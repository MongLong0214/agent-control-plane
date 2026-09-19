// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
export default {
  "id": "restoration-live-successor-is-admissible",
  "what": "a dead incumbent and READY live replacement permit restoration",
  "file": "src/session/binding-registry.ts",
  "find": "!incumbent || incumbent.incarnation !== restore.incarnation ||\n        !replacement || replacement.provider !== \"hermes\" || replacement.lifecycle !== SessionLifecycle.READY ||\n        probeSessionLiveness(incumbent.osPid, incumbent.osProcessStartedAt) !== \"DEAD\" ||\n        probeSessionLiveness(replacement.osPid, replacement.osProcessStartedAt) !== \"ALIVE\"",
  "replace": "(!incumbent || incumbent.incarnation !== restore.incarnation ||\n        !replacement || replacement.provider !== \"hermes\" || replacement.lifecycle !== SessionLifecycle.READY ||\n        probeSessionLiveness(incumbent.osPid, incumbent.osProcessStartedAt) !== \"DEAD\" ||\n        probeSessionLiveness(replacement.osPid, replacement.osProcessStartedAt) !== \"ALIVE\") || true",
  "killedBy": [
    "tests/unit/ceo-same-actor-restore.test.ts::attaches the first authenticated target"
  ]
};
