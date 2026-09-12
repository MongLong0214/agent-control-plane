/**
 * #833 — The typeof half admits the empty string and a whitespace-only one — both are strings — so this operand is the only thing that stops a required deployment value from being present and empty. Killed by the construction test that passes an empty requiredExecutorVersion and a whitespace-only canonicalBuzzChannelId and expects a throw naming the field.
 *
 * The anchor is the operand rather than its line, because the census credits every operand inside
 * an anchor.
 */
const aCanonicalConfigValueIsNotBlank = {
  id: 'a-canonical-config-value-is-not-blank',
  what: 'a blank deployment config value is refused at construction, not carried as an empty string',
  file: "src/registry/canonical-self-claim.ts",
  find: 'value.trim().length === 0',
  replace: 'false',
  killedBy: [
    'tests/unit/canonical-self-claim.test.ts::fails closed, before any effect, when a required deployment value is missing or blank',
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aCanonicalConfigValueIsNotBlank;
