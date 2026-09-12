/**
 * #833 — a re-registration that changes the trust class is refused rather than applying it.
 *
 * Each of the four fields is guarded by a pair — provided, and different. The changed-field test supplies the other three unchanged, so only this comparison sees its own change; the retry test omits all four, so removing a presence check turns `undefined != stored` into a refusal of a plain idempotent retry. Registration retries are deliberately inert, and a rebinding is deliberately an activation, so both halves have an observable.
 *
 * The anchor is the operand rather than its line: `hasBindingChange` puts eight operands in
 * one expression and the census credits every operand inside an anchor.
 */
const aTrustRebindingNeedsActivation = {
  id: 'a-trust-rebinding-needs-activation',
  what: 'a re-registration that changes the trust class is refused rather than applying it',
  file: "src/registry/repository-registry.ts",
  find: 'input.trustClass !== existing.trustClass',
  replace: 'false',
  killedBy: [
    'tests/unit/cto-registry-r2.test.ts::refuses a re-registration that changes any one binding field',
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aTrustRebindingNeedsActivation;
