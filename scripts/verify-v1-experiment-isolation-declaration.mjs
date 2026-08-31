#!/usr/bin/env node
/**
 * #416 originally shipped only `validateExperimentIsolation` plus a declaration that V1 had
 * nothing to consume it: this script's job was to catch a *second*, undeclared consumer
 * appearing anywhere in `src` while that claim stood — a caller that opened experiment state or
 * threaded the validation's fields through code the declaration said did not exist.
 *
 * That premise is gone. `Db`'s constructor (`src/db/database.ts`) now consumes this validation
 * as a real write-denial gate before it opens a handle for a declared experiment context, and the
 * isolation module's own `runtimeEnforcement` field says so (`"ENFORCED_AT_DB_OPEN"`). So the
 * question this script answers changed with it: it no longer asks "does anything touch these
 * tokens" (the honest answer is now yes, on purpose, at exactly one place) — it asks "does
 * anything touch them *outside* the one place the isolation module claims does". `AUTHORIZED_CONSUMERS`
 * is that allowlist. A hit inside it is the sanctioned wiring; a hit anywhere else is exactly the
 * silent-second-consumer drift this script was built to catch, and still fails the build.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootArg = process.argv.find((arg) => arg.startsWith("--root="));
const repoRoot = rootArg
  ? resolve(rootArg.slice("--root=".length))
  : fileURLToPath(new URL("..", import.meta.url));
const asJson = process.argv.includes("--json");
const ISOLATION_MODULE = "src/export/experiment-isolation.ts";

/**
 * The only file(s) permitted to consume `validateExperimentIsolation`'s fields outside the
 * isolation module itself. `Db`'s constructor is the enforcement point the isolation module's
 * own `enforcementPoint` field names (#416) — keep the two in sync by hand; a rename on either
 * side that does not move the other is exactly the drift this script exists to catch.
 */
const AUTHORIZED_CONSUMERS = new Set(["src/db/database.ts"]);

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
const authorizedConsumers = {
  experimentDatabasePath: [],
  experimentArtifactRoot: [],
  validatorConsumer: [],
};
for (const file of sourceFiles) {
  const source = executableSource(readFileSync(join(repoRoot, file), "utf8"));
  const bucket = AUTHORIZED_CONSUMERS.has(file) ? authorizedConsumers : candidates;
  bucket.experimentDatabasePath.push(...locations(file, source, /\bexperimentDatabasePath\b/g));
  bucket.experimentArtifactRoot.push(...locations(file, source, /\bexperimentArtifactRoot\b/g));
  bucket.validatorConsumer.push(
    ...locations(file, source, /\bExperimentIsolationValidation\b/g),
    ...locations(file, source, /\bvalidateExperimentIsolation\s*\(/g),
  );
}

const isolationSource = readFileSync(join(repoRoot, ISOLATION_MODULE), "utf8");
const runtimeEnforcementDeclarations = locations(
  ISOLATION_MODULE,
  isolationSource,
  /\bruntimeEnforcement\s*:\s*"ENFORCED_AT_DB_OPEN"/g,
);
const candidateCount = Object.values(candidates).reduce((count, locations) => count + locations.length, 0);
const active = runtimeEnforcementDeclarations.length > 0;
const report = {
  active,
  scannedFileCount: sourceFiles.length,
  runtimeEnforcementDeclarations,
  candidates,
  authorizedConsumers,
};

if (asJson) {
  process.stdout.write(`${JSON.stringify(report)}\n`);
} else if (active) {
  process.stdout.write(
    `V1 experiment isolation scanned ${sourceFiles.length} source file(s): unauthorized database paths ${candidates.experimentDatabasePath.length}, unauthorized artifact roots ${candidates.experimentArtifactRoot.length}, unauthorized validator consumers ${candidates.validatorConsumer.length}.\n`,
  );
} else {
  process.stdout.write("No ENFORCED_AT_DB_OPEN declaration is present, so the V1 enforcement census is inactive.\n");
}

if (active && candidateCount > 0) {
  for (const [kind, hits] of Object.entries(candidates)) {
    for (const hit of hits) process.stderr.write(`${kind}: ${hit}\n`);
  }
  process.stderr.write(
    `ENFORCED_AT_DB_OPEN names ${[...AUTHORIZED_CONSUMERS].join(", ")} as the only authorized consumer(s), but another source file references experiment-state tokens.\n`,
  );
  process.exit(1);
}

if (!asJson) {
  process.stdout.write("Static tokens identify named V1 boundary candidates and do not prove ACP 2.0 runtime enforcement.\n");
}
