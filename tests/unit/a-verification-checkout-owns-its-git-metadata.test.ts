import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { produceRepoFactoryResult, VERIFICATION_KINDS } from "../../src/bootstrap/repo-factory-producer.ts";
import { parseVerificationCommand } from "../../src/contracts/verification-command.ts";
import { allow, deny } from "../../src/core/errors.ts";
import { digestOf } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { REPAIR_OWNER_APPROVAL_OPERATION } from "../../src/doctor/repair.ts";
import { ExecutionMode, RunKind, RunState } from "../../src/domain/types.ts";
import { WorktreeAction, WriteOperation, type ManagedWriteGuard } from "../../src/guard/managed-write-guard.ts";
import { IngressGuard, ownerApprovalPayload } from "../../src/ingress/ingress-guard.ts";
import { runSandboxed } from "../../src/verify/sandbox.ts";
import { WorktreeManager, type WorktreeAuthorization } from "../../src/verify/worktree.ts";
import { dispatchBootstrapRun, makeHarness, TEST_OWNER, type Harness } from "../helpers/harness.ts";
import { cleanupTempDirs, commitAll, gitSync, makeRepo, tempDir, writeFiles } from "../helpers/fixtures.ts";

afterEach(cleanupTempDirs);

/**
 * #246 C2v. A project Repo Factory bootstraps declares exactly one verification, CLEAN_TREE
 * (`git status --porcelain`). In a later run the verification engine ran it in a linked worktree,
 * whose `.git` is a file naming `<checkout>/.git/worktrees/<id>`, inside a sandbox that denies that
 * checkout (§33.3) -- so git exited 128 and the project could never pass verification again. These
 * cases witness the checkout that replaces it for that command: one with its own git metadata and
 * objects, nothing pointing back at the original, the original still denied, dirty and untracked
 * source state refused rather than dropped, and the lifecycle a linked worktree already had.
 */

const sandboxIt = (name: string, fn: () => Promise<void>): void => {
  if (process.platform === "darwin") it(name, fn);
};

type ActionHooks = Partial<Record<WorktreeAction, () => void>>;

/**
 * A guard that grants every lifecycle effect, with a hook before or after a chosen one. The hooks
 * are how a case moves the source "between preparation and copy", or tampers with a copy after
 * git wrote it: preparation happens before the ADD effect, the copy inside it.
 */
const authorizationFor = (
  manager: WorktreeManager,
  repositoryPath: string,
  worktreeId: string,
  hooks: {
    before?: ActionHooks;
    after?: ActionHooks;
    refuse?: readonly WorktreeAction[];
    /** Answer "allowed" without running the effect: a grant is not proof the effect happened. */
    skip?: readonly WorktreeAction[];
  } = {},
): WorktreeAuthorization => {
  const path = manager.pathFor(worktreeId);
  const guard = {
    authorize: async (
      request: { worktreeAction: WorktreeAction },
      effect: (context: { grant: object }) => Promise<void> | void,
    ) => {
      if (hooks.refuse?.includes(request.worktreeAction)) {
        return deny(ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH, "refused by the test guard", {});
      }
      if (hooks.skip?.includes(request.worktreeAction)) return allow(ReasonCode.WRITE_ALLOWED, undefined);
      hooks.before?.[request.worktreeAction]?.();
      const value = await effect({ grant: {} });
      hooks.after?.[request.worktreeAction]?.();
      return allow(ReasonCode.WRITE_ALLOWED, value);
    },
  } as unknown as ManagedWriteGuard;
  const common = {
    guard,
    request: {
      operation: WriteOperation.GIT_WORKTREE,
      repositoryIdentity: "test-repository",
      targetWorktreeId: path,
      runId: "test-run",
      sessionId: "test-session",
      bindingGeneration: 1,
    },
  };
  return {
    add: { ...common, request: { ...common.request, targetPath: path, worktreeAction: WorktreeAction.ADD } },
    remove: { ...common, request: { ...common.request, targetPath: path, worktreeAction: WorktreeAction.REMOVE } },
    cleanup: { ...common, request: { ...common.request, targetPath: path, worktreeAction: WorktreeAction.CLEANUP } },
    prune: { ...common, request: { ...common.request, targetPath: repositoryPath, worktreeAction: WorktreeAction.PRUNE } },
  };
};

/** Where a self-contained checkout's registration lives: beside it, under the managed root. */
const registrationOf = (manager: WorktreeManager, worktreeId: string): string =>
  join(dirname(manager.pathFor(worktreeId)), ".verification-checkouts", `${worktreeId}.json`);

/** Git that reads only the repository's own config, as the sandbox does. */
const ownGit = (cwd: string, args: readonly string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      XDG_CONFIG_HOME: "/dev/null",
    },
  }).trim();

const filesUnder = (root: string): string[] => {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else found.push(path);
    }
  };
  walk(root);
  return found;
};

const executable = (path: string, body: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
};

const refusal = async (promise: Promise<unknown>): Promise<{ reasonCode?: string; evidence?: Record<string, unknown> }> => {
  try {
    await promise;
  } catch (error) {
    return error as { reasonCode?: string; evidence?: Record<string, unknown> };
  }
  throw new Error("expected a refusal, and the checkout was created");
};

const CLEAN_TREE = parseVerificationCommand({ id: "clean-tree", argv: ["git", "status", "--porcelain"], timeoutSeconds: 30 });

