import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chmodSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { main as cliMain } from "../../src/cli/agentctl.ts";
import { runCtoCommand, type CtoPorts } from "../../src/cli/cto-command.ts";
import { deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeStartedOperator, TEST_OPERATOR_TOKEN, type StartedOperator } from "../helpers/harness.ts";

// `ACP_OPERATOR_TOKEN_FILE` is the operator's explicit way to hand agentctl the credential without exporting it.
// Each case drives `agentctl daemon status` through main(): a live answer prints the daemon's own status, and a
// refused one prints the offline reading with the reason the socket gave, so the output says which happened.

const VARS = ["ACP_OPERATOR_SOCKET", "ACP_OPERATOR_TOKEN", "ACP_OPERATOR_TOKEN_FILE"] as const;
let running: StartedOperator;
const saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));

beforeAll(async () => { running = await makeStartedOperator(); });
afterAll(async () => { await running.close(); cleanupTempDirs(); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const tokenFile = (contents: string, mode: number): string => {
  const path = join(tempDir("acp-operator-token-file-"), "operator.token");
  writeFileSync(path, contents);
  chmodSync(path, mode);
  return path;
};

const status = async (env: Partial<Record<(typeof VARS)[number], string>>): Promise<{ code: number; answer: Record<string, unknown> }> => {
  for (const name of VARS) delete process.env[name];
  process.env["ACP_OPERATOR_SOCKET"] = running.socketPath;
  Object.assign(process.env, env);
  const printed: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { printed.push(String(chunk)); return true; });
  const code = await cliMain(["daemon", "status"]);
  vi.restoreAllMocks();
  return { code, answer: JSON.parse(printed.join("")) as Record<string, unknown> };
};

describe("agentctl ACP_OPERATOR_TOKEN_FILE", () => {
  it("authenticates with the credential read from an explicitly named 0600 file", async () => {
    const { code, answer } = await status({ ACP_OPERATOR_TOKEN_FILE: tokenFile(`${TEST_OPERATOR_TOKEN}\n`, 0o600) });
    expect(code).toBe(0);
    expect(answer).not.toHaveProperty("daemonStatus");
    expect(answer).toHaveProperty("mode");
  });

  it("with neither variable set, reads nothing and the daemon is still asked without a token", async () => {
    const { code, answer } = await status({});
    expect(code).toBe(0);
    expect(answer["daemonStatus"]).toMatchObject({ reasonCode: ReasonCode.OPERATOR_UNAUTHENTICATED });
  });

  it.each([
    ["group-readable", 0o640],
    ["world-readable", 0o604],
    ["group-writable", 0o620],
  ])("refuses a %s file and sends nothing", async (_label, mode) => {
    const { code, answer } = await status({ ACP_OPERATOR_TOKEN_FILE: tokenFile(TEST_OPERATOR_TOKEN, mode) });
    expect(code).toBe(1);
    expect(answer).toMatchObject({ allowed: false, reasonCode: ReasonCode.OPERATOR_UNAUTHENTICATED });
    expect(String(answer["message"])).toMatch(/^ACP_OPERATOR_TOKEN_FILE is refused: .*beyond its owner/);
  });

  it("refuses a file owned by another user", async () => {
    const path = tokenFile(TEST_OPERATOR_TOKEN, 0o600);
    const uid = process.getuid!();
    // The file is this process's own; reporting a different uid for the caller is the only way to stand on the
    // other side of the ownership check without root.
    for (const name of VARS) delete process.env[name];
    process.env["ACP_OPERATOR_SOCKET"] = running.socketPath;
    process.env["ACP_OPERATOR_TOKEN_FILE"] = path;
    const printed: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { printed.push(String(chunk)); return true; });
    vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    const code = await cliMain(["daemon", "status"]);
    vi.restoreAllMocks();
    expect(code).toBe(1);
    expect(JSON.parse(printed.join(""))).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.OPERATOR_UNAUTHENTICATED,
      message: expect.stringMatching(/owned by another user/) as unknown,
    });
  });

  it("refuses a symlink to a valid 0600 file", async () => {
    const target = tokenFile(TEST_OPERATOR_TOKEN, 0o600);
    const link = join(tempDir("acp-operator-token-link-"), "operator.token");
    symlinkSync(target, link);
    const { code, answer } = await status({ ACP_OPERATOR_TOKEN_FILE: link });
    expect(code).toBe(1);
    expect(answer).toMatchObject({ allowed: false, reasonCode: ReasonCode.OPERATOR_UNAUTHENTICATED });
    expect(String(answer["message"])).toMatch(/symbolic link/);
  });

  it("refuses an empty 0600 file", async () => {
    const { code, answer } = await status({ ACP_OPERATOR_TOKEN_FILE: tokenFile(" \n", 0o600) });
    expect(code).toBe(1);
    expect(answer).toMatchObject({ allowed: false, reasonCode: ReasonCode.OPERATOR_UNAUTHENTICATED });
    expect(String(answer["message"])).toMatch(/it is empty/);
  });

  it("lets ACP_OPERATOR_TOKEN win over a named file, which is then never opened", async () => {
    const wrong = await status({
      ACP_OPERATOR_TOKEN: "not-the-daemons-operator-token",
      ACP_OPERATOR_TOKEN_FILE: tokenFile(TEST_OPERATOR_TOKEN, 0o600),
    });
    expect(wrong.answer["daemonStatus"]).toMatchObject({ reasonCode: ReasonCode.OPERATOR_UNAUTHENTICATED });

    const right = await status({
      ACP_OPERATOR_TOKEN: TEST_OPERATOR_TOKEN,
      ACP_OPERATOR_TOKEN_FILE: tokenFile("not-the-daemons-operator-token", 0o644),
    });
    expect(right.code).toBe(0);
    expect(right.answer).toHaveProperty("mode");
  });
});

