import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import {
  CEO_CONVERSATION_BUDGET_MS,
  CEO_REPLY_TIMEOUT_MS,
  assertOuterOutlastsInner,
} from "../../src/contracts/ceo-turn-budget.ts";
import type { McpPeerAuthenticator } from "../../src/mcp/shared.ts";
import { allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";

/** Stands in for the per-request authenticator every inbound tool call already runs. */
const stillCeo = (): McpPeerAuthenticator => () =>
  allow(ReasonCode.OK, { sessionId: "s", sessionIncarnation: "i", sessionSecret: "x" } as never);

const noLongerCeo = (): McpPeerAuthenticator => () =>
  deny(ReasonCode.BINDING_GENERATION_STALE, "the binding moved on", {});

interface FakePeer {
  capabilities: { sampling?: Record<string, unknown> } | undefined;
  answer: (() => Promise<unknown>) | null;
  calls: string[];
}

/**
 * The port only ever touches two members of the SDK server, and both are the ones a real peer
 * drives over the wire. Building the whole `McpServer` would test the SDK rather than this.
 */
const fakePeer = (peer: FakePeer): McpServer =>
  ({
    server: {
      getClientCapabilities: () => peer.capabilities,
      createMessage: async (params: { messages: { content: { text?: string } }[] }) => {
        peer.calls.push(params.messages[0]?.content.text ?? "");
        if (!peer.answer) throw new Error("no scripted answer");
        return peer.answer();
      },
    },
  }) as unknown as McpServer;

const textPeer = (text: string): { peer: FakePeer; server: McpServer } => {
  const peer: FakePeer = {
    capabilities: { sampling: {} },
    answer: async () => ({ model: "fake", role: "assistant", content: { type: "text", text } }),
    calls: [],
  };
  return { peer, server: fakePeer(peer) };
};

describe("CEO conversation port", () => {
  it("refuses when no CEO peer is connected, rather than throwing at the poll loop", async () => {
    const port = new CeoConversationPort();

    const answered = await port.ask("어떻게 돼가?");

    expect(port.connected()).toBe(false);
    expect(answered.allowed).toBe(false);
    expect(answered.reasonCode).toBe(ReasonCode.CEO_CONVERSATION_UNAVAILABLE);
  });

  it("carries the owner's text to the peer and returns what it answered", async () => {
    const port = new CeoConversationPort();
    const { peer, server } = textPeer("돌고 있어");
    port.attach(server, stillCeo());

    const answered = await port.ask("어떻게 돼가?");

    expect(answered.allowed).toBe(true);
    expect(answered.allowed && answered.value).toBe("돌고 있어");
    // The message reached the peer as written; a reply that never asked would also be a string.
    expect(peer.calls).toEqual(["어떻게 돼가?"]);
  });

  it("refuses a peer that never declared sampling instead of hanging on a request it cannot serve", async () => {
    const port = new CeoConversationPort();
    const peer: FakePeer = { capabilities: {}, answer: null, calls: [] };
    port.attach(fakePeer(peer), stillCeo());

    const answered = await port.ask("어떻게 돼가?");

    expect(answered.reasonCode).toBe(ReasonCode.CEO_CONVERSATION_UNSUPPORTED);
    // And it did not spend the request finding out.
    expect(peer.calls).toEqual([]);
  });

  it("treats a peer that never answers as a timeout without repeating its error text", async () => {
    // Both sides are stated, not just the budget. The port checks that its own deadline
    // outlasts the peer's, and a test that shortened only one of them would be asking for the
    // inverted arrangement the check exists to refuse.
    const port = new CeoConversationPort({ budgetMs: 5, peerReplyTimeoutMs: 1 });
    const peer: FakePeer = {
      capabilities: { sampling: {} },
      answer: async () => {
        throw new Error("secret-bearing internal detail");
      },
      calls: [],
    };
    port.attach(fakePeer(peer), stillCeo());

    const answered = await port.ask("어떻게 돼가?");

    expect(answered.reasonCode).toBe(ReasonCode.CEO_CONVERSATION_TIMEOUT);
    expect(answered.allowed).toBe(false);
    expect(JSON.stringify(answered)).not.toContain("secret-bearing internal detail");
  });

  it("refuses non-text content rather than delivering an empty message", async () => {
    const port = new CeoConversationPort();
    const peer: FakePeer = {
      capabilities: { sampling: {} },
      answer: async () => ({
        model: "fake",
        role: "assistant",
        content: { type: "image", data: "…", mimeType: "image/png" },
      }),
      calls: [],
    };
    port.attach(fakePeer(peer), stillCeo());

    const answered = await port.ask("도표 그려줘");

    expect(answered.reasonCode).toBe(ReasonCode.CEO_CONVERSATION_NOT_TEXT);
  });

  it("keeps the newer connection when the replaced one closes late", async () => {
    // A reconnecting CEO can leave its old socket closing after the new one is attached. An
    // unguarded detach would clear the live peer and answer the owner CEO_CONVERSATION_UNAVAILABLE
    // while a CEO is in fact connected.
    const port = new CeoConversationPort();
    const first = textPeer("stale");
    const second = textPeer("current");
    const detachFirst = port.attach(first.server, stillCeo());
    port.attach(second.server, stillCeo());

    detachFirst();
    const answered = await port.ask("누구야?");

    expect(port.connected()).toBe(true);
    expect(answered.allowed && answered.value).toBe("current");
  });

  it("stops answering once the live connection detaches", async () => {
    const port = new CeoConversationPort();
    const { server } = textPeer("here");
    const detach = port.attach(server, stillCeo());

    detach();
    const answered = await port.ask("아직 있어?");

    expect(port.connected()).toBe(false);
    expect(answered.reasonCode).toBe(ReasonCode.CEO_CONVERSATION_UNAVAILABLE);
  });

  it("refuses a socket that outlived the binding it was admitted under", async () => {
    // An inbound tool call re-authenticates on every request. Sampling travels the other way,
    // so without the same check a former CEO whose socket has not finished closing keeps
    // receiving the owner's conversation after the role has moved.
    const port = new CeoConversationPort();
    const { peer, server } = textPeer("I am no longer the CEO");
    port.attach(server, noLongerCeo());

    const answered = await port.ask("어떻게 돼가?");

    expect(answered.reasonCode).toBe(ReasonCode.CEO_CONVERSATION_STALE);
    expect(peer.calls, "a stale runtime must not be spoken to at all").toEqual([]);
  });

  it("drops the stale peer so the next turn does not re-ask it", async () => {
    const port = new CeoConversationPort();
    const { server } = textPeer("stale");
    port.attach(server, noLongerCeo());

    await port.ask("first");

    expect(port.connected()).toBe(false);
  });

  it("lets the successor answer after the superseded socket has been refused", async () => {
    // The full sequence §8.6 names: A is attached, the binding rotates, A stays open, B
    // arrives, and only B is spoken to.
    const port = new CeoConversationPort();
    const stale = textPeer("A");
    const current = textPeer("B");
    const detachStale = port.attach(stale.server, noLongerCeo());
    expect((await port.ask("while only A is here")).reasonCode).toBe(ReasonCode.CEO_CONVERSATION_STALE);

    port.attach(current.server, stillCeo());
    detachStale();
    const answered = await port.ask("who answers now?");

    expect(answered.allowed && answered.value).toBe("B");
    expect(stale.peer.calls).toEqual([]);
    expect(current.peer.calls).toEqual(["who answers now?"]);
  });
});

describe("the deadlines on one owner turn", () => {
  /**
   * An owner turn crosses two process boundaries and had a deadline at each: the daemon waited
   * 60s while the CEO runtime waited 120s for its spawned reply command. Ordered that way the
   * inner deadline can never fire in the ordinary case — the daemon has already abandoned the
   * turn — so a failure is always reported as "the CEO did not answer" and never as "the reply
   * source did not answer", which is the one of the two that says where the fault is.
   *
   * They were two constants in two files with nothing relating them, which is how they came to
   * be ordered backwards without anything failing.
   */
  it("gives the daemon longer than the runtime it is waiting on", () => {
    // The real constants, not the relationship restated. Recomputing `inner + margin` here
    // would agree with any pair of values at all, including an inverted one.
    expect(CEO_CONVERSATION_BUDGET_MS).toBeGreaterThan(CEO_REPLY_TIMEOUT_MS);
  });

  it("requires the runtime to actually wait on the shared constant", () => {
    // The assertion above is, by itself, `margin > 0`. Both values come from this contract, so
    // comparing them says nothing about whether the process that waits on the child still reads
    // it — and the original bug was exactly that the two sides had drifted apart. A blind review
    // caught this: every test here stayed green while `hermes-ceo.ts` hardcoded a larger inner
    // timeout, which is the bug shape returning.
    //
    // So the source is read. The daemon cannot observe the peer's timer at runtime, and the
    // repository is the only place the two can be held together.
    const runtime = readFileSync(join(process.cwd(), "src", "runtime", "hermes-ceo.ts"), "utf8");

    expect(runtime).toContain("const DEFAULT_REPLY_TIMEOUT_MS = CEO_REPLY_TIMEOUT_MS;");
    // And the runtime holds itself to the relationship for a caller-supplied override, which is
    // the one path the daemon's constructor check cannot see at all.
    expect(runtime).toContain("assertOuterOutlastsInner(CEO_CONVERSATION_BUDGET_MS, replyTimeoutMs)");
  });

  it("refuses a budget that does not outlast the peer's reply timeout", () => {
    // The derived defaults are the case that cannot go wrong. An override is where the
    // inversion comes back, and it would surface as an unexplained timeout on every turn.
    expect(() => new CeoConversationPort({ budgetMs: 30_000, peerReplyTimeoutMs: 120_000 })).toThrow(
      /must outlast the reply timeout/,
    );
  });

  it("refuses a tie, because equal deadlines still let the outer one fire first", () => {
    // `>=` would accept this. Two deadlines that expire together race, and the daemon losing
    // that race produces exactly the unattributable timeout the ordering exists to prevent.
    expect(() => assertOuterOutlastsInner(120_000, 120_000)).toThrow(/must outlast/);
  });

  it("names both numbers in the refusal, so the operator can see which way round they are", () => {
    // "budget must outlast reply timeout" alone does not say which of the two the operator set
    // wrongly — and the peer's value is in another process, where they cannot go and read it.
    expect(() => assertOuterOutlastsInner(30_000, 120_000)).toThrow(/30000.*120000/s);
  });
});

describe("one turn at a time on the CEO's canonical session", () => {
  /**
   * The reply command resumes one conversation by id, and the runtime fires it with `void` and
   * keeps no queue (`hermes-ceo.ts:341`). Two overlapping turns therefore both reach
   * `hermes chat --resume <same id>` and interleave in a transcript the CEO carries forward as
   * context — which cannot be unwound, and which the CEO cannot tell happened.
   *
   * The property holds today only because `TelegramLongPoller.pollOnce` awaits each update in
   * turn. That await is what #630 removes, so this is written while the invariant is still true
   * rather than after it stops being.
   */
  const heldPeer = (): { peer: FakePeer; server: McpServer; release: (text: string) => void } => {
    let release!: (text: string) => void;
    const held = new Promise<unknown>((resolve) => {
      release = (text: string) =>
        resolve({ model: "fake", role: "assistant", content: { type: "text", text } });
    });
    const peer: FakePeer = { capabilities: { sampling: {} }, answer: () => held, calls: [] };
    return { peer, server: fakePeer(peer), release };
  };

  it("refuses a second turn while the first is still open", async () => {
    const port = new CeoConversationPort();
    const { peer, server, release } = heldPeer();
    port.attach(server, stillCeo());

    const first = port.ask("첫 번째");
    const second = await port.ask("두 번째");

    expect(second.allowed).toBe(false);
    expect(second.reasonCode).toBe(ReasonCode.CEO_CONVERSATION_BUSY);
    // The assertion that matters: the second turn never reached the session. A refusal that
    // still sent the message would satisfy the reason code and cause the exact interleaving
    // this exists to prevent.
    expect(peer.calls).toEqual(["첫 번째"]);

    release("답");
    const answered = await first;
    expect(answered.allowed && answered.value).toBe("답");
  });

  it("takes the next turn once the first one finishes", async () => {
    // Without this the guard would be indistinguishable from a port that refuses forever after
    // one turn, and the owner would lose their CEO after a single message.
    const port = new CeoConversationPort();
    const { server, release } = heldPeer();
    port.attach(server, stillCeo());

    const first = port.ask("첫 번째");
    release("답");
    await first;
    const second = await port.ask("두 번째");

    expect(second.allowed).toBe(true);
  });

  it("takes the next turn after one that timed out, rather than locking the owner out", async () => {
    // A timed-out turn is over as far as this port is concerned — it has stopped waiting. The
    // runtime may still have work behind it, which is #632's problem and is not solved by
    // refusing every later turn.
    const port = new CeoConversationPort({ budgetMs: 5, peerReplyTimeoutMs: 1 });
    const failing: FakePeer = {
      capabilities: { sampling: {} },
      answer: async () => {
        throw new Error("no answer");
      },
      calls: [],
    };
    port.attach(fakePeer(failing), stillCeo());

    expect((await port.ask("첫 번째")).reasonCode).toBe(ReasonCode.CEO_CONVERSATION_TIMEOUT);
    const second = await port.ask("두 번째");

    expect(second.reasonCode).not.toBe(ReasonCode.CEO_CONVERSATION_BUSY);
  });
});
