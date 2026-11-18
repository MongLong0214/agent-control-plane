import { realpathSync } from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import {
  CTO_ALREADY_RUNNING,
  CTO_PROCESS_TABLE_UNREADABLE,
  assertNoOtherCtoProcess,
  ctoRefusalOfStderr,
  ctoRoleScope,
  parseClaudeArgv,
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
const CHECKOUT = "/Users/isaac/projects/FreshReadme";
const uid = process.getuid?.() ?? 0;

/** The live incident's older process: its real argv, one element each, as the kernel holds it. */
const INCIDENT = ["claude", "--resume", CONVERSATION, "--messaging-socket-path", "/state/cc-session-acp-freshreadme-2.sock", "--remote-control", "freshreadme-2 CTO",
  "--permission-mode", "bypassPermissions", "--dangerously-skip-permissions", `{\n  "schema": "acp.resident-boot.v1",\n  "sessionUuid": "${CONVERSATION}"\n}`];

interface Fake { pid: number; ppid?: number; argv: string[]; cwd?: string; uid?: number; startedAt?: string }

/**
 * A host: `ps`'s table (a rendering, the argv joined with spaces) and, beside it, each process's real argv. `unreadable`
 * lists pids whose argv cannot be read; `gone` pids that no longer exist.
 */
const hostWith = (others: readonly Fake[], opts: { tableFails?: boolean; cwdFails?: boolean; panes?: Record<number, string>; gone?: number[]; unreadable?: number[]; startTokens?: Record<number, string> } = {}): CtoProcessReader => {
  const rows: CtoProcess[] = [
    { pid: process.pid, ppid: 1, uid, startedAt: STARTED, command: "node vitest" },
    ...others.map((one) => ({ pid: one.pid, ppid: one.ppid ?? 1, uid: one.uid ?? uid, startedAt: one.startedAt ?? STARTED, command: one.argv.join(" ") })),
  ];
  return {
    table: async () => { if (opts.tableFails) throw Object.assign(new Error("ps"), { code: "ETIMEDOUT" }); return rows; },
    argv: (pid) => (opts.unreadable ?? []).includes(pid) ? null : others.find((one) => one.pid === pid)?.argv ?? ["node", "vitest"],
    cwds: async (pids) => {
      if (opts.cwdFails) throw Object.assign(new Error("lsof"), { code: "ETIMEDOUT" });
      return new Map(others.filter((one) => pids.includes(one.pid) && one.cwd !== undefined).map((one) => [one.pid, one.cwd!]));
    },
    tmuxPanes: async () => new Map(Object.entries(opts.panes ?? {}).map(([pid, name]) => [Number(pid), name])),
    alive: (pid) => !(opts.gone ?? []).includes(pid) && rows.some((row) => row.pid === pid),
    startToken: (pid) => opts.startTokens?.[pid] ?? null,
  };
};

const scope = (over: Partial<CtoRoleScope> = {}): CtoRoleScope => ({
  projectId: "freshreadme-2", conversationIds: [CONVERSATION], checkouts: [CHECKOUT], bound: [], ...over,
});

describe("the one-CTO check: what counts as a process of a project's CTO", () => {
  it("the live incident: an older plain-path process on the same conversation is found, with its tmux session", async () => {
    const reader = hostWith([{ pid: 37663, ppid: 3327, argv: INCIDENT, cwd: CHECKOUT }], { panes: { 3327: "acp-freshreadme-2" } });
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
      { pid: 100, argv: ["claude", "--resume", "99999999-9999-4999-8999-999999999999", "--remote-control", "other"], cwd: "/Users/isaac/projects/Other" },
      { pid: 101, argv: ["grep", "claude", "--resume", CONVERSATION] },
      { pid: 102, argv: ["tmux", "new-session", "-d", "-s", "acp-x", `claude --resume '${CONVERSATION}' --model opus`] },
      { pid: 103, argv: ["node", "/x/claude.js", "--resume", CONVERSATION] },
    ]);
    expect(await assertNoOtherCtoProcess(scope(), reader)).toEqual({ ok: true });
  });

  it("counts an interactive claude whose argv says nothing, by its working directory", async () => {
    const reader = hostWith([{ pid: 200, argv: ["claude"], cwd: CHECKOUT }]);
    const verdict = await assertNoOtherCtoProcess(scope(), reader);
    expect(verdict.ok).toBe(false);
    if (verdict.ok || verdict.reasonCode !== CTO_ALREADY_RUNNING) throw new Error("expected a refusal");
    expect(verdict.processes).toEqual([expect.objectContaining({ pid: 200, conversationId: null, matchedBy: ["cwd"] })]);
  });

  it("does not count a subcommand or a headless query in the checkout, and a trailing slash is the same directory", async () => {
    const reader = hostWith([
      { pid: 300, argv: ["/Users/isaac/.local/bin/claude", "mcp", "get", "acp-cto"], cwd: CHECKOUT },
      { pid: 301, argv: ["/Users/isaac/.local/bin/claude", "-p", "--output-format", "json", "--safe-mode", "--max-turns", "1", "/usage"], cwd: CHECKOUT },
      { pid: 302, argv: ["claude", "--print", "list the files"], cwd: CHECKOUT },
    ]);
    expect(await assertNoOtherCtoProcess(scope(), reader)).toEqual({ ok: true });
    const slashed = hostWith([{ pid: 303, argv: ["claude"], cwd: `${CHECKOUT}/` }]);
    expect((await assertNoOtherCtoProcess(scope(), slashed)).ok).toBe(false);
  });

  it("reads real argv elements: a prompt that mentions -p is not headless, so its working directory still counts", async () => {
    const reader = hostWith([{ pid: 310, argv: ["claude", "Explain how -p works"], cwd: CHECKOUT }]);
    const verdict = await assertNoOtherCtoProcess(scope(), reader);
    expect(verdict).toMatchObject({ ok: false, reasonCode: CTO_ALREADY_RUNNING });
    if (verdict.ok || verdict.reasonCode !== CTO_ALREADY_RUNNING) throw new Error("expected a refusal");
    expect(verdict.processes).toEqual([expect.objectContaining({ pid: 310, matchedBy: ["cwd"] })]);
    // A `-p` that is an element of its own, after the options and before nothing, is the flag; one after `--` is a positional.
    expect((await assertNoOtherCtoProcess(scope(), hostWith([{ pid: 311, argv: ["claude", "--model", "opus", "-p", "hello"], cwd: CHECKOUT }]))).ok).toBe(true);
    expect((await assertNoOtherCtoProcess(scope(), hostWith([{ pid: 312, argv: ["claude", "--", "-p"], cwd: CHECKOUT }]))).ok).toBe(false);
  });

  it("reads real argv elements: a prompt that quotes --resume <uuid> is not a conversation, so it is no false refusal", async () => {
    const reader = hostWith([
      { pid: 320, argv: ["claude", `please run claude --resume ${CONVERSATION} for me`], cwd: "/elsewhere" },
      { pid: 321, argv: ["claude", "--model", "opus", `--resume ${CONVERSATION}`], cwd: "/elsewhere" },
    ]);
    expect(await assertNoOtherCtoProcess(scope(), reader)).toEqual({ ok: true });
  });

  it("counts the bound session's process by pid and start, and not a pid that was reused by a later start", async () => {
    const reader = hostWith([{ pid: 400, argv: ["node", "something"], startedAt: STARTED }]);
    expect((await assertNoOtherCtoProcess(scope({ bound: [{ pid: 400, startedAt: STARTED }] }), reader)).ok).toBe(false);
    expect((await assertNoOtherCtoProcess(scope({ bound: [{ pid: 400, startedAt: "Mon Nov 10 01:00:00 2026" }] }), reader)).ok).toBe(true);
    expect((await assertNoOtherCtoProcess(scope({ bound: [{ pid: 400, startedAt: null }] }), reader)).ok).toBe(false);
  });

  it("excludes an expected process only while its pid AND start still match, and nothing else", async () => {
    const reader = hostWith([
      { pid: 500, argv: ["claude", "--session-id", CONVERSATION], cwd: "/elsewhere" },
      { pid: 501, argv: ["claude", "--resume", CONVERSATION], cwd: "/elsewhere" },
    ]);
    const verdict = await assertNoOtherCtoProcess(scope(), reader, [{ pid: 500, startedAt: STARTED }]);
    if (verdict.ok || verdict.reasonCode !== CTO_ALREADY_RUNNING) throw new Error("expected a refusal");
    expect(verdict.processes.map((one) => one.pid)).toEqual([501]);
    expect((await assertNoOtherCtoProcess(scope(), reader, [{ pid: 500, startedAt: STARTED }, { pid: 501, startedAt: STARTED }])).ok).toBe(true);
    // The pid was reused by another process with another start: it is counted like any other.
    const reused = await assertNoOtherCtoProcess(scope(), reader, [{ pid: 500, startedAt: "Mon Nov 10 01:00:00 2026" }, { pid: 501, startedAt: STARTED }]);
    if (reused.ok || reused.reasonCode !== CTO_ALREADY_RUNNING) throw new Error("expected a refusal");
    expect(reused.processes.map((one) => one.pid)).toEqual([500]);
    // The recorded start may be the native token as well as the lstart text.
    const native = hostWith([{ pid: 502, argv: ["claude", "--resume", CONVERSATION], cwd: "/elsewhere" }], { startTokens: { 502: "darwin-tv:1.000001" } });
    expect((await assertNoOtherCtoProcess(scope(), native, [{ pid: 502, startedAt: "darwin-tv:1.000001" }])).ok).toBe(true);
  });
});

