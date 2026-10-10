#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Machine-checked traceability (PRD §38, §42 item 10).
 *
 * A scenario has declaration coverage only when its identifier resolves to an executable
 * Vitest test, and that exact test appears as passed in a fresh JSON-reporter result set. This
 * establishes declaration coverage; behavioural coverage and production-entry-point coverage
 * are not measured here.
 */
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export interface Requirement {
  id: string;
  text: string;
  blocking: string;
  scenarios: string[];
  evidenceSource: string;
}

export interface TestReference {
  file: string;
  title: string;
}

export interface ExecutableTestDeclaration extends TestReference {
  fullName: string;
  scenarioIds: string[];
}

export interface VitestAssertionResult {
  fullName: string;
  status: string;
}

export interface VitestTestResult {
  name: string;
  assertionResults: VitestAssertionResult[];
}

export interface VitestJsonReport {
  success: boolean;
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  testResults: VitestTestResult[];
}

interface RequirementRow extends Requirement {
  coveredScenarios: string[];
  missingScenarios: string[];
  status: "NO_SCENARIOS" | "DECLARATION_COVERED" | "DECLARATION_GAP";
}

interface ScenarioRow {
  id: string;
  description: string;
  tests: TestReference[];
  status: "DECLARATION_COVERED" | "DECLARATION_MISSING";
}

/** One Repo Factory scenario, or one arm of one, whose tests live in another repository. */
export interface ExternalScenario {
  readonly id: string;
  /**
   * `null` when the whole scenario is judged there. Otherwise the one arm judged there: the rest
   * still needs a passed declaration in this repository, and the arm alone covers nothing.
   */
  readonly arm: string | null;
  /** The other repository's own test ids (pytest node ids), as its CI runs them. */
  readonly tests: readonly string[];
  /** What the external evidence does not show, stated beside it rather than left out. */
  readonly limit?: string;
}

export interface ExternalScenarioEvidence {
  readonly repository: string;
  /** The exact commit the listed tests are the evidence at. */
  readonly revision: string;
  /** The CI run that judged that commit. */
  readonly ciRun: string;
  readonly scenarios: readonly ExternalScenario[];
}

/** An external entry as one report row carries it: where the evidence is, and what it covers. */
export interface ExternalScenarioReference extends ExternalScenario {
  readonly repository: string;
  readonly revision: string;
  readonly ciRun: string;
  /** Recorded with the entry, never measured here: the ACP producer does not implement it. */
  readonly acpUnattendedRun: "NOT_SUPPORTED";
}

/**
 * Repo Factory scenarios whose execution evidence is in the Python repo-factory repository.
 *
 * ACP's own bootstrap producer (`src/bootstrap/repo-factory-producer.ts` and what it calls)
 * creates one repository and checks a clean tree. It selects no artifacts by profile, renders no
 * CI, runs no lean review, computes no PlanCore digest and has no CommitLore step. These
 * scenarios therefore cannot run in this repository, and ACP's unattended bootstrap run does not
 * support them. Their ownership was assigned to repo-factory; this constant is where that
 * assignment is written down, and the one thing to change if it moves.
 *
 * What the report does with an entry:
 * - `arm: null` makes the scenario EXTERNAL. It is listed with these test ids, the revision and
 *   the CI run, and it is never counted as a passed declaration. This tool cannot read that run,
 *   so an entry points at evidence; it is not evidence.
 * - an `arm` names the one part judged there. The scenario's verdict still comes from this
 *   repository's own declarations, and the arm is reported as not supported by the ACP run.
 * - a scenario that is listed whole and also declared by a test here, or listed whole twice, is
 *   DUPLICATE and fails. Each scenario has exactly one judge.
 *
 * repo-factory's CI step (`pytest tests/ -q`) keeps no per-test result, only its summary line
 * (`852 passed, 3 skipped` for the run below). Each listed id was seen to pass in a junit run of
 * the same revision; the CI run shows that the suite as a whole passed there.
 */
