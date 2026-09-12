/**
 * The tally is the only thing that separates "connected and receiving nothing" from "receiving and
 * refusing", and before #841 neither existed: `socketCount` counts configured identities at
 * startup and moves for neither case. Dropping the `record` call restores exactly that state — the
 * subscriber still works, still refuses, still reconnects, and reports nothing about any of it.
 *
 * The mutation keeps the `await`, so frame handling is unchanged and only the observation is lost.
 * That is the shape worth pinning: a silent regression here does not break delivery, it breaks the
 * ability to tell whether delivery is happening.
 */
const theSubscriberCountsTheFramesItHandles = {
  id: "the-subscriber-counts-the-frames-it-handles",
  what: "every frame that reaches the subscriber is counted, with its refusal reason",
  file: "src/buzz/buzz-mention-subscriber.ts",
  find: "            this.#tally.record(await this.#handleFrame(raw, generation));\n",
  replace: "            await this.#handleFrame(raw, generation);\n",
  killedBy: [
    "tests/unit/buzz-mention-subscriber.test.ts::counts a frame it refuses, under the reason it refused it",
  ],
};

export default theSubscriberCountsTheFramesItHandles;