describe("parseClaudeArgv: what a claude process is, from its argv elements", () => {
  it("reads the conversation from --resume, --session-id, -r and the attached form, only on a claude process", () => {
    expect(parseClaudeArgv(["claude", "--resume", CONVERSATION])?.conversationIds).toEqual([CONVERSATION]);
    expect(parseClaudeArgv(["/Users/x/.local/share/claude/versions/2.1.323", `--session-id=${CONVERSATION.toUpperCase()}`])?.conversationIds).toEqual([CONVERSATION]);
    expect(parseClaudeArgv(["env", "FOO=1", "claude", "-r", CONVERSATION])?.conversationIds).toEqual([CONVERSATION]);
    expect(parseClaudeArgv(["node", "server.js", "--resume", CONVERSATION])).toBeNull();
    expect(parseClaudeArgv(["claude", "--resume", "a session name"])?.conversationIds).toEqual([]);
    expect(parseClaudeArgv(["claude", "--", "--resume", CONVERSATION])?.conversationIds).toEqual([]);
  });

  it("is interactive unless it is a subcommand or has a real -p/--print before its prompt, past options and their values", () => {
    expect(parseClaudeArgv(["claude", "--resume", CONVERSATION, "--remote-control", "p CTO"])?.interactive).toBe(true);
    expect(parseClaudeArgv(["claude", "plugin", "list"])?.interactive).toBe(false);
    expect(parseClaudeArgv(["claude", "-p", "hi"])?.interactive).toBe(false);
    expect(parseClaudeArgv(["claude", "--mcp-config", "{}", "--dangerously-load-development-channels", "server:acp-buzz-channel", "-p", "hi"])?.interactive).toBe(false);
    expect(parseClaudeArgv(["claude", "Explain how -p works"])?.interactive).toBe(true);
    expect(parseClaudeArgv(["claude", "--model", "opus", "do the thing", "-p"])?.interactive).toBe(true);
  });
});

