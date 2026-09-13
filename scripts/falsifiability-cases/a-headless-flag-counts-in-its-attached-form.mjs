/**
 * #833 - and in its attached form.
 *
 * Its own row rather than folded in with the bare form: the two are separate operands of one `||`
 * and the suite has a case for each, because `--output-format=json` and `--output-format json`
 * are the same flag and only one of them is an exact token match.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "a-headless-flag-counts-in-its-attached-form",
  what:
    "a headless flag written as flag=value still marks the invocation headless",
  file: "src/registry/canonical-self-claim.ts",
  find: " || token.startsWith(`${flag}=`)",
  replace: "",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::rejects a headless flag in its attached form, not only its separated form",
  ],
};
export default c;
