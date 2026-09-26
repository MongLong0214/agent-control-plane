/**
 * #954 — the role probe's durable record carries the reason, not only the shape of the reading.
 *
 * On this deployment `claude` is role-scoped. `CapacityMonitor.refresh` excludes a role-scoped
 * provider even when a caller names it explicitly — an explicit id is routed to `ambiguous` and
 * comes back as `unknownCapacity` — so the `CAPACITY_PROBE` row, the only other event whose
 * allowlisted `error` key carries a collector sentence, is never written for it. This event is the
 * whole durable record of a role probe; the process-local role snapshot it mirrors dies with the
 * process.
 *
 * The block above this line was added for #917, whose finding was that the role path "had been
 * explainable nowhere". It recorded the shape of the reading and dropped the reason, so a pin
 * whose target the updater deleted was on disk as health and buckets and nothing that named it.
 *
 * The mutation removes the field, which is that state, and typechecks — audit evidence is an
 * open record type, so the compiler has nothing to say about a missing key. Recording the audit
 * inside `refreshForRole` instead was ruled out long before this change: `role-bound-capacity`
 * hands that slice a proxy that throws on db, audit and telemetry.
 *
 * Exercised with `--only` before this prose was written: `killed`.
 */
const c = {
  id: "a-role-probe-records-why-not-only-what",
  what:
    "the CAPACITY_ROLE_PROBE event carries the collector's error, so the only durable record of a "
    + "role-scoped probe can name why the sensor failed and not merely that it did",
  file: "src/continuity/continuity-kernel.ts",
  find: "            error: measured.error ?? null,\n",
  replace: "",
  killedBy: [
    "tests/unit/daemon-sensor-failure-binding.test.ts::#954: a failed role probe records the collector's sentence, not only the shape of the reading",
  ],
};
export default c;
