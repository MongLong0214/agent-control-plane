import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { executablePlanOf } from "../../src/bootstrap/bootstrap-plan.ts";
import { bytesDigest } from "../../src/bootstrap/genesis-bundle.ts";
import { produceRepoFactoryResult } from "../../src/bootstrap/repo-factory-producer.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import * as sandbox from "../../src/verify/sandbox.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { GenesisGitHub, genesisFile, genesisPlanFixture } from "../helpers/genesis-github.ts";

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempDirs();
});

const approvedArgv = ["npm", "test"];
const executedArgv = ["node", "--test", "--experimental-test-isolation=none"];
const compat = "npm-test-node-test-in-process";
const passing = "const {test}=require('node:test');const assert=require('node:assert/strict');test('smoke',()=>assert.equal(2+2,4));\n";

function fixture(options: { scripts?: Record<string, unknown>; argv?: string[]; source?: string; cwd?: string; packageBytes?: string | null } = {}) {
  const f = genesisPlanFixture();
  const cwd = options.cwd ?? ".";
  const prefix = cwd === "." ? "" : `${cwd}/`;
  const packageBytes = options.packageBytes === undefined
    ? JSON.stringify({ scripts: options.scripts ?? { test: "node --test" } })
    : options.packageBytes;
  const files = [
    ...f.genesis.files,
    ...(packageBytes === null ? [] : [genesisFile(`${prefix}package.json`, packageBytes)]),
    genesisFile(`${prefix}test/smoke.test.js`, options.source ?? passing),
    // Default discovery must include both files; no explicit test-file list is equivalent.
    genesisFile(`${prefix}test/second.test.js`, passing.replace("'smoke'", "'second'")),
    genesisFile("node", "#!/bin/sh\nexit 72\n", "100755"),
    genesisFile(".gitignore", "ignored.test.js\n"),
  ];
  const root = tempDir("genesis-verification-");
  const port = new GenesisGitHub(root);
  const plan = executablePlanOf(f.outputs, f.binding.planDigest);
  plan.genesis = { ...plan.genesis!, files };
  plan.verificationCommands = [{ ...plan.verificationCommands![0]!, argv: options.argv ?? approvedArgv, cwd,
    envAllowlist: ["NODE_ENV"], timeoutSeconds: 20, maxCpuSeconds: 15, maxMemoryMb: 1024, maxOutputBytes: 65536 }];
  const workDir = join(root, "work");
  const checkout = join(workDir, "repositories", "primary");
  const input = { plan, workDir, approvedFiles: files.map(({ sha256: _sha256, ...file }) => ({ ...file, content: "" })), keepCheckoutOnFailure: true,
    github: { port, authority: { owner: "acme", visibility: "public" as const,
      approvedOperations: f.outputs.githubOperations.map(({ operationId, resourceIdentity, resourceType }) => ({ operationId, resourceIdentity, resourceType })) } } };
  // Call through to the real sandbox, including seatbelt and the production NPROC limit.
  const runs = vi.spyOn(sandbox, "runSandboxed");
  return { input, port, checkout, runs };
}

