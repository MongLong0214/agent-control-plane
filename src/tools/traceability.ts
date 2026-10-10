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

/** One part of a scenario, declared as `RF-S14 arm:issue`. */
export interface ScenarioArm {
  id: string;
  arm: string;
}

export interface ExecutableTestDeclaration extends TestReference {
  fullName: string;
  /** Scenarios this leaf claims whole. */
  scenarioIds: string[];
  /** Parts of scenarios this leaf witnesses. An arm never covers its scenario by itself. */
  scenarioArms?: ScenarioArm[];
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

/** One Repo Factory scenario whose tests live in another repository. */
export interface ExternalScenario {
  readonly id: string;
  /** This scenario's own evidence commit, when it is not the evidence's default `revision`. */
  readonly revision?: string;
  /** The CI run that judged this scenario's own `revision`. Required whenever `revision` is given. */
  readonly ciRun?: string;
  /** The other repository's own test ids (pytest node ids), as its CI runs them. */
  readonly tests: readonly string[];
  /** What the external evidence does not show, stated beside it rather than left out. */
  readonly limit?: string;
}

export interface ExternalScenarioEvidence {
  readonly repository: string;
  /** The exact commit the listed tests are the evidence at, unless a scenario names its own. */
  readonly revision: string;
  /** The CI run that judged that commit. */
  readonly ciRun: string;
  readonly scenarios: readonly ExternalScenario[];
}

/** An external entry as one report row carries it, with the revision and CI run that apply to it. */
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
 * CI, runs no lean review, computes no PlanCore digest, has no CommitLore step and cannot apply
 * across two repositories. These scenarios therefore cannot run in this repository, and ACP's
 * unattended bootstrap run does not support them. Their ownership was assigned to repo-factory;
 * this constant is where that assignment is written down, and the one thing to change if it moves.
 *
 * What the report does with an entry:
 * - the scenario is EXTERNAL. It is listed with these test ids, the revision and the CI run, and
 *   it is never counted as a passed declaration. This tool cannot read that run, so an entry
 *   points at evidence; it is not evidence.
 * - an arm label here for the same scenario (RF-S16's single-repository retries) is reported in
 *   the row and covers nothing; the entry stays the scenario's only judge.
 * - a scenario that is listed and also covered here, by a whole label or a complete set of arms,
 *   or listed twice, is DUPLICATE and fails. Each scenario has exactly one judge.
 *
 * Entries stay at the revision their ids were measured at. A scenario whose evidence moved names
 * its own revision and CI run; the rest use the default, which is older than repo-factory's main.
 *
 * repo-factory's CI step (`pytest tests/ -q`) keeps no per-test result, only its summary line:
 * `852 passed, 3 skipped` at 309e2e6b47, `880 passed, 3 skipped` at f1380fd2e4 and
 * `889 passed, 3 skipped` at 41b61b0d1c. Each listed id was seen to pass in a junit run of its
 * own revision; the CI run shows that the suite as a whole passed there.
 */
export const REPO_FACTORY_EXTERNAL_EVIDENCE: ExternalScenarioEvidence = {
  repository: "MongLong0214/repo-factory",
  revision: "309e2e6b47b0bc35db0147cb5fe5c132580653d7",
  ciRun: "36937509727",
  scenarios: [
    {
      id: "RF-S02",
      tests: ["tests/test_slice1_plan.py::test_simple_materializes_no_formal_documents_without_optional_requests"],
    },
    {
      id: "RF-S03",
      revision: "f1380fd2e47c9c359c16ee8e1ce96a04d294d049",
      ciRun: "38026327764",
      tests: [
        "tests/test_slice1_plan.py::test_standard_lean_revision_preserves_product_scope_and_required_artifacts",
        "tests/test_slice1_plan.py::test_lean_accept_without_removals_preserves_the_plan",
        "tests/test_slice1_plan.py::test_lean_review_refuses_product_scope_and_required_artifact_removal",
        "tests/test_slice1_plan.py::test_lean_decision_refuses_planning",
        "tests/test_slice1_plan.py::test_lean_review_refuses_unrequested_optional_and_contradictory_verdicts",
        "tests/test_slice1_plan.py::test_lean_review_schema_requires_a_reason",
        "tests/test_slice1_plan.py::test_lean_review_refuses_duplicate_removal_items",
        "tests/test_slice1_plan.py::test_lean_review_cli_emits_applied_review_outside_strict_plan",
        "tests/test_slice1_plan.py::test_a_verdict_that_does_not_account_for_every_requested_option_is_refused",
        "tests/test_slice1_plan.py::test_the_plan_command_refuses_a_request_that_skipped_the_lean_review",
        "tests/test_slice1_plan.py::test_simple_reaches_the_plan_without_a_lean_review",
        "tests/test_slice1_plan.py::test_the_plan_command_refuses_a_verdict_that_blocks",
        "tests/test_lean_review.py::test_the_generated_revision_cuts_what_nothing_consumes_and_keeps_scope",
        "tests/test_lean_review.py::test_an_already_lean_spec_gets_a_pass_verdict_and_an_unchanged_plan",
        "tests/test_lean_review.py::test_a_cut_into_scope_is_generated_as_a_ceo_decision_and_stops_the_plan",
        "tests/test_lean_review.py::test_the_generator_refuses_a_verdict_the_plan_would_refuse",
      ],
    },
    {
      id: "RF-S04",
      tests: ["tests/test_slice1_plan.py::test_rf_s04_a_different_timestamp_is_the_same_plan"],
    },
    {
      id: "RF-S08",
      revision: "41b61b0d1cab9c10fa92378bb5ff3b0904a7d897",
      ciRun: "38027660325",
      tests: [
        "tests/test_node_install_witness.py::test_the_fixture_dependency_is_the_source_beside_it_and_the_lock_pins_its_bytes",
        "tests/test_node_install_witness.py::test_the_rendered_steps_install_the_pinned_dependency_and_run_it",
        "tests/test_node_install_witness.py::test_a_failed_install_is_not_followed_by_steps_that_count_as_success",
        "tests/test_node_install_witness.py::test_a_configured_runtime_list_with_an_unusable_entry_fails_instead_of_skipping",
        "tests/test_node_install_witness.py::test_a_usable_runtime_list_runs_every_execution_witness_on_every_runtime",
        "tests/test_slice2_stack_ci.py::test_node_workflow_installs_dependencies_on_both_declared_runtimes",
      ],
      limit:
        "the install witness is a local, offline install from a file: tarball, not GitHub Actions " +
        "setup-node. CI does not set RF_S08_NODE_BIN_DIRS, so it runs the witness on one runtime, " +
        "Node 22 (the declared latest); the declared lower runtime, Node 20, is checked only in the " +
        "rendered workflow. The 2026-08-19 run 32256790243 survives only as residual JSON: it " +
        "answers 404 and cannot be verified remotely",
    },
    {
      id: "RF-S16",
      tests: [
        "tests/test_slice3_apply.py::test_a_partial_apply_reports_what_completed_rather_than_claiming_atomicity",
        "tests/test_slice3_apply.py::test_resume_after_a_partial_apply_starts_from_the_verified_receipt",
      ],
    },
    {
      id: "RF-S19",
      tests: ["tests/test_publish.py::test_simple_missing_commitlore_warns_and_continues_with_a_receipt"],
    },
    {
      id: "RF-S20",
      tests: ["tests/test_publish.py::test_standard_missing_commitlore_refuses_before_push_for_revision"],
    },
    {
      id: "RF-S21",
      tests: ["tests/test_publish.py::test_guarded_missing_commitlore_refuses_before_push_as_blocking"],
    },
  ],
};

/**
 * The arms a Repo Factory scenario is made of, where its PRD text names parts that no single test
 * here covers at once. A label `RF-Sxx arm:<name>` witnesses one of them. A scenario is covered by
 * a passed whole-scenario label, or by a passed label for every arm listed here; any other arm
 * evidence is reported and covers nothing. An arm label whose name is not listed for its scenario
 * fails the report, so a misspelt arm cannot quietly stand in for a missing one.
 */
export const REPO_FACTORY_SCENARIO_ARMS: Readonly<Record<string, readonly string[]>> = {
  // Absolute path, session id, provider id, channel id.
  "RF-S05": ["absolute-path", "session", "provider", "channel"],
  // Re-read after creating a repository, a branch, an issue.
  "RF-S14": ["repository", "branch", "issue"],
  // RepoFactoryResult carries no CTO/Doctor fields; ACPActivationResult supplies them.
  "RF-S17": ["result", "activation"],
  // A candidate weakening the validator, the workflow or the manifest keeps the old contract.
  "RF-S22": ["manifest", "workflow", "validator"],
  // Public exposure is bound to the approval, and that approval is the Owner's, not Hermes'.
  "RF-S25": ["visibility", "owner-authority"],
};

interface RepoFactoryScenarioRow {
  id: string;
  description: string;
  /** Passed whole-scenario declarations in this repository's result set. */
  tests: TestReference[];
  /** Passed arm declarations here, by arm. */
  arms: Array<{ arm: string; tests: TestReference[] }>;
  /** Arms listed for this scenario with no passed declaration. */
  missingArms: string[];
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
    /** An arm label or arm list this report cannot use as written: these fail. */
    repoFactoryArmProblems: string[];
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

const normalizeScenarioId = (id: string): string => id.replace(/-S(\d)$/, "-S0$1");

/**
 * Whole-scenario labels. An id written in arm form (`RF-S16 arm:single-repository`) is not one:
 * a comment saying "this is one arm" used to count as the whole scenario, because a bare id was
 * all this looked for, and the qualifier around it had no effect.
 */
const scenarioIdsIn = (text: string): string[] =>
  [...text.matchAll(/\b((?:CP|RF)-S\d+)\b(?!\s+arm:)/g)].map((match) => normalizeScenarioId(match[1]!));

const scenarioArmsIn = (text: string): ScenarioArm[] =>
  [...text.matchAll(/\b((?:CP|RF)-S\d+)\s+arm:([a-z0-9]+(?:-[a-z0-9]+)*)/g)].map((match) => ({
    id: normalizeScenarioId(match[1]!),
    arm: match[2]!,
  }));

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
 *
 * Arm labels are read on leaves only. A leaf's arm label for a scenario also narrows any bare
 * mention of that same scenario on the leaf, inherited or its own, so a title that names the
 * scenario and a body that says which arm it is read as the arm.
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
          const text = [title, body ? body.getFullText(source) : ""];
          const ownScenarioIds = [...new Set(text.flatMap(scenarioIdsIn))];
          const scenarioArms = [
            ...new Map(text.flatMap(scenarioArmsIn).map((arm) => [`${arm.id}\u0000${arm.arm}`, arm])).values(),
          ];
          const narrowed = new Set(scenarioArms.map((arm) => arm.id));
          declarations.push({
            file: fileName,
            title,
            fullName: [...ancestors, title].join(" "),
            scenarioIds: (ownScenarioIds.length > 0 ? ownScenarioIds : inheritedScenarioIds).filter(
              (id) => !narrowed.has(id),
            ),
            scenarioArms,
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
const passedDeclarations = (
  declarations: readonly ExecutableTestDeclaration[],
  result: VitestJsonReport,
): ExecutableTestDeclaration[] => {
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

  return declarations.filter((declaration) =>
    statuses.get(resultKey(declaration.file, declaration.fullName, known))?.has("passed"),
  );
};

const addReference = (rows: TestReference[], declaration: ExecutableTestDeclaration): TestReference[] => {
  if (!rows.some((row) => row.file === declaration.file && row.title === declaration.title)) {
    rows.push({ file: declaration.file, title: declaration.title });
  }
  return rows;
};

export const passedScenarioReferences = (
  declarations: readonly ExecutableTestDeclaration[],
  result: VitestJsonReport,
): Map<string, TestReference[]> => {
  const references = new Map<string, TestReference[]>();
  for (const declaration of passedDeclarations(declarations, result)) {
    for (const id of declaration.scenarioIds) references.set(id, addReference(references.get(id) ?? [], declaration));
  }
  return references;
};

/** Passed arm declarations, by scenario and then by arm. Matched exactly as whole labels are. */
export const passedScenarioArmReferences = (
  declarations: readonly ExecutableTestDeclaration[],
  result: VitestJsonReport,
): Map<string, Map<string, TestReference[]>> => {
  const references = new Map<string, Map<string, TestReference[]>>();
  for (const declaration of passedDeclarations(declarations, result)) {
    for (const { id, arm } of declaration.scenarioArms ?? []) {
      const arms = references.get(id) ?? new Map<string, TestReference[]>();
      arms.set(arm, addReference(arms.get(arm) ?? [], declaration));
      references.set(id, arms);
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

/** The revision and CI run an entry's tests are evidence at: its own, or the evidence's default. */
const evidenceAt = (
  external: ExternalScenarioEvidence,
  entry: ExternalScenario,
): { revision: string; ciRun: string } => ({
  revision: entry.revision ?? external.revision,
  ciRun: entry.ciRun ?? external.ciRun,
});

/** What makes an external entry unusable. Each problem fails the report rather than being skipped. */
const externalEvidenceProblems = (
  external: ExternalScenarioEvidence,
  repoFactoryScenarios: ReadonlyMap<string, string>,
): string[] => {
  if (external.scenarios.length === 0) return [];
  const problems: string[] = [];
  if (!external.repository) problems.push("the external evidence names no repository");
  for (const entry of external.scenarios) {
    const { revision, ciRun } = evidenceAt(external, entry);
    if (!/^[0-9a-f]{40}$/.test(revision)) {
      problems.push(`${entry.id}: the external evidence revision is not a full commit SHA: '${revision}'`);
    }
    if (!ciRun) problems.push(`${entry.id}: the external evidence names no CI run`);
    // A revision of its own with the default's CI run would credit one commit with another's run.
    if (entry.revision !== undefined && entry.ciRun === undefined) {
      problems.push(`${entry.id} names its own revision but not the CI run that judged it`);
    }
    if (!repoFactoryScenarios.has(entry.id)) problems.push(`${entry.id} is not a Repo Factory scenario in the PRD`);
    if (entry.tests.length === 0 || entry.tests.some((test) => test.trim() === "")) {
      problems.push(`${entry.id} names no external test id`);
    }
  }
  return problems;
};

/** What makes an arm label or an arm list unusable. Each problem fails the report. */
const armProblems = (
  declarations: readonly ExecutableTestDeclaration[],
  requiredArms: Readonly<Record<string, readonly string[]>>,
  repoFactoryScenarios: ReadonlyMap<string, string>,
): string[] => {
  const problems: string[] = [];
  for (const [id, arms] of Object.entries(requiredArms)) {
    if (!repoFactoryScenarios.has(id)) problems.push(`arms are listed for ${id}, which is not a Repo Factory scenario in the PRD`);
    if (arms.length < 2) problems.push(`${id} lists ${arms.length} arm(s); a scenario of one part is labelled whole`);
    if (new Set(arms).size !== arms.length) problems.push(`${id} lists the same arm twice`);
  }
  for (const declaration of declarations) {
    for (const { id, arm } of declaration.scenarioArms ?? []) {
      const listed = requiredArms[id];
      if (listed && !listed.includes(arm)) {
        problems.push(
          `${declaration.file} › ${declaration.title}: ${id} arm '${arm}' is not one of ${listed.join(", ")}`,
        );
      }
    }
  }
  return problems;
};

/**
 * One judge per scenario. A passed whole-scenario declaration here covers it, and so does a passed
 * declaration for every arm listed for it; an external entry hands it to the other repository.
 * An external entry together with either of those, or two external entries, is a duplicate.
 * `declared` is every scenario a test here labels whole, passed or not: a failing declaration of
 * an externally judged scenario is still a second judge. Arm evidence that does not complete a
 * listed set is reported and decides nothing.
 */
const repoFactoryVerdict = (
  passed: boolean,
  declared: boolean,
  armsComplete: boolean,
  entries: readonly ExternalScenario[],
): RepoFactoryScenarioRow["status"] => {
  if (entries.length > 1 || (entries.length === 1 && (declared || armsComplete))) return "DUPLICATE";
  if (entries.length === 1) return "EXTERNAL";
  return passed || armsComplete ? "DECLARATION_COVERED" : "DECLARATION_MISSING";
};

export interface RepoFactoryJudgementOptions {
  /** Defaults to none, so a caller that supplies nothing gets every unproven scenario reported missing. */
  external?: ExternalScenarioEvidence;
  /**
   * Every declaration the tree holds, passed or not. Defaults to none: the whole-scenario labels
   * are then taken from `tests`, i.e. those with a passed declaration.
   */
  declarations?: readonly ExecutableTestDeclaration[];
  /** Passed arm declarations, from `passedScenarioArmReferences`. Defaults to none. */
  armTests?: ReadonlyMap<string, ReadonlyMap<string, TestReference[]>>;
  /** Defaults to none, so no scenario can be covered by arms unless its arms are listed. */
  requiredArms?: Readonly<Record<string, readonly string[]>>;
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
  const declaredScenarioIds = options.declarations
    ? new Set(options.declarations.flatMap((declaration) => declaration.scenarioIds))
    : new Set(tests.keys());
  const armTests = options.armTests ?? new Map<string, Map<string, TestReference[]>>();
  const requiredArms = options.requiredArms ?? {};
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
    const passedArms = armTests.get(id) ?? new Map<string, TestReference[]>();
    const listed = requiredArms[id] ?? [];
    const missingArms = listed.filter((arm) => (passedArms.get(arm) ?? []).length === 0);
    const armsComplete = listed.length > 0 && missingArms.length === 0;
    return {
      id,
      description,
      tests: tests.get(id) ?? [],
      arms: [...passedArms.entries()].map(([arm, armReferences]) => ({ arm, tests: armReferences })),
      missingArms,
      status: repoFactoryVerdict(passed, passed || declaredScenarioIds.has(id), armsComplete, entries),
      external: entries.map((entry) => ({
        ...entry,
        repository: external.repository,
        ...evidenceAt(external, entry),
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
      repoFactoryArmProblems: armProblems(options.declarations ?? [], requiredArms, repoFactoryScenarios),
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
  report.summary.repoFactoryExternalEvidenceProblems.length === 0 &&
  report.summary.repoFactoryArmProblems.length === 0;

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
  ...report.summary.repoFactoryArmProblems.map((problem) => `- Arm label problem: ${problem}`),
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
  "A Repo Factory scenario is covered here by a passed whole-scenario declaration, or by a passed",
  "declaration for every arm `REPO_FACTORY_SCENARIO_ARMS` lists for it. An arm label",
  "(`RF-Sxx arm:<name>`) witnesses one part and never covers the scenario by itself. A scenario",
  "listed in `REPO_FACTORY_EXTERNAL_EVIDENCE` is EXTERNAL: the row points at that repository's run,",
  "which this report does not read, and it is not counted as passed. The last column is recorded",
  "with the external entry, not measured: `—` means nothing is recorded as unsupported, and this",
  "report does not measure the unattended run either way.",
  "",
  "| Repo Factory scenario | Verdict | Passed whole-scenario declarations | Passed arm declarations | Arms with no passed declaration | Judged by another repository | Not supported by the ACP unattended run |",
  "|---|---|---|---|---|---|---|",
  ...report.repoFactoryScenarios.map((row) => {
    const references = (tests: TestReference[]) => tests.map((test) => `${test.file} › ${test.title}`);
    const arms = row.arms.flatMap(({ arm, tests }) => references(tests).map((reference) => `${arm}: ${reference}`));
    const externally = row.external
      .map(
        (entry) =>
          `${entry.repository}@${entry.revision.slice(0, 12)} (CI run ${entry.ciRun}): ${entry.tests.join(", ")}` +
          `${entry.limit ? ` (limit: ${entry.limit})` : ""}`,
      )
      .join("<br>");
    const cells = [
      row.id,
      row.status,
      references(row.tests).join("<br>") || "—",
      arms.join("<br>") || "—",
      row.missingArms.join(", ") || "—",
      externally || "—",
      row.external.length > 0 ? "whole scenario" : "—",
    ];
    return `| ${cells.join(" | ")} |`;
  }),
].join("\n");

export interface TraceabilityMainOptions {
  root?: string;
  vitest?: VitestJsonReport;
  writeEvidence?: boolean;
  emitOutput?: boolean;
  /** Defaults to `REPO_FACTORY_EXTERNAL_EVIDENCE`. */
  external?: ExternalScenarioEvidence;
  /** Defaults to `REPO_FACTORY_SCENARIO_ARMS`. */
  requiredArms?: Readonly<Record<string, readonly string[]>>;
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
    declarations,
    armTests: passedScenarioArmReferences(declarations, vitest),
    requiredArms: options.requiredArms ?? REPO_FACTORY_SCENARIO_ARMS,
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
      for (const problem of report.summary.repoFactoryArmProblems) process.stderr.write(`arm label: ${problem}\n`);
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
