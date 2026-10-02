/**
 * #1044 ACP-1044-01. The receipt is read when the frame arrives, before it waits behind another
 * frame's admission. The mutation reads it when the frame reaches the front instead, which is the
 * processing-time proof the review measured: a frame that waited across a CTO takeover is then
 * admitted for the successor.
 */
const aFrameKeepsTheReceiptItArrivedWith = {
  id: "a-frame-keeps-the-receipt-it-arrived-with",
  what: "a queued frame carries the CEO generation and CTO session current when it arrived",
  file: "src/buzz/buzz-mention-subscriber.ts",
  find: "            this.#tally.record(await this.#handleFrame(raw, generation, receipt));\n",
  replace: "            this.#tally.record(await this.#handleFrame(raw, generation, this.#peerReceipt()));\n",
  killedBy: [
    "tests/unit/a-ceo-mention-is-a-peer-turn.test.ts::refuses a frame that waited in the subscriber's queue while the CTO was taken over, with zero writes",
  ],
};

export default aFrameKeepsTheReceiptItArrivedWith;
