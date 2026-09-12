/**
 * Blocking subprocess calls that do not yet state a time bound.
 *
 * These are NOT assessed as safe. Each one waits forever if its child does, and
 * `src/verify/sandbox.ts` showed what that costs on a path that decides a verdict (#844): a
 * command needing 50ms against a 3-second budget came back as a containment failure after
 * 24,081ms, with a `ps` made to take 8s and nothing else changed.
 *
 * They are listed so the census can pass on today's tree while refusing the *next* unbounded call,
 * which is the part that kept failing: the bound diverged across two implementations of the same
 * `ps -o lstart=` probe and nothing compared them for weeks. Remove an entry by bounding its call.
 *
 * Keyed by `path:line`, which goes stale when the file above it grows — so the census reports a
 * name that no longer matches as a STALE EXCLUSION and fails on it, rather than letting a moved
 * line excuse whatever call now sits there. That is the fix for an allow-list keyed by `file:line`
 * quietly excusing the wrong thing.
 *
 * One entry this list does not have: `src/runtime/cli-adapters.ts:1272`. The first census of this
 * class was taken by regex and counted it, because the line is
 * `(allow process-exec (literal ...))` inside a seatbelt policy string. The parser does not, and
 * that correction is the reason this census is parsed rather than matched.
 *
 * sol-simplify: the backlog stays visible; remove entries as the calls are bounded (#859).
 */
const reason = "not yet bounded; entered the census when it was first taken; tracked as #859";

export const UNBOUNDED_SUBPROCESS_EXCLUSIONS = new Map([
  ["src/ceo/production-gate.ts:867", reason],
  ["src/cli/attach-relay.ts:232", reason],
  ["src/deploy/rollback-pair.ts:582", reason],
  ["src/deploy/rollback-pair.ts:1785", reason],
  ["src/doctor/doctor.ts:1208", reason],
  ["src/guard/workspace-probe.ts:49", reason],
  ["src/guard/workspace-probe.ts:72", reason],
  ["src/registry/repository-registry.ts:418", reason],
  ["src/registry/repository-registry.ts:430", reason],
  ["src/tools/traceability.ts:300", reason],
  ["src/tools/traceability.ts:303", reason],
  ["src/tools/traceability.ts:469", reason],
]);
