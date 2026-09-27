/**
 * Review #1006/sol ACP1006-R1-03. The startup parser used to check only shape and size while
 * blanks, padding, UUID form and uniqueness lived in `CanonicalSelfClaim`'s constructor — which the
 * operator builds per request, not at startup. A set with two entries sharing a uuid therefore
 * started the listener, the daemon reported itself up, and every claim afterwards failed with
 * INTERNAL_ERROR, while `deploy/README.md` promised an invalid array refuses startup.
 *
 * Returning `parsed.data` is exactly the old behaviour: it still typechecks, because zod's inferred
 * row is structurally a `CanonicalAdoptableSession`. That is what makes this a useful mutant rather
 * than a compile error.
 */
const c = {
  id: "the-startup-parser-validates-the-set",
  what: "an invalid adoptable set refuses startup rather than the first claim",
  file: "src/daemon/agentcpd.ts",
  find: "    return assertCanonicalSessionsValid(parsed.data);",
  replace: "    return parsed.data;",
  killedBy: [
    "tests/unit/daemon-startup.test.ts::refuses",
  ],
};
export default c;
