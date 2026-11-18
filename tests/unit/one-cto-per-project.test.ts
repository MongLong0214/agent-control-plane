import { realpathSync } from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import {
  CTO_ALREADY_RUNNING,
  CTO_PROCESS_TABLE_UNREADABLE,
  assertNoOtherCtoProcess,
  conversationIdsNamedBy,
  ctoRefusalOfStderr,
  ctoRoleScope,
  isInteractiveClaude,
  parseLsofCwds,
  parseProcessTable,
  type CtoProcess,
  type CtoProcessReader,
  type CtoRoleScope,
} from "../../src/cto/one-cto-per-project.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { bindCeo, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

const CONVERSATION = "4c491658-32e1-4666-9449-97b2329b2bc2";
const STARTED = "Fri Nov 14 12:10:15 2026";
const uid = process.getuid?.() ?? 0;

/** The live incident's older process, as `ps` rendered it. */
const INCIDENT = `claude --resume ${CONVERSATION} --messaging-socket-path /state/cc-session-acp-freshreadme-2.sock --remote-control freshreadme-2 CTO --permission-mode bypassPermissions --dangerously-skip-permissions {\\012  "schema": "acp.resident-boot.v1"}`;

interface Fake { pid: number; ppid?: number; command: string; cwd?: string; uid?: number; startedAt?: string }

const hostWith = (others: readonly Fake[], opts: { tableFails?: boolean; cwdFails?: boolean; panes?: Record<number, string>; gone?: number[] } = {}): CtoProcessReader => {
  const rows: CtoProcess[] = [
    { pid: process.pid, ppid: 1, uid, startedAt: STARTED, command: "node vitest" },
    ...others.map((one) => ({ pid: one.pid, ppid: one.ppid ?? 1, uid: one.uid ?? uid, startedAt: one.startedAt ?? STARTED, command: one.command })),
  ];
  return {
    table: async () => { if (opts.tableFails) throw Object.assign(new Error("ps"), { code: "ETIMEDOUT" }); return rows; },
    cwds: async (pids) => {
      if (opts.cwdFails) throw Object.assign(new Error("lsof"), { code: "ETIMEDOUT" });
      return new Map(others.filter((one) => pids.includes(one.pid) && one.cwd !== undefined).map((one) => [one.pid, one.cwd!]));
    },
    tmuxPanes: async () => new Map(Object.entries(opts.panes ?? {}).map(([pid, name]) => [Number(pid), name])),
    alive: (pid) => !(opts.gone ?? []).includes(pid) && rows.some((row) => row.pid === pid),
    startToken: () => null,
  };
};

const scope = (over: Partial<CtoRoleScope> = {}): CtoRoleScope => ({
  projectId: "freshreadme-2", conversationIds: [CONVERSATION], checkouts: ["/Users/isaac/projects/FreshReadme"], bound: [], ...over,
});

