import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ControlPlane, type ControlPlaneConfig } from "../app/control-plane.ts";
import { digestOf } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { Role, SessionLifecycle } from "../domain/types.ts";
import {
  TelegramDeliveryError,
  type TelegramBotTransport,
  type TelegramSentMessage,
  startTelegramLongPollListener,
} from "../ingress/telegram-polling.ts";
import type { TelegramRouteOutcome } from "../ingress/telegram-router.ts";
import type { TelegramUpdate } from "../ingress/telegram.ts";
import {
  REALM_EVIDENCE_CLAIM,
  type OwnedProcess,
  type ProductionCensus,
  type RealmPaths,
  assertProductionUnchanged,
  censusProduction,
  classifyProbeSignal,
  mayTerminate,
  planDisposableRealm,
  productionRoot,
  realmLayout,
  verifyRealmResidue,
} from "./disposable-realm.ts";

const OWNER_ID = "655001";
const CHAT_ID = "-100655001";
const WEBHOOK_SECRET = "synthetic-disposable-realm-secret";
const UPDATE_IDS = [65_501, 65_502] as const;
const MESSAGE_IDS = [75_501, 75_502] as const;
const PROMPTS = ["synthetic probe 1", "synthetic probe 2"] as const;

export type SyntheticProbeFault =
  | "AMBIGUOUS_FIRST_SEND"
  | "BEFORE_CENSUS_UNOBSERVABLE"
  | "FABRICATED_REPLY"
  | "ONE_MESSAGE_ONLY"
  | "PROBE_TARGET_IS_CANONICAL"
  | "REALM_POINTS_AT_FAKE_PRODUCTION"
  | "SECOND_ACTOR"
  | "SYNTHETIC_BASELINE_CHANGES"
  | "LEAVE_REALM_RESIDUE";

export interface SyntheticDisposableRealmOptions {
  /** There is deliberately no live mode and no Telegram credential option. */
  readonly evidenceClaim?: string;
  /** Deterministic fault injection for the negative matrix; every path stays in synthetic state. */
  readonly fault?: SyntheticProbeFault;
}

export interface SyntheticProbeOutcome {
  readonly updateId: number;
  readonly admitted: boolean;
  readonly classification: TelegramRouteOutcome["classification"];
  readonly reasonCode: string;
  readonly reply: string | null;
}

export interface SyntheticSentReply {
  readonly replyToMessageId: number | undefined;
  readonly text: string;
}

export interface SyntheticTargetTurn {
  readonly prompt: string;
  readonly reply: string;
}

export interface SyntheticProbeTrace {
  readonly outcomes: SyntheticProbeOutcome[];
  readonly sentReplies: SyntheticSentReply[];
  readonly targetTurns: SyntheticTargetTurn[];
  readonly durableNonces: string[];
  readonly actorIds: string[];
  readonly targetActorIds: string[];
}

export interface SyntheticDisposableRealmEvidence {
  readonly mode: "SYNTHETIC";
  readonly claim: typeof REALM_EVIDENCE_CLAIM;
  readonly updateIds: readonly number[];
  readonly replyCount: number;
  readonly targetTurnCount: number;
  readonly durableNonceCount: number;
  readonly disposableActorCount: number;
  readonly targetBindingCount: number;
  readonly syntheticBaselineUnchanged: true;
  readonly residue: readonly string[];
  readonly layout: readonly string[];
}

/**
 * The two-message claim is structural, not a count attached after the fact.
 *
 * Every observation must agree on the same two updates: Telegram admission, the reply accepted
 * by the transport, the synthetic target's own transcript and the durable APPLIED row. The realm
 * must also contain one actor with one lifetime binding to the synthetic target. A two in one
 * column and a zero in another is an incomplete probe, not a partially successful one.
 */
