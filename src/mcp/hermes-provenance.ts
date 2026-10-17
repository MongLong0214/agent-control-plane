import { type Decision, allow, deny } from "../core/errors.ts";
import { isDigest } from "../core/digest.ts";
import { ReasonCode } from "../core/reason-codes.ts";

/**
 * Caller provenance for the adopted CEO's tool channel (#1037).
 *
 * The channel is one MCP server entry in the Gateway's profile, so every conversation that profile
 * runs can reach it: other chats, cron jobs, delegated subagents, and peers who are not the owner.
 * The kernel-peer claim proves the channel belongs to the Gateway; it says nothing about *which*
 * turn inside the Gateway is calling. That is what this answers, and it answers it per call.
 * Leaving the whole profile with the CEO's mutation authority was rejected rather than accepted as
 * the price of one shared MCP entry: a cron job or a delegated subagent would then start runs as
 * the owner without the owner having asked.
 *
 * Where it is read: `params._meta["agent-control-plane/provenance"]` of the `tools/call` request,
 * which the MCP SDK hands a tool callback as `extra._meta` — and nowhere else. Hermes fills this key
 * from its Gateway context only and strips or refuses the same key inside `arguments`. This side
 * holds up its half by never looking at `arguments` for it — reading them was ruled out rather than
 * kept as a fallback: a model writes `arguments`, so a provenance-shaped object there is the
 * caller's own claim about itself, and reading it would hand the decision to whoever composes the
 * call.
 *
 * Fields, as agreed with the Hermes deployment owner:
 *
 *   session_id           the Hermes session of this turn; must equal the bound live session
 *   lineage_root_digest  `sha256:<64 hex>`; must equal the binding's lineage digest. Hermes
 *                        computes it as `"sha256:" + sha256(b"hermes.target-bind:lineage-root\0"
 *                        + root_id.encode("utf-8")).hexdigest()`. ACP never computes it: the value
 *                        it compares against is the one Hermes reported and ACP stored
 *                        (`actor_target_bindings.target_locator_digest`, written from the Gateway
 *                        readback or the target-bind receipt), so the two are the same function's
 *                        output by construction, not by a second implementation agreeing.
 *   principal            "owner" | "peer"; any other value is refused. A peer may mutate only as
 *                        `admitPeerTurn` below allows (CEO ad57675b)
 *   cron                 boolean; only `false` may mutate
 *   delegation_depth     integer; 0 is a top-level turn, > 0 a subagent; only 0 may mutate, and a
 *                        missing value is refused rather than read as 0
 *   peer_grant           `sha256:<64 hex>`, a peer turn only: the digest of the Hermes peer policy
 *                        applied to this call. Checked for shape and recorded, never compared:
 *                        what it names is Hermes's half of the delegation
 *   session_key, platform, chat_id, parent_chat_id
 *                        carried, not compared. `parent_chat_id` in particular is not a subagent
 *                        signal: a delegate worker inherits its parent's context unchanged, so its
 *                        value is the parent's, and `delegation_depth` is the field Hermes added to
 *                        say what this one cannot.
 *
 * Every condition is its own statement and its own refusal, so a test can name the branch it
 * kills; none is an operand of an `&&`/`||` chain.
 */

export const HERMES_PROVENANCE_META_KEY = "agent-control-plane/provenance";

/** What a call is compared against: read from the live binding, never from the call. */
export interface HermesProvenanceAnchor {
  liveHermesSessionId: string;
  lineageRootDigest: string;
}

/**
 * The tools an adopted channel may call without provenance: they read and change nothing.
 *
 * An allowlist, so a tool added later is guarded until someone decides otherwise. `doctor_run` is
 * deliberately absent although the server registers it as a read: every pass appends a
 * `DOCTOR_REPORT` audit row and runs host probes, which is not nothing.
 */
export const HERMES_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "run_get",
  "project_get",
  "continuity_status",
]);

/**
 * The tools a peer turn of the CEO binding may call (CEO ad57675b): a fixed set, so a tool added
 * later, and every tool not named here — run_cancel, run_priority_set, cto_*, repair_execute,
 * doctor_run, owner_decision_submit — stays the owner's alone. Hermes narrows this further by its own
 * configured allowlist; neither side's permission alone executes anything.
 */
export const HERMES_PEER_DELEGABLE_TOOLS: ReadonlySet<string> = new Set([
  "escalation_resolve",
  "ceo_decision_submit",
  "run_create",
  "run_dispatch",
]);

/** The decisions a peer turn may submit; OWNER_DECISION_REQUIRED and anything else are the owner's. */
export const HERMES_PEER_CEO_DECISIONS: ReadonlySet<string> = new Set(["FINAL_REVISE", "CONFIRM"]);

