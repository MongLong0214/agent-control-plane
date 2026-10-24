import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { getPublicKey } from "nostr-tools/pure";
import { nsecEncode } from "nostr-tools/nip19";
import { canonicalJson } from "../../src/core/digest.ts";
import * as SignerRoute from "../../src/outbox/ceo-buzz-signer.ts";

import { afterEach, expect, it, vi } from "vitest";
import type * as ChildProcess from "node:child_process";
import type { ExecFileOptions } from "node:child_process";

import { ExecFileHostProjectProvisioner, type CeoBuzzSignerAllocation } from "../../src/runtime/host-project-provisioner.ts";

const edge = vi.hoisted(() => ({ exec: vi.fn(), response: "{}", error: null as Error | null, stderr: "", request: null as unknown }));
// Only the existing execFile protocol is exercised. No host script, CLI or relay runs.
vi.mock("node:child_process", async original => ({
  ...await original<typeof ChildProcess>(),
  execFile: edge.exec.mockImplementation((_file: string, _args: string[], _options: ExecFileOptions,
    done: (error: Error | null, stdout: string, stderr: string) => void) => ({ stdin: { end: (bytes: string) => {
      edge.request = JSON.parse(bytes); queueMicrotask(() => done(edge.error, edge.response, edge.stderr));
    } } })),
}));
afterEach(() => { edge.exec.mockClear(); edge.request = null; edge.response = "{}"; edge.error = null; edge.stderr = ""; });
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
  await expect(port.invoke("ensure-buzz", allocation)).rejects.toMatchObject({ outcome: "INVALID" });
});

it.each(["hex", "nsec"] as const)("ACP1199-02: host signer branch accepts %s without changing its sending credential", encoding => {
  const key = "1".repeat(64); const signer = getPublicKey(Buffer.from(key, "hex"));
  const credential = encoding === "hex" ? key : nsecEncode(Buffer.from(key, "hex"));
  const request = { ...allocation, signer, route: { ...allocation.route, recipient: "c".repeat(64) } };
  const members = [{ pubkey: request.route.recipient, role: "admin" }];
  const room = { channel_id: request.route.roomId, visibility: "private", policy: "preserved" };
  const run = vi.fn((_binary: string, args: string[]) => { members.push({ pubkey: args[args.indexOf("--pubkey") + 1]!, role: "member" }); });
  const environment = { BUZZ_PRIVATE_KEY: credential };
  // Execute only the source branch with every host effect replaced. No script process,
  // real environment, filesystem state, DB or relay is available inside this VM.
  const source = readFileSync(new URL("../../scripts/host-project-provisioner.mjs", import.meta.url), "utf8");
  const start = source.indexOf("case 'ensure-buzz': {");
  const end = source.indexOf("      if (!existsSync(a.privateKeyFile))", start);
  const branch = source.slice(start, end);
  const result = runInNewContext(`let result; switch ('ensure-buzz') { ${branch} } } result;`, {
    a: request, ceoSigner: true, process: { env: environment }, Buffer, getPublicKey,
    daemonBuzzSigner: Reflect.get(SignerRoute, "daemonBuzzSigner"), canonicalJson,
    currentCeo: () => request.route, routeDb: { close: vi.fn() }, run,
    check: (ok: boolean, message: string) => { if (!ok) throw new Error(message); },
    json: (_binary: string, args: string[]) => args[1] === "members" ? members.map(m => ({ ...m })) : room,
  }, { timeout: 1000 });
  expect(result).toEqual({ ceoBuzzSigner: { route: request.route, signer, changed: true, rosterVerified: true } });
  expect(run).toHaveBeenCalledExactlyOnceWith("buzz", ["channels", "add-member", "--channel", room.channel_id, "--pubkey", signer, "--role", "member"]);
  expect(environment.BUZZ_PRIVATE_KEY).toBe(credential);
});

it("CEO d0d06bc1: preserves an exact credential authorization refusal across the host wire", async () => {
  const refusal = { code: "mention_policy", message: "signer not registered for channel" };
  edge.error = Object.assign(new Error("child refused"), { code: 1 });
  edge.stderr = JSON.stringify({ ceoBuzzSignerFailure: { outcome: "REFUSED", ...refusal } });
  const port = new ExecFileHostProjectProvisioner("/fake/script", "/fake/home", "/fake/state");
  await expect(port.invoke("ensure-buzz", allocation)).rejects.toMatchObject({ outcome: "REFUSED", refusal });
  expect(edge.exec).toHaveBeenCalledTimes(1);
});

it("ACP1199-03: a host timeout is LOST, distinct from a known invalid response", async () => {
  edge.error = Object.assign(new Error("timeout"), { killed: true, code: "ETIMEDOUT" });
  const port = new ExecFileHostProjectProvisioner("/fake/script", "/fake/home", "/fake/state");
  await expect(port.invoke("ensure-buzz", allocation)).rejects.toMatchObject({ outcome: "LOST" });
});