// `cto --apply` checks for a credential before it asks the daemon to authenticate one. A daemon that refuses with its own
// reason shows the check passed; a refusal naming the variables shows it did not, and then the daemon is never asked.
describe("agentctl cto --apply resolves the credential the same way", () => {
  const apply = async (env: Record<string, string>): Promise<{ code: number; refused: string; asked: number }> => {
    const out: Array<{ refused?: string }> = [];
    let asked = 0;
    const ports = {
      env,
      write: (value: { refused?: string }) => { out.push(value); },
      operator: { request: async () => { asked++; return deny(ReasonCode.CONFLICT, "daemon stub"); } },
    } as unknown as CtoPorts;
    const code = await runCtoCommand(["relaunch", "p1", "--apply"], ports);
    return { code, refused: String(out.at(-1)?.refused), asked };
  };

  it("accepts an explicitly named 0600 file and goes on to ask the daemon", async () => {
    const result = await apply({ ACP_OPERATOR_TOKEN_FILE: tokenFile(TEST_OPERATOR_TOKEN, 0o600) });
    expect(result.asked).toBe(1);
    expect(result.refused).toMatch(/daemon did not authenticate this credential \(CONFLICT\)/);
  });

  it("refuses with neither variable set, and with a file that is not 0600, before asking the daemon", async () => {
    const none = await apply({});
    expect(none).toMatchObject({ code: 2, asked: 0 });
    expect(none.refused).toMatch(/needs ACP_OPERATOR_TOKEN or ACP_OPERATOR_TOKEN_FILE/);
    const loose = await apply({ ACP_OPERATOR_TOKEN_FILE: tokenFile(TEST_OPERATOR_TOKEN, 0o644) });
    expect(loose).toMatchObject({ code: 2, asked: 0 });
    expect(loose.refused).toMatch(/ACP_OPERATOR_TOKEN_FILE is refused: .*beyond its owner/);
  });
});