export const REPO_FACTORY_EXTERNAL_EVIDENCE: ExternalScenarioEvidence = {
  repository: "MongLong0214/repo-factory",
  revision: "309e2e6b47b0bc35db0147cb5fe5c132580653d7",
  ciRun: "36937509727",
  scenarios: [
    {
      id: "RF-S02",
      arm: null,
      tests: ["tests/test_slice1_plan.py::test_simple_materializes_no_formal_documents_without_optional_requests"],
    },
    {
      id: "RF-S03",
      arm: null,
      tests: [
        "tests/test_slice1_plan.py::test_standard_lean_revision_preserves_product_scope_and_required_artifacts",
        "tests/test_slice1_plan.py::test_lean_review_refuses_product_scope_and_required_artifact_removal",
        "tests/test_slice1_plan.py::test_lean_decision_refuses_planning",
      ],
      limit:
        "a lean verdict is applied when one is supplied; nothing requires or produces one, so an " +
        "over-designed STANDARD request without a review compiles unchanged",
    },
    {
      id: "RF-S04",
      arm: null,
      tests: ["tests/test_slice1_plan.py::test_rf_s04_a_different_timestamp_is_the_same_plan"],
    },
    {
      id: "RF-S08",
      arm: null,
      tests: ["tests/test_slice2_stack_ci.py::test_node_workflow_installs_dependencies_on_both_declared_runtimes"],
      limit:
        "a static check of the rendered workflow; the only real lower/latest install is a recorded " +
        "Actions run (32256790243), which no gate re-runs",
    },
    {
      id: "RF-S16",
      arm: "two repositories",
      tests: [
        "tests/test_slice3_apply.py::test_a_partial_apply_reports_what_completed_rather_than_claiming_atomicity",
        "tests/test_slice3_apply.py::test_resume_after_a_partial_apply_starts_from_the_verified_receipt",
      ],
    },
    {
      id: "RF-S19",
      arm: null,
      tests: ["tests/test_publish.py::test_simple_missing_commitlore_warns_and_continues_with_a_receipt"],
    },
    {
      id: "RF-S20",
      arm: null,
      tests: ["tests/test_publish.py::test_standard_missing_commitlore_refuses_before_push_for_revision"],
    },
    {
      id: "RF-S21",
      arm: null,
      tests: ["tests/test_publish.py::test_guarded_missing_commitlore_refuses_before_push_as_blocking"],
    },
  ],
};

interface RepoFactoryScenarioRow {
  id: string;
  description: string;
  /** Passed declarations in this repository's result set. */
  tests: TestReference[];
  status: "DECLARATION_COVERED" | "DECLARATION_MISSING" | "EXTERNAL" | "DUPLICATE";
  external: ExternalScenarioReference[];
}

export interface TraceabilityReport {
  generatedFrom: string[];
  /**
   * The commit this report's counts were measured against.
   *
   * The rendered prose used to call its inputs "this fresh JSON-reporter result set" while the
   * committed copy sat 15 tests behind the tree (#560) — a claim of currency that nothing kept
   * true. Naming the commit makes the file self-describing instead: the counts stay meaningful
   * because a reader can see which tree they belong to.
   *
   * Deliberately **not** one of `verify-evidence-freshness`'s `DIGEST_KEYS`, so this does not
   * silently reclassify the file from report to evidence. That reclassification is a real
   * option — the file does describe a tree — but it makes every commit touching `src/` stale it,
   * so every such PR would have to carry a regenerated artifact. That is a workflow decision,
   * and it is left open in #560 rather than smuggled in behind a key name.
   */
  measuredAt: string;
  testRun: {
    reporter: "vitest-json";
    success: boolean;
    total: number;
    passed: number;
    failed: number;
    pending: number;
  };
  summary: {
    requirements: number;
    requirementsWithDeclarationCoverage: number;
    requirementsWithGaps: number;
    scenarios: number;
    scenariosWithPassedDeclarations: number;
    scenariosMissing: string[];
    repoFactoryScenarios: number;
    /** Passed in this result set. External scenarios are never counted here. */
    repoFactoryScenariosWithPassedDeclarations: number;
    /** No passed declaration here and no external entry: these fail, as a missing CP scenario does. */
    repoFactoryScenariosMissing: string[];
    /** Judged by another repository's tests, listed by id; not verified by this result set. */
    repoFactoryScenariosExternal: string[];
    /** Claimed by more than one judge: these fail. */
    repoFactoryScenariosDuplicated: string[];
    /** An external entry this report cannot use as written: these fail. */
    repoFactoryExternalEvidenceProblems: string[];
  };
  requirements: RequirementRow[];
  scenarios: ScenarioRow[];
  repoFactoryScenarios: RepoFactoryScenarioRow[];
}

const readPrd = (root: string, name: string): string => readFileSync(join(root, "docs", "prd", name), "utf8");

/** §37 — `| CP-001 | requirement | P0 |` */
export const parseRequirements = (prd: string, prefix: string): Map<string, Requirement> => {
  const requirements = new Map<string, Requirement>();
  const rowPattern = new RegExp(`^\\|\\s*(${prefix}-\\d{3})\\s*\\|([^|]*)\\|\\s*(P\\d)\\s*\\|`, "gm");
  for (const match of prd.matchAll(rowPattern)) {
    requirements.set(match[1]!, {
      id: match[1]!,
      text: match[2]!.trim(),
      blocking: match[3]!,
      scenarios: [],
      evidenceSource: "",
    });
  }
  return requirements;
};

