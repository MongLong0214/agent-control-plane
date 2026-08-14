import { generateKeyPairSync, verify } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { TrustedCredentialStore } from "../../src/github/credential-store.ts";
import { runtimeEnvironment } from "../../src/runtime/cli-adapters.ts";

/** This file owns its temporary directories so its cleanup cannot race another suite's fixtures. */
const ownedTempDirs: string[] = [];
const credentialTempDir = (prefix: string): string => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  ownedTempDirs.push(directory);
  return directory;
};

afterAll(() => {
  for (const directory of ownedTempDirs) rmSync(directory, { recursive: true, force: true });
});

const appPermissions = {
  checks: "write",
  contents: "write",
  issues: "write",
  merge_queues: "write",
  metadata: "read",
  pull_requests: "write",
  statuses: "write",
};

const makeAppFiles = (options: { appId?: string; installationId?: string } = {}) => {
  const root = credentialTempDir("acp-github-app-");
  const credentials = join(root, "credentials");
  mkdirSync(credentials, { mode: 0o700 });
  chmodSync(credentials, 0o700);
  const envFile = join(credentials, "github-app.env");
  const privateKeyPath = join(credentials, "github-app.private-key.pem");
  const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(privateKeyPath, keyPair.privateKey.export({ type: "pkcs1", format: "pem" }), { mode: 0o600 });
  writeFileSync(
    envFile,
    [
      `GITHUB_APP_ID=${options.appId ?? "4586878"}`,
      `GITHUB_APP_INSTALLATION_ID=${options.installationId ?? "153553922"}`,
      `GITHUB_APP_PRIVATE_KEY_PATH=${privateKeyPath}`,
    ].join("\n"),
    { mode: 0o600 },
  );
  chmodSync(envFile, 0o600);
  chmodSync(privateKeyPath, 0o600);
  return { root, envFile, privateKeyPath, publicKey: keyPair.publicKey };
};

const requestUrl = (input: string | URL | Request): string =>
  typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

const authorization = (init: RequestInit | undefined): string | null =>
  new Headers(init?.headers).get("Authorization");

