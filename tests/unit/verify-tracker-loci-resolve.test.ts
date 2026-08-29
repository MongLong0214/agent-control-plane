import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface IssueFixture {
  number: number;
  title: string;
  body: string;
  url?: string;
}

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const scriptPath = join(repoRoot, "scripts", "verify-tracker-loci-resolve.mjs");

/** Writes a throwaway `--issues-file` fixture and returns its path plus a cleanup function. */
const withIssues = (issues: IssueFixture[]) => {
  const dir = mkdtempSync(join(tmpdir(), "acp-tracker-loci-"));
  const path = join(dir, "issues.json");
  writeFileSync(path, JSON.stringify(issues, null, 2));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

const run = (issuesPath: string, extraArgs: string[] = []) =>
  spawnSync(process.execPath, [scriptPath, `--issues-file=${issuesPath}`, ...extraArgs], {
    cwd: repoRoot,
    encoding: "utf8",
  });

describe("verify-tracker-loci-resolve", () => {
  it("#649: finds the real citation #657 made stale — binding-registry.ts:163 no longer unconditionally mints", () => {
    // The actual body text of #649, trimmed to the fenced block carrying the citation. #657
    // ("reconstitution reuses the actor a verified target names") rewrote `bind()` so line 163
    // is not this assignment any more, and the assignment does not appear anywhere nearby in the
    // file either — the one place it still exists verbatim is an unrelated method ~225 lines
    // away (#449's deliberate unconditional mint on role replacement), which this check must not
    // credit as the cited line surviving.
    const body = [
      "## A — one Hermes root, two ACP actors",
      "",
      "```",
      "hermes-bootstrap.ts:121-146   reconstitution is allowed when no active CEO exists (#619)",
      "hermes-bootstrap.ts:341       calls bindings.bind()",
      "binding-registry.ts:163       const actorId = this.mintActor(...)   ← always mints",
      "```",
      "",
      "`bind()` has no path that reuses an actor.",
    ].join("\n");
    const { path, cleanup } = withIssues([{ number: 649, title: "two ACP actors", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("binding-registry.ts:163");
      expect(result.stdout).toContain("no longer appears");
      // The two citations this check must NOT flag: a prose description ("reconstitution is
      // allowed…") and a paraphrase around a real call ("calls bindings.bind()") that is still
      // there — both should read as ADVISORY (still resolves), never STALE.
      expect(result.stdout).toContain("hermes-bootstrap.ts:121-146");
      expect(result.stdout).toContain("hermes-bootstrap.ts:341");
    } finally {
      cleanup();
    }
  });

  it("reports a missing file loudly", () => {
    const body = "The fix lives in `src/does/not/exist.ts:42`, which handles the retry.";
    const { path, cleanup } = withIssues([{ number: 9001, title: "missing file", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("src/does/not/exist.ts does not exist");
    } finally {
      cleanup();
    }
  });

  it("flags a /private/tmp citation as its own category, distinct from STALE", () => {
    // The #603/#676 shape: a ticket asserting custody over something under a scratchpad.
    const body =
      "Evidence for this was captured at `/private/tmp/acp-probe/scratch/derive3.py` and " +
      "the residual-zero census depends on it.";
    const { path, cleanup } = withIssues([{ number: 9002, title: "scratch custody", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("NON_DURABLE");
      expect(result.stdout).toContain("/private/tmp/acp-probe/scratch/derive3.py");
      expect(result.stdout).toContain("commit it, or accept it is gone");
    } finally {
      cleanup();
    }
  });

  it("is silent on a subset with nothing to report", () => {
    // A bare path with no line number that resolves cleanly, and nothing else. Requirement 4:
    // a check that always prints becomes noise and stops being read.
    const body = "See `package.json` for the script list.";
    const { path, cleanup } = withIssues([{ number: 9003, title: "clean citation", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    } finally {
      cleanup();
    }
  });

  it("an in-range file:line citation is ADVISORY, not a failure, unless --strict", () => {
    const body = "The status banner is at `README.md:1`.";
    const { path, cleanup } = withIssues([{ number: 9004, title: "advisory only", body }]);
    try {
      const plain = run(path);
      expect(plain.status).toBe(0);
      expect(plain.stdout).toContain("ADVISORY");
      expect(plain.stdout).toContain("README.md:1");
      expect(plain.stdout).toContain("line numbers rot");

      const strict = run(path, ["--strict"]);
      expect(strict.status).toBe(1);
      expect(strict.stdout).toContain("ADVISORY");
    } finally {
      cleanup();
    }
  });

  it("a symbol citation in the repo's `path` — `symbol` table convention resolves silently", () => {
    const body = "`src/continuity/continuity-kernel.ts` — `failover`";
    const { path, cleanup } = withIssues([{ number: 9005, title: "symbol resolves", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      cleanup();
    }
  });

  it("a symbol citation that does not resolve anywhere under src/ is STALE", () => {
    const body = "`src/continuity/continuity-kernel.ts` — `definitelyNotARealSymbolXYZ`";
    const { path, cleanup } = withIssues([{ number: 9006, title: "symbol missing", body }]);
    try {
      const result = run(path);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("STALE");
      expect(result.stdout).toContain("definitelyNotARealSymbolXYZ");
      expect(result.stdout).toContain("does not resolve anywhere under src/");
    } finally {
      cleanup();
    }
  });

  it("--json emits parseable structured output", () => {
    const body = "`src/does/not/exist.ts:1` is the culprit.";
    const { path, cleanup } = withIssues([{ number: 9007, title: "json mode", body }]);
    try {
      const result = run(path, ["--json"]);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.stale.length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });
});
