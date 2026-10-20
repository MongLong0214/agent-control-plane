import { type Stats, closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { digestOf } from "../core/digest.ts";
import { ensurePrivateDirectory } from "../db/state-preflight.ts";
import { frameRecord, unframeRecord, writeWholeSync } from "./whole-write.ts";

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

/** The directory that holds every record of one exact intent. */
export const withheldIntentDirectory = (workDir: string, key: WithheldIntentKey): string =>
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
      // Review 1076-R5 — whole and exact, the closing newline included: a prefix that parses is not the record.
      const content = unframeRecord(readFileSync(path));
      if (content === null) return null;
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

/**
 * One record, written once, exclusively, whole, and synced with the directories that name it. Throws
 * when it cannot — a write cut short included (review 1076-R4) — and then nothing relies on it.
 */
const writeWithheldRecord = (workDir: string, key: WithheldIntentKey, name: string, record: unknown): void => {
  const parent = join(workDir, "withheld-requests");
  const directory = withheldIntentDirectory(workDir, key);
  ensurePrivateDirectory(workDir);
  ensurePrivateDirectory(parent);
  ensurePrivateDirectory(directory);
  const descriptor = openSync(join(directory, name), "wx", 0o600);
  try {
    writeWholeSync(descriptor, frameRecord(record));
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
