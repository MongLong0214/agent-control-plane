import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * The operator-facing rollback block in `docs/ops/owner-actions.md`, extracted and executed.
 *
 * **On the filename.** This file is named for the procedure it used to guard: a hand-built
 * rollback that named a database backup in one variable and a bytes directory in another, checked
 * each file it was about to consume, and then ran `rm -rf` against the live `dist`. That procedure
 * is gone. The block now runs one command — `install-launchd.sh rollback --pair-id …
 * --expected-index-digest …` — and everything the preflight used to do by hand happens inside it,
 * against one sealed artifact instead of two independently chosen halves. The path is kept rather
 * than renamed because renaming would add a path to this change's ceiling; what it asserts is
 * stated here and in the row names below.
 *
 * Two claims, and they fail for different reasons:
 *
 *   1. The block selects nothing. It names a pair id and a retained digest, and carries none of
 *      the tokens the split procedure needed — no `$BACKUP_PATH`, no `$BYTES_BACKUP`, no
 *      `rm -rf`, no operator-specific checkout path. Reintroduce any of them and this row fails
 *      on the token it found.
 *   2. The block is fail-closed *when run*. A census over text cannot tell a document that
 *      refuses from one that proceeds, so the extracted script is executed for real, under
 *      `bash -x`, against disposable stand-ins for `$HOME` and the app root. It must exit
 *      non-zero, it must create nothing — not even the directory it looked in — and the trace
 *      must never contain a destructive command. A block that regressed to the old procedure
 *      would fail here on the `rm -rf` in its own trace, not merely on a missing string.
 *
 * Nothing this test runs can reach the real machine: `HOME` and the app root are both temp
 * directories, and the block's own `$APP_ROOT` is supplied from the fixture rather than read out
 * of the document.
 */
const OWNER_ACTIONS = join(process.cwd(), "docs/ops/owner-actions.md");
const INSTALLER = join(process.cwd(), "deploy/install-launchd.sh");
const BEGIN_MARKER = "<!-- owner-actions:rollback-preflight:start -->";
const END_MARKER = "<!-- owner-actions:rollback-preflight:end -->";

/** Tokens the split rollback needed and the sealed-pair rollback must never bring back. */
const OBSOLETE_TOKENS = [
  "$BACKUP_PATH",
  "$BYTES_BACKUP",
  "rm -rf",
  "cp -a",
  "state-admin.js",
  "rollback-receipt",
  "sort | tail",
  "--database-backup",
  "deploy-backups",
] as const;

/** Commands that must never appear in the trace of a refused rollback. */
const DESTRUCTIVE_TRACE = ["rm -rf", "cp -a", "state-admin.js", "launchctl", "mv -f"] as const;

/**
 * Extracts the operator-facing block verbatim.
 *
 * Fails loudly — never returns an empty or partial script — if the markers are gone, out of
 * order, or the block has drifted away from the 4-space indented code-block shape the doc uses.
 * A fixture that quietly finds nothing to run is worse than no fixture: silence here would read
 * as "still fail-closed" while actually testing nothing.
 */
const extractRollbackScript = (): string => {
  const text = readFileSync(OWNER_ACTIONS, "utf8");
  const start = text.indexOf(BEGIN_MARKER);
  const end = text.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `docs/ops/owner-actions.md no longer carries both rollback-preflight markers ` +
        `(${JSON.stringify(BEGIN_MARKER)} / ${JSON.stringify(END_MARKER)}). This fixture has ` +
        `nothing to extract and must fail, not silently skip.`,
    );
  }
  const body = text.slice(start + BEGIN_MARKER.length, end);
  const lines = body.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    throw new Error("the rollback-preflight markers in docs/ops/owner-actions.md bound no lines");
  }
  const stripped = lines.map((line) => {
    if (!line.startsWith("    ")) {
      throw new Error(
        `a line between the rollback-preflight markers is not 4-space indented as a code block: ` +
          JSON.stringify(line),
      );
    }
    return line.slice(4);
  });
  const script = stripped.join("\n");
  if (!script.includes("install-launchd.sh")) {
    throw new Error("the extracted rollback script no longer invokes the installer at all");
  }
  return script;
};

/**
 * A disposable deployment the extracted block can be pointed at.
 *
 * `resolve_app_root` only checks that three files exist, so stubs are enough to reach the
 * refusal this test is about — and stubs are the safer fixture, because a real `dist` copy here
 * would be a runtime this test has no business installing.
 */
interface Fixture {
  home: string;
  appRoot: string;
  stateDir: string;
  pairsDir: string;
}

const makeFixture = (options: { withPairsDir: boolean }): Fixture => {
  const root = tempDir("acp-doc-rollback-");
  const home = join(root, "home");
  const appRoot = join(root, "app-root");
  const stateDir = join(home, ".agent-control-plane");
  const pairsDir = join(stateDir, "rollback-pairs");

  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  chmodSync(home, 0o700);
  if (options.withPairsDir) {
    mkdirSync(pairsDir, { recursive: true, mode: 0o700 });
    chmodSync(pairsDir, 0o700);
  }

  mkdirSync(join(appRoot, "deploy"), { recursive: true, mode: 0o700 });
  mkdirSync(join(appRoot, "dist", "daemon"), { recursive: true, mode: 0o700 });
  mkdirSync(join(appRoot, "dist", "db"), { recursive: true, mode: 0o700 });
  mkdirSync(join(appRoot, "dist", "deploy"), { recursive: true, mode: 0o700 });
  // The real installer, not a stand-in: the claim is about what this document tells an operator
  // to run, and a stub would pass for any installer including one that never refuses.
  copyFileSync(INSTALLER, join(appRoot, "deploy", "install-launchd.sh"));
  for (const stub of [
    join(appRoot, "deploy", "render-launchd-plist.mjs"),
    join(appRoot, "dist", "daemon", "agentcpd.js"),
    join(appRoot, "dist", "db", "state-admin.js"),
    join(appRoot, "dist", "deploy", "rollback-pair.js"),
  ]) {
    writeFileSync(stub, "// disposable fixture stub\n", { mode: 0o600 });
  }

  return { home, appRoot, stateDir, pairsDir };
};

