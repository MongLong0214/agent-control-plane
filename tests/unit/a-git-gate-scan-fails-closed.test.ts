import type * as ChildProcess from "node:child_process";
import { describe, expect, it, vi } from "vitest";

/**
 * S2 round 4 — the scan that looks for a worker git gate still waiting (`gatedGitChildren`) reads the
 * process table with `/bin/ps`. A table that cannot be read, or that does not list this process itself,
 * proves nothing gone: the scan answers null, and every caller then counts the intent as a live writer
 * and refuses. Only `/bin/ps` is substituted here, so a sandbox that denies it is told apart from a
 * table that shows no gate.
 */
const table = vi.hoisted(() => ({ listing: "" as string | Error, calls: 0 }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof ChildProcess>();
  return {
    ...actual,
    execFileSync: (file: string, ...args: unknown[]) => {
      if (file !== "/bin/ps") return (actual.execFileSync as (...a: unknown[]) => unknown)(file, ...args);
      table.calls += 1;
      if (table.listing instanceof Error) throw table.listing;
      return table.listing;
    },
  };
});

const { gatedGitChildren } = await import("../../src/run/worker-git.ts");

describe("the git gate scan fails closed", () => {
  it("a process table that cannot be read, or does not list this process, proves no gate gone", () => {
    table.listing = new Error("spawnSync /bin/ps EPERM");
    expect(gatedGitChildren(["9d1e"])).toBeNull();
    table.listing = "    1 /sbin/launchd\n";
    expect(gatedGitChildren(["9d1e"])).toBeNull();
  });

  it("a readable table names exactly the gates still waiting, as whole arguments", () => {
    table.listing = [
      `  ${process.pid} node vitest`,
      "  4242 /bin/sh -c gate acp-git-9d1e -c core.hooksPath=/dev/null rev-parse",
      "  4343 grep acp-git-7c2fx",
      "",
    ].join("\n");
    expect(gatedGitChildren(["9d1e", "7c2f"])).toEqual(new Set(["9d1e"]));
  });

  it("with no gate-less intent, no table is read at all", () => {
    table.calls = 0;
    expect(gatedGitChildren([])).toEqual(new Set());
    expect(table.calls).toBe(0);
  });
});
