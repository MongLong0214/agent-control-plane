import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface IssueFixture {
  number: number;
  state: string;
  body?: string;
  comments?: Array<{ body?: string }>;
}

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const reportScript = join(repoRoot, "scripts", "ssot-report.mjs");
const issueFixture = join(repoRoot, "tests", "fixtures", "ssot-report-issues.json");

const runReport = (args: string[], cwd = repoRoot) =>
  spawnSync(process.execPath, [reportScript, ...args], {
    cwd,
    encoding: "utf8",
  });

const runIssueFixture = (state: "OPEN" | "CLOSED") => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "acp-ssot-issues-"));
  const issuesPath = join(fixtureDir, "issues.json");
  const issues = JSON.parse(readFileSync(issueFixture, "utf8")) as IssueFixture[];
  const issue = issues.find((candidate) => candidate.number === 45);
  if (!issue) throw new Error("the SSOT fixture must contain issue #45");
  issue.state = state;
  writeFileSync(issuesPath, JSON.stringify(issues, null, 2));

  try {
    return runReport([`--issues-file=${issuesPath}`]);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
};

const makeDocumentRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "acp-ssot-docs-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "README.md"), "> **Status: not production-ready.**\n");
  writeFileSync(join(root, "docs", "STATUS.md"), "# Current status and acceptance limits\n");
  writeFileSync(join(root, "docs", "OPERATIONS.md"), "# Operations\n");
  writeFileSync(join(root, "docs", "SECURITY.md"), "# Security\n");
  writeFileSync(join(root, "docs", "CONTRIBUTING.md"), "# Contributing\n");
  writeFileSync(join(root, "scripts", "file-open-work.mjs"), "const WORK = [];\n");
  const issuesPath = join(root, "issues.json");
  writeFileSync(issuesPath, "[]\n");
  return { root, issuesPath };
};

describe("SSOT report entry point", () => {
  it("#535: does not read an open issue's prose as a disposition", () => {
    // This asserted the opposite until #535: an OPEN issue whose text began with FIXED / STALE /
    // NOT APPLICABLE was reported as "recorded as resolved but still open".
    //
    // Measured across all 534 issues before removing it — machine marker: 0 users; prose fallback:
    // 5 matches, every one a false positive; genuine catches: 0. The matches were sentences
    // *about* those words ("Fixed the synthetic chain; the pinned file still failed"), and one of
    // them was cited during the day as the rule working. It was not.
    //
    // The cost was real: a comment on #533 beginning "Fixed in #534 — …", prose about a different
    // PR, was taken as #533's disposition and turned `main` red.
    //
    // So this test now pins the absence. Restoring the rule makes it fail, which is the point —
    // the numbers above live in the script's header so that reviving it is a decision someone
    // makes against evidence rather than a rediscovery of a plausible-looking check.
    const open = runIssueFixture("OPEN");
    expect(
      `${open.stdout}\n${open.stderr}`,
      "an open issue's prose was read as its disposition again",
    ).not.toContain("recorded disposition");
    expect(open.status).toBe(0);
    expect(open.stdout).toContain("SSOT reconciled");

    // Closing it changes nothing, because resolution is no longer inferred from text at all.
    const closed = runIssueFixture("CLOSED");
    expect(closed.status).toBe(0);
    expect(closed.stdout).toContain("SSOT reconciled");
  });

  it("fails through the report entry point when a public document or status section disappears", () => {
    const fixture = makeDocumentRoot();
    try {
      const baseline = runReport([
        `--repo-root=${fixture.root}`,
        `--issues-file=${fixture.issuesPath}`,
      ]);
      expect(baseline.status).toBe(0);

      rmSync(join(fixture.root, "docs", "SECURITY.md"));
      const missingDocument = runReport([
        `--repo-root=${fixture.root}`,
        `--issues-file=${fixture.issuesPath}`,
      ]);
      expect(missingDocument.status).toBe(1);
      expect(`${missingDocument.stdout}\n${missingDocument.stderr}`).toContain(
        "required public document missing: docs/SECURITY.md",
      );

      writeFileSync(join(fixture.root, "docs", "SECURITY.md"), "# Security\n");
      writeFileSync(join(fixture.root, "README.md"), "# No status banner\n");
      const missingStatus = runReport([
        `--repo-root=${fixture.root}`,
        `--issues-file=${fixture.issuesPath}`,
      ]);
      expect(missingStatus.status).toBe(1);
      expect(`${missingStatus.stdout}\n${missingStatus.stderr}`).toContain(
        "status section missing: README status banner in README.md",
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
