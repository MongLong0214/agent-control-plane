import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { boundedSpawnSync } from "../helpers/bounded-sync-child.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * #1107 — a commit message that links an external work session is refused, by the `commit-msg` hook
 * and by the shared checker the hook, CI's range check (`pnpm trailers` under `pnpm gates`) and the
 * merge path all call.
 *
 * Commits already on `main` keep the links they carry: history is not rewritten, and the range check
 * reads only the range it is given. Every link below is synthetic — an all-zero id that names no
 * session — and none of the refusals may print it back.
 */
const ROOT = process.cwd();
const CHECK = join(ROOT, "scripts/verify-trailers-are-parsable.mjs");
const HOOK = join(ROOT, ".githooks/commit-msg");
const SYNTHETIC_ID = "session_0000000000000000000000";
const LINK = `https://claude.ai/code/${SYNTHETIC_ID}`;

/** The hook runs `command -v node`; put the interpreter running this suite first on its PATH. */
const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` };

const messageFile = (message: string): string => {
  const file = join(tempDir("acp-session-link-msg-"), "COMMIT_EDITMSG");
  writeFileSync(file, message);
  return file;
};

type Run = { status: number; out: string };

const viaChecker = (message: string): Run => {
  const done = boundedSpawnSync(process.execPath, [CHECK, "--message-file", messageFile(message)], {
    cwd: ROOT,
    encoding: "utf8",
    env,
  });
  return { status: done.status ?? -1, out: `${done.stdout ?? ""}${done.stderr ?? ""}` };
};

const viaHook = (message: string): Run => {
  const done = boundedSpawnSync(HOOK, [messageFile(message)], { cwd: ROOT, encoding: "utf8", env });
  return { status: done.status ?? -1, out: `${done.stdout ?? ""}${done.stderr ?? ""}` };
};

const LINKED: ReadonlyArray<readonly [string, string]> = [
  ["bare, alone at the end of a squash body", `subject\n\nwhat changed.\n\n${LINK}\n`],
  ["labelled, as a Claude-Session trailer", `subject\n\nwhat changed.\n\nClaude-Session: ${LINK}\n`],
  ["labelled, beside a record trailer", `subject\n\nwhat changed.\n\nLimit: one line\nClaude-Session: ${LINK}\n`],
  ["embedded in prose", `subject\n\nThe work is at ${LINK} if anyone needs it.\n`],
  ["embedded as a markdown link", `subject\n\nSee [the session](${LINK}) for the steps.\n`],
  ["embedded without a scheme", `subject\n\nRan in claude.ai/code/${SYNTHETIC_ID} first.\n`],
  ["a session key carrying no link at all", `subject\n\nwhat changed.\n\nX-Claude-Session: ${SYNTHETIC_ID}\n`],
];

const CLEAN = [
  "subject\n\nA session_id column and a claude.ai mention are prose, not a link.\n\nLimit: one line\n",
  "subject\n\njust a body, nothing to record\n",
];

/** Git's scissors line. Whether git discards what follows depends on a cleanup mode the hook never sees. */
const SCISSORS = "# ------------------------ >8 ------------------------\n# Do not modify or remove the line above.\n";

/** What `git commit -v` hands the hook: the staged diff, below git's scissors line. */
const VERBOSE_TAIL = `${SCISSORS}# Everything below it will be ignored.\ndiff --git a/t.ts b/t.ts\n+const SESSION_URL = "${LINK}";\n`;

