import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { ManualClock } from "../../src/core/clock.ts";
import { CodexCliAdapter, __testing } from "../../src/runtime/cli-adapters.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { testReviewerEgressEvidence } from "../helpers/production-adapter.ts";

afterEach(() => __testing.setRunCli(null));
afterAll(cleanupTempDirs);

/**
 * An aborted packet review stops its Codex child: the real CodexCliAdapter hands the signal to runCli,
 * whose end path ends the child's process group, so the invocation settles at once instead of at its
 * own timeout. runCli is stubbed at the spawn boundary; its child runs until that end path stops it.
 */

const THREAD = "01a1448e-0001-7000-8000-000000000000";
const line = (value: unknown): string => JSON.stringify(value);
const codexStdout = (thread: string, answer: string): string => [
  line({ type: "thread.started", thread_id: thread }),
  line({ type: "turn.started" }),
  line({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: answer } }),
  line({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
].join("\n");

/** runCli whose `step` (the handshake or the resumed review) runs until its signal ends it. */
const stubRunCli = (step: "handshake" | "review") => {
  const seen = { signal: false, ended: false };
  let entered!: () => void;
  const running = new Promise<void>((resolve) => { entered = resolve; });
  __testing.setRunCli(async (_file, args, options) => {
    const answered = { stderr: "", timedOut: false, isolationEnforced: true, egressEvidence: testReviewerEgressEvidence("gpt") };
    if (args.includes("resume") !== (step === "review")) return { ...answered, stdout: codexStdout(THREAD, "READY"), exitCode: 0 };
    seen.signal = options.signal !== undefined;
    entered();
    return new Promise((resolve) => {
      const end = (): void => {
        seen.ended = true;
        resolve({ ...answered, stdout: "", stderr: "ended", exitCode: null });
      };
      if (options.signal?.aborted) end();
      else options.signal?.addEventListener("abort", end, { once: true });
    });
  });
  return { seen, running };
};

const setup = () => {
  const root = tempDir("acp-cancelled-reviewer-");
  const home = join(root, ".codex");
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(home, "auth.json"), '{"synthetic":"placeholder"}', { mode: 0o600 });
  const packetRoot = tempDir("acp-cancelled-packet-");
  const adapter = new CodexCliAdapter({
    clock: new ManualClock("2026-10-31T00:00:00.000Z"),
    capacityFile: join(root, "gpt.json"),
    binary: join(root, "codex-stub"),
    codexHome: home,
  });
  const isolation = { packetRoot, denyReadPaths: [], emptyEnvironment: true as const, network: "provider-only" as const, tools: "none" as const };
  return { adapter, packetRoot, isolation };
};

/** What `pending` did within two seconds of the abort. */
const within = <T>(pending: Promise<T>): Promise<"resolved" | "rejected" | "pending"> =>
  Promise.race([
    pending.then(() => "resolved" as const, () => "rejected" as const),
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 2_000)),
  ]);

describe("an aborted Codex packet review ends its child", () => {
  it("the resumed review: the child is ended and the invocation settles at once", async () => {
    const { adapter, packetRoot, isolation } = setup();
    const { seen, running } = stubRunCli("review");
    const handle = await adapter.startSession({ model: "gpt-6.1-sol", effort: "xhigh", workdir: packetRoot, purpose: "blind-review", isolation });
    const controller = new AbortController();
    const review = adapter.invoke({
      prompt: "Return the packet verdict.", workdir: packetRoot, timeoutMs: 20 * 60_000, model: "gpt-6.1-sol", effort: "xhigh",
      readOnly: true, correlationId: "aborted-review", externalSessionId: handle.externalSessionId, isolation, signal: controller.signal,
    });
    await running;
    controller.abort();

    expect(await within(review)).toBe("resolved");
    expect(seen).toEqual({ signal: true, ended: true });
    expect((await review).ok).toBe(false);
  });

  it("the session handshake: the child is ended and constituting the session fails at once", async () => {
    const { adapter, packetRoot, isolation } = setup();
    const { seen, running } = stubRunCli("handshake");
    const controller = new AbortController();
    const handshake = adapter.startSession({
      model: "gpt-6.1-sol", effort: "xhigh", workdir: packetRoot, purpose: "blind-review", isolation, signal: controller.signal,
    });
    await running;
    controller.abort();

    expect(await within(handshake)).toBe("rejected");
    expect(seen).toEqual({ signal: true, ended: true });
  });
});
