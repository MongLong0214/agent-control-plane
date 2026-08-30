import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  type TelegramLongPollStartOptions,
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
  | "SYNTHETIC_TRANSPORT_NOT_INJECTED"
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

export interface SyntheticDriverTurn {
  readonly prompt: string;
  readonly reply: string;
}

export interface SyntheticIngressAppliedReply extends SyntheticSentReply {
  readonly nonce: string;
  readonly chatId: string;
  readonly correlationId: string;
}

export interface SyntheticProbeTrace {
  readonly outcomes: SyntheticProbeOutcome[];
  readonly sentReplies: SyntheticSentReply[];
  readonly driverTurns: SyntheticDriverTurn[];
  readonly ingressAppliedReplies: SyntheticIngressAppliedReply[];
  readonly actorIds: string[];
  readonly targetActorIds: string[];
}

export type SyntheticEvidenceStepStatus = "CHECKED_BY_RUN" | "UNPROVEN";

export interface SyntheticEvidenceStep {
  readonly id: string;
  readonly status: SyntheticEvidenceStepStatus;
  readonly statement: string;
}

const SYNTHETIC_EVIDENCE_STEPS: readonly SyntheticEvidenceStep[] = [
  {
    id: "REALM_PATHS_ISOLATED",
    status: "CHECKED_BY_RUN",
    statement:
      "The generated realm paths passed isolation planning before and after creation inside the janitor-owned OS-temp workspace.",
  },
  {
    id: "NONCANONICAL_PROBE_TARGET",
    status: "CHECKED_BY_RUN",
    statement:
      "The generated probe target passed the noncanonical-target check before and after realm creation.",
  },
  {
    id: "SYNTHETIC_TRANSPORT_USED",
    status: "CHECKED_BY_RUN",
    statement:
      "The listener received and used the driver-owned synthetic Telegram transport instead of its live fallback.",
  },
  {
    id: "PRODUCTION_POLL_AND_ROUTER_USED",
    status: "CHECKED_BY_RUN",
    statement:
      "Production polling and routing admitted and DIRECT-classified both synthetic Telegram updates.",
  },
  {
    id: "DRIVER_DIRECT_CALLBACK_ANSWERED",
    status: "CHECKED_BY_RUN",
    statement:
      "A driver-owned onDirect callback handled both prompts and supplied both reply bodies.",
  },
  {
    id: "INGRESS_APPLIED_REPLIES_READ",
    status: "CHECKED_BY_RUN",
    statement:
      "The driver reread two matching APPLIED ingress reply records from the realm database.",
  },
  {
    id: "SYNTHETIC_BASELINE_UNCHANGED",
    status: "CHECKED_BY_RUN",
    statement:
      "The generated synthetic baseline had the same observed facts before and after the probe.",
  },
  {
    id: "REALM_AND_WORKSPACE_REMOVED",
    status: "CHECKED_BY_RUN",
    statement:
      "The normal run observed no realm residue and the janitor confirmed the outer workspace absent before this artifact was built.",
  },
  {
    id: "BOUND_ACTOR_HANDLED_PROBE",
    status: "UNPROVEN",
    statement:
      "The bound actor did not handle either probe message; the run used a driver-owned onDirect callback.",
  },
  {
    id: "PRODUCTION_CEO_PATH_ANSWERED",
    status: "UNPROVEN",
    statement:
      "The production CeoConversationPort and authenticated MCP peer were not connected or exercised.",
  },
  {
    id: "TARGET_AUTHORED_TRANSCRIPT",
    status: "UNPROVEN",
    statement:
      "No target process authored or persisted a transcript; the run did not observe target-owned state.",
  },
  {
    id: "CEO_DURABLE_COMMIT",
    status: "UNPROVEN",
    statement:
      "APPLIED is ingress reply-delivery state; the run did not prove a CEO-side durable commit.",
  },
  {
    id: "LIVE_CANONICAL_ACTIVATION",
    status: "UNPROVEN",
    statement:
      "Live Telegram, canonical state, actor reconstitution, duplicate freedom, the target fence and receipt, and activation were not exercised.",
  },
];

export type SyntheticSafetyConditionStatus = "CHECKED_BY_RUN" | "ASSERTED_ONLY";

export interface SyntheticSafetyCondition {
  readonly condition: string;
  readonly status: SyntheticSafetyConditionStatus;
  readonly detail: string;
}

