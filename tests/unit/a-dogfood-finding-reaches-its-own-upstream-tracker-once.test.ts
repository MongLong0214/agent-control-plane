import { afterAll, describe, expect, it } from "vitest";

import { judgeCommitLoreRuns } from "../../src/bootstrap/commitlore-observation.ts";
import { acpError } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { GitHubClient } from "../../src/github/github-kernel.ts";
import {
  type DogfoodFindingInput,
  type DogfoodRecord,
  DOGFOOD_FINDING_KIND,
  DogfoodFindingStore,
  UPSTREAM_REPOSITORIES,
  UpstreamDogfoodReporter,
  commitloreObservationFinding,
  findingKey,
  githubUpstreamIssuePort,
  splitAcrossProducts,
} from "../../src/quality/upstream-dogfood.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { driveToReviewedCandidate, makeHarness } from "../helpers/harness.ts";

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
  product: "commitlore",
  kind: "improvement",
  cause: "product",
  basis: "observed",
  reproduced: true,
  signature: "capture.names-no-rejected-field",
  source: "test.boundary",
  privateEvidenceRef: "capture-7",
  title: "Name the field a rejected capture failed on",
  problem: "A rejected capture says it was rejected without naming the field, so the caller retries blind.",
  expected: "The rejection names the field and the rule it broke.",
  actual: "The rejection names neither.",
  reproduction: "Stage a capture with an empty Limit and read the rejection.",
  productRevision: "1.7.5",
  impact: "Retries that change the wrong field.",
  workaround: "Read the verifier source.",
  ...over,
});

const ORIGIN = { runId: null, actor: "test-boundary" };

const setup = (options: { maxAttempts?: number; publishing?: boolean } = {}) => {
  const harness = makeHarness();
  const clock = harness.clock;
  const tracker = new FakeTracker();
  const port = githubUpstreamIssuePort(tracker);
  const store = harness.cp.dogfoodFindings;
  // A reporter built afresh each time, on a store built afresh over the same database: a restart.
  const reporter = () =>
    new UpstreamDogfoodReporter(
      new DogfoodFindingStore({ db: harness.cp.db, audit: harness.cp.audit, artifacts: harness.cp.artifacts, clock }),
      options.publishing === false ? null : port,
      { clock, backoffMs: 1000, ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }) },
    );
  return { harness, clock, tracker, port, store, reporter };
};

