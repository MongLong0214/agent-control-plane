import { cpSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { BuzzCliTransport } from "../../src/buzz/buzz-adapter.ts";
import { sha256Hex } from "../../src/core/digest.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { stableFixtureLink } from "../helpers/stable-fixture-executable.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.unstubAllEnvs());

const fixture = () => {
  const root = tempDir("policy-check-cli-");
  const file = join(root, "policy-link.json");
  const canonicalFile = join(root, "required-mentions.json");
  const reply = join(root, "reply.json");
  const log = join(root, "checks.jsonl");
  const real = join(root, "buzz");
  writeFileSync(canonicalFile, '{"fixture":"policy bytes"}');
  symlinkSync(canonicalFile, file);
  writeFileSync(reply, '{}');
  stableFixtureLink(real, '#!/bin/sh\nexec python3 -B "$(dirname "$0")/buzz-mention-enforce.py" "$0" "$@"\n');
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
  return { file, reply, log, transport, binary: real };
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


it("ACP1202 runtime binding: a well-formed but different reported digest fails closed with both identities", async () => {
  const f = fixture(); const reported = "b".repeat(64);
  writeFileSync(f.reply, JSON.stringify({ overrides: { policy_digest: reported } }));
  expect(await f.transport.policyReadiness("exact-room", "body", "ceo-key", "a".repeat(64))).toMatchObject({
    verdict: "undeterminable", policyIdentity: {
      configured: { file: realpathSync(f.file), digest: sha256Hex(readFileSync(f.file)) },
      reported: { file: realpathSync(f.file), digest: reported },
    },
  });
});


it("ACP1202 runtime binding: compares resolved policy paths without guessing another copy", async () => {
  const f = fixture(); const alias = join(f.file, "..", "policy-alias.json"); symlinkSync(f.file, alias);
  const transport = new BuzzCliTransport(f.binary, null, alias);
  expect(await transport.policyReadiness("exact-room", "body", "ceo-key", "a".repeat(64))).toMatchObject({
    verdict: "allowed", policyIdentity: { configured: { file: realpathSync(f.file) }, reported: { file: realpathSync(f.file) } },
  });
  writeFileSync(f.reply, JSON.stringify({ overrides: { policy_file: "/another/copy.json" } }));
  expect(await transport.policyReadiness("exact-room", "body", "ceo-key", "a".repeat(64))).toMatchObject({
    verdict: "undeterminable", policyIdentity: { configured: { file: realpathSync(f.file) }, reported: { file: "/another/copy.json" } },
  });
});


it("ACP1202 runtime binding: checks the sending executable, never a wrapper beside a policy copy", async () => {
  const f = fixture(); const copy = tempDir("policy-copy-"); const file = join(copy, "required-mentions.json");
  writeFileSync(file, readFileSync(f.file)); cpSync(f.reply, join(copy, "reply.json"));
  cpSync(join(f.file, "..", "buzz-mention-enforce.py"), join(copy, "buzz-mention-enforce.py"));
  const transport = new BuzzCliTransport(f.binary, null, file);
  expect(await transport.policyReadiness("exact-room", "body", "ceo-key", "a".repeat(64))).toMatchObject({
    verdict: "undeterminable", policyIdentity: { configured: { file: realpathSync(file) }, reported: { file: realpathSync(f.file) } },
  });
  expect(readFileSync(f.log, "utf8").trim().split("\n")).toHaveLength(1);
});

it.each(["different file", "different digest"] as const)(
  "ACP1202 path normalization: a same-file alias never excuses a %s", async difference => {
    const f = fixture();
    const alias = join(f.file, "..", "another-alias.json"); symlinkSync(f.file, alias);
    const transport = new BuzzCliTransport(f.binary, null, alias);
    const send = vi.spyOn(transport, "send");
    const configured = { file: realpathSync(f.file), digest: sha256Hex(readFileSync(f.file)) };
    expect((await transport.policyReadiness("exact-room", "body", "ceo-key", "a".repeat(64))).verdict).toBe("allowed");
    const copy = join(f.file, "..", "equal-bytes-different-file.json"); writeFileSync(copy, readFileSync(f.file));
    expect(realpathSync(copy)).not.toBe(configured.file);
    expect(sha256Hex(readFileSync(copy))).toBe(configured.digest);
    const reported = difference === "different file"
      ? { file: realpathSync(copy), digest: configured.digest } : { file: configured.file, digest: "b".repeat(64) };
    writeFileSync(f.reply, JSON.stringify({ overrides: { policy_file: reported.file, policy_digest: reported.digest } }));
    expect(await transport.policyReadiness("exact-room", "body", "ceo-key", "a".repeat(64))).toMatchObject({
      verdict: "undeterminable", policyIdentity: { configured, reported },
    });
    expect(send).not.toHaveBeenCalled();
    expect(readFileSync(f.log, "utf8").trim().split("\n")).toHaveLength(2);
  },
);


it.each(["ROSTER_STATE", "POLICY", "CREDENTIAL", "AUTHORITY", "UNKNOWN", undefined, "not-a-cause", { retryable: true }].flatMap(cause => ["refused", "undeterminable"].map(verdict => ({ cause, verdict }))))(
  "ACP1202-R2-01: wrapper cause is explicit, never inferred from a fixed message (%j)", async ({ cause, verdict }) => {
    const f = fixture(); writeFileSync(f.reply, JSON.stringify({ verdict, overrides: { cause, message: "current roster does not match expected pair" } }));
    expect(await f.transport.policyReadiness("exact-room", "body", "ceo-key", "a".repeat(64))).toMatchObject({
      verdict, cause: typeof cause === "string" && ["ROSTER_STATE", "POLICY", "CREDENTIAL", "AUTHORITY", "UNKNOWN"].includes(cause) ? cause : "UNKNOWN",
    });
  },
);


it.each([{ signer: "b".repeat(64) }, { recipient: "another-ceo" }])("ACP1202-R2-01: a roster cause for another identity is not re-validatable (%j)", async overrides => {
  const f = fixture(); writeFileSync(f.reply, JSON.stringify({ verdict: "refused", overrides: { ...overrides, cause: "ROSTER_STATE" } }));
  expect(await f.transport.policyReadiness("exact-room", "body", "ceo-key", "a".repeat(64))).toMatchObject({ verdict: "refused", cause: "UNKNOWN" });
});
