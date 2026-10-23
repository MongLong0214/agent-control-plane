import { MessageKind } from "../../src/outbox/envelope.ts";
import type { BootstrapRuntimeFixture } from "./bootstrap-cto-fixture.ts";
import { callMcpToolOverSocket } from "./mcp-socket.ts";

/**
 * A scripted stand-in for a driven bootstrap CTO's model, acting only through the acp-cto tools over
 * the real CTO socket with the credential its relay took for the turn. It does what the turn's prompt
 * says and nothing the prompt does not say: it plans a run only where the prompt carries the planning
 * directive, follows the bound the prompt states, and builds its PLAN only from what `contract_get`
 * returned — the guide's example manifest and repository-create shape with their placeholders filled
 * in. It runs no code a model could not: the manifest digest it names is the one a refusal reports.
 * It never provisions a worker or submits a task receipt: a project-less bootstrap's task is settled
 * by the control plane at CEO CONFIRM (CEO 1792120507).
 *
 * - `onDispatch: "ack-only"` acknowledges every row it is sent and plans nothing — the stall observed
 *   live. `"follow-prompt"` plans a RUN_DISPATCH's run first when the prompt says to and it holds no
 *   accepted PLAN for that run, then acknowledges.
 * - `onRecovery: "follow-prompt"` plans the run a plan-recovery wake names when the prompt says to;
 *   `"ignore"` answers such a wake with no tool call at all, as an owner that does not answer would.
 * - `onResult: "follow-prompt"` (the default) submits the result of its latest accepted PLAN for an
 *   ACTIVE run when the prompt carries the bootstrap result directive, in the turn that got the PLAN
 *   accepted or in the turn of the run's next RUN_DISPATCH, and on a result-recovery wake when the
 *   prompt carries that wake's line. `"recovery-only"` skips the result outside a result-recovery
 *   wake, the stall observed live. `"ignore"` never submits a result.
 * - `onRetry: "follow-prompt"` (the default) submits the latest accepted PLAN's result again on a review
 *   retry wake when the prompt carries that wake's line, even though it was submitted before; `"ignore"`
 *   answers such a wake with no tool call at all.
 * - `onRevision: "follow-prompt"` (the default) answers a REVISION_REQUEST the prompt's revision line
 *   covers by planning the run again from the reason the request carries, applying the verification
 *   limits it names; `"ignore"` acknowledges it and does nothing else.
 */
export interface ScriptedBootstrapOwner {
  onDispatch: "ack-only" | "follow-prompt";
  onRecovery: "follow-prompt" | "ignore";
  onResult: "follow-prompt" | "recovery-only" | "ignore";
  onRevision: "follow-prompt" | "ignore";
  onRetry: "follow-prompt" | "ignore";
  /** Every work turn's prompt, in order. */
  readonly prompts: string[];
  /** Every `plan_submit` call: its run, whether it was accepted, and the refusal's name and `supplied`. */
  readonly submissions: Array<{ runId: string; ok: boolean; refusal: string | null; supplied: string | null }>;
  /** Every `contract_get` answer the owner read. */
  readonly contracts: Array<Record<string, unknown>>;
  /** Every in-band row acknowledged, with the acknowledgement's answer. */
  readonly acknowledged: Array<{ kind: string; messageId: string; ok: unknown }>;
  /** Every `result_submit` call: its run, whether it was accepted, and the pipeline stage it answered. */
  readonly results: Array<{ runId: string; ok: boolean; stage: string | null }>;
  /** Every REVISION_REQUEST read: its run and the reason it carried. */
  readonly revisions: Array<{ runId: string; reason: string }>;
  /** Holds every work turn at its start until the returned release is called. */
  hold(): () => void;
}

/** The values this scripted owner reads as "what the contract names" for each placeholder. */
export const SCRIPTED_CONTRACT_VALUES: Readonly<Record<string, string>> = Object.freeze({
  "<project-id>": "widget",
  "<owner>": "acme",
  "<name>": "widget",
  "<operation-id>": "create-repository",
  "<public|private>": "public",
});

export const RUN_DISPATCH_DIRECTIVE = "A RUN_DISPATCH for a run you own and have not yet submitted a PLAN for means:";
const RECOVERY_DIRECTIVE = "means that run's RUN_DISPATCH was already acknowledged and the run still has no PLAN";
export const RESULT_DIRECTIVE = "For a run whose contract_get returned a bootstrapPlanGuide, once its PLAN is accepted and the run is ACTIVE";
const RESULT_RECOVERY_DIRECTIVE = "means that run's current PLAN was accepted and no result was submitted for it";
const REVIEW_RETRY_DIRECTIVE = "means the blind review of that run's submitted result could not be constituted and can now be retried";
export const REVISION_DIRECTIVE = "A REVISION_REQUEST for a run whose contract_get returned a bootstrapPlanGuide carries why its PLAN was sent back";
const WOKE_FOR = "The control plane woke you for:";