describe("the one-CTO check: what counts as a process of a project's CTO", () => {
  it("the live incident: an older plain-path process on the same conversation is found, with its tmux session", async () => {
    const reader = hostWith([{ pid: 37663, ppid: 3327, command: INCIDENT, cwd: "/Users/isaac/projects/FreshReadme" }],
      { panes: { 3327: "acp-freshreadme-2" } });
    const verdict = await assertNoOtherCtoProcess(scope(), reader);
    expect(verdict).toMatchObject({ ok: false, reasonCode: CTO_ALREADY_RUNNING, projectId: "freshreadme-2" });
    if (verdict.ok || verdict.reasonCode !== CTO_ALREADY_RUNNING) throw new Error("expected a refusal");
    expect(verdict.processes).toEqual([{ pid: 37663, startedAt: STARTED, conversationId: CONVERSATION, tmuxSession: "acp-freshreadme-2", matchedBy: ["conversation", "cwd"] }]);
    expect(verdict.message).toContain("pid=37663");
    expect(verdict.message).toContain(`conversation=${CONVERSATION}`);
    expect(verdict.message).toContain("tmux=acp-freshreadme-2");
  });

  it("is clean when no process is the role's, whatever else runs", async () => {
    const reader = hostWith([
      { pid: 100, command: "claude --resume 99999999-9999-4999-8999-999999999999 --remote-control other", cwd: "/Users/isaac/projects/Other" },
      { pid: 101, command: `grep claude --resume ${CONVERSATION}` },
      { pid: 102, command: `tmux new-session -d -s acp-x claude --resume '${CONVERSATION}' --model opus` },
    ]);
    expect(await assertNoOtherCtoProcess(scope(), reader)).toEqual({ ok: true });
  });

  it("counts an interactive claude whose argv says nothing, by its working directory", async () => {
    const reader = hostWith([{ pid: 200, command: "claude", cwd: "/Users/isaac/projects/FreshReadme" }]);
    const verdict = await assertNoOtherCtoProcess(scope(), reader);
    expect(verdict.ok).toBe(false);
    if (verdict.ok || verdict.reasonCode !== CTO_ALREADY_RUNNING) throw new Error("expected a refusal");
    expect(verdict.processes).toEqual([expect.objectContaining({ pid: 200, conversationId: null, matchedBy: ["cwd"] })]);
  });

  it("does not count a short command or a headless query in the checkout, and a trailing slash is the same directory", async () => {
    const checkout = "/Users/isaac/projects/FreshReadme";
    const reader = hostWith([
      { pid: 300, command: "/Users/isaac/.local/bin/claude mcp get acp-cto", cwd: checkout },
      { pid: 301, command: "/Users/isaac/.local/bin/claude -p --output-format json --safe-mode --max-turns 1 /usage", cwd: checkout },
    ]);
    expect(await assertNoOtherCtoProcess(scope(), reader)).toEqual({ ok: true });
    const slashed = hostWith([{ pid: 302, command: "claude", cwd: `${checkout}/` }]);
    expect((await assertNoOtherCtoProcess(scope(), slashed)).ok).toBe(false);
  });

  it("counts the bound session's process by pid and start, and not a pid that was reused by a later start", async () => {
    const reader = hostWith([{ pid: 400, command: "node something", startedAt: STARTED }]);
    expect((await assertNoOtherCtoProcess(scope({ bound: [{ pid: 400, startedAt: STARTED }] }), reader)).ok).toBe(false);
    expect((await assertNoOtherCtoProcess(scope({ bound: [{ pid: 400, startedAt: "Mon Nov 10 01:00:00 2026" }] }), reader)).ok).toBe(true);
    expect((await assertNoOtherCtoProcess(scope({ bound: [{ pid: 400, startedAt: null }] }), reader)).ok).toBe(false);
  });

  it("excludes exactly the pids it is told are the expected process, and nothing else", async () => {
    const reader = hostWith([
      { pid: 500, command: `claude --session-id ${CONVERSATION}`, cwd: "/elsewhere" },
      { pid: 501, command: `claude --resume ${CONVERSATION}`, cwd: "/elsewhere" },
    ]);
    const verdict = await assertNoOtherCtoProcess(scope(), reader, [500]);
    if (verdict.ok || verdict.reasonCode !== CTO_ALREADY_RUNNING) throw new Error("expected a refusal");
    expect(verdict.processes.map((one) => one.pid)).toEqual([501]);
    expect((await assertNoOtherCtoProcess(scope(), reader, [500, 501])).ok).toBe(true);
  });

  it("reads the conversation from --resume, --session-id, -r and the attached form, only on a claude process", () => {
    expect(conversationIdsNamedBy(`claude --resume ${CONVERSATION}`)).toEqual([CONVERSATION]);
    expect(conversationIdsNamedBy(`/Users/x/.local/share/claude/versions/2.1.323 --session-id=${CONVERSATION.toUpperCase()}`)).toEqual([CONVERSATION]);
    expect(conversationIdsNamedBy(`env FOO=1 claude -r ${CONVERSATION}`)).toEqual([CONVERSATION]);
    expect(conversationIdsNamedBy(`node server.js --resume ${CONVERSATION}`)).toEqual([]);
    expect(isInteractiveClaude("claude --resume x --remote-control y")).toBe(true);
    expect(isInteractiveClaude("claude plugin list")).toBe(false);
  });
});

