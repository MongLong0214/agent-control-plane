import { afterEach, describe, expect, it } from "vitest";

import { allow } from "../../src/core/errors.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { WriteOperation } from "../../src/guard/managed-write-guard.ts";
import { ClaudeCliAdapter, __testing } from "../../src/runtime/cli-adapters.ts";
import type { InvocationRequest, ManagedInvocationWriteBroker } from "../../src/runtime/provider.ts";

/**
 * #512 — a WORKER turn runs as the implementer, not as the operator. Measured live on claude 2.1.283
 * before this change: a worker turn loaded the operator's `~/.claude/CLAUDE.md`, applied the user
 * settings' permission rules (which allow Bash), loaded the user's plugins and started all eight user
 * MCP servers. A WORKER invocation (a task-bound managed write — only `task_worker_run` sends one) now
 * names the claimed worktree's setting sources only and a strict, empty MCP config. Other invocations
 * keep their argv.
 */

afterEach(() => __testing.setRunCli(null));

const argvOf = async (request: Partial<InvocationRequest>): Promise<string[]> => {
  let seen: string[] = [];
  __testing.setRunCli(async (_file, args) => {
    seen = [...args];
    return { stdout: JSON.stringify({ session_id: request.externalSessionId ?? null, result: "ok" }), stderr: "", exitCode: 0, timedOut: false, isolationEnforced: false };
  });
  const broker: ManagedInvocationWriteBroker = { authorize: async (_write, effect) => allow(ReasonCode.WRITE_ALLOWED, await effect()) };
  const adapter = new ClaudeCliAdapter({ clock: new ManualClock(), capacityFile: "/nonexistent/claude.json", binary: process.execPath, managedWriteBroker: broker });
  await adapter.invoke({
    prompt: "p",
    workdir: process.cwd(),
    timeoutMs: 1_000,
    correlationId: "c",
    readOnly: false,
    ...request,
  } as InvocationRequest);
  return seen;
};

const valueAfter = (argv: readonly string[], flag: string): string | undefined => {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
};

describe("#512 a WORKER turn does not load the operator's configuration", () => {
  it("a WORKER invocation names the worktree's setting sources and a strict, empty MCP config", async () => {
    const cwd = process.cwd();
    const argv = await argvOf({
      model: "opus",
      externalSessionId: "11111111-1111-4111-8111-111111111111",
      managedWrite: {
        operation: WriteOperation.FILE_MUTATION,
        targetPath: cwd,
        taskId: "task_x",
        taskReceiptId: "task_x#1",
        assignedWorktreeId: cwd,
        runId: "run_x",
        sessionId: "ses_x",
        sessionIncarnation: "11111111-1111-4111-8111-111111111111#t",
        bindingGeneration: 1,
      },
    });
    expect(valueAfter(argv, "--setting-sources")).toBe("project,local");
    expect(valueAfter(argv, "--setting-sources")).not.toMatch(/user/);
    expect(valueAfter(argv, "--mcp-config")).toBe(JSON.stringify({ mcpServers: {} }));
    expect(argv).toContain("--strict-mcp-config");
    expect(valueAfter(argv, "--permission-mode")).toBe("acceptEdits");
    // Auth is left alone: no flag that moves the config directory or turns keychain reads off.
    for (const flag of ["--bare", "--safe-mode", "--restricted", "--allowedTools", "--allowed-tools", "--dangerously-skip-permissions", "--add-dir"]) {
      expect(argv).not.toContain(flag);
    }
  });

  it("an invocation that is not a WORKER turn keeps its argv", async () => {
    const argv = await argvOf({ readOnly: true, model: "opus" });
    expect(argv).not.toContain("--setting-sources");
    expect(argv).not.toContain("--strict-mcp-config");
    expect(argv).not.toContain("--mcp-config");
  });
});