const runExtractedScript = (
  fixture: Fixture,
  values: { pairId: string; indexDigest: string },
): { status: number | null; stdout: string; trace: string } => {
  const script = extractRollbackScript();
  const result = spawnSync("bash", ["-x", "-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: fixture.home,
      APP_ROOT: fixture.appRoot,
      PAIR_ID: values.pairId,
      INDEX_DIGEST: values.indexDigest,
    },
  });
  return { status: result.status, stdout: result.stdout, trace: result.stderr };
};

describe("the documented rollback is the sealed pair and nothing else", () => {
  it("names a pair id and a retained digest, and carries no split-rollback token", () => {
    const script = extractRollbackScript();

    expect(script).toContain("install-launchd.sh");
    expect(script).toContain("rollback");
    expect(script).toContain("--pair-id");
    expect(script).toContain("--expected-index-digest");

    for (const token of OBSOLETE_TOKENS) {
      expect(script, `the documented rollback reintroduced ${token}`).not.toContain(token);
    }
    // No operator-specific checkout path: the block is parameterised, so it is the same procedure
    // on any machine and names nobody's home directory.
    expect(script, "the documented rollback names a specific machine's checkout").not.toMatch(
      /\/Users\/[A-Za-z0-9._-]+\//,
    );
    expect(script).toContain("$APP_ROOT");
  });

  it("refuses without a sealed pair, creating nothing and running nothing destructive", () => {
    // The pairs root does not exist. A rollback must say so and leave it not existing — the
    // refusal is free, which is the point, because the commonest reason to run this is to find
    // out whether a rollback is possible at all.
    const fixture = makeFixture({ withPairsDir: false });
    const before = readdirSync(fixture.stateDir).sort();
    const modeBefore = statSync(fixture.stateDir).mode;

    const result = runExtractedScript(fixture, {
      pairId: "00000000-0000-0000-0000-000000000000",
      indexDigest: `sha256:${"0".repeat(64)}`,
    });

    expect(result.status, `the documented rollback proceeded: ${result.stdout}`).not.toBe(0);
    expect(result.trace).toContain("required directory does not exist");
    expect(existsSync(fixture.pairsDir), "a refused rollback created the pairs root").toBe(false);
    expect(readdirSync(fixture.stateDir).sort()).toEqual(before);
    expect(statSync(fixture.stateDir).mode).toBe(modeBefore);

    for (const command of DESTRUCTIVE_TRACE) {
      expect(result.trace, `the documented rollback traced ${command} before refusing`).not.toContain(
        command,
      );
    }
  });

  it("refuses a pair id that is not there, still without touching the deployment", () => {
    // One step deeper: the pairs root exists and the named pair does not. This is the shape an
    // operator hits when they mistype an id or reach for a pair that was never sealed.
    const fixture = makeFixture({ withPairsDir: true });
    const installedBefore = readdirSync(join(fixture.appRoot, "dist")).sort();

    const result = runExtractedScript(fixture, {
      pairId: "11111111-2222-3333-4444-555555555555",
      indexDigest: `sha256:${"0".repeat(64)}`,
    });

    expect(result.status, `the documented rollback proceeded: ${result.stdout}`).not.toBe(0);
    expect(result.trace).toContain("no sealed rollback pair with this id");
    expect(readdirSync(fixture.pairsDir)).toEqual([]);
    expect(readdirSync(join(fixture.appRoot, "dist")).sort()).toEqual(installedBefore);

    for (const command of DESTRUCTIVE_TRACE) {
      expect(result.trace, `the documented rollback traced ${command} before refusing`).not.toContain(
        command,
      );
    }
  });

  it("refuses `latest` and every other name that is not a pair id", () => {
    const fixture = makeFixture({ withPairsDir: true });
    for (const pairId of ["latest", "20260901T000000Z-newest", "../elsewhere"]) {
      const result = runExtractedScript(fixture, { pairId, indexDigest: `sha256:${"0".repeat(64)}` });
      expect(result.status, `the documented rollback accepted ${pairId}`).not.toBe(0);
      expect(result.trace).toContain("must be a UUID, never a name like 'latest'");
    }
  });

  it("is a script bash accepts, so a refusal is a refusal and not a syntax error", () => {
    const script = join(tempDir("acp-doc-rollback-syntax-"), "documented-rollback.sh");
    writeFileSync(script, `${extractRollbackScript()}\n`, { mode: 0o700 });
    // `bash -n` parses without running. Without this, a block that stopped parsing would exit
    // non-zero for the wrong reason and every refusal row above would pass on a broken document.
    execFileSync("bash", ["-n", script]);
  });
});
