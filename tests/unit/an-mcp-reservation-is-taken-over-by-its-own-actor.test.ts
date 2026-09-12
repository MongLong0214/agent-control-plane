import { afterAll, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { idempotentMcpMutation, ok, type AuthenticatedMcpPeer } from "../../src/mcp/shared.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * An MCP idempotency key reserves a `(mcp, nonce)` slot before the mutation runs, so a retry of a
 * call that never returned does not run it twice. A reservation whose caller vanished would hold
 * that slot forever, so it expires — and the takeover is guarded by three operands, none of which
 * had a witness before #833.
 *
 * The three failures they prevent are different in kind:
 *
 *   another actor       one peer completing another peer's reserved mutation
 *   a finished result   re-running a mutation that already returned
 *   a live reservation  running concurrently with the call still in flight
 *
 * Each case below is a reservation only one of the three refuses.
 */
const RESERVATION_TTL_MS = 60_000;

const peer = (actor: string): AuthenticatedMcpPeer =>
  ({ actor, sessionId: `ses:${actor}`, incarnation: "inc" }) as unknown as AuthenticatedMcpPeer;

/** A source whose clock is fixed, so expiry is stated by the fixture rather than waited for. */
const sourceAt = (h: ReturnType<typeof makeHarness>, iso: string) => ({
  db: h.cp.db,
  clock: { nowIso: () => iso, now: () => Date.parse(iso) } as never,
});

const reserve = (h: ReturnType<typeof makeHarness>, opts: {
  actor: string;
  nonce: string;
  receivedAt: string;
  result?: string | null;
}): void => {
  h.cp.db.run(
    `INSERT INTO inbound_messages (channel, nonce, actor, received_at, result_json)
     VALUES ('mcp', ?, ?, ?, ?)`,
    [opts.nonce, opts.actor, opts.receivedAt, opts.result ?? null],
  );
};

const T0 = "2026-09-12T00:00:00.000Z";
const EXPIRED_AT = new Date(Date.parse(T0) + RESERVATION_TTL_MS).toISOString();
const STILL_LIVE_AT = new Date(Date.parse(T0) + RESERVATION_TTL_MS - 1).toISOString();

describe("an expired MCP reservation is taken over by its own actor and nobody else", () => {
  it("lets the same actor retry once its reservation has expired", () => {
    // The control. Without it every refusal below passes against a guard that refuses every
    // takeover, which would make a vanished caller's key permanently unusable.
    const h = makeHarness();
    reserve(h, { actor: "actor:a", nonce: "k1", receivedAt: T0 });

    let ran = 0;
    const out = idempotentMcpMutation(sourceAt(h, EXPIRED_AT), peer("actor:a"), "k1", () => {
      ran += 1;
      return ok({ done: true });
    });

    return out.then((result) => {
      expect(ran).toBe(1);
      expect(result.isError ?? false).toBe(false);
    });
  });

  it("refuses a different actor holding the same key, expired or not", async () => {
    // The witness for `existing.actor === peer.actor`. Everything else is satisfied — the
    // reservation is expired and carries no result — so only that operand refuses this.
    const h = makeHarness();
    reserve(h, { actor: "actor:a", nonce: "k2", receivedAt: T0 });

    let ran = 0;
    const result = await idempotentMcpMutation(
      sourceAt(h, EXPIRED_AT),
      peer("actor:b"),
      "k2",
      () => {
        ran += 1;
        return ok({ done: true });
      },
    );

    expect(ran).toBe(0);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(ReasonCode.MCP_PEER_UNAUTHENTICATED);
  });

  it("returns the stored result instead of re-running a reservation that already finished", async () => {
    // The witness for `!existing.result_json`. Same actor, long expired — only the stored result
    // stops the takeover, and what the caller gets back is that result rather than a refusal.
    const h = makeHarness();
    reserve(h, {
      actor: "actor:a",
      nonce: "k3",
      receivedAt: T0,
      result: JSON.stringify(ok({ from: "the first call" })),
    });

    let ran = 0;
    const result = await idempotentMcpMutation(
      sourceAt(h, EXPIRED_AT),
      peer("actor:a"),
      "k3",
      () => {
        ran += 1;
        return ok({ from: "a second run" });
      },
    );

    expect(ran).toBe(0);
    expect(JSON.stringify(result)).toContain("the first call");
    expect(JSON.stringify(result)).not.toContain("a second run");
  });

  it("refuses a retry one millisecond before the reservation expires", async () => {
    // The witness for `reservationExpired(...)` and for the `>=` inside it. Same actor, no stored
    // result — the reservation is simply still live, and running now would run concurrently with
    // a call that may still be in flight.
    const h = makeHarness();
    reserve(h, { actor: "actor:a", nonce: "k4", receivedAt: T0 });

    let ran = 0;
    const result = await idempotentMcpMutation(
      sourceAt(h, STILL_LIVE_AT),
      peer("actor:a"),
      "k4",
      () => {
        ran += 1;
        return ok({ done: true });
      },
    );

    expect(ran).toBe(0);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(ReasonCode.INGRESS_REPLAY_IGNORED);
  });
});
