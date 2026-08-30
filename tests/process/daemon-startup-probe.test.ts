import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const script = fileURLToPath(new URL("../../scripts/probe-daemon-startup.ts", import.meta.url));

describe("the daemon startup probe", () => {
  it("records every startup decision without a fixture authority", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", script, "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 190_000,
    });
    const output = `${result.stdout}${result.stderr}`;
    const report = JSON.parse(result.stdout) as { stages: Array<Record<string, unknown>> };

    expect(result.error, output).toBeUndefined();
    expect(report.stages).toHaveLength(4);
    for (const stage of report.stages) expect(stage).not.toHaveProperty("error");
  });
});
