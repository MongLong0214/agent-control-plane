// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
export default {
  "id": "durable-authenticated-request-opens-fence",
  "what": "authenticated scoped principal opens its durable operation fence",
  "file": "src/ceo/cto-binding-delegation.ts",
  "find": "grant && authenticated.allowed && principal.data.sessionId === grant.scope.ceoSessionId &&\n          authenticated.value.incarnation === grant.scope.ceoIncarnation",
  "replace": "(grant && authenticated.allowed && principal.data.sessionId === grant.scope.ceoSessionId &&\n          authenticated.value.incarnation === grant.scope.ceoIncarnation) && false",
  "killedBy": [
    "tests/unit/cto-binding-delegation-durable.test.ts::reconstructs only an explicitly durable"
  ]
};