const deniedReadFile = (blockedPath: string): typeof readFileSync =>
  ((...args: Parameters<typeof readFileSync>) => {
    if (args[0] === blockedPath) {
      const error = new Error("permission denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    }
    return readFileSync(...args);
  }) as typeof readFileSync;

describe("GitHub App credential store", () => {
  it("mints in process, records the App-reported slug, and refreshes before and after expiry", async () => {
    const files = makeAppFiles();
    const base = Date.parse("2026-08-14T00:00:00.000Z");
    let now = base;
    let exchanges = 0;
    const requests: Array<{ url: string; authorization: string | null }> = [];
    let jwtVerified = false;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = requestUrl(input);
      const auth = authorization(init);
      requests.push({ url, authorization: auth });
      if (url.endsWith("/app")) {
        const jwt = auth?.replace(/^Bearer\s+/, "") ?? "";
        const [header, payload, signature] = jwt.split(".");
        jwtVerified = Boolean(
          header &&
          payload &&
          signature &&
          verify(
            "RSA-SHA256",
            Buffer.from(`${header}.${payload}`),
            files.publicKey,
            Buffer.from(signature, "base64url"),
          ),
        );
        return new Response(JSON.stringify({ slug: "acp-production-gate", permissions: appPermissions }), { status: 200 });
      }
      if (url.includes("/access_tokens")) {
        exchanges += 1;
        return new Response(JSON.stringify({
          token: `installation-token-${exchanges}`,
          expires_at: new Date(now + 60 * 60 * 1_000).toISOString(),
        }), { status: 201 });
      }
      if (url.endsWith("/user")) return new Response(JSON.stringify({ login: "app[bot]" }), { status: 200 });
      throw new Error(`unexpected request: ${url}`);
    };
    const store = new TrustedCredentialStore(join(files.root, "secrets"), {
      appEnvFile: files.envFile,
      fetch,
      now: () => now,
    });

    expect(store.creatorIdentity()).toBeNull();
    const first = await store.githubApi({ method: "GET", path: "/user" });
    expect(first).toMatchObject({ allowed: true, reasonCode: ReasonCode.OK });
    expect(jwtVerified).toBe(true);
    expect(store.creatorIdentity()).toBe("acp-production-gate");
    expect(exchanges).toBe(1);
    expect(JSON.stringify(first)).not.toContain("installation-token-1");

    // Four minutes remain: this must refresh before GitHub reaches the actual expiry.
    now = base + 56 * 60 * 1_000;
    const refreshBeforeExpiry = await store.githubApi({ method: "GET", path: "/user" });
    expect(refreshBeforeExpiry.allowed).toBe(true);
    expect(exchanges).toBe(2);

    // The second token is now past its expiry. This assertion fails if either expiry
    // checking or pre-expiry refresh is removed from the store.
    now = base + 117 * 60 * 1_000;
    const refreshAfterExpiry = await store.githubApi({ method: "GET", path: "/user" });
    expect(refreshAfterExpiry.allowed).toBe(true);
    expect(exchanges).toBe(3);
    expect(requests.filter((request) => request.url.endsWith("/app"))).toHaveLength(3);
    expect(requests.every((request) => request.url.startsWith("https://api.github.com/"))).toBe(true);
  });

  it("fails closed with file-specific reasons and does not fall back to GH_TOKEN", async () => {
    const root = credentialTempDir("acp-github-app-missing-");
    const previous = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "must-never-be-used";
    try {
      const missing = new TrustedCredentialStore(join(root, "secrets"), {
        appEnvFile: join(root, "credentials", "github-app.env"),
      });
      expect(missing.availability().reasonCode).toBe(ReasonCode.GITHUB_APP_ENV_FILE_MISSING);
      expect((await missing.githubApi({ method: "GET", path: "/user" })).reasonCode)
        .toBe(ReasonCode.GITHUB_APP_ENV_FILE_MISSING);
    } finally {
      if (previous === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previous;
    }

    const insecure = makeAppFiles();
    chmodSync(insecure.privateKeyPath, 0o640);
    const store = new TrustedCredentialStore(join(insecure.root, "secrets"), { appEnvFile: insecure.envFile });
    expect(store.availability().reasonCode).toBe(ReasonCode.GITHUB_APP_PRIVATE_KEY_INSECURE);

    const insecureEnv = makeAppFiles();
    chmodSync(insecureEnv.envFile, 0o640);
    const envStore = new TrustedCredentialStore(join(insecureEnv.root, "secrets"), { appEnvFile: insecureEnv.envFile });
    expect(envStore.availability().reasonCode).toBe(ReasonCode.GITHUB_APP_ENV_FILE_INSECURE);

    const missingKey = makeAppFiles();
    unlinkSync(missingKey.privateKeyPath);
    const missingKeyStore = new TrustedCredentialStore(join(missingKey.root, "secrets"), {
      appEnvFile: missingKey.envFile,
    });
    expect(missingKeyStore.availability().reasonCode).toBe(ReasonCode.GITHUB_APP_PRIVATE_KEY_MISSING);

    const unreadableKey = makeAppFiles();
    const unreadableKeyStore = new TrustedCredentialStore(join(unreadableKey.root, "secrets"), {
      appEnvFile: unreadableKey.envFile,
      readFile: deniedReadFile(unreadableKey.privateKeyPath),
    });
    expect(unreadableKeyStore.availability().reasonCode).toBe(ReasonCode.GITHUB_APP_PRIVATE_KEY_UNREADABLE);

    const unreadableEnv = makeAppFiles();
    const unreadableEnvStore = new TrustedCredentialStore(join(unreadableEnv.root, "secrets"), {
      appEnvFile: unreadableEnv.envFile,
      readFile: deniedReadFile(unreadableEnv.envFile),
    });
    expect(unreadableEnvStore.availability().reasonCode).toBe(ReasonCode.GITHUB_APP_ENV_FILE_UNREADABLE);
  });

  it("withholds App credential paths from an allowlisted agent child environment", () => {
    const previous = process.env.ACP_GITHUB_APP_PRIVATE_KEY_PATH;
    process.env.ACP_GITHUB_APP_PRIVATE_KEY_PATH = "/daemon-only/github-app.private-key.pem";
    try {
      const environment = runtimeEnvironment(["ACP_GITHUB_APP_PRIVATE_KEY_PATH"], credentialTempDir("acp-agent-env-"));
      expect(environment.ACP_GITHUB_APP_PRIVATE_KEY_PATH).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.ACP_GITHUB_APP_PRIVATE_KEY_PATH;
      else process.env.ACP_GITHUB_APP_PRIVATE_KEY_PATH = previous;
    }
  });

  it("refuses a failed installation-token exchange without exposing its response", async () => {
    const files = makeAppFiles();
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/app")) {
        return new Response(JSON.stringify({ slug: "acp-production-gate", permissions: appPermissions }), { status: 200 });
      }
      if (url.includes("/access_tokens")) {
        return new Response(JSON.stringify({ message: "installation token rejected" }), { status: 401 });
      }
      throw new Error(`unexpected request: ${url}`);
    };
    const store = new TrustedCredentialStore(join(files.root, "secrets"), { appEnvFile: files.envFile, fetch });

    const result = await store.githubApi({ method: "GET", path: "/user" });
    if (result.allowed) throw new Error("expected token exchange refusal");
    expect(result.reasonCode).toBe(ReasonCode.GITHUB_APP_TOKEN_EXCHANGE_FAILED);
    expect(result.message).toContain("installation-token exchange failed");
    expect(JSON.stringify(result)).not.toContain("installation token rejected");
  });

  it("requires every owner-approved merge permission and rejects a broader App", async () => {
    const files = makeAppFiles();
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/app")) {
        return new Response(JSON.stringify({
          slug: "acp-production-gate",
          permissions: { ...appPermissions, pull_requests: "read" },
        }), { status: 200 });
      }
      throw new Error(`installation exchange must not run after rejected permissions: ${url}`);
    };
    const store = new TrustedCredentialStore(join(files.root, "secrets"), { appEnvFile: files.envFile, fetch });

    const result = await store.githubApi({ method: "GET", path: "/user" });
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.GITHUB_APP_PERMISSION_DENIED);
  });
});
