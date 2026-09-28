/**
 * The rule that refuses a published text reads the request that text arrived in.
 *
 * The writer's classification is a property of the code that wrote a reading; this is the property
 * of the file, and it is what a reading taken by some other instrument -- or edited afterwards --
 * is admitted or refused by. It failed in exactly the way the writer did: it asked whether a text
 * contained the token, never which request put it in front of the model, so a reading that carried
 * the client's system prompt inside a count-tokens request or a GET satisfied it. Every count was
 * untouched by that text, so no other rule could notice.
 *
 * The mutation judges every text as if it came from a user message in a turn, which is the form
 * this check had. The killing row appends one such request to an otherwise admitted arm, in both
 * shapes a non-turn takes, and keeps the untouched arm as its control.
 */
const aPublishedTextIsJudgedWithItsRequest = {
  id: "a-published-text-is-judged-with-its-request",
  what: "the acceptance rule judges a verbatim text against the request it was recorded in, not on its content alone",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find:
    "  !isArmEvidence(\n" +
    "    { method: `${request?.method}`, url: `${request?.url}` },\n" +
    "    { from: `${entry.from}`, text: entry.text },\n" +
    "  );\n",
  replace:
    "  !isArmEvidence({ method: \"POST\", url: \"/v1/messages\" }, { from: \"user\", text: entry.text });\n",
  killedBy: [
    "tests/feasibility/wake-transport-readings.test.ts::an arm publishing a text none of its counts are read from is refused",
  ],
};

export default aPublishedTextIsJudgedWithItsRequest;
