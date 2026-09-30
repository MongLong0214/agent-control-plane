/**
 * #954. Whether a role's restoration need is already recorded is answered per revocation, not per
 * role: the reader counts only a `CONTINUITY_RESTORE_AWAITS_CLAIM` row newer than the role's latest
 * `BINDING_REVOKED`. Keyed by role alone, the first episode's record would answer for every later
 * one, and a role revoked a second time would never be recorded or reach `restore()` again.
 *
 * The mutant drops the revocation bound and keeps the role key. The killing test ends the first
 * episode with a claim, revokes the role again for the same cause, and asserts the second return of
 * coverage is deferred afresh and leaves a second record.
 */
const aSecondRevocationIsANewRestorationNeed = {
  id: "a-second-revocation-is-a-new-restoration-need",
  what: "a later revocation of the same role is a new restoration need, not the one already recorded",
  file: "src/continuity/continuity-kernel.ts",
  find:
    "        WHERE kind = 'CONTINUITY_RESTORE_AWAITS_CLAIM' AND role_key = ?\n" +
    "          AND event_id > COALESCE(\n" +
    "                (SELECT MAX(revoked.event_id) FROM audit_events revoked\n" +
    "                  WHERE revoked.kind = 'BINDING_REVOKED' AND revoked.role_key = ?), 0)\n" +
    "        LIMIT 1`,\n" +
    "      [roleKey, roleKey],\n",
  replace:
    "        WHERE kind = 'CONTINUITY_RESTORE_AWAITS_CLAIM' AND role_key = ?\n" +
    "        LIMIT 1`,\n" +
    "      [roleKey],\n",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::answers a second revocation instead of counting it as the one already recorded",
  ],
};

export default aSecondRevocationIsANewRestorationNeed;
