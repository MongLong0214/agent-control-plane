import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, expect, it } from "vitest";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PAIR = join(ROOT, "src", "tools", "pair-repo-factory-result.ts");
const REPO_FACTORY_COMMIT = "f".repeat(40);

afterAll(cleanupTempDirs);

const sha256 = (input: Buffer): string =>
  `sha256:${createHash("sha256").update(input).digest("hex")}`;

const emittedResult = () => ({
  schema: "repo-factory.result.v2",
  runId: "run-pairing-fixture",
  bootstrapOperationId: "op-pairing-fixture",
  planDigest: "sha256:" + "1".repeat(64),
  projectManifestDigest: "sha256:" + "2".repeat(64),
  repositories: [
    {
      role: "primary",
      identity: "github:acme/pairing-fixture",
      proposedCheckoutPath: null,
      defaultBranch: "dev",
      createdBranches: ["main", "dev"],
    },
  ],
  externalWriteReceipts: [
    {
      bootstrapOperationId: "op-pairing-fixture",
      requestDigest: "sha256:" + "3".repeat(64),
      operationId: "create-repository",
      resourceType: "repository",
      resourceIdentity: "github:acme/pairing-fixture",
      preexisting: false,
      beforeStateDigest: null,
      afterStateDigest: "sha256:" + "4".repeat(64),
      createdAt: "2026-08-30T00:00:00.000Z",
      rereadAt: "2026-08-30T00:00:01.000Z",
      verified: true,
    },
  ],
  bootstrapVerification: [
    {
      commandId: "test",
      repositoryIdentity: "github:acme/pairing-fixture",
      exactHead: "a".repeat(40),
      status: "PASS",
    },
  ],
  ciEvidence: [],
  unresolvedGaps: [],
});

it("pairs an emitted result with the actual ACP parser", () => {
  const dir = tempDir("acp-rf-pair-");
  const resultPath = join(dir, "result.json");
  const evidencePath = join(dir, "pairing.json");
  const result = emittedResult();
  writeFileSync(resultPath, `${JSON.stringify(result)}\n`);

  execFileSync(
    process.execPath,
    ["--import", "tsx", PAIR, "--result", resultPath, "--repo-factory-commit", REPO_FACTORY_COMMIT, "--evidence", evidencePath],
    { cwd: ROOT, encoding: "utf8" },
  );

  const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as {
    schema: string;
    repoFactory: { commit: string; resultSha256: string };
    controlPlane: { commit: string; parserPath: string; parserSha256: string };
    repoFactoryResult: unknown;
    controlPlaneVerdict: { allowed: boolean; reasonCode: string };
  };
  expect(evidence).toMatchObject({
    schema: "agent-control-plane.repo-factory-pairing.v1",
    repoFactory: { commit: REPO_FACTORY_COMMIT, resultSha256: sha256(readFileSync(resultPath)) },
    controlPlane: {
      commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
      parserPath: "src/bootstrap/repo-factory-result.ts",
    },
    repoFactoryResult: result,
    controlPlaneVerdict: { allowed: true, reasonCode: "OK" },
  });
  expect(evidence.controlPlane.parserSha256).toMatch(/^sha256:[0-9a-f]{64}$/);

  const incompatiblePath = join(dir, "incompatible.json");
  const deniedEvidencePath = join(dir, "denied-pairing.json");
  writeFileSync(incompatiblePath, JSON.stringify({ ...result, schema: "repo-factory.result.v1" }));
  const denied = spawnSync(
    process.execPath,
    ["--import", "tsx", PAIR, "--result", incompatiblePath, "--repo-factory-commit", REPO_FACTORY_COMMIT, "--evidence", deniedEvidencePath],
    { cwd: ROOT, encoding: "utf8" },
  );
  expect(denied.status).toBe(1);
  expect(JSON.parse(readFileSync(deniedEvidencePath, "utf8")).controlPlaneVerdict).toMatchObject({
    allowed: false,
    reasonCode: "BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT",
  });
});
