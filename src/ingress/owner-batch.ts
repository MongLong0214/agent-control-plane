/**
 * What "three messages do not become three turns" means, decided rather than guessed.
 *
 * The CEO's ruling on #628/#631 (2026-09-20) is a **transport** batch, not a content merge:
 *
 * > 같은 canonical project/conversation에 속하고, 한 turn 실행 중 도착해 다음 execution claim
 * > 전까지 내구 저장된 owner 메시지를 하나의 transport batch로 묶는다. 원래 도착 순서, 각
 * > message/event ID, 개별 경계를 그대로 보존한다. 내용은 합쳐 요약하거나 덮어쓰지 말고 ordered
 * > items로 전달한다. 같은 대화의 무관한 새 지시도 같은 batch 안의 별도 item으로 전달하되,
 * > 의미적으로 한 지시로 융합하지 않는다. 다른 project/conversation/thread/root는 절대 합치지
 * > 않는다. 응답/receipt에는 소비한 ID 전부와 미소비 ID를 구분해 남긴다.
 *
 * So one execution consumes many messages and each of them stays a message. Summarising would be
 * the failure this exists to prevent: the owner's own words are the thing being carried, and a
 * batch that paraphrased three instructions into one would lose the only copy.
 *
 * This module is the decision and nothing else — no polling, no offsets, no claims. The poll
 * loop's ordering is delicate enough that the rule it will follow is worth pinning where a test
 * can reach it directly.
 */

/** One owner message, exactly as it arrived. `id` is the durable key the ingress already uses. */
export interface OwnerMessage {
  readonly id: string;
  /** Arrival order as observed, not a timestamp: two messages can share a millisecond. */
  readonly sequence: number;
  readonly projectId: string | null;
  readonly conversation: string;
  readonly text: string;
}

/** The scope one execution claim covers. A batch never spans two of these. */
export interface OwnerBatchScope {
  readonly projectId: string | null;
  readonly conversation: string;
}

export interface OwnerBatch {
  readonly scope: OwnerBatchScope;
  /** In arrival order, each item whole. Never fused, never summarised. */
  readonly items: readonly OwnerMessage[];
  readonly consumedIds: readonly string[];
  /** Everything this batch did **not** take, so the next claim knows what is still owed. */
  readonly unconsumedIds: readonly string[];
}

const sameScope = (message: OwnerMessage, scope: OwnerBatchScope): boolean =>
  message.projectId === scope.projectId && message.conversation === scope.conversation;

/**
 * Groups the messages one claim may take, and names everything it leaves behind.
 *
 * `unconsumedIds` is not bookkeeping. Without it a batch that took some of what was pending is
 * indistinguishable from one that took all of it, and the next execution has no way to know what
 * is still owed — which turns coalescing into a quiet way to lose the owner's words. It is
 * reported even when empty, because "nothing was left" and "nobody looked" must not be one value.
 */
export const composeOwnerBatch = (
  pending: readonly OwnerMessage[],
  scope: OwnerBatchScope,
): OwnerBatch => {
  const ordered = [...pending].sort((left, right) => left.sequence - right.sequence);
  const items = ordered.filter((message) => sameScope(message, scope));
  const consumedIds = items.map((message) => message.id);
  const taken = new Set(consumedIds);
  return {
    scope,
    items,
    consumedIds,
    unconsumedIds: ordered.filter((message) => !taken.has(message.id)).map((message) => message.id),
  };
};

/**
 * The batch as one transport payload, with every boundary still visible.
 *
 * Numbered and delimited on purpose: the receiving side has to be able to say which instruction it
 * answered, and a reader has to be able to see that three arrived. A join with "\n" would render
 * identically to one long message the owner never sent.
 */
export const renderOwnerBatch = (batch: OwnerBatch): string =>
  batch.items
    .map((message, index) => `[${index + 1}/${batch.items.length} id=${message.id}]\n${message.text}`)
    .join("\n\n");
