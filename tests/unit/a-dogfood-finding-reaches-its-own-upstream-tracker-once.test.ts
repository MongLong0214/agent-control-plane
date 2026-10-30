import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { judgeCommitLoreRuns } from "../../src/bootstrap/commitlore-observation.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { acpError } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { GitHubClient } from "../../src/github/github-kernel.ts";
import {
  type DogfoodFindingInput,
  type DogfoodRecord,
  DogfoodFindingStore,
  UPSTREAM_REPOSITORIES,
  UpstreamDogfoodReporter,
  commitloreObservationFinding,
  findingKey,
  githubUpstreamIssuePort,
  splitAcrossProducts,
} from "../../src/quality/upstream-dogfood.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

const CL = UPSTREAM_REPOSITORIES.commitlore;
const FS = UPSTREAM_REPOSITORIES["frontier-simplify"];

interface FakeIssue {
  number: number;
  state: "open" | "closed";
  title: string;
  body: string;
  repo: string;
  comments: Array<{ id: number; body: string }>;
}

const answered = (status: number): Error => acpError(ReasonCode.INVALID_ARGUMENT, `GitHub answered ${status}`, { status });

/** An in-memory GitHub behind the real port: issues, comments, search, and the faults a tracker has. */
class FakeTracker implements GitHubClient {
  issues: FakeIssue[] = [];
  calls: string[] = [];
  /** Thrown before the request reaches the tracker: nothing happens there. */
  failBefore: Array<{ match: RegExp; error: () => Error; times: number }> = [];
  /** The tracker applies the write, then the answer is lost. */
  loseAnswer: RegExp[] = [];
  /** The search index has not seen anything yet. */
  searchLags = false;
  /** Runs on each issue the tracker creates, as an edit by someone else would. */
  onCreate: ((issue: FakeIssue) => void) | null = null;
  #next = 1;
  #nextComment = 9000;