export const assertSyntheticProbeComplete = (
  trace: SyntheticProbeTrace,
): Decision<void> => {
  const expectedNonces = UPDATE_IDS.map((id) => `update:${id}`);
  const counts = {
    outcomes: trace.outcomes.length,
    sentReplies: trace.sentReplies.length,
    targetTurns: trace.targetTurns.length,
    durableNonces: trace.durableNonces.length,
    actorIds: trace.actorIds.length,
    targetActorIds: trace.targetActorIds.length,
  };
  if (
    counts.outcomes !== 2 ||
    counts.sentReplies !== 2 ||
    counts.targetTurns !== 2 ||
    counts.durableNonces !== 2 ||
    counts.actorIds !== 1 ||
    counts.targetActorIds !== 1
  ) {
    return deny(
      ReasonCode.ACCEPTANCE_PROBE_INCOMPLETE,
      "the disposable probe did not produce two complete round trips owned by one actor",
      counts,
    );
  }

  for (let index = 0; index < UPDATE_IDS.length; index += 1) {
    const outcome = trace.outcomes[index]!;
    const sent = trace.sentReplies[index]!;
    const target = trace.targetTurns[index]!;
    const expectedReply =
      `DIRECT received; no run created\n${target.reply}\n` +
      `correlation: telegram:${UPDATE_IDS[index]}:${MESSAGE_IDS[index]}`;
    if (
      outcome.updateId !== UPDATE_IDS[index] ||
      outcome.admitted !== true ||
      outcome.classification !== "DIRECT" ||
      outcome.reasonCode !== ReasonCode.OK ||
      outcome.reply !== expectedReply ||
      sent.replyToMessageId !== MESSAGE_IDS[index] ||
      sent.text !== expectedReply ||
      target.prompt !== PROMPTS[index] ||
      trace.durableNonces[index] !== expectedNonces[index]
    ) {
      return deny(
        ReasonCode.ACCEPTANCE_PROBE_INCOMPLETE,
        "the synthetic transport, target transcript and durable reply do not describe the same turn",
        { index, outcome, sent, target, durableNonce: trace.durableNonces[index] ?? null },
      );
    }
  }
  return allow(ReasonCode.OK, undefined);
};

/** Cleanup may act only on the exact process identities this run recorded at creation. */
export const assertCleanupCandidatesOwned = (
  owned: readonly OwnedProcess[],
  candidates: readonly OwnedProcess[],
): Decision<void> => {
  const unowned = candidates.filter((candidate) => !mayTerminate(owned, candidate));
  if (unowned.length > 0) {
    return deny(
      ReasonCode.ACCEPTANCE_PROCESS_NOT_OWNED,
      "cleanup refused a process whose pid and start time were not both owned by this run",
      { unowned },
    );
  }
  return allow(ReasonCode.OK, undefined);
};

const assertEvidenceClaim = (claim: string): Decision<typeof REALM_EVIDENCE_CLAIM> =>
  claim === REALM_EVIDENCE_CLAIM
    ? allow(ReasonCode.OK, REALM_EVIDENCE_CLAIM)
    : deny(
        ReasonCode.ACCEPTANCE_EVIDENCE_OVERCLAIMED,
        "the requested evidence sentence claims more than the disposable realm observed",
        { permittedClaim: REALM_EVIDENCE_CLAIM },
      );

const controlPlaneConfig = (
  root: string,
  ownerIdentities: ControlPlaneConfig["ownerIdentities"] = [],
): ControlPlaneConfig => ({
  databasePath: join(root, "state.sqlite"),
  worktreeRoot: join(root, "worktrees"),
  capacityDir: join(root, "capacity"),
  secretsDir: join(root, "secrets"),
  runtimeRoot: join(root, "runtime"),
  githubAppEnvFile: join(root, "credentials", "github-app.env"),
  adapters: [],
  ownerIdentities,
});

const productionRecords = (
  cp: ControlPlane,
): Pick<ProductionCensus, "actorIds" | "bindingGenerations" | "assignmentIds"> => ({
  actorIds: cp.db
    .all<{ actor_id: string }>("SELECT actor_id FROM conversational_actors ORDER BY actor_id")
    .map((row) => row.actor_id),
  bindingGenerations: cp.db
    .all<{ role_key: string; binding_generation: number }>(
      "SELECT role_key, binding_generation FROM assignments ORDER BY role_key, binding_generation",
    )
    .map((row) => `${row.role_key}:${row.binding_generation}`),
  assignmentIds: cp.db
    .all<{ assignment_id: string }>("SELECT assignment_id FROM assignments ORDER BY assignment_id")
    .map((row) => row.assignment_id),
});

