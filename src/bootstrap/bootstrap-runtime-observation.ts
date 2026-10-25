import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { digestOf, sha256 } from "../core/digest.ts";
import type { AuditLog } from "../db/audit.ts";
import { BOOTSTRAP_POST_CONFIRM_LIFECYCLE } from "./bootstrap-lifecycle.ts";

export const bootstrapCodeGuarantees = () => BOOTSTRAP_POST_CONFIRM_LIFECYCLE.map(({ id, kind, statement }) => ({ id, kind, statement }));
export interface BootstrapRuntimeObservation {
  eventId: number;
  generation: string | null;
  runtimeSha256: string;
  entrypointSha256: string;
  runtimeFileCount: number;
  entrypoint: string;
  pid: number;
  lifecycleDigest: string;
}
/** Called by agentcpd before serving requests. Never reads a checkout HEAD or an author field.
 * The generation is an observed directory name, not proof of a source commit. runtimeSha256 is
 * the fingerprint of runtime code/SQL/native files at startup, not a source commit or test result.
 */
export function recordBootstrapServingRuntime(audit: AuditLog, entrypointUrl: string): number {
  const entrypoint = realpathSync(fileURLToPath(entrypointUrl));
  const runtimeRoot = dirname(dirname(entrypoint));
  const root = dirname(runtimeRoot);
  const files: Array<{ path: string; sha256: string }> = [];
  const scan = (directory: string): void => {
    for (const member of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, member.name);
      if (member.isDirectory()) scan(path);
      else if (member.isFile() && /\.(?:js|mjs|ts|sql|node|dylib|so)$/.test(member.name)) {
        files.push({ path: relative(runtimeRoot, path), sha256: sha256(readFileSync(path)) });
      }
    }
  };
  scan(runtimeRoot);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const generation = basename(dirname(dirname(entrypoint))) === "dist" ? basename(root) : null;
  const observed = audit.record({ kind: "DAEMON_RUNTIME_OBSERVED", evidence: {
    generation, runtimeSha256: digestOf(files), entrypointSha256: sha256(readFileSync(entrypoint)), runtimeFileCount: files.length, resolvedPath: entrypoint, pid: process.pid,
    lifecycleDigest: digestOf(bootstrapCodeGuarantees()),
  } });
  if (!observed.allowed) throw new Error(observed.message);
  return observed.value;
}
export function bootstrapServingRuntime(audit: AuditLog, eventId: number | null): BootstrapRuntimeObservation | null {
  const event = audit.byKind("DAEMON_RUNTIME_OBSERVED").find(e => e.eventId === eventId && e.reasonCode === null);
  if (!event || event.evidence["pid"] !== process.pid || event.evidence["lifecycleDigest"] !== digestOf(bootstrapCodeGuarantees())) return null;
  return { eventId: event.eventId, generation: event.evidence["generation"] as string | null,
    runtimeSha256: event.evidence["runtimeSha256"] as string, entrypointSha256: event.evidence["entrypointSha256"] as string,
    runtimeFileCount: event.evidence["runtimeFileCount"] as number, entrypoint: event.evidence["resolvedPath"] as string,
    pid: event.evidence["pid"] as number, lifecycleDigest: event.evidence["lifecycleDigest"] as string };
}