/** §38 — `| CP-001 | CP-S01–CP-S03 | Evidence Source | P0 |` */
export const attachScenarios = (
  prd: string,
  requirements: Map<string, Requirement>,
  prefix: string,
): void => {
  const rowPattern = new RegExp(
    `^\\|\\s*(${prefix}-\\d{3})\\s*\\|([^|]*)\\|([^|]*)\\|\\s*(P\\d)\\s*\\|`,
    "gm",
  );
  for (const match of prd.matchAll(rowPattern)) {
    const requirement = requirements.get(match[1]!);
    if (!requirement) continue;
    const cell = match[2]!;
    if (!new RegExp(`${prefix}-S`).test(cell)) continue; // this is the §37 row, not §38
    requirement.scenarios = expandScenarioCell(cell, prefix);
    requirement.evidenceSource = match[3]!.trim();
  }
};

/** Expands `CP-S01–CP-S03` and `CP-S30, CP-S33` into explicit ids. */
export const expandScenarioCell = (cell: string, prefix: string): string[] => {
  const ids: string[] = [];
  for (const part of cell.split(",")) {
    const range = new RegExp(`${prefix}-S(\\d+)\\s*[–\\-]\\s*${prefix}-S(\\d+)`).exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      for (let n = from; n <= to; n += 1) ids.push(`${prefix}-S${String(n).padStart(2, "0")}`);
      continue;
    }
    const single = new RegExp(`${prefix}-S(\\d+)`).exec(part);
    if (single) ids.push(`${prefix}-S${single[1]!.padStart(2, "0")}`);
  }
  return [...new Set(ids)];
};

/** §39 — every `- **CP-S01:** description` bullet. */
export const parseScenarioCatalogue = (prd: string, prefix: string): Map<string, string> => {
  const catalogue = new Map<string, string>();
  const pattern = new RegExp(`\\*\\*(${prefix}-S\\d+):\\*\\*\\s*(.+)`, "g");
  for (const match of prd.matchAll(pattern)) {
    const id = match[1]!.replace(/-S(\d)$/, "-S0$1");
    catalogue.set(id, match[2]!.trim());
  }
  return catalogue;
};

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (path.endsWith(".test.ts")) out.push(path);
  }
  return out;
};

const scenarioIdsIn = (title: string): string[] =>
  [...title.matchAll(/\b((?:CP|RF)-S\d+)\b/g)].map((match) => match[1]!.replace(/-S(\d)$/, "-S0$1"));

const callBaseName = (expression: ts.Expression): string | null => {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return callBaseName(expression.expression);
  if (ts.isCallExpression(expression)) return callBaseName(expression.expression);
  return null;
};

const stringArgument = (call: ts.CallExpression): string | null => {
  const first = call.arguments[0];
  return first && ts.isStringLiteralLike(first) ? first.text : null;
};

const callbackBody = (call: ts.CallExpression): ts.ConciseBody | null => {
  const callback = call.arguments[1];
  if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return callback.body;
  return null;
};

/**
 * Reads test declarations through the TypeScript AST. A label is associated only with a leaf
 * test's title/body or an enclosing suite, never with file scope. A suite label is inherited only
 * by a leaf test that has no own label; an explicit leaf label always wins.
 */
export const collectExecutableTestDeclarations = (root: string = repoRoot): ExecutableTestDeclaration[] => {
  const declarations: ExecutableTestDeclaration[] = [];

  for (const file of walk(join(root, "tests"))) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const fileName = relative(root, file);

    const visit = (node: ts.Node, ancestors: string[], inheritedScenarioIds: string[]): void => {
      if (ts.isCallExpression(node)) {
        const baseName = callBaseName(node.expression);
        const title = stringArgument(node);
        if (title && baseName === "describe") {
          const body = callbackBody(node);
          if (body) {
            visit(body, [...ancestors, title], [...inheritedScenarioIds, ...scenarioIdsIn(title)]);
          }
          return;
        }
        if (title && (baseName === "it" || baseName === "test")) {
          const body = callbackBody(node);
          const ownScenarioIds = [
            ...new Set([...scenarioIdsIn(title), ...(body ? scenarioIdsIn(body.getFullText(source)) : [])]),
          ];
          declarations.push({
            file: fileName,
            title,
            fullName: [...ancestors, title].join(" "),
            scenarioIds: ownScenarioIds.length > 0 ? ownScenarioIds : inheritedScenarioIds,
          });
          return;
        }
      }
      ts.forEachChild(node, (child) => visit(child, ancestors, inheritedScenarioIds));
    };

    visit(source, [], []);
  }

  return declarations;
};

const normalizeTitle = (title: string): string => title.replace(/\s+/g, " ").trim();

