/**
 * Which falsifiability rows a change can break — the relation, not yet a runner.
 *
 * #885. A pull request spends 7423 macOS slot-seconds, 6100 of them re-running all 624 mutation
 * rows, and queue time is slot-seconds divided by slots. Running fewer rows per pull request is
 * the only lever on that 82%, and it is also a reduction in what a pull request proves — so the
 * shape it takes is a decision, and this module is the decision written down.
 *
 * **`row.file` alone is not the relation.** That was the first proposal, and it was ruled out
 * rather than narrowed, because a row
 * stops being killed for reasons that never touch the mutated file. Its witness test can change.
 * A shared fixture that witness inherits can change. A module the mutated file calls can change.
 * Deferring those to the `main` sweep moves a regression one merge later instead of catching it,
 * and `main`'s full sweep is additional defence, never a substitute for what a pull request missed.
 *
 * So the selection is the **affected closure**: the row, its definition, its witness, and anything
 * either side transitively imports.
 *
 * ```
 * SELECT r when   r.file            is changed        the mutated module itself
 *                 r.definedIn       is changed        the row's own text — find/replace/killedBy
 *                 killedBy file     is changed        the witness
 *                 killedBy file     imports a change  a shared fixture or helper it inherits
 *                 r.file            imports a change  a module the mutated code calls
 * ```
 *
 * **Undecidable means full, and says which file made it so.** A changed file whose import edges
 * this module was not given is not "probably unrelated" — the caller could not answer, and a
 * selection resting on an answer nobody has is the "coverage implied, not observed" shape the
 * whole harness exists to refuse. The same for a change to the harness, the case loader, this
 * module, or CI: those decide *how* rows are judged rather than *what* any row says, so no row is
 * unaffected by them.
 *
 * A selected row carries **every** reason that put it in scope, so the report does not depend
 * on the order these checks are written in.
 *
 * Nothing here reads the filesystem, spawns anything, or knows what a shard is. It takes the row
 * table, the changed paths and the import graph as values and returns a verdict, because a
 * selector that gathers its own inputs cannot be handed a counterexample.
 *
 * sol-simplify: the contract unit for #885's affected-closure selection; the runner and the
 * baseline comparison that must precede it are separate units.
 */

/** Paths whose change decides how every row is judged, so no row is out of scope. */
export const GLOBAL_SCOPE_PATHS = Object.freeze([
  "scripts/verify-guards-are-falsifiable.mjs",
  "scripts/lib/falsifiability-cases.mjs",
  "scripts/lib/affected-closure.mjs",
  "vitest.config.ts",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
]);

/** A change under any of these decides how the sweep is invoked at all. */
/**
 * A change under this decides how the sweep is invoked at all.
 *
 * `scripts/falsifiability-cases/` was in this list and was measured out of it. Against twelve real
 * changed-file sets from `origin/main`, nine resolved to FULL and eight of those were commits that
 * touched one or more case modules — the closure was answering "the whole table" for a change to a
 * single row's own text. The contract names a row-definition change as a *selection* input, not a
 * full-sweep trigger, and `definedIn` is the term that carries it: a new case module selects the
 * row it declares, and a deleted one removes a row there is nothing left to run.
 */
export const GLOBAL_SCOPE_PREFIXES = Object.freeze([".github/workflows/"]);

/**
 * `killedBy` entries are `<test file>::<test name>`. The name half names the verdict; the file
 * half is what a change can move, and it is the half this relation reads. Measured on the current
 * table: 244 of 244 entries carry the `::`, so a bare-file entry is a shape this has not seen —
 * it is accepted and read as the whole string being the file, rather than silently dropped.
 */
export const witnessFilesOf = (row) => {
  const entries = Array.isArray(row.killedBy) ? row.killedBy : row.killedBy === undefined ? [] : [row.killedBy];
  return entries.map((entry) => String(entry).split("::")[0]).filter((file) => file.length > 0);
};

const reachesAChange = (from, changed, imports, seen = new Set()) => {
  if (from === undefined || seen.has(from)) return false;
  seen.add(from);
  for (const next of imports.get(from) ?? []) {
    if (changed.has(next)) return true;
    if (reachesAChange(next, changed, imports, seen)) return true;
  }
  return false;
};

/**
 * @param rows          the falsifiability table, each row `{ id, file, killedBy, definedIn }`
 * @param changedFiles  repository-relative paths the change touches
 * @param imports       `file -> files it imports`, repository-relative, transitive edges not required
 * @param undecidable   changed paths whose import edges the caller could not determine
 */
export const affectedClosure = ({ rows, changedFiles, imports = new Map(), undecidable = [] }) => {
  const changed = new Set(changedFiles);

  const global = [...changed].filter(
    (path) => GLOBAL_SCOPE_PATHS.includes(path) || GLOBAL_SCOPE_PREFIXES.some((prefix) => path.startsWith(prefix)),
  );
  if (global.length > 0) {
    return { kind: "FULL", reason: `changes how every row is judged or invoked: ${global.sort().join(", ")}` };
  }
  if (undecidable.length > 0) {
    return {
      kind: "FULL",
      reason:
        "the import edges of these changed file(s) could not be determined, and a selection resting " +
        `on an answer nobody has is not a selection: ${[...undecidable].sort().join(", ")}`,
    };
  }

  const selected = [];
  for (const row of rows) {
    const witnesses = witnessFilesOf(row);
    // Every reason that holds, not the first one found. Which reason put a row in scope is what
    // an operator reads to judge whether the selection is right, and reporting only the first
    // makes that reading depend on the order these checks happen to be written in. Measured while
    // writing this: a witness that imports the mutated module reaches the same change from both
    // sides, and a first-match report silently picked one.
    const because = [
      changed.has(row.file) ? "the mutated module changed" : null,
      row.definedIn !== undefined && changed.has(row.definedIn) ? "the row's own definition changed" : null,
      witnesses.some((file) => changed.has(file)) ? "its witness test changed" : null,
      witnesses.some((file) => reachesAChange(file, changed, imports)) ? "its witness imports a changed file" : null,
      reachesAChange(row.file, changed, imports) ? "the mutated module imports a changed file" : null,
    ].filter((reason) => reason !== null);
    if (because.length > 0) selected.push({ row, because });
  }
  return { kind: "SELECTED", selected };
};
