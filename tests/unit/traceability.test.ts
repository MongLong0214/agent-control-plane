import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  buildTraceabilityReport,
  collectExecutableTestDeclarations,
  main,
  passedScenarioReferences,
  REPO_FACTORY_EXTERNAL_EVIDENCE,
  traceabilityPasses,
  type ExecutableTestDeclaration,
  type ExternalScenarioEvidence,
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

describe("a result set written by another machine still matches", () => {
  // The failure this pins needs two machines to appear, which is why a same-platform job hid it
  // completely. CI produces the Vitest JSON on the macOS matrix leg and hands it to a job that
  // consumes it; once that job moved to ubuntu the artifact's `/Users/runner/work/...` names were
  // resolved against `/home/runner/work/...` and every key differed. Measured in CI as
  // `requirementsWithGaps: 22` — every requirement in the PRD, from a suite that had passed.
  const producedUnder = (root: string): VitestJsonReport => ({
    success: true,
    numTotalTests: 1,
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: 0,
    testResults: [
      {
        name: `${root}/${declaration.file}`,
        assertionResults: [{ fullName: declaration.fullName, status: "passed" }],
      },
    ],
  });

  it("matches a macOS-runner result set from a Linux-runner process", () => {
    const covered = passedScenarioReferences(
      [declaration],
      producedUnder("/Users/runner/work/agent-control-plane/agent-control-plane"),
    );

    expect(covered.get(fixtureScenarioId)).toHaveLength(1);
  });

  it("matches the same result set from any other root, including this one", () => {
    for (const root of ["/home/runner/work/agent-control-plane/agent-control-plane", "/tmp/x/y", repoRoot]) {
      const covered = passedScenarioReferences([declaration], producedUnder(root));
      expect(covered.get(fixtureScenarioId), `root ${root}`).toHaveLength(1);
    }
  });

  it("leaves a path that matches no declaration unmatched rather than folding it onto one", () => {
    // The other direction. Relaxing the comparison must not make one file's result count for
    // another's declaration — an unmatched entry has to stay unmatched.
    const foreign: VitestJsonReport = {
      ...producedUnder("/Users/runner/work/agent-control-plane/agent-control-plane"),
      testResults: [
        {
          name: "/Users/runner/work/other-repo/other-repo/tests/scenarios/different.test.ts",
          assertionResults: [{ fullName: declaration.fullName, status: "passed" }],
        },
      ],
    };

    expect(passedScenarioReferences([declaration], foreign).get(fixtureScenarioId)).toBeUndefined();
  });

  it("requires the whole relative path to match, not just the basename", () => {
    // Written after a mutation survived the case above. That one uses a different *file name*, so
    // a comparison as loose as "ends with the basename" passed it while being wrong — the shape I
    // expected rather than the shape a wrong implementation has. `tests/scenarios/example.test.ts`
    // and `tests/other/example.test.ts` are different files with one name between them, and the
    // suffix has to carry the directory to tell them apart.
    const sameNameElsewhere: VitestJsonReport = {
      ...producedUnder("/Users/runner/work/agent-control-plane/agent-control-plane"),
      testResults: [
        {
          name: "/Users/runner/work/agent-control-plane/agent-control-plane/tests/other/example.test.ts",
          assertionResults: [{ fullName: declaration.fullName, status: "passed" }],
        },
      ],
    };

    expect(
      passedScenarioReferences([declaration], sameNameElsewhere).get(fixtureScenarioId),
    ).toBeUndefined();
  });
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

describe("Repo Factory scenarios count in the verdict", () => {
  // `pnpm trace` used to exit 0 while Repo Factory scenarios were uncovered: the pass check read
  // only the CP side. These drive `main` over a fixture tree, so the verdict is the one the CLI
  // returns. Every id here is assembled at run time, for the reason given at the top of the file.
  const cp = ["CP", "S01"].join("-");
  const first = ["RF", "S01"].join("-");
  const second = ["RF", "S02"].join("-");
  const noExternal: ExternalScenarioEvidence = { repository: "", revision: "", ciRun: "", scenarios: [] };
  const elsewhere = (scenarios: ExternalScenarioEvidence["scenarios"]): ExternalScenarioEvidence => ({
    repository: "example/other-repository",
    revision: "0123456789abcdef0123456789abcdef01234567",
    ciRun: "42",
    scenarios,
  });

  /** A tree with one CP scenario and two Repo Factory ones, and a result set for the given leaves. */
  const traceFixture = (
    leaves: Array<{ id: string; status: string }>,
    external: ExternalScenarioEvidence,
    run: Partial<{ writeEvidence: boolean; emitOutput: boolean }> = {},
  ) => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "acp-trace-rf-"));
    try {
      mkdirSync(join(fixtureRoot, "docs", "prd"), { recursive: true });
      mkdirSync(join(fixtureRoot, "tests", "scenarios"), { recursive: true });
      writeFileSync(
        join(fixtureRoot, "docs", "prd", "AGENT_CONTROL_PLANE_PRD_v1.3_FINAL.md"),
        `| CP-001 | fixture requirement | P0 |\n\n| CP-001 | ${cp} | fixture evidence | P0 |\n\n**${cp}:** fixture scenario\n`,
      );
      writeFileSync(
        join(fixtureRoot, "docs", "prd", "REPO_FACTORY_CONTROL_PLANE_INTEGRATION_PRD_v1.1_FINAL.md"),
        `- **${first}:** first factory scenario\n- **${second}:** second factory scenario\n`,
      );
      const testFile = join(fixtureRoot, "tests", "scenarios", "fixture.test.ts");
      const all = [{ id: cp, status: "passed" }, ...leaves];
      writeFileSync(
        testFile,
        `import { it } from "vitest";\n${all.map(({ id }) => `it(${JSON.stringify(`${id}: leaf`)}, () => {});`).join("\n")}\n`,
      );
      const result = main({
        root: fixtureRoot,
        vitest: {
          success: true,
          numTotalTests: all.length,
          numPassedTests: all.filter(({ status }) => status === "passed").length,
          numFailedTests: 0,
          numPendingTests: all.filter(({ status }) => status !== "passed").length,
          testResults: [
            { name: testFile, assertionResults: all.map(({ id, status }) => ({ fullName: `${id}: leaf`, status })) },
          ],
        },
        writeEvidence: run.writeEvidence ?? false,
        emitOutput: run.emitOutput ?? false,
        external,
      });
      const markdown = run.writeEvidence ? readFileSync(join(fixtureRoot, "evidence", "traceability.md"), "utf8") : "";
      return { ...result, markdown };
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  };

  it("fails main when a Repo Factory scenario has no passed declaration, though every CP scenario passed", () => {
    const result = traceFixture([{ id: first, status: "passed" }], noExternal);

    expect(result.report.summary.scenariosMissing).toEqual([]);
    expect(result.report.summary.requirementsWithGaps).toBe(0);
    expect(result.report.summary.repoFactoryScenariosMissing).toEqual([second]);
    expect(result.exitCode).toBe(1);
  });

  it("fails main when a Repo Factory scenario's only declaration did not pass", () => {
    const result = traceFixture([{ id: first, status: "passed" }, { id: second, status: "skipped" }], noExternal);

    expect(result.report.testRun.success).toBe(true);
    expect(result.report.summary.repoFactoryScenariosMissing).toEqual([second]);
    expect(result.exitCode).toBe(1);
  });

  it("passes main when every Repo Factory scenario passed here (the control for the two above)", () => {
    const result = traceFixture([{ id: first, status: "passed" }, { id: second, status: "passed" }], noExternal);

    expect(result.report.summary.repoFactoryScenariosWithPassedDeclarations).toBe(2);
    expect(result.exitCode).toBe(0);
  });

  it("reports an externally judged scenario as EXTERNAL with its test ids, counts it as nothing, and names it on every run", () => {
    const external = elsewhere([{ id: second, arm: null, tests: ["tests/test_x.py::test_second"] }]);
    const writes: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const result = traceFixture([{ id: first, status: "passed" }], external, { emitOutput: true, writeEvidence: true });

      expect(result.exitCode).toBe(0);
      expect(result.report.summary).toMatchObject({
        repoFactoryScenariosWithPassedDeclarations: 1,
        repoFactoryScenariosMissing: [],
        repoFactoryScenariosExternal: [second],
        repoFactoryScenariosDuplicated: [],
      });
      const row = result.report.repoFactoryScenarios.find((candidate) => candidate.id === second);
      expect(row).toMatchObject({ status: "EXTERNAL", tests: [] });
      expect(row?.external).toEqual([
        expect.objectContaining({
          arm: null,
          tests: ["tests/test_x.py::test_second"],
          repository: "example/other-repository",
          revision: external.revision,
          ciRun: "42",
          acpUnattendedRun: "NOT_SUPPORTED",
        }),
      ]);
      // Not silent: the exit code is 0, so the run has to say what it did not judge.
      expect(writes.join("")).toContain(`EXTERNAL`);
      expect(writes.join("")).toContain(second);
      expect(result.markdown).toContain(`| ${second} | EXTERNAL |`);
      expect(result.markdown).toContain("tests/test_x.py::test_second");
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
    }
  });

  it("fails main when a scenario is declared here and also listed as judged elsewhere", () => {
    const external = elsewhere([{ id: first, arm: null, tests: ["tests/test_x.py::test_first"] }]);

    const passedHere = traceFixture([{ id: first, status: "passed" }, { id: second, status: "passed" }], external);
    expect(passedHere.report.summary.repoFactoryScenariosDuplicated).toEqual([first]);
    expect(passedHere.exitCode).toBe(1);

    // A declaration that did not pass is still a second judge, not a gap the external entry fills.
    const skippedHere = traceFixture([{ id: first, status: "skipped" }, { id: second, status: "passed" }], external);
    expect(skippedHere.report.summary.repoFactoryScenariosDuplicated).toEqual([first]);
    expect(skippedHere.exitCode).toBe(1);
  });

  it("fails main when one scenario is listed whole twice, or the same arm twice", () => {
    const twice = elsewhere([
      { id: second, arm: null, tests: ["tests/test_x.py::test_a"] },
      { id: second, arm: null, tests: ["tests/test_x.py::test_b"] },
    ]);
    expect(traceFixture([{ id: first, status: "passed" }], twice).report.summary.repoFactoryScenariosDuplicated).toEqual([
      second,
    ]);

    const armTwice = elsewhere([
      { id: second, arm: "two repositories", tests: ["tests/test_x.py::test_a"] },
      { id: second, arm: "two repositories", tests: ["tests/test_x.py::test_b"] },
    ]);
    const result = traceFixture([{ id: first, status: "passed" }, { id: second, status: "passed" }], armTwice);
    expect(result.report.summary.repoFactoryScenariosDuplicated).toEqual([second]);
    expect(result.exitCode).toBe(1);
  });

  it("an arm judged elsewhere never covers a scenario by itself, and is reported beside a passed declaration", () => {
    const external = elsewhere([{ id: second, arm: "two repositories", tests: ["tests/test_x.py::test_arm"] }]);

    const alone = traceFixture([{ id: first, status: "passed" }], external);
    expect(alone.report.summary.repoFactoryScenariosMissing).toEqual([second]);
    expect(alone.exitCode).toBe(1);

    const withDeclaration = traceFixture([{ id: first, status: "passed" }, { id: second, status: "passed" }], external, {
      writeEvidence: true,
    });
    expect(withDeclaration.exitCode).toBe(0);
    const row = withDeclaration.report.repoFactoryScenarios.find((candidate) => candidate.id === second);
    expect(row?.status).toBe("DECLARATION_COVERED");
    expect(row?.external).toEqual([
      expect.objectContaining({ arm: "two repositories", acpUnattendedRun: "NOT_SUPPORTED" }),
    ]);
    expect(withDeclaration.markdown).toContain("two repositories arm: example/other-repository@0123456789ab");
  });

  it("fails main on an external entry it cannot use: an unknown scenario, no test id, or a short revision", () => {
    const unknown = ["RF", "S99"].join("-");
    const cases: ExternalScenarioEvidence[] = [
      elsewhere([{ id: unknown, arm: null, tests: ["tests/test_x.py::test_a"] }]),
      elsewhere([{ id: second, arm: null, tests: [] }]),
      { ...elsewhere([{ id: second, arm: null, tests: ["tests/test_x.py::test_a"] }]), revision: "309e2e6" },
    ];
    for (const external of cases) {
      const result = traceFixture([{ id: first, status: "passed" }, { id: second, status: "passed" }], external);
      expect(result.report.summary.repoFactoryExternalEvidenceProblems, JSON.stringify(external)).not.toEqual([]);
      expect(result.exitCode).toBe(1);
    }
  });

  it("no longer claims that CI recomputes the committed report", () => {
    const result = traceFixture([{ id: first, status: "passed" }, { id: second, status: "passed" }], noExternal, {
      writeEvidence: true,
    });

    expect(result.markdown).not.toMatch(/CI recomputes/);
    expect(result.markdown).toContain("CI does not run `pnpm trace`");
  });

  it("the committed external list is usable as written, and no test here also judges one of its whole scenarios", () => {
    // Read against this repository's own PRD and declarations, with an empty result set: only the
    // two checks that do not depend on a run are asserted.
    const { report } = main({
      vitest: { success: true, numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, testResults: [] },
      writeEvidence: false,
      emitOutput: false,
    });

    expect(report.summary.repoFactoryExternalEvidenceProblems).toEqual([]);
    expect(report.summary.repoFactoryScenariosDuplicated).toEqual([]);
    expect(REPO_FACTORY_EXTERNAL_EVIDENCE.scenarios.length).toBeGreaterThan(0);
    expect(report.summary.repoFactoryScenariosExternal).toEqual(
      REPO_FACTORY_EXTERNAL_EVIDENCE.scenarios.filter((entry) => entry.arm === null).map((entry) => entry.id),
    );
  });
});
