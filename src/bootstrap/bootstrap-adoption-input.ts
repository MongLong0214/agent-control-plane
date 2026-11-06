import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { Db } from "../db/database.ts";

/**
 * #1234 — the explicit input a PROJECT_BOOTSTRAP run is created with when it adopts an existing
 * canonical CTO instead of having dispatch spawn a BOOTSTRAP_CTO and activation provision a resident:
 * the exact project, the exact ACP session that holds its PRIMARY_CTO, and the binding generation it
 * holds it at. Absent, a bootstrap behaves exactly as it does without this module.
 *
 * A leaf module (no registry or session imports) so the run engine can read it without a cycle.
 */
export interface CanonicalCtoBootstrapAdoption {
  projectId: string;
  sessionId: string;
  bindingGeneration: number;
}

/**
 * What the run engine stores in RUN_CREATED once the validator has admitted a request: the request's
 * three fields and the canonical entitlement the validator found for that project (its conversation's
 * session UUID and its Buzz actor), read by ACP, never taken from the requester. The database's
 * manifest-pointer guard (schema v56) admits an adopting bootstrap's first manifest only on this record,
 * matched against the project's live entitlement row and the run's own owner pin.
 */
export interface RecordedBootstrapAdoption extends CanonicalCtoBootstrapAdoption {
  entitlementSessionUuid: string;
  buzzActorId: string;
}

/** The RUN_CREATED evidence field the adoption is recorded under, in the run's creation transaction. */
export const BOOTSTRAP_ADOPTION_EVIDENCE_FIELD = "adoptCanonicalCto";

const REQUEST_FIELDS = ["projectId", "sessionId", "bindingGeneration"] as const;
const RECORDED_FIELDS = [...REQUEST_FIELDS, "entitlementSessionUuid", "buzzActorId"] as const;

const exactIdentifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 200 && value.trim() === value;

const exactFields = (value: unknown, fields: readonly string[]): Record<string, unknown> | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !fields.includes(key))) return null;
  if (!exactIdentifier(input["projectId"]) || !exactIdentifier(input["sessionId"])) return null;
  if (!Number.isSafeInteger(input["bindingGeneration"]) || (input["bindingGeneration"] as number) <= 0) return null;
  return input;
};

/** The requester's input, checked before anything is read or stored. */
export const parseBootstrapAdoption = (value: unknown): Decision<CanonicalCtoBootstrapAdoption> => {
  const input = exactFields(value, REQUEST_FIELDS);
  if (!input) {
    return deny(ReasonCode.INVALID_ARGUMENT, "adoptCanonicalCto names exactly a projectId, a sessionId and a positive bindingGeneration", {
      refusal: "ADOPTION_INPUT_INVALID",
    });
  }
  return allow(ReasonCode.OK, {
    projectId: input["projectId"] as string,
    sessionId: input["sessionId"] as string,
    bindingGeneration: input["bindingGeneration"] as number,
  });
};

const parseRecorded = (value: unknown): RecordedBootstrapAdoption | null => {
  const input = exactFields(value, RECORDED_FIELDS);
  if (!input || !exactIdentifier(input["entitlementSessionUuid"]) || !exactIdentifier(input["buzzActorId"])) return null;
  return {
    projectId: input["projectId"] as string,
    sessionId: input["sessionId"] as string,
    bindingGeneration: input["bindingGeneration"] as number,
    entitlementSessionUuid: input["entitlementSessionUuid"] as string,
    buzzActorId: input["buzzActorId"] as string,
  };
};

/**
 * The adoption a run was created with: the first RUN_CREATED record of the run, written in the same
 * transaction as the run row (audit rows are neither updated nor deleted). Null for every run created
 * without the input. A record that does not carry all five fields is no adoption.
 */
export const recordedBootstrapAdoption = (db: Pick<Db, "get">, runId: string): RecordedBootstrapAdoption | null => {
  const row = db.get<{ adoption: string | null }>(
    `SELECT CASE WHEN json_valid(evidence_json) THEN json_extract(evidence_json, '$.${BOOTSTRAP_ADOPTION_EVIDENCE_FIELD}') END AS adoption
       FROM audit_events WHERE run_id = ? AND kind = 'RUN_CREATED' ORDER BY event_id LIMIT 1`,
    [runId],
  );
  if (!row?.adoption) return null;
  try {
    return parseRecorded(JSON.parse(row.adoption));
  } catch {
    return null;
  }
};
