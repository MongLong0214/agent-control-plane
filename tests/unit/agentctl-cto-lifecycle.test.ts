import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli/agentctl.ts";
import {
  CTO_SUBCOMMANDS, IDLE_SECONDS, runCtoCommand,
  type CtoExecOptions, type CtoExecResult, type CtoPorts, type CtoProcess, type CtoRecord,
} from "../../src/cli/cto-command.ts";
import { allow, deny, type Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import { formatHostProvisionerReason, hostProvisionerReason, hostReasonKind, hostRefusalText } from "../../src/runtime/host-provisioner-reason.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * `agentctl cto` composes the existing lifecycle pieces. Every host the command touches — the process table, tmux, gh,
 * git, the Buzz roster and its map script, the fleet files, the provisioner and the rotation launcher — is a fake here,
 * so what is proved is the command's own contract: a dry run by default, the plan's order when applied, the stop at
 * the first failure and the continuation on a rerun, the repository deleted only on its exact name, operator only.
 */
const HOME = "/home/op";
const STATE = "/state";
const P = "e2e-sort-fixture";
const REPO = "MongLong0214/e2e-sort-fixture";
const CONVERSATION = "13a705bf-23dd-429d-a3e4-0c7f8eb61b40";
const ROOM = "bd05ad09-58c4-4e15-8198-6c1500c2aeed";
const ACTOR = "a".repeat(64);
const CLONE = `${HOME}/projects/e2e-sort-fixture`;
const WORKER = `${HOME}/projects/.acp-worker-checkouts/repo_1`;
const ARCHIVE = `${HOME}/projects/.retired/e2e-sort-fixture-${P}`;
const TMUX = `acp-${Buffer.from(P).toString("hex")}`;
const MANIFEST = `${HOME}/.claude/watchers/fleet/manifest.tsv`;
const REQUEST = `${HOME}/.claude/watchers/fleet/acp-${P}.resident.json`;
const ROSTER = `${HOME}/.hermes/bridge/required-mentions.json`;
const MAP = `${HOME}/.hermes/bridge/channel-cto.map`;
const MAP_SCRIPT = `${HOME}/.hermes/bridge/buzz-identity-map.sh`;
const TRANSCRIPT = `${HOME}/.claude/projects/-home-op-projects-e2e-sort-fixture/${CONVERSATION}.jsonl`;
const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const CLAUDE = 16590;
const CHANNEL = "--dangerously-load-development-channels server:acp-buzz-channel";
const recordedExit = hostRefusalText(formatHostProvisionerReason(hostProvisionerReason("claude", "ensure-resident", hostReasonKind.nonZeroExit, 143)!));

interface World {
  ports: CtoPorts;
  out: Record<string, unknown>[];
  /** Every change the command made to the world, in order. */
  changes: string[];
  /** Every subprocess the command ran, in order. */
  ran: string[];
  record: CtoRecord;
  files: Map<string, string>;
  procs: CtoProcess[];
  tmux: Set<string>;
  repo: { exists: boolean };
  operatorAnswers: Array<(method: string) => Decision<unknown> | null>;
  provisionerAnswers: Array<(operation: string) => CtoExecResult | null>;
  mtimes: Map<string, number>;
}

const results = (w: World): Array<[string, string]> => w.out.filter((l) => typeof l["result"] === "string" && typeof l["step"] === "string").map((l) => [l["step"] as string, l["result"] as string]);
const last = (w: World): Record<string, unknown> => w.out[w.out.length - 1]!;

const makeWorld = (overrides: Partial<CtoRecord> = {}, env: Record<string, string | undefined> = { ACP_OPERATOR_TOKEN: "operator-test-credential" }): World => {
  const files = new Map<string, string>([
    [`${CLONE}/README.md`, "clone"], [`${WORKER}/README.md`, "worker"], [REQUEST, JSON.stringify({ allocation: { projectId: P, sessionUuid: CONVERSATION }, packet: { handoff: {} } })],
    [MANIFEST, `# comment\nother\t/x\tother CTO\t/b\t11111111-1111-1111-1111-111111111111\nacp-${P}\t${CLONE}\t${P} CTO\t/boot\t${CONVERSATION}\n`],
    [ROSTER, JSON.stringify({ version: 1, channels: { [ROOM]: { status: "active", acp_project_id: P, peer: { pubkey: ACTOR, handle: "cto-e2e" } } } })],
    [MAP, `${ROOM} cto-${P}\n`], [`${HOME}/.hermes/bridge/keys/cto-${P}.priv`, ACTOR], [TRANSCRIPT, "{}"],
  ]);
  const mtimes = new Map([[TRANSCRIPT, NOW - (IDLE_SECONDS + 60) * 1000]]);
  const w = {
    out: [], changes: [], ran: [], files, mtimes, tmux: new Set([TMUX]), repo: { exists: true }, operatorAnswers: [], provisionerAnswers: [],
    procs: [
      { pid: 100, ppid: 1, command: "/bin/sh /state/resident-e2e-sort-fixture.sh" },
      { pid: CLAUDE, ppid: 100, command: `/bin/claude --model opus ${CHANNEL} --resume ${CONVERSATION} --name e2e CTO` },
      // The acp-cto relay names the conversation too, but is not the conversation's process.
      { pid: 16970, ppid: CLAUDE, command: `/node agentctl.js attach resident-cto --claimed-session-id ${CONVERSATION} --project-id ${P}` },
    ],
    record: {
      projectId: P, name: P, retiredAt: null, kind: "resident",
      repositories: [{ repositoryId: "repo_1", identity: `github:${REPO}`, checkoutPath: WORKER }],
      conversation: CONVERSATION, generation: 3, session: { pid: CLAUDE, startedAt: "t", workdir: CLONE },
      room: ROOM, actorId: ACTOR, resident: { status: "COMPLETE", allocation: { projectId: P, sessionUuid: CONVERSATION, clonePath: CLONE, roomId: ROOM } },
      pendingRotation: null, lastBuzzAt: null, ...overrides,
    },
  } as unknown as World;
  const exists = (path: string): boolean => files.has(path) || [...files.keys()].some((k) => k.startsWith(`${path}/`));
  const move = (from: string, to: string): void => {
    for (const [k, v] of [...files]) if (k === from || k.startsWith(`${from}/`)) { files.delete(k); files.set(to + k.slice(from.length), v); }
  };
  const roster = (): { channels: Record<string, { status: string }> } => JSON.parse(files.get(ROSTER)!) as { channels: Record<string, { status: string }> };
  /** The daemon and the host provisioner's retirement, as `project retire` performs it. */
  const retire = (): Decision<unknown> => {
    w.record = { ...w.record, retiredAt: new Date(NOW).toISOString(), generation: null, session: null };
    const r = roster(); r.channels[ROOM]!.status = "retired"; files.set(ROSTER, JSON.stringify(r));
    files.set(MANIFEST, files.get(MANIFEST)!.split("\n").filter((l) => !l.startsWith(`acp-${P}\t`)).join("\n"));
    files.delete(REQUEST);
    w.procs = w.procs.filter((p) => p.pid !== CLAUDE && p.pid !== 16970);
    move(CLONE, ARCHIVE);
    return allow(ReasonCode.OK, { projectId: P });
  };
  const subprocess = (bin: string, args: readonly string[], options: CtoExecOptions = {}): CtoExecResult => {
    const line = [bin, ...args].join(" ");
    w.ran.push(line);
    const answer = (status: number, stdout = "", stderr = ""): CtoExecResult => ({ status, stdout, stderr });
    if (bin === "tmux" && args[0] === "list-panes") return answer(0, `100 ${TMUX}\n`);
    if (bin === "tmux" && args[0] === "has-session") return answer(w.tmux.has(args[2]!.slice(1)) ? 0 : 1);
    if (bin === "tmux" && args[0] === "kill-session") { w.changes.push(line); w.tmux.delete(args[2]!.slice(1)); return answer(0); }
    if (bin === "git" && args[2] === "status") return answer(0, "");
    if (bin === "git" && args[2] === "log") return answer(0, "");
    if (bin === "git" && args[2] === "config") return answer(0, `${CLONE}\n`);
    if (bin === "gh" && args[0] === "api") return w.repo.exists ? answer(0, `${REPO}\n`) : answer(1, "", "gh: Not Found (HTTP 404)\n");
    if (bin === "gh" && args[0] === "repo" && args[1] === "delete") { w.changes.push(line); w.repo.exists = false; return answer(0); }
    if (bin === MAP_SCRIPT) {
      w.changes.push("buzz-identity-map.sh");
      files.set(MAP, Object.entries(roster().channels).filter(([, v]) => v.status === "active").map(([room]) => `${room} cto-${P}\n`).join(""));
      return answer(0);
    }
    if (bin === "/node" && args[0] === "/prov.mjs") {
      const operation = (JSON.parse(options.input!) as { operation: string }).operation;
      w.changes.push(`provisioner ${operation}`);
      const scripted = w.provisionerAnswers.shift()?.(operation);
      if (scripted) return scripted;
      if (operation === "ensure-resident") {
        w.procs.push({ pid: 20000, ppid: 1, command: `/bin/claude --model opus ${CHANNEL} --resume ${w.record.conversation} --name e2e CTO` });
        return answer(0, JSON.stringify({ fleet: true, resident: { pid: 20000 } }));
      }
      return answer(0, "{}");
    }
    if (bin === "/node" && args[0] === "/rotate.mjs") { w.changes.push(line); return answer(0, `${JSON.stringify({ step: "verify", generation: 27 })}\n`); }
    throw new Error(`unexpected subprocess: ${line}`);
  };
  w.ports = {
    home: HOME, stateDir: STATE, databasePath: `${STATE}/state.sqlite`, env,
    operator: {
      request: async (method: string) => {
        w.changes.push(`operator ${method}`);
        const scripted = w.operatorAnswers.shift()?.(method);
        if (scripted) return scripted;
        return method === "project.retire" ? retire() : allow(ReasonCode.OK, {});
      },
    },
    state: { projects: () => (w.record.retiredAt ? [] : [structuredClone(w.record)]), project: (id: string) => (id === P ? structuredClone(w.record) : null) },
    run: subprocess,
    processes: () => w.procs.slice(),
    startToken: (pid: number) => (w.procs.some((p) => p.pid === pid) ? `start-${pid}` : null),
    signal: (pid: number) => { w.changes.push(`SIGTERM ${pid}`); w.procs = w.procs.filter((p) => p.pid !== pid && p.ppid !== pid); },
    files: {
      exists,
      read: (path: string) => { const body = files.get(path); if (body === undefined) throw new Error(`ENOENT ${path}`); return body; },
      replace: (path: string, body: string) => { w.changes.push(`replace ${path}`); files.set(path, body); },
      remove: (path: string) => { w.changes.push(`remove ${path}`); for (const k of [...files.keys()]) if (k === path || k.startsWith(`${path}/`)) files.delete(k); },
      mtimeMs: (path: string) => (files.has(path) ? mtimes.get(path) ?? NOW : null),
    },
    // A fake key file holds its own public key.
    publicKeyOf: (keyFile: string) => files.get(keyFile) ?? null,
    now: () => NOW, sleep: async () => {}, newUuid: () => "99999999-8888-4777-8666-555555555555",
    write: (line: Record<string, unknown>) => { w.out.push(line); },
    node: "/node", scripts: { provisioner: "/prov.mjs", rotate: "/rotate.mjs" },
  };
  return w;
};

const RETIRE = ["retire", P, "--reason", "fixture done"];
const RETIRE_STEPS = ["idle", "project-retire", "session-stopped", "roster", "channel-map", "fleet", "tmux", "worker-checkouts", "local-checkout"];

describe("agentctl cto: a dry run is the default", () => {
  it("prints every mutating subcommand's plan and changes nothing without --apply", async () => {
    for (const args of [RETIRE, [...RETIRE, "--delete-repo", "--yes-delete-repo", REPO], ["relaunch", P], ["add", P]]) {
      const w = makeWorld();
      expect(await runCtoCommand(args, w.ports)).toBe(0);
      expect(w.out[0]).toMatchObject({ mode: "dry-run" });
      expect(last(w)).toMatchObject({ result: "dry-run" });
      const planned = w.out[0]!["steps"] as string[];
      expect(w.out.slice(1, -1).map((l) => l["step"])).toEqual(planned);
      expect(w.changes).toEqual([]);
      expect(w.ran.filter((l) => /kill-session|repo delete|\/prov\.mjs|\/rotate\.mjs|buzz-identity-map/.test(l))).toEqual([]);
    }
  });

  it("is listed in agentctl's usage", async () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; });
    try { expect(await main(["--help"])).toBe(0); } finally { spy.mockRestore(); }
    expect(written.join("")).toContain("agentctl cto add|relaunch|retire <project>");
  });
});

