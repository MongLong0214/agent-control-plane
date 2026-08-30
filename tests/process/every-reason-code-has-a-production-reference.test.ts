import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const script = join(root, "scripts", "verify-reason-code-usage.mjs");

interface Census {
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
    return JSON.parse(result.stdout) as Census;
  } catch {
    throw new Error(`reason-code census did not return JSON:\n${result.stdout}${result.stderr}`);
  }
};

/** Every declared reason code has a production reference. */
it("every declared reason code has a production reference", () => {
  expect(census().unreferenced).toEqual([]);
});

/** Every mapped trigger denial is raised by production DDL. */
it("every mapped trigger denial is raised by production DDL", () => {
  expect(census().notes).toEqual([]);
});
