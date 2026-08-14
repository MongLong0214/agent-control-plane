import { afterEach, afterAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { ManualClock } from "../../src/core/clock.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { CodexCliAdapter, __testing } from "../../src/runtime/cli-adapters.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { testReviewerEgressEvidence } from "../helpers/production-adapter.ts";

afterEach(() => __testing.setRunCli(null));
afterAll(cleanupTempDirs);

describe("Codex provider-issued reviewer sessions", () => {
  it("refuses a non-provider id and resumes only the constituted thread.started id", async () => {
    const packetRoot = tempDir("acp-codex-provider-session-packet-");
    const credentialDir = tempDir("acp-codex-provider-session-credentials-");
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
    __testing.setRunCli(async (_file, args) => {
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

    const adapter = new CodexCliAdapter({
      clock: new ManualClock("2026-08-13T00:00:00.000Z"),
      capacityFile: join(packetRoot, "gpt.json"),
      binary,
      providerCredentialDir: credentialDir,
    });

    const rejectedSession = adapter.startSession(spec);
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
