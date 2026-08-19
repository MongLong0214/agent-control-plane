import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";

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
    port.attach(server);

    const answered = await port.ask("어떻게 돼가?");

    expect(answered.allowed).toBe(true);
    expect(answered.allowed && answered.value).toBe("돌고 있어");
    // The message reached the peer as written; a reply that never asked would also be a string.
    expect(peer.calls).toEqual(["어떻게 돼가?"]);
  });

  it("refuses a peer that never declared sampling instead of hanging on a request it cannot serve", async () => {
    const port = new CeoConversationPort();
    const peer: FakePeer = { capabilities: {}, answer: null, calls: [] };
    port.attach(fakePeer(peer));

    const answered = await port.ask("어떻게 돼가?");

    expect(answered.reasonCode).toBe(ReasonCode.CEO_CONVERSATION_UNSUPPORTED);
    // And it did not spend the request finding out.
    expect(peer.calls).toEqual([]);
  });

  it("treats a peer that never answers as a timeout without repeating its error text", async () => {
    const port = new CeoConversationPort({ budgetMs: 5 });
    const peer: FakePeer = {
      capabilities: { sampling: {} },
      answer: async () => {
        throw new Error("secret-bearing internal detail");
      },
      calls: [],
    };
    port.attach(fakePeer(peer));

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
    port.attach(fakePeer(peer));

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
    const detachFirst = port.attach(first.server);
    port.attach(second.server);

    detachFirst();
    const answered = await port.ask("누구야?");

    expect(port.connected()).toBe(true);
    expect(answered.allowed && answered.value).toBe("current");
  });

  it("stops answering once the live connection detaches", async () => {
    const port = new CeoConversationPort();
    const { server } = textPeer("here");
    const detach = port.attach(server);

    detach();
    const answered = await port.ask("아직 있어?");

    expect(port.connected()).toBe(false);
    expect(answered.reasonCode).toBe(ReasonCode.CEO_CONVERSATION_UNAVAILABLE);
  });
});