/**
 * The repository-relative spelling of a path that may have been written by a different machine.
 *
 * This used to resolve both sides to absolute paths against the *current* root, which is only
 * correct while the result set and this process were produced on the same filesystem layout. They
 * are not: the JSON comes from the macOS matrix leg as an artifact, so its `name` fields read
 * `/Users/runner/work/...`, and the job consuming them reads `/home/runner/work/...`. Every key
 * then differed and nothing matched — measured as `requirementsWithGaps: 22`, which is every
 * requirement in the PRD, from a suite that had passed.
 *
 * A same-platform version of this job hid it completely. The failure needs two machines to appear
 * and says nothing about the code under test when it does.
 *
 * Matched against the declarations this run found rather than by cutting at a fixed marker: the
 * declarations are the authoritative list of files that can participate, and an absolute path from
 * anywhere either ends with one of them or is not a file this report is about. A path that matches
 * nothing is left alone, so an unmatched entry stays unmatched instead of being folded onto some
 * other file's key.
 */
const repositoryRelative = (file: string, known: ReadonlySet<string>): string => {
  const normalized = file.split(sep).join("/");
  if (known.has(normalized)) return normalized;
  for (const candidate of known) {
    if (normalized.endsWith(`/${candidate}`)) return candidate;
  }
  return normalized;
};

const resultKey = (file: string, fullName: string, known: ReadonlySet<string>): string =>
  `${repositoryRelative(file, known)}\u0000${normalizeTitle(fullName)}`;

/**
 * Returns only the declared scenario tests whose exact Vitest assertion result was `passed`.
 * Failed, skipped, todo, unmatched and suite-only declarations intentionally contribute no
 * coverage.
 */
export const passedScenarioReferences = (
  declarations: readonly ExecutableTestDeclaration[],
  result: VitestJsonReport,
): Map<string, TestReference[]> => {
  // The files this run actually found, which is what an absolute path from another machine is
  // matched back onto. Built before the result set is read, because it is the reference.
  const known = new Set(declarations.map((declaration) => declaration.file.split(sep).join("/")));
  const statuses = new Map<string, Set<string>>();
  for (const testFile of result.testResults) {
    for (const assertion of testFile.assertionResults) {
      const key = resultKey(testFile.name, assertion.fullName, known);
      const values = statuses.get(key) ?? new Set<string>();
      values.add(assertion.status);
      statuses.set(key, values);
    }
  }

  const references = new Map<string, TestReference[]>();
  for (const declaration of declarations) {
    const status = statuses.get(resultKey(declaration.file, declaration.fullName, known));
    if (!status?.has("passed")) continue;
    for (const id of declaration.scenarioIds) {
      const rows = references.get(id) ?? [];
      if (!rows.some((row) => row.file === declaration.file && row.title === declaration.title)) {
        rows.push({ file: declaration.file, title: declaration.title });
      }
      references.set(id, rows);
    }
  }
  return references;
};

/**
 * The commit the counts describe. Falls back to a explicit marker rather than an empty string:
 * "measured at (unknown)" is a readable admission, whereas a blank renders as a sentence that
 * looks complete and says nothing.
 */
const measuredCommit = (): string => {
  // Bounded, and the two outcomes kept apart. Unbounded, a git that never returns made this
  // function never return; bounded but undistinguished, `status !== 0` would have reported a
  // killed probe as "not a git checkout" — a sentence that reads complete and is false (#859).
  // The bound is written out at each call rather than shared through a variable: the operand and
  // subprocess censuses read the options object at the call site, and an options *reference* is
  // invisible to them. A check that cannot see a bound reports the call as unbounded, which is the
  // same failure as not having one (#859).
  const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 10_000 });
  if (head.error !== undefined) return "(unknown — the git probe did not answer)";
  const sha = head.status === 0 ? head.stdout.trim() : "";
  if (!sha) return "(unknown — not a git checkout)";
  const dirty = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8", timeout: 10_000 });
  // A dirty tree matters here: the counts came from working-tree files, so naming only the
  // commit would attribute them to a tree that does not contain what was measured.
  return dirty.status === 0 && dirty.stdout.trim().length > 0 ? `${sha} (working tree modified)` : sha;
};

const NO_EXTERNAL_EVIDENCE: ExternalScenarioEvidence = { repository: "", revision: "", ciRun: "", scenarios: [] };

/** What makes an external entry unusable. Each problem fails the report rather than being skipped. */
const externalEvidenceProblems = (
  external: ExternalScenarioEvidence,
  repoFactoryScenarios: ReadonlyMap<string, string>,
): string[] => {
  if (external.scenarios.length === 0) return [];
  const problems: string[] = [];
  if (!external.repository) problems.push("the external evidence names no repository");
  if (!/^[0-9a-f]{40}$/.test(external.revision)) {
    problems.push(`the external evidence revision is not a full commit SHA: '${external.revision}'`);
  }
  if (!external.ciRun) problems.push("the external evidence names no CI run");
  for (const entry of external.scenarios) {
    if (!repoFactoryScenarios.has(entry.id)) problems.push(`${entry.id} is not a Repo Factory scenario in the PRD`);
    if (entry.tests.length === 0 || entry.tests.some((test) => test.trim() === "")) {
      problems.push(`${entry.id} names no external test id`);
    }
    if (entry.arm !== null && entry.arm.trim() === "") problems.push(`${entry.id} names an empty arm`);
  }
  return problems;
};

