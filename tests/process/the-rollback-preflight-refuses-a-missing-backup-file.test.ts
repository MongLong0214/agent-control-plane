import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * Item 6 of `docs/ops/owner-actions.md`, extracted and executed.
 *
 * **On the filename.** This file is named for the procedure it used to guard: a hand-built
 * rollback that named a database backup in one variable and a bytes directory in another and then
 * ran `rm -rf` against the live `dist`. That procedure is gone. Item 6 now runs one command —
 * `install-launchd.sh rollback --pair-id … --expected-index-digest …` — and everything the old
 * preflight did by hand happens inside it. The path is kept rather than renamed because renaming
 * would add a path to this change's ceiling.
 *
 * **What this measures, and why it is not what it used to be.** The previous version extracted
 * only the text between the two markers and asserted, by denylist, that certain strings were not
 * in it. That passed 5/5 against a destructive command placed one line *above* the opening
 * marker: the extraction window never contained it, so nothing ran it and no string search looked
 * for it. A regression that only measures inside its own extraction window is a census wearing a
 * trace's clothes.
 *
 * So two things changed. The window is now **all of item 6** — every indented command line from
 * the item-6 heading to the next section heading, in document order, which is what an operator
 * actually executes. And the assertion is no longer a denylist: a complete inventory of the app
 * root, the state directory and `LaunchAgents` — relative path, type, mode, inode and content
 * digest of every entry — is taken before and after, and must be identical. A destructive command
 * anywhere in item 6 now runs, and anything it touches shows up as a changed digest, a changed
 * inode, a changed mode or a vanished path, whether or not anyone thought to name it.
 *
 * Nothing this test runs can reach the real machine: `HOME` and the app root are both temp
 * directories, and `$APP_ROOT` is supplied by the fixture rather than read out of the document.
 */
const OWNER_ACTIONS = join(process.cwd(), "docs/ops/owner-actions.md");
const INSTALLER = join(process.cwd(), "deploy/install-launchd.sh");
const BEGIN_MARKER = "<!-- owner-actions:rollback-preflight:start -->";
const END_MARKER = "<!-- owner-actions:rollback-preflight:end -->";
const ITEM6_HEADING = "**6. Rollback";
const ITEM6_END_HEADING = "### The sealed rollback pair";

/**
 * Every command line item 6 tells an operator to run, in document order.
 *
 * Deliberately not scoped to the markers. The markers anchor the rollback invocation so an editor
 * cannot quietly move it, but the executable surface is the whole item — a line added anywhere in
 * it is a line the operator runs.
 */
const extractItem6Script = (): string => {
  const text = readFileSync(OWNER_ACTIONS, "utf8");
  const start = text.indexOf(ITEM6_HEADING);
  const end = text.indexOf(ITEM6_END_HEADING);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `docs/ops/owner-actions.md no longer carries item 6 between ${JSON.stringify(ITEM6_HEADING)} ` +
        `and ${JSON.stringify(ITEM6_END_HEADING)}. This fixture has nothing to extract and must ` +
        `fail, not silently skip.`,
    );
  }
  const section = text.slice(start, end);
  for (const marker of [BEGIN_MARKER, END_MARKER]) {
    if (!section.includes(marker)) {
      throw new Error(
        `item 6 no longer carries ${JSON.stringify(marker)}; the rollback invocation has been ` +
          `moved out from under its anchor and this fixture cannot tell what it is guarding.`,
      );
    }
  }
  const commands = section
    .split("\n")
    .filter((line) => line.startsWith("    ") && line.trim().length > 0)
    .map((line) => line.slice(4));
  if (commands.length === 0) {
    throw new Error("item 6 contains no indented command lines at all");
  }
  const script = commands.join("\n");
  if (!script.includes("install-launchd.sh")) {
    throw new Error("item 6 no longer invokes the installer at all");
  }
  return script;
};

const sha256 = (value: Buffer): string => createHash("sha256").update(value).digest("hex");

/**
 * A complete census of everything the documented rollback could reach: relative path, type, mode,
 * inode and content digest. Compared before and after, this sees a truncation, a replacement, a
 * chmod, a deletion and a swap for a symlink alike — including on files nobody thought to name.
 */
const inventory = (roots: Record<string, string>): string => {
  const rows: string[] = [];
  const walk = (label: string, base: string, relative: string): void => {
    const absolute = relative ? join(base, relative) : base;
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      rows.push(`${label}:${relative}\tABSENT`);
      return;
    }
    const type = stat.isSymbolicLink()
      ? "symlink"
      : stat.isDirectory()
        ? "dir"
        : stat.isFile()
          ? "file"
          : "other";
    const content =
      type === "file"
        ? sha256(readFileSync(absolute))
        : type === "symlink"
          ? `->${readlinkSync(absolute)}`
          : "-";
    rows.push(
      `${label}:${relative}\t${type}\t${(stat.mode & 0o7777).toString(8)}\t${stat.ino}\t${content}`,
    );
    if (type === "dir") {
      for (const entry of readdirSync(absolute).sort()) {
        walk(label, base, relative ? `${relative}/${entry}` : entry);
      }
    }
  };
  for (const [label, base] of Object.entries(roots)) walk(label, base, "");
  return rows.sort().join("\n");
};

interface Fixture {
  home: string;
  appRoot: string;
  stateDir: string;
  pairsDir: string;
  launchAgents: string;
  roots: Record<string, string>;
}