describe("a self-contained verification checkout (#246 C2v)", () => {
  sandboxIt("answers git inside the sandbox while the original checkout stays denied", async () => {
    const repository = makeRepo();
    const manager = new WorktreeManager(tempDir("acp-own-checkout-"));
    const own = await manager.create(repository, "HEAD", "own", authorizationFor(manager, repository, "own"), {
      selfContained: true,
    });
    const linked = await manager.create(repository, "HEAD", "linked", authorizationFor(manager, repository, "linked"));
    // The engine denies the run's own checkout to every candidate command (§33.3).
    const denyReadPaths = [repository];
    const sandboxed = (worktreePath: string, id: string, argv: string[]) =>
      runSandboxed({ command: parseVerificationCommand({ id, argv, timeoutSeconds: 30 }), worktreePath, denyReadPaths });
    // A probe of the original that only seatbelt can refuse: the file exists and is ours to read.
    const readOriginal = [
      "node",
      "-e",
      `require('fs').readFile(${JSON.stringify(join(repository, ".git", "HEAD"))}, function(e){ console.log(e ? 'denied ' + e.code : 'read'), process.exit(e ? 3 : 0) })`,
    ];

    const gitDir = await sandboxed(own.path, "git-dir", ["git", "rev-parse", "--git-dir"]);
    expect(gitDir).toMatchObject({ status: "PASS", exitCode: 0 });
    expect(gitDir.stdout.trim()).toBe(".git");
    const status = await sandboxed(own.path, "clean-tree", ["git", "status", "--porcelain"]);
    expect(status).toMatchObject({ status: "PASS", exitCode: 0, stdout: "" });
    const original = await sandboxed(own.path, "read-original", readOriginal);
    expect(original.exitCode).toBe(3);
    expect(original.stdout.trim()).toBe("denied EPERM");

    // The defect, kept visible: the same command in a linked worktree cannot find its metadata.
    const linkedStatus = await sandboxed(linked.path, "clean-tree", ["git", "status", "--porcelain"]);
    expect(linkedStatus.exitCode).toBe(128);
    expect(linkedStatus.stderr).toContain("not a git repository");

    await manager.destroy(repository, own.path, authorizationFor(manager, repository, "own"));
    await manager.destroy(repository, linked.path, authorizationFor(manager, repository, "linked"));
  });

  it("keeps nothing of the original: no gitfile, alternates, hooks, config, remote, tags or FETCH_HEAD", async () => {
    const repository = makeRepo();
    writeFiles(repository, { "src/app.js": "module.exports = 2;\n" });
    const head = commitAll(repository, "second");
    gitSync(repository, ["tag", "v-source", head]);

    const ran = tempDir("acp-source-hooks-ran-");
    executable(join(repository, ".git", "hooks", "post-checkout"), `#!/bin/sh\n: > ${JSON.stringify(join(ran, "source-hook"))}\n`);
    executable(join(repository, ".git", "hooks", "pre-commit"), `#!/bin/sh\n: > ${JSON.stringify(join(ran, "source-pre-commit"))}\n`);
    const hooksPath = tempDir("acp-source-hooks-path-");
    executable(join(hooksPath, "post-checkout"), `#!/bin/sh\n: > ${JSON.stringify(join(ran, "hooks-path"))}\n`);
    const included = join(tempDir("acp-source-include-"), "included.gitconfig");
    writeFileSync(included, "[user]\n\tname = included-from-source\n");
    gitSync(repository, ["config", "credential.helper", "!echo password=source-credential"]);
    gitSync(repository, ["config", "url.https://source-token@example.invalid/.insteadOf", "https://example.invalid/"]);
    gitSync(repository, ["config", "core.hooksPath", hooksPath]);
    gitSync(repository, ["config", "include.path", included]);
    gitSync(repository, ["config", "remote.origin.url", "https://user:source-token@example.invalid/acme/fixture.git"]);
    // Programs the original's config names, which reading it must not start: `git status` runs an
    // fsmonitor hook, and `upload-pack` would run a pack-objects hook if it honoured repo config.
    const fsmonitor = join(tempDir("acp-source-fsmonitor-"), "fsmonitor");
    executable(fsmonitor, `#!/bin/sh\n: > ${JSON.stringify(join(ran, "source-fsmonitor"))}\nexit 1\n`);
    gitSync(repository, ["config", "core.fsmonitor", fsmonitor]);
    const packHook = join(tempDir("acp-source-pack-hook-"), "pack-objects-hook");
    executable(packHook, `#!/bin/sh\n: > ${JSON.stringify(join(ran, "source-pack-objects-hook"))}\nexec "$@"\n`);
    gitSync(repository, ["config", "uploadpack.packObjectsHook", packHook]);

    const manager = new WorktreeManager(tempDir("acp-own-checkout-"));
    const checkout = await manager.create(repository, "HEAD", "artefact", authorizationFor(manager, repository, "artefact"), {
      selfContained: true,
    });
    const gitDir = join(checkout.path, ".git");

    // Its own metadata: a directory, not a gitfile naming the original.
    expect(lstatSync(gitDir).isDirectory()).toBe(true);
    expect(ownGit(checkout.path, ["rev-parse", "--absolute-git-dir"])).toBe(gitDir);
    // Its own objects: no alternates, and no object file shared with the original by a hard link.
    expect(existsSync(join(gitDir, "objects", "info", "alternates"))).toBe(false);
    const linkedFiles = filesUnder(gitDir).filter((file) => lstatSync(file).nlink !== 1);
    expect(linkedFiles).toEqual([]);
    // No hooks directory at all -- not the source's, not a template's -- and no hook ran.
    expect(existsSync(join(gitDir, "hooks"))).toBe(false);
    expect(readdirSync(ran)).toEqual([]);
    // Its config is git init's own: nothing the source configured, and no remote.
    const keys = ownGit(checkout.path, ["config", "--local", "--name-only", "--list"]).split("\n");
    expect(keys.every((key) => key.startsWith("core."))).toBe(true);
    expect(keys.filter((key) => /hookspath|fsmonitor|sshcommand/i.test(key))).toEqual([]);
    const config = readFileSync(join(gitDir, "config"), "utf8");
    for (const sourceValue of ["credential", "insteadOf", "source-token", "hooksPath", "include", "remote", repository]) {
      expect(config).not.toContain(sourceValue);
    }
    // No FETCH_HEAD, ref, tag or log line names the original or carries its refs.
    expect(existsSync(join(gitDir, "FETCH_HEAD"))).toBe(false);
    expect(ownGit(checkout.path, ["for-each-ref"])).toBe("");
    const naming = filesUnder(gitDir).filter((file) => readFileSync(file, "latin1").includes(repository));
    expect(naming).toEqual([]);
    // Exactly the candidate, and only it: the one commit, not the source's history.
    expect(ownGit(checkout.path, ["rev-parse", "HEAD"])).toBe(head);
    expect(ownGit(checkout.path, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(ownGit(checkout.path, ["status", "--porcelain", "--untracked-files=all"])).toBe("");

    await manager.destroy(repository, checkout.path, authorizationFor(manager, repository, "artefact"));
  });

  it("reads none of the operator's git configuration while it builds the copy", async () => {
    const repository = makeRepo({ "README.md": "# fixture\n", ".gitattributes": "* filter=acpwitness\n" });
    const ran = tempDir("acp-operator-config-ran-");
    const home = tempDir("acp-operator-home-");
    const operatorHooks = join(home, "hooks");
    executable(join(operatorHooks, "post-checkout"), `#!/bin/sh\n: > ${JSON.stringify(join(ran, "operator-hook"))}\n`);
    const templates = join(home, "templates");
    executable(join(templates, "hooks", "post-checkout"), `#!/bin/sh\n: > ${JSON.stringify(join(ran, "operator-template"))}\n`);
    writeFileSync(
      join(home, ".gitconfig"),
      [
        "[filter \"acpwitness\"]",
        `\tsmudge = touch ${JSON.stringify(join(ran, "operator-filter"))} && cat`,
        "[core]",
        `\thooksPath = ${operatorHooks}`,
        "[init]",
        `\ttemplateDir = ${templates}`,
        "",
      ].join("\n"),
    );

    const manager = new WorktreeManager(tempDir("acp-own-checkout-"));
    const previousHome = process.env["HOME"];
    process.env["HOME"] = home;
    try {
      const checkout = await manager.create(repository, "HEAD", "operator", authorizationFor(manager, repository, "operator"), {
        selfContained: true,
      });
      // An operator-wide smudge filter, hook path or template would each have run or landed here.
      expect(readdirSync(ran)).toEqual([]);
      expect(existsSync(join(checkout.path, ".git", "hooks"))).toBe(false);
      await manager.destroy(repository, checkout.path, authorizationFor(manager, repository, "operator"));
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
    }
  });

  it("takes the source's object format, so a SHA-256 repository can be verified too", async () => {
    const repository = tempDir("acp-sha256-");
    gitSync(repository, ["init", "-q", "--object-format=sha256", "-b", "dev"]);
    writeFiles(repository, { "README.md": "# sha256\n" });
    const head = commitAll(repository, "base");
    const manager = new WorktreeManager(tempDir("acp-own-checkout-"));
    const checkout = await manager.create(repository, "HEAD", "sha256", authorizationFor(manager, repository, "sha256"), {
      selfContained: true,
    });
    expect(ownGit(checkout.path, ["rev-parse", "--show-object-format"])).toBe("sha256");
    expect(ownGit(checkout.path, ["rev-parse", "HEAD"])).toBe(head);
    await manager.destroy(repository, checkout.path, authorizationFor(manager, repository, "sha256"));
  });
});

describe("dirty and untracked state is refused, never copied clean (#246 C2v)", () => {
  /** A refused copy leaves nothing behind: no checkout and no registration. */
  const expectNothingLeft = (manager: WorktreeManager, worktreeId: string): void => {
    expect(existsSync(manager.pathFor(worktreeId))).toBe(false);
    expect(existsSync(registrationOf(manager, worktreeId))).toBe(false);
  };

  const create = (
    manager: WorktreeManager,
    repository: string,
    worktreeId: string,
    head = "HEAD",
    hooks: Parameters<typeof authorizationFor>[3] = {},
  ) =>
    manager.create(repository, head, worktreeId, authorizationFor(manager, repository, worktreeId, hooks), {
      selfContained: true,
    });

  /** Refused at preparation: the guard is never even asked to start the copy. */
  const refusedBeforeCopy = async (manager: WorktreeManager, repository: string, worktreeId: string, head = "HEAD") => {
    let copyStarted = false;
    const refused = await refusal(create(manager, repository, worktreeId, head, {
      before: { [WorktreeAction.ADD]: () => { copyStarted = true; } },
    }));
    expect(copyStarted, "a candidate that is not exactly its commit must be refused before any copy").toBe(false);
    expectNothingLeft(manager, worktreeId);
    return refused;
  };

  it("refuses a tracked change in the source and leaves it in place", async () => {
    const repository = makeRepo();
    writeFileSync(join(repository, "README.md"), "# edited, not committed\n");
    const manager = new WorktreeManager(tempDir("acp-own-checkout-"));
    const refused = await refusedBeforeCopy(manager, repository, "dirty");
    expect(refused.reasonCode).toBe(ReasonCode.SNAPSHOT_STALE);
    expect(refused.evidence?.["sourceStatus"]).toEqual([" M README.md"]);
    expect(readFileSync(join(repository, "README.md"), "utf8")).toBe("# edited, not committed\n");
  });

  it("refuses a staged change in the source", async () => {
    const repository = makeRepo();
    writeFiles(repository, { "staged.txt": "staged\n" });
    gitSync(repository, ["add", "staged.txt"]);
    const manager = new WorktreeManager(tempDir("acp-own-checkout-"));
    const refused = await refusedBeforeCopy(manager, repository, "staged");
    expect(refused.reasonCode).toBe(ReasonCode.SNAPSHOT_STALE);
    expect(refused.evidence?.["sourceStatus"]).toEqual(["A  staged.txt"]);
  });

  it("refuses an untracked file the repository hides from status, and leaves it in place", async () => {
    const repository = makeRepo();
    gitSync(repository, ["config", "status.showUntrackedFiles", "no"]);
    writeFiles(repository, { "nested/untracked.txt": "not in the commit\n" });
    // The hiding is real: ordinary status, which the snapshot freshness check uses, sees nothing.
    expect(gitSync(repository, ["status", "--porcelain"])).toBe("");
    const manager = new WorktreeManager(tempDir("acp-own-checkout-"));
    const refused = await refusedBeforeCopy(manager, repository, "untracked");
    expect(refused.reasonCode).toBe(ReasonCode.SNAPSHOT_STALE);
    expect(refused.evidence?.["sourceStatus"]).toEqual(["?? nested/untracked.txt"]);
    expect(existsSync(join(repository, "nested", "untracked.txt"))).toBe(true);
  });

  it("refuses a source that gets dirty between preparation and copy", async () => {
    const repository = makeRepo();
    const manager = new WorktreeManager(tempDir("acp-own-checkout-"));
    const refused = await refusal(create(manager, repository, "dirtied", "HEAD", {
      before: { [WorktreeAction.ADD]: () => writeFiles(repository, { "late.txt": "arrived during the copy\n" }) },
    }));
    expect(refused.reasonCode).toBe(ReasonCode.SNAPSHOT_STALE);
    expect(refused.evidence?.["sourceStatus"]).toEqual(["?? late.txt"]);
    expectNothingLeft(manager, "dirtied");
    expect(existsSync(join(repository, "late.txt"))).toBe(true);
  });

  it("accepts an ignored file, which is not candidate state, and does not copy it", async () => {
    const repository = makeRepo({ "README.md": "# fixture\n", ".gitignore": "build/\n" });
    writeFiles(repository, { "build/output.txt": "ignored\n" });
    const manager = new WorktreeManager(tempDir("acp-own-checkout-"));
    const checkout = await create(manager, repository, "ignored");
    expect(existsSync(join(checkout.path, "build"))).toBe(false);
    await manager.destroy(repository, checkout.path, authorizationFor(manager, repository, "ignored"));
  });

  it("refuses a head the source checkout is not at, since its working state is not that commit's", async () => {
    const repository = makeRepo();
    const base = gitSync(repository, ["rev-parse", "HEAD"]);
    writeFiles(repository, { "next.txt": "next\n" });
    commitAll(repository, "next");
    const manager = new WorktreeManager(tempDir("acp-own-checkout-"));
    const refused = await refusedBeforeCopy(manager, repository, "elsewhere", base);
    expect(refused.reasonCode).toBe(ReasonCode.SNAPSHOT_STALE);
    expect(refused.evidence).toMatchObject({ expectedHead: base });
  });

  it("refuses a copy that is not clean once written, and removes it rather than cleaning it", async () => {
    const repository = makeRepo();
    const manager = new WorktreeManager(tempDir("acp-own-checkout-"));
    const refused = await refusal(create(manager, repository, "stray", "HEAD", {
      after: { [WorktreeAction.ADD]: () => writeFileSync(join(manager.pathFor("stray"), "stray.txt"), "stray\n") },
    }));
    expect(refused.reasonCode).toBe(ReasonCode.SNAPSHOT_STALE);
    expect(refused.evidence?.["status"]).toEqual(["?? stray.txt"]);
    expectNothingLeft(manager, "stray");
  });

  it("judges the copy without the operator's global ignore file", async () => {
    const repository = makeRepo();
    const home = tempDir("acp-operator-home-");
    writeFiles(home, { ".config/git/ignore": "stray.txt\n" });
    const manager = new WorktreeManager(tempDir("acp-own-checkout-"));
    const previousHome = process.env["HOME"];
    process.env["HOME"] = home;
    try {
      const refused = await refusal(create(manager, repository, "ignored-stray", "HEAD", {
        after: { [WorktreeAction.ADD]: () => writeFileSync(join(manager.pathFor("ignored-stray"), "stray.txt"), "stray\n") },
      }));
      // The sandbox has no global ignore file, so CLEAN_TREE there would report the stray file.
      expect(refused.reasonCode).toBe(ReasonCode.SNAPSHOT_STALE);
      expect(refused.evidence?.["status"]).toEqual(["?? stray.txt"]);
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
    }
    expectNothingLeft(manager, "ignored-stray");
  });

  it("lists every untracked file in the copy, whatever the copy's config says", async () => {
    const repository = makeRepo();
    const manager = new WorktreeManager(tempDir("acp-own-checkout-"));
    const refused = await refusal(create(manager, repository, "hidden-stray", "HEAD", {
      after: {
        [WorktreeAction.ADD]: () => {
          gitSync(manager.pathFor("hidden-stray"), ["config", "status.showUntrackedFiles", "no"]);
          writeFileSync(join(manager.pathFor("hidden-stray"), "stray.txt"), "stray\n");
        },
      },
    }));
    expect(refused.reasonCode).toBe(ReasonCode.SNAPSHOT_STALE);
    expect(refused.evidence?.["status"]).toEqual(["?? stray.txt"]);
    expectNothingLeft(manager, "hidden-stray");
  });

  it("refuses a copy whose HEAD is not the candidate", async () => {
    const repository = makeRepo();
    const manager = new WorktreeManager(tempDir("acp-own-checkout-"));
    const refused = await refusal(create(manager, repository, "advanced", "HEAD", {
      after: {
        [WorktreeAction.ADD]: () => gitSync(manager.pathFor("advanced"), ["commit", "-q", "--allow-empty", "-m", "not the candidate"]),
      },
    }));
    expect(refused.reasonCode).toBe(ReasonCode.SNAPSHOT_STALE);
    expect(refused.evidence?.["materializedHead"]).not.toBe(refused.evidence?.["expectedHead"]);
    expectNothingLeft(manager, "advanced");
  });

  it("refuses a copy whose .git became a gitfile naming the original", async () => {
    const repository = makeRepo();
    const manager = new WorktreeManager(tempDir("acp-own-checkout-"));
    const refused = await refusal(create(manager, repository, "gitfile", "HEAD", {
      after: {
        [WorktreeAction.ADD]: () => {
          const gitDir = join(manager.pathFor("gitfile"), ".git");
          rmSync(gitDir, { recursive: true, force: true });
          writeFileSync(gitDir, `gitdir: ${join(repository, ".git")}\n`);
        },
      },
    }));
    // Same head, same tree, clean status -- only the self-containment check can tell.
    expect(refused.reasonCode).toBe(ReasonCode.SNAPSHOT_STALE);
    expect(refused.evidence).toMatchObject({ selfContained: false, status: [] });
    expect(refused.evidence?.["materializedHead"]).toBe(refused.evidence?.["expectedHead"]);
    expectNothingLeft(manager, "gitfile");
    expect(existsSync(join(repository, ".git", "HEAD"))).toBe(true);
  });

  it("refuses a copy whose metadata names the original as its common directory", async () => {
    const repository = makeRepo();
    const manager = new WorktreeManager(tempDir("acp-own-checkout-"));
    const refused = await refusal(create(manager, repository, "commondir", "HEAD", {
      after: {
        [WorktreeAction.ADD]: () =>
          writeFileSync(join(manager.pathFor("commondir"), ".git", "commondir"), `${join(repository, ".git")}\n`),
      },
    }));
    expect(refused.reasonCode).toBe(ReasonCode.SNAPSHOT_STALE);
    expect(refused.evidence).toMatchObject({ selfContained: false });
    expectNothingLeft(manager, "commondir");
  });

  it("refuses a copy that borrows the original's objects", async () => {
    const repository = makeRepo();
    const manager = new WorktreeManager(tempDir("acp-own-checkout-"));
    const refused = await refusal(create(manager, repository, "borrowed", "HEAD", {
      after: {
        [WorktreeAction.ADD]: () =>
          writeFileSync(
            join(manager.pathFor("borrowed"), ".git", "objects", "info", "alternates"),
            `${join(repository, ".git", "objects")}\n`,
          ),
      },
    }));
    expect(refused.reasonCode).toBe(ReasonCode.SNAPSHOT_STALE);
    expect(refused.evidence).toMatchObject({ selfContained: false });
    expectNothingLeft(manager, "borrowed");
  });

  it("is SNAPSHOT_STALE, never another tree, when the source moves between preparation and copy", async () => {
    const repository = makeRepo();
    const prepared = gitSync(repository, ["rev-parse", "HEAD"]);
    const manager = new WorktreeManager(tempDir("acp-own-checkout-"));
    const refused = await refusal(create(manager, repository, "moved", "HEAD", {
      before: {
        [WorktreeAction.ADD]: () => {
          writeFiles(repository, { "moved.txt": "moved\n" });
          commitAll(repository, "moved while copying");
        },
      },
    }));
    expect(refused.reasonCode).toBe(ReasonCode.SNAPSHOT_STALE);
    expect(refused.evidence).toMatchObject({ expectedHead: prepared, materializedHead: prepared });
    expect(refused.evidence?.["sourceHead"]).not.toBe(prepared);
    expectNothingLeft(manager, "moved");
  });
});

describe("a self-contained checkout keeps the worktree lifecycle (#246 C2v)", () => {
  const make = async (manager: WorktreeManager, repository: string, worktreeId: string) =>
    manager.create(repository, "HEAD", worktreeId, authorizationFor(manager, repository, worktreeId), {
      selfContained: true,
    });

  it("destroy removes the checkout and its registration, and never touched the source's worktrees", async () => {
    const repository = makeRepo();
    const manager = new WorktreeManager(tempDir("acp-own-checkout-"));
    const checkout = await make(manager, repository, "lifecycle");
    expect(existsSync(registrationOf(manager, "lifecycle"))).toBe(true);
    expect(gitSync(repository, ["worktree", "list", "--porcelain"]).match(/^worktree /gm)).toHaveLength(1);
    await manager.destroy(repository, checkout.path, authorizationFor(manager, repository, "lifecycle"));
    expect(existsSync(checkout.path)).toBe(false);
    expect(existsSync(registrationOf(manager, "lifecycle"))).toBe(false);
  });

  it("refuses to delete a checkout-shaped path nobody registered", async () => {
    const repository = makeRepo();
    const manager = new WorktreeManager(tempDir("acp-own-checkout-"));
    const stray = manager.pathFor("unregistered");
    mkdirSync(stray);
    gitSync(stray, ["init", "-q"]);
    const refused = await refusal(manager.destroy(repository, stray, authorizationFor(manager, repository, "unregistered")));
    expect(refused.reasonCode).toBe(ReasonCode.NOT_FOUND);
    expect(existsSync(join(stray, ".git"))).toBe(true);
  });

  it("refuses to delete a checkout registered to another repository", async () => {
    const owner = makeRepo();
    const other = makeRepo();
    const manager = new WorktreeManager(tempDir("acp-own-checkout-"));
    const checkout = await make(manager, owner, "owned");
    const refused = await refusal(manager.destroy(other, checkout.path, authorizationFor(manager, other, "owned")));
    expect(refused.reasonCode).toBe(ReasonCode.NOT_FOUND);
    expect(existsSync(join(checkout.path, ".git"))).toBe(true);
    expect(await manager.orphans(other, new Set())).toEqual([]);
    await manager.destroy(owner, checkout.path, authorizationFor(manager, owner, "owned"));
  });

  it("is an orphan of its own repository until it is live, and a teardown that stopped part-way finishes", async () => {
    const repository = makeRepo();
    const manager = new WorktreeManager(tempDir("acp-own-checkout-"));
    const checkout = await make(manager, repository, "half-torn");
    expect(await manager.orphans(repository, new Set(["half-torn"]))).toEqual([]);
    expect(await manager.orphans(repository, new Set())).toEqual(["half-torn"]);
    // The checkout went and the registration stayed: the record is what lets the sweep find it.
    rmSync(checkout.path, { recursive: true, force: true });
    expect(await manager.orphans(repository, new Set())).toEqual(["half-torn"]);
    await manager.destroy(repository, checkout.path, authorizationFor(manager, repository, "half-torn"));
    expect(existsSync(registrationOf(manager, "half-torn"))).toBe(false);
    expect(await manager.orphans(repository, new Set())).toEqual([]);
  });

  it("keeps the registration when the removal fails part-way, so the remains are still found", async () => {
    const repository = makeRepo();
    const manager = new WorktreeManager(tempDir("acp-own-checkout-"));
    const checkout = await make(manager, repository, "stuck");
    // A directory the removal cannot empty, as a candidate command could leave behind.
    const locked = join(checkout.path, "locked");
    writeFiles(checkout.path, { "locked/kept.txt": "kept\n" });
    chmodSync(locked, 0o500);
    try {
      await refusal(manager.destroy(repository, checkout.path, authorizationFor(manager, repository, "stuck")));
      expect(existsSync(registrationOf(manager, "stuck"))).toBe(true);
      expect(await manager.orphans(repository, new Set())).toEqual(["stuck"]);
    } finally {
      chmodSync(locked, 0o700);
    }
    await manager.destroy(repository, checkout.path, authorizationFor(manager, repository, "stuck"));
    expect(existsSync(checkout.path)).toBe(false);
    expect(existsSync(registrationOf(manager, "stuck"))).toBe(false);
  });

  it("will not reuse a registered id, even for a linked worktree, while its record remains", async () => {
    const repository = makeRepo();
    const manager = new WorktreeManager(tempDir("acp-own-checkout-"));
    const checkout = await make(manager, repository, "reused");
    rmSync(checkout.path, { recursive: true, force: true });
    const refused = await refusal(manager.create(repository, "HEAD", "reused", authorizationFor(manager, repository, "reused")));
    expect(refused.reasonCode).toBe(ReasonCode.CONFLICT);
    expect(gitSync(repository, ["worktree", "list", "--porcelain"]).match(/^worktree /gm)).toHaveLength(1);
    await manager.destroy(repository, checkout.path, authorizationFor(manager, repository, "reused"));
  });

  it("never deletes a registration or directory another creator holds", async () => {
    const repository = makeRepo();
    const manager = new WorktreeManager(tempDir("acp-own-checkout-"));
    const foreignRecord = registrationOf(manager, "raced-record");
    const recordRefusal = await refusal(manager.create(
      repository,
      "HEAD",
      "raced-record",
      authorizationFor(manager, repository, "raced-record", {
        before: {
          [WorktreeAction.ADD]: () => {
            mkdirSync(dirname(foreignRecord), { recursive: true, mode: 0o700 });
            writeFileSync(foreignRecord, "another creator's record\n");
          },
        },
      }),
      { selfContained: true },
    ));
    expect(recordRefusal.reasonCode).toBe(ReasonCode.CONFLICT);
    expect(readFileSync(foreignRecord, "utf8")).toBe("another creator's record\n");

    const foreignDirectory = manager.pathFor("raced-directory");
    await refusal(manager.create(
      repository,
      "HEAD",
      "raced-directory",
      authorizationFor(manager, repository, "raced-directory", {
        before: { [WorktreeAction.ADD]: () => writeFiles(foreignDirectory, { "theirs.txt": "theirs\n" }) },
      }),
      { selfContained: true },
    ));
    expect(readFileSync(join(foreignDirectory, "theirs.txt"), "utf8")).toBe("theirs\n");
    expect(existsSync(registrationOf(manager, "raced-directory"))).toBe(false);
  });

  it("does not report a removal that did not happen", async () => {
    const repository = makeRepo();
    const manager = new WorktreeManager(tempDir("acp-own-checkout-"));
    const checkout = await make(manager, repository, "unremoved");
    const refused = await refusal(manager.destroy(
      repository,
      checkout.path,
      authorizationFor(manager, repository, "unremoved", { skip: [WorktreeAction.REMOVE] }),
    ));
    expect(refused.reasonCode).toBe(ReasonCode.ISOLATION_LOST);
    await manager.destroy(repository, checkout.path, authorizationFor(manager, repository, "unremoved"));
  });

  it("keeps the registration when the guard refuses the removal, so the checkout is still found", async () => {
    const repository = makeRepo();
    const manager = new WorktreeManager(tempDir("acp-own-checkout-"));
    const checkout = await make(manager, repository, "refused-removal");
    const refused = await refusal(manager.destroy(
      repository,
      checkout.path,
      authorizationFor(manager, repository, "refused-removal", { refuse: [WorktreeAction.REMOVE] }),
    ));
    expect(refused.reasonCode).toBe(ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH);
    expect(existsSync(checkout.path)).toBe(true);
    expect(await manager.orphans(repository, new Set())).toEqual(["refused-removal"]);
    await manager.destroy(repository, checkout.path, authorizationFor(manager, repository, "refused-removal"));
  });
});

/** A projectless §17.5 run over its own temporary repository, frozen at that repository's HEAD. */
const temporaryCandidate = async (candidateRepository?: { path: string; baseBranch: string }) => {
  const harness = makeHarness();
  const created = harness.cp.runs.create({
    kind: RunKind.PROJECT_BOOTSTRAP,
    executionMode: ExecutionMode.SIMPLE,
    contract: {
      goal: "verify a bootstrapped checkout",
      why: "#246 C2v",
      scope: [],
      nonGoals: [],
      acceptance: ["CLEAN_TREE passes in the verification sandbox"],
      priority: "NORMAL" as const,
      humanGate: [],
      references: [],
    },
  });
  if (!created.allowed) throw new Error(created.message);
  const repository = await harness.cp.repositories.registerTemporary(
    candidateRepository?.path ?? harness.repoPath,
    created.value.runId,
  );
  if (!repository.allowed) throw new Error(repository.message);
  const dispatched = await dispatchBootstrapRun(harness.cp, harness.clock, created.value.runId);
  const attached = harness.cp.runs.attachRepository(created.value.runId, {
    repositoryId: repository.value.repositoryId,
    repositoryRole: "primary",
    baseBranch: candidateRepository?.baseBranch ?? "dev",
    ownerSessionId: dispatched.ownerSessionId!,
    ownerBindingGeneration: dispatched.ownerBindingGeneration!,
  });
  if (!attached.allowed) throw new Error(attached.message);
  const frozen = await harness.cp.pipeline.freeze(created.value.runId);
  if (!frozen.allowed) throw new Error(frozen.message);
  return { harness, run: dispatched, snapshot: frozen.value };
};

const verifyCleanTree = (candidate: Awaited<ReturnType<typeof temporaryCandidate>>, command = CLEAN_TREE) =>
  candidate.harness.cp.verification.verify({
    runId: candidate.run.runId,
    snapshot: candidate.snapshot,
    commands: [command],
    contractDigest: candidate.snapshot.contractDigest,
    runScoped: true,
  });

const latestVerificationTree = (harness: Harness, runId: string) =>
  harness.cp.db.get<{ worktree_id: string; worktree_path: string; state: string }>(
    `SELECT worktree_id, worktree_path, state FROM verification_worktrees
      WHERE run_id = ? ORDER BY created_at DESC LIMIT 1`,
    [runId],
  )!;

const sweepOrphans = async (harness: Harness, key: string) => {
  const approval = {
    runId: null,
    candidateSnapshotDigest: null,
    operation: REPAIR_OWNER_APPROVAL_OPERATION,
    parameters: { operationId: "prune_orphan_worktrees", parameters: {}, dryRun: false },
    idempotencyKey: key,
    approved: true,
  };
  const ingress = new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
    cli: { allowedActors: [TEST_OWNER.actor] },
  });
  const admitted = ingress.admitOwnerApproval({
    channel: TEST_OWNER.channel,
    actor: TEST_OWNER.actor,
    nonce: `repair:${digestOf(approval)}`,
    payload: ownerApprovalPayload(approval),
  }, approval);
  if (!admitted.allowed) throw new Error(admitted.message);
  return harness.cp.repair.execute({
    operationId: "prune_orphan_worktrees",
    parameters: {},
    authorizedBy: "OWNER",
    ownerApproval: admitted.value,
    dryRun: false,
  });
};