/**
 * One judge per scenario. A passed declaration here covers it; an external entry with no arm hands
 * it to the other repository; both at once, or two whole entries, or the same arm twice, is a
 * duplicate. An arm entry hands over only that arm, so it never covers a scenario by itself.
 * `declared` is every scenario a test here declares, passed or not: a failing declaration of an
 * externally judged scenario is still a second judge.
 */
const repoFactoryVerdict = (
  passed: boolean,
  declared: boolean,
  entries: readonly ExternalScenario[],
): RepoFactoryScenarioRow["status"] => {
  const whole = entries.filter((entry) => entry.arm === null).length;
  const arms = entries.filter((entry) => entry.arm !== null).map((entry) => entry.arm);
  if (whole > 1 || (whole === 1 && (declared || arms.length > 0)) || new Set(arms).size !== arms.length) {
    return "DUPLICATE";
  }
  if (whole === 1) return "EXTERNAL";
  return passed ? "DECLARATION_COVERED" : "DECLARATION_MISSING";
};

export interface RepoFactoryJudgementOptions {
  /** Defaults to none, so a caller that supplies nothing gets every unproven scenario reported missing. */
  external?: ExternalScenarioEvidence;
  /** Defaults to the scenarios in `tests`, i.e. those with a passed declaration. */
  declaredScenarioIds?: ReadonlySet<string>;
}

export const buildTraceabilityReport = (
  requirements: Iterable<Requirement>,
  scenarios: Map<string, string>,
  repoFactoryScenarios: Map<string, string>,
  tests: Map<string, TestReference[]>,
  vitest: VitestJsonReport,
  options: RepoFactoryJudgementOptions = {},
): TraceabilityReport => {
  const external = options.external ?? NO_EXTERNAL_EVIDENCE;
  const declaredScenarioIds = options.declaredScenarioIds ?? new Set(tests.keys());
  const requirementRows: RequirementRow[] = [...requirements].map((requirement) => {
    const covered = requirement.scenarios.filter((id) => (tests.get(id) ?? []).length > 0);
    const missing = requirement.scenarios.filter((id) => (tests.get(id) ?? []).length === 0);
    return {
      ...requirement,
      coveredScenarios: covered,
      missingScenarios: missing,
      status:
        requirement.scenarios.length === 0
          ? "NO_SCENARIOS"
          : missing.length === 0
            ? "DECLARATION_COVERED"
            : "DECLARATION_GAP",
    };
  });

  const scenarioRows: ScenarioRow[] = [...scenarios.entries()].map(([id, description]) => ({
    id,
    description,
    tests: tests.get(id) ?? [],
    status: (tests.get(id) ?? []).length > 0 ? "DECLARATION_COVERED" : "DECLARATION_MISSING",
  }));

  const rfScenarioRows: RepoFactoryScenarioRow[] = [...repoFactoryScenarios.entries()].map(([id, description]) => {
    const entries = external.scenarios.filter((entry) => entry.id === id);
    const passed = (tests.get(id) ?? []).length > 0;
    return {
      id,
      description,
      tests: tests.get(id) ?? [],
      status: repoFactoryVerdict(passed, passed || declaredScenarioIds.has(id), entries),
      external: entries.map((entry) => ({
        ...entry,
        repository: external.repository,
        revision: external.revision,
        ciRun: external.ciRun,
        acpUnattendedRun: "NOT_SUPPORTED" as const,
      })),
    };
  });
  const rfIds = (status: RepoFactoryScenarioRow["status"]): string[] =>
    rfScenarioRows.filter((row) => row.status === status).map((row) => row.id);

  return {
    generatedFrom: [
      "docs/prd/AGENT_CONTROL_PLANE_PRD_v1.3_FINAL.md",
      "docs/prd/REPO_FACTORY_CONTROL_PLANE_INTEGRATION_PRD_v1.1_FINAL.md",
    ],
    measuredAt: measuredCommit(),
    testRun: {
      reporter: "vitest-json",
      success: vitest.success,
      total: vitest.numTotalTests,
      passed: vitest.numPassedTests,
      failed: vitest.numFailedTests,
      pending: vitest.numPendingTests,
    },
    summary: {
      requirements: requirementRows.length,
      requirementsWithDeclarationCoverage: requirementRows.filter((row) => row.status === "DECLARATION_COVERED").length,
      requirementsWithGaps: requirementRows.filter((row) => row.status === "DECLARATION_GAP").length,
      scenarios: scenarioRows.length,
      scenariosWithPassedDeclarations: scenarioRows.filter((row) => row.status === "DECLARATION_COVERED").length,
      scenariosMissing: scenarioRows.filter((row) => row.status === "DECLARATION_MISSING").map((row) => row.id),
      repoFactoryScenarios: rfScenarioRows.length,
      repoFactoryScenariosWithPassedDeclarations: rfIds("DECLARATION_COVERED").length,
      repoFactoryScenariosMissing: rfIds("DECLARATION_MISSING"),
      repoFactoryScenariosExternal: rfIds("EXTERNAL"),
      repoFactoryScenariosDuplicated: rfIds("DUPLICATE"),
      repoFactoryExternalEvidenceProblems: externalEvidenceProblems(external, repoFactoryScenarios),
    },
    requirements: requirementRows,
    scenarios: scenarioRows,
    repoFactoryScenarios: rfScenarioRows,
  };
};

