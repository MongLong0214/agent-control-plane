import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  COMMITLORE_LIMITS,
  COMMITLORE_OBSERVATION_ARGV,
  commitloreRunner,
  createCommitLoreCliPort,
  probeCommitLore,
  requiredCommitLoreObservation,
} from "../../src/bootstrap/commitlore-observation.ts";
import { cleanupTempDirs, makeRepo, tempDir, writeFiles } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * FIX-B3-OBSERVE R2 (CEO c3c052bf) — the required observation runs `init` with `--no-agent-hooks`, so a
 * CommitLore that offers it leaves the checkout's working tree as it found it, and the pin's checks refuse a
 * CommitLore whose `init` does not offer it (`NO_INIT_OPTION`) before any `init` runs, with no fallback to the
 * argv without it. The changed-checkout guard is unchanged: whatever `init` does, any working-tree change
 * after the observation refuses, a user's change made before it included, and nothing is ignored or removed.
 *
 * Every CommitLore here is a fake run by this Node, standing in for the two real builds measured in
 * `followup-fix/b3-observe-evidence`: the released 1.7.4, whose `init` has no `--no-agent-hooks` and writes
 * `.claude/settings.json` into the tree, and commitlore main (4501ef68, unreleased), whose `init
 * --no-agent-hooks` writes only under `.git`. It answers only what such a build answers; anything else is
 * refused with exit 2, as the real CLI refuses an unknown option.
 */

const INIT = COMMITLORE_OBSERVATION_ARGV[0]?.join(" ") as string;
const OLD_INIT = "init --mcp-scope none --no-unattended";
const CHECKS = ["--version", "doctor --help", "init --help"];

const INIT_OPTIONS_1_7_4 = [
  "  --mcp-scope <scope>  where to register the capture server: user, project,",
  "                       local, none (skips the prompt; default user)",
  "  --force              forward to hooks install — replace an already-preserved",
  "                       foreign hook",
  "  --json               emit the report as JSON",
  "  --unattended         enable unattended capture if the repository has no policy",
  "                       file yet (skips the prompt; for scripts)",
  "  --no-unattended      leave unattended capture off if the repository has no",
  "                       policy file yet (skips the prompt; for scripts)",
  "  --agents-md          also write the capture procedure into AGENTS.md (off by",
  "                       default; the MCP server already carries it)",
];
const NO_AGENT_HOOKS_OPTION = [
  "  --no-agent-hooks     write nothing inside the working tree: skip the",
  "                       PreToolUse injection hook at .claude/settings.json (for a",
  "                       caller that must keep the checkout clean)",
];
const initUsage = (offersNoAgentHooks: boolean): string =>
  [
    "Usage: commitlore init [options]",
    "",
    "Options:",
    ...INIT_OPTIONS_1_7_4,
    ...(offersNoAgentHooks ? NO_AGENT_HOOKS_OPTION : []),
    "  -h, --help           display help for command",
    "",
    // The prose names the option too, as upstream's does: only an option line offers it.
    "`--no-agent-hooks` skips the one working-tree write.",
    "",
  ].join("\n");

// What commitlore main's `doctor --json` reports after `init --no-agent-hooks` in a repository with no remote.
const DEGRADED_REPORT = JSON.stringify({
  schema: "commitlore_doctor.v2",
  status: "degraded",
  exitCode: 0,
  checks: [
    { id: "commit-msg-hook", status: "ok" },
    { id: "notes-refspec", status: "warn", detail: "no remote is configured" },
    { id: "inject-runtime", status: "warn", detail: "not installed", needsAttention: true },
    { id: "inject-version", status: "skipped", skipReason: "no installed hook to compare against" },
  ],
});

interface FakeOptions {
  /** Whether `init --help` lists `--no-agent-hooks`, and `init` takes it (commitlore main) or refuses it (1.7.4). */
  offersNoAgentHooks: boolean;
  /** An observer that writes into the working tree although it was asked not to. */
  writesIntoTreeAnyway?: boolean;
}

/**
 * A fake `commitlore` in a directory of its own, logging every argv. Its `init`, with the argv it takes, installs
 * a commit-msg hook under `.git`; the argv without `--no-agent-hooks` (1.7.4's) also writes the injection hook
 * into the tree, as 1.7.4 does.
 */