const SYNTHETIC_SAFETY_CONDITIONS: readonly SyntheticSafetyCondition[] = [
  {
    condition: "A realm that shares a path with production is not a realm",
    status: "CHECKED_BY_RUN",
    detail:
      "The generated paths passed planning before and after creation against the synthetic production root; no live production path was supplied.",
  },
  {
    condition: "The probe may not address the canonical conversation",
    status: "CHECKED_BY_RUN",
    detail:
      "The generated probe root passed the canonical-root containment refusal before and after creation.",
  },
  {
    condition: "Production has to be the same set of facts afterwards",
    status: "CHECKED_BY_RUN",
    detail:
      "Before and after censuses matched for the generated synthetic baseline; live production was deliberately not read and is not covered.",
  },
  {
    condition: "A failure to look is not an observation of absence",
    status: "CHECKED_BY_RUN",
    detail: "Both synthetic census reads returned observations; either unreadable census denies the run.",
  },
  {
    condition: "Disposable means observed to be gone",
    status: "CHECKED_BY_RUN",
    detail:
      "Normal realm cleanup reported no residue and janitor release confirmed the outer workspace absent; parent-death cleanup was not exercised by this artifact.",
  },
  {
    condition: "An unanswerable question is never followed by another message",
    status: "ASSERTED_ONLY",
    detail:
      "This successful run observed no ambiguous signal, so terminal no-retry behavior was not exercised by this artifact.",
  },
  {
    condition: "Cleanup terminates only what this run started",
    status: "ASSERTED_ONLY",
    detail:
      "Synthetic mode started no target or Gateway process and supplied zero cleanup candidates, so PID and start-time ownership refusal was not exercised by this artifact.",
  },
  {
    condition: "The evidence claim is bounded in the code, not in the write-up",
    status: "CHECKED_BY_RUN",
    detail:
      "The requested claim matched the only permitted sentence and every CHECKED_BY_RUN step was matched to an execution marker before this artifact was returned.",
  },
];

export interface SyntheticDisposableRealmEvidence {
  readonly mode: "SYNTHETIC";
  readonly claim: typeof REALM_EVIDENCE_CLAIM;
  readonly updateIds: readonly number[];
  readonly replyCount: number;
  readonly driverHandledTurnCount: number;
  readonly ingressAppliedReplyCount: number;
  readonly createdActorCount: number;
  readonly createdTargetBindingCount: number;
  readonly syntheticBaselineUnchanged: true;
  readonly workspaceRemoved: true;
  readonly residue: readonly string[];
  readonly layout: readonly string[];
  readonly steps: readonly SyntheticEvidenceStep[];
  readonly safetyConditions: readonly SyntheticSafetyCondition[];
}

interface SyntheticDisposableRealmObservation {
  readonly updateIds: readonly number[];
  readonly replyCount: number;
  readonly driverHandledTurnCount: number;
  readonly ingressAppliedReplyCount: number;
  readonly createdActorCount: number;
  readonly createdTargetBindingCount: number;
  readonly syntheticBaselineUnchanged: true;
  readonly residue: readonly string[];
  readonly layout: readonly string[];
}

export const assertEvidenceStepsExecuted = (
  steps: readonly SyntheticEvidenceStep[],
  executed: ReadonlySet<string>,
): Decision<void> => {
  const unsupportedSteps = steps
    .filter((step) => step.status === "CHECKED_BY_RUN" && !executed.has(step.id))
    .map((step) => step.id);
  if (unsupportedSteps.length > 0) {
    return deny(
      ReasonCode.ACCEPTANCE_EVIDENCE_OVERCLAIMED,
      "the evidence artifact marked a step checked that this run did not execute",
      { unsupportedSteps },
    );
  }
  return allow(ReasonCode.OK, undefined);
};

/**
 * The two-message claim is structural, not a count attached after the fact.
 *
 * Every observation must agree on the same two updates: Telegram admission, the reply accepted
 * by the injected transport, the driver-owned callback turn and the full APPLIED ingress reply
 * reread from the database. The realm must also contain one created actor and target binding,
 * which is only a creation count — handling by that actor is explicitly unproven in the artifact.
 */