/**
 * Repo Factory scenarios count the way CP scenarios do: a missing or failed one fails the report.
 * This used to read only the CP side, so `pnpm trace` exited 0 with 13 of 25 Repo Factory
 * scenarios uncovered, and the exit code was an all-clear nobody could rely on. External
 * scenarios do not fail it, and do not pass it silently either: `main` names them on every run.
 */
export const traceabilityPasses = (report: TraceabilityReport): boolean =>
  report.testRun.success &&
  report.summary.scenariosMissing.length === 0 &&
  report.summary.requirementsWithGaps === 0 &&
  report.summary.repoFactoryScenariosMissing.length === 0 &&
  report.summary.repoFactoryScenariosDuplicated.length === 0 &&
  report.summary.repoFactoryExternalEvidenceProblems.length === 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const numberValue = (value: unknown, field: string): number => {
  if (typeof value !== "number") throw new Error(`Vitest JSON report has no numeric ${field}`);
  return value;
};

const stringValue = (value: unknown, field: string): string => {
  if (typeof value !== "string") throw new Error(`Vitest JSON report has no string ${field}`);
  return value;
};

export const parseVitestJsonReport = (text: string): VitestJsonReport => {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || typeof parsed.success !== "boolean" || !Array.isArray(parsed.testResults)) {
    throw new Error("Vitest JSON report has an unsupported shape");
  }

  const testResults = parsed.testResults.map((entry, index) => {
    if (!isRecord(entry) || !Array.isArray(entry.assertionResults)) {
      throw new Error(`Vitest JSON report has no assertionResults for test file ${index}`);
    }
    return {
      name: stringValue(entry.name, `testResults[${index}].name`),
      assertionResults: entry.assertionResults.map((assertion, assertionIndex) => {
        if (!isRecord(assertion)) {
          throw new Error(`Vitest JSON report has an invalid assertion at ${index}:${assertionIndex}`);
        }
        return {
          fullName: stringValue(assertion.fullName, `assertionResults[${index}:${assertionIndex}].fullName`),
          status: stringValue(assertion.status, `assertionResults[${index}:${assertionIndex}].status`),
        };
      }),
    };
  });

  return {
    success: parsed.success,
    numTotalTests: numberValue(parsed.numTotalTests, "numTotalTests"),
    numPassedTests: numberValue(parsed.numPassedTests, "numPassedTests"),
    numFailedTests: numberValue(parsed.numFailedTests, "numFailedTests"),
    numPendingTests: numberValue(parsed.numPendingTests, "numPendingTests"),
    testResults,
  };
};

/**
 * The current Vitest JSON result set.
 *
 * Prefers a result file the caller already produced (`ACP_VITEST_RESULTS`). CI runs the whole
 * suite once for the test gate and then ran it a second time here purely to obtain a JSON
 * reporter pass — two full runs of a suite that starts real sandboxed child processes, whose
 * second run failed on the runner while the first passed. Reusing the first run's output is
 * both cheaper and the only way the traceability report describes the same execution the
 * gate actually judged.
 *
 * Falling back to running Vitest keeps `pnpm trace` usable on its own.
 */
const runVitestJson = (root: string): VitestJsonReport => {
  const supplied = process.env["ACP_VITEST_RESULTS"];
  if (supplied) {
    const suppliedPath = isAbsolute(supplied) ? supplied : join(root, supplied);
    if (!existsSync(suppliedPath)) {
      throw new Error(`ACP_VITEST_RESULTS points at a missing file: ${suppliedPath}`);
    }
    return parseVitestJsonReport(readFileSync(suppliedPath, "utf8"));
  }

  // Refused rather than substituted. `a9c8c56a` already ruled on the shape this fallback has:
  // *"it was a duplicate execution, and the fix is to not run it twice"* — and the record beside
  // it says what a trace is for, *"traceability now describes the run the gate judged, so a
  // supplied result set must come from the same commit"*. A suite this tool starts for itself is
  // by definition not the run any gate judged, so the report it produced was a claim about an
  // execution nobody looked at, dressed as coverage.
  //
  // It also pinned this tool to Darwin. The fallback starts the whole suite, and that suite reads
  // `lsof`, launchd and peer credentials through a Darwin-only addon (#539), so a job running
  // `pnpm trace` had to be on `macos-15` for a path CI arranges never to take. The CI workflow
  // recorded that cost and the condition for lifting it in as many words: the move "waits until
  // the fallback is removed or explicitly refused, as its own change." This is that change.
  //
  // The refusal names the command, because a refusal a reader cannot act on is just a failure.
  throw new Error(
    "pnpm trace needs a result set and will not produce one by starting a second suite run: a run " +
      "this tool starts is not the run any gate judged. Supply ACP_VITEST_RESULTS, e.g.\n" +
      "  pnpm vitest run --reporter=json --outputFile=evidence/local/ci-vitest-results.json\n" +
      "  ACP_VITEST_RESULTS=evidence/local/ci-vitest-results.json pnpm trace",
  );
};

