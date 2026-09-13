import { describe, expect, it } from "vitest";

import {
  GLOBAL_SCOPE_PATHS,
  affectedClosure,
  witnessFilesOf,
} from "../../scripts/lib/affected-closure.mjs";

/**
 * #885's selector contract, as its own unit and ahead of any runner.
 *
 * Five shapes decide whether this relation is worth having, and four of them are the ones that
 * kill the selector it replaces. `rowFileOnly` below is that refused proposal, kept here as a
 * live control rather than described: each case measures what it selects, so "the closure is
 * wider" is a comparison and not a claim.
 *
 * Nothing here touches the sweep or CI. The full sweep still runs everywhere; this unit only
 * fixes what a later one is allowed to select.
 */

/**
 * The proposal this contract replaces: select a row when the change touches the file it mutates.
 * It is here to be shown failing. A test that only exercises the accepted relation cannot say
 * whether the accepted relation was needed.
 */
const rowFileOnly = (rows: ReadonlyArray<{ id: string; file: string }>, changed: readonly string[]) =>
  rows.filter((row) => changed.includes(row.file));

const ROWS = [
  {
    id: "a-claim-checks-the-derived-uuid",
    file: "src/registry/canonical-self-claim.ts",
    definedIn: "scripts/falsifiability-cases/a-claim-checks-the-derived-uuid.mjs",
    killedBy: ["tests/unit/canonical-self-claim.test.ts::clause 1 — a caller-supplied session UUID"],
  },
  {
    id: "a-buzz-message-from-a-non-owner-reaches-nobody",
    file: "src/ingress/buzz-message.ts",
    definedIn: "scripts/falsifiability-cases/a-buzz-message-from-a-non-owner-reaches-nobody.mjs",
    killedBy: ["tests/unit/buzz-message-ingress.test.ts::refuses an ACTIVE non-owner's other message"],
  },
] as const;

/** `tests/helpers/fixtures.ts` is inherited by 33 test files; here two of them, one at a hop. */
const IMPORTS = new Map<string, readonly string[]>([
  ["tests/unit/canonical-self-claim.test.ts", ["tests/helpers/bounded-child.ts", "src/registry/canonical-self-claim.ts"]],
  ["tests/helpers/bounded-child.ts", ["tests/helpers/fixtures.ts"]],
  ["tests/unit/buzz-message-ingress.test.ts", ["src/ingress/buzz-message.ts"]],
  ["src/ingress/buzz-message.ts", ["src/core/errors.ts"]],
]);

const closure = (changedFiles: readonly string[], extra: Record<string, unknown> = {}) =>
  affectedClosure({ rows: ROWS, changedFiles, imports: IMPORTS, ...extra }) as
    | { kind: "FULL"; reason: string }
    | { kind: "SELECTED"; selected: ReadonlyArray<{ row: { id: string }; because: readonly string[] }> };

const idsOf = (result: ReturnType<typeof closure>) =>
  result.kind === "SELECTED" ? result.selected.map((one) => one.row.id).sort() : ["<FULL>"];

