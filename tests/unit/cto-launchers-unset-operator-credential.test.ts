import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CHILD_BUDGET_MS } from "../helpers/bounded-sync-child.ts";

// Every CTO launch shell starts with one `unset` line. The operator credential reaches agentctl through either
// ACP_OPERATOR_TOKEN or ACP_OPERATOR_TOKEN_FILE, so a CTO session must inherit neither. Each launcher's own line is run
// here in a real shell, and the environment it hands to what it execs is read back.
const LAUNCHERS = ["src/cli/cto-command.ts", "scripts/rotate-canonical-cto.mjs", "scripts/host-project-provisioner.mjs"];

describe("CTO launch shells unset the operator credential in both its forms", () => {
  it.each(LAUNCHERS)("%s: the child environment carries neither ACP_OPERATOR_TOKEN nor ACP_OPERATOR_TOKEN_FILE", (path) => {
    const lines = readFileSync(join(process.cwd(), path), "utf8").match(/unset ACP_OPERATOR_TOKEN[A-Z0-9_ ]*/g) ?? [];
    expect(lines).toHaveLength(1);
    const child = spawnSync("/bin/sh", ["-c", `${lines[0]}\nexec /usr/bin/env`], {
      env: { PATH: "/usr/bin:/bin", ACP_OPERATOR_TOKEN: "operator-test-credential", ACP_OPERATOR_TOKEN_FILE: "/nonexistent/operator.token", KEPT: "1" },
      encoding: "utf8",
      timeout: CHILD_BUDGET_MS,
    });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toMatch(/^KEPT=1$/m);
    expect(child.stdout).not.toMatch(/^ACP_OPERATOR_TOKEN(?:_FILE)?=/m);
  });
});
