import { execFile } from 'node:child_process';
import { z } from 'zod';

export const hostOperations = ['ensure-checkout', 'ensure-buzz', 'ensure-routing', 'ensure-resident', 'observe', 'retire'] as const;
export type HostOperation = typeof hostOperations[number];
export interface ProjectAllocation {
  projectId: string; runId: string; repositoryIdentity: string; repositoryNodeId: string; head: string;
  sessionUuid: string; roomId: string; roomName?: string; clonePath: string; tmuxName: string; socketPath: string;
  retirementPin?: {pid:number;startedAt:string};
  fleetName: string; identityName: string; privateKeyFile: string; bootPacket: string; nonce: string;
}
export const hostObservationSchema = z.object({
  checkout: z.object({ path: z.string(), origin: z.string(), head: z.string(), repositoryNodeId: z.string() }).optional(),
  buzz: z.object({ pubkey: z.string().regex(/^[a-f0-9]{64}$/), roomId: z.string().uuid(), rosterVerified: z.literal(true), nonceEventId: z.string(), nonceReadable: z.literal(true) }).optional(),
  routing: z.object({ generation: z.number().int(), roomId: z.string().uuid() }).optional(),
  resident: z.object({ pid: z.number().int().positive(), startedAt: z.string().min(1), cwd: z.string(), sessionUuid: z.string().uuid(), tmuxName: z.string(), tmuxAncestry: z.literal(true), bridgeSessionId: z.string().min(1) }).optional(),
  fleet: z.boolean().optional(), retired: z.boolean().optional(), retirementArchivePath: z.string().optional(),
}).strict();
export type HostObservation = z.infer<typeof hostObservationSchema>;
export interface HostProjectProvisioner {
  invoke(operation: HostOperation, allocation: ProjectAllocation, packet?: unknown): Promise<HostObservation>;
}
/** One bounded execFile protocol. No shell, command text, credentials or raw child errors cross it. */
export class ExecFileHostProjectProvisioner implements HostProjectProvisioner {
  constructor(private readonly script: string, private readonly home: string, private readonly stateDir: string, private readonly timeoutMs = 120_000) {}
  invoke(operation: HostOperation, allocation: ProjectAllocation, packet?: unknown): Promise<HostObservation> {
    return new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [this.script], { timeout: this.timeoutMs, maxBuffer: 2_000_000,
        env: { ...process.env, HOME: this.home, ACP_STATE_DIR: this.stateDir }, killSignal: 'SIGKILL' }, (error, stdout) => {
        if (error) { reject(new Error(`host provisioner ${operation} failed`)); return; }
        try { resolve(hostObservationSchema.parse(JSON.parse(stdout))); } catch { reject(new Error('invalid host provisioner response')); }
      });
      child.stdin?.end(JSON.stringify({ version: 1, operation, allocation, packet }));
    });
  }
}
