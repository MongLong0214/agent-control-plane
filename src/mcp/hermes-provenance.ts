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
 *   principal            "owner" | "peer"; only "owner" may mutate (an unknown value is refused)
 *   cron                 boolean; only `false` may mutate
 *   delegation_depth     integer; 0 is a top-level turn, > 0 a subagent; only 0 may mutate, and a
 *                        missing value is refused rather than read as 0
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

const refuse = (message: string): Decision<void> =>
  deny(ReasonCode.MCP_TOOL_PROVENANCE_REFUSED, message, {});

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object") return false;
  if (value === null) return false;
  return !Array.isArray(value);
};

/**
 * Admits one mutation call, or refuses it with nothing written.
 *
 * `meta` is the request's `params._meta` exactly as the SDK delivered it; `anchor` is what the
 * connection's admission read from the binding, `null` when there is nothing to compare against.
 */
export const admitHermesProvenance = (
  meta: unknown,
  anchor: HermesProvenanceAnchor | null,
): Decision<void> => {
  if (anchor === null) return refuse("this channel's runtime does not hold the live CEO binding");
  if (!isRecord(meta)) return refuse("the call carries no provenance");
  if (!Object.hasOwn(meta, HERMES_PROVENANCE_META_KEY)) return refuse("the call carries no provenance");
  const provenance = meta[HERMES_PROVENANCE_META_KEY];
  if (!isRecord(provenance)) return refuse("the call's provenance is not an object");
  if (provenance["principal"] !== "owner") return refuse("only the owner's turn may mutate");
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
  return allow(ReasonCode.OK, undefined);
};
