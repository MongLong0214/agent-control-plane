import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  buildTraceabilityReport,
  collectExecutableTestDeclarations,
  main,
  passedScenarioReferences,
  traceabilityPasses,
  type ExecutableTestDeclaration,
  type Requirement,
  type VitestJsonReport,
} from "../../src/tools/traceability.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
// Keep fixture labels out of the source-text discovery path: this test must never make a
// production scenario look covered simply because it tests the traceability mechanism.
const fixtureScenarioId = ["CP", "S01"].join("-");
const pipelineScenarioId = ["CP", "S30"].join("-");
const coveredRepoFactoryScenarioId = ["RF", "S05"].join("-");
const missingRepoFactoryScenarioId = ["RF", "S06"].join("-");
const fixtureTestTitle = `${fixtureScenarioId}: refuses the invalid operation`;

const requirement: Requirement = {
  id: "CP-001",
  text: "A requirement with one scenario",
  blocking: "P0",
  scenarios: [fixtureScenarioId],
  evidenceSource: "fixture",
};

const declaration: ExecutableTestDeclaration = {
  file: "tests/scenarios/example.test.ts",
  title: fixtureTestTitle,
  fullName: `scenario fixture ${fixtureTestTitle}`,
  scenarioIds: [fixtureScenarioId],
};

const vitestResult = (status: string): VitestJsonReport => ({
  success: status === "passed",
  numTotalTests: 1,
  numPassedTests: status === "passed" ? 1 : 0,
  numFailedTests: status === "failed" ? 1 : 0,
  numPendingTests: status === "pending" ? 1 : 0,
  testResults: [
    {
      name: join(repoRoot, declaration.file),
      assertionResults: [{ fullName: declaration.fullName, status }],
    },
  ],
});

describe("traceability executed-test coverage", () => {
  it("counts a scenario only when its named Vitest assertion passed", () => {
    const passed = passedScenarioReferences([declaration], vitestResult("passed"));
    const failed = passedScenarioReferences([declaration], vitestResult("failed"));

    expect(passed.get(fixtureScenarioId)).toEqual([
      { file: declaration.file, title: declaration.title },
    ]);
    expect(failed.has(fixtureScenarioId)).toBe(false);
  });

  it("associates a scenario label in a test body with that executable leaf", () => {
    const declarationFromSuite = collectExecutableTestDeclarations().find(
      (candidate) =>
        candidate.file === "tests/integration/pipeline.test.ts" &&
        candidate.title === "registers a project manually and drives contract → verification → blind review → packet",
    );

    expect(declarationFromSuite?.scenarioIds).toContain(pipelineScenarioId);
  });

  it("does not let its fixtures supply product coverage", () => {
    const selfDeclarations = collectExecutableTestDeclarations().filter(
      (candidate) => candidate.file === "tests/unit/traceability.test.ts",
    );

    expect(selfDeclarations.flatMap((candidate) => candidate.scenarioIds)).toEqual([]);
  });

  it("drives main to fail when Vitest succeeds but a labelled leaf is skipped", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "acp-trace-main-"));
    const fixturePrd = `| CP-001 | fixture requirement | P0 |\n\n| CP-001 | ${fixtureScenarioId} | fixture evidence | P0 |\n\n**${fixtureScenarioId}:** fixture scenario\n`;
    const fixtureTestTitle = `${fixtureScenarioId}: skipped leaf`;
    const fixtureTestFile = join(fixtureRoot, "tests", "scenarios", "fixture.test.ts");

    try {
      mkdirSync(join(fixtureRoot, "docs", "prd"), { recursive: true });
      mkdirSync(join(fixtureRoot, "tests", "scenarios"), { recursive: true });
      writeFileSync(
        join(fixtureRoot, "docs", "prd", "AGENT_CONTROL_PLANE_PRD_v1.3_FINAL.md"),
        fixturePrd,
      );
      writeFileSync(
        join(fixtureRoot, "docs", "prd", "REPO_FACTORY_CONTROL_PLANE_INTEGRATION_PRD_v1.1_FINAL.md"),
        "",
      );
      writeFileSync(
        fixtureTestFile,
        `import { it } from "vitest";\nit(${JSON.stringify(fixtureTestTitle)}, () => {});\n`,
      );

      const result = main({
        root: fixtureRoot,
        vitest: {
          success: true,
          numTotalTests: 1,
          numPassedTests: 0,
          numFailedTests: 0,
          numPendingTests: 1,
          testResults: [
            {
              name: fixtureTestFile,
              assertionResults: [{ fullName: fixtureTestTitle, status: "skipped" }],
            },
          ],
        },
        writeEvidence: false,
        emitOutput: false,
      });

      expect(result.report.testRun.success).toBe(true);
      expect(result.report.summary.scenariosMissing).toEqual([fixtureScenarioId]);
      expect(result.exitCode).toBe(1);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("fails the gate when a required scenario loses its passed test", () => {
    const report = buildTraceabilityReport(
      [requirement],
      new Map([[fixtureScenarioId, "fixture scenario"]]),
      new Map(),
      new Map(),
      vitestResult("passed"),
    );

    expect(report.requirements[0]?.status).toBe("DECLARATION_GAP");
    expect(report.summary.scenariosMissing).toEqual([fixtureScenarioId]);
    expect(traceabilityPasses(report)).toBe(false);
  });

  it("lists Repo Factory scenarios that this execution did not cover", () => {
    const report = buildTraceabilityReport(
      [requirement],
      new Map([[fixtureScenarioId, "fixture scenario"]]),
      new Map([
        [coveredRepoFactoryScenarioId, "covered factory scenario"],
        [missingRepoFactoryScenarioId, "missing factory scenario"],
      ]),
      new Map([
        [fixtureScenarioId, [{ file: declaration.file, title: declaration.title }]],
        [coveredRepoFactoryScenarioId, [{ file: declaration.file, title: declaration.title }]],
      ]),
      vitestResult("passed"),
    );

    expect(report.repoFactoryScenarios).toEqual([
      expect.objectContaining({ id: coveredRepoFactoryScenarioId, status: "DECLARATION_COVERED" }),
      expect.objectContaining({ id: missingRepoFactoryScenarioId, status: "DECLARATION_MISSING", tests: [] }),
    ]);
    expect(report.summary).toMatchObject({
      repoFactoryScenarios: 2,
      repoFactoryScenariosWithPassedDeclarations: 1,
      repoFactoryScenariosMissing: [missingRepoFactoryScenarioId],
    });
  });
});