export const assertSyntheticProbeComplete = (
  trace: SyntheticProbeTrace,
): Decision<void> => {
  const expectedNonces = UPDATE_IDS.map((id) => `update:${id}`);
  const counts = {
    outcomes: trace.outcomes.length,
    sentReplies: trace.sentReplies.length,
    driverTurns: trace.driverTurns.length,
    ingressAppliedReplies: trace.ingressAppliedReplies.length,
    actorIds: trace.actorIds.length,
    targetActorIds: trace.targetActorIds.length,
  };
  if (
    counts.outcomes !== 2 ||
    counts.sentReplies !== 2 ||
    counts.driverTurns !== 2 ||
    counts.ingressAppliedReplies !== 2 ||
    counts.actorIds !== 1 ||
    counts.targetActorIds !== 1
  ) {
    return deny(
      ReasonCode.ACCEPTANCE_PROBE_INCOMPLETE,
      "the disposable probe did not produce two matching driver-handled ingress exchanges and one created actor binding",
      counts,
    );
  }

  for (let index = 0; index < UPDATE_IDS.length; index += 1) {
    const outcome = trace.outcomes[index]!;
    const sent = trace.sentReplies[index]!;
    const driverTurn = trace.driverTurns[index]!;
    const ingress = trace.ingressAppliedReplies[index]!;
    const expectedCorrelationId = `telegram:${UPDATE_IDS[index]}:${MESSAGE_IDS[index]}`;
    const expectedReply =
      `DIRECT received; no run created\n${driverTurn.reply}\n` +
      `correlation: ${expectedCorrelationId}`;
    if (
      outcome.updateId !== UPDATE_IDS[index] ||
      outcome.admitted !== true ||
      outcome.classification !== "DIRECT" ||
      outcome.reasonCode !== ReasonCode.OK ||
      outcome.reply !== expectedReply ||
      sent.replyToMessageId !== MESSAGE_IDS[index] ||
      sent.text !== expectedReply ||
      driverTurn.prompt !== PROMPTS[index] ||
      ingress.nonce !== expectedNonces[index] ||
      ingress.chatId !== CHAT_ID ||
      ingress.replyToMessageId !== MESSAGE_IDS[index] ||
      ingress.text !== expectedReply ||
      ingress.correlationId !== expectedCorrelationId
    ) {
      return deny(
        ReasonCode.ACCEPTANCE_PROBE_INCOMPLETE,
        "the production router, driver callback, injected transport and APPLIED ingress record do not describe the same exchange",
        { index, outcome, sent, driverTurn, ingress },
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

const assertSyntheticTransportInjected = (
  options: TelegramLongPollStartOptions,
  transport: TelegramBotTransport,
): Decision<void> =>
  options.transport === transport
    ? allow(ReasonCode.OK, undefined)
    : deny(
        ReasonCode.ACCEPTANCE_PROBE_INCOMPLETE,
        "the synthetic listener refused to start without its injected transport because omission selects the live Bot API fallback",
        {
          configuredTransport: "DEFAULT_LIVE_FALLBACK",
          requiredTransport: "SYNTHETIC_INJECTED",
        },
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
 * Runs the only driver #655 currently permits: deterministic transport and a driver-owned direct
 * handler, never live Telegram, never a target or Gateway process, and never a caller-supplied
 * state root.
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
  const executedEvidenceSteps = new Set<string>();

  const execute = async (): Promise<Decision<SyntheticDisposableRealmObservation>> => {
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
      return planned as Decision<SyntheticDisposableRealmObservation>;
    }

    const before = options.fault === "BEFORE_CENSUS_UNOBSERVABLE"
      ? deny<ProductionCensus>(
          ReasonCode.ACCEPTANCE_CENSUS_UNOBSERVABLE,
          "the synthetic before census was deliberately made unobservable",
        )
      : takeProductionCensus(production, fakeProductionRoot);
    if (!before.allowed) {
      return before as Decision<SyntheticDisposableRealmObservation>;
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
      return createdPlan as Decision<SyntheticDisposableRealmObservation>;
    }
    executedEvidenceSteps.add("REALM_PATHS_ISOLATED");
    executedEvidenceSteps.add("NONCANONICAL_PROBE_TARGET");

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
      return ready as Decision<SyntheticDisposableRealmObservation>;
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
      return bound as Decision<SyntheticDisposableRealmObservation>;
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
        return secondReady as Decision<SyntheticDisposableRealmObservation>;
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
        return switched as Decision<SyntheticDisposableRealmObservation>;
      }
    }

    const driverTurns: SyntheticDriverTurn[] = [];
    const transport = new SyntheticTelegramTransport(options.fault);
    const listenerOptions: TelegramLongPollStartOptions = {
      ...(options.fault === "SYNTHETIC_TRANSPORT_NOT_INJECTED" ? {} : { transport }),
      start: false,
      onDirect: (input) => {
        const reply = `synthetic reply ${driverTurns.length + 1}`;
        driverTurns.push({ prompt: input.text, reply });
        return reply;
      },
    };
    const injected = assertSyntheticTransportInjected(listenerOptions, transport);
    if (!injected.allowed) {
      return injected as Decision<SyntheticDisposableRealmObservation>;
    }
    executedEvidenceSteps.add("SYNTHETIC_TRANSPORT_USED");
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
      listenerOptions,
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
            {
              signal,
              polls: transport.polls,
              sends: transport.sends,
              driverHandledTurns: driverTurns.length,
            },
          );
        }
        throw error;
      }
    }

    const ingressAppliedReplies = realm.db
      .all<{ nonce: string; result_json: string | null }>(
        "SELECT nonce, result_json FROM inbound_messages WHERE channel = 'telegram' ORDER BY nonce",
      )
      .flatMap((row): SyntheticIngressAppliedReply[] => {
        if (!row.result_json) return [];
        try {
          const value = JSON.parse(row.result_json) as {
            deliveryStatus?: unknown;
            reply?: {
              chatId?: unknown;
              text?: unknown;
              replyToMessageId?: unknown;
              correlationId?: unknown;
            };
          };
          const reply = value.reply;
          if (
            value.deliveryStatus !== "APPLIED" ||
            !reply ||
            typeof reply.chatId !== "string" ||
            typeof reply.text !== "string" ||
            typeof reply.replyToMessageId !== "number" ||
            typeof reply.correlationId !== "string"
          ) return [];
          return [{
            nonce: row.nonce,
            chatId: reply.chatId,
            text: reply.text,
            replyToMessageId: reply.replyToMessageId,
            correlationId: reply.correlationId,
          }];
        } catch {
          return [];
        }
      });
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
      driverTurns,
      ingressAppliedReplies,
      actorIds,
      targetActorIds,
    };
    const complete = assertSyntheticProbeComplete(trace);
    if (!complete.allowed) {
      return complete as Decision<SyntheticDisposableRealmObservation>;
    }
    executedEvidenceSteps.add("PRODUCTION_POLL_AND_ROUTER_USED");
    executedEvidenceSteps.add("DRIVER_DIRECT_CALLBACK_ANSWERED");
    executedEvidenceSteps.add("INGRESS_APPLIED_REPLIES_READ");

    // Synthetic mode starts no target or Gateway process. The empty set is still passed through
    // the same ownership decision a future child would have to satisfy; the negative case is a
    // public helper and is exercised with a reused pid in the affected test.
    const cleanupOwnership = assertCleanupCandidatesOwned([], []);
    if (!cleanupOwnership.allowed) {
      return cleanupOwnership as Decision<SyntheticDisposableRealmObservation>;
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
      return after as Decision<SyntheticDisposableRealmObservation>;
    }
    const unchanged = assertProductionUnchanged(before.value, after.value);
    if (!unchanged.allowed) {
      return unchanged as Decision<SyntheticDisposableRealmObservation>;
    }
    executedEvidenceSteps.add("SYNTHETIC_BASELINE_UNCHANGED");

    const residue = verifyRealmResidue(paths);
    if (!residue.allowed) {
      residueWasPresent = true;
      return residue as Decision<SyntheticDisposableRealmObservation>;
    }

    return allow(ReasonCode.OK, {
      updateIds: outcomes.map((outcome) => outcome.updateId),
      replyCount: transport.sentReplies.length,
      driverHandledTurnCount: driverTurns.length,
      ingressAppliedReplyCount: ingressAppliedReplies.length,
      createdActorCount: actorIds.length,
      createdTargetBindingCount: targetActorIds.length,
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
  if (!result.allowed) return result as Decision<SyntheticDisposableRealmEvidence>;

  executedEvidenceSteps.add("REALM_AND_WORKSPACE_REMOVED");
  const steps = SYNTHETIC_EVIDENCE_STEPS.map((step) => ({ ...step }));
  const supported = assertEvidenceStepsExecuted(steps, executedEvidenceSteps);
  if (!supported.allowed) return supported as Decision<SyntheticDisposableRealmEvidence>;

  return allow(ReasonCode.OK, {
    mode: "SYNTHETIC",
    claim: claim.value,
    ...result.value,
    workspaceRemoved: true,
    steps,
    safetyConditions: SYNTHETIC_SAFETY_CONDITIONS.map((condition) => ({ ...condition })),
  });
};
