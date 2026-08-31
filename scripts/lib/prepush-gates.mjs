/**
 * The gate set, once, for both the pre-push runner and CI.
 *
 * #736 went green locally on a hand-assembled list of four checks and failed CI in 35 seconds on
 * one `@typescript-eslint/consistent-type-imports` error, because `pnpm lint` was not on that
 * list. The same list went into four subagent briefs and was wrong in all four. There was nothing
 * to be right about: the set existed only as a sequence of `run:` steps in `.github/workflows/`,
 * and reading a workflow is not running one.
 *
 * The rejected fix was to parse `ci.yml` at run time and execute the `pnpm` strings it yields
 * (`scripts/lib/ci-workflow-gates.mjs`, written and then deleted; it is preserved in this
 * branch's first commit and imported by nothing).
 * YAML is an execution contract, not a command manifest; partially parsing matrix, condition, env,
 * and working-directory semantics produces another silent omission, and it makes `ci.yml` the
 * source of truth — so a gate the parser misses is missing locally and nobody is told. That is the
 * same defect one layer up.
 *
 * So the manifest is here, it is data, and CI runs it through the same executor a developer does.
 * `scripts/verify-ci-runs-the-gate-runner.mjs` is what keeps that true: it refuses a workflow that
 * runs a verification command the runner does not own.
 */

/**
 * Exactly the `verify-matrix` job's verification steps, in its order.
 *
 * Order is not decoration. `typecheck` regenerates a declaration file and diffs it; `trailers`
 * reads a commit range; `build` produces `dist/` that the suite's process-level tests spawn. The
 * cheap structural checks come first because a failure there is a failure in under a second.
 *
 * `argumentFrom` names an environment variable whose value, when non-empty, is appended as a
 * single argument. It exists for exactly one thing: the commit range for `trailers` is a property
 * of the event CI is handling (a pull request's base SHA), not of the gate. The workflow supplies
 * it; the runner never learns what a pull request is. Locally the variable is unset and the check
 * uses its own default, `origin/main..HEAD`.
 */
export const GATES = [
  // The same dependency-free working-tree check the pre-commit hook runs. CI also runs it once
  // before `pnpm install` (see CI_SETUP_COMMANDS), where a workflow/package-script mismatch or
  // invalid Bash costs seconds rather than the matrix's minutes.
  { script: "ci:preflight" },
  // #739 itself: refuses a workflow that verifies anything this manifest does not own. It is in
  // the set rather than beside it, so the property is checked by the same run everything else is.
  { script: "gates:ci-parity" },
  // #736 failed CI in 35 seconds on one `@typescript-eslint/consistent-type-imports` error while
  // four hand-written local lists all omitted this line. It is the reason the manifest exists.
  { script: "lint" },
  { script: "terminology" },
  // #705 — this check is correct and was reachable from neither package.json nor CI, so a real
  // defect it found (a `_STALE` code absent from STALENESS_REASON_CODES) reported into a room
  // nobody was in. Dependency-free by the same PRD §17.4 contract as `terminology`.
  { script: "reason-codes" },
  // Reports, never fails: stale evidence is a fact to see, and a check that fails on a true
  // statement gets switched off. `--strict` exists for when a release wants a gate.
  { script: "evidence:freshness" },
  { script: "invariants" },
  { script: "typecheck" },
  // #705's static half: every direct script has a plausible invocation site. The command prints
  // that this cannot establish execution and that dynamic measurement remains #705.
  { script: "scripts:plausible-callers" },
  // Mutable repository structure is named by symbols or derived at the point of use. This catches
  // four copied coordinate forms that already went stale in tests and documentation.
  { script: "coordinates:stale" },
  // Seconds, and it answers the question that actually goes stale: does every mutation row still
  // name a line that exists. Editing a guarded line renames its anchor and the row silently stops
  // checking anything — three times on one branch, each found only when the full sweep reached it
  // forty minutes in. This fails first instead.
  { script: "guards:anchors" },
  // The question that found three of four findings in one final review: which operand of a refusal
  // does no falsifiability row name. The harness answers "is this guard tested" for the lines
  // someone wrote a row for; it cannot answer which lines nobody did.
  { script: "guards:operands" },
  // #539 lands src/core/peercred.ts unreachable from every live surface on purpose — a new call
  // site (or a ControlPlane export) is a RED mutant here, not a deliverable.
  { script: "guards:peercred-unreachable" },
  // `migrations:check` freezes what each migration does. v24's DDL was edited in place across two
  // correction rounds; a database created at the earlier one then sat at that version with bodies
  // nobody's code expected and could not settle a turn.
  { script: "migrations:check" },
  // Refuses a table guarded on UPDATE or DELETE and open on INSERT. `INSERT OR REPLACE` skips the
  // implicit delete's triggers on a connection with recursive_triggers off, which is any
  // connection ACP did not open. Adding it found two more tables in that shape within a minute.
  { script: "schema:census" },
  // #676: every inline-SQL direct call whose TypeScript property symbol is exactly Db.run and that
  // names a turn-fence table is in that table's declared application owner.
  { script: "schema:writers" },
  // A trigger sentinel with no entry in TRIGGER_CODES reaches its caller as a raw Error instead of
  // a Decision, so a refusal is indistinguishable from a bug. The whole canonical-turn ledger was
  // in that state, and a census found five more that predate it.
  { script: "schema:denials" },
  // A trigger declared and named by no required registry is created on a fresh install and never
  // checked again — drop it from a live database and nothing notices. The registries are
  // hand-written lists, and four defects on one branch were a hand-written list that stopped
  // matching what it enumerates.
  { script: "schema:registry" },
  // A wrapped CommitLore trailer is not a trailer: git ends the block at the continuation line and
  // the record is stored by nobody. It happened six times on 2026-08-22, and every one was
  // *detected* — `commitlore validate` printed a warning and exited 0, after the commit it
  // described already existed. The local commit-msg hook refuses it up front; this is the half
  // that holds for a clone that never installed the hooks, and for a message a server composes.
  { script: "trailers", argumentFrom: "ACP_TRAILERS_RANGE" },
  { script: "build" },
  // One suite run, and its JSON belongs to the gate that judged this exact run: `pnpm trace`
  // consumes that artifact rather than running the suite a second time, because a second run is a
  // different execution and anything it reports is a claim about a run no gate judged.
  { script: "test" },
];