  async request<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    const call = `${method} ${path}`;
    this.calls.push(call);
    const fault = this.failBefore.find((entry) => entry.times > 0 && entry.match.test(call));
    if (fault) {
      fault.times -= 1;
      throw fault.error();
    }
    const result = this.#handle(method, path, body as Record<string, string> | undefined);
    const lost = this.loseAnswer.findIndex((match) => match.test(call));
    if (lost >= 0) {
      this.loseAnswer.splice(lost, 1);
      throw new Error("socket hang up");
    }
    return result as T;
  }

  writes(): string[] {
    return this.calls.filter((call) => call.startsWith("POST"));
  }

  #raw(issue: FakeIssue) {
    return {
      number: issue.number,
      state: issue.state,
      title: issue.title,
      body: issue.body,
      html_url: `https://github.com/${issue.repo}/issues/${issue.number}`,
      repository_url: `https://api.github.com/repos/${issue.repo}`,
    };
  }

  #comment(issue: FakeIssue, comment: { id: number; body: string }) {
    return { id: comment.id, body: comment.body, html_url: `https://github.com/${issue.repo}/issues/${issue.number}#issuecomment-${comment.id}` };
  }

  #handle(method: string, path: string, body: Record<string, string> | undefined): unknown {
    const url = new URL(`https://api.github.com${path}`);
    if (method === "GET" && url.pathname === "/search/issues") {
      if (this.searchLags) return { items: [] };
      const [token, repo] = url.searchParams.get("q")!.split(" ");
      return { items: this.issues.filter((issue) => `repo:${issue.repo}` === repo && issue.body.includes(token!)).map((issue) => this.#raw(issue)) };
    }
    const list = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(url.pathname);
    if (list && method === "GET") {
      return this.issues.filter((issue) => issue.repo === list[1]).sort((a, b) => b.number - a.number).slice(0, 100).map((issue) => this.#raw(issue));
    }
    if (list && method === "POST") {
      const issue: FakeIssue = { number: this.#next++, state: "open", title: body!["title"]!, body: body!["body"]!, repo: list[1]!, comments: [] };
      this.issues.push(issue);
      this.onCreate?.(issue);
      return this.#raw(issue);
    }
    const one = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(url.pathname);
    const find = (repo: string, number: string) => this.issues.find((issue) => issue.repo === repo && issue.number === Number(number));
    if (one && method === "GET") {
      const issue = find(one[1]!, one[2]!);
      if (!issue) throw answered(404);
      return this.#raw(issue);
    }
    const comments = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(url.pathname);
    if (comments) {
      const issue = find(comments[1]!, comments[2]!);
      if (!issue) throw answered(404);
      if (method === "GET") return Number(url.searchParams.get("page")) > 1 ? [] : issue.comments.map((comment) => this.#comment(issue, comment));
      const comment = { id: this.#nextComment++, body: body!["body"]! };
      issue.comments.push(comment);
      return this.#comment(issue, comment);
    }
    const comment = /^\/repos\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)$/.exec(url.pathname);
    if (comment && method === "GET") {
      for (const issue of this.issues.filter((candidate) => candidate.repo === comment[1])) {
        const found = issue.comments.find((candidate) => candidate.id === Number(comment[2]));
        if (found) return this.#comment(issue, found);
      }
    }
    throw answered(404);
  }
}

const finding = (over: Partial<DogfoodFindingInput> = {}): DogfoodFindingInput => ({
  product: "frontier-simplify",
  kind: "improvement",
  cause: "product",
  basis: "observed",
  reproduced: true,
  signature: "method.no-stop-rule-for-review-rounds",
  source: "review.round-summary",
  privateEvidenceRef: "review-round-7",
  title: "State when a review round may stop",
  problem: "Reviewers repeat rounds on a change with no new finding because the method names no stop rule.",
  expected: "The method says a round with no new finding ends the review.",
  actual: "A third round re-raised two findings already answered.",
  reproduction: "Review one change three times with the method; compare the findings.",
  productRevision: "0d788506",
  impact: "Review time spent on rounds that find nothing new.",
  workaround: "The caller stops after a round with no new finding.",
  ...over,
});

const setup = (options: { maxAttempts?: number } = {}) => {
  const directory = join(tempDir("acp-dogfood-"), "findings");
  const clock = new ManualClock("2026-10-30T00:00:00.000Z");
  const tracker = new FakeTracker();
  const port = githubUpstreamIssuePort(tracker);
  const store = new DogfoodFindingStore(directory, clock);
  const reporter = () => new UpstreamDogfoodReporter(new DogfoodFindingStore(directory, clock), port, { clock, backoffMs: 1000, ...options });
  return { directory, clock, tracker, port, store, reporter };
};

const recorded = (store: DogfoodFindingStore, input: DogfoodFindingInput): DogfoodRecord => {
  const decision = store.record(input);
  if (!decision.allowed) throw new Error(`not recorded: ${decision.message}`);
  return decision.value;
};

const doctor = (stdout: object, exitCode = 0) => judgeCommitLoreRuns({ exitCode: 0, stdout: "", stderr: "" }, { exitCode, stdout: JSON.stringify(stdout), stderr: "" });

describe("a dogfood finding reaches its own upstream tracker once, and is read back there", () => {
  it("a CommitLore doctor whose report contradicts its exit code becomes a CommitLore issue, read back and linked", async () => {
    const { tracker, store, reporter } = setup();
    const observation = doctor({ schema: "commitlore_doctor.v2", status: "failed", checks: [{ id: "hooks", status: "fail", detail: "hook missing" }] });
    expect(observation.outcome).toBe("FAIL");
    const input = commitloreObservationFinding(observation, { productRevision: "1.7.5", privateEvidenceRef: "attempt-3 observation record" });
    expect(input).toMatchObject({ product: "commitlore", cause: "product", signature: "doctor.report-contradicts-exit-code" });
    const record = recorded(store, input!);
    expect(record.state.status).toBe("QUEUED");

    const summary = await reporter().reportDue();
    expect(summary.linked).toEqual([record.id]);
    expect(tracker.issues.map((issue) => issue.repo)).toEqual([CL]);
    const [issue] = tracker.issues;
    expect(issue!.body).toContain(`acpdogfood${record.key}`);
    expect(issue!.body).toContain("Product revision: `1.7.5`");
    expect(issue!.body).toContain("Basis: observed.");
    expect(issue!.body).not.toContain("attempt-3 observation record");
    const linked = store.get(record.id)!.state;
    expect(linked).toMatchObject({ status: "LINKED", action: "created", issueNumber: issue!.number, url: `https://github.com/${CL}/issues/${issue!.number}` });
    // A readback is what links it: the create and the read of that exact issue both happened.
    expect(tracker.calls).toContain(`GET /repos/${CL}/issues/${issue!.number}`);
  });

  it("a frontier-simplify improvement goes to the frontier-simplify tracker", async () => {
    const { tracker, store, reporter } = setup();
    const record = recorded(store, finding());
    await reporter().reportDue();
    expect(tracker.issues.map((issue) => [issue.repo, issue.title])).toEqual([[FS, "State when a review round may stop"]]);
    expect(tracker.issues[0]!.body).toContain("## Use case");
    expect(store.get(record.id)!.state.status).toBe("LINKED");
  });

  it("a normal refusal, caller misuse, the environment and an undetermined cause are kept with their reason and sent nowhere", async () => {
    const { tracker, store, reporter } = setup();
    const refusal = commitloreObservationFinding(
      doctor({ schema: "commitlore_doctor.v2", status: "failed", checks: [{ id: "hooks", status: "fail" }] }, 1),
      { productRevision: "1.7.5", privateEvidenceRef: "observation a" },
    )!;
    const notRun = commitloreObservationFinding(judgeCommitLoreRuns(null, null), { productRevision: "1.7.5", privateEvidenceRef: "observation b" })!;
    const initFailed = commitloreObservationFinding(
      judgeCommitLoreRuns({ exitCode: 2, stdout: "", stderr: "boom" }, null),
      { productRevision: "1.7.5", privateEvidenceRef: "observation c" },
    )!;
    const misuse = finding({ kind: "defect", cause: "caller_misuse", privateEvidenceRef: "transcript d" });
    const reasons = [refusal, notRun, initFailed, misuse].map((input) => {
      const record = recorded(store, input);
      return [record.state.status === "NOT_REPORTED" ? record.state.reason : record.state.status, record.privateEvidenceRef];
    });
    expect(reasons).toEqual([
      ["NORMAL_REFUSAL", "observation a"],
      ["ENVIRONMENT", "observation b"],
      ["CAUSE_UNDETERMINED", "observation c"],
      ["CALLER_MISUSE", "transcript d"],
    ]);
    await reporter().reportDue();
    expect(tracker.calls).toEqual([]);
    expect(store.list().records).toHaveLength(4);
  });

  it("one finding from a restart or another project is one record and one issue; new evidence is one comment, repeated evidence none", async () => {
    const { directory, clock, tracker, store, reporter } = setup();
    const first = recorded(store, finding({ reproduction: "Review /Users/example/p1/change.diff three times." }));
    const again = new DogfoodFindingStore(directory, clock).record(finding({ reproduction: "Review /Users/sample/p2/change.diff three times." }));
    expect(again.allowed && again.value.id).toBe(first.id);
    expect(again.allowed && again.evidence["replayed"]).toBe(true);
    // The same error text under another cause is another finding, not a duplicate.
    expect(findingKey(finding({ signature: "method.other-cause", reproduction: "Review /Users/example/p1/change.diff three times." }))).not.toBe(first.key);

    await reporter().reportDue();
    expect(tracker.issues).toHaveLength(1);

    const newer = recorded(store, finding({ reproduction: "Review /Users/sample/p3/change.diff three times.", productRevision: "1a2b3c4d" }));
    expect(newer.key).toBe(first.key);
    await reporter().reportDue();
    expect(tracker.issues).toHaveLength(1);
    expect(tracker.issues[0]!.comments).toHaveLength(1);
    expect(store.get(newer.id)!.state).toMatchObject({ status: "LINKED", action: "commented" });

    store.record(finding({ reproduction: "Review /Users/sample/p3/change.diff three times.", productRevision: "1a2b3c4d" }));
    await reporter().reportDue();
    expect(tracker.issues[0]!.comments).toHaveLength(1);
    expect(tracker.writes()).toHaveLength(2);
  });

  it("a closed issue: the revision it records links as it is, a new revision opens a regression naming it", async () => {
    const { tracker, store, reporter } = setup();
    recorded(store, finding({ kind: "defect", productRevision: "rev-a" }));
    await reporter().reportDue();
    tracker.issues[0]!.state = "closed";

    const stale = recorded(store, finding({ kind: "defect", productRevision: "rev-a", actual: "Seen again on the old revision." }));
    await reporter().reportDue();
    expect(store.get(stale.id)!.state).toMatchObject({ status: "LINKED", action: "existing", issueNumber: 1 });
    expect(tracker.writes()).toHaveLength(1);

    const regression = recorded(store, finding({ kind: "defect", productRevision: "rev-b" }));
    await reporter().reportDue();
    expect(tracker.issues).toHaveLength(2);
    expect(tracker.issues[1]!.title).toBe("Regression: State when a review round may stop");
    expect(tracker.issues[1]!.body).toContain(`Previously reported as https://github.com/${FS}/issues/1`);
    expect(store.get(regression.id)!.state).toMatchObject({ status: "LINKED", action: "regression", issueNumber: 2 });
  });

  it("a finding across both products is split, each side to its own tracker, cross-linked", async () => {
    const { tracker, store, reporter } = setup();
    const shared = finding();
    const [commitlore, frontier] = splitAcrossProducts(
      { ...shared, kind: "defect" },
      [
        { product: "commitlore", signature: "capture.rejects-review-record", expected: "CommitLore accepts the record the method asks for.", productRevision: "1.7.5" },
        { product: "frontier-simplify", signature: "method.asks-unrecordable-record", expected: "The method asks only for a record CommitLore accepts.", productRevision: "0d788506" },
      ],
    );
    const left = recorded(store, commitlore);
    const right = recorded(store, frontier);
    await reporter().reportDue();
    expect(tracker.issues.map((issue) => issue.repo).sort()).toEqual([CL, FS].sort());
    const bodyOf = (repo: string) => tracker.issues.find((issue) => issue.repo === repo)!.body;
    expect(bodyOf(CL)).toContain("## Related");
    expect(bodyOf(FS)).toContain("## Related");
    expect(bodyOf(CL)).toMatch(new RegExp(`acpdogfood${right.key}|github\\.com/${FS}/issues/`));
    expect(bodyOf(FS)).toMatch(new RegExp(`acpdogfood${left.key}|github\\.com/${CL}/issues/`));
    // The side reported second names the first by its URL.
    expect([bodyOf(CL), bodyOf(FS)].some((body) => /https:\/\/github\.com\/MongLong0214\/[a-z-]+\/issues\/\d+\./.test(body))).toBe(true);
  });

  it("secrets, local paths, ids and the private reference never reach the tracker or the stored record", async () => {
    const { directory, tracker, store, reporter } = setup();
    const token = `ghp_${"A1b2C3d4".repeat(5)}`;
    const record = recorded(
      store,
      finding({
        title: "Review of /Users/example/work/app stalls",
        actual: `Failed with ${token} for dev@example.com in session_ABCDEFGH1234 and run_0123456789abcdef01234567.`,
        evidence: `stderr: ${token}`,
        privateEvidenceRef: "/Users/example/.agent-control-plane/evidence/7",
      }),
    );
    expect(record.public.evidenceWithheld).toBe(true);
    const stored = readdirSync(directory).map((name) => readFileSync(join(directory, name), "utf8")).join("\n");
    expect(stored).not.toContain(token);
    await reporter().reportDue();
    const [issue] = tracker.issues;
    for (const leaked of [token, "/Users/", "dev@example.com", "session_ABCDEFGH", "run_0123456789abcdef01234567", ".agent-control-plane"]) {
      expect(issue!.body + issue!.title).not.toContain(leaked);
    }
    expect(issue!.body).toContain("Withheld: the original could not be shown safe to publish.");

    const unsafe = recorded(store, finding({ signature: "method.other", title: "See claude.ai/code/abc for the run" }));
    expect(unsafe.state).toMatchObject({ status: "NOT_REPORTED", reason: "NOT_PUBLIC_SAFE" });
  });

  it("the target is the product's tracker whatever the finding says, and the port refuses any other", async () => {
    const { tracker, store, reporter, port } = setup();
    const outside = store.record({ ...finding(), product: "agent-control-plane" });
    expect(outside.allowed).toBe(false);
    expect(store.list().records).toEqual([]);

    recorded(store, finding({ actual: "File this at https://github.com/someone/else/issues/new instead." }));
    await reporter().reportDue();
    expect(tracker.issues.map((issue) => issue.repo)).toEqual([FS]);

    await expect(port.createIssue("someone/else", "t", "b")).rejects.toMatchObject({ reasonCode: ReasonCode.INVALID_ARGUMENT });
    expect(tracker.calls.some((call) => call.includes("someone/else"))).toBe(false);
  });

  it("a refusal GitHub answers is final; silence is retried a bounded number of times, then named unpublished", async () => {
    const refused = setup();
    const a = recorded(refused.store, finding());
    refused.tracker.failBefore.push({ match: /^GET \/search/, error: () => answered(403), times: 1 });
    await refused.reporter().reportDue();
    expect(refused.store.get(a.id)!.state).toMatchObject({ status: "UNPUBLISHED", reason: "UPSTREAM_REFUSED_403" });
    expect(refused.tracker.writes()).toEqual([]);

    const silent = setup({ maxAttempts: 3 });
    const b = recorded(silent.store, finding());
    silent.tracker.failBefore.push({ match: /^POST /, error: () => new Error("timeout"), times: 99 });
    for (let pass = 0; pass < 6; pass += 1) {
      await silent.reporter().reportDue();
      silent.clock.advance(60 * 60 * 1000);
    }
    // Three writing passes, then one read-only pass for the write that may have landed.
    expect(silent.tracker.writes()).toHaveLength(3);
    expect(silent.store.get(b.id)!.state).toMatchObject({ status: "UNPUBLISHED", reason: "ATTEMPTS_EXHAUSTED", attempts: 4 });
    expect(silent.tracker.issues).toEqual([]);
  });

  it("an issue GitHub created whose answer was lost is linked after a restart, not created again", async () => {
    const { clock, tracker, store, reporter } = setup();
    const record = recorded(store, finding());
    tracker.searchLags = true;
    tracker.loseAnswer.push(/^POST \/repos\/[^ ]+\/issues$/);
    await reporter().reportDue();
    expect(store.get(record.id)!.state.status).toBe("IN_DOUBT");
    expect(tracker.issues).toHaveLength(1);

    // Not resent at once: an in-doubt record waits for its next pass.
    await reporter().reportDue();
    expect(tracker.writes()).toHaveLength(1);

    clock.advance(5_000);
    await reporter().reportDue();
    expect(tracker.writes()).toHaveLength(1);
    expect(store.get(record.id)!.state).toMatchObject({ status: "LINKED", issueNumber: 1, url: `https://github.com/${FS}/issues/1` });
  });

  it("a comment whose answer was lost is linked after a restart, not posted again", async () => {
    const { clock, tracker, store, reporter } = setup();
    recorded(store, finding());
    await reporter().reportDue();
    const newer = recorded(store, finding({ productRevision: "1a2b3c4d" }));
    tracker.loseAnswer.push(/^POST .*\/comments$/);
    await reporter().reportDue();
    expect(store.get(newer.id)!.state.status).toBe("IN_DOUBT");
    clock.advance(5_000);
    await reporter().reportDue();
    expect(tracker.issues[0]!.comments).toHaveLength(1);
    expect(store.get(newer.id)!.state).toMatchObject({ status: "LINKED", commentId: tracker.issues[0]!.comments[0]!.id });
  });

  it("a write the readback does not show is not counted as published", async () => {
    const { tracker, store, reporter } = setup();
    const record = recorded(store, finding());
    tracker.onCreate = (issue) => {
      issue.body = "edited away";
    };
    await reporter().reportDue();
    expect(store.get(record.id)!.state).toMatchObject({ status: "IN_DOUBT", lastError: "READBACK_MISMATCH" });
  });

  it("two passes over one finding write one issue", async () => {
    const { tracker, store, reporter } = setup();
    recorded(store, finding());
    const shared = reporter();
    await Promise.all([shared.reportDue(), shared.reportDue()]);
    expect(tracker.issues).toHaveLength(1);
  });

  it("a tracker that fails for one product neither escapes the pass nor holds the other product's finding", async () => {
    const { tracker, store, reporter, directory } = setup();
    const stuck = recorded(store, commitloreObservationFinding(
      doctor({ schema: "commitlore_doctor.v2", status: "ok", checks: [], exitCode: 3 }),
      { productRevision: "1.7.5", privateEvidenceRef: "observation e" },
    )!);
    const moving = recorded(store, finding());
    tracker.failBefore.push({ match: new RegExp(`repo%3A${CL.replace("/", "%2F")}`), error: () => new TypeError("fetch failed"), times: 1 });
    writeFileSync(join(directory, "0000.json"), "not a record\n", { mode: 0o600 });
    const summary = await reporter().reportDue();
    expect(summary.linked).toEqual([moving.id]);
    expect(summary.waiting).toEqual([stuck.id]);
    expect(summary.unreadable).toEqual(["0000.json"]);
    expect(store.get(stuck.id)!.state).toMatchObject({ status: "QUEUED", attempts: 1, lastError: "no answer from GitHub" });
  });
});