describe("the one-CTO check fails closed on a read that failed", () => {
  it.each([
    ["the process table cannot be read", { tableFails: true }],
    ["the working directories cannot be read", { cwdFails: true }],
  ])("%s", async (_what, opts) => {
    const reader = hostWith([{ pid: 600, command: "claude --resume 99999999-9999-4999-8999-999999999999", cwd: "/elsewhere" }], opts);
    const verdict = await assertNoOtherCtoProcess(scope(), reader);
    expect(verdict).toMatchObject({ ok: false, reasonCode: CTO_PROCESS_TABLE_UNREADABLE });
  });

  it("a live claude whose working directory was not answered is unreadable, a vanished one is not", async () => {
    const live = hostWith([{ pid: 700, command: "claude --resume 99999999-9999-4999-8999-999999999999" }]);
    expect(await assertNoOtherCtoProcess(scope(), live)).toMatchObject({ ok: false, reasonCode: CTO_PROCESS_TABLE_UNREADABLE });
    const gone = hostWith([{ pid: 700, command: "claude --resume 99999999-9999-4999-8999-999999999999" }], { gone: [700] });
    expect(await assertNoOtherCtoProcess(scope(), gone)).toEqual({ ok: true });
  });

  it("a table that does not contain this very process is not a table", async () => {
    const empty: CtoProcessReader = { ...hostWith([]), table: async () => [] };
    expect(await assertNoOtherCtoProcess(scope(), empty)).toMatchObject({ ok: false, reasonCode: CTO_PROCESS_TABLE_UNREADABLE });
  });

  it("another user's claude is not asked for a working directory it could not give", async () => {
    const reader = hostWith([{ pid: 800, command: `claude --resume ${CONVERSATION}`, uid: uid + 1 }]);
    const verdict = await assertNoOtherCtoProcess(scope(), reader);
    // Named by its argv, which ps reads for any user; its cwd is never asked.
    expect(verdict.ok).toBe(false);
  });
});

describe("the readers' parsers and the refusal line", () => {
  it("parses ps rows with a start time, skips zombies, and keeps a very long command whole", () => {
    const long = "x".repeat(150_000);
    const rows = parseProcessTable(
      `  37663   3327   501 S+   Sat Nov 14 12:10:15 2026     ${INCIDENT}\n  1 0 0 Ss Mon Nov  3 08:00:01 2026 /sbin/launchd\n  9 1 501 Z Mon Nov  3 08:00:01 2026 (claude)\n  55 1 501 S Mon Nov  3 08:00:01 2026 claude ${long}\n`);
    expect(rows.map((row) => row.pid)).toEqual([37663, 1, 55]);
    expect(rows[0]).toMatchObject({ ppid: 3327, uid: 501, startedAt: "Sat Nov 14 12:10:15 2026" });
    expect(rows[2]!.command.length).toBeGreaterThan(150_000);
  });

  it("parses lsof -Fpn output", () => {
    expect([...parseLsofCwds("p37663\nn/Users/isaac/projects/FreshReadme\np71274\nn/Users/isaac/projects/FreshReadme\n")]).toEqual([
      [37663, "/Users/isaac/projects/FreshReadme"], [71274, "/Users/isaac/projects/FreshReadme"]]);
  });

  it("reads back only the host's own refusal line, in its one shape", () => {
    const line = `host project provisioner refused operation: ${CTO_ALREADY_RUNNING}: project p already has a CTO process: pid=1 started="x" conversation=none tmux=none by=cwd\n`;
    expect(ctoRefusalOfStderr(line)).toBe(line.slice("host project provisioner refused operation: ".length, -1));
    expect(ctoRefusalOfStderr(`${line}secret on the next line`)).toBeNull();
    expect(ctoRefusalOfStderr("host project provisioner refused operation: something else\n")).toBeNull();
  });

  it("reads no scope from a database that has none of the tables", () => {
    const empty = ctoRoleScope(() => { throw new Error("no such table"); }, "p", { conversationIds: [CONVERSATION.toUpperCase()], checkouts: ["/c"] });
    expect(empty).toEqual({ projectId: "p", conversationIds: [CONVERSATION], checkouts: ["/c"], bound: [] });
  });
});

describe("the role's scope from the daemon's database", () => {
  it("reads the project's checkouts and the bound session's process", async () => {
    const harness = makeHarness();
    bindCeo(harness);
    const { projectId } = await registerFixtureProject(harness);
    const session = harness.cp.sessions.create({ provider: "scripted", model: "scripted-cto", osPid: 90_001 });
    expect(harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test cto").allowed).toBe(true);
    const bound = harness.cp.bindings.bind({ role: Role.PRIMARY_CTO, roleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId }), projectId, sessionId: session.sessionId });
    expect(bound.allowed).toBe(true);
    const read = ctoRoleScope((sql, params) => harness.cp.db.all(sql, [...params]), projectId);
    expect(read.checkouts).toEqual([realpathSync(harness.repoPath)]);
    expect(read.bound).toEqual([{ pid: 90_001, startedAt: null }]);
  });
});