describe("a message that links an external work session is refused (#1107)", () => {
  for (const [form, message] of LINKED) {
    it(`refuses it ${form}, through the checker and through the hook`, () => {
      const checked = viaChecker(message);
      expect(checked.status, checked.out).toBe(1);
      expect(checked.out).toContain("external work session");
      const hooked = viaHook(message);
      expect(hooked.status, hooked.out).toBe(1);
      expect(hooked.out).toContain("external work session");
      // The refusal names the line, never the link: a CI log is as public as the commit would be.
      expect(checked.out + hooked.out).not.toContain(SYNTHETIC_ID);
    });
  }

  it("does not blame the trailers for a link, and names both when both are wrong", () => {
    expect(viaHook(LINKED[0]![1]).out).not.toContain("writes a record git will not store");
    const both = viaHook(`subject\n\nbody\n\nLimit: this wraps across\ntwo lines.\n${LINK}\n`);
    expect(both.status).toBe(1);
    expect(both.out).toContain("external work session");
    expect(both.out).toContain("writes a record git will not store");
  });

  it("passes a clean message, through the checker and through the hook", () => {
    for (const message of CLEAN) {
      const checked = viaChecker(message);
      expect(checked.status, checked.out).toBe(0);
      const hooked = viaHook(message);
      expect(hooked.status, hooked.out).toBe(0);
    }
  });

  it("reads the whole file, below git's scissors line too (review r2, R1)", () => {
    // `git commit -F` keeps text below the scissors line, and the hook cannot see the cleanup mode.
    for (const message of [`subject\n\nwhat changed.\n\n${SCISSORS}${LINK}\n`, `subject\n\nwhat changed.\n\n${VERBOSE_TAIL}`]) {
      const checked = viaChecker(message);
      expect(checked.status, checked.out).toBe(1);
      const hooked = viaHook(message);
      expect(hooked.status, hooked.out).toBe(1);
      expect(hooked.out).toContain("external work session");
      expect(checked.out + hooked.out).not.toContain(SYNTHETIC_ID);
    }
  });
});

/**
 * Review r2, R1: the same refusals through a real `git commit`, with this repository's hook and
 * checker installed in a scratch repository. `-F` is the case the scissors cut let through: git
 * stored the link below that line and the hook exited 0.
 */
describe("a real git commit through the hook is refused when it links a work session (#1107)", () => {
  // LC_ALL=C: a localized git translates the scissors line's second line, and the r2 cut never fired.
  const gitEnv = (dir: string): NodeJS.ProcessEnv => ({
    ...env,
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(dir, "absent-gitconfig"),
  });

  const repository = (): { dir: string; git: (args: string[], extra?: NodeJS.ProcessEnv) => Run; head: () => string } => {
    const dir = tempDir("acp-session-link-commit-");
    for (const file of [".githooks/commit-msg", "scripts/verify-trailers-are-parsable.mjs", "scripts/lib/record-trailer-keys.mjs"]) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      copyFileSync(join(ROOT, file), join(dir, file));
    }
    chmodSync(join(dir, ".githooks/commit-msg"), 0o755);
    const git = (args: string[], extra: NodeJS.ProcessEnv = {}): Run => {
      const done = boundedSpawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...gitEnv(dir), ...extra } });
      return { status: done.status ?? -1, out: `${done.stdout ?? ""}${done.stderr ?? ""}` };
    };
    for (const args of [
      ["init", "-q", "-b", "main", "."],
      ["config", "user.email", "fixture@example.invalid"],
      ["config", "user.name", "fixture"],
      ["config", "core.hooksPath", join(dir, ".githooks")],
      ["add", "."],
      ["commit", "-q", "--no-verify", "-m", "fixture"],
    ]) {
      const done = git(args);
      expect(done.status, `git ${args.join(" ")}: ${done.out}`).toBe(0);
    }
    const head = (): string => git(["rev-parse", "HEAD"]).out.trim();
    return { dir, git, head };
  };

  const commitFile = (repo: ReturnType<typeof repository>, message: string): Run =>
    repo.git(["commit", "--allow-empty", "-q", "-F", messageFile(message)]);

  /** A verbose editor commit: git appends the staged diff below its scissors line, then runs this editor. */
  const commitVerbose = (repo: ReturnType<typeof repository>, staged: string): Run => {
    writeFileSync(join(repo.dir, "t.ts"), staged);
    expect(repo.git(["add", "t.ts"]).status).toBe(0);
    const editor = join(repo.dir, "..", "editor.sh");
    writeFileSync(editor, `#!/bin/sh\n{ printf 'verbose subject\\n\\nwhat changed.\\n'; cat "$1"; } > "$1.next" && mv "$1.next" "$1"\n`);
    chmodSync(editor, 0o755);
    return repo.git(["commit", "-q", "-v"], { GIT_EDITOR: editor });
  };

  it("refuses `git commit -F` with a link below the scissors line, and stores nothing", () => {
    const repo = repository();
    const before = repo.head();
    const done = commitFile(repo, `subject\n\nwhat changed.\n\n${SCISSORS}${LINK}\n`);
    expect(done.status, done.out).not.toBe(0);
    expect(done.out).toContain("external work session");
    expect(done.out).not.toContain(SYNTHETIC_ID);
    expect(repo.head()).toBe(before);
  });

  it("still refuses the bare, labelled and embedded forms through `git commit -F`, and stores a clean one", () => {
    const repo = repository();
    const before = repo.head();
    for (const [form, message] of LINKED) {
      const done = commitFile(repo, message);
      expect(done.status, `${form}: ${done.out}`).not.toBe(0);
      expect(done.out).not.toContain(SYNTHETIC_ID);
    }
    expect(repo.head()).toBe(before);
    const clean = commitFile(repo, CLEAN[0]!);
    expect(clean.status, clean.out).toBe(0);
    expect(repo.head()).not.toBe(before);
  });

  it("passes a verbose editor commit whose staged diff links nothing, and stores only the message", () => {
    const repo = repository();
    const done = commitVerbose(repo, "export const answer = 42;\n");
    expect(done.status, done.out).toBe(0);
    expect(repo.git(["log", "-1", "--format=%B"]).out.trim()).toBe("verbose subject\n\nwhat changed.");
  });

  it("refuses a verbose editor commit whose staged diff carries a link: the documented, fail-closed cost", () => {
    // The hook reads every line git hands it, and in a verbose editor commit that includes the diff.
    // docs/SECURITY.md: commit such a change without `-v`, and the message is checked alone.
    const repo = repository();
    const before = repo.head();
    const done = commitVerbose(repo, `export const SESSION_URL = "${LINK}";\n`);
    expect(done.status, done.out).not.toBe(0);
    expect(done.out).toContain("external work session");
    expect(repo.head()).toBe(before);
    const plain = repo.git(["commit", "-q", "-F", messageFile("subject\n\nwhat changed.\n")]);
    expect(plain.status, plain.out).toBe(0);
  });
});

