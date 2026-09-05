/**
 * C0 feasibility: the native Claude Code session inbox carries one opaque wake into
 * a running session's real model input.
 *
 * The pairing is the point. GREEN and RED run the identical harness and differ in one
 * input -- whether a `type: "user"` frame is written to the session's unix socket --
 * so the wake's appearance at the provider is attributable to the injection alone.
 *
 * The measurement is taken at the provider, not at the socket. A wake that reaches the
 * socket has proved the socket accepts bytes; only a wake that appears in the request
 * body the CLI sent to be inferred on has proved the session was actually asked.
 *
 * Chosen over MCP Channels and over MCP sampling. The installed client's handshake
 * declares `{"roots":{"listChanged":true},"elicitation":{}}` and no `sampling`, so a
 * `sampling/createMessage` delivery cannot reach a real session no matter how it is
 * wired. This path uses only surfaces the runtime documents for itself.
 */
import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ACP_WAKE, isClaudeCliAvailable, runInboxProbe } from "./native-session-inbox/harness.ts";

const cliAvailable = isClaudeCliAvailable();

// This slice measures the behaviour of the installed CLI. Where there is no CLI there
// is nothing to measure, and a pass would be a statement about nothing.
describe.skipIf(!cliAvailable)("C0: native session inbox reaches model input", () => {
  it("GREEN: an injected wake appears at the model-input boundary", async () => {
    const result = await runInboxProbe({ inject: ACP_WAKE });

    const wakeBodies = result.modelInputBodies.filter((body) => body.includes(ACP_WAKE));
    expect(wakeBodies.length).toBeGreaterThan(0);

    // The first turn predates the injection, so a second model request is what shows
    // the wake started a turn rather than riding along on one already in flight.
    expect(result.modelInputBodies.length).toBeGreaterThan(1);
  }, 180_000);

  it("RED: the same run without an injection never carries the wake", async () => {
    const result = await runInboxProbe();

    expect(result.modelInputBodies.length).toBeGreaterThan(0);
    for (const body of result.modelInputBodies) {
      expect(body).not.toContain(ACP_WAKE);
    }
  }, 180_000);

  it("every model request went to a loopback fake under a dummy credential", async () => {
    const result = await runInboxProbe({ inject: ACP_WAKE });

    // Positive, not an absence: the requests below are in this list because the list
    // IS the endpoint the CLI's provider traffic was pointed at.
    //
    // The scope of that is exactly what the row name says. ANTHROPIC_BASE_URL and the
    // proxy variables redirect model/provider traffic; they are not a network
    // namespace, so this is no evidence about a process that ignores the proxy
    // environment or opens a socket of its own. What it does establish is that the
    // inference this session performed was served here, under a credential that
    // belongs to no account.
    expect(result.captured.length).toBeGreaterThan(0);
    expect(result.baseUrl.startsWith("http://127.0.0.1:")).toBe(true);

    // The CLI's own reachability probe (HEAD /api/hello) landed here too -- evidence
    // the base-URL override caught non-inference traffic as well, not just /v1/messages.
    const hosts = new Set(result.captured.map((r) => String(r.headers.host ?? "")));
    for (const host of hosts) {
      expect(host.startsWith("127.0.0.1:")).toBe(true);
    }

    // The credential in play is the harness dummy, so no real-account request was
    // even possible. The CLI reports which source it resolved.
    expect(result.init?.apiKeySource).toBe("ANTHROPIC_API_KEY");
    expect(result.init?.analytics_disabled).toBe(true);
    expect(result.init?.product_feedback_disabled).toBe(true);

    // The strongest available signal: the assistant text the session produced came out
    // of the fake server's own stream. If any part of the turn had been served by a
    // real provider, this model id could not be here.
    expect(result.stdout).toContain('"model":"claude-c0-fake"');
  }, 180_000);

  it("the probe leaves behind neither its temp root nor a live child", async () => {
    const result = await runInboxProbe({ inject: ACP_WAKE });

    // Stat'd here rather than believed from a flag the harness sets about itself. The
    // probe has resolved, so its teardown has already run; if the root is still on
    // disk it was never removed.
    expect(existsSync(result.teardown.root)).toBe(false);

    // A process that is still running has neither of these set, so the disjunction is
    // the reaped/not-reaped question and not a restatement of the kill call.
    const { exitCode, signalCode } = result.teardown;
    expect(exitCode !== null || signalCode !== null).toBe(true);
  }, 180_000);
});

describe.skipIf(cliAvailable)("C0: native session inbox (not measurable here)", () => {
  it("reports that the installed CLI is absent rather than passing vacuously", () => {
    expect(isClaudeCliAvailable()).toBe(false);
  });
});
