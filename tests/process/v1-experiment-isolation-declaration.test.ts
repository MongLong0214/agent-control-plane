import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const script = join(root, "scripts", "verify-v1-experiment-isolation-declaration.mjs");

interface CensusBucket {
  experimentDatabasePath: string[];
  experimentArtifactRoot: string[];
  validatorConsumer: string[];
}

interface Census {
  active: boolean;
  scannedFileCount: number;
  runtimeEnforcementDeclarations: string[];
  candidates: CensusBucket;
  authorizedConsumers: CensusBucket;
}

const census = (fixtureRoot?: string): { exitCode: number | null; report: Census } => {
  const args = [script, "--json"];
  if (fixtureRoot) args.push(`--root=${fixtureRoot}`);
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  try {
    return { exitCode: result.status, report: JSON.parse(result.stdout) as Census };
  } catch {
    throw new Error(`experiment-isolation census did not return JSON:\n${result.stdout}${result.stderr}`);
  }
};

it("finds no unauthorized experiment-state consumer in production, with Db's constructor as the sole authorized one", () => {
  const production = census();
  expect(production.exitCode).toBe(0);
  expect(production.report.active).toBe(true);
  expect(production.report.scannedFileCount).toBeGreaterThan(0);
  expect(production.report.runtimeEnforcementDeclarations).not.toHaveLength(0);
  expect(production.report.candidates).toEqual({
    experimentDatabasePath: [],
    experimentArtifactRoot: [],
    validatorConsumer: [],
  });
  // Db's constructor is #416's declared enforcement point, so its own references to these tokens
  // are expected and reported apart from `candidates` rather than failing the build.
  expect(production.report.authorizedConsumers.experimentDatabasePath).not.toHaveLength(0);
  expect(production.report.authorizedConsumers.experimentArtifactRoot).not.toHaveLength(0);
  expect(production.report.authorizedConsumers.validatorConsumer).not.toHaveLength(0);
  for (const hit of [
    ...production.report.authorizedConsumers.experimentDatabasePath,
    ...production.report.authorizedConsumers.experimentArtifactRoot,
    ...production.report.authorizedConsumers.validatorConsumer,
  ]) {
    expect(hit.startsWith("src/db/database.ts:")).toBe(true);
  }
});

it("detects synthetic experiment state opening and validator consumption outside the authorized consumer", () => {
  const fixture = mkdtempSync(join(tmpdir(), "v1-experiment-isolation-census-"));
  try {
    mkdirSync(join(fixture, "src", "export"), { recursive: true });
    writeFileSync(
      join(fixture, "src", "export", "experiment-isolation.ts"),
      'export const runtimeEnforcement = "ENFORCED_AT_DB_OPEN";\n' +
        'const declaration = { runtimeEnforcement: "ENFORCED_AT_DB_OPEN" };\nvoid declaration;\n',
    );
    writeFileSync(
      join(fixture, "src", "experiment-runner.ts"),
      "const open = (input: unknown) => {\n" +
        "  const validation: ExperimentIsolationValidation = validateExperimentIsolation(input).value;\n" +
        "  new Db(validation.experimentDatabasePath);\n" +
        "  writeFileSync(join(validation.experimentArtifactRoot, \"artifact.json\"), \"artifact\");\n" +
        "};\nvoid open;\n",
    );

    const synthetic = census(fixture);
    expect(synthetic.exitCode).toBe(1);
    expect(synthetic.report.scannedFileCount).toBe(1);
    expect(synthetic.report.candidates.experimentDatabasePath).toEqual(["src/experiment-runner.ts:3"]);
    expect(synthetic.report.candidates.experimentArtifactRoot).toEqual(["src/experiment-runner.ts:4"]);
    expect(synthetic.report.candidates.validatorConsumer).toEqual([
      "src/experiment-runner.ts:2",
      "src/experiment-runner.ts:2",
    ]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

it("does not fail a synthetic consumer placed at the authorized path", () => {
  const fixture = mkdtempSync(join(tmpdir(), "v1-experiment-isolation-census-authorized-"));
  try {
    mkdirSync(join(fixture, "src", "export"), { recursive: true });
    mkdirSync(join(fixture, "src", "db"), { recursive: true });
    writeFileSync(
      join(fixture, "src", "export", "experiment-isolation.ts"),
      'export const runtimeEnforcement = "ENFORCED_AT_DB_OPEN";\n' +
        'const declaration = { runtimeEnforcement: "ENFORCED_AT_DB_OPEN" };\nvoid declaration;\n',
    );
    writeFileSync(
      join(fixture, "src", "db", "database.ts"),
      "const open = (input: unknown) => {\n" +
        "  const validation: ExperimentIsolationValidation = validateExperimentIsolation(input).value;\n" +
        "  new Db(validation.experimentDatabasePath);\n" +
        "  writeFileSync(join(validation.experimentArtifactRoot, \"artifact.json\"), \"artifact\");\n" +
        "};\nvoid open;\n",
    );

    const synthetic = census(fixture);
    expect(synthetic.exitCode).toBe(0);
    expect(synthetic.report.candidates).toEqual({
      experimentDatabasePath: [],
      experimentArtifactRoot: [],
      validatorConsumer: [],
    });
    expect(synthetic.report.authorizedConsumers.experimentDatabasePath).toEqual(["src/db/database.ts:3"]);
    expect(synthetic.report.authorizedConsumers.experimentArtifactRoot).toEqual(["src/db/database.ts:4"]);
    expect(synthetic.report.authorizedConsumers.validatorConsumer).toEqual([
      "src/db/database.ts:2",
      "src/db/database.ts:2",
    ]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
