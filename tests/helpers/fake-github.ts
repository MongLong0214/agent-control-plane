import type { GitHubClient } from "../../src/github/github-kernel.ts";

export interface FakePull {
  number: number;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
  merged: boolean;
  state: string;
  html_url: string;
  title?: string;
  body?: string | null;
  merge_commit_sha?: string | null;
}

export interface FakeCheckRun {
  id: number;
  name: string;
  head_sha: string;
  conclusion: string | null;
  status: string;
  app?: { slug?: string } | null;
  check_suite?: { id?: number } | null;
  details_url?: string | null;
  output?: { title?: string | null; summary?: string | null; text?: string | null } | null;
  completed_at?: string | null;
}

/**
 * A GitHub state model sufficient to exercise every kernel predicate.
 *
 * It records mutations so a scenario can assert *how many times* a merge actually
 * happened — the idempotency claim is only meaningful against a counter.
 */
export class FakeGitHub implements GitHubClient {
  pulls: FakePull[] = [];
  checkRuns: FakeCheckRun[] = [];
  branches: string[] = ["main", "dev"];
  tags = new Map<string, string>();
  issues: Array<{ number: number; body: string | null; title: string }> = [];
  /** branch -> commits it contains, for the hotfix propagation compare. */
  contains = new Map<string, Set<string>>();
  /** sha -> its parents, so the kernel's post-merge base proof has something to read. */
  commitParents = new Map<string, string[]>();
  /** When set, the next merge records this sha as the merge commit's first parent. */
  driftBaseTo: string | null = null;
  /** Lets a scenario use a real local candidate commit for trusted workflow-file inspection. */
  nextMergeSha: string | null = null;
  /** Synchronous hook used to model Actions publishing its exact-merge check before a reread. */
  onMerge: ((input: { mergeSha: string; pull: FakePull }) => void) | null = null;
  readonly calls: Array<{ method: string; path: string; body?: unknown }> = [];
  mergeCount = 0;
  #nextId = 100;

  async request<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    this.calls.push({ method, path, body });

    // --- pulls -------------------------------------------------------------
    if (method === "GET" && /\/pulls\?/.test(path)) {
      const head = /head=[^:]+:([^&]+)/.exec(path)?.[1];
      const base = /base=([^&]+)/.exec(path)?.[1];
      return this.pulls.filter(
        (p) =>
          (!head || p.head.ref === decodeURIComponent(head)) &&
          (!base || p.base.ref === decodeURIComponent(base)) &&
          p.state === "open",
      ) as unknown as T;
    }
    if (method === "POST" && /\/pulls$/.test(path)) {
      const input = body as { head: string; base: string; title?: string; body?: string };
      const pull: FakePull = {
        number: this.#nextId++,
        head: { sha: this.headShaFor(input.head), ref: input.head },
        base: { sha: this.headShaFor(input.base), ref: input.base },
        merged: false,
        state: "open",
        html_url: `https://github.test/pull/${this.#nextId}`,
        title: input.title,
        body: input.body ?? null,
      };
      this.pulls.push(pull);
      return pull as unknown as T;
    }
    if (method === "GET" && /\/pulls\/\d+$/.test(path)) {
      const number = Number(/\/pulls\/(\d+)$/.exec(path)![1]);
      const pull = this.pulls.find((p) => p.number === number);
      if (!pull) throw new Error(`no pull ${number}`);
      return pull as unknown as T;
    }
    if (method === "PUT" && /\/pulls\/\d+\/merge$/.test(path)) {
      const number = Number(/\/pulls\/(\d+)\/merge$/.exec(path)![1]);
      const input = body as { sha: string };
      const pull = this.pulls.find((p) => p.number === number);
      if (!pull) throw new Error(`no pull ${number}`);
      if (pull.head.sha !== input.sha) {
        return { merged: false, sha: "" } as unknown as T;
      }
      this.mergeCount += 1;
      pull.merged = true;
      pull.state = "closed";
      const mergeSha = this.nextMergeSha ?? `merge${this.mergeCount}`.padEnd(40, "0");
      this.nextMergeSha = null;
      const firstParent = this.driftBaseTo ?? pull.base.sha;
      this.driftBaseTo = null;
      this.commitParents.set(mergeSha, [firstParent, pull.head.sha]);
      this.markContains(pull.base.ref, mergeSha);
      this.onMerge?.({ mergeSha, pull });
      return { merged: true, sha: mergeSha } as unknown as T;
    }

    // --- check runs --------------------------------------------------------
    if (method === "POST" && /\/check-runs$/.test(path)) {
      const input = body as { name: string; head_sha: string; conclusion: string; output?: FakeCheckRun["output"] };
      const check: FakeCheckRun = {
        id: this.#nextId++,
        name: input.name,
        head_sha: input.head_sha,
        conclusion: input.conclusion,
        status: "completed",
        app: { slug: "acp-trusted-app" },
        output: input.output ?? null,
        completed_at: "2026-08-12T00:00:00.000Z",
      };
      this.checkRuns.push(check);
      return check as unknown as T;
    }
    if (method === "GET" && /\/commits\/[^/]+\/check-runs/.test(path)) {
      const sha = /\/commits\/([^/]+)\/check-runs/.exec(path)![1]!;
      const name = /check_name=([^&]+)/.exec(path)?.[1];
      const runs = this.checkRuns.filter(
        (c) => c.head_sha === sha && (!name || c.name === decodeURIComponent(name)),
      );
      return { check_runs: runs } as unknown as T;
    }
    if (method === "GET" && /\/check-suites\/\d+$/.test(path)) {
      const id = Number(/\/check-suites\/(\d+)$/.exec(path)![1]);
      const suite = this.#checkSuites.get(id);
      if (!suite) throw new Error(`no check suite ${id}`);
      return suite as unknown as T;
    }
    if (method === "GET" && /\/actions\/runs\/\d+$/.test(path)) {
      const id = Number(/\/actions\/runs\/(\d+)$/.exec(path)![1]);
      const run = this.#actionsRuns.get(id);
      if (!run) throw new Error(`no actions run ${id}`);
      return run as unknown as T;
    }