const markdownReport = (report: TraceabilityReport): string => [
  "# Requirement declaration traceability",
  "",
  "Generated from the vendored SSOT PRDs. This report measures declaration coverage only: a",
  "scenario label resolves to an executable Vitest leaf that appears with status `passed` in",
  "the JSON-reporter result set named below. Behavioural coverage and production-entry-point",
  "coverage are not measured, so this report is not proof that a requirement is met in the",
  "running system.",
  "",
  `Measured at \`${report.measuredAt}\`: the declarations are read from that tree, and the statuses`,
  "come from the Vitest result set supplied through `ACP_VITEST_RESULTS`, which has to be from a run",
  "of that same tree. CI does not run `pnpm trace`, so the copy committed to the repository changes",
  "only when someone regenerates and commits it. A reader comparing this file against a later tree",
  "should re-run it rather than trust the counts.",
  "",
  `- Vitest result set: ${report.testRun.passed}/${report.testRun.total} passed; ${report.testRun.failed} failed; ${report.testRun.pending} pending`,
  `- Requirements: ${report.summary.requirements} (declaration coverage ${report.summary.requirementsWithDeclarationCoverage}, gaps ${report.summary.requirementsWithGaps})`,
  `- Scenarios: ${report.summary.scenarios} (passed declarations ${report.summary.scenariosWithPassedDeclarations})`,
  report.summary.scenariosMissing.length > 0
    ? `- Missing scenarios: ${report.summary.scenariosMissing.join(", ")}`
    : "- Missing scenarios: none",
  `- Repo Factory scenarios: ${report.summary.repoFactoryScenarios} (passed declarations ${report.summary.repoFactoryScenariosWithPassedDeclarations}, external ${report.summary.repoFactoryScenariosExternal.length}, missing ${report.summary.repoFactoryScenariosMissing.length}, duplicated ${report.summary.repoFactoryScenariosDuplicated.length})`,
  report.summary.repoFactoryScenariosMissing.length > 0
    ? `- Missing Repo Factory scenarios: ${report.summary.repoFactoryScenariosMissing.join(", ")}`
    : "- Missing Repo Factory scenarios: none",
  report.summary.repoFactoryScenariosExternal.length > 0
    ? `- External Repo Factory scenarios, judged by another repository's tests and not verified by this result set: ${report.summary.repoFactoryScenariosExternal.join(", ")}`
    : "- External Repo Factory scenarios: none",
  ...(report.summary.repoFactoryScenariosDuplicated.length > 0
    ? [`- Duplicated Repo Factory scenarios: ${report.summary.repoFactoryScenariosDuplicated.join(", ")}`]
    : []),
  ...report.summary.repoFactoryExternalEvidenceProblems.map((problem) => `- External evidence problem: ${problem}`),
  "",
  "| Requirement | Blocking | Declared scenarios | Declaration status |",
  "|---|---|---|---|",
  ...report.requirements.map(
    (row) =>
      `| ${row.id} | ${row.blocking} | ${row.scenarios.join(", ") || "—"} | ${row.status}${
        row.missingScenarios.length > 0 ? ` (missing ${row.missingScenarios.join(", ")})` : ""
      } |`,
  ),
  "",
  "| Scenario | Declaration status | Passed executable test declarations |",
  "|---|---|---|",
  ...report.scenarios.map(
    (row) =>
      `| ${row.id} | ${row.status} | ${row.tests.map((test) => `${test.file} › ${test.title}`).join("<br>") || "—"} |`,
  ),
  "",
  "A Repo Factory scenario is judged here by a passed declaration, or by another repository's tests",
  "when it is listed in `REPO_FACTORY_EXTERNAL_EVIDENCE` (`src/tools/traceability.ts`). An EXTERNAL",
  "row is a pointer to that repository's run, which this report does not read, and it is not",
  "counted as passed. The last column is recorded with the entry, not measured: `—` means nothing",
  "is recorded as unsupported, and this report does not measure the unattended run either way.",
  "",
  "| Repo Factory scenario | Verdict | Passed executable test declarations | Judged by another repository | Not supported by the ACP unattended run |",
  "|---|---|---|---|---|",
  ...report.repoFactoryScenarios.map((row) => {
    const externally = row.external
      .map(
        (entry) =>
          `${entry.arm === null ? "" : `${entry.arm} arm: `}${entry.repository}@${entry.revision.slice(0, 12)} ` +
          `(CI run ${entry.ciRun}): ${entry.tests.join(", ")}${entry.limit ? ` (limit: ${entry.limit})` : ""}`,
      )
      .join("<br>");
    const unsupported = row.external.map((entry) => entry.arm ?? "whole scenario").join(", ");
    return `| ${row.id} | ${row.status} | ${row.tests.map((test) => `${test.file} › ${test.title}`).join("<br>") || "—"} | ${externally || "—"} | ${unsupported || "—"} |`;
  }),
].join("\n");

