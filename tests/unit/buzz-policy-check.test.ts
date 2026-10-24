import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { BuzzCliTransport } from "../../src/buzz/buzz-adapter.ts";
import { sha256Hex } from "../../src/core/digest.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.unstubAllEnvs());

const fixture = () => {
  const root = tempDir("policy-check-cli-");
  const file = join(root, "required-mentions.json");
  const reply = join(root, "reply.json");
  const log = join(root, "checks.jsonl");
  const real = join(root, "fake-real");
  writeFileSync(file, '{"fixture":"policy bytes"}');
  writeFileSync(reply, '{}');
  writeFileSync(real, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  writeFileSync(join(root, "buzz-mention-enforce.py"), `import hashlib,json,os,sys
from pathlib import Path
root=Path(__file__).parent
args=sys.argv[1:]
assert args[0] == ${JSON.stringify(real)}
assert args[1] == '__acp_policy_check_v1__'
body=sys.stdin.read()
with (root/'checks.jsonl').open('a') as log: log.write(json.dumps({'args':args,'body':body,'key':os.environ.get('BUZZ_PRIVATE_KEY')})+'\\n')
config=json.loads((root/'reply.json').read_text())
verdict=config.get('verdict','allowed')
value={'protocol':'acp.buzz-policy-check/v1','policy_file':str((root/'required-mentions.json').resolve()),
 'policy_digest':hashlib.sha256((root/'required-mentions.json').read_bytes()).hexdigest(),
 'channel':args[args.index('--channel')+1], 'recipient':args[args.index('--mention')+1], 'signer':'a'*64,'verdict':verdict}
if verdict != 'allowed': value.update(error='mention_policy',message='signer not registered for channel',retryable=False)
value.update(config.get('overrides',{}))
print(config.get('stdout',json.dumps(value)))
sys.exit(config.get('code',{'allowed':0,'refused':1,'undeterminable':2}[verdict]))
`);
  vi.stubEnv("BUZZ_PRIVATE_KEY", "fixture-credential");
  const transport = new BuzzCliTransport(real, null, file);
  vi.stubEnv("BUZZ_PRIVATE_KEY", "replacement-fixture-credential");
  return { file, reply, log, transport };
};

it.each(["allowed", "refused", "undeterminable"] as const)("wrapper check protocol: %s is distinct and never calls send", async verdict => {
  const f = fixture(); writeFileSync(f.reply, JSON.stringify({ verdict }));
  const send = vi.spyOn(f.transport, "send");
  const result = await f.transport.policyReadiness("exact-room", "notification\nbody", "ceo-key", "a".repeat(64));
  expect(result).toMatchObject({ verdict, policyDigest: sha256Hex(readFileSync(f.file)), signer: "a".repeat(64), recipient: "ceo-key" });
  const calls = readFileSync(f.log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ body: "notification\nbody", key: "fixture-credential" });
  expect(calls[0].args).not.toContain("send"); expect(send).not.toHaveBeenCalled();
});

it.each([
  { overrides: { protocol: "wrong" } }, { overrides: { policy_file: "/another/policy" } },
  { overrides: { channel: "other-room" } }, { overrides: { recipient: "other-recipient" } },
  { overrides: { signer: "b".repeat(64) } }, { overrides: { policy_digest: null } },
  { overrides: { policy_digest: "not-a-digest" } }, { code: 1 },
  { stdout: "not-json" }, { stdout: '{}\n{}' },
  { verdict: "refused", code: 0 }, { verdict: "undeterminable", code: 0 },
])("wrapper check protocol: malformed/mismatched evidence stays undeterminable (%j)", async reply => {
  const f = fixture(); writeFileSync(f.reply, JSON.stringify(reply));
  expect((await f.transport.policyReadiness("exact-room", "body", "ceo-key", "a".repeat(64))).verdict).toBe("undeterminable");
});

it("wrapper check protocol: unavailable configuration or checker fails closed", async () => {
  const root = tempDir("policy-check-missing-"); const file = join(root, "required-mentions.json");
  writeFileSync(file, "policy");
  for (const policyFile of ["", "relative-policy", join(root, "missing.json"), file]) {
    const transport = new BuzzCliTransport("unused-real", null, policyFile);
    expect((await transport.policyReadiness("room", "body", "ceo", "a".repeat(64))).verdict).toBe("undeterminable");
  }
});
