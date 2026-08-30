import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { parseRepoFactoryResult } from "../bootstrap/repo-factory-result.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PARSER_PATH = "src/bootstrap/repo-factory-result.ts";
const PAIRING_SCHEMA = "agent-control-plane.repo-factory-pairing.v1";

const sha256 = (input: string | Buffer): string =>
  `sha256:${createHash("sha256").update(input).digest("hex")}`;

const git = (args: readonly string[]): string =>
  execFileSync("git", [...args], { cwd: ROOT, encoding: "utf8" }).trim();

const parserIsDirty = (): boolean => {
  const differs = (args: readonly string[]) =>
    spawnSync("git", [...args], { cwd: ROOT, stdio: "ignore" }).status !== 0;
  return differs(["diff", "--quiet", "--", PARSER_PATH]) ||
    differs(["diff", "--cached", "--quiet", "--", PARSER_PATH]);
};

const main = (): void => {
  const { values } = parseArgs({
    options: {
      result: { type: "string" },
      evidence: { type: "string" },
      "repo-factory-commit": { type: "string" },
    },
    strict: true,
  });
  const resultPath = values.result;
  const evidencePath = values.evidence;
  const repoFactoryCommit = values["repo-factory-commit"];
  if (!resultPath || !evidencePath || !repoFactoryCommit) {
    throw new Error(
      "usage: pnpm repo-factory:pair --result <result.json> --repo-factory-commit <sha> --evidence <evidence.json>",
    );
  }
  if (!/^[0-9a-f]{40}$/.test(repoFactoryCommit)) {
    throw new Error("--repo-factory-commit must be a full 40-character lowercase Git SHA");
  }

  const resultBytes = readFileSync(resultPath);
  const result: unknown = JSON.parse(resultBytes.toString("utf8"));
  const decision = parseRepoFactoryResult(result);
  const parserBytes = readFileSync(fileURLToPath(new URL("../bootstrap/repo-factory-result.ts", import.meta.url)));
  const pairing = {
    schema: PAIRING_SCHEMA,
    capturedAt: new Date().toISOString(),
    repoFactory: {
      commit: repoFactoryCommit,
      resultSha256: sha256(resultBytes),
    },
    controlPlane: {
      commit: git(["rev-parse", "HEAD"]),
      parserPath: PARSER_PATH,
      parserSha256: sha256(parserBytes),
      parserDirty: parserIsDirty(),
    },
    repoFactoryResult: result,
    controlPlaneVerdict: {
      allowed: decision.allowed,
      reasonCode: decision.reasonCode,
      message: decision.allowed ? null : decision.message,
      evidence: decision.evidence,
    },
  };
  const serialized = `${JSON.stringify(pairing, null, 2)}\n`;

  // Evidence is append-only at the file boundary: a rerun must choose a new path rather
  // than silently replacing the first parser verdict for a live result.
  writeFileSync(evidencePath, serialized, { encoding: "utf8", flag: "wx" });
  process.stdout.write(serialized);
  if (!decision.allowed) process.exitCode = 1;
};

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