    if (method === "GET" && /\/commits\/[^/]+$/.test(path)) {
      const sha = /\/commits\/([^/]+)$/.exec(path)![1]!;
      const parents = this.commitParents.get(sha) ?? [];
      return { sha, parents: parents.map((p) => ({ sha: p })) } as unknown as T;
    }

    // --- refs and tags -----------------------------------------------------
    if (method === "GET" && /\/git\/ref\/tags\//.test(path)) {
      const tag = /\/git\/ref\/tags\/(.+)$/.exec(path)![1]!;
      const sha = this.tags.get(tag);
      if (!sha) throw new Error("404 tag not found");
      return { object: { sha } } as unknown as T;
    }
    if (method === "POST" && /\/git\/refs$/.test(path)) {
      const input = body as { ref: string; sha: string };
      this.tags.set(input.ref.replace("refs/tags/", ""), input.sha);
      return { ref: input.ref } as unknown as T;
    }

    // --- branches and compare ---------------------------------------------
    if (method === "GET" && /\/branches\?/.test(path)) {
      return this.branches.map((name) => ({ name })) as unknown as T;
    }
    if (method === "GET" && /\/compare\//.test(path)) {
      const [, base, headSha] = /\/compare\/(.+)\.\.\.(.+)$/.exec(path)!;
      const branch = decodeURIComponent(base!);
      const has = this.contains.get(branch)?.has(headSha!) ?? false;
      return { status: has ? "behind" : "diverged" } as unknown as T;
    }

    // --- issues ------------------------------------------------------------
    if (method === "GET" && /\/issues\?/.test(path)) {
      return this.issues as unknown as T;
    }
    if (method === "POST" && /\/issues$/.test(path)) {
      const input = body as { title: string; body: string };
      const issue = { number: this.#nextId++, title: input.title, body: input.body };
      this.issues.push(issue);
      return issue as unknown as T;
    }
    if (method === "PATCH" && /\/issues\/\d+$/.test(path)) {
      const number = Number(/\/issues\/(\d+)$/.exec(path)![1]);
      const issue = this.issues.find((i) => i.number === number);
      const input = body as { title: string; body: string };
      if (issue) {
        issue.title = input.title;
        issue.body = input.body;
      }
      return (issue ?? {}) as unknown as T;
    }

    throw new Error(`FakeGitHub has no handler for ${method} ${path}`);
  }

  /** Register a branch and the sha it points at. */
  setBranch(ref: string, sha: string): void {
    if (!this.branches.includes(ref)) this.branches.push(ref);
    this.#heads.set(ref, sha);
    this.markContains(ref, sha);
  }

  markContains(branch: string, sha: string): void {
    const set = this.contains.get(branch) ?? new Set<string>();
    set.add(sha);
    this.contains.set(branch, set);
  }

  headShaFor(ref: string): string {
    return this.#heads.get(ref) ?? `${ref.replace(/\W/g, "")}sha`.padEnd(40, "0");
  }

  /** Simulate a candidate publishing a check with the gate's name. */
  forgeGate(headSha: string, summary: string, appSlug = "candidate-ci"): FakeCheckRun {
    const check: FakeCheckRun = {
      id: this.#nextId++,
      name: "acp-production-gate",
      head_sha: headSha,
      conclusion: "success",
      status: "completed",
      app: { slug: appSlug },
      output: { title: "forged", summary, text: "{}" },
      completed_at: "2026-08-12T00:00:00.000Z",
    };
    this.checkRuns.push(check);
    return check;
  }

  setPostMergeCheck(mergeSha: string, name: string, conclusion: string): void {
    this.checkRuns.push({
      id: this.#nextId++,
      name,
      head_sha: mergeSha,
      conclusion,
      status: "completed",
      app: { slug: "github-actions" },
      completed_at: "2026-08-12T00:00:00.000Z",
    });
  }

  /** Add a check with the complete suite → Actions run provenance chain the kernel requires. */
  setTrustedPostMergeCheck(mergeSha: string, name: string, workflowPath: string): void {
    const suiteId = this.#nextId++;
    const actionRunId = this.#nextId++;
    this.#checkSuites.set(suiteId, { head_sha: mergeSha, app: { slug: "github-actions" } });
    this.#actionsRuns.set(actionRunId, {
      head_sha: mergeSha,
      path: workflowPath,
      status: "completed",
      conclusion: "success",
    });
    this.checkRuns.push({
      id: this.#nextId++,
      name,
      head_sha: mergeSha,
      conclusion: "success",
      status: "completed",
      app: { slug: "github-actions" },
      check_suite: { id: suiteId },
      details_url: `https://github.test/acme/fixture/actions/runs/${actionRunId}/job/1`,
      completed_at: "2026-08-12T00:00:00.000Z",
    });
  }

  readonly #heads = new Map<string, string>();
  readonly #checkSuites = new Map<number, { head_sha: string; app: { slug: string } }>();
  readonly #actionsRuns = new Map<number, {
    head_sha: string;
    path: string;
    status: string;
    conclusion: string;
  }>();
}