export interface TraceabilityMainOptions {
  root?: string;
  vitest?: VitestJsonReport;
  writeEvidence?: boolean;
  emitOutput?: boolean;
  /** Defaults to `REPO_FACTORY_EXTERNAL_EVIDENCE`. */
  external?: ExternalScenarioEvidence;
}

export interface TraceabilityMainResult {
  report: TraceabilityReport;
  exitCode: 0 | 1;
}

export const main = (options: TraceabilityMainOptions = {}): TraceabilityMainResult => {
  const root = options.root ?? repoRoot;
  const acpPrd = readPrd(root, "AGENT_CONTROL_PLANE_PRD_v1.3_FINAL.md");
  const rfPrd = readPrd(root, "REPO_FACTORY_CONTROL_PLANE_INTEGRATION_PRD_v1.1_FINAL.md");
  const requirements = parseRequirements(acpPrd, "CP");
  attachScenarios(acpPrd, requirements, "CP");
  const scenarios = parseScenarioCatalogue(acpPrd, "CP");
  const rfScenarios = parseScenarioCatalogue(rfPrd, "RF");
  const vitest = options.vitest ?? runVitestJson(root);
  const declarations = collectExecutableTestDeclarations(root);
  const tests = passedScenarioReferences(declarations, vitest);
  const report = buildTraceabilityReport(requirements.values(), scenarios, rfScenarios, tests, vitest, {
    external: options.external ?? REPO_FACTORY_EXTERNAL_EVIDENCE,
    declaredScenarioIds: new Set(declarations.flatMap((declaration) => declaration.scenarioIds)),
  });

  if (options.writeEvidence ?? true) {
    mkdirSync(join(root, "evidence"), { recursive: true });
    writeFileSync(join(root, "evidence", "traceability.json"), JSON.stringify(report, null, 2));
    writeFileSync(join(root, "evidence", "traceability.md"), markdownReport(report));
  }

  const passes = traceabilityPasses(report);
  if (options.emitOutput ?? true) {
    process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
    // Every run, passing or not: an external scenario that only appeared inside the JSON would
    // pass silently, which is the thing it must never do.
    const external = report.summary.repoFactoryScenariosExternal;
    if (external.length > 0) {
      process.stderr.write(
        `${external.length} Repo Factory scenarios are EXTERNAL, judged by another repository's tests that ` +
          `this result set does not contain: ${external.join(", ")}\n`,
      );
    }
    if (!passes) {
      process.stderr.write(
        report.testRun.success
          ? "traceability declaration gaps present; behavioural coverage is not measured\n"
          : "Vitest result set contains failures; declaration traceability cannot claim a passing suite\n",
      );
      const { repoFactoryScenariosMissing: missing, repoFactoryScenariosDuplicated: duplicated } = report.summary;
      if (missing.length > 0) process.stderr.write(`Repo Factory scenarios missing: ${missing.join(", ")}\n`);
      if (duplicated.length > 0) {
        process.stderr.write(`Repo Factory scenarios with more than one judge: ${duplicated.join(", ")}\n`);
      }
      for (const problem of report.summary.repoFactoryExternalEvidenceProblems) {
        process.stderr.write(`external evidence: ${problem}\n`);
      }
    }
  }
  return { report, exitCode: passes ? 0 : 1 };
};

/**
 * Whether this module is the process entrypoint, not merely importable from one.
 *
 * `import.meta.url` is always the realpath Node resolved the module through, but
 * `process.argv[1]` is whatever path the caller passed — including a symlink, such as
 * `<state root>/current` (#1052). `resolve()` only normalizes a path; it does not follow
 * symlinks, so comparing it against the realpath never matched through that link. Resolving both
 * sides with `realpathSync` keeps the check correct across symlinks; a path that cannot be
 * resolved (missing, unreadable, a dangling link) is treated as "not main" rather than thrown.
 */
const isMain = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (isMain()) process.exitCode = main().exitCode;