/** The call being admitted: the tool's name and the arguments the SDK parsed for its handler. */
export interface HermesToolCall {
  tool: string;
  arguments: unknown;
}

/** Which turn an admitted call was made by, recorded with the mutation's own audit evidence. */
export interface HermesAdmittedTurn {
  principal: "owner" | "peer";
  /** The peer grant the call carried; `null` for the owner, whose turn needs none. */
  peerGrant: string | null;
}

/** The bounded audit fields for an admitted turn: two values, never the provenance object itself. */
export const hermesTurnEvidence = (
  turn: HermesAdmittedTurn | undefined,
): { hermesPrincipal?: HermesAdmittedTurn["principal"]; hermesPeerGrant?: string | null } =>
  turn === undefined ? {} : { hermesPrincipal: turn.principal, hermesPeerGrant: turn.peerGrant };

const PRINCIPALS: ReadonlySet<unknown> = new Set(["owner", "peer"]);

const refuse = (message: string): Decision<never> =>
  deny<never>(ReasonCode.MCP_TOOL_PROVENANCE_REFUSED, message, {});

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object") return false;
  if (value === null) return false;
  return !Array.isArray(value);
};

/**
 * A peer turn's own conditions, asked only after every condition an owner's turn meets has passed.
 *
 * The one argument read anywhere in admission is `ceo_decision_submit`'s `decision`, and only here:
 * it is what the call asks to do, not who is asking, and it can only refuse. `call.arguments` is the
 * object the SDK parsed for the handler, so the decision checked is the decision executed.
 */
const admitPeerTurn = (
  provenance: Record<string, unknown>,
  call: HermesToolCall | undefined,
): Decision<HermesAdmittedTurn> => {
  const peerGrant = provenance["peer_grant"];
  if (!isDigest(peerGrant)) return refuse("a peer's turn carries no well-formed peer_grant digest");
  if (call === undefined) return refuse("a peer's turn may call only a delegable tool, and this call names none");
  if (!HERMES_PEER_DELEGABLE_TOOLS.has(call.tool)) return refuse("this tool is not delegable to a peer's turn");
  if (call.tool === "ceo_decision_submit") {
    const decision = isRecord(call.arguments) ? call.arguments["decision"] : undefined;
    if (typeof decision !== "string") return refuse("a peer's ceo_decision_submit names no decision");
    if (!HERMES_PEER_CEO_DECISIONS.has(decision)) {
      return refuse("a peer's turn may submit only FINAL_REVISE or CONFIRM");
    }
  }
  return allow<HermesAdmittedTurn>(ReasonCode.OK, { principal: "peer", peerGrant });
};

/**
 * Admits one mutation call, or refuses it with nothing written, and answers with the turn admitted.
 *
 * `meta` is the request's `params._meta` exactly as the SDK delivered it; `anchor` is what the
 * connection's admission read from the binding, `null` when there is nothing to compare against;
 * `call` is the tool and its parsed arguments. An owner's turn never needs `call`; a peer's turn
 * without it is refused.
 */
export const admitHermesProvenance = (
  meta: unknown,
  anchor: HermesProvenanceAnchor | null,
  call?: HermesToolCall,
): Decision<HermesAdmittedTurn> => {
  if (anchor === null) return refuse("this channel's runtime does not hold the live CEO binding");
  if (!isRecord(meta)) return refuse("the call carries no provenance");
  if (!Object.hasOwn(meta, HERMES_PROVENANCE_META_KEY)) return refuse("the call carries no provenance");
  const provenance = meta[HERMES_PROVENANCE_META_KEY];
  if (!isRecord(provenance)) return refuse("the call's provenance is not an object");
  if (!PRINCIPALS.has(provenance["principal"])) return refuse("only the owner's or a delegated peer's turn may mutate");
  if (provenance["cron"] !== false) return refuse("a scheduled turn may not mutate");
  if (provenance["delegation_depth"] !== 0) return refuse("only a top-level turn may mutate");
  if (typeof provenance["session_id"] !== "string") return refuse("the call names no Hermes session");
  if (provenance["session_id"] !== anchor.liveHermesSessionId) {
    return refuse("the call's Hermes session is not the bound live session");
  }
  if (!isDigest(provenance["lineage_root_digest"])) return refuse("the call's lineage root is not a digest");
  if (provenance["lineage_root_digest"] !== anchor.lineageRootDigest) {
    return refuse("the call's lineage root is not the bound lineage");
  }
  if (provenance["principal"] === "peer") return admitPeerTurn(provenance, call);
  return allow<HermesAdmittedTurn>(ReasonCode.OK, { principal: "owner", peerGrant: null });
};
