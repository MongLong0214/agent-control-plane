#!/usr/bin/env node
/** #416 keeps V1's stated absence of enforcement honest but does not add ACP 2.0 runtime enforcement. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootArg = process.argv.find((arg) => arg.startsWith("--root="));
const repoRoot = rootArg
  ? resolve(rootArg.slice("--root=".length))
  : fileURLToPath(new URL("..", import.meta.url));
const asJson = process.argv.includes("--json");
const ISOLATION_MODULE = "src/export/experiment-isolation.ts";

const walk = (directory, files = []) => {
  for (const entry of readdirSync(join(repoRoot, directory)).sort()) {
    const relative = `${directory}/${entry}`;
    const stat = statSync(join(repoRoot, relative));
    if (stat.isDirectory()) walk(relative, files);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) files.push(relative);
  }
  return files;
};

/** Masks comments and quoted text because neither opens experiment state nor consumes a validation. */
const executableSource = (source) => {
  const chars = [...source];
  let state = "code";
  let escaped = false;
  for (let index = 0; index < chars.length; index += 1) {
    const character = chars[index];
    const next = chars[index + 1];
    if (state === "code") {
      if (character === "/" && next === "/") {
        chars[index] = chars[index + 1] = " ";
        state = "line-comment";
        index += 1;
      } else if (character === "/" && next === "*") {
        chars[index] = chars[index + 1] = " ";
        state = "block-comment";
        index += 1;
      } else if (character === "'" || character === '"' || character === "`") {
        chars[index] = " ";
        state = character === "'" ? "single" : character === '"' ? "double" : "template";
        escaped = false;
      }
      continue;
    }
    if (state === "line-comment") {
      if (character === "\n") state = "code";
      else chars[index] = " ";
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        chars[index] = chars[index + 1] = " ";
        state = "code";
        index += 1;
      } else if (character !== "\n") {
        chars[index] = " ";
      }
      continue;
    }
    if (character !== "\n") chars[index] = " ";
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (
      (state === "single" && character === "'") ||
      (state === "double" && character === '"') ||
      (state === "template" && character === "`")
    ) {
      state = "code";
    }
  }
  return chars.join("");
};

const locations = (file, source, pattern) =>
  [...source.matchAll(pattern)].map((match) => `${file}:${source.slice(0, match.index).split("\n").length}`);

const srcRoot = join(repoRoot, "src");
if (!existsSync(srcRoot)) {
  process.stderr.write(`verify-v1-experiment-isolation-declaration: ${srcRoot} does not exist\n`);
  process.exit(1);
}

const sourceFiles = walk("src").filter((file) => file !== ISOLATION_MODULE);
const candidates = {
  experimentDatabasePath: [],
  experimentArtifactRoot: [],
  validatorConsumer: [],
};
for (const file of sourceFiles) {
  const source = executableSource(readFileSync(join(repoRoot, file), "utf8"));
  candidates.experimentDatabasePath.push(...locations(file, source, /\bexperimentDatabasePath\b/g));
  candidates.experimentArtifactRoot.push(...locations(file, source, /\bexperimentArtifactRoot\b/g));
  candidates.validatorConsumer.push(
    ...locations(file, source, /\bExperimentIsolationValidation\b/g),
    ...locations(file, source, /\bvalidateExperimentIsolation\s*\(/g),
  );
}

const isolationSource = readFileSync(join(repoRoot, ISOLATION_MODULE), "utf8");
const runtimeEnforcementDeclarations = locations(
  ISOLATION_MODULE,
  isolationSource,
  /\bruntimeEnforcement\s*:\s*"NOT_AVAILABLE_IN_V1"/g,
);
const candidateCount = Object.values(candidates).reduce((count, locations) => count + locations.length, 0);
const active = runtimeEnforcementDeclarations.length > 0;
const report = {
  active,
  scannedFileCount: sourceFiles.length,
  runtimeEnforcementDeclarations,
  candidates,
};

if (asJson) {
  process.stdout.write(`${JSON.stringify(report)}\n`);
} else if (active) {
  process.stdout.write(
    `V1 experiment isolation scanned ${sourceFiles.length} source file(s): database paths ${candidates.experimentDatabasePath.length}, artifact roots ${candidates.experimentArtifactRoot.length}, validator consumers ${candidates.validatorConsumer.length}.\n`,
  );
} else {
  process.stdout.write("No NOT_AVAILABLE_IN_V1 declaration is present, so the V1 absence census is inactive.\n");
}

if (active && candidateCount > 0) {
  for (const [kind, hits] of Object.entries(candidates)) {
    for (const hit of hits) process.stderr.write(`${kind}: ${hit}\n`);
  }
  process.stderr.write(
    "NOT_AVAILABLE_IN_V1 declares no runtime enforcement, but V1 source contains experiment-state candidates.\n",
  );
  process.exit(1);
}

if (!asJson) {
  process.stdout.write("Static tokens identify named V1 boundary candidates and do not prove ACP 2.0 runtime enforcement.\n");
}
