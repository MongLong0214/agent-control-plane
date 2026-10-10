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
  REPO_FACTORY_SCENARIO_ARMS,
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

  interface Leaf {
    title: string;
    /** Written into the test body as a comment, which is where an arm label usually sits. */
    body?: string;
    status: string;
  }
  /** A leaf labelled whole by its title. */
  const whole = (id: string, status: string): Leaf => ({ title: `${id}: leaf`, status });
  /** A leaf that witnesses one arm of a scenario, labelled in its body. */
  const arm = (id: string, name: string, status = "passed", title = `${name} arm leaf`): Leaf => ({
    title,
    body: `${id} arm:${name}`,
    status,
  });

  /** A tree with one CP scenario and two Repo Factory ones, and a result set for the given leaves. */
  const traceFixture = (
    leaves: Leaf[],
    external: ExternalScenarioEvidence,
    run: Partial<{
      writeEvidence: boolean;
      emitOutput: boolean;
      requiredArms: Readonly<Record<string, readonly string[]>>;
    }> = {},
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
      const all = [whole(cp, "passed"), ...leaves];
      writeFileSync(
        testFile,
        `import { it } from "vitest";\n${all
          .map(({ title, body }) => `it(${JSON.stringify(title)}, () => {${body ? `\n  // ${body}\n` : ""}});`)
          .join("\n")}\n`,
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
            { name: testFile, assertionResults: all.map(({ title, status }) => ({ fullName: title, status })) },
          ],
        },
        writeEvidence: run.writeEvidence ?? false,
        emitOutput: run.emitOutput ?? false,
        external,
        // The committed arm list names scenarios this fixture's PRD does not have.
        requiredArms: run.requiredArms ?? {},
      });
      const markdown = run.writeEvidence ? readFileSync(join(fixtureRoot, "evidence", "traceability.md"), "utf8") : "";
      const row = (id: string) => result.report.repoFactoryScenarios.find((candidate) => candidate.id === id);
      return { ...result, markdown, row };
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  };

  it("fails main when a Repo Factory scenario has no passed declaration, though every CP scenario passed", () => {
    const result = traceFixture([whole(first, "passed")], noExternal);

    expect(result.report.summary.scenariosMissing).toEqual([]);
    expect(result.report.summary.requirementsWithGaps).toBe(0);
    expect(result.report.summary.repoFactoryScenariosMissing).toEqual([second]);
    expect(result.exitCode).toBe(1);
  });

  it("fails main when a Repo Factory scenario's only declaration did not pass", () => {
    const result = traceFixture([whole(first, "passed"), whole(second, "skipped")], noExternal);

    expect(result.report.testRun.success).toBe(true);
    expect(result.report.summary.repoFactoryScenariosMissing).toEqual([second]);
    expect(result.exitCode).toBe(1);
  });

  it("passes main when every Repo Factory scenario passed here (the control for the two above)", () => {
    const result = traceFixture([whole(first, "passed"), whole(second, "passed")], noExternal);

    expect(result.report.summary.repoFactoryScenariosWithPassedDeclarations).toBe(2);
    expect(result.exitCode).toBe(0);
  });

  it("an arm label leaves its scenario uncovered, and is reported as the arm it is", () => {
    // A comment that said "one arm only" used to cover the whole scenario: the bare id was all the
    // collector looked for. The arm is reported in the row, and the scenario is still missing.
    const result = traceFixture([whole(first, "passed"), arm(second, "single-repository")], noExternal);

    expect(result.report.summary.repoFactoryScenariosMissing).toEqual([second]);
    expect(result.row(second)).toMatchObject({ status: "DECLARATION_MISSING", tests: [] });
    expect(result.row(second)?.arms).toEqual([
      { arm: "single-repository", tests: [{ file: "tests/scenarios/fixture.test.ts", title: "single-repository arm leaf" }] },
    ]);
    expect(result.exitCode).toBe(1);
  });

  it("an arm label narrows the bare id the same leaf's title carries", () => {
    const result = traceFixture(
      [whole(first, "passed"), arm(second, "alpha", "passed", `${second}: names the scenario in its title`)],
      noExternal,
    );

    expect(result.row(second)?.status).toBe("DECLARATION_MISSING");
    expect(result.row(second)?.arms.map(({ arm: name }) => name)).toEqual(["alpha"]);
    expect(result.exitCode).toBe(1);
  });

  it("covers a scenario by its listed arms only when every one of them passed", () => {
    const requiredArms = { [second]: ["alpha", "beta"] };

    const one = traceFixture([whole(first, "passed"), arm(second, "alpha")], noExternal, { requiredArms });
    expect(one.row(second)).toMatchObject({ status: "DECLARATION_MISSING", missingArms: ["beta"] });
    expect(one.exitCode).toBe(1);

    const failedArm = traceFixture(
      [whole(first, "passed"), arm(second, "alpha"), arm(second, "beta", "skipped")],
      noExternal,
      { requiredArms },
    );
    expect(failedArm.row(second)).toMatchObject({ status: "DECLARATION_MISSING", missingArms: ["beta"] });
    expect(failedArm.exitCode).toBe(1);

    const both = traceFixture([whole(first, "passed"), arm(second, "alpha"), arm(second, "beta")], noExternal, {
      requiredArms,
      writeEvidence: true,
    });
    expect(both.row(second)).toMatchObject({ status: "DECLARATION_COVERED", tests: [], missingArms: [] });
    expect(both.exitCode).toBe(0);
    expect(both.markdown).toContain("alpha: tests/scenarios/fixture.test.ts › alpha arm leaf");
  });

  it("fails main on an arm that is not listed for its scenario, or a list it cannot use", () => {
    const misspelt = traceFixture(
      [whole(first, "passed"), arm(second, "alpha"), arm(second, "betta")],
      noExternal,
      { requiredArms: { [second]: ["alpha", "beta"] } },
    );
    expect(misspelt.report.summary.repoFactoryArmProblems).toEqual([
      expect.stringContaining(`${second} arm 'betta' is not one of alpha, beta`),
    ]);
    expect(misspelt.exitCode).toBe(1);

    const unknown = ["RF", "S99"].join("-");
    for (const requiredArms of [{ [unknown]: ["alpha", "beta"] }, { [second]: ["alpha"] }, { [second]: ["alpha", "alpha"] }]) {
      const result = traceFixture([whole(first, "passed"), whole(second, "passed")], noExternal, { requiredArms });
      expect(result.report.summary.repoFactoryArmProblems, JSON.stringify(requiredArms)).not.toEqual([]);
      expect(result.exitCode).toBe(1);
    }
  });

  it("reports an externally judged scenario as EXTERNAL with its test ids, counts it as nothing, and names it on every run", () => {
    const external = elsewhere([{ id: second, tests: ["tests/test_x.py::test_second"] }]);
    const writes: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const result = traceFixture([whole(first, "passed")], external, { emitOutput: true, writeEvidence: true });

      expect(result.exitCode).toBe(0);
      expect(result.report.summary).toMatchObject({
        repoFactoryScenariosWithPassedDeclarations: 1,
        repoFactoryScenariosMissing: [],
        repoFactoryScenariosExternal: [second],
        repoFactoryScenariosDuplicated: [],
      });
      expect(result.row(second)).toMatchObject({ status: "EXTERNAL", tests: [] });
      expect(result.row(second)?.external).toEqual([
        expect.objectContaining({
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

  it("keeps an external scenario's entry as its only judge when arms here witness part of it", () => {
    // The shape of a scenario whose whole is witnessed in the other repository while this one
    // witnesses a part: the part is reported, and removing the entry leaves the scenario missing.
    const external = elsewhere([{ id: second, tests: ["tests/test_x.py::test_two_repositories"] }]);
    const leaves = [whole(first, "passed"), arm(second, "single-repository")];

    const judged = traceFixture(leaves, external);
    expect(judged.row(second)?.status).toBe("EXTERNAL");
    expect(judged.row(second)?.arms.map(({ arm: name }) => name)).toEqual(["single-repository"]);
    expect(judged.exitCode).toBe(0);

    const withoutEntry = traceFixture(leaves, noExternal);
    expect(withoutEntry.row(second)?.status).toBe("DECLARATION_MISSING");
    expect(withoutEntry.exitCode).toBe(1);

    // A complete set of arms here is a second judge, just as a whole label is.
    const complete = traceFixture([whole(first, "passed"), arm(second, "alpha"), arm(second, "beta")], external, {
      requiredArms: { [second]: ["alpha", "beta"] },
    });
    expect(complete.report.summary.repoFactoryScenariosDuplicated).toEqual([second]);
    expect(complete.exitCode).toBe(1);
  });

  it("fails main when a scenario is declared here and also listed as judged elsewhere", () => {
    const external = elsewhere([{ id: first, tests: ["tests/test_x.py::test_first"] }]);

    const passedHere = traceFixture([whole(first, "passed"), whole(second, "passed")], external);
    expect(passedHere.report.summary.repoFactoryScenariosDuplicated).toEqual([first]);
    expect(passedHere.exitCode).toBe(1);

    // A declaration that did not pass is still a second judge, not a gap the external entry fills.
    const skippedHere = traceFixture([whole(first, "skipped"), whole(second, "passed")], external);
    expect(skippedHere.report.summary.repoFactoryScenariosDuplicated).toEqual([first]);
    expect(skippedHere.exitCode).toBe(1);
  });

  it("fails main when one scenario is listed as judged elsewhere twice", () => {
    const twice = elsewhere([
      { id: second, tests: ["tests/test_x.py::test_a"] },
      { id: second, tests: ["tests/test_x.py::test_b"] },
    ]);
    const result = traceFixture([whole(first, "passed")], twice);
    expect(result.report.summary.repoFactoryScenariosDuplicated).toEqual([second]);
    expect(result.exitCode).toBe(1);
  });

  it("fails main on an external entry it cannot use: an unknown scenario, no test id, or a short revision", () => {
    const unknown = ["RF", "S99"].join("-");
    const cases: ExternalScenarioEvidence[] = [
      elsewhere([{ id: unknown, tests: ["tests/test_x.py::test_a"] }]),
      elsewhere([{ id: second, tests: [] }]),
      { ...elsewhere([{ id: second, tests: ["tests/test_x.py::test_a"] }]), revision: "309e2e6" },
    ];
    for (const external of cases) {
      const result = traceFixture([whole(first, "passed"), whole(second, "passed")], external);
      expect(result.report.summary.repoFactoryExternalEvidenceProblems, JSON.stringify(external)).not.toEqual([]);
      expect(result.exitCode).toBe(1);
    }
  });

  it("no longer claims that CI recomputes the committed report", () => {
    const result = traceFixture([whole(first, "passed"), whole(second, "passed")], noExternal, { writeEvidence: true });

    expect(result.markdown).not.toMatch(/CI recomputes/);
    expect(result.markdown).toContain("CI does not run `pnpm trace`");
  });

  it("the committed external and arm lists are usable as written against this repository's own labels", () => {
    // Read against this repository's own PRD and declarations, with an empty result set: only the
    // checks that do not depend on a run are asserted.
    const { report } = main({
      vitest: { success: true, numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, testResults: [] },
      writeEvidence: false,
      emitOutput: false,
    });

    expect(report.summary.repoFactoryExternalEvidenceProblems).toEqual([]);
    expect(report.summary.repoFactoryArmProblems).toEqual([]);
    expect(report.summary.repoFactoryScenariosDuplicated).toEqual([]);
    expect(REPO_FACTORY_EXTERNAL_EVIDENCE.scenarios.length).toBeGreaterThan(0);
    expect(report.summary.repoFactoryScenariosExternal).toEqual(
      REPO_FACTORY_EXTERNAL_EVIDENCE.scenarios.map((entry) => entry.id),
    );
    // Every listed arm names a scenario that is not also handed to the other repository.
    for (const id of Object.keys(REPO_FACTORY_SCENARIO_ARMS)) {
      expect(REPO_FACTORY_EXTERNAL_EVIDENCE.scenarios.map((entry) => entry.id), id).not.toContain(id);
    }
  });
});
