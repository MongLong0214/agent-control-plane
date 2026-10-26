/**
 * The one shape in which the resident host provisioner may say why an operation failed: which pinned
 * binary, in which operation, what happened to it, and its exit code when it exited. The host script
 * writes it and the daemon reads it through this module alone. Nothing else on the host's stderr
 * crosses: raw child output, free text and any near miss are dropped whole, never truncated.
 * The script runs this file from source under Node's type stripping, so it holds only erasable syntax.
 */
export const hostReasonBinaries = ['buzz', 'claude'] as const;
/** Only `nonZeroExit` (exit code 1-255) and `exited` (exit code 0) carry an exit code. */
export const hostReasonKind = {
  missingVariable: 'missing binary variable',
  relativePath: 'binary path is not absolute',
  missing: 'binary is missing',
  notRegularFile: 'binary is not an executable regular file',
  notExecutable: 'binary is not executable',
  missingAtExecution: 'binary is missing (ENOENT)',
  timedOut: 'execution timed out',
  failed: 'execution failed',
  nonZeroExit: 'non-zero exit',
  exited: 'exited',
} as const;
export interface HostProvisionerReason {
  binary: typeof hostReasonBinaries[number];
  operation: string;
  kind: typeof hostReasonKind[keyof typeof hostReasonKind];
  exitCode?: number;
}

const kinds: readonly string[] = Object.values(hostReasonKind);
const exitCodeFits = (kind: string, exitCode: unknown): boolean =>
  kind === hostReasonKind.nonZeroExit ? Number.isInteger(exitCode) && (exitCode as number) >= 1 && (exitCode as number) <= 255 :
  kind === hostReasonKind.exited ? exitCode === 0 : exitCode === undefined;

/** The reason in the allowlisted shape, or null when any field falls outside it. */
export function hostProvisionerReason(binary: unknown, operation: unknown, kind: unknown, exitCode?: unknown): HostProvisionerReason | null {
  if (!hostReasonBinaries.some(name => name === binary) || typeof operation !== 'string' || !/^[a-z]+(?:-[a-z]+)*$/.test(operation) ||
    typeof kind !== 'string' || !kinds.includes(kind) || !exitCodeFits(kind, exitCode)) return null;
  const reason = { binary, operation, kind } as HostProvisionerReason;
  return exitCode === undefined ? reason : { ...reason, exitCode: exitCode as number };
}

export const formatHostProvisionerReason = (reason: HostProvisionerReason): string =>
  `${reason.binary} in ${reason.operation}: ${reason.kind}${reason.exitCode === undefined ? '' : ` with exit code ${reason.exitCode}`}`;

/** The host's whole stderr for a refused operation. `detail` is only ever the script's own text. */
export const hostRefusalText = (detail?: string): string => `host project provisioner refused operation${detail === undefined ? '' : `: ${detail}`}\n`;

/**
 * The daemon's reading of the host's stderr after `operation` failed: a reason only when the whole of
 * stderr is exactly the refusal text of one allowlisted reason for that same operation, otherwise null.
 */
export function readHostProvisionerReason(stderr: string, operation: string): HostProvisionerReason | null {
  const match = /^host project provisioner refused operation: (\S+) in (\S+): (.+?)(?: with exit code (\d+))?\n$/.exec(stderr);
  const reason = match && hostProvisionerReason(match[1], match[2], match[3], match[4] === undefined ? undefined : Number(match[4]));
  return reason && reason.operation === operation && hostRefusalText(formatHostProvisionerReason(reason)) === stderr ? reason : null;
}
