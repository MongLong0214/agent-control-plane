#!/usr/bin/env node
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Machine-checked traceability (PRD §38, §42 item 10).
 *
 * Reads the requirement table and scenario list straight out of the vendored PRDs, then
 * scans the test suite for each scenario id. A requirement whose scenarios are not all
 * referenced by an executable test is reported as a gap rather than assumed covered —
 * CP-HI-08 applies to this report too.
 */
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const prdDir = join(repoRoot, "docs", "prd");
const testsDir = join(repoRoot, "tests");

interface Requirement {
  id: string;
  text: string;
  blocking: string;
  scenarios: string[];
  evidenceSource: string;
}

const readPrd = (name: string): string => readFileSync(join(prdDir, name), "utf8");

/** §37 — `| CP-001 | requirement | P0 |` */
const parseRequirements = (prd: string, prefix: string): Map<string, Requirement> => {
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
const attachScenarios = (
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
const expandScenarioCell = (cell: string, prefix: string): string[] => {
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
const parseScenarioCatalogue = (prd: string, prefix: string): Map<string, string> => {
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

interface TestReference {
  file: string;
  title: string;
}

const scanTests = (): Map<string, TestReference[]> => {
  const references = new Map<string, TestReference[]>();
  for (const file of walk(testsDir)) {
    const source = readFileSync(file, "utf8");
    const relative = file.slice(repoRoot.length + 1);
    // Attribute each mention to the nearest enclosing it()/describe() title.
    const lines = source.split("\n");
    let currentTitle = "(file scope)";
    for (const line of lines) {
      const title = /^\s*(?:it|describe)(?:\.\w+)?\s*\(\s*["'`](.+?)["'`]/.exec(line);
      if (title) currentTitle = title[1]!;
      for (const match of line.matchAll(/\b((?:CP|RF)-S\d+)\b/g)) {
        const id = match[1]!.replace(/-S(\d)$/, "-S0$1");
        const list = references.get(id) ?? [];
        if (!list.some((r) => r.file === relative && r.title === currentTitle)) {
          list.push({ file: relative, title: currentTitle });
        }
        references.set(id, list);
      }
    }
  }
  return references;
};

const acpPrd = readPrd("AGENT_CONTROL_PLANE_PRD_v1.3_FINAL.md");
const rfPrd = readPrd("REPO_FACTORY_CONTROL_PLANE_INTEGRATION_PRD_v1.1_FINAL.md");

const requirements = parseRequirements(acpPrd, "CP");
attachScenarios(acpPrd, requirements, "CP");
const scenarios = parseScenarioCatalogue(acpPrd, "CP");
const rfScenarios = parseScenarioCatalogue(rfPrd, "RF");
const tests = scanTests();

const requirementRows = [...requirements.values()].map((requirement) => {
  const covered = requirement.scenarios.filter((id) => (tests.get(id) ?? []).length > 0);
  const missing = requirement.scenarios.filter((id) => (tests.get(id) ?? []).length === 0);
  return {
    ...requirement,
    coveredScenarios: covered,
    missingScenarios: missing,
    status: requirement.scenarios.length === 0 ? "NO_SCENARIOS" : missing.length === 0 ? "COVERED" : "GAP",
  };
});

const scenarioRows = [...scenarios.entries()].map(([id, description]) => ({
  id,
  description,
  tests: tests.get(id) ?? [],
  status: (tests.get(id) ?? []).length > 0 ? "COVERED" : "MISSING",
}));

const rfScenarioRows = [...rfScenarios.entries()]
  .filter(([id]) => (tests.get(id) ?? []).length > 0)
  .map(([id, description]) => ({ id, description, tests: tests.get(id) ?? [] }));

const report = {
  generatedFrom: [
    "docs/prd/AGENT_CONTROL_PLANE_PRD_v1.3_FINAL.md",
    "docs/prd/REPO_FACTORY_CONTROL_PLANE_INTEGRATION_PRD_v1.1_FINAL.md",
  ],
  summary: {
    requirements: requirementRows.length,
    requirementsCovered: requirementRows.filter((r) => r.status === "COVERED").length,
    requirementsWithGaps: requirementRows.filter((r) => r.status === "GAP").length,
    scenarios: scenarioRows.length,
    scenariosCovered: scenarioRows.filter((s) => s.status === "COVERED").length,
    scenariosMissing: scenarioRows.filter((s) => s.status === "MISSING").map((s) => s.id),
    repoFactoryScenariosTouched: rfScenarioRows.length,
  },
  requirements: requirementRows,
  scenarios: scenarioRows,
  repoFactoryScenariosTouched: rfScenarioRows,
};

mkdirSync(join(repoRoot, "evidence"), { recursive: true });
writeFileSync(join(repoRoot, "evidence", "traceability.json"), JSON.stringify(report, null, 2));

const markdown = [
  "# Requirement traceability",
  "",
  `Generated from the vendored SSOT PRDs. Scenario coverage is established by scanning`,
  `the executable test suite for each scenario id, not by assertion.`,
  "",
  `- Requirements: ${report.summary.requirements} (covered ${report.summary.requirementsCovered}, gaps ${report.summary.requirementsWithGaps})`,
  `- Scenarios: ${report.summary.scenarios} (covered ${report.summary.scenariosCovered})`,
  report.summary.scenariosMissing.length > 0
    ? `- Missing scenarios: ${report.summary.scenariosMissing.join(", ")}`
    : "- Missing scenarios: none",
  "",
  "| Requirement | Blocking | Scenarios | Status |",
  "|---|---|---|---|",
  ...requirementRows.map(
    (r) =>
      `| ${r.id} | ${r.blocking} | ${r.scenarios.join(", ") || "—"} | ${r.status}${
        r.missingScenarios.length > 0 ? ` (missing ${r.missingScenarios.join(", ")})` : ""
      } |`,
  ),
  "",
  "| Scenario | Status | Tests |",
  "|---|---|---|",
  ...scenarioRows.map(
    (s) =>
      `| ${s.id} | ${s.status} | ${s.tests.map((t) => `${t.file} › ${t.title}`).join("<br>") || "—"} |`,
  ),
].join("\n");

writeFileSync(join(repoRoot, "evidence", "traceability.md"), markdown);

process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
if (report.summary.scenariosMissing.length > 0 || report.summary.requirementsWithGaps > 0) {
  process.stderr.write("traceability gaps present\n");
  process.exit(1);
}
