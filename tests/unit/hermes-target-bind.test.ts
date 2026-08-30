import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { digestOf } from "../../src/core/digest.ts";
import { runHermesTargetBind } from "../../src/runtime/hermes-target-bind.ts";

const roots: string[] = [];
const inheritedCredentialEnv = "ACP_TARGET_BIND_TEST_CREDENTIAL";
const inheritedCredentialValue = "fixture-only-credential";
const request = {
  domain: "hermes.target-bind",
  version: 1,
  session_id: "session:fixture",
  expected_lineage_root_digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  actor_id: "actor:fixture",
  binding_generation: 7,
  executor_runtime_identity: "runtime:fixture",
} as const;

type FixtureMode = "success" | "wrong-root" | "wrong-receipt" | "refusal" | "timeout" | "oversize";

const rootsToClean = roots;
afterEach(() => {
  for (const root of rootsToClean.splice(0)) rmSync(root, { recursive: true, force: true });
});

const makeResponse = (overrides: Record<string, unknown> = {}) => {
  const publicFields = {
    domain: "hermes.target-bind",
    version: 1,
    actor_id: request.actor_id,
    binding_generation: request.binding_generation,
    executor_runtime_identity: request.executor_runtime_identity,
    requested_session_id: request.session_id,
    lineage_root_digest: request.expected_lineage_root_digest,
    ...overrides,
  };
  return { ...publicFields, receipt_digest: digestOf(publicFields) };
};

const makeFixture = (mode: FixtureMode) => {
  const root = mkdtempSync(join(tmpdir(), "acp-hermes-target-bind-"));
  roots.push(root);
  const executable = join(root, "hermes-target-bind-fixture");
  const response =
    mode === "wrong-root"
      ? makeResponse({ lineage_root_digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222" })
      : makeResponse();
  if (mode === "wrong-receipt") response.receipt_digest = "sha256:3333333333333333333333333333333333333333333333333333333333333333";
  const script = `#!${process.execPath}
const expectedRequest = ${JSON.stringify(request)};
const response = ${JSON.stringify(response)};
const mode = ${JSON.stringify(mode)};
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
if (!same(process.argv.slice(2), ["target", "bind", "--json"])) process.exit(2);
if (process.env[${JSON.stringify(inheritedCredentialEnv)}] !== undefined) process.exit(3);
if (process.env.HOME !== ${JSON.stringify(root)} || process.env.HERMES_HOME !== ${JSON.stringify(root)} || process.env.HERMES_PROFILE !== "owner-profile") process.exit(4);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  let actual;
  try { actual = JSON.parse(input); } catch { process.exit(5); }
  if (!same(Object.keys(actual).sort(), ["actor_id", "binding_generation", "domain", "executor_runtime_identity", "expected_lineage_root_digest", "session_id", "version"])) process.exit(6);
  if (!same(actual, expectedRequest)) process.exit(7);
  if (mode === "timeout") return setTimeout(() => process.stdout.write(JSON.stringify(response)), 200);
  if (mode === "oversize") return process.stdout.write("x".repeat(70_000));
  if (mode === "refusal") { process.stdout.write('{"error":"target_bind_preflight_invalid"}'); process.exitCode = 1; return; }
  process.stdout.write(JSON.stringify(response));
});
`;
  writeFileSync(executable, script, { mode: 0o700 });
  chmodSync(executable, 0o700);
  return { executable, root, response };
};

const invoke = (mode: FixtureMode) => {
  const originalInheritedCredential = process.env[inheritedCredentialEnv];
  process.env[inheritedCredentialEnv] = inheritedCredentialValue;
  try {
    const { executable, root, response } = makeFixture(mode);
    return { response, decision: runHermesTargetBind({
      hermesExecutable: executable,
      hermesProfile: "owner-profile",
      hermesHome: root,
      sessionId: request.session_id,
      expectedLineageRootDigest: request.expected_lineage_root_digest,
      actorId: request.actor_id,
      bindingGeneration: request.binding_generation,
      executorRuntimeIdentity: request.executor_runtime_identity,
      timeoutMs: mode === "timeout" ? 50 : 1_000,
      maxOutputBytes: 65_536,
    }) };
  } finally {
    if (originalInheritedCredential === undefined) delete process.env[inheritedCredentialEnv];
    else process.env[inheritedCredentialEnv] = originalInheritedCredential;
  }
};

describe("Hermes target-bind preflight", () => {
  it("accepts only the exact owner-bound response and receipt", () => {
    const { decision, response } = invoke("success");
    expect(decision).toEqual({ allowed: true, value: response });
  });

  it("fails closed when the root or receipt is tampered", () => {
    expect(invoke("wrong-root").decision).toEqual({ allowed: false, category: "PROTOCOL_INVALID" });
    expect(invoke("wrong-receipt").decision).toEqual({ allowed: false, category: "PROTOCOL_INVALID" });
  });

  it("preserves a stable producer preflight refusal", () => {
    expect(invoke("refusal").decision).toEqual({ allowed: false, category: "PREFLIGHT_INVALID" });
  });

  it("fails closed when the producer exceeds the synchronous timeout", () => {
    expect(invoke("timeout").decision).toEqual({ allowed: false, category: "PROTOCOL_UNAVAILABLE" });
  });

  it("fails closed when producer output exceeds the ACP cap", () => {
    expect(invoke("oversize").decision).toEqual({ allowed: false, category: "PROTOCOL_UNAVAILABLE" });
  });
});
