/**
 * One canonical CTO restart, in a process of its own (#1068 final review: simultaneous retargeting
 * by independent OS processes on one database file).
 *
 * Run by `a-canonical-restart-keeps-the-ceo-peer-message.test.ts` with
 * `node --experimental-transform-types`. It opens its own control plane on the fixture's database file
 * — its own SQLite connection, in its own address space, with nothing shared with the test process
 * but the file — builds the same self-claim the fixture builds for run `run`, waits at a file barrier
 * so that two such processes claim at the same instant, claims, and prints one JSON line.
 *
 * Only the process table, the image scan, the transcript lookup and the relay are fixtures, exactly
 * as in the test file; the claim, its recovery, the outbox carry and the database are real.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ManualClock } from "../../src/core/clock.ts";
import { allow, type Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  CanonicalSelfClaim,
  hostSessionRegistryAbsent,
  type ProcessSnapshot,
} from "../../src/registry/canonical-self-claim.ts";
import { makeHarness } from "./harness.ts";

interface ChildInput {
  root: string;
  repoPath: string;
  nowIso: string;
  projectId: string;
  ctoBuzzActor: string;
  ownerActor: string;
  barrierDir: string;
  name: string;
  run: number;
  canon: string;
  cwd: string;
  room: string;
  protocol: string;
  identity: string;
}

const input = JSON.parse(process.argv[2] ?? "{}") as ChildInput;

/** The fixture's `claudeRun`, verbatim: a new claude pid and start for each run. */
const claudeRun = (run: number): ProcessSnapshot[] => {
  const claudePid = 9 + run;
  return [
    {
      pid: 100, ppid: 50, argv: ["/usr/bin/node", "/opt/acp/mcp-server.js"],
      command: "/usr/bin/node /opt/acp/mcp-server.js", cwd: input.cwd, cwdProbeFailure: null, startedAt: "t1",
    },
    {
      pid: 50, ppid: claudePid, argv: ["/bin/zsh", "-c", "relay"], command: "/bin/zsh -c relay", cwd: input.cwd,
      cwdProbeFailure: null, startedAt: "t2",
    },
    {
      pid: claudePid, ppid: 1, argv: ["/opt/claude/claude", "--session-id", input.canon],
      command: `/opt/claude/claude --session-id ${input.canon}`, cwd: input.cwd, cwdProbeFailure: null,
      startedAt: `Fri Jan  1 0${run}:00:00 2027`,
    },
  ];
};

const main = async (): Promise<void> => {
  const harness = makeHarness({
    root: input.root,
    repoPath: input.repoPath,
    clock: new ManualClock(input.nowIso),
    ownerIdentities: [{ channel: "buzz", actor: input.ownerActor }],
  });
  const chain = claudeRun(input.run);
  const subject = new CanonicalSelfClaim(
    harness.cp.db,
    harness.clock,
    harness.cp.audit,
    harness.cp.sessions,
    harness.cp.bindings,
    { isAllowedActor: () => true },
    async (): Promise<Decision<string>> => allow(ReasonCode.OK, input.room),
    {
      canonicalSessions: [{ sessionUuid: input.canon, projectId: input.projectId, buzzActorId: input.ctoBuzzActor }],
      canonicalBuzzChannelId: input.room,
      expectedPeerProtocolVersion: input.protocol,
      expectedPeerIdentity: input.identity,
    },
    {
      processInspector: { snapshot: (pid) => chain.find((entry) => entry.pid === pid) ?? null },
      imageInspector: {
        resolve: () => ({ imagePath: "/fake/claude", version: "0.0.0-test", sha256: `sha256:${"0".repeat(64)}` }),
      },
      transcriptReader: { locate: (uuid) => ({ path: `/fake/transcripts/${uuid}.jsonl`, sizeBytes: 42 }) },
      hostSessionRegistryReader: { read: (pid) => hostSessionRegistryAbsent(`/fake/sessions/${pid}.json is absent`) },
      processSignal: (pid) => {
        if (chain.some((entry) => entry.pid === pid)) return;
        throw Object.assign(new Error(`no such process: ${pid}`), { code: "ESRCH" });
      },
    },
  );
  writeFileSync(join(input.barrierDir, `${input.name}.ready`), "");
  while (!existsSync(join(input.barrierDir, "go"))) await new Promise((resolve) => setTimeout(resolve, 2));
  let result: Record<string, unknown>;
  try {
    const claimed = await subject.claim({
      callerPid: 100,
      claimedSessionUuid: input.canon,
      projectId: input.projectId,
      expectedBindingGeneration: 2,
      peerProtocolVersion: input.protocol,
      peerIdentity: input.identity,
      buzzPurpose: "continuity:PRIMARY_CTO",
    });
    result = claimed.allowed
      ? { allowed: true, sessionId: claimed.value.sessionId, generation: claimed.value.binding.bindingGeneration,
          pid: process.pid }
      : { allowed: false, reasonCode: claimed.reasonCode, pid: process.pid };
  } catch (error) {
    result = { allowed: false, threw: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      pid: process.pid };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  harness.cp.close();
};

await main();
