import { type Stats, closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, writeSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { digestOf } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { OwnerApprovalReceipt } from "../ceo/owner-authority.ts";
import { ensurePrivateDirectory } from "../db/state-preflight.ts";

/**
 * #246 C3 (review 1076-R1-02) — the owner approval an application's execution runs on, anchored
 * outside the database.
 *
 * Whether an owner receipt was admitted and consumed is otherwise answered from database rows: the
 * ingress message, its INGRESS_ADMITTED audit event and the OWNER_APPROVAL_CONSUMED event. The ingress
 * message is a replay cache that is pruned, and a connection ACP did not open cannot insert one at all
 * (its triggers name functions only ACP's own connection defines); but the two audit events are
 * ordinary rows such a connection can insert, so neither can say an approval was consumed once the
 * cache has expired. The runner therefore writes this file itself, after it has admitted the receipt
 * from live ingress and committed its consumption with the reservation or attempt, and before the
 * attempt's first ledger write. It names the receipt, the run, the operation, the candidate and the
 * reservation the receipt was consumed for. A resume and every completion of the application require
 * it; a database row alone never stands in for it.
 *
 * Its trust boundary is the GitHub ledger's: a file in the run's private work directory, refused when
 * it is a symlink, another account's or writable by others. A writer that can write files as this
 * account can fabricate it, which is outside the database writer it guards against.
 */
export const OWNER_APPROVAL_ANCHOR_SCHEMA_ID = "acp.bootstrap.owner-approval-anchor.v1";

const anchoredReceiptSchema = z
  .object({
    channel: z.string().min(1),
    actor: z.string().min(1),
    inboundNonce: z.string().min(1),
    runId: z.string().nullable(),
    candidateSnapshotDigest: z.string().nullable(),
    operation: z.string().min(1),
    parameterDigest: z.string().min(1),
    idempotencyKey: z.string().min(1),
    approved: z.boolean(),
  })
  .strict();

export const ownerApprovalAnchorSchema = z
  .object({
    schema: z.literal(OWNER_APPROVAL_ANCHOR_SCHEMA_ID),
    runId: z.string().min(1),
    bootstrapOperationId: z.string().min(1),
    candidateSnapshotDigest: z.string().min(1),
    /** The digest of exactly the application reservation the receipt was consumed for. */
    reservationDigest: z.string().min(1),
    owner: z.string().min(1),
    visibility: z.enum(["public", "private"]),
    /** The project manifest the owner approved; checked against the reservation's digest when used. */
    approvedManifest: z.unknown(),
    receiptDigest: z.string().min(1),
    receipt: anchoredReceiptSchema,
    anchoredAt: z.string().min(1),
  })
  .strict();

export type OwnerApprovalAnchor = z.infer<typeof ownerApprovalAnchorSchema>;

const RECEIPT_DIGEST = /^sha256:([0-9a-f]{64})$/;

/** One file per consumed receipt, named by its digest, in the run's work directory. */
export const approvalAnchorPath = (workDir: string, receiptDigest: string): string | null => {
  const hex = RECEIPT_DIGEST.exec(receiptDigest)?.[1];
  return hex === undefined ? null : join(workDir, "owner-approval", `${hex}.json`);
};

const unanchored = <T>(refusal: string, message: string, evidence: Record<string, unknown>): Decision<T> =>
  deny(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE, message, { refusal, ...evidence });

/**
 * The anchor of `receiptDigest`, or null when there is none. A symlink, a non-file, another
 * account's file, one writable by others, unreadable JSON or a file that does not describe exactly
 * that receipt is a refusal, never an absence.
 */
export const readApprovalAnchor = (workDir: string, receiptDigest: string): Decision<OwnerApprovalAnchor | null> => {
  const path = approvalAnchorPath(workDir, receiptDigest);
  if (path === null) return unanchored("APPROVAL_ANCHOR_UNREADABLE", "the approval identity is not a receipt digest", { receiptDigest });
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return allow(ReasonCode.OK, null);
    return unanchored("APPROVAL_ANCHOR_UNREADABLE", "the approval anchor could not be inspected", { path, message: (error as Error).message });
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    typeof process.getuid !== "function" ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o022) !== 0
  ) {
    return unanchored("APPROVAL_ANCHOR_UNSAFE", "the approval anchor is not a private regular file of this account", { path });
  }
  let content: unknown;
  try {
    content = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return unanchored("APPROVAL_ANCHOR_UNREADABLE", "the approval anchor is not readable JSON", { path, message: (error as Error).message });
  }
  const parsed = ownerApprovalAnchorSchema.safeParse(content);
  if (!parsed.success || parsed.data.receiptDigest !== receiptDigest || digestOf(parsed.data.receipt) !== receiptDigest) {
    return unanchored("APPROVAL_ANCHOR_UNREADABLE", "the approval anchor does not describe the receipt it is named for", { path });
  }
  return allow(ReasonCode.OK, parsed.data);
};

