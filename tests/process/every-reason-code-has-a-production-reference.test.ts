import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const script = join(root, "scripts", "verify-reason-code-usage.mjs");

interface Census {
  exitCode: number | null;
  problems: string[];
  unreferenced: unknown[];
  notes: string[];
}

const census = (): Census => {
  const result = spawnSync(process.execPath, [script, "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  try {
    return {
      exitCode: result.status,
      ...(JSON.parse(result.stdout) as Omit<Census, "exitCode">),
    };
  } catch {
    throw new Error(`reason-code census did not return JSON:\n${result.stdout}${result.stderr}`);
  }
};

/** Every declared reason code has a production reference. */
it("every declared reason code has a production reference", () => {
  const result = census();

  expect(result.unreferenced).toEqual([]);
  expect(result.problems).toEqual([]);
  expect(result.exitCode).toBe(0);
});

/** Staleness classifications name declared reason codes. */
it("staleness classifications name declared reason codes", () => {
  const result = census();

  expect(result.problems).toEqual([]);
  expect(result.exitCode).toBe(0);
});

/** Production trigger denials and mappings agree. */
it("production trigger denials and mappings agree", () => {
  const result = census();

  expect(result.exitCode).toBe(0);
  expect(result.problems).toEqual([]);
  expect(result.notes).toEqual([]);
});