/**
 * A disposable deployment. `resolve_app_root` only checks that three files exist, so stubs reach
 * the refusal this test is about — and stubs are the safer fixture, because a real runtime here
 * would be one this test has no business installing.
 */
const makeFixture = (options: { withPairsDir: boolean }): Fixture => {
  const root = tempDir("acp-doc-rollback-");
  const home = join(root, "home");
  const appRoot = join(root, "app-root");
  const stateDir = join(home, ".agent-control-plane");
  const pairsDir = join(stateDir, "rollback-pairs");
  const launchAgents = join(home, "Library", "LaunchAgents");

  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  chmodSync(home, 0o700);
  mkdirSync(launchAgents, { recursive: true, mode: 0o700 });
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
    writeFileSync(stub, "// disposable fixture stub, and a witness: truncating this changes it\n", {
      mode: 0o600,
    });
  }
  writeFileSync(join(stateDir, "agentcpd-launch.sh"), "#!/bin/bash\n# live launcher\n", { mode: 0o700 });
  writeFileSync(join(launchAgents, "com.agentcontrolplane.agentcpd.plist"), "<!-- live plist -->\n", {
    mode: 0o600,
  });

  return {
    home,
    appRoot,
    stateDir,
    pairsDir,
    launchAgents,
    roots: { app: appRoot, state: stateDir, launchAgents },
  };
};

const runItem6 = (
  fixture: Fixture,
  values: { pairId: string; indexDigest: string },
): { status: number | null; stdout: string; trace: string } => {
  const result = spawnSync("bash", ["-x", "-c", extractItem6Script()], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: fixture.home,
      APP_ROOT: fixture.appRoot,
      PAIR_ID: values.pairId,
      INDEX_DIGEST: values.indexDigest,
      SCHEMA_VERSION: "36",
      SERVICE_GENERATION: "generation-under-test",
      NODE_VERSION: "v22.18.0",
    },
  });
  return { status: result.status, stdout: result.stdout, trace: result.stderr };
};

/** Runs item 6 and requires that nothing it could reach changed in any respect. */
const expectRefusalChangesNothing = (
  fixture: Fixture,
  values: { pairId: string; indexDigest: string },
  expectedMessage: string,
): void => {
  const before = inventory(fixture.roots);
  const result = runItem6(fixture, values);

  expect(result.status, `item 6 proceeded instead of refusing: ${result.stdout}`).not.toBe(0);
  expect(result.trace).toContain(expectedMessage);
  expect(
    inventory(fixture.roots),
    "item 6 changed something while refusing — compare the inventory rows above",
  ).toBe(before);
};

describe("item 6 is the sealed-pair rollback and touches nothing when it refuses", () => {
  it("names a pair id and a retained digest, and carries no split-rollback token", () => {
    const script = extractItem6Script();

    expect(script).toContain("install-launchd.sh");
    expect(script).toContain("rollback");
    expect(script).toContain("--pair-id");
    expect(script).toContain("--expected-index-digest");
    expect(script).toContain("$APP_ROOT");

    for (const token of [
      "$BACKUP_PATH",
      "$BYTES_BACKUP",
      "rm -rf",
      "cp -a",
      "state-admin.js",
      "rollback-receipt",
      "sort | tail",
      "--database-backup",
      "deploy-backups",
    ]) {
      expect(script, `item 6 reintroduced ${token}`).not.toContain(token);
    }
    expect(script, "item 6 names a specific machine's checkout").not.toMatch(
      /\/Users\/[A-Za-z0-9._-]+\//,
    );
  });

  it("refuses without a sealed pair, changing nothing anywhere it can reach", () => {
    // The pairs root does not exist. A rollback must say so and leave it not existing — the
    // refusal is free, which is the point, because the commonest reason to run this is to find
    // out whether a rollback is possible at all.
    const fixture = makeFixture({ withPairsDir: false });
    expectRefusalChangesNothing(
      fixture,
      { pairId: "00000000-0000-0000-0000-000000000000", indexDigest: `sha256:${"0".repeat(64)}` },
      "required directory does not exist",
    );
    expect(existsSync(fixture.pairsDir), "a refused rollback created the pairs root").toBe(false);
  });

  it("refuses a pair id that is not there, changing nothing anywhere it can reach", () => {
    // One step deeper: the pairs root exists and the named pair does not. This is the shape an
    // operator hits when they mistype an id or reach for a pair that was never sealed.
    const fixture = makeFixture({ withPairsDir: true });
    expectRefusalChangesNothing(
      fixture,
      { pairId: "11111111-2222-3333-4444-555555555555", indexDigest: `sha256:${"0".repeat(64)}` },
      "no sealed rollback pair with this id",
    );
  });

  it("refuses `latest` and every other name that is not a pair id, changing nothing", () => {
    const fixture = makeFixture({ withPairsDir: true });
    for (const pairId of ["latest", "20260901T000000Z-newest", "../elsewhere"]) {
      expectRefusalChangesNothing(
        fixture,
        { pairId, indexDigest: `sha256:${"0".repeat(64)}` },
        "must be a UUID, never a name like 'latest'",
      );
    }
  });

  it("is a script bash accepts, so a refusal is a refusal and not a syntax error", () => {
    const script = join(tempDir("acp-doc-rollback-syntax-"), "documented-rollback.sh");
    writeFileSync(script, `${extractItem6Script()}\n`, { mode: 0o700 });
    // `bash -n` parses without running. Without this, a block that stopped parsing would exit
    // non-zero for the wrong reason and every refusal row above would pass on a broken document.
    execFileSync("bash", ["-n", script]);
  });
});