const recorded = (store: DogfoodFindingStore, input: DogfoodFindingInput): DogfoodRecord => {
  const decision = store.record(input, ORIGIN);
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

  it("a frontier-simplify method finding from a stored review goes to the frontier-simplify tracker", async () => {
    const { harness, tracker, store, reporter } = setup();
    await driveToReviewedCandidate(harness, {
      reviewerFindings: [{
        category: "method",
        severity: "MINOR",
        repository: "github:acme/fixture",
        path: null,
        summary: "State when a review round may stop",
        detail: "Reviewers repeat rounds on a change with no new finding because the method names no stop rule.",
      }],
    });
    const [record] = store.list().records;
    expect(record).toMatchObject({ product: "frontier-simplify", binding: { findingIndex: 0 } });
    await reporter().reportDue();
    expect(tracker.issues.map((issue) => [issue.repo, issue.title])).toEqual([[FS, "State when a review round may stop"]]);
    expect(tracker.issues[0]!.body).toContain("## Use case");
    expect(store.get(record!.id)!.state.status).toBe("LINKED");
  });

  it("with publishing off, findings accumulate and nothing is sent", async () => {
    const { tracker, store, reporter } = setup({ publishing: false });
    const record = recorded(store, finding());
    const summary = await reporter().reportDue();
    expect(summary).toMatchObject({ publishing: "disabled", waiting: [record.id], linked: [], unpublished: [] });
    expect(tracker.calls).toEqual([]);
    expect(store.get(record.id)!.state).toEqual(record.state);
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
    const { harness, clock, tracker, store, reporter } = setup();
    const first = recorded(store, finding({ reproduction: "Stage /Users/example/p1/capture.json and read the rejection." }));
    const again = new DogfoodFindingStore({ db: harness.cp.db, audit: harness.cp.audit, artifacts: harness.cp.artifacts, clock })
      .record(finding({ reproduction: "Stage /Users/sample/p2/capture.json and read the rejection." }), ORIGIN);
    expect(again.allowed && again.value.id).toBe(first.id);
    expect(again.allowed && again.evidence["replayed"]).toBe(true);
    expect(harness.cp.audit.byKind(DOGFOOD_FINDING_KIND)).toHaveLength(1);
    // The same error text under another cause is another finding, not a duplicate.
    expect(findingKey(finding({ signature: "capture.other-cause", reproduction: "Stage /Users/example/p1/capture.json and read the rejection." }))).not.toBe(first.key);

    await reporter().reportDue();
    expect(tracker.issues).toHaveLength(1);

    const newer = recorded(store, finding({ reproduction: "Stage /Users/sample/p3/capture.json and read the rejection.", productRevision: "1.7.6" }));
    expect(newer.key).toBe(first.key);
    await reporter().reportDue();
    expect(tracker.issues).toHaveLength(1);
    expect(tracker.issues[0]!.comments).toHaveLength(1);
    expect(store.get(newer.id)!.state).toMatchObject({ status: "LINKED", action: "commented" });

    store.record(finding({ reproduction: "Stage /Users/sample/p3/capture.json and read the rejection.", productRevision: "1.7.6" }), ORIGIN);
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
    expect(tracker.issues[1]!.title).toBe("Regression: Name the field a rejected capture failed on");
    expect(tracker.issues[1]!.body).toContain(`Previously reported as https://github.com/${CL}/issues/1`);
    expect(store.get(regression.id)!.state).toMatchObject({ status: "LINKED", action: "regression", issueNumber: 2 });
  });

  it("a finding across both products is split; the CommitLore side names the other, which only a stored review may record", async () => {
    const { tracker, store, reporter } = setup();
    const [commitlore, frontier] = splitAcrossProducts(
      { ...finding(), kind: "defect" },
      [
        { product: "commitlore", signature: "capture.rejects-review-record", expected: "CommitLore accepts the record the method asks for.", productRevision: "1.7.5" },
        { product: "frontier-simplify", signature: "method.asks-unrecordable-record", expected: "The method asks only for a record CommitLore accepts.", productRevision: "0d788506" },
      ],
    );
    recorded(store, commitlore);
    expect(store.record(frontier, ORIGIN)).toMatchObject({ allowed: false, evidence: { refusal: "FRONTIER_SIMPLIFY_EVIDENCE_UNBOUND" } });
    await reporter().reportDue();
    expect(tracker.issues.map((issue) => issue.repo)).toEqual([CL]);
    expect(tracker.issues[0]!.body).toContain("## Related");
    expect(tracker.issues[0]!.body).toContain(`acpdogfood${findingKey(frontier)}\` in ${FS}`);
  });

  it("secrets, local paths, ids and the private reference never reach the tracker or the stored record", async () => {
    const { harness, tracker, store, reporter } = setup();
    const token = `ghp_${"A1b2C3d4".repeat(5)}`;
    const record = recorded(
      store,
      finding({
        title: "Capture of /Users/example/work/app stalls",
        actual: `Failed with ${token} for dev@example.com in session_ABCDEFGH1234 and run_0123456789abcdef01234567.`,
        evidence: `stderr: ${token}`,
        privateEvidenceRef: "/Users/example/.agent-control-plane/evidence/7",
      }),
    );
    expect(record.public.evidenceWithheld).toBe(true);
    const stored = JSON.stringify(harness.cp.audit.byKind(DOGFOOD_FINDING_KIND));
    expect(stored).not.toContain(token);
    await reporter().reportDue();
    const [issue] = tracker.issues;
    for (const leaked of [token, "/Users/", "dev@example.com", "session_ABCDEFGH", "run_0123456789abcdef01234567", ".agent-control-plane"]) {
      expect(issue!.body + issue!.title).not.toContain(leaked);
    }
    expect(issue!.body).toContain("Withheld: the original could not be shown safe to publish.");

    const unsafe = recorded(store, finding({ signature: "capture.other", title: "See claude.ai/code/abc for the run" }));
    expect(unsafe.state).toMatchObject({ status: "NOT_REPORTED", reason: "NOT_PUBLIC_SAFE" });
  });

  it("the target is the product's tracker whatever the finding says, and the port refuses any other", async () => {
    const { harness, tracker, store, reporter, port } = setup();
    const outside = store.record({ ...finding(), product: "agent-control-plane" }, ORIGIN);
    expect(outside.allowed).toBe(false);
    expect(harness.cp.audit.byKind(DOGFOOD_FINDING_KIND)).toEqual([]);

    recorded(store, finding({ actual: "File this at https://github.com/someone/else/issues/new instead." }));
    await reporter().reportDue();
    expect(tracker.issues.map((issue) => issue.repo)).toEqual([CL]);

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
    expect(store.get(record.id)!.state).toMatchObject({ status: "LINKED", issueNumber: 1, url: `https://github.com/${CL}/issues/1` });
  });

  it("a comment whose answer was lost is linked after a restart, not posted again", async () => {
    const { clock, tracker, store, reporter } = setup();
    recorded(store, finding());
    await reporter().reportDue();
    const newer = recorded(store, finding({ productRevision: "1.7.6" }));
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

  it("a tracker failure on one finding neither escapes the pass nor holds another, and an unreadable row is named", async () => {
    const { harness, tracker, store, reporter } = setup();
    const stuck = recorded(store, commitloreObservationFinding(
      doctor({ schema: "commitlore_doctor.v2", status: "ok", checks: [], exitCode: 3 }),
      { productRevision: "1.7.5", privateEvidenceRef: "observation e" },
    )!);
    const moving = recorded(store, finding());
    tracker.failBefore.push({ match: new RegExp(`acpdogfood${stuck.key}`), error: () => new TypeError("fetch failed"), times: 1 });
    const unreadable = harness.cp.audit.record({ kind: DOGFOOD_FINDING_KIND, evidence: { findingId: "not-a-finding" } });
    const summary = await reporter().reportDue();
    expect(summary.linked).toEqual([moving.id]);
    expect(summary.waiting).toEqual([stuck.id]);
    expect(summary.unreadable).toEqual([`audit:${unreadable.allowed ? unreadable.value : "?"}`]);
    expect(store.get(stuck.id)!.state).toMatchObject({ status: "QUEUED", attempts: 1, lastError: "no answer from GitHub" });
  });
});
