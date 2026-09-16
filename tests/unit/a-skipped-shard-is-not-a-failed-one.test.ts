import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `main` was red on every merge for a day and a half while every pull request was green.
 *
 * The falsifiability shards opt out of `push` — a squash merge lands the tree the pull request
 * already swept, and the four shards are 81% of a main run's macOS minutes. The gate that requires
 * them did not learn that, so it read `needs.guard-falsifiability.result = skipped` and exited 1.
 * Measured: sixteen consecutive failing `push` runs from 2026-09-15T10:18, against a `schedule`
 * run on the same tree that passed.
 *
 * `skipped` is a third answer and it is not a failure. That is the whole defect, and it is the same
 * shape as three others measured the same week — an empty snapshot scored as uncovered, a timed-out
 * probe recorded as dead, a row that stopped being written read as healthy. Each had a vocabulary
 * with no word for *did not happen*, so it took the nearest definite one.
 *
 * The script is read out of `ci.yml` and run, rather than restated here. A copy of the logic would
 * pass while the workflow said something else, which is precisely how the original went unnoticed:
 * the shard job's `if:` and the gate's `if [ … ]` are one decision written in two places, and
 * nothing held them together.
 */
const GATE_STEP = "require every falsifiability shard to have actually succeeded";

/** The gate's own `run:` block, lifted from the workflow with its indentation removed. */
const gateScript = (): string => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8").split("\n");
  const step = workflow.findIndex((line) => line.includes(GATE_STEP));
  expect(step, `the workflow no longer has a step named "${GATE_STEP}"`).toBeGreaterThan(-1);
  const runAt = workflow.findIndex((line, index) => index > step && line.trim() === "run: |");
  expect(runAt, "the gate step no longer carries a `run: |` block").toBeGreaterThan(-1);
  const indent = (workflow[runAt + 1] ?? "").match(/^\s*/)?.[0] ?? "";
  const body: string[] = [];
  for (let index = runAt + 1; index < workflow.length; index += 1) {
    const line = workflow[index]!;
    if (line.trim() !== "" && !line.startsWith(indent)) break;
    body.push(line.slice(indent.length));
  }
  return body.join("\n");
};

/**
 * Actions substitutes `${{ … }}` before bash ever sees it, so the test does the same rather than
 * exporting shell variables the script does not read.
 */
const runGate = (shards: string, event: string): number => {
  const script = gateScript()
    .replaceAll("${{ needs.guard-falsifiability.result }}", shards)
    .replaceAll("${{ github.event_name }}", event);
  try {
    execFileSync("/bin/bash", ["-e", "-c", script], { stdio: "pipe", timeout: 10_000 });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? -1;
  }
};

describe("a skipped shard is not a failed one", () => {
  it("passes a push whose shards were skipped by the job's own opt-out", () => {
    expect(runGate("skipped", "push")).toBe(0);
  });

  /**
   * The direction that keeps the excuse from becoming "never check". A pull request is where the
   * sweep is supposed to run, so a skip there is the gate's whole reason to exist.
   */
  it("still fails a pull request whose shards were skipped", () => {
    expect(runGate("skipped", "pull_request")).toBe(1);
  });

  it("still fails a push whose shards actually failed", () => {
    expect(runGate("failure", "push")).toBe(1);
  });

  it("passes when the shards succeeded", () => {
    expect(runGate("success", "pull_request")).toBe(0);
    expect(runGate("success", "push")).toBe(0);
  });
});