/**
 * Writes the anchor once, exclusively, and syncs it and its directory. Nothing is renamed or
 * replaced: an anchor of the same receipt already there is accepted only when it says exactly the
 * same, so a second consumption cannot rewrite what the first one anchored.
 */
export const writeApprovalAnchor = (
  workDir: string,
  input: Omit<OwnerApprovalAnchor, "schema" | "receiptDigest" | "receipt"> & { receipt: OwnerApprovalReceipt },
): Decision<OwnerApprovalAnchor> => {
  const receiptDigest = digestOf(input.receipt);
  const anchor: OwnerApprovalAnchor = { schema: OWNER_APPROVAL_ANCHOR_SCHEMA_ID, ...input, receiptDigest, receipt: { ...input.receipt } };
  const path = approvalAnchorPath(workDir, receiptDigest);
  if (path === null) return unanchored("APPROVAL_ANCHOR_UNWRITTEN", "the receipt digest cannot name an anchor", { receiptDigest });
  try {
    ensurePrivateDirectory(workDir);
    ensurePrivateDirectory(join(workDir, "owner-approval"));
    let descriptor: number;
    try {
      descriptor = openSync(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const present = readApprovalAnchor(workDir, receiptDigest);
      const same =
        present.allowed &&
        present.value !== null &&
        digestOf({ ...present.value, anchoredAt: null }) === digestOf({ ...anchor, anchoredAt: null });
      return same
        ? allow(ReasonCode.OK, present.value!)
        : unanchored("APPROVAL_ANCHOR_CONFLICT", "an anchor of this receipt already names another execution", { path });
    }
    try {
      writeSync(descriptor, `${JSON.stringify(anchor, null, 2)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    const directory = openSync(join(workDir, "owner-approval"), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch (error) {
    return unanchored("APPROVAL_ANCHOR_UNWRITTEN", "the approval anchor could not be written", { path, message: (error as Error).message });
  }
  return allow(ReasonCode.OK, anchor);
};

/**
 * #246 C3, reviews 1076-R2 and -R3 — the proof that a ledger intent's request was never sent, and its
 * single use.
 *
 * A request the attempt refused at the moment it would have started, because its authority no longer
 * held, is recorded as withheld: by the runner, before it throws, for exactly the intent the ledger
 * keeps pending for it — the digest of the whole intent, not its operation and the time it was begun,
 * which a later attempt reuses — and for the request generation that withheld it, the attempt. A
 * later attempt that finds that intent pending may then make the request rather than hold it in doubt
 * forever. That exemption is used once (review 1076-R3): before the later attempt lets its request
 * start, it records, durably, that its generation consumed it, and if that cannot be recorded the
 * request is not sent. A consumption is answered only by a withheld record of the same generation —
 * that attempt refused its request before it started. Otherwise the request may have been sent,
 * whether the attempt then crashed or lost the answer, and the intent is in doubt from then on: no
 * later attempt, whatever its number, revives the exemption. Same trust boundary as the anchor.
 */
export const WITHHELD_REQUEST_SCHEMA_ID = "acp.bootstrap.withheld-request.v2";
export const WITHHELD_CONSUMPTION_SCHEMA_ID = "acp.bootstrap.withheld-consumption.v1";

const INTENT_DIGEST = /^sha256:[0-9a-f]{64}$/;

export const withheldRequestSchema = z
  .object({
    schema: z.literal(WITHHELD_REQUEST_SCHEMA_ID),
    runId: z.string().min(1),
    operationId: z.string().min(1),
    resourceType: z.string().min(1),
    /** The digest of the exact pending intent the ledger keeps for the request. */
    intentDigest: z.string().regex(INTENT_DIGEST),
    attemptedAt: z.string().min(1),
    /** The request generation: the attempt that withheld it. */
    attempt: z.number().int().positive(),
    withheldAt: z.string().min(1),
    refusal: z.string().min(1),
  })
  .strict();

export type WithheldRequest = z.infer<typeof withheldRequestSchema>;

export const withheldConsumptionSchema = z
  .object({
    schema: z.literal(WITHHELD_CONSUMPTION_SCHEMA_ID),
    runId: z.string().min(1),
    operationId: z.string().min(1),
    resourceType: z.string().min(1),
    intentDigest: z.string().regex(INTENT_DIGEST),
    /** The request generation that consumed the exemption, before its request could start. */
    attempt: z.number().int().positive(),
    consumedAt: z.string().min(1),
  })
  .strict();

export type WithheldConsumption = z.infer<typeof withheldConsumptionSchema>;

/** The exact intent a record is about: its operation and the digest of the whole pending intent. */
export interface WithheldIntentKey {
  operationId: string;
  intentDigest: string;
}

/** Every record of one exact intent, by generation. */
export interface WithheldIntent {
  withheld: WithheldRequest[];
  consumed: WithheldConsumption[];
}

const withheldIntentDirectory = (workDir: string, key: WithheldIntentKey): string =>
  join(workDir, "withheld-requests", digestOf({ operationId: key.operationId, intentDigest: key.intentDigest }).replace(/^sha256:/, ""));

const WITHHELD_RECORD_NAME = /^(withheld|consumed)-([1-9][0-9]*)\.json$/;

const privateEntry = (stat: Stats, kind: "file" | "directory"): boolean =>
  !stat.isSymbolicLink() &&
  (kind === "file" ? stat.isFile() : stat.isDirectory()) &&
  typeof process.getuid === "function" &&
  stat.uid === process.getuid() &&
  (stat.mode & 0o022) === 0;

/**
 * The withheld and consumption records of exactly this intent: none when there are none, null when
 * any entry for it is not a private, exact record of it — a doubt, never an absence.
 */
export const readWithheldIntent = (workDir: string, key: WithheldIntentKey): WithheldIntent | null => {
  const directory = withheldIntentDirectory(workDir, key);
  let names: string[];
  try {
    if (!privateEntry(lstatSync(directory), "directory")) return null;
    names = readdirSync(directory);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { withheld: [], consumed: [] } : null;
  }
  const records: WithheldIntent = { withheld: [], consumed: [] };
  for (const name of names) {
    const named = WITHHELD_RECORD_NAME.exec(name);
    if (named === null) return null;
    const path = join(directory, name);
    try {
      if (!privateEntry(lstatSync(path), "file")) return null;
      const content: unknown = JSON.parse(readFileSync(path, "utf8"));
      const parsed = named[1] === "withheld" ? withheldRequestSchema.safeParse(content) : withheldConsumptionSchema.safeParse(content);
      if (
        !parsed.success ||
        parsed.data.operationId !== key.operationId ||
        parsed.data.intentDigest !== key.intentDigest ||
        parsed.data.attempt !== Number(named[2])
      ) {
        return null;
      }
      if (parsed.data.schema === WITHHELD_REQUEST_SCHEMA_ID) records.withheld.push(parsed.data);
      else records.consumed.push(parsed.data);
    } catch {
      return null;
    }
  }
  return records;
};

/**
 * Whether the records prove the intent's request was never sent: a generation withheld it, and every
 * generation that consumed the exemption withheld it again before its request started. A consumption
 * with no withheld record of its own generation is a request that may have been sent.
 */
export const withheldUnsent = (records: WithheldIntent | null): boolean =>
  records !== null &&
  records.withheld.length > 0 &&
  records.consumed.every((consumption) => records.withheld.some((withheld) => withheld.attempt === consumption.attempt));

const syncDirectory = (path: string): void => {
  const handle = openSync(path, "r");
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
};

/** One record, written once, exclusively, and synced with the directories that name it. Throws when it cannot. */
const writeWithheldRecord = (workDir: string, key: WithheldIntentKey, name: string, record: unknown): void => {
  const parent = join(workDir, "withheld-requests");
  const directory = withheldIntentDirectory(workDir, key);
  ensurePrivateDirectory(workDir);
  ensurePrivateDirectory(parent);
  ensurePrivateDirectory(directory);
  const descriptor = openSync(join(directory, name), "wx", 0o600);
  try {
    writeSync(descriptor, `${JSON.stringify(record, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  syncDirectory(directory);
  syncDirectory(parent);
};

/** Records that `record.attempt` withheld the intent's request before it started. Throws when it cannot: the intent then stays in doubt. */
export const writeWithheldRequest = (workDir: string, record: Omit<WithheldRequest, "schema">): void =>
  writeWithheldRecord(workDir, record, `withheld-${record.attempt}.json`, { schema: WITHHELD_REQUEST_SCHEMA_ID, ...record });

/**
 * Records that `record.attempt` consumed the intent's exemption, before its request may start. Throws
 * when it cannot, and the request is then not sent; a consumption only partly written is a doubt.
 */
export const consumeWithheldExemption = (workDir: string, record: Omit<WithheldConsumption, "schema">): void =>
  writeWithheldRecord(workDir, record, `consumed-${record.attempt}.json`, { schema: WITHHELD_CONSUMPTION_SCHEMA_ID, ...record });
