import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boundedSpawnSync } from "../helpers/bounded-sync-child.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);
const ROOT = process.cwd();
const run = (file: string, args: string[], cwd: string, env = process.env, input?: string) =>
  boundedSpawnSync(file, args, { cwd, env, encoding: "utf8", ...(input === undefined ? {} : { input }) });

const fixture = (count = 8) => {
  const dir = tempDir("acp-official-records-");
  const git = (...args: string[]) => {
    const result = run("git", args, dir);
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "fixture");
  git("config", "user.email", "fixture@example.invalid");
  // merge-pr.mjs refuses a copy that differs from the current base of the pull request's repository,
  // so the base holds the script bytes that run (and `currentCheckout` gives it that origin).
  cpSync(join(ROOT, "scripts"), join(dir, "scripts"), { recursive: true });
  git("add", "scripts");
  const tree = git("write-tree");
  const base = git("commit-tree", tree, "-m", "base");
  let head = base;
  for (let i = 0; i < count; i += 1) {
    head = git("commit-tree", tree, "-p", head, "-m",
      `fixture ${String(i)}\n\nLimit: synthetic constraint ${String(i)}\nRecord-Id: r-fixture${String(i)}\nProvenance: drafted\nUnverified: live behavior\n`);
  }
  // The merge helper runs from the destination checkout, not the source branch:
  // semantic references must see the history the squash will actually extend.
  git("update-ref", "refs/heads/main", base);
  git("update-ref", "refs/heads/feature", head);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const pinnedCli = join(ROOT, "node_modules/.commitlore-cli/dist/commitlore.mjs");
  const cli = existsSync(pinnedCli) ? pinnedCli : run("which", ["commitlore"], ROOT).stdout.trim();
  expect(cli, "official CommitLore 1.5.0 is required (no skipped integration)").not.toBe("");
  symlinkSync(cli, join(bin, "commitlore"));
  // Copy the tracked executable, rather than generating executable source in the test.
  const gh = join(bin, "gh");
  writeFileSync(gh, readFileSync(join(ROOT, "tests/helpers/merge-gh-fixture.mjs")));
  chmodSync(gh, 0o755);
  const message = join(dir, "outgoing.message");
  // The pull request as merge-gh-fixture.mjs answers it by default, with the repository and base it is in.
  const ghWorld = join(dir, "gh-world.json");
  writeFileSync(ghWorld, JSON.stringify({ pr: {
    state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", title: "fixture", baseRefOid: base, headRefOid: head,
    statusCheckRollup: [{ name: "verify", status: "COMPLETED", conclusion: "SUCCESS", completedAt: "2026-10-02T00:00:00Z" }],
    baseRefName: "main", url: "https://github.com/test/repo/pull/1",
  } }));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, GIT_DIR: join(dir, ".git"),
    GIT_WORK_TREE: dir, FIXTURE_BASE: base, FIXTURE_HEAD: head, FIXTURE_MESSAGE: message, FIXTURE_GH_WORLD: ghWorld };
  expect(run("commitlore", ["--version"], dir, env).stdout.trim()).toBe("1.5.0");
  const expected = join(dir, "official.message");
  writeFileSync(expected, "merge fixture\n\nSummary.\n");
  const rendered = run("commitlore", ["squash-preserve", `${base}..${head}`, "--message-file", expected, "--json"], dir, env);
  expect(rendered.status, rendered.stderr).toBe(0);
  const body = join(dir, "body");
  writeFileSync(body, "Summary.\n");
  return { dir, git, tree, base, head, env, expected, message, body };
};

/**
 * The fixture as a current checkout of test/repo, for merge-pr.mjs: origin is that repository,
 * holding the base, reached offline through a stand-in ssh. Only the merge needs it; with a remote,
 * the trailer checks the other cases run also want origin's notes ref, which is not their subject.
 */
const currentCheckout = (f: ReturnType<typeof fixture>): NodeJS.ProcessEnv => {
  const remotes = tempDir("acp-official-origin-");
  mkdirSync(join(remotes, "test"));
  f.git("init", "-q", "--bare", "-b", "main", join(remotes, "test", "repo.git"));
  f.git("push", "-q", "--no-verify", join(remotes, "test", "repo.git"), "main");
  f.git("remote", "add", "origin", "git@github.com:test/repo.git");
  const ssh = join(f.dir, "bin", "fake-ssh");
  writeFileSync(ssh, `#!/bin/sh\nfor last; do :; done\nunset GIT_DIR GIT_WORK_TREE\ncd '${remotes}' || exit 128\nexec /bin/sh -c "git \${last#git-}"\n`);
  chmodSync(ssh, 0o755);
  return { ...f.env, GIT_SSH_COMMAND: `'${ssh}'`, GIT_SSH_VARIANT: "simple" };
};