describe("agentctl cto retire --apply", () => {
  it("runs the plan in its order, reports each step, and removes the worker and archived checkouts", async () => {
    const w = makeWorld();
    expect(await runCtoCommand([...RETIRE, "--apply"], w.ports)).toBe(0);
    expect(results(w).map(([step]) => step)).toEqual(RETIRE_STEPS);
    expect(results(w)).toEqual([
      ["idle", "done"], ["project-retire", "done"], ["session-stopped", "skipped"], ["roster", "skipped"], ["channel-map", "done"],
      ["fleet", "skipped"], ["tmux", "done"], ["worker-checkouts", "done"], ["local-checkout", "done"],
    ]);
    expect(last(w)).toEqual({ result: "done" });
    expect(w.changes).toEqual([
      "operator project.retire", "buzz-identity-map.sh", `tmux kill-session -t =${TMUX}`, `remove ${WORKER}`, `remove ${ARCHIVE}`,
    ]);
    expect(w.files.get(MAP)).toBe("");
    expect([...w.files.keys()].some((k) => k.startsWith(WORKER) || k.startsWith(ARCHIVE) || k.startsWith(CLONE))).toBe(false);
    expect(w.ran.some((l) => l.startsWith("gh repo delete"))).toBe(false);
  });

  it("stops at the first failure and, run again, continues from where it stopped", async () => {
    const w = makeWorld();
    w.operatorAnswers.push(() => deny(ReasonCode.CONFLICT, "host retirement refused: provisioner busy; nothing was changed", { requiredOrder: [`run agentctl project retire ${P} again`] }));
    expect(await runCtoCommand([...RETIRE, "--apply"], w.ports)).toBe(1);
    expect(results(w)).toEqual([["idle", "done"], ["project-retire", "failed"]]);
    expect(last(w)).toMatchObject({ result: "stopped", at: "project-retire", rerun: `agentctl cto retire ${P} --reason "fixture done" --apply` });
    expect(w.changes).toEqual(["operator project.retire"]);
    expect(w.files.has(`${WORKER}/README.md`)).toBe(true);

    w.out.length = 0; w.changes.length = 0;
    expect(await runCtoCommand([...RETIRE, "--apply"], w.ports)).toBe(0);
    expect(results(w).map(([step]) => step)).toEqual(RETIRE_STEPS);
    expect(w.changes[0]).toBe("operator project.retire");

    // Everything is in place now: a third run changes nothing.
    w.out.length = 0; w.changes.length = 0;
    expect(await runCtoCommand([...RETIRE, "--apply"], w.ports)).toBe(0);
    expect(results(w).filter(([, r]) => r !== "skipped")).toEqual([["idle", "done"]]);
    expect(w.changes).toEqual([]);
  });

  it("keeps an archived clone holding work no remote has, and stops before anything after it", async () => {
    const w = makeWorld();
    const original = w.ports.run;
    w.ports.run = (bin, args, options) => (bin === "git" && args[2] === "log" ? { status: 0, stdout: "abc123\n", stderr: "" } : original(bin, args, options));
    expect(await runCtoCommand([...RETIRE, "--apply"], w.ports)).toBe(1);
    expect(results(w).at(-1)).toEqual(["local-checkout", "failed"]);
    expect(w.files.has(`${ARCHIVE}/README.md`)).toBe(true);
  });

  it("does not run while the CTO is mid-turn", async () => {
    const w = makeWorld();
    w.mtimes.set(TRANSCRIPT, NOW - 5_000);
    expect(await runCtoCommand([...RETIRE, "--apply"], w.ports)).toBe(1);
    expect(results(w)).toEqual([["idle", "failed"]]);
    expect(w.changes).toEqual([]);
  });
});

