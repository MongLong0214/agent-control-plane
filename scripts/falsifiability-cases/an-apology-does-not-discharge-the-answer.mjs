/**
 * `turnAnswered` is what separates the CEO's answer from a sentence the daemon composed when the CEO
 * could not be asked. An apology the transport accepted discharges nothing; the receipt still proves
 * an answer exists, and it is still owed.
 */
const anApologyDoesNotDischargeTheAnswer = {
  id: "an-apology-does-not-discharge-the-answer",
  what: "a reserved reply that is not the CEO's answer leaves the answer owed",
  file: "src/conversation/owner-reply-outbox.ts",
  find: '  if (result?.["turnAnswered"] !== true) return false;',
  replace: '  if (result?.["turnAnswered"] === undefined) return false;',
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::still owes the answer when what the transport carried for the message was only an apology",
  ],
};

export default anApologyDoesNotDischargeTheAnswer;
