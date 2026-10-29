import { execFile } from 'node:child_process';
import { z } from 'zod';
import { join } from 'node:path';
import type { CanonicalCeoBuzzRoute } from '../outbox/ceo-buzz-signer.ts';

export const hostOperations = ['ensure-checkout', 'ensure-buzz', 'ensure-routing', 'ensure-resident', 'observe', 'verify-retire', 'retire'] as const;
export type HostOperation = typeof hostOperations[number];
export interface ProjectAllocation {
  projectId: string; runId: string; repositoryIdentity: string; repositoryNodeId: string; head: string;
  sessionUuid: string; roomId: string; roomName?: string; clonePath: string; tmuxName: string; socketPath: string;
  retirementPin?: {pid:number;startedAt:string};
  fleetName: string; identityName: string; privateKeyFile: string; bootPacket: string; nonce: string;
}
/** Narrow extension of ensure-buzz: the host independently reads this tuple from its database. */
export interface CeoBuzzSignerAllocation {
  mode: 'ceo-route-signer'; route: CanonicalCeoBuzzRoute; signer: string;
}
export type HostAllocation = ProjectAllocation | CeoBuzzSignerAllocation;
export const hostObservationSchema = z.object({
  checkout: z.object({ path: z.string(), origin: z.string(), head: z.string(), repositoryNodeId: z.string() }).optional(),
  buzz: z.object({ pubkey: z.string().regex(/^[a-f0-9]{64}$/), roomId: z.string().uuid(), rosterVerified: z.literal(true), nonceEventId: z.string(), nonceReadable: z.literal(true) }).optional(),
  ceoBuzzSigner: z.object({
    route: z.object({ assignmentId: z.string(), bindingGeneration: z.number().int(), actorId: z.string(),
      sessionId: z.string(), incarnation: z.string(), targetBindingId: z.string(), roomId: z.string().uuid(), recipient: z.string() }).strict(),
    signer: z.string().regex(/^[a-f0-9]{64}$/), changed: z.boolean(), rosterVerified: z.literal(true),
  }).strict().optional(),
  routing: z.object({ generation: z.number().int().optional(), roomId: z.string().uuid() }).optional(),
  resident: z.object({ pid: z.number().int().positive(), startedAt: z.string().min(1), cwd: z.string(), sessionUuid: z.string().uuid(), tmuxName: z.string(), tmuxAncestry: z.literal(true), bridgeSessionId: z.string().min(1) }).optional(),
  fleet: z.boolean().optional(), retired: z.boolean().optional(), retirementArchivePath: z.string().optional(),
  buzzRoom: z.enum(['archived', 'none']).optional(), identityArchivePath: z.string().optional(), retirementVerified: z.literal(true).optional(),
}).strict();
export type HostObservation = z.infer<typeof hostObservationSchema>;
export interface HostProjectProvisioner {
  invoke(operation: HostOperation, allocation: HostAllocation, packet?: unknown): Promise<HostObservation>;
}
/** A lost response is recoverable by readback; a known refusal/invalid receipt is not. */
export class HostProvisionerError extends Error {
  constructor(readonly outcome: 'LOST' | 'INVALID' | 'REFUSED', readonly refusal?: { code: string; message: string }) {
    super(refusal ? `host provisioner refused: ${refusal.code}: ${refusal.message}` : `host provisioner result ${outcome.toLowerCase()}`);
  }
}

/**
 * #1229 — the host stopped a retirement (or its verification) and said how far it got. `hostChanged: false` is a
 * refusal before its first host write: the host is exactly as it was. `requiredOrder` is what lets retirement complete.
 */
export class HostRetirementRefusal extends Error {
  constructor(readonly reason: string, readonly requiredOrder: readonly string[], readonly hostChanged: boolean) {
    super(`host retirement refused: ${reason}`);
  }
}

/** The provisioner's own structured retirement outcome: the last stderr line, and nothing else from the child. */
const retirementRefusalOf = (stderr: string): HostRetirementRefusal | null => {
  try {
    const outcome = (JSON.parse(stderr.trim().split('\n').at(-1) ?? '') as {retirementOutcome?: {hostChanged?: unknown; reason?: unknown; requiredOrder?: unknown}}).retirementOutcome;
    const order = outcome?.requiredOrder;
    if (typeof outcome?.hostChanged !== 'boolean' || typeof outcome.reason !== 'string' || !Array.isArray(order) || order.length === 0 || !order.every(step => typeof step === 'string')) return null;
    return new HostRetirementRefusal(outcome.reason, order as string[], outcome.hostChanged);
  } catch { return null; }
};

/** One bounded execFile protocol. No shell, command text, credentials or raw child errors cross it. */
export class ExecFileHostProjectProvisioner implements HostProjectProvisioner {
  constructor(private readonly script: string, private readonly home: string, private readonly stateDir: string, private readonly timeoutMs = 120_000, private readonly databasePath = join(stateDir, "state.sqlite")) {}
  invoke(operation: HostOperation, allocation: HostAllocation, packet?: unknown): Promise<HostObservation> {
    if ('mode' in allocation && operation !== 'ensure-buzz') return Promise.reject(new Error('CEO signer allocation requires ensure-buzz'));
    return new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [this.script], { timeout: this.timeoutMs, maxBuffer: 2_000_000,
        env: { ...process.env, HOME: this.home, ACP_STATE_DIR: this.stateDir, ACP_HOST_DATABASE_PATH: this.databasePath }, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
        if (error) {
          if ('mode' in allocation) {
            try {
              const failure = JSON.parse(stderr).ceoBuzzSignerFailure;
              if (failure && ['INVALID','REFUSED','LOST'].includes(failure.outcome) &&
                typeof failure.code === 'string' && typeof failure.message === 'string') {
                reject(new HostProvisionerError(failure.outcome, {code:failure.code,message:failure.message})); return;
              }
            } catch { /* An unclassified failure supplies no verification. */ }
            reject(new HostProvisionerError(error.killed || error.code === 'ETIMEDOUT' ? 'LOST' : 'INVALID')); return;
          }
          reject((operation === 'retire' || operation === 'verify-retire' ? retirementRefusalOf(String(stderr)) : null) ?? new Error(`host provisioner ${operation} failed`)); return;
        }
        try { resolve(hostObservationSchema.parse(JSON.parse(stdout))); }
        catch { reject('mode' in allocation ? new HostProvisionerError('INVALID') : new Error('invalid host provisioner response')); }
      });
      child.stdin?.end(JSON.stringify({ version: 1, operation, allocation, packet }));
    });
  }
}