describe("the range check CI runs refuses a commit that links an external work session (#1107)", () => {
  const fixture = (): { git: (...args: string[]) => string; dir: string } => {
    const dir = tempDir("acp-session-link-range-");
    const git = (...args: string[]): string => {
      const done = boundedSpawnSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(dir, "absent-gitconfig") },
      });
      expect(done.status, `git ${args.join(" ")}: ${done.stderr ?? ""}`).toBe(0);
      return (done.stdout ?? "").trim();
    };
    git("init", "-q", "-b", "main", ".");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "fixture");
    return { git, dir };
  };

  const commit = (git: (...args: string[]) => string, message: string): string => {
    git("commit", "-q", "--allow-empty", "--no-verify", "-F", messageFile(message));
    return git("rev-parse", "HEAD");
  };

  /** The real script, reading the fixture repository rather than this one. */
  const verifyRange = (dir: string, range: string): Run => {
    const done = boundedSpawnSync(process.execPath, [CHECK, range], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...env, GIT_DIR: join(dir, ".git"), GIT_WORK_TREE: dir },
    });
    return { status: done.status ?? -1, out: `${done.stdout ?? ""}${done.stderr ?? ""}` };
  };

  it("refuses the range that carries a synthetic link, and passes the one that does not", () => {
    const { git, dir } = fixture();
    const clean = commit(git, "clean subject\n\nnothing linked here.\n");
    const linked = commit(git, `linked subject\n\nwhat changed.\n\nClaude-Session: ${LINK}\n`);

    const refused = verifyRange(dir, `${clean}..${linked}`);
    expect(refused.status, refused.out).toBe(1);
    expect(refused.out).toContain(linked.slice(0, 7));
    expect(refused.out).toContain("external work session");
    expect(refused.out).not.toContain(SYNTHETIC_ID);

    const passed = verifyRange(dir, clean);
    expect(passed.status, passed.out).toBe(0);
  });
});
