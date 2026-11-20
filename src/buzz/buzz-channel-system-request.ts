import type { ChannelNotification } from "./buzz-channel.ts";
import { handoffRequestText, hostStoreFiles, readHandoffRequest, type HandoffRequest, type StoreFiles } from "../cto/cto-session-refresh.ts";

/**
 * ACP's own request to a CTO, shown on that CTO's Buzz channel: "your conversation is long; write a handoff". It is not a
 * Buzz message and not the CEO's or the owner's: the daemon writes a request file beneath its state directory
 * (`src/cto/cto-session-refresh.ts`), and this watcher, inside the CTO's own channel server, shows it once per request id.
 * It grants nothing and asks for one thing, a call to the CTO's own `cto_handoff_write` tool; if the file is forged, the
 * worst a forger gets is a handoff the CTO wrote about its own project.
 */

export const SYSTEM_REQUEST_POLL_MS = 15_000;

export interface SystemRequestWatcherOptions {
  readonly stateDir: string;
  readonly projectId: string;
  readonly emit: (notification: ChannelNotification) => Promise<void>;
  readonly files?: StoreFiles;
  readonly intervalMs?: number;
  readonly onDiagnostic?: (line: string) => void;
}

export const systemRequestNotification = (request: HandoffRequest): ChannelNotification => ({
  content: handoffRequestText(request),
  meta: { sender_role: "acp", project: request.projectId, request_id: request.requestId, trust: "acp_system_request" },
});

export interface SystemRequestWatcher {
  /** One look at the request file; shows a request not shown before. Resolves true when it showed one. */
  poll(): Promise<boolean>;
  start(): void;
  stop(): void;
}

export const createSystemRequestWatcher = (options: SystemRequestWatcherOptions): SystemRequestWatcher => {
  const files = options.files ?? hostStoreFiles;
  const shown = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;
  const poll = async (): Promise<boolean> => {
    const request = readHandoffRequest(files, options.stateDir, options.projectId);
    if (request === null || shown.has(request.requestId)) return false;
    try {
      await options.emit(systemRequestNotification(request));
      shown.add(request.requestId);
      return true;
    } catch {
      options.onDiagnostic?.("a handoff request could not be shown; it is asked again");
      return false;
    }
  };
  return {
    poll,
    start: () => {
      if (timer !== null) return;
      timer = setInterval(() => void poll(), options.intervalMs ?? SYSTEM_REQUEST_POLL_MS);
      timer.unref();
    },
    stop: () => { if (timer !== null) { clearInterval(timer); timer = null; } },
  };
};
