/**
 * A turn counts as wake-carrying when the token is in what the model was asked, not anywhere in
 * the request.
 *
 * The count used to be `request.body.includes(ROLE_WAKE_TOKEN)` over the serialized body, and a
 * substring test over serialized JSON is wrong in both directions. Both reviewers reproduced the
 * first: a follow-up request whose messages say only `ping`, carrying the token in
 * `metadata.user_id`, was counted as a delivery -- the client puts that field there for the
 * provider and the model never reads it. One of them drove the real probe with in-memory
 * boundaries and got four passing arms and a `qualified` receipt out of it. The second reviewer
 * found the mirror: JSON-escaping one character of the token inside real model input produced a
 * false negative, because the escape is in the encoding and not in the text.
 *
 * This count is what decides whether a build joins the qualified set -- the injection arm requires
 * it positive, the control requires it zero -- so a place the model never reads standing in for a
 * delivery makes both claims about something other than what they say.
 *
 * The mutation restores the old serialized-body test exactly. The killing row keeps the live shape
 * as its control -- the token inside client-composed prose in a user message, which is what every
 * capture on this host shows and which must still count -- so it cannot pass by counting nothing.
 */
const aWakeIsCountedWhereTheModelReads = {
  id: "a-wake-is-counted-where-the-model-reads",
  what: "the harness counts a wake-carrying turn from the token in the request's model input, not from a substring of its serialized body",
  file: "tests/feasibility/wake-transport-qualification/harness.ts",
  find: "    modelInputTexts(request.body).some(({ text }) => text.includes(ROLE_WAKE_TOKEN)),\n",
  replace: "    request.body.includes(ROLE_WAKE_TOKEN),\n",
  killedBy: [
    "tests/feasibility/wake-transport-qualification.test.ts::a wake is counted where the model reads, so metadata is not a delivery and an escape is",
  ],
};

export default aWakeIsCountedWhereTheModelReads;
