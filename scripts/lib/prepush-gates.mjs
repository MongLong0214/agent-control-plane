/**
 * The gate set, once, for both the pre-push runner and CI.
 *
 * #736 went green locally on a hand-assembled list of four checks and failed CI in 35 seconds on
 * one `@typescript-eslint/consistent-type-imports` error, because `pnpm lint` was not on that
 * list. The same list went into four subagent briefs and was wrong in all four. There was nothing
 * to be right about: the set existed only as a sequence of `run:` steps in `.github/workflows/`,
 * and reading a workflow is not running one.
 *
 * So the manifest is here, it is data, and CI runs it through the same executor a developer does
 * (`pnpm gates`, one step in the `verify-matrix` job).
 *
 * What belongs here: a check that stops a product defect, or one that keeps the commit record
 * intact. Checks whose only subject was this repository's own documents, rules or verification
 * tooling were removed at the owner's direction on 2026-10-02; each static check that stays says
 * on its entry which product defect it stops.
 */

/**
 * The `verify-matrix` job's verification, in order.
 *
 * Order is not decoration. `trailers` reads a commit range; `build` produces `dist/` that the
 * suite's process-level tests spawn. The cheap structural checks come first because a failure
 * there is a failure in under a second.
 *
 * `argumentFrom` names an environment variable whose value, when non-empty, is appended as a
 * single argument. It exists for exactly one thing: the commit range for `trailers` is a property
 * of the event CI is handling (a pull request's base SHA), not of the gate. The workflow supplies
 * it; the runner never learns what a pull request is. Locally the variable is unset and the check
 * uses its own default, `origin/main..HEAD`.
 */
export const GATES = [
  // The same dependency-free working-tree check the pre-commit hook runs: a workflow `pnpm`
  // command with no package script, or a `run:` that does not parse under Bash. CI also runs it
  // once before `pnpm install`, where that costs seconds rather than the job's minutes.
  { script: "ci:preflight" },
  // #736 failed CI in 35 seconds on one `@typescript-eslint/consistent-type-imports` error while
  // four hand-written local lists all omitted this line. It is the reason the manifest exists.
  { script: "lint" },
  // Reason codes are an external contract (PRD §40): callers match on the string. This refuses a
  // code whose value is not its key and a published code that was removed or renamed.
  { script: "reason-codes" },
  { script: "typecheck" },
  // #859 — a subprocess call in `src/` with no time bound. Measured: a sandboxed command needing
  // 50ms against a 3-second budget came back SANDBOX_CHILD_CLEANUP_FAILED after 24,081ms, because
  // `promisify(execFile)` waits forever without the option.
  { script: "guards:subprocess-bounds" },
  // #858 — a timestamp ORDER BY names a tiebreaker. 400 consecutive clock reads shared one
  // millisecond, and four sites took the first of the tied rows as "the oldest" and handed its
  // channel and nonce to a person; which row that was had been decided by an index choice.
  { script: "guards:timestamp-orderings" },
  // #539 — the peercred addon stays unreachable from every live surface. A new call site (or a
  // ControlPlane export) widens a security boundary; it is a refusal here, not a deliverable.
  { script: "guards:peercred-unreachable" },
  // `migrations:check` freezes what each migration does. v24's DDL was edited in place across two
  // correction rounds; a database created at the earlier one then sat at that version with bodies
  // nobody's code expected and could not settle a turn.
  { script: "migrations:check" },
  // Refuses a table guarded on UPDATE or DELETE and open on INSERT. `INSERT OR REPLACE` skips the
  // implicit delete's triggers on a connection with recursive_triggers off, which is any
  // connection ACP did not open — measured: an `audit_events` row rewritten under its own id with
  // every foreign key still valid.
  { script: "schema:census" },
  // #676: every inline-SQL `Db.run` that names a turn-fence table is in that table's declared
  // owner, so a write cannot reach the fence's tables around the code that enforces the fence.
  { script: "schema:writers" },
  // A trigger sentinel with no entry in TRIGGER_CODES reaches its caller as a raw Error instead of
  // a Decision, so a refusal is indistinguishable from a bug. The whole canonical-turn ledger was
  // in that state, and a census found five more that predate it.
  { script: "schema:denials" },
  // A trigger declared and named by no required registry is created on a fresh install and never
  // checked when a database is opened again — drop it from a live database and nothing notices.
  { script: "schema:registry" },
  // A wrapped CommitLore trailer is not a trailer: git ends the block at the continuation line and
  // the record is stored by nobody. It happened six times on 2026-08-22, and every one was
  // *detected* — `commitlore validate` printed a warning and exited 0, after the commit it
  // described already existed. The local commit-msg hook refuses it up front; this is the half
  // that holds for a clone that never installed the hooks, and for a message a server composes.
  { script: "trailers", argumentFrom: "ACP_TRAILERS_RANGE" },
  // The other half of the same question, and the half `trailers` cannot answer. `trailers` asks
  // whether the lines in this message parse; this asks whether every line the *branch* carried is
  // reachable from the merge at all. A squash whose body is written by hand drops the records
  // entirely and leaves nothing unparseable behind, which is the case `trailers` passes. Shares
  // `ACP_TRAILERS_RANGE` deliberately: the two are about one commit range and a second variable
  // would be a second authority over what that range is.
  { script: "merge-records", argumentFrom: "ACP_TRAILERS_RANGE" },
  { script: "build" },
  // One suite run, and its JSON belongs to the gate that judged this exact run: `pnpm trace`
  // consumes that artifact rather than running the suite a second time, because a second run is a
  // different execution and anything it reports is a claim about a run no gate judged.
  { script: "test" },
];
