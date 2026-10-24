import { afterEach, expect, it, vi } from "vitest";
import type * as ChildProcess from "node:child_process";
import type { ExecFileOptions } from "node:child_process";

import { ExecFileHostProjectProvisioner, type CeoBuzzSignerAllocation } from "../../src/runtime/host-project-provisioner.ts";

const edge = vi.hoisted(() => ({ exec: vi.fn(), response: "{}", request: null as unknown }));
// Only the existing execFile protocol is exercised. No host script, CLI or relay runs.
vi.mock("node:child_process", async original => ({
  ...await original<typeof ChildProcess>(),
  execFile: edge.exec.mockImplementation((_file: string, _args: string[], _options: ExecFileOptions,
    done: (error: Error | null, stdout: string) => void) => ({ stdin: { end: (bytes: string) => {
      edge.request = JSON.parse(bytes); queueMicrotask(() => done(null, edge.response));
    } } })),
}));
afterEach(() => { edge.exec.mockClear(); edge.request = null; edge.response = "{}"; });
const allocation: CeoBuzzSignerAllocation = {
  mode: "ceo-route-signer", signer: "a".repeat(64),
  route: { assignmentId: "assignment", bindingGeneration: 2, actorId: "verified-actor", sessionId: "current-ceo",
    incarnation: "current-incarnation", targetBindingId: "verified-target", roomId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", recipient: "ceo-key" },
};

it("extends ensure-buzz with an explicit public-only CEO allocation on the existing bounded wire", async () => {
  edge.response = JSON.stringify({ ceoBuzzSigner: { route: allocation.route, signer: allocation.signer, changed: true, rosterVerified: true } });
  const port = new ExecFileHostProjectProvisioner("/fake/dist/host/host-project-provisioner.mjs", "/fake/home", "/fake/state", 1234, "/fake/state/custom.sqlite");
  expect(await port.invoke("ensure-buzz", allocation)).toEqual(JSON.parse(edge.response));
  expect(edge.request).toEqual({ version: 1, operation: "ensure-buzz", allocation });
  const [binary, args, options] = edge.exec.mock.calls[0]!;
  expect(binary).toBe(process.execPath); expect(args).toEqual(["/fake/dist/host/host-project-provisioner.mjs"]);
  expect(options).toMatchObject({ timeout: 1234, killSignal: "SIGKILL", env: {
    HOME: "/fake/home", ACP_STATE_DIR: "/fake/state", ACP_HOST_DATABASE_PATH: "/fake/state/custom.sqlite",
  } });
  expect(JSON.stringify(edge.request)).not.toContain("privateKey");
});

it("cannot use the CEO allocation with a different host operation", async () => {
  const port = new ExecFileHostProjectProvisioner("/fake/script", "/fake/home", "/fake/state");
  await expect(port.invoke("ensure-routing", allocation)).rejects.toThrow("requires ensure-buzz");
  expect(edge.exec).not.toHaveBeenCalled();
});

it("rejects a receipt that does not establish roster verification", async () => {
  edge.response = JSON.stringify({ ceoBuzzSigner: { route: allocation.route, signer: allocation.signer, changed: true, rosterVerified: false } });
  const port = new ExecFileHostProjectProvisioner("/fake/script", "/fake/home", "/fake/state");
  await expect(port.invoke("ensure-buzz", allocation)).rejects.toThrow("invalid host provisioner response");
});
