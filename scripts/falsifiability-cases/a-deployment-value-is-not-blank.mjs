/**
 * #833 - a deployment value that is present but blank is missing.
 *
 * Every `ACP_CANONICAL_*` value reaches this guard as a string, so `typeof value !== "string"` is
 * the half TypeScript already holds; this is the half that matters at runtime. An empty or
 * whitespace-only Keychain entry is exactly what a partially-provisioned deployment produces, and
 * without the trim check it becomes a configured expectation of `""` - which then matches nothing
 * and refuses every claim for an unrelated-looking reason.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "a-deployment-value-is-not-blank",
  what:
    "a required deployment value that is blank is refused as missing, so a whitespace Keychain "
    + "entry does not become a configured expectation of the empty string",
  file: "src/registry/canonical-self-claim.ts",
  find: " || value.trim().length === 0",
  replace: "",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::fails closed, before any effect, when a required deployment value is missing or blank",
  ],
};
export default c;