/** The package script that must invoke the runner, and the file it must invoke. */
export const RUNNER_SCRIPT = "gates";
export const RUNNER_PATH = "scripts/run-prepush-gates.mjs";

/** The workflow job whose verification steps the runner owns. */
export const CI_GATE_JOB = "verify-matrix";

/**
 * Commands a workflow may run outside the runner because they build the environment the runner
 * needs, rather than verifying anything about the tree.
 *
 * `ci:preflight` is here *and* in `GATES`. CI runs it once before `pnpm install` — it is
 * dependency-free, and a workflow/package-script mismatch found there costs seconds instead of the
 * matrix's minutes — and once more inside the runner, where it is part of the set a developer
 * gets. A duplicate that is declared and cheap is not drift; an omission is.
 */
export const CI_SETUP_COMMANDS = new Map([
  ["pnpm install", "installs the dependencies every later gate needs"],
  ["pnpm rebuild", "rebuilds better-sqlite3 against the matrix leg's Node ABI"],
  ["pnpm native:peercred:build", "ADR-0010: prebuilds the Darwin peercred addon before anything loads it"],
  ["pnpm ci:preflight", "runs pre-install as a seconds-long fast fail; also runs inside the runner"],
]);

/**
 * Verification a workflow runs outside the runner on purpose, with the reason it is not a pre-push
 * gate. Every entry must match something a workflow actually runs — a stale exemption is a hole
 * that reads as a decision, so the parity check fails on one that names nothing.
 */
export const VERIFICATION_OUTSIDE_THE_RUNNER = new Map([
  [
    "guard-falsifiability:pnpm guards:falsifiable",
    "the full mutation sweep is over an hour and edits the working tree in place; it has its own job for that reason, and a pre-push gate nobody waits for is not a gate. `guards:anchors` is its seconds-long half and is in the runner.",
  ],
  [
    "traceability:pnpm trace",
    "consumes the Vitest JSON the matrix leg produced, downloaded as an artifact. Running it pre-push would either need a second suite execution — a different run, so a claim about something no gate judged — or a stale file.",
  ],
  [
    "ssot:node scripts/ssot-report.mjs",
    "reconciles against the live issue tracker with GH_TOKEN. It is a fact about the tracker, not about the diff, so it must not be able to fail a push.",
  ],
  [
    "loci:node scripts/verify-tracker-loci-resolve.mjs",
    "#597 citation staleness, on a schedule in tracker-loci.yml. It is red today on an unedited main because an open issue cites a moved line; requiring it anywhere near a merge is how a check gets silenced instead of fixed.",
  ],
]);
