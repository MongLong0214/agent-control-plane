import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A force-push leaves the run it supersedes running, and that run keeps its eight macOS jobs.
 *
 * Measured 2026-09-15, immediately after #943 was rebased past two merges:
 *
 *     34973735898  64dd3a35  in_progress   <- the head the pull request now points at
 *     34966057871  53806331  in_progress   <- the pre-rebase head, still holding slots
 *
 * Nothing in the repository cancelled the second; a person did. #885 measures the supply this runs
 * against -- eight macOS jobs per pull request against three to five concurrent -- and a rebase is
 * how a conflicting pull request is made mergeable, so a superseded run is ordinary traffic.
 *
 * These read the workflow text rather than a parsed document because this repository ships no YAML
 * parser, and a check that needed one would be a dependency added to assert three lines. Each case
 * below distinguishes a specific wrong value, not merely the presence of the key -- the dangerous
 * mistake here is not omitting the block but writing `cancel-in-progress: true`, which would cancel
 * the `main` run a merge started as soon as the next merge landed.
 */
const WORKFLOW = readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8");

/** The workflow-level block: at column zero, above `jobs:`, not one nested inside a job. */
const topLevelConcurrency = (): string | null => {
  const lines = WORKFLOW.split("\n");
  const at = lines.indexOf("concurrency:");
  if (at === -1) return null;
  const block: string[] = [];
  for (let i = at + 1; i < lines.length && (lines[i] === "" || lines[i]!.startsWith(" ")); i += 1) {
    block.push(lines[i]!);
  }
  return block.join("\n");
};

describe("a run a force-push superseded does not go on holding the queue", () => {
  it("declares a workflow-level concurrency group", () => {
    expect(
      topLevelConcurrency(),
      "project-ci has no concurrency group, so a superseded run keeps its eight macOS jobs",
    ).not.toBeNull();
  });

  it("groups by ref, so one pull request never cancels another", () => {
    // A group that is the workflow alone would make every open pull request share one slot: the
    // newest push would cancel whichever other PR happened to be running. That is the same queue
    // problem with the losses moved somewhere less visible.
    expect(topLevelConcurrency()).toMatch(/group:\s*\$\{\{\s*github\.workflow\s*\}\}-\$\{\{\s*github\.ref\s*\}\}/);
  });

  it("does not cancel a push, because main pushes share one group", () => {
    // The failure this forbids: `cancel-in-progress: true` groups every `main` push together and
    // cancels the run a merge started when the next merge lands. A cancelled run is `cancelled`,
    // which `verify-gate` and `guard-falsifiability-gate` both read as not-success -- so the cost
    // is a red `main` over a tree nothing tested, not a slow queue.
    const block = topLevelConcurrency() ?? "";
    expect(block).toMatch(/cancel-in-progress:/);
    expect(
      /cancel-in-progress:\s*true\s*$/m.test(block),
      "cancel-in-progress is unconditionally true, which cancels main's own runs",
    ).toBe(false);
    expect(block).toMatch(/github\.event_name\s*==\s*'pull_request'/);
  });
});