const takeProductionCensus = (
  cp: ControlPlane,
  root: string,
): Decision<ProductionCensus> => censusProduction(root, productionRecords(cp));

const update = (index: number): TelegramUpdate => ({
  update_id: UPDATE_IDS[index]!,
  message: {
    message_id: MESSAGE_IDS[index]!,
    date: 1_787_978_400 + index,
    text: PROMPTS[index]!,
    from: { id: Number(OWNER_ID), username: "synthetic-owner" },
    chat: { id: Number(CHAT_ID) },
  },
});

class SyntheticTelegramTransport implements TelegramBotTransport {
  readonly sentReplies: SyntheticSentReply[] = [];
  polls = 0;
  sends = 0;
  #next = 0;

  constructor(private readonly fault?: SyntheticProbeFault) {}

  async getUpdates(): Promise<readonly TelegramUpdate[]> {
    this.polls += 1;
    if (this.fault === "ONE_MESSAGE_ONLY" && this.#next === 1) return [];
    if (this.#next >= UPDATE_IDS.length) return [];
    const next = update(this.#next);
    this.#next += 1;
    return [next];
  }

  async sendMessage(input: {
    chatId: string;
    text: string;
    replyToMessageId?: number;
    correlationId: string;
  }): Promise<TelegramSentMessage> {
    this.sends += 1;
    if (this.fault === "AMBIGUOUS_FIRST_SEND" && this.sends === 1) {
      throw new TelegramDeliveryError("synthetic transport result is ambiguous", null);
    }
    const recordedText = this.fault === "FABRICATED_REPLY" && this.sends === 2
      ? "a fabricated reply"
      : input.text;
    this.sentReplies.push({ replyToMessageId: input.replyToMessageId, text: recordedText });
    return { messageId: 85_500 + this.sends };
  }
}

const JANITOR_SOURCE = String.raw`
const { mkdirSync, rmSync } = require("node:fs");
const target = process.argv[1];
let cleaning = false;
const clean = () => {
  if (cleaning) return;
  cleaning = true;
  try {
    rmSync(target, { recursive: true, force: true });
    process.exit(0);
  } catch (error) {
    process.stderr.write(String(error && error.message ? error.message : error));
    process.exit(1);
  }
};
mkdirSync(target, { recursive: true, mode: 0o700 });
process.stdin.resume();
process.stdin.once("end", clean);
process.stdin.once("error", clean);
process.once("SIGTERM", clean);
process.stdout.write("READY\n");
`;

export interface RealmJanitor {
  release(): Promise<Decision<void>>;
}

export interface JanitorOwnedRealmWorkspace {
  readonly workspace: string;
  readonly janitor: RealmJanitor;
}

/**
 * A separate process creates and owns the outer synthetic workspace.
 *
 * The path does not exist before spawn. The janitor creates it only after its ownership pipe is
 * established, then reports READY. Normal completion closes the pipe after every database handle
 * is closed; parent death closes it in the kernel, so SIGKILL cannot strand a realm between mkdir
 * and janitor setup. A machine-wide death can still leave the OS temp entry until the host cleans
 * its temp volume; no evidence is returned in that case, and a later live driver still does not
 * exist.
 */
export const createJanitorOwnedRealmWorkspace = async (): Promise<JanitorOwnedRealmWorkspace> => {
  const workspace = join(tmpdir(), `acp-655-synthetic-${randomUUID()}`);
  const janitor = await new Promise<RealmJanitor>((resolveJanitor, reject) => {
    const child = spawn(process.execPath, ["-e", JANITOR_SOURCE, workspace], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    let ready = false;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.stdout.setEncoding("utf8");
    const exited = new Promise<number | null>((resolveExit) => {
      child.once("exit", (code) => {
        resolveExit(code);
        if (!ready) reject(new Error(`the synthetic workspace janitor exited before READY: ${code}`));
      });
    });
    child.once("error", reject);
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (!stdout.split("\n").includes("READY")) return;
      ready = true;
      resolveJanitor({
        release: async () => {
          child.stdin.end();
          const code = await exited;
          if (code === 0 && !existsSync(workspace)) {
            return allow(ReasonCode.OK, undefined);
          }
          return deny(
            ReasonCode.ACCEPTANCE_REALM_RESIDUE,
            "the crash janitor did not remove the synthetic workspace",
            { code, stderr, workspacePresent: existsSync(workspace) },
          );
        },
      });
    });
  });
  return { workspace, janitor };
};

/**
 * Runs the only driver #655 currently permits: deterministic transport and target, never live
 * Telegram, never the live Gateway, and never a caller-supplied state root.
 */
export const runSyntheticDisposableRealmProbe = async (
  options: SyntheticDisposableRealmOptions = {},
): Promise<Decision<SyntheticDisposableRealmEvidence>> => {
  const claim = assertEvidenceClaim(options.evidenceClaim ?? REALM_EVIDENCE_CLAIM);
  if (!claim.allowed) return claim;

  // The caller cannot name this path. That is the synthetic-first embargo in the API: there is no
  // option through which ~/.hermes, ~/.agent-control-plane or Telegram credentials can enter.
  let ownedWorkspace: JanitorOwnedRealmWorkspace;
  try {
    ownedWorkspace = await createJanitorOwnedRealmWorkspace();
  } catch (error) {
    return deny(
      ReasonCode.INTERNAL_ERROR,
      "the synthetic workspace janitor could not start",
      { error: error instanceof Error ? error.message : String(error) },
    );
  }
  const { workspace, janitor } = ownedWorkspace;
  let production: ControlPlane | null = null;
  let realm: ControlPlane | null = null;
  let listener: Awaited<ReturnType<typeof startTelegramLongPollListener>> | null = null;
  let residueWasPresent = false;

  const execute = async (): Promise<Decision<SyntheticDisposableRealmEvidence>> => {
    try {
    const fakeHome = join(workspace, "home");
    const fakeProductionRoot = productionRoot(fakeHome);
    const stateDir = options.fault === "REALM_POINTS_AT_FAKE_PRODUCTION"
      ? join(fakeProductionRoot, "realm")
      : join(workspace, "realm");
    const paths: RealmPaths = {
      stateDir,
      databasePath: join(stateDir, "state.sqlite"),
      runtimeRoot: join(stateDir, "runtime"),
      socketDir: join(stateDir, "sockets"),
      lockPath: join(stateDir, "agentcpd.lock"),
    };
    const canonicalTargetRoot = join(workspace, "canonical-target");
    const probeTargetRoot = options.fault === "PROBE_TARGET_IS_CANONICAL"
      ? canonicalTargetRoot
      : join(stateDir, "probe-target");

    mkdirSync(canonicalTargetRoot, { recursive: true, mode: 0o700 });
    production = new ControlPlane(controlPlaneConfig(fakeProductionRoot));

    const planned = planDisposableRealm({
      home: fakeHome,
      paths,
      probeTargetRoot,
      canonicalTargetRoot,
    });
    if (!planned.allowed) {
      return planned as Decision<SyntheticDisposableRealmEvidence>;
    }

    const before = options.fault === "BEFORE_CENSUS_UNOBSERVABLE"
      ? deny<ProductionCensus>(
          ReasonCode.ACCEPTANCE_CENSUS_UNOBSERVABLE,
          "the synthetic before census was deliberately made unobservable",
        )
      : takeProductionCensus(production, fakeProductionRoot);
    if (!before.allowed) {
      return before as Decision<SyntheticDisposableRealmEvidence>;
    }

    mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
    // Re-plan after creation. The safety module names a link introduced between plan and use as a
    // limit; closing the ordinary create-time window here keeps this driver on the checked side.
    const createdPlan = planDisposableRealm({
      home: fakeHome,
      paths,
      probeTargetRoot,
      canonicalTargetRoot,
    });
    if (!createdPlan.allowed) {
      return createdPlan as Decision<SyntheticDisposableRealmEvidence>;
    }

    realm = new ControlPlane(controlPlaneConfig(paths.stateDir, [{ channel: "telegram", actor: OWNER_ID }]));
    const session = realm.sessions.create({
      provider: "synthetic-acceptance",
      model: "synthetic-disposable-target",
      workdir: probeTargetRoot,
    });
    const ready = realm.sessions.transition(
      session.sessionId,
      SessionLifecycle.READY,
      "synthetic disposable target ready",
    );
    if (!ready.allowed) {
      return ready as Decision<SyntheticDisposableRealmEvidence>;
    }
    const targetLocatorDigest = digestOf({ executorKind: "hermes", targetLocator: probeTargetRoot });
    const bound = realm.bindings.bind({
      role: Role.CEO,
      sessionId: session.sessionId,
      verifiedTarget: {
        executorKind: "hermes",
        targetLocator: probeTargetRoot,
        targetLocatorDigest,
      },
    });
    if (!bound.allowed) {
      return bound as Decision<SyntheticDisposableRealmEvidence>;
    }
    if (options.fault === "SECOND_ACTOR") {
      const secondTargetRoot = join(paths.stateDir, "second-probe-target");
      const secondSession = realm.sessions.create({
        provider: "synthetic-acceptance",
        model: "synthetic-second-target",
        workdir: secondTargetRoot,
      });
      const secondReady = realm.sessions.transition(
        secondSession.sessionId,
        SessionLifecycle.READY,
        "synthetic second target ready",
      );
      if (!secondReady.allowed) {
        return secondReady as Decision<SyntheticDisposableRealmEvidence>;
      }
      const switched = realm.bindings.switchTo({
        role: Role.CEO,
        sessionId: secondSession.sessionId,
        verifiedTarget: {
          executorKind: "hermes",
          targetLocator: secondTargetRoot,
          targetLocatorDigest: digestOf({
            executorKind: "hermes",
            targetLocator: secondTargetRoot,
          }),
        },
        reason: "synthetic fault injects a second actor",
        conversation: "REPLACED",
        expectedCurrentGeneration: bound.value.bindingGeneration,
      });
      if (!switched.allowed) {
        return switched as Decision<SyntheticDisposableRealmEvidence>;
      }
    }

    const targetTurns: SyntheticTargetTurn[] = [];
    const transport = new SyntheticTelegramTransport(options.fault);
    listener = await startTelegramLongPollListener(
      realm,
      {
        botToken: "synthetic-token-not-a-credential",
        allowedOwnerIds: [OWNER_ID],
        allowedChatIds: [CHAT_ID],
        webhookSecret: WEBHOOK_SECRET,
        pollTimeoutSeconds: 1,
        retryDelayMs: 100,
      },
      {
        transport,
        start: false,
        onDirect: (input) => {
          const reply = `synthetic reply ${targetTurns.length + 1}`;
          const turn = { prompt: input.text, reply };
          mkdirSync(probeTargetRoot, { recursive: true, mode: 0o700 });
          appendFileSync(join(probeTargetRoot, "transcript.jsonl"), `${JSON.stringify(turn)}\n`, {
            encoding: "utf8",
            mode: 0o600,
          });
          targetTurns.push(turn);
          return reply;
        },
      },
    );

    const outcomes: TelegramRouteOutcome[] = [];
    for (let index = 0; index < UPDATE_IDS.length; index += 1) {
      try {
        const polled = await listener.service.pollOnce();
        outcomes.push(...polled.outcomes);
      } catch (error) {
        const signal = error instanceof TelegramDeliveryError && error.accepted === null
          ? "TELEGRAM_SEND_AMBIGUOUS"
          : "SOCKET_CLOSED";
        if (classifyProbeSignal(signal) === "INCONCLUSIVE") {
          return deny(
            ReasonCode.ACCEPTANCE_PROBE_INCONCLUSIVE,
            "the synthetic probe stopped after an outcome that cannot be retried safely",
            { signal, polls: transport.polls, sends: transport.sends, targetTurns: targetTurns.length },
          );
        }
        throw error;
      }
    }

    const durableNonces = realm.db
      .all<{ nonce: string; result_json: string | null }>(
        "SELECT nonce, result_json FROM inbound_messages WHERE channel = 'telegram' ORDER BY nonce",
      )
      .filter((row) => {
        if (!row.result_json) return false;
        try {
          const value = JSON.parse(row.result_json) as { deliveryStatus?: unknown };
          return value.deliveryStatus === "APPLIED";
        } catch {
          return false;
        }
      })
      .map((row) => row.nonce);
    const actorIds = realm.db
      .all<{ actor_id: string }>("SELECT actor_id FROM conversational_actors ORDER BY actor_id")
      .map((row) => row.actor_id);
    const targetActorIds = realm.db
      .all<{ target_actor_id: string }>(
        `SELECT target_actor_id FROM actor_target_bindings
          WHERE executor_kind = ? AND target_locator_digest = ? ORDER BY target_actor_id`,
        ["hermes", targetLocatorDigest],
      )
      .map((row) => row.target_actor_id);
    const trace: SyntheticProbeTrace = {
      outcomes: outcomes.map((outcome) => ({
        updateId: outcome.updateId,
        admitted: outcome.admitted,
        classification: outcome.classification,
        reasonCode: outcome.reasonCode,
        reply: outcome.reply?.text ?? null,
      })),
      sentReplies: transport.sentReplies,
      targetTurns,
      durableNonces,
      actorIds,
      targetActorIds,
    };
    const complete = assertSyntheticProbeComplete(trace);
    if (!complete.allowed) {
      return complete as Decision<SyntheticDisposableRealmEvidence>;
    }

    // Synthetic mode starts no target or Gateway process. The empty set is still passed through
    // the same ownership decision a future child would have to satisfy; the negative case is a
    // public helper and is exercised with a reused pid in the affected test.
    const cleanupOwnership = assertCleanupCandidatesOwned([], []);
    if (!cleanupOwnership.allowed) {
      return cleanupOwnership as Decision<SyntheticDisposableRealmEvidence>;
    }

    const layout = realmLayout(paths);
    await listener.close();
    listener = null;
    realm.close();
    realm = null;

    if (options.fault !== "LEAVE_REALM_RESIDUE") {
      rmSync(paths.stateDir, { recursive: true, force: true });
    }
    if (options.fault === "SYNTHETIC_BASELINE_CHANGES") {
      writeFileSync(join(fakeProductionRoot, "unexpected-during-probe"), "changed", { mode: 0o600 });
    }

    const after = takeProductionCensus(production, fakeProductionRoot);
    if (!after.allowed) {
      return after as Decision<SyntheticDisposableRealmEvidence>;
    }
    const unchanged = assertProductionUnchanged(before.value, after.value);
    if (!unchanged.allowed) {
      return unchanged as Decision<SyntheticDisposableRealmEvidence>;
    }

    const residue = verifyRealmResidue(paths);
    if (!residue.allowed) {
      residueWasPresent = true;
      return residue as Decision<SyntheticDisposableRealmEvidence>;
    }

    return allow(ReasonCode.OK, {
      mode: "SYNTHETIC",
      claim: claim.value,
      updateIds: outcomes.map((outcome) => outcome.updateId),
      replyCount: transport.sentReplies.length,
      targetTurnCount: targetTurns.length,
      durableNonceCount: durableNonces.length,
      disposableActorCount: actorIds.length,
      targetBindingCount: targetActorIds.length,
      syntheticBaselineUnchanged: true,
      residue: [],
      layout,
    });
    } catch (error) {
      return deny(
        ReasonCode.INTERNAL_ERROR,
        "the synthetic disposable realm driver failed",
        { error: error instanceof Error ? error.message : String(error) },
      );
    } finally {
      await listener?.close().catch(() => undefined);
      realm?.close();
      production?.close();
    }
  };

  const result = await execute();
  const released = await janitor.release();
  if (!released.allowed) return released as Decision<SyntheticDisposableRealmEvidence>;
  if (residueWasPresent && !result.allowed) {
    result.evidence["janitorRemovedResidue"] = !existsSync(workspace);
  }
  return result;
};
