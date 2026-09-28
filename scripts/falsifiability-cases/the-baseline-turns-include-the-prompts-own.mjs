/**
 * The turns an arm counts as its baseline have to include the one its own prompt started.
 *
 * The baseline is a position now -- the requests that preceded the recorded frame -- and a position
 * says nothing about what those turns carried. The probe refuses to proceed without the prompt's
 * turn (`baselineTurnObserved`), but that is a property of the code that took the reading; this is
 * the same question asked of the committed file, where the prompt's user text is one of the two
 * things kept verbatim. Without it a record whose pre-frame turns are the client's own business
 * qualifies a session that never accepted the prompt at all.
 *
 * The mutation drops the check. The killing row swaps the order of an arm's two requests, so the
 * turn before its boundary is the wake-carrying one and the prompt's turn falls after -- every
 * count still agrees with the observations, and only this rule sees it.
 */
const theBaselineTurnsIncludeThePromptsOwn = {
  id: "the-baseline-turns-include-the-prompts-own",
  what: "the acceptance rule refuses an arm that observed no turn carrying its own prompt before its recorded boundary",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find:
    "        if (!baselineTurnBeforeBoundary(observations)) {\n" +
    "          shortfalls.push(\n" +
    "            `${where} shows no turn carrying the prompt it was started with before that point, so its baseline ` +\n" +
    "              `counts turns that are not the prompt's`,\n" +
    "          );\n" +
    "        }\n",
  replace: "",
  killedBy: [
    "tests/feasibility/wake-transport-readings.test.ts::an arm that does not say where its frame went, or says it went somewhere its own arm did not, is refused",
  ],
};

export default theBaselineTurnsIncludeThePromptsOwn;
