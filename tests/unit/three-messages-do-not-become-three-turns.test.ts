import { describe, expect, it } from "vitest";

import { composeOwnerBatch, renderOwnerBatch, type OwnerMessage } from "../../src/ingress/owner-batch.ts";

/**
 * #631's remaining condition, with the boundary the CEO fixed on 2026-09-20.
 *
 * The ruling is a **transport** batch: one execution consumes many messages and each of them stays
 * a message. *"내용은 합쳐 요약하거나 덮어쓰지 말고 ordered items로 전달한다"* and *"같은 대화의
 * 무관한 새 지시도 같은 batch 안의 별도 item으로 전달하되, 의미적으로 한 지시로 융합하지 않는다"*.
 *
 * That distinction is the whole feature. Summarising three instructions into one would lose the
 * only copy of the owner's words — #631's own body says so: *"The owner's own words are the thing
 * being dropped, so this cannot be reconstructed from anywhere else."*
 */
const message = (over: Partial<OwnerMessage> & { id: string; sequence: number }): OwnerMessage => ({
  projectId: "prj_a",
  conversation: "chat-1",
  text: `text of ${over.id}`,
  ...over,
});

describe("three messages do not become three turns", () => {
  it("keeps arrival order, every id, and every boundary", () => {
    // Deliberately out of order on input: the poll loop does not promise to hand them over sorted,
    // and "preserve the original arrival order" is a claim about `sequence`, not about the array.
    const batch = composeOwnerBatch(
      [message({ id: "c", sequence: 3 }), message({ id: "a", sequence: 1 }), message({ id: "b", sequence: 2 })],
      { projectId: "prj_a", conversation: "chat-1" },
    );

    expect(batch.items.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(batch.consumedIds).toEqual(["a", "b", "c"]);
    expect(batch.items.map((item) => item.text)).toEqual(["text of a", "text of b", "text of c"]);
  });

  it("does not fuse an unrelated instruction — it stays its own item", () => {
    // The CEO's wording: an unrelated new instruction in the same conversation travels in the same
    // batch as a *separate item*. A merge here would be the summarisation the ruling forbids.
    const batch = composeOwnerBatch(
      [
        message({ id: "1", sequence: 1, text: "deploy the thing" }),
        message({ id: "2", sequence: 2, text: "actually, first check the logs" }),
      ],
      { projectId: "prj_a", conversation: "chat-1" },
    );

    expect(batch.items).toHaveLength(2);
    expect(batch.items[0]?.text).toBe("deploy the thing");
    expect(batch.items[1]?.text).toBe("actually, first check the logs");
    // Rendered, both instructions survive as themselves and the count is visible.
    const rendered = renderOwnerBatch(batch);
    expect(rendered).toContain("deploy the thing");
    expect(rendered).toContain("actually, first check the logs");
    expect(rendered).toContain("[1/2 id=1]");
    expect(rendered).toContain("[2/2 id=2]");
  });

  it("never spans a conversation, a project, or both", () => {
    // *"다른 project/conversation/thread/root는 절대 합치지 않는다."* Each of these differs from
    // the scope in exactly one way, so a rule that checked only one of the two fields passes the
    // other case and would merge across it.
    const pending = [
      message({ id: "mine", sequence: 1 }),
      message({ id: "other-conversation", sequence: 2, conversation: "chat-2" }),
      message({ id: "other-project", sequence: 3, projectId: "prj_b" }),
      message({ id: "no-project", sequence: 4, projectId: null }),
    ];

    const batch = composeOwnerBatch(pending, { projectId: "prj_a", conversation: "chat-1" });

    expect(batch.items.map((item) => item.id)).toEqual(["mine"]);
    expect(batch.unconsumedIds).toEqual(["other-conversation", "other-project", "no-project"]);
  });

  it("names what it left behind, and reports an empty remainder rather than staying silent", () => {
    // Without this the next execution cannot tell "took everything" from "took some", which is how
    // coalescing becomes a quiet way to lose the owner's words. Reported even when empty, because
    // "nothing was left" and "nobody looked" must not be the same value.
    const all = composeOwnerBatch(
      [message({ id: "a", sequence: 1 }), message({ id: "b", sequence: 2 })],
      { projectId: "prj_a", conversation: "chat-1" },
    );
    expect(all.unconsumedIds).toEqual([]);

    const some = composeOwnerBatch(
      [message({ id: "a", sequence: 1 }), message({ id: "z", sequence: 2, conversation: "chat-9" })],
      { projectId: "prj_a", conversation: "chat-1" },
    );
    expect(some.consumedIds).toEqual(["a"]);
    expect(some.unconsumedIds).toEqual(["z"]);
  });

  it("a batch of one is still a batch, and renders as one of one", () => {
    // The ordinary case must not take a different path: a single message that rendered without its
    // boundary would make "how many did this execution consume" unanswerable from the payload.
    const batch = composeOwnerBatch([message({ id: "solo", sequence: 7 })], {
      projectId: "prj_a", conversation: "chat-1",
    });
    expect(batch.consumedIds).toEqual(["solo"]);
    expect(renderOwnerBatch(batch)).toContain("[1/1 id=solo]");
  });

  it("a project-less conversation matches only another project-less one", () => {
    // `null` is a value here, not a wildcard. A DM with no project must not absorb a project room's
    // messages, and `null === null` is the comparison that keeps them apart.
    const batch = composeOwnerBatch(
      [message({ id: "dm", sequence: 1, projectId: null }), message({ id: "room", sequence: 2 })],
      { projectId: null, conversation: "chat-1" },
    );
    expect(batch.consumedIds).toEqual(["dm"]);
    expect(batch.unconsumedIds).toEqual(["room"]);
  });
});