describe("agentctl cto retire --delete-repo", () => {
  it("is refused, with nothing planned or run, unless --yes-delete-repo names the repository exactly", async () => {
    for (const extra of [["--delete-repo"], ["--delete-repo", "--yes-delete-repo", "MongLong0214/e2e-sort-fixtur"],
      ["--delete-repo", "--yes-delete-repo", "monglong0214/e2e-sort-fixture"], ["--delete-repo", "--yes-delete-repo", "e2e-sort-fixture"],
      ["--yes-delete-repo", REPO]]) {
      const w = makeWorld();
      expect(await runCtoCommand([...RETIRE, ...extra, "--apply"], w.ports)).toBe(2);
      expect(w.out).toEqual([expect.objectContaining({ nothingChanged: true })]);
      expect(w.changes).toEqual([]);
      expect(w.ran).toEqual([]);
    }
  });

  it("deletes exactly that repository, last, once every other step is done", async () => {
    const w = makeWorld();
    expect(await runCtoCommand([...RETIRE, "--delete-repo", "--yes-delete-repo", REPO, "--apply"], w.ports)).toBe(0);
    expect(results(w).map(([step]) => step)).toEqual([...RETIRE_STEPS, "github-repo"]);
    expect(w.changes.at(-1)).toBe(`gh repo delete ${REPO} --yes`);
    expect(w.changes.filter((c) => c.includes("repo delete"))).toHaveLength(1);
  });

  it("never reaches the deletion when an earlier step fails", async () => {
    const w = makeWorld();
    const original = w.ports.run;
    w.ports.run = (bin, args, options) => (bin === "git" && args[2] === "config" ? { status: 0, stdout: "/somewhere/else\n", stderr: "" } : original(bin, args, options));
    expect(await runCtoCommand([...RETIRE, "--delete-repo", "--yes-delete-repo", REPO, "--apply"], w.ports)).toBe(1);
    expect(results(w).at(-1)).toEqual(["worker-checkouts", "failed"]);
    expect(w.ran.some((l) => l.startsWith("gh repo delete"))).toBe(false);
    expect(w.repo.exists).toBe(true);
  });
});

