/**
 * `configuredCanonicalSessions` reads ACP_CANONICAL_SESSIONS_JSON's shape and its internal
 * consistency; neither can see whether the project an entry names was ever registered. Before
 * this check a deployment configured with an unregistered project started the listener and
 * reported itself up while the entitlement it held named a project no row exists for.
 *
 * The mutant keeps the lookup and the refusal text and makes the condition unreachable: no
 * `findIndex` result is below -1, so every configured set starts, which is the defect restored.
 * It still typechecks. The named test configures one unregistered project through `main()` and
 * requires startup to refuse.
 */
const c = {
  id: "a-configured-canonical-session-names-a-registered-project",
  what: "a configured canonical session naming an unregistered project refuses startup",
  file: "src/daemon/agentcpd.ts",
  find: "      if (unregisteredEntryIndex !== -1) {",
  replace: "      if (unregisteredEntryIndex < -1) {",
  killedBy: [
    "tests/unit/canonical-session-project-must-be-registered.test.ts::refuses startup when the only configured entry names a project the registry does not hold",
  ],
};
export default c;