const fake = (name: string, { offersNoAgentHooks, writesIntoTreeAnyway = false }: FakeOptions): { bin: string; log: string } => {
  const dir = tempDir(`acp-r2-${name}-`);
  const bin = join(dir, "commitlore");
  const log = join(dir, "argv.log");
  writeFileSync(join(dir, "package.json"), '{"type":"commonjs"}');
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2).join(' ');
fs.appendFileSync(${JSON.stringify(log)}, argv + '\\n');
const answer = (text, code) => process.stdout.write(text, () => process.exit(code));
const refuse = () => process.stderr.write("error: unknown option '" + argv + "'\\n", () => process.exit(2));
const gitHook = () => { fs.mkdirSync('.git/hooks', { recursive: true }); fs.writeFileSync('.git/hooks/commit-msg', '#!/bin/sh\\n', { mode: 0o755 }); };
const agentHook = () => { fs.mkdirSync('.claude', { recursive: true }); fs.writeFileSync('.claude/settings.json', '{"hooks":{}}\\n'); };
if (argv === '--version') answer('1.7.4\\n', 0);
else if (argv === 'doctor --help') answer('Usage: commitlore doctor [options]\\n  --json             emit the report as JSON\\n', 0);
else if (argv === 'init --help') answer(${JSON.stringify(initUsage(offersNoAgentHooks))}, 0);
else if (argv === ${JSON.stringify(OLD_INIT)}) { gitHook(); agentHook(); answer('', 0); }
else if (argv === ${JSON.stringify(INIT)} && ${offersNoAgentHooks}) { gitHook(); if (${writesIntoTreeAnyway}) agentHook(); answer('', 0); }
else if (argv === 'doctor --json') answer(${JSON.stringify(`${DEGRADED_REPORT}\n`)}, 0);
else refuse();
`,
    { mode: 0o700 },
  );
  return { bin, log };
};

const argvs = (log: string): string[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
const portAt = (bin: string) => createCommitLoreCliPort(commitloreRunner(COMMITLORE_LIMITS, bin));
// The guard's own question, untrimmed: a leading status column is significant.
const status = (checkout: string): string =>
  execFileSync("git", ["-C", checkout, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8", timeout: 20_000 });
const hooks = (checkout: string): string[] => readdirSync(join(checkout, ".git", "hooks")).sort();

describe("R2: the observation's init carries --no-agent-hooks, and a CommitLore without it is refused before init", () => {
  it("the argv: init with --mcp-scope none, --no-unattended and --no-agent-hooks, then doctor --json", () => {
    expect(COMMITLORE_OBSERVATION_ARGV.map((argv) => argv.join(" "))).toEqual([
      "init --mcp-scope none --no-unattended --no-agent-hooks",
      "doctor --json",
    ]);
  });

  it("an init usage without the option (1.7.4's) is refused NO_INIT_OPTION at the pin's checks: no init runs, in any form, and the checkout is untouched", async () => {
    const cli = fake("without-option", { offersNoAgentHooks: false });
    const checkout = makeRepo();
    const hooksBefore = hooks(checkout);

    // The refusal, uncut, as the pin's checks give it.
    await expect(commitloreRunner(COMMITLORE_LIMITS, cli.bin).ready(checkout)).rejects.toThrow(
      `ACP_COMMITLORE_BINARY NO_INIT_OPTION: ${cli.bin} init does not offer --no-agent-hooks, which the observation needs so that it writes nothing into the checkout`,
    );
    expect(argvs(cli.log)).toEqual(CHECKS);
    writeFileSync(cli.log, "");

    // The required observation in the checkout refuses as not observed, with that condition.
    const observed = await requiredCommitLoreObservation(portAt(cli.bin), checkout, { at: "checkout" });
    expect(observed).toMatchObject({
      allowed: false,
      evidence: {
        refusal: "COMMITLORE_REQUIRED_NOT_OBSERVED",
        at: "checkout",
        observation: { outcome: "FAIL", detail: expect.stringContaining("ACP_COMMITLORE_BINARY NO_INIT_OPTION: ") },
      },
    });
    // Only the checks ran: neither init with the option nor the argv without it, whose 1.7.4 answer would pass.
    expect(argvs(cli.log)).toEqual(CHECKS);
    expect(existsSync(join(checkout, ".claude"))).toBe(false);
    expect(existsSync(join(checkout, ".git", "hooks", "commit-msg"))).toBe(false);
    expect(hooks(checkout)).toEqual(hooksBefore);
    expect(status(checkout)).toBe("");

    // The probe refuses the same way.
    writeFileSync(cli.log, "");
    expect(await probeCommitLore(portAt(cli.bin))).toMatchObject({
      allowed: false,
      evidence: { refusal: "COMMITLORE_REQUIRED_NOT_OBSERVED", at: "probe", observation: { detail: expect.stringContaining("NO_INIT_OPTION") } },
    });
    expect(argvs(cli.log)).toEqual(CHECKS);
  });

  it("an init usage with the option: init runs with --no-agent-hooks after the checks, the doctor is judged as before, and the observation passes with the status empty", async () => {
    const cli = fake("with-option", { offersNoAgentHooks: true });
    const checkout = makeRepo();
    const observed = await requiredCommitLoreObservation(portAt(cli.bin), checkout, { at: "checkout" });
    expect(observed).toMatchObject({
      allowed: true,
      value: {
        outcome: "PASS",
        reportStatus: "degraded",
        warnings: ["notes-refspec: no remote is configured", "inject-runtime: not installed", "inject-version: skipped (no installed hook to compare against)"],
        report: DEGRADED_REPORT + "\n",
      },
    });
    expect(argvs(cli.log)).toEqual([...CHECKS, INIT, "doctor --json"]);
    expect(argvs(cli.log)).not.toContain(OLD_INIT);
    // init wrote under .git only; the working tree is the approved one.
    expect(existsSync(join(checkout, ".git", "hooks", "commit-msg"))).toBe(true);
    expect(existsSync(join(checkout, ".claude"))).toBe(false);
    expect(status(checkout)).toBe("");

    writeFileSync(cli.log, "");
    expect(await probeCommitLore(portAt(cli.bin))).toMatchObject({ allowed: true, value: { outcome: "PASS" } });
    expect(argvs(cli.log)).toEqual([...CHECKS, INIT, "doctor --json"]);
  });
});

describe("R2: the changed-checkout guard is unchanged", () => {
  it("an observer that writes into the working tree though it was passed --no-agent-hooks is refused COMMITLORE_CHANGED_CHECKOUT, and its file is left there", async () => {
    const cli = fake("writes-anyway", { offersNoAgentHooks: true, writesIntoTreeAnyway: true });
    const checkout = makeRepo();
    const observed = await requiredCommitLoreObservation(portAt(cli.bin), checkout, { at: "checkout" });
    expect(observed).toMatchObject({
      allowed: false,
      evidence: { refusal: "COMMITLORE_CHANGED_CHECKOUT", at: "checkout", status: "?? .claude/settings.json" },
    });
    expect(argvs(cli.log)).toEqual([...CHECKS, INIT, "doctor --json"]);
    // Refused, not cleaned up: nothing is removed, ignored or allowlisted.
    expect(readFileSync(join(checkout, ".claude", "settings.json"), "utf8")).toBe('{"hooks":{}}\n');
    expect(status(checkout)).toBe("?? .claude/settings.json\n");

    expect(await probeCommitLore(portAt(cli.bin))).toMatchObject({ allowed: false, evidence: { refusal: "COMMITLORE_CHANGED_CHECKOUT", at: "probe" } });
  });

  it("a user's change made before the observation is refused COMMITLORE_CHANGED_CHECKOUT, though the observer wrote nothing there, and is left as it was", async () => {
    const cli = fake("user-change", { offersNoAgentHooks: true });
    const checkout = makeRepo({ "README.md": "# fixture\n" });
    writeFiles(checkout, { "README.md": "# edited before the observation\n", "notes/draft.txt": "a user's file\n" });
    const before = status(checkout);
    expect(before).toBe(" M README.md\n?? notes/draft.txt\n");
    const observed = await requiredCommitLoreObservation(portAt(cli.bin), checkout, { at: "checkout" });
    expect(observed).toMatchObject({ allowed: false, evidence: { refusal: "COMMITLORE_CHANGED_CHECKOUT", at: "checkout" } });
    expect(argvs(cli.log)).toEqual([...CHECKS, INIT, "doctor --json"]);
    expect(status(checkout)).toBe(before);
    expect(readFileSync(join(checkout, "README.md"), "utf8")).toBe("# edited before the observation\n");
    expect(readFileSync(join(checkout, "notes", "draft.txt"), "utf8")).toBe("a user's file\n");
  });
});