/** One counter for every owner: an MCP idempotency key is reserved for whichever peer used it first. */
let keys = 0;

const fill = (value: unknown): unknown => {
  let text = JSON.stringify(value);
  for (const [placeholder, real] of Object.entries(SCRIPTED_CONTRACT_VALUES)) text = text.split(placeholder).join(real);
  return JSON.parse(text) as unknown;
};

/** The verification limits a revision reason names ("timeoutSeconds to 1200", "maxMemoryMb to 4096"), applied to every command. */
const revisedManifest = (manifest: unknown, reason: string): unknown => {
  const timeout = /timeoutSeconds to (\d+)/.exec(reason)?.[1];
  const memory = /maxMemoryMb to (\d+)/.exec(reason)?.[1];
  const value = manifest as { verificationCommands?: Array<Record<string, unknown>> };
  return {
    ...value,
    verificationCommands: (value.verificationCommands ?? []).map((command) => ({
      ...command,
      ...(timeout === undefined ? {} : { timeoutSeconds: Number(timeout) }),
      ...(memory === undefined ? {} : { maxMemoryMb: Number(memory) }),
    })),
  };
};

export const scriptBootstrapOwner = (
  f: BootstrapRuntimeFixture,
  options: {
    onDispatch: ScriptedBootstrapOwner["onDispatch"];
    onRecovery?: ScriptedBootstrapOwner["onRecovery"];
    onResult?: ScriptedBootstrapOwner["onResult"];
    onRevision?: ScriptedBootstrapOwner["onRevision"];
    onRetry?: ScriptedBootstrapOwner["onRetry"];
  },
): ScriptedBootstrapOwner => {
  let gate: Promise<void> | null = null;
  /** What the owner's own conversation holds for a run: its latest accepted PLAN and whether that PLAN's result went in. */
  const planned = new Map<string, { plan: Record<string, unknown>; resulted: boolean }>();
  const owner: ScriptedBootstrapOwner = {
    onDispatch: options.onDispatch,
    onRecovery: options.onRecovery ?? "follow-prompt",
    onResult: options.onResult ?? "follow-prompt",
    onRevision: options.onRevision ?? "follow-prompt",
    onRetry: options.onRetry ?? "follow-prompt",
    prompts: [],
    submissions: [],
    contracts: [],
    acknowledged: [],
    results: [],
    revisions: [],
    hold: () => {
      let release: () => void = () => undefined;
      gate = new Promise<void>((resolve) => {
        release = () => {
          gate = null;
          resolve();
        };
      });
      return release;
    },
  };
  f.claude.onWorkTurn = async (request, credential) => {
    owner.prompts.push(request.prompt);
    if (gate) await gate;
    if (!credential) return;
    const as = { sessionId: credential.sessionId, sessionSecret: credential.sessionSecret, token: credential.token ?? "" };
    const call = (name: string, args: Record<string, unknown>) => callMcpToolOverSocket(f.ctoSocket, as, name, args);
    const prompt = request.prompt;
    // The bound the prompt states, and one call where it states none.
    const bound = Number(/at most (\d+) plan_submit calls/.exec(prompt)?.[1] ?? "1");
    const resultsInTurn = owner.onResult === "follow-prompt" && prompt.includes(RESULT_DIRECTIVE);

    /** Plans the run from contract_get; answers the run's state as contract_get read it. */
    const planRun = async (runId: string, revision: string | null = null): Promise<string | null> => {
      const contract = await call("contract_get", { runId });
      const value = (contract["value"] ?? {}) as Record<string, unknown>;
      owner.contracts.push(value);
      const guide = value["bootstrapPlanGuide"] as
        | { manifest: { example: unknown }; repositoryCreateOperation: { shape: unknown }; genesisExample: unknown; githubOperationsExample: unknown }
        | undefined;
      if (guide === undefined) return null;
      const run = value["run"] as { contractDigest: string; state: string };
      const summary = "create the public repository from the approved genesis bundle";
      const plan: Record<string, unknown> = {
        summary: revision === null ? summary : `${summary}; revised: ${revision}`,
        bootstrapOperationId: "bootstrap-widget",
        requestDigest: run.contractDigest,
        // No tool here computes a digest: name a placeholder and take the refusal's `supplied`.
        projectManifestDigest: "sha256:unknown",
        genesis: fill(guide.genesisExample),
        githubOperations: fill(guide.githubOperationsExample),
        projectManifest: revision === null ? fill(guide.manifest.example) : revisedManifest(fill(guide.manifest.example), revision),
      };
      for (let attempt = 0; attempt < bound; attempt += 1) {
        const submitted = await call("plan_submit", {
          idempotencyKey: `scripted-plan-${++keys}`,
          runId,
          plan,
          tasks: [{ key: "bootstrap", title: "create the repository", category: "implementation" }],
        });
        const evidence = (submitted["evidence"] ?? {}) as { refusal?: string; supplied?: string };
        owner.submissions.push({
          runId,
          ok: submitted["ok"] === true,
          refusal: evidence.refusal ?? null,
          supplied: evidence.supplied ?? null,
        });
        if (submitted["ok"] === true) {
          planned.set(runId, { plan: { ...plan }, resulted: false });
          return run.state;
        }
        if (evidence.refusal !== "MANIFEST_MISMATCH" || evidence.supplied === undefined) return run.state;
        plan["projectManifestDigest"] = evidence.supplied;
      }
      return run.state;
    };

    /** The result of the latest accepted PLAN, from that PLAN alone. */
    const submitResult = async (runId: string): Promise<void> => {
      const mine = planned.get(runId);
      if (mine === undefined || mine.resulted) return;
      const summary = String(mine.plan["summary"]);
      const submitted = await call("result_submit", {
        idempotencyKey: `scripted-result-${++keys}`,
        runId,
        resultSummary: summary,
        recommendation: `apply the accepted PLAN: ${summary}`,
      });
      const value = (submitted["value"] ?? {}) as { stage?: string };
      owner.results.push({ runId, ok: submitted["ok"] === true, stage: value.stage ?? null });
      if (submitted["ok"] === true) mine.resulted = true;
    };

    const wokeFor = prompt.split("\n").find((line) => line.startsWith(WOKE_FOR)) ?? "";
    const recovered = /plan recovery: run (\S+) has no PLAN/.exec(wokeFor)?.[1] ?? null;
    if (recovered !== null) {
      if (owner.onRecovery === "ignore" || !prompt.includes(RECOVERY_DIRECTIVE)) return;
      const state = await planRun(recovered);
      if (resultsInTurn && state === "ACTIVE") await submitResult(recovered);
    }
    const resultRecovered = /result recovery: run (\S+) has a PLAN and no result/.exec(wokeFor)?.[1] ?? null;
    if (resultRecovered !== null) {
      if (owner.onResult === "ignore" || !prompt.includes(RESULT_RECOVERY_DIRECTIVE)) return;
      await submitResult(resultRecovered);
    }
    const retried = /review retry: run (\S+) has a result whose blind review was unavailable/.exec(wokeFor)?.[1] ?? null;
    if (retried !== null) {
      if (owner.onRetry === "ignore" || !prompt.includes(REVIEW_RETRY_DIRECTIVE)) return;
      const mine = planned.get(retried);
      if (mine !== undefined) mine.resulted = false;
      await submitResult(retried);
    }
    const pending = await call("role_dispatch_pending", {});
    const messages = (pending["value"] as {
      messages?: Array<{ messageId: string; runId: string | null; kind: string; payload?: Record<string, unknown> }>;
    } | undefined)?.messages ?? [];
    for (const message of messages) {
      if (message.kind === MessageKind.REVISION_REQUEST && message.runId !== null) {
        const reason = String(message.payload?.["rationale"] ?? message.payload?.["reasonCode"] ?? "");
        owner.revisions.push({ runId: message.runId, reason });
        if (owner.onRevision === "follow-prompt" && prompt.includes(REVISION_DIRECTIVE)) {
          const state = await planRun(message.runId, reason);
          if (resultsInTurn && state === "ACTIVE") await submitResult(message.runId);
        }
      }
      if (message.kind === MessageKind.RUN_DISPATCH && message.runId !== null) {
        if (owner.onDispatch === "follow-prompt" && prompt.includes(RUN_DISPATCH_DIRECTIVE) && !planned.has(message.runId)) {
          await planRun(message.runId);
        }
        if (resultsInTurn) await submitResult(message.runId);
      }
      const acked = message.runId
        ? await call("run_ack", { idempotencyKey: `scripted-ack-${++keys}`, runId: message.runId, messageId: message.messageId })
        : await call("role_dispatch_ack", { messageId: message.messageId });
      owner.acknowledged.push({ kind: message.kind, messageId: message.messageId, ok: acked["ok"] });
    }
  };
  return owner;
};
