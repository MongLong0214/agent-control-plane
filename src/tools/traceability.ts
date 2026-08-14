#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
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

export interface TraceabilityReport {
  generatedFrom: string[];
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
    repoFactoryScenariosTouched: number;
  };
  requirements: RequirementRow[];
  scenarios: ScenarioRow[];
  repoFactoryScenariosTouched: ScenarioRow[];
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

const resultKey = (file: string, fullName: string, root: string): string => {
  const resolvedFile = isAbsolute(file) ? resolve(file) : resolve(root, file);
  return `${resolvedFile}\u0000${normalizeTitle(fullName)}`;
};

/**
 * Returns only the declared scenario tests whose exact Vitest assertion result was `passed`.
 * Failed, skipped, todo, unmatched and suite-only declarations intentionally contribute no
 * coverage.
 */
export const passedScenarioReferences = (
  declarations: readonly ExecutableTestDeclaration[],
  result: VitestJsonReport,
  root: string = repoRoot,
): Map<string, TestReference[]> => {
  const statuses = new Map<string, Set<string>>();
  for (const testFile of result.testResults) {
    for (const assertion of testFile.assertionResults) {
      const key = resultKey(testFile.name, assertion.fullName, root);
      const values = statuses.get(key) ?? new Set<string>();
      values.add(assertion.status);
      statuses.set(key, values);
    }
  }

  const references = new Map<string, TestReference[]>();
  for (const declaration of declarations) {
    const status = statuses.get(resultKey(declaration.file, declaration.fullName, root));
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

export const buildTraceabilityReport = (
  requirements: Iterable<Requirement>,
  scenarios: Map<string, string>,
  repoFactoryScenarios: Map<string, string>,
  tests: Map<string, TestReference[]>,
  vitest: VitestJsonReport,
): TraceabilityReport => {
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

  const rfScenarioRows: ScenarioRow[] = [...repoFactoryScenarios.entries()]
    .filter(([id]) => (tests.get(id) ?? []).length > 0)
    .map(([id, description]) => ({
      id,
      description,
      tests: tests.get(id) ?? [],
      status: "DECLARATION_COVERED",
    }));

  return {
    generatedFrom: [
      "docs/prd/AGENT_CONTROL_PLANE_PRD_v1.3_FINAL.md",
      "docs/prd/REPO_FACTORY_CONTROL_PLANE_INTEGRATION_PRD_v1.1_FINAL.md",
    ],
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
      repoFactoryScenariosTouched: rfScenarioRows.length,
    },
    requirements: requirementRows,
    scenarios: scenarioRows,
    repoFactoryScenariosTouched: rfScenarioRows,
  };
};

export const traceabilityPasses = (report: TraceabilityReport): boolean =>
  report.testRun.success &&
  report.summary.scenariosMissing.length === 0 &&
  report.summary.requirementsWithGaps === 0;

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

  const evidenceDir = join(root, "evidence", "local");
  const outputPath = join(evidenceDir, `traceability-vitest-${process.pid}.json`);
  const vitestEntrypoint = join(root, "node_modules", "vitest", "vitest.mjs");
  if (!existsSync(vitestEntrypoint)) {
    throw new Error("Vitest is not installed; run pnpm install before pnpm trace");
  }

  mkdirSync(evidenceDir, { recursive: true });
  const result = spawnSync(
    process.execPath,
    [vitestEntrypoint, "run", "--reporter=json", `--outputFile=${outputPath}`],
    { cwd: root, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (!existsSync(outputPath)) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`Vitest JSON reporter did not produce a result set${details ? `: ${details}` : ""}`);
  }
  return parseVitestJsonReport(readFileSync(outputPath, "utf8"));
};

const markdownReport = (report: TraceabilityReport): string => [
  "# Requirement declaration traceability",
  "",
  "Generated from the vendored SSOT PRDs. This report measures declaration coverage only: a",
  "scenario label resolves to an executable Vitest leaf that appears with status `passed` in",
  "this fresh JSON-reporter result set. Behavioural coverage and production-entry-point coverage",
  "are not measured, so this report is not proof that a requirement is met in the running system.",
  "",
  `- Vitest result set: ${report.testRun.passed}/${report.testRun.total} passed; ${report.testRun.failed} failed; ${report.testRun.pending} pending`,
  `- Requirements: ${report.summary.requirements} (declaration coverage ${report.summary.requirementsWithDeclarationCoverage}, gaps ${report.summary.requirementsWithGaps})`,
  `- Scenarios: ${report.summary.scenarios} (passed declarations ${report.summary.scenariosWithPassedDeclarations})`,
  report.summary.scenariosMissing.length > 0
    ? `- Missing scenarios: ${report.summary.scenariosMissing.join(", ")}`
    : "- Missing scenarios: none",
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
].join("\n");

export interface TraceabilityMainOptions {
  root?: string;
  vitest?: VitestJsonReport;
  writeEvidence?: boolean;
  emitOutput?: boolean;
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
  const tests = passedScenarioReferences(collectExecutableTestDeclarations(root), vitest, root);
  const report = buildTraceabilityReport(requirements.values(), scenarios, rfScenarios, tests, vitest);

  if (options.writeEvidence ?? true) {
    mkdirSync(join(root, "evidence"), { recursive: true });
    writeFileSync(join(root, "evidence", "traceability.json"), JSON.stringify(report, null, 2));
    writeFileSync(join(root, "evidence", "traceability.md"), markdownReport(report));
  }

  const passes = traceabilityPasses(report);
  if (options.emitOutput ?? true) {
    process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
    if (!passes) {
      process.stderr.write(
        report.testRun.success
          ? "traceability declaration gaps present; behavioural coverage is not measured\n"
          : "Vitest result set contains failures; declaration traceability cannot claim a passing suite\n",
      );
    }
  }
  return { report, exitCode: passes ? 0 : 1 };
};

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = main().exitCode;
