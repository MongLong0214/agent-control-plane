// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
const delegationDeadIncumbentCanBeReplaced = {
  "id": "delegation-dead-incumbent-can-be-replaced",
  "what": "a proven-dead incumbent can be replaced under the grant",
  "file": "src/daemon/cto-delegated-binding.ts",
  "find": "{\n        const session = sessions.get(binding.sessionId);\n        return !!session && session.incarnation === binding.sessionIncarnation &&\n          probeSessionLiveness(session.osPid, session.osProcessStartedAt) === \"DEAD\";\n      }",
  "replace": "{\n        const session = sessions.get(binding.sessionId);\n        return !!session && session.incarnation === binding.sessionIncarnation &&\n          probeSessionLiveness(session.osPid, session.osProcessStartedAt) !== \"DEAD\";\n      }",
  "killedBy": [
    "tests/unit/cto-delegated-binding.test.ts::socket authenticates CEO"
  ]
};

export default delegationDeadIncumbentCanBeReplaced;
