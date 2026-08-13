import { afterAll, describe, expect, it } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { ManualClock } from "../../src/core/clock.ts";
import { CodexCliAdapter, __testing, reviewerEnvironment } from "../../src/runtime/cli-adapters.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

const seatbeltCanApply = (): boolean =>
  process.platform === "darwin" &&
  existsSync("/usr/bin/sandbox-exec") &&
  spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)\n(allow default)", "/usr/bin/true"]).status === 0;

describe("CP-HI-04 reviewer isolation probes", () => {
  it("P0-07 fixes the Codex reviewer to GPT-5.6 Sol xhigh and uses only its provider thread id", () => {
    const packetRoot = tempDir("acp-codex-reviewer-contract-");
    const adapter = new CodexCliAdapter({
      clock: new ManualClock("2026-08-13T00:00:00.000Z"),
      capacityFile: join(packetRoot, "gpt.json"),
      binary: "codex-not-invoked-by-contract-test",
    });
    expect(adapter.supportsReviewerIsolation).toBe(true);
    expect(adapter.requiresReviewerProviderSessionProof).toBe(true);
    expect(adapter.supportsReviewerEffortAttestation).toBe(true);

    const bootstrap = __testing.codexReviewerArgs("bootstrap", "gpt-5.6-sol", "xhigh");
    expect(bootstrap).toEqual([
      "exec",
      "--json",
      "--strict-config",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "-m",
      "gpt-5.6-sol",
      "-c",
      'sandbox_mode="read-only"',
      "-c",
      'model_reasoning_effort="xhigh"',
      "-s",
      "read-only",
      "-",
    ]);
    expect(__testing.reviewerToolContractPresent(bootstrap)).toBe(true);

    const resume = __testing.codexReviewerArgs(
      "resume",
      "gpt-5.6-sol",
      "xhigh",
      "provider-thread-7b1c",
    );
    expect(resume).toContain("provider-thread-7b1c");
    expect(resume).not.toContain("--ephemeral");
    expect(__testing.reviewerToolContractPresent(resume)).toBe(true);
    expect(__testing.reviewerToolContractPresent(
      resume.filter((value) => value !== 'sandbox_mode="read-only"'),
    )).toBe(false);

    const output = [
      '{"type":"thread.started","thread_id":"provider-thread-7b1c"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"verdict\\":\\"PASS\\"}"}}',
    ].join("\n");
    expect(__testing.codexThreadId(output)).toBe("provider-thread-7b1c");
    expect(__testing.codexLastAgentMessage(output)).toBe('{"verdict":"PASS"}');
    expect(__testing.codexThreadId('{"type":"thread.started","session_id":"local-uuid"}')).toBeNull();
    // Removing the strict model/effort args, the read-only control, or the provider-issued
    // thread event makes this regression fail instead of silently accepting a local id.
  });

  it("#360 actively proves the profile denies producer transcript reads", async () => {
    const packetRoot = tempDir("acp-review-probe-packet-");
    const transcript = join(tempDir("acp-review-probe-transcript-"), "cto-history.jsonl");
    const credentialScope = tempDir("acp-review-probe-provider-");
    writeFileSync(transcript, "private producer reasoning");
    const profile = __testing.reviewerProfile(
      packetRoot,
      [transcript],
      "/usr/bin/true",
      [credentialScope],
    );
    const result = await __testing.probeDeniedTranscriptPaths(
      profile,
      packetRoot,
      reviewerEnvironment(packetRoot, credentialScope),
      packetRoot,
      [transcript],
      5_000,
    );

    if (!seatbeltCanApply()) {
      expect(result.enforced).toBe(false);
      return;
    }
    expect(result).toEqual({ enforced: true });
    // Removing either the profile's file-read deny or the live probe turns this into a
    // false result instead of a static list assertion.
  });

  it("#360 actively proves a reviewer cannot execute a shell or write outside its packet", async () => {
    const packetRoot = tempDir("acp-review-probe-packet-");
    const credentialScope = tempDir("acp-review-probe-provider-");
    const profile = __testing.reviewerProfile(
      packetRoot,
      [],
      "/usr/bin/true",
      [credentialScope],
    );
    const result = await __testing.probeNoTools(
      profile,
      packetRoot,
      reviewerEnvironment(packetRoot, credentialScope),
      packetRoot,
      5_000,
    );

    if (!seatbeltCanApply()) {
      expect(result.enforced).toBe(false);
      return;
    }
    expect(result).toEqual({ enforced: true });
    // If `(deny process-exec*)`, `(deny file-write*)`, or either active probe disappears,
    // one of the attempted shell/write effects succeeds and this assertion fails.
  });

});