describe("the one-CTO check fails closed on a read that failed", () => {
  it.each([
    ["the process table cannot be read", { tableFails: true }],
    ["the working directories cannot be read", { cwdFails: true }],
  ])("%s", async (_what, opts) => {
    const reader = hostWith([{ pid: 600, argv: ["claude", "--resume", "99999999-9999-4999-8999-999999999999"], cwd: "/elsewhere" }], opts);
    const verdict = await assertNoOtherCtoProcess(scope(), reader);
    expect(verdict).toMatchObject({ ok: false, reasonCode: CTO_PROCESS_TABLE_UNREADABLE });
  });

  it("a live claude whose working directory was not answered is unreadable, a vanished one is not", async () => {
    const live = hostWith([{ pid: 700, argv: ["claude", "--resume", "99999999-9999-4999-8999-999999999999"] }]);
    expect(await assertNoOtherCtoProcess(scope(), live)).toMatchObject({ ok: false, reasonCode: CTO_PROCESS_TABLE_UNREADABLE });
    const gone = hostWith([{ pid: 700, argv: ["claude", "--resume", "99999999-9999-4999-8999-999999999999"] }], { gone: [700] });
    expect(await assertNoOtherCtoProcess(scope(), gone)).toEqual({ ok: true });
  });

  it("exact argv unavailable for a live claude-looking process refuses a launch; for one that has gone, it does not", async () => {
    const live = hostWith([{ pid: 710, argv: ["claude", "--resume", CONVERSATION], cwd: "/elsewhere" }], { unreadable: [710] });
    const verdict = await assertNoOtherCtoProcess(scope(), live);
    expect(verdict).toMatchObject({ ok: false, reasonCode: CTO_PROCESS_TABLE_UNREADABLE });
    if (verdict.ok || verdict.reasonCode !== CTO_PROCESS_TABLE_UNREADABLE) throw new Error("expected an unreadable refusal");
    expect(verdict.detail).toContain("argv of pid 710");
    const gone = hostWith([{ pid: 710, argv: ["claude"], cwd: "/elsewhere" }], { unreadable: [710], gone: [710] });
    expect(await assertNoOtherCtoProcess(scope(), gone)).toEqual({ ok: true });
  });

  it("a table that does not contain this very process is not a table", async () => {
    const empty: CtoProcessReader = { ...hostWith([]), table: async () => [] };
    expect(await assertNoOtherCtoProcess(scope(), empty)).toMatchObject({ ok: false, reasonCode: CTO_PROCESS_TABLE_UNREADABLE });
  });

  it("another user's claude is neither read nor asked for a working directory", async () => {
    const reader = hostWith([{ pid: 800, argv: ["claude", "--resume", CONVERSATION], uid: uid + 1 }], { unreadable: [800] });
    expect(await assertNoOtherCtoProcess(scope(), reader)).toEqual({ ok: true });
  });
});

describe("the readers' parsers and the refusal line", () => {
  it("parses ps rows with a start time, skips zombies, and keeps a very long command whole", () => {
    const long = "x".repeat(150_000);
    const rows = parseProcessTable(
      `  37663   3327   501 S+   Sat Nov 14 12:10:15 2026     ${INCIDENT.join(" ")}\n  1 0 0 Ss Mon Nov  3 08:00:01 2026 /sbin/launchd\n  9 1 501 Z Mon Nov  3 08:00:01 2026 (claude)\n  55 1 501 S Mon Nov  3 08:00:01 2026 claude ${long}\n`);
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
