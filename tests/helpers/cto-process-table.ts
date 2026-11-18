import type { CtoProcessReader } from "../../src/cto/one-cto-per-project.ts";

/**
 * The host's process table as a claim test that models its own processes (synthetic ancestry, stand-ins) states it:
 * only the test process itself. The claim's one-CTO check reads the real `ps` and `lsof` unless it is given a reader,
 * and a test that fakes the claimant's ancestry has no business being judged on the claude sessions of the machine
 * running it, or on its own stand-ins, which are test doubles of a process table rather than members of one.
 */
export const noOtherCtoProcesses: CtoProcessReader = {
  table: async () => [{ pid: process.pid, ppid: 1, uid: process.getuid?.() ?? 0, startedAt: "Fri Jan  1 00:00:00 2027", command: "node vitest" }],
  cwds: async () => new Map(),
  tmuxPanes: async () => new Map(),
  alive: () => false,
  startToken: () => null,
};
