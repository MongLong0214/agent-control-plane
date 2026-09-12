/**
 * #870 — a frame that arrived is counted whatever the seam does with it.
 *
 * `this.#tally.record(await this.#handleFrame(...))` puts `record` on the *outside*, so it runs
 * only if the handler resolves. A sink that threw skipped the tally entirely and left the `EVENT`
 * frame invisible to all three counters — measured by a merge-gate review as `framesHandled: 2`
 * on a case that handles three frames. The comment three lines above claimed the frame was
 * "counted before anything can throw past it", which is the alibi that kept anyone from looking.
 *
 * The cost is not one number. `framesHandled === 0` is the evidence
 * `BUZZ_MENTION_SUBSCRIBER_SILENT` fires on (`src/daemon/daemon.ts`), so a seam throwing on every
 * event presents as a quiet relay: events arriving, none counted, the subscriber diagnosed as
 * silent, and the operator sent to look at the relay while the seam is what is failing.
 *
 * The mutation removes the record from the catch, which is exactly the shipped behaviour. It
 * survives every assertion about the socket and the cursor — those were always right — and dies
 * only on the tally, which is the point: the behaviour was correct and the report was blind.
 */
const aFrameWhoseSeamThrowsIsStillAFrame = {
  id: "a-frame-whose-seam-throws-is-still-a-frame",
  what: "a frame whose admission seam threw is still counted, so a failing seam is not reported as a silent relay",
  file: "src/buzz/buzz-mention-subscriber.ts",
  find: '            this.#tally.record({ rejected: "seam-threw", admission: null });\n',
  replace: "",
  killedBy: [
    "tests/unit/buzz-mention-subscriber.test.ts::keeps reading after a sink that threw, and does not advance past the event it threw on",
  ],
};

export default aFrameWhoseSeamThrowsIsStillAFrame;
