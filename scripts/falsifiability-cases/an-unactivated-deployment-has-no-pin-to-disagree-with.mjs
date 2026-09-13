/**
 * #886 — a deployment that never activated canonical self-claim holds no executor pin, and the
 * absence of a claim is not a disagreement about one.
 *
 * The composition root calls `setCanonicalExecutorVersion` from *inside* the activation block, so
 * `#canonicalExecutorVersion` stays null wherever the `ACP_CANONICAL_*` group is absent — which is
 * every deployment that has never heard of this feature, and which `agentcpd.ts` deliberately
 * treats as ordinary startup ("no partial credential surface is exposed, no socket is bound").
 *
 * Removing the null test makes `null === C0_QUALIFIED_CLIENT.version` the only comparison. That is
 * false, so the finding fires: every such deployment carries an ERROR naming a pin it does not
 * have, and the recommended action tells its operator to move a Keychain value that was never set.
 * A finding that is true of everyone is the noise that gets a surface switched off.
 *
 * The mutant typechecks — `deployed` is `string | null` and the surviving comparison accepts it —
 * so TypeScript is not what enforces this one; the unactivated case is.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const anUnactivatedDeploymentHasNoPinToDisagreeWith = {
  id: "an-unactivated-deployment-has-no-pin-to-disagree-with",
  what:
    "the executor-pin disagreement is not reported when canonical self-claim was never activated, "
    + "because a deployment with no pin has nothing to disagree with",
  file: "src/daemon/daemon.ts",
  find: "    if (deployed === null || deployed === C0_QUALIFIED_CLIENT.version) return [];\n",
  replace: "    if (deployed === C0_QUALIFIED_CLIENT.version) return [];\n",
  killedBy: [
    "tests/unit/the-two-halves-of-the-canonical-end-state-name-one-build.test.ts::stays quiet when canonical self-claim was never activated, which is not a disagreement",
  ],
};

export default anUnactivatedDeploymentHasNoPinToDisagreeWith;