/**
 * After merging, `merge-pr.mjs` reads the merge commit back. The `gh` fixture composes no merge
 * commit and answers no API read, so that read-back refuses loudly once the merge call is made;
 * a-merge-names-the-head-it-checked.test.ts reads a real one back.
 */
const READ_BACK_REFUSED = "RESULT: FAIL — #1 is merged, and reading it back does not match what was checked";

// Copy exact production modules into a disposable module root. No production
// resolver seam, inherited PATH, HOME installation or repository node_modules is used.
const hermeticFixture = (checks: unknown) => {
  const dir = tempDir("acp-check-completion-");
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  mkdirSync(bin);
  mkdirSync(home);
  mkdirSync(join(dir, "scripts/lib"), { recursive: true });
  for (const path of ["scripts/verify-trailers-are-parsable.mjs", "scripts/lib/record-trailer-keys.mjs"]) {
    writeFileSync(join(dir, path), readFileSync(join(ROOT, path)));
  }
  symlinkSync(process.execPath, join(bin, "node"));
  symlinkSync(run("which", ["git"], ROOT).stdout.trim(), join(bin, "git"));
  const responses = join(dir, "responses.json");
  const log = join(dir, "argv.jsonl");
  const blocks = [0, 1].map((i) => ({ trailers: [
    { key: "Limit", value: `synthetic constraint ${String(i)}` },
    { key: "Record-Id", value: `r-fixture${String(i)}` },
    { key: "Provenance", value: "drafted" },
  ] }));
  const message = join(dir, "candidate.message");
  writeFileSync(message, "fixture\n\n" + blocks.map((b) => b.trailers.map((t) => `${t.key}: ${t.value}`).join("\n")).join("\n\n") + "\n");
  writeFileSync(responses, JSON.stringify({ validate: { checks }, parse: { blocks } }));
  const env = { PATH: bin, HOME: home, XDG_DATA_HOME: home, NODE_PATH: "", GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, "absent"), FIXTURE_CLI_RESPONSES: responses, FIXTURE_CLI_LOG: log };
  const git = (...args: string[]) => {
    const result = run("git", args, dir, env);
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git("init", "-q");
  git("config", "user.name", "fixture");
  git("config", "user.email", "fixture@example.invalid");
  const script = join(dir, "scripts/verify-trailers-are-parsable.mjs");
  // Probe before installing the test executable: this exact context cannot find
  // the real CLI through PATH, HOME or a module-root fallback.
  expect(run("commitlore", ["--version"], dir, env).error).toMatchObject({ code: "ENOENT" });
  expect(run(process.execPath, [script, "--message-file", message], dir, env).status).toBe(1);
  expect(existsSync(log)).toBe(false);
  const cli = join(bin, "commitlore");
  writeFileSync(cli, readFileSync(join(ROOT, "tests/helpers/merge-gh-fixture.mjs")));
  chmodSync(cli, 0o755);
  return { dir, env, git, script, message, log };
};