describe.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))("RF genesis npm test compatibility (real sandbox)", () => {
  it.each([".", "app"])("passes default discovery in approved cwd %s and records both invocations at both verification steps", async cwd => {
    const f = fixture({ cwd });
    const passCount = cwd === "." ? 3 : 2; // Root discovery also includes the approved legacy test.js.
    const decision = await produceRepoFactoryResult(f.input);
    expect(decision.allowed, JSON.stringify(decision)).toBe(true);
    expect(decision.evidence.genesisVerification).toEqual([
      expect.objectContaining({ phase: "verifyGenesis", commandId: "test", approvedArgv, executedArgv, compat,
        outcome: expect.objectContaining({ status: "PASS", exitCode: 0, stdout: expect.stringContaining(`# pass ${passCount}`),
          enforcement: expect.objectContaining({ mechanism: "seatbelt", networkEnforced: true, resourceLimitsEnforced: true }) }) }),
      expect.objectContaining({ phase: "GENESIS_TEST", commandId: "test", approvedArgv, executedArgv, compat,
        outcome: expect.objectContaining({ status: "PASS", exitCode: 0, stdout: expect.stringContaining(`# pass ${passCount}`) }) }),
    ]);
    expect(f.runs).toHaveBeenCalledTimes(2);
    for (const [request] of f.runs.mock.calls) {
      expect(request.command).toEqual({ ...f.input.plan.verificationCommands![0]!, argv: executedArgv });
      expect(request.worktreePath).toBe(f.checkout);
    }
    expect(f.input.plan.verificationCommands![0]!.argv).toEqual(approvedArgv);
  });

  it.each(["verifyGenesis", "GENESIS_TEST"])("propagates a real assertion failure in %s", async phase => {
    const source = phase === "verifyGenesis" ? passing.replace("2+2,4", "2+2,5") :
      "const fs=require('node:fs');const {test}=require('node:test');const assert=require('node:assert/strict');const marker='.git/test-ran';test('fails on second verification',()=>{const ran=fs.existsSync(marker);fs.writeFileSync(marker,'yes');assert.equal(ran,false);});\n";
    const f = fixture({ source });
    const decision = await produceRepoFactoryResult(f.input);
    expect(decision).toMatchObject({ allowed: false, reasonCode: ReasonCode.VERIFICATION_GAP,
      evidence: { commandId: "test", status: "FAIL", genesisVerification: expect.arrayContaining([
        expect.objectContaining({ phase, approvedArgv, executedArgv, compat, outcome: expect.objectContaining({ status: "FAIL", exitCode: 1 }) }),
      ]) } });
    expect(f.runs).toHaveBeenCalledTimes(phase === "verifyGenesis" ? 1 : 2);
  });

  it.each([
    { name: "pretest", scripts: { test: "node --test", pretest: "node test.js" } },
    { name: "empty pretest", scripts: { test: "node --test", pretest: "" } },
    { name: "posttest", scripts: { test: "node --test", posttest: "node test.js" } },
    { name: "empty posttest", scripts: { test: "node --test", posttest: "" } },
    { name: "explicit file", scripts: { test: "node --test test/x.test.js" } },
    { name: "other script", scripts: { test: "node test.js" } },
    { name: "trailing whitespace", scripts: { test: "node --test " } },
    { name: "npm run test", argv: ["npm", "run", "test"] },
    { name: "extra argv", argv: ["npm", "test", "--", "test/smoke.test.js"] },
    { name: "missing package", packageBytes: null },
    { name: "invalid JSON", packageBytes: "{" },
  ])("runs unchanged for $name and records no compatibility reason", async options => {
    const f = fixture(options);
    const decision = await produceRepoFactoryResult(f.input);
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.VERIFICATION_GAP);
    const argv = options.argv ?? approvedArgv;
    expect(f.runs).toHaveBeenCalledTimes(1);
    expect(f.runs.mock.calls[0]![0].command).toEqual(f.input.plan.verificationCommands![0]);
    const records = decision.evidence.genesisVerification as Array<Record<string, unknown>>;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ commandId: "test", approvedArgv: argv, executedArgv: argv,
      outcome: expect.objectContaining({ status: expect.stringMatching(/^(FAIL|ERROR)$/) }) });
    expect(records[0]).not.toHaveProperty("compat");
  });
});

describe("RF genesis approved worktree checks", () => {
  it.each(["untracked", "modified", "package", "ignored"])("refuses %s drift before verifyGenesis runs any command", async kind => {
    const f = fixture({ argv: ["node", "test.js"] });
    const open = f.port.openGenesisPull.bind(f.port);
    vi.spyOn(f.port, "openGenesisPull").mockImplementation(async (...args) => {
      await open(...args);
      writeFileSync(join(f.checkout, kind === "modified" ? "test.js" : kind === "package" ? "package.json" : kind === "ignored" ? "ignored.test.js" : "untracked.test.js"), "throw new Error('unapproved');\n");
    });
    const decision = await produceRepoFactoryResult(f.input);
    expect(f.runs).not.toHaveBeenCalled();
    expect(decision).toMatchObject({ allowed: false, reasonCode: ReasonCode.VERIFICATION_GAP });
  });

  it.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")).each(["untracked", "modified", "package", "ignored", "head"])("refuses %s drift before GENESIS_TEST runs", async kind => {
    const f = fixture({ argv: ["node", "test.js"] });
    const decision = await produceRepoFactoryResult({ ...f.input, beforeLedgerWrite: state => {
      // All GitHub effects are complete, after the producer's last checkout/reset.
      if (state.pending.length || state.receipts.length !== f.input.plan.githubOperations.length) return;
      if (kind === "head") writeFileSync(join(f.checkout, ".git", "HEAD"), f.port.pull!.baseSha + "\n");
      else writeFileSync(join(f.checkout, kind === "modified" ? "test.js" : kind === "package" ? "package.json" : kind === "ignored" ? "ignored.test.js" : "untracked.test.js"), "throw new Error('unapproved');\n");
    } });
    expect(f.runs).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({ allowed: false, reasonCode: ReasonCode.VERIFICATION_GAP });
  });

  it.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))("rechecks drift after a command and before running another", async () => {
    const f = fixture({ argv: ["node", "test.js"] });
    const command = f.input.plan.verificationCommands![0]!;
    f.input.plan.verificationCommands!.push({ ...command, id: "second" });
    const file = f.input.approvedFiles.find(file => file.path === "test.js")!;
    file.contentBase64 = Buffer.from("require('node:fs').writeFileSync('untracked.test.js','throw Error(1)');\n").toString("base64");
    f.input.plan.genesis!.files.find(file => file.path === "test.js")!.contentBase64 = file.contentBase64;
    // Keep the approved bundle's digest consistent with the deliberate test input.
    f.input.plan.genesis!.files.find(file => file.path === "test.js")!.sha256 = bytesDigest(Buffer.from(file.contentBase64, "base64"));
    const decision = await produceRepoFactoryResult(f.input);
    expect(f.runs).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({ allowed: false, reasonCode: ReasonCode.VERIFICATION_GAP });
  });
});
