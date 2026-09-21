const delegationAuthenticatedCeoIsAdmissible = {
  "id": "delegation-authenticated-ceo-is-admissible",
  "what": "a READY authenticated CEO session permits authorization",
  "file": "src/ceo/cto-binding-delegation.ts",
  "find": "authenticated.value.lifecycle !== SessionLifecycle.READY",
  "replace": "authenticated.value.lifecycle === SessionLifecycle.READY",
  "killedBy": [
    "tests/unit/cto-binding-delegation.test.ts::authenticates the CEO session"
  ]
};

export default delegationAuthenticatedCeoIsAdmissible;