describe("the affected closure selects what a change can break", () => {
  it("1 — a direct change to the mutated module selects its rows, and so did the refused proposal", () => {
    const changed = ["src/ingress/buzz-message.ts"];
    expect(idsOf(closure(changed))).toEqual(["a-buzz-message-from-a-non-owner-reaches-nobody"]);
    // The one shape both relations agree on. Named so the three below are read as differences
    // rather than as this one being the whole contract.
    expect(rowFileOnly(ROWS, changed).map((row) => row.id)).toEqual([
      "a-buzz-message-from-a-non-owner-reaches-nobody",
    ]);
  });

  it("2 — a change to the witness test alone selects its row; the refused proposal selects nothing", () => {
    const changed = ["tests/unit/canonical-self-claim.test.ts"];
    expect(rowFileOnly(ROWS, changed)).toEqual([]);
    const result = closure(changed);
    expect(idsOf(result)).toEqual(["a-claim-checks-the-derived-uuid"]);
    expect(result.kind === "SELECTED" && result.selected[0]?.because).toEqual(["its witness test changed"]);
  });

  it("3 — a change to a shared helper two hops from the witness selects the row it can un-kill", () => {
    const changed = ["tests/helpers/fixtures.ts"];
    expect(rowFileOnly(ROWS, changed)).toEqual([]);
    const result = closure(changed);
    expect(idsOf(result)).toEqual(["a-claim-checks-the-derived-uuid"]);
    expect(result.kind === "SELECTED" && result.selected[0]?.because).toEqual(["its witness imports a changed file"]);
  });

  /**
   * Written first as a single-reason assertion, and it failed: `buzz-message-ingress.test.ts`
   * imports the module under mutation, so the change one hop below is reachable from the witness
   * *and* from the mutated file. Both reasons are true, and a first-match report picked whichever
   * check happened to be written higher. The contract now reports every reason that holds, and
   * this row is the case that earned it.
   */
  it("3b — a change a hop below the mutated module selects it, and reports both routes that reach it", () => {
    const result = closure(["src/core/errors.ts"]);
    expect(idsOf(result)).toEqual(["a-buzz-message-from-a-non-owner-reaches-nobody"]);
    expect(result.kind === "SELECTED" && result.selected[0]?.because).toEqual([
      "its witness imports a changed file",
      "the mutated module imports a changed file",
    ]);
  });

  it("4 — a changed file whose import edges the caller could not determine is FULL, and names it", () => {
    const result = closure(["src/generated/schema.d.ts"], { undecidable: ["src/generated/schema.d.ts"] });
    expect(result.kind).toBe("FULL");
    expect(result.kind === "FULL" && result.reason).toContain("src/generated/schema.d.ts");
    expect(result.kind === "FULL" && result.reason).toContain("could not be determined");
  });

  it("4b — the harness, the case loader, this module and CI are FULL: they judge every row", () => {
    for (const path of [...GLOBAL_SCOPE_PATHS, ".github/workflows/ci.yml"]) {
      const result = closure([path]);
      expect(result.kind, `${path} must put the whole table in scope`).toBe("FULL");
      expect(result.kind === "FULL" && result.reason).toContain(path);
    }
  });

  it("4c — a row-definition change selects that row even when nothing it names moved", () => {
    const result = closure(["scripts/falsifiability-cases/a-claim-checks-the-derived-uuid.mjs"]);
    // Also FULL-by-prefix today, because the case directory is global scope. Both answers put the
    // row in scope; this asserts the row is never *missed*, which is the property that matters.
    expect(idsOf(result)).not.toEqual([]);
  });

  it("5 — the control: a change that affects nothing selects zero rows, and zero is not a constant", () => {
    const empty = closure(["docs/OPERATIONS.md"]);
    expect(empty.kind).toBe("SELECTED");
    expect(idsOf(empty)).toEqual([]);

    // Without this, a selector that always returned zero would pass the line above. The same call
    // with one relevant path added must select — so the zero is a reading of the input, not the
    // function's only answer.
    expect(idsOf(closure(["docs/OPERATIONS.md", "src/ingress/buzz-message.ts"]))).toEqual([
      "a-buzz-message-from-a-non-owner-reaches-nobody",
    ]);
  });

  it("an empty change set selects nothing and is still a selection, never a fallback to FULL", () => {
    expect(closure([]).kind).toBe("SELECTED");
    expect(idsOf(closure([]))).toEqual([]);
  });

  it("a cycle in the import graph terminates rather than selecting by exhaustion", () => {
    const cyclic = new Map<string, readonly string[]>([
      ["tests/unit/canonical-self-claim.test.ts", ["a.ts"]],
      ["a.ts", ["b.ts"]],
      ["b.ts", ["a.ts"]],
    ]);
    const result = affectedClosure({ rows: ROWS, changedFiles: ["unrelated.ts"], imports: cyclic }) as {
      kind: string;
      selected: readonly unknown[];
    };
    expect(result.kind).toBe("SELECTED");
    expect(result.selected).toEqual([]);
  });

  it("witnessFilesOf reads the file half of every killedBy entry, and drops none", () => {
    expect(witnessFilesOf({ killedBy: ["tests/unit/x.test.ts::a name with :: inside"] })).toEqual([
      "tests/unit/x.test.ts",
    ]);
    // Measured on the current table: 244 of 244 entries carry `::`. A bare-file entry is a shape
    // the table does not hold today, and it is read as the whole string rather than dropped —
    // dropping it would silently narrow the closure.
    expect(witnessFilesOf({ killedBy: ["tests/unit/bare.test.ts"] })).toEqual(["tests/unit/bare.test.ts"]);
    expect(witnessFilesOf({ killedBy: [] })).toEqual([]);
    expect(witnessFilesOf({})).toEqual([]);
  });
});
