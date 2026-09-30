/**
 * A model-input text is kept verbatim only when it came from a request this arm's counts read.
 *
 * Both reviewers reproduced the same defect independently, one of them with a system-prompt
 * fixture. The counts are derived only from turns -- POSTs to the messages endpoint itself -- but
 * the writer kept any text containing the wake token, whatever request it arrived in. Feed the
 * probe a `/v1/messages/count_tokens` request, or a GET, whose text carries the token, and that
 * text is published verbatim in every arm while no count reads a word of it. The repository is
 * public and the text is the client's, so this is the safety defect the withholding rule was
 * written to prevent, one layer up from where it was prevented.
 *
 * The mutation drops the request from the question, which is the state that shipped. The killing
 * row puts the vendor's own text in a count-tokens request and in a GET, and requires both to be
 * accounted for by a digest rather than published -- with the two turns beside them kept verbatim,
 * so it is not a row that withholds everything.
 */
const aTextIsEvidenceOnlyInARequestACountReads = {
  id: "a-text-is-evidence-only-in-a-request-a-count-reads",
  what: "a model-input text is kept verbatim only when the request it arrived in is one the arm's counts are derived from",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find:
    "  isModelRequest(request) &&\n" +
    "  (entry.text.includes(ROLE_WAKE_TOKEN) || (entry.from === \"user\" && entry.text.trim() === prompt));\n",
  replace:
    "  entry.text.includes(ROLE_WAKE_TOKEN) || (entry.from === \"user\" && entry.text.trim() === prompt);\n",
  killedBy: [
    "tests/feasibility/wake-transport-qualification.test.ts::keeps a text verbatim only from the requests its counts are derived from",
  ],
};

export default aTextIsEvidenceOnlyInARequestACountReads;
