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
 *
 * - `onDispatch: "ack-only"` acknowledges every row it is sent and plans nothing — the stall observed
 *   live. `"follow-prompt"` plans a RUN_DISPATCH's run first when the prompt says to, then acknowledges.
 * - `onRecovery: "follow-prompt"` plans the run a plan-recovery wake names when the prompt says to;
 *   `"ignore"` answers such a wake with no tool call at all, as an owner that does not answer would.
 */
export interface ScriptedBootstrapOwner {
  onDispatch: "ack-only" | "follow-prompt";
  onRecovery: "follow-prompt" | "ignore";
  /** Every work turn's prompt, in order. */
  readonly prompts: string[];
  /** Every `plan_submit` call: its run, whether it was accepted, and the refusal's name and `supplied`. */
  readonly submissions: Array<{ runId: string; ok: boolean; refusal: string | null; supplied: string | null }>;
  /** Every `contract_get` answer the owner read. */
  readonly contracts: Array<Record<string, unknown>>;
  /** Every in-band row acknowledged, with the acknowledgement's answer. */
  readonly acknowledged: Array<{ kind: string; messageId: string; ok: unknown }>;
  /** Holds every work turn at its start until the returned release is called. */
  hold(): () => void;
}

/** The values this scripted owner reads as "what the contract names" for each placeholder. */
export const SCRIPTED_CONTRACT_VALUES: Readonly<Record<string, string>> = Object.freeze({
  "<project-id>": "widget",
  "<owner>": "acme",
  "<name>": "widget",
  "<operation-id>": "create-repository",
  "<public|private>": "private",
});

export const RUN_DISPATCH_DIRECTIVE = "A RUN_DISPATCH for a run you own and have not yet submitted a PLAN for means:";
const RECOVERY_DIRECTIVE = "means that run's RUN_DISPATCH was already acknowledged and the run still has no PLAN";
const WOKE_FOR = "The control plane woke you for:";

/** One counter for every owner: an MCP idempotency key is reserved for whichever peer used it first. */
let keys = 0;

const fill = (value: unknown): unknown => {
  let text = JSON.stringify(value);
  for (const [placeholder, real] of Object.entries(SCRIPTED_CONTRACT_VALUES)) text = text.split(placeholder).join(real);
  return JSON.parse(text) as unknown;
};

export const scriptBootstrapOwner = (
  f: BootstrapRuntimeFixture,
  options: { onDispatch: ScriptedBootstrapOwner["onDispatch"]; onRecovery?: ScriptedBootstrapOwner["onRecovery"] },
): ScriptedBootstrapOwner => {
  let gate: Promise<void> | null = null;
  const owner: ScriptedBootstrapOwner = {
    onDispatch: options.onDispatch,
    onRecovery: options.onRecovery ?? "follow-prompt",
    prompts: [],
    submissions: [],
    contracts: [],
    acknowledged: [],
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

    const planRun = async (runId: string): Promise<void> => {
      const contract = await call("contract_get", { runId });
      const value = (contract["value"] ?? {}) as Record<string, unknown>;
      owner.contracts.push(value);
      const guide = value["bootstrapPlanGuide"] as
        | { manifest: { example: unknown }; repositoryCreateOperation: { shape: unknown } }
        | undefined;
      if (guide === undefined) return;
      const run = value["run"] as { contractDigest: string };
      const plan: Record<string, unknown> = {
        summary: "create the private repository the contract asks for, create-only",
        bootstrapOperationId: "bootstrap-widget",
        requestDigest: run.contractDigest,
        // No tool here computes a digest: name a placeholder and take the refusal's `supplied`.
        projectManifestDigest: "sha256:unknown",
        githubOperations: [fill(guide.repositoryCreateOperation.shape)],
        projectManifest: fill(guide.manifest.example),
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
        if (submitted["ok"] === true) return;
        if (evidence.refusal !== "MANIFEST_MISMATCH" || evidence.supplied === undefined) return;
        plan["projectManifestDigest"] = evidence.supplied;
      }
    };

    const wokeFor = prompt.split("\n").find((line) => line.startsWith(WOKE_FOR)) ?? "";
    const recovered = /plan recovery: run (\S+) has no PLAN/.exec(wokeFor)?.[1] ?? null;
    if (recovered !== null) {
      if (owner.onRecovery === "ignore" || !prompt.includes(RECOVERY_DIRECTIVE)) return;
      await planRun(recovered);
    }
    const pending = await call("role_dispatch_pending", {});
    const messages = (pending["value"] as { messages?: Array<{ messageId: string; runId: string | null; kind: string }> } | undefined)
      ?.messages ?? [];
    for (const message of messages) {
      if (
        message.kind === MessageKind.RUN_DISPATCH &&
        message.runId !== null &&
        owner.onDispatch === "follow-prompt" &&
        prompt.includes(RUN_DISPATCH_DIRECTIVE)
      ) {
        await planRun(message.runId);
      }
      const acked = message.runId
        ? await call("run_ack", { idempotencyKey: `scripted-ack-${++keys}`, runId: message.runId, messageId: message.messageId })
        : await call("role_dispatch_ack", { messageId: message.messageId });
      owner.acknowledged.push({ kind: message.kind, messageId: message.messageId, ok: acked["ok"] });
    }
  };
  return owner;
};