describe("agentctl cto relaunch", () => {
  it("stops only the resident's claude process and starts it again through ensure-resident, acknowledging its recorded exit", async () => {
    const w = makeWorld();
    w.provisionerAnswers.push((operation) => (operation === "ensure-resident" ? { status: 3, stdout: "", stderr: recordedExit } : null));
    expect(await runCtoCommand(["relaunch", P, "--apply"], w.ports)).toBe(0);
    expect(results(w)).toEqual([["idle", "done"], ["stop", "done"], ["launch", "done"]]);
    expect(w.changes).toEqual([`SIGTERM ${CLAUDE}`, "provisioner ensure-resident", "provisioner acknowledge-resident-exit", "provisioner ensure-resident"]);
    expect(w.procs.find((p) => p.pid === 20000)?.command).toContain(`${CHANNEL} --resume ${CONVERSATION}`);
  });

  it("continues with the launch when a rerun finds the old process already stopped", async () => {
    const w = makeWorld();
    w.provisionerAnswers.push(() => ({ status: 1, stdout: "", stderr: "host project provisioner refused operation: provisioner busy\n" }));
    expect(await runCtoCommand(["relaunch", P, "--apply"], w.ports)).toBe(1);
    expect(results(w)).toEqual([["idle", "done"], ["stop", "done"], ["launch", "failed"]]);
    w.out.length = 0; w.changes.length = 0;
    expect(await runCtoCommand(["relaunch", P, "--apply"], w.ports)).toBe(0);
    expect(results(w)).toEqual([["idle", "done"], ["stop", "skipped"], ["launch", "done"]]);
    expect(w.changes).toEqual(["provisioner ensure-resident"]);
  });

  it("moves a canonical CTO through rotate-canonical-cto, which needs a handoff package", async () => {
    const w = makeWorld({ kind: "canonical", resident: null, generation: 26 });
    expect(await runCtoCommand(["relaunch", P, "--apply"], w.ports)).toBe(1);
    expect(results(w)).toEqual([["idle", "done"], ["rotate", "failed"]]);
    expect(w.changes).toEqual([]);
    w.out.length = 0;
    expect(await runCtoCommand(["relaunch", P, "--handoff", "/h.json", "--apply"], w.ports)).toBe(0);
    expect(w.changes).toEqual([`/node /rotate.mjs --project ${P} --to 99999999-8888-4777-8666-555555555555 --expected-generation 26 --cwd ${CLONE} --old-pid ${CLAUDE} --tmux-session cto-${P}-99999999 --handoff /h.json`]);
  });
});