describe("the verification engine gives CLEAN_TREE, and only it, a self-contained checkout (#246 C2v)", () => {
  sandboxIt("passes CLEAN_TREE through the real engine and sandbox, and leaves nothing behind", async () => {
    const candidate = await temporaryCandidate();
    const verified = await verifyCleanTree(candidate);
    if (!verified.allowed) throw new Error(`${verified.reasonCode}: ${verified.message}`);
    expect(verified.value).toMatchObject({ status: "PASS", results: [{ commandId: "clean-tree", status: "PASS" }] });
    const tree = latestVerificationTree(candidate.harness, candidate.run.runId);
    expect(tree.state).toBe("DESTROYED");
    expect(existsSync(tree.worktree_path)).toBe(false);
    expect(existsSync(join(dirname(tree.worktree_path), ".verification-checkouts", `${tree.worktree_id}.json`))).toBe(false);
  });

  sandboxIt("passes CLEAN_TREE in a later run over the checkout the real Repo Factory producer made", async () => {
    // The producer's own checkout, with the untracked ownership marker it keeps out of status
    // through `.git/info/exclude` -- the shape a bootstrapped project's registered checkout has.
    const produced = await produceRepoFactoryResult({
      plan: {
        runId: "run_c2v_bootstrap",
        bootstrapOperationId: "op_c2v_bootstrap",
        requestDigest: `sha256:${"a".repeat(64)}`,
        planDigest: `sha256:${"b".repeat(64)}`,
        projectManifestDigest: `sha256:${"c".repeat(64)}`,
        repositoryRole: "primary",
        defaultBranch: "main",
        verificationCommandId: "clean-tree",
        verificationKind: "CLEAN_TREE",
        githubOperations: [],
      },
      workDir: join(tempDir("acp-c2v-producer-"), "workdir"),
    });
    if (!produced.allowed) throw new Error(`${produced.reasonCode}: ${produced.message}`);
    const checkout = produced.value.repositories[0]?.proposedCheckoutPath;
    if (!checkout) throw new Error("the producer proposed no checkout path");
    expect(produced.value.bootstrapVerification[0]).toMatchObject({ commandId: "clean-tree", status: "PASS" });
    expect(existsSync(join(checkout, ".repo-factory-operation.json"))).toBe(true);

    const candidate = await temporaryCandidate({ path: checkout, baseBranch: "main" });
    // The manifest command the producer's PASS is recorded under: exactly its fixed invocation.
    const command = parseVerificationCommand({
      id: "clean-tree",
      argv: ["git", ...VERIFICATION_KINDS.CLEAN_TREE.argv],
      timeoutSeconds: 30,
    });
    const verified = await verifyCleanTree(candidate, command);
    if (!verified.allowed) throw new Error(`${verified.reasonCode}: ${verified.message}`);
    expect(verified.value).toMatchObject({ status: "PASS", results: [{ commandId: "clean-tree", status: "PASS" }] });
    expect(latestVerificationTree(candidate.harness, candidate.run.runId).state).toBe("DESTROYED");
  });

  it("refuses a CLEAN_TREE candidate whose untracked file the repository hides, instead of passing it", async () => {
    const candidate = await temporaryCandidate();
    const repository = candidate.harness.repoPath;
    gitSync(repository, ["config", "status.showUntrackedFiles", "no"]);
    writeFiles(repository, { "hidden.txt": "dropped by a copy of the commit\n" });
    const refused = await refusal(verifyCleanTree(candidate));
    expect(refused.reasonCode).toBe(ReasonCode.SNAPSHOT_STALE);
    expect(existsSync(join(repository, "hidden.txt"))).toBe(true);
    expect(latestVerificationTree(candidate.harness, candidate.run.runId).state).toBe("FAILED");
  });

  it("keeps a linked worktree for every other command", async () => {
    const candidate = await temporaryCandidate();
    const create = vi.spyOn(candidate.harness.cp.worktrees, "create");
    await verifyCleanTree(candidate, parseVerificationCommand({ id: "node-suite", argv: ["node", "-e", "process.exit(0)"], timeoutSeconds: 30 }));
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[4]).toEqual({ selfContained: false });
  });

  it("an interrupted teardown stays DESTROYING, and the orphan sweep removes the checkout once its owner is gone", async () => {
    const candidate = await temporaryCandidate();
    const { harness, run } = candidate;
    vi.spyOn(harness.cp.worktrees, "destroy").mockRejectedValueOnce(new Error("teardown interrupted"));
    await expect(verifyCleanTree(candidate)).rejects.toThrow("teardown interrupted");
    const tree = latestVerificationTree(harness, run.runId);
    const registration = join(dirname(tree.worktree_path), ".verification-checkouts", `${tree.worktree_id}.json`);
    expect(tree.state).toBe("DESTROYING");
    expect(existsSync(tree.worktree_path)).toBe(true);
    expect(existsSync(registration)).toBe(true);

    // While the owner still holds the run, the tree is live and the sweep leaves it.
    await sweepOrphans(harness, "c2v-sweep-live");
    expect(existsSync(tree.worktree_path)).toBe(true);
    expect(existsSync(registration)).toBe(true);

    expect(harness.cp.runs.transition(run.runId, RunState.CANCELLED, "test: owner released the run").allowed).toBe(true);
    const swept = await sweepOrphans(harness, "c2v-sweep-released");
    if (!swept.allowed) throw new Error(`${swept.reasonCode}: ${swept.message}`);
    expect(swept.value.changes).toBe(1);
    expect(existsSync(tree.worktree_path)).toBe(false);
    expect(existsSync(registration)).toBe(false);
  });
});
