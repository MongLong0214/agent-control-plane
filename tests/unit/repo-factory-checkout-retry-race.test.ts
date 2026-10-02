import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualClock } from "../../src/core/clock.ts";
import {
  produceRepoFactoryResult,
  repositoryCheckoutPath,
  type RepoFactoryPlanFixture,
} from "../../src/bootstrap/repo-factory-producer.ts";
import type * as GitModule from "../../src/git/git.ts";
import { FakeGitHub } from "../helpers/fake-github-write-port.ts";

/**
 * PR #1043 review round 3 witness (RF1043-07, the concurrent half). Two retries of one bootstrap
 * operation meet a leftover checkout. The reviewer's schedule: retry A finishes reading the old
 * checkout's HEAD, then retry B removes that checkout and claims a new one, then A acts on what it
 * read. Gating `tryRevParse` for the checkout path holds A at exactly that point, so the schedule
 * is reproduced deterministically rather than hoped for.
 *
 * On the reviewed head (c884196b) the old checkout is deleted and a retry's claim is lost. A
 * leftover checkout must instead be refused by name and preserved, by both retries.
 */

const gate = vi.hoisted(() => ({ checkout: "", armed: false, reached: false, wait: Promise.resolve() }));

vi.mock("../../src/git/git.ts", async (importOriginal) => {
  const original = await importOriginal<typeof GitModule>();
  return {
    ...original,
    tryRevParse: async (cwd: string, ref: string) => {
      const value = await original.tryRevParse(cwd, ref);
      if (gate.armed ? cwd === gate.checkout : false) {
        gate.armed = false;
        gate.reached = true;
        await gate.wait;
      }
      return value;
    },
  };
});

const sandboxes: string[] = [];
afterEach(async () => {
  while (sandboxes.length > 0) {
    const dir = sandboxes.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

const IDENTITY = "github:acme/fixture";
const operations = [
  {
    operationId: "create-repository:fixture",
    resourceType: "repository" as const,
    resourceIdentity: IDENTITY,
    desiredState: { visibility: "public" as const },
  },
  { operationId: "push-default-branch:fixture", resourceType: "branch" as const, resourceIdentity: `${IDENTITY}#main` },
  {
    operationId: "set-default-branch:fixture",
    resourceType: "setting" as const,
    resourceIdentity: `${IDENTITY}#default-branch`,
    desiredState: { defaultBranch: "main" },
  },
];
const plan = {
  runId: "run_bootstrap_246",
  bootstrapOperationId: "bootstrap_246",
  requestDigest: "sha256:" + "a".repeat(64),
  planDigest: "sha256:" + "b".repeat(64),
  projectManifestDigest: "sha256:" + "c".repeat(64),
  repositoryRole: "primary",
  defaultBranch: "main",
  verificationCommandId: "local-clean-tree",
  verificationKind: "CLEAN_TREE",
  githubOperations: operations,
} as unknown as RepoFactoryPlanFixture;
const authority = {
  owner: "acme",
  visibility: "public" as const,
  approvedOperations: operations.map(({ operationId, resourceType, resourceIdentity }) => ({
    operationId,
    resourceType,
    resourceIdentity,
  })),
};

const until = async (condition: () => boolean, settled: Promise<unknown>): Promise<void> => {
  let done = false;
  void settled.finally(() => {
    done = true;
  });
  for (let waited = 0; waited < 20_000; waited += 5) {
    if (condition() || done) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the schedule did not reach its next step");
};

describe("PR #1043 review round 3 witnesses — concurrent retries", () => {
  it("RF1043-07: two retries meeting a leftover checkout both refuse it by name; neither removes it, nor a checkout the other claimed", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "acp-246-race-"));
    sandboxes.push(sandbox);
    const workDir = join(sandbox, "workdir");
    const github = new FakeGitHub(sandbox);
    const produce = (at: string) =>
      produceRepoFactoryResult({
        plan,
        workDir,
        clock: new ManualClock(at),
        github: { port: github, authority },
      } as Parameters<typeof produceRepoFactoryResult>[0]);

    const first = await produce("2026-10-02T00:00:00.000Z");
    if (!first.allowed) throw new Error(`${first.reasonCode}: ${first.message}`);
    // As a run that died before storing its result leaves it (the reviewed head kept a file here).
    rmSync(join(workDir, "github-ledger", "primary.result.json"), { force: true });
    const checkout = repositoryCheckoutPath(workDir, "primary");
    const original = statSync(checkout).ino;
    github.writes.length = 0;

    let releaseA = (): void => {};
    gate.wait = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    gate.checkout = checkout;
    gate.armed = true;
    gate.reached = false;

    const retryA = produce("2026-10-02T00:05:00.000Z");
    await until(() => gate.reached, retryA);
    const retryB = produce("2026-10-02T00:06:00.000Z");
    let claimedByB: number | null = null;
    await until(() => {
      if (!existsSync(checkout)) return false;
      const inode = statSync(checkout).ino;
      if (inode === original) return false;
      claimedByB = inode;
      return true;
    }, retryB);
    releaseA();
    gate.armed = false;
    const [a, b] = await Promise.allSettled([retryA, retryB]);

    // Nobody reclaimed the leftover: no new checkout was ever claimed over it, and it is intact.
    expect(claimedByB).toBeNull();
    expect(existsSync(checkout) ? statSync(checkout).ino : null).toBe(original);
    for (const outcome of [a, b]) {
      expect(outcome.status).toBe("fulfilled");
      const decision = outcome.status === "fulfilled" ? outcome.value : null;
      expect(decision?.allowed).toBe(false);
      expect(decision?.allowed === false ? decision.evidence["refusal"] : null).toBe("INTERRUPTED_RUN_CHECKOUT");
    }
    expect(github.writes).toEqual([]);
  });
});
