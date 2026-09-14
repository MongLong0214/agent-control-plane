import { afterEach, afterAll, describe, expect, it } from "vitest";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { provisionReviewerCodexHome } from "../../src/runtime/reviewer-codex-home.ts";

import { ManualClock } from "../../src/core/clock.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { CodexCliAdapter, __testing } from "../../src/runtime/cli-adapters.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { testReviewerEgressEvidence } from "../helpers/production-adapter.ts";

afterEach(() => __testing.setRunCli(null));
afterAll(cleanupTempDirs);
const homes: string[] = [];
const freshHome = () => { const root = provisionReviewerCodexHome(); homes.push(root); return root; };
// This file only stubs runCli: no child can still own these test-only homes.
afterAll(() => { for (const root of homes) rmSync(dirname(root), { recursive: true, force: true }); });

describe("Codex provider-issued reviewer sessions", () => {
  it("rejects the legacy shared credential selector before provider spawn", async () => {
    const packetRoot = tempDir("acp-codex-private-home-red-");
    let calls = 0;
    __testing.setRunCli(async () => {
      calls++;
      return { stdout: '{"type":"thread.started","thread_id":"wrong-target"}', stderr: "",
        exitCode: 0, timedOut: false, isolationEnforced: true,
        egressEvidence: testReviewerEgressEvidence("gpt") };
    });
    const adapter = new CodexCliAdapter({
      clock: new ManualClock("2026-08-13T00:00:00.000Z"),
      capacityFile: join(packetRoot, "gpt.json"),
      providerCredentialDir: tempDir("acp-codex-shared-home-"),
    });
    await expect(adapter.startSession({ model: "gpt-5.6-sol", workdir: packetRoot,
      purpose: "blind-review", isolation: { packetRoot, denyReadPaths: [],
        emptyEnvironment: true, network: "provider-only", tools: "none" } })).rejects.toThrow("private");
    expect(calls).toBe(0);
  });
  it("rejects a relabelled shared root in the explicit private selector before spawn", async () => {
    const packetRoot = tempDir("acp-codex-wrong-target-");
    let calls = 0;
    __testing.setRunCli(async () => {
      calls++;
      return { stdout: '{"type":"thread.started","thread_id":"wrong-target"}', stderr: "",
        exitCode: 0, timedOut: false, isolationEnforced: true,
        egressEvidence: testReviewerEgressEvidence("gpt") };
    });
    const adapter = new CodexCliAdapter({ clock: new ManualClock("2026-08-13T00:00:00.000Z"),
      capacityFile: join(packetRoot, "gpt.json"), reviewerCodexHome: packetRoot });
    await expect(adapter.startSession({ model: "gpt-5.6-sol", workdir: packetRoot,
      purpose: "blind-review", isolation: { packetRoot, denyReadPaths: [],
        emptyEnvironment: true, network: "provider-only", tools: "none" } })).rejects.toThrow("private");
    expect(calls).toBe(0);
  });
  it("serializes resume while retaining the home through stop during an active run", async () => {
    const root = freshHome();
    const packetRoot = tempDir("acp-codex-concurrent-private-");
    const isolation = { packetRoot, denyReadPaths: [], emptyEnvironment: true as const,
      network: "provider-only" as const, tools: "none" as const };
    const spec = { model: "gpt-5.6-sol", workdir: packetRoot, purpose: "blind-review", isolation };
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    __testing.setRunCli(async () => {
      calls++;
      if (calls > 1) await held;
      return { stdout: '{"type":"thread.started","thread_id":"held-private-thread"}', stderr: "",
        exitCode: 0, timedOut: false, isolationEnforced: true,
        egressEvidence: testReviewerEgressEvidence("gpt") };
    });
    const adapter = new CodexCliAdapter({ clock: new ManualClock("2026-08-13T00:00:00.000Z"),
      capacityFile: join(packetRoot, "gpt.json"), reviewerCodexHome: root });
    const handle = await adapter.startSession(spec);
    const request = { ...spec, prompt: "READY", timeoutMs: 1000, readOnly: true,
      correlationId: "held-private", externalSessionId: handle.externalSessionId };
    const first = adapter.invoke(request);
    const second = adapter.invoke(request);
    await adapter.stopSession(handle);
    expect(existsSync(root)).toBe(true);
    release();
    const results = await Promise.all([first, second]);
    expect(results[0]?.ok).toBe(true);
    expect(results[1]?.ok).toBe(false);
    expect(calls).toBe(2);
    expect(existsSync(root)).toBe(true);
  });
  it("refuses a non-provider id and resumes only the constituted thread.started id", async () => {
    const packetRoot = tempDir("acp-codex-provider-session-packet-");
    const credentialDir = freshHome();
    const transcript = join(tempDir("acp-codex-provider-session-transcript-"), "producer.jsonl");
    writeFileSync(transcript, "producer transcript");
    const binary = join(packetRoot, "codex-stub");

    const isolation = {
      packetRoot,
      denyReadPaths: [transcript],
      emptyEnvironment: true as const,
      network: "provider-only" as const,
      tools: "none" as const,
    };
    const spec = {
      model: "gpt-5.6-sol",
      effort: "xhigh",
      workdir: packetRoot,
      purpose: "blind-review",
      isolation,
    };
    const replies = [
      '{"type":"thread.started","session_id":"local-only-id"}\n',
      '{"type":"thread.started","thread_id":"provider-thread-constituted"}\n',
      [
        '{"type":"thread.started","thread_id":"provider-thread-constituted"}',
        '{"item":{"type":"agent_message","text":"{\\"verdict\\":\\"PASS\\"}"}}',
      ].join("\n"),
    ];
    const providerCalls: string[][] = [];
    const observedHomes: (string | undefined)[] = [];
    const writableHomes: (string | undefined)[] = [];
    __testing.setRunCli(async (_file, args, options) => {
      observedHomes.push(options.reviewerEnvironment?.CODEX_HOME);
      writableHomes.push((options as { reviewerPrivateHome?: { root: string } }).reviewerPrivateHome?.root);
      providerCalls.push([...args]);
      return {
        stdout: replies.shift() ?? "",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        // Isolation is covered by the live probe regressions; this stub supplies only the
        // already-admitted runCli result needed to exercise provider-session identity.
        isolationEnforced: true,
        egressEvidence: testReviewerEgressEvidence("gpt"),
      };
    });

    const makeAdapter = (root: string) => new CodexCliAdapter({
      clock: new ManualClock("2026-08-13T00:00:00.000Z"),
      capacityFile: join(packetRoot, "gpt.json"), binary, reviewerCodexHome: root,
    });
    const rejectedAdapter = makeAdapter(freshHome());
    const adapter = makeAdapter(credentialDir);

    const rejectedSession = rejectedAdapter.startSession(spec);
    await expect(rejectedSession).rejects.toMatchObject({ reasonCode: ReasonCode.ISOLATION_LOST });
    await expect(rejectedSession).rejects.toThrow("provider thread id");
    expect(providerCalls).toHaveLength(1);

    const handle = await adapter.startSession(spec);
    expect(handle).toMatchObject({
      externalSessionId: "provider-thread-constituted",
      provider: "gpt",
      providerSessionProven: true,
    });

    const result = await adapter.invoke({
      prompt: "Return the packet verdict.",
      workdir: packetRoot,
      timeoutMs: 5_000,
      model: spec.model,
      effort: spec.effort,
      readOnly: true,
      correlationId: "provider-session-proof",
      externalSessionId: handle.externalSessionId,
      isolation,
    });

    expect(result).toMatchObject({
      ok: true,
      providerSessionId: "provider-thread-constituted",
      isolationAttested: true,
      effortAttested: true,
    });
    expect(providerCalls).toHaveLength(3);
    expect(observedHomes.slice(1)).toEqual([credentialDir, credentialDir]);
    expect(writableHomes.slice(1)).toEqual([credentialDir, credentialDir]);
    expect(providerCalls.every((args) => !args.includes("--ephemeral"))).toBe(true);
    await adapter.stopSession(handle);
    expect(existsSync(credentialDir)).toBe(true);
    await expect(adapter.startSession(spec)).rejects.toThrow("claimed");
    expect(providerCalls[0]).toEqual(expect.arrayContaining(["exec", "--json", "-s", "read-only"]));
    expect(providerCalls[1]).toEqual(expect.arrayContaining(["exec", "--json", "-s", "read-only"]));
    expect(providerCalls[1]).not.toContain("local-only-id");
    expect(providerCalls[2]).toEqual(expect.arrayContaining([
      "exec",
      "resume",
      "provider-thread-constituted",
    ]));
    expect(providerCalls[2]).not.toContain("local-only-id");
    // Removing the provider-session check makes the first start resolve instead of
    // refusing the bootstrap that only reported a local/session_id field.
  });
});
