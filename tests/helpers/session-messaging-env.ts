import { spawnSync } from "node:child_process";

/**
 * The session-messaging variables a Claude Code session hands its children. The relay's CLI entry
 * reads `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` from its environment, and a
 * test run from inside a Claude Code session inherits that session's real ones: a relay would open
 * its wake proxy beside the live session's socket, outside the test's scratch roots.
 */
export const SESSION_MESSAGING_PREFIX = "CLAUDE_CODE_MESSAGING_";

/**
 * Deletes every variable whose name starts with `SESSION_MESSAGING_PREFIX` from this process's
 * environment: a prefix, not a list of the names known today, so a variable a later client adds
 * under that prefix is cleared too (R1154-01).
 *
 * Takes no argument on purpose. Passed straight to `beforeEach`, a parameter would receive the hook's
 * test context and the deletes would land on that object instead of `process.env`.
 */
export const clearSessionMessagingEnv = (): void => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith(SESSION_MESSAGING_PREFIX)) delete process.env[name];
  }
};

/**
 * The prefixed names a relay started now would see: in this process's environment, which an
 * in-process relay reads, and in the environment of a child that inherits it, as a spawned relay
 * does when it is given no environment of its own.
 */
export const inheritedSessionMessagingNames = (): { here: string[]; child: string[] } => {
  const prefixed = (names: readonly string[]): string[] =>
    names.filter((name) => name.startsWith(SESSION_MESSAGING_PREFIX)).sort();
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (child.status !== 0) throw new Error(`the environment probe child failed: ${child.stderr}`);
  return { here: prefixed(Object.keys(process.env)), child: prefixed(JSON.parse(child.stdout) as string[]) };
};
