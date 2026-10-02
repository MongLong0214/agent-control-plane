/**
 * The payload column is write-once, but only the INGRESS_ADMITTED digest says it is the payload the
 * guard admitted rather than one a raw insert placed there first.
 */
const aReplyAddressComesFromTheAdmittedPayload = {
  id: "a-reply-address-comes-from-the-admitted-payload",
  what: "a reply is refused when the stored payload is not the one ingress admitted",
  file: "src/conversation/owner-reply-outbox.ts",
  find: "  if (admitted?.payload_digest !== digestOf(payload)) {",
  replace: "  if (false as boolean) {",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::refuses a payload that is not the one ingress admitted",
  ],
};

export default aReplyAddressComesFromTheAdmittedPayload;