describe("agentctl cto list", () => {
  it("reports the CTO's generation, live session, channel, room and route, and not its relay", async () => {
    const w = makeWorld();
    expect(await runCtoCommand(["list"], w.ports)).toBe(0);
    expect(w.out).toEqual([{ ctos: [expect.objectContaining({
      project: P, kind: "resident", generation: 3, conversation: CONVERSATION, room: ROOM, roomRouted: true,
      session: [{ pid: CLAUDE, tmux: TMUX, channel: true }],
    })] }]);
  });
});

describe("agentctl cto is operator only", () => {
  it("refuses --apply, before any step, without the operator credential a CTO's launch shell unsets", async () => {
    for (const args of [[...RETIRE, "--apply"], ["relaunch", P, "--apply"], ["add", P, "--apply"]]) {
      const w = makeWorld({}, {});
      expect(await runCtoCommand(args, w.ports)).toBe(2);
      expect(w.out).toEqual([expect.objectContaining({ nothingChanged: true })]);
      expect(w.changes).toEqual([]);
      expect(w.ran).toEqual([]);
    }
  });

  it("has no tool on a CTO's acp-cto surface", async () => {
    const h = makeHarness();
    const cto = createCtoServer(createCtoMcpPort(h.cp), () => allow(ReasonCode.OK, { actor: "cto" }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await cto.connect(serverTransport);
    const client = new Client({ name: "cto-surface", version: "1" });
    await client.connect(clientTransport);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names.length).toBeGreaterThan(0);
      for (const sub of CTO_SUBCOMMANDS) expect(names).not.toContain(`cto_${sub}`);
      expect(names.filter((name) => /retire|relaunch|project_register|repo_delete/.test(name))).toEqual([]);
    } finally {
      await client.close();
    }
  });
});
