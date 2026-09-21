const delegationTargetIsNotTheCaller = {
  "id": "delegation-target-is-not-the-caller",
  "what": "a target distinct from the calling CEO permits authorization",
  "file": "src/ceo/cto-binding-delegation.ts",
  "find": "request.targetSessionId === p.sessionId",
  "replace": "request.targetSessionId !== p.sessionId",
  "killedBy": [
    "tests/unit/cto-binding-delegation.test.ts::authenticates the CEO session"
  ]
};

export default delegationTargetIsNotTheCaller;