const completeChecks = [{ class: "shape", status: "ok" }, { class: "reference", status: "ok" }];
describe("hermetic required-check completion", () => {
  it.each([
    ["empty", []],
    ["shape only", [completeChecks[0]]],
    ["reference only", [completeChecks[1]]],
    ["duplicate shape", [...completeChecks, completeChecks[0]]],
    ["duplicate reference", [...completeChecks, completeChecks[1]]],
    ["failed shape", [{ class: "shape", status: "failed" }, completeChecks[1]]],
    ["failed reference", [completeChecks[0], { class: "reference", status: "failed" }]],
    ["unknown only", [{ class: "other", status: "ok" }]],
    ["unknown extra", [...completeChecks, { class: "other", status: "ok" }]],
    ["malformed", null],
    ["malformed member", [null, completeChecks[1]]],
    ["missing status", [{ class: "shape" }, completeChecks[1]]],
  ])("rejects %s", (_name, checks) => {
    const f = hermeticFixture(checks);
    const result = run(process.execPath, [f.script, "--message-file", f.message], f.dir, f.env);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain("RESULT: FAIL");
    expect(JSON.parse(readFileSync(f.log, "utf8").trim())).toEqual(["validate", "--message-file", f.message, "--json"]);
  });

  it.each([completeChecks, [...completeChecks].reverse()])("accepts the complete checks in either order (%j)", (...checks) => {
    const f = hermeticFixture(checks);
    const result = run(process.execPath, [f.script, "--message-file", f.message], f.dir, f.env);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const sha = f.git("commit-tree", f.git("mktree"), "-F", f.message);
    const committed = run(process.execPath, [f.script, sha], f.dir, f.env);
    expect(committed.status, committed.stdout + committed.stderr).toBe(0);
    const calls = readFileSync(f.log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(calls).toEqual([
      ["validate", "--message-file", f.message, "--json"], ["parse", "--json"],
      ["validate", "--commit", sha, "--json"], ["parse", "--json"],
    ]);
  });
});

// Default CI is hermetic and does not install CommitLore. The separately
// required local integration gate is explicit, never skipped by CLI discovery:
// ACP_COMMITLORE_INTEGRATION=1 pnpm exec vitest run tests/process/official-merge-records.test.ts
const officialIntegration = describe.runIf(process.env.ACP_COMMITLORE_INTEGRATION === "1");
officialIntegration("the merge helper preserves the official record paragraphs", () => {
  it("sends the validated message unchanged, and the branch's eight official records stay on its commits (#1269)", () => {
    const f = fixture();
    const result = run(process.execPath, [join(ROOT, "scripts/merge-pr.mjs"), "1", "--subject", "merge fixture", "--body-file", f.body], ROOT, currentCheckout(f));
    expect(result.stdout).toContain(READ_BACK_REFUSED);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(readFileSync(f.message, "utf8")).toBe("merge fixture\n\nSummary.\n");
    const merged = f.git("commit-tree", f.tree, "-p", f.base, "-p", f.head, "-F", f.message);
    const ids = f.git("log", "--format=%(trailers:key=Record-Id,valueonly)", `${f.base}..${merged}`).split("\n").filter(Boolean);
    expect(ids.sort()).toEqual(Array.from({ length: 8 }, (_, i) => `r-fixture${String(i)}`));
  });
});

const check = (f: ReturnType<typeof fixture>, message: string, exact = false) => {
  const file = join(f.dir, "candidate.message");
  writeFileSync(file, message);
  return run(process.execPath, [join(ROOT, "scripts/verify-trailers-are-parsable.mjs"), "--message-file", file,
    ...(exact ? ["--expected-message-file", f.expected] : [])], ROOT, f.env);
};

officialIntegration("preservation is not a semantic exemption", () => {
  it("rejects missing, reordered, duplicated and mutated official bytes", () => {
    const f = fixture();
    const official = readFileSync(f.expected, "utf8");
    expect(check(f, official, true).status).toBe(0);
    const paragraphs = official.trimEnd().split("\n\n");
    const prefix = paragraphs.slice(0, 2);
    const records = paragraphs.slice(2);
    const variants = [
      [...prefix, ...records.slice(1)].join("\n\n") + "\n",
      [...prefix, ...records.slice().reverse()].join("\n\n") + "\n",
      [...prefix, ...records, records[0]].join("\n\n") + "\n",
      official.replace("constraint 0", "constraint changed"),
      official.replace("Provenance: inherited", "Provenance: reconstructed"),
      official.replace("Unverified: live behavior\n", ""),
    ];
    for (const message of variants) {
      const result = check(f, message, true);
      expect(result.status, result.stdout).toBe(1);
      expect(result.stdout).toContain("official message bytes changed");
    }
  });

  it("rejects malformed records, duplicate identities, collapsed paragraphs and trailing prose without a byte oracle", () => {
    const f = fixture(2);
    const official = readFileSync(f.expected, "utf8");
    const variants = [
      official.replace("r-fixture1", "r-fixture0"),
      official.replace("Limit: synthetic constraint 0", "Ruled-out: no separator"),
      official.replace("Limit: synthetic constraint 0", "Blast: invalid"),
      official.replace("Limit: synthetic constraint 0", "Limit: synthetic\nwrapped text"),
      official.replace("\n\nLimit: synthetic constraint 1", "\nLimit: synthetic constraint 1"),
      official + "\nprose after the records\n",
      official.replace("\n\nLimit: synthetic constraint 1", "\n\nsecond title\n\nLimit: synthetic constraint 1"),
    ];
    for (const message of variants) expect(check(f, message).status, message).toBe(1);
  });

  it("keeps ordinary Git trailer parsing for one record", () => {
    const f = fixture(1);
    const message = readFileSync(f.expected, "utf8");
    const parsed = run("git", ["interpret-trailers", "--parse"], f.dir, f.env, message).stdout;
    expect(message.endsWith(parsed)).toBe(true);
    expect(check(f, message.replace("Limit: synthetic constraint 0", "Limit: synthetic\nwrapped text")).status).toBe(1);
  });

  it("accepts the raw multi-record commit without a repairing note", () => {
    const f = fixture(2);
    const sha = f.git("commit-tree", f.tree, "-F", f.expected);
    const result = run(process.execPath, [join(ROOT, "scripts/verify-trailers-are-parsable.mjs"), sha], ROOT, f.env);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("rejects a dangling reference rather than validating stdin without history", () => {
    const f = fixture(2);
    const message = readFileSync(f.expected, "utf8").replace("Limit: synthetic constraint 0", "Supersedes: r-missingrecord\nLimit: synthetic constraint 0");
    expect(check(f, message).status).toBe(1);
  });
});
