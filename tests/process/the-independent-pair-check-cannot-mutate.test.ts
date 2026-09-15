import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { boundedSpawnSync } from "../helpers/bounded-sync-child.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * The independent pair verification is a program because a brief could not defend the thing it
 * needed to defend.
 *
 * 2026-09-16, delegated as prose to a second session. It ran, meaning to read:
 *
 *     plutil -extract ProgramArguments json <plist>        # no -o
 *
 * Without `-o` that does not print — it **overwrites the target** with the extracted value. The
 * live LaunchAgent plist became a one-element array, and the drift check the session was about to
 * perform would have measured a file it had already rewritten. The brief said "mutate nothing" in
 * eleven places; none of them could help, because the command's shape lied about its direction.
 *
 * So these cases hold the three properties prose cannot: reads leave bytes alone, the run reports
 * on its own non-mutation, and the validator is the verifier's own build rather than the one the
 * deployment already ships.
 */
const ROOT = process.cwd();
const SCRIPT = join(ROOT, "scripts/verify-pair-independently.mjs");

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

const run = (args: readonly string[], cwd = ROOT): { status: number; stdout: string; stderr: string } => {
  const out = boundedSpawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });
  return { status: out.status ?? -1, stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
};

/** A deployment shaped like the real one, entirely inside a temp directory. */
const fixtureDeployment = (): { plist: string; appRoot: string } => {
  const home = tempDir("acp-pair-fixture-");
  const appRoot = join(home, "runtime/generation-fixture");
  mkdirSync(join(appRoot, "dist/bin"), { recursive: true });
  // The generation's node: a copy of this one, so `--version` answers for real.
  copyFileSync(process.execPath, join(appRoot, "dist/bin/node"));
  chmodSync(join(appRoot, "dist/bin/node"), 0o755);
  // A validator where the deployment keeps its own. It must be *present* for the case below to
  // mean anything: with nothing here, a check that reaches for the deployed copy and one that
  // refuses to are indistinguishable, and the mutation survives.
  mkdirSync(join(appRoot, "dist/deploy"), { recursive: true });
  writeFileSync(
    join(appRoot, "dist/deploy/rollback-pair.js"),
    'process.stdout.write("STUB-DEPLOYED-VALIDATOR\\n");\n',
  );
  const launcher = join(home, "agentcpd-launch.sh");
  writeFileSync(
    launcher,
    ["#!/bin/bash", `ACP_STATE_DIR=${home}`, `ACP_APP_ROOT=${appRoot}`, 'exec "$ACP_APP_ROOT/dist/bin/node"'].join("\n"),
  );
  const plist = join(home, "fixture.plist");
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.fixture.agentcpd</string>
  <key>WorkingDirectory</key><string>${appRoot}</string>
  <key>ProgramArguments</key><array><string>${launcher}</string></array>
</dict></plist>
`,
  );
  const database = join(home, "state.sqlite");
  expect(
    boundedSpawnSync("/usr/bin/sqlite3", [database, "PRAGMA user_version = 37; CREATE TABLE t(a);"], {
      encoding: "utf8",
    }).status,
    "the fixture database was not created",
  ).toBe(0);
  return { plist, appRoot };
};

describe("the independent pair check reads without writing", () => {
  it("leaves a property list byte-identical after reading it", async () => {
    // The exact operation the incident destroyed. `readPlist` is exported so this measures the
    // reader itself rather than a whole run that might not reach it.
    const { plist } = fixtureDeployment();
    const before = sha256(plist);
    const module = (await import(`${SCRIPT}?case=readonly`)) as { readPlist: (path: string) => unknown };
    const parsed = module.readPlist(plist) as { Label?: string };
    expect(parsed.Label, "the reader did not actually parse the plist").toBe("com.fixture.agentcpd");
    expect(sha256(plist), "reading the plist changed it").toBe(before);
  });

  it("parses a launcher as text instead of running it", async () => {
    // A launcher is a program. Sourcing one to learn what it assigns is the same category of
    // mistake as `-extract`: an action that looks like a question.
    const module = (await import(`${SCRIPT}?case=launcher`)) as {
      launcherAssignment: (text: string, name: string) => string | null;
    };
    expect(module.launcherAssignment('export ACP_APP_ROOT="/a/b"\n', "ACP_APP_ROOT")).toBe("/a/b");
    expect(module.launcherAssignment("ACP_STATE_DIR=/c/d\n", "ACP_STATE_DIR")).toBe("/c/d");
    expect(module.launcherAssignment("nothing here\n", "ACP_APP_ROOT")).toBeNull();
  });
});

describe("the independent pair check refuses what it cannot answer honestly", () => {
  it("needs both a pair root and a receipt", () => {
    expect(run([]).status).toBe(2);
    expect(run(["--pair-root", ROOT]).status).toBe(2);
  });

  it("refuses a receipt that lives inside the pair", () => {
    // A pair cannot prove its own index: rewrite a member, rewrite its line, and every internal
    // check agrees. The external receipt is the whole defence, so a receipt taken from inside the
    // pair is not one.
    const pair = tempDir("acp-pair-inside-");
    const receipt = join(pair, "receipt.txt");
    writeFileSync(receipt, "ACP_PAIR_ID=x\nACP_PAIR_INDEX_DIGEST=sha256:y\n");
    const { status, stdout } = run(["--pair-root", pair, "--receipt", receipt]);
    expect(status).toBe(2);
    expect(stdout).toContain("the receipt is inside the pair");
  });

  it("uses the verifier's own build, never the one the deployment ships", () => {
    // The mutant this kills is the draft that preferred `$APP_ROOT/dist/deploy/rollback-pair.js`.
    // That copy is whatever the deployment was built from — here a generation that predates #929
    // and refuses pnpm store paths — so validating with it asks the question the deployment has
    // already answered for itself. Copied to a directory with no sibling `dist`, the check must
    // say so rather than reach for the deployed one.
    const elsewhere = tempDir("acp-pair-nodist-");
    mkdirSync(join(elsewhere, "scripts"), { recursive: true });
    const copied = join(elsewhere, "scripts/verify-pair-independently.mjs");
    copyFileSync(SCRIPT, copied);
    const { plist } = fixtureDeployment();
    const pair = tempDir("acp-pair-root-");
    const receipt = join(tempDir("acp-pair-receipt-"), "receipt.txt");
    writeFileSync(receipt, "ACP_PAIR_ID=x\nACP_PAIR_INDEX_DIGEST=sha256:y\nservice_generation=g\n");

    const out = boundedSpawnSync(
      process.execPath,
      [copied, "--pair-root", pair, "--receipt", receipt, "--plist", plist],
      { cwd: elsewhere, encoding: "utf8" },
    );
    expect(out.status).toBe(2);
    expect(out.stdout ?? "").toContain("no dist/deploy/rollback-pair.js");
    // The deployment's copy is right there and runnable. Reaching for it is the mutation.
    expect(out.stdout ?? "", "the deployed validator was used").not.toContain("STUB-DEPLOYED-VALIDATOR");
  });
});

describe("the independent pair check proves its instrument before trusting its answer", () => {
  it("reports that the validator accepted a known-bad expectation, instead of only its own PASS", () => {
    // A verifier that has only ever reported PASS on a good input has not shown it can fail. The
    // second session established that by hand, once; a property an operator has to remember is not
    // a property. Here the validator is a stub that succeeds on anything, so a run that does not
    // probe it would report an unqualified PASS — and this asserts the probe happened and said so.
    const elsewhere = tempDir("acp-pair-stubval-");
    mkdirSync(join(elsewhere, "scripts"), { recursive: true });
    mkdirSync(join(elsewhere, "dist/deploy"), { recursive: true });
    writeFileSync(join(elsewhere, "dist/deploy/rollback-pair.js"), "process.stdout.write(\"ALWAYS-OK\\n\");\n");
    const copied = join(elsewhere, "scripts/verify-pair-independently.mjs");
    copyFileSync(SCRIPT, copied);
    const { plist } = fixtureDeployment();
    const pair = tempDir("acp-pair-stub-root-");
    const receipt = join(tempDir("acp-pair-stub-receipt-"), "receipt.txt");
    writeFileSync(receipt, "ACP_PAIR_ID=x\nACP_PAIR_INDEX_DIGEST=sha256:y\nservice_generation=g\n");

    const out = boundedSpawnSync(
      process.execPath,
      [copied, "--pair-root", pair, "--receipt", receipt, "--plist", plist],
      { cwd: elsewhere, encoding: "utf8" },
    );
    const stdout = out.stdout ?? "";
    expect(stdout, "the run never reported on whether its validator can fail").toContain("CAN_FAIL");
    expect(stdout, "a validator that accepts a bogus pair id was not called out").toContain("ACCEPTED");
    expect(out.status, "a validator that cannot fail was reported as a pass").not.toBe(0);
  });
});
