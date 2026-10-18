import { generateKeyPairSync, verify } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { type Decision, allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { GITHUB_API_RESPONSE_LIMIT_BYTES, TrustedCredentialStore } from "../../src/github/credential-store.ts";
import { GitHubAppClient } from "../../src/github/github-kernel.ts";
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

/** The narrowed target shape from #575: drops merge_queues and statuses, adds nothing. */
const narrowedAppPermissions = {
  checks: "write",
  contents: "write",
  issues: "write",
  metadata: "read",
  pull_requests: "write",
};

const storeWithPermissions = (
  files: ReturnType<typeof makeAppFiles>,
  permissions: Record<string, string>,
): TrustedCredentialStore => {
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = requestUrl(input);
    if (url.endsWith("/app")) {
      return new Response(JSON.stringify({ slug: "acp-production-gate", permissions }), { status: 200 });
    }
    if (url.includes("/access_tokens")) {
      return new Response(JSON.stringify({
        token: "installation-token-permission-shape",
        expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      }), { status: 201 });
    }
    if (url.endsWith("/user")) return new Response(JSON.stringify({ login: "app[bot]" }), { status: 200 });
    throw new Error(`unexpected request: ${url}`);
  };
  return new TrustedCredentialStore(join(files.root, "secrets"), { appEnvFile: files.envFile, fetch });
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

  it("refuses an oversized API response instead of buffering it", async () => {
    const files = makeAppFiles();
    // One byte over the limit, delivered in chunks. The finalizer calls this transport
    // unattended, so an endpoint that streams without end must be cut off rather than
    // buffered until the daemon dies.
    const chunk = new Uint8Array(1024 * 1024);
    const atLimit = Math.ceil(GITHUB_API_RESPONSE_LIMIT_BYTES / chunk.byteLength);
    // Three times the limit, so "stopped at the boundary" and "drained the stream" are far
    // apart and the assertion cannot pass by accident.
    const chunksNeeded = atLimit * 3;
    let pushed = 0;

    const fetch: typeof globalThis.fetch = async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/app")) {
        return new Response(JSON.stringify({ slug: "acp-production-gate", permissions: appPermissions }), { status: 200 });
      }
      if (url.includes("/access_tokens")) {
        return new Response(JSON.stringify({
          token: "installation-token-oversized",
          expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
        }), { status: 201 });
      }
      // Deliberately declares no content-length, so the refusal has to come from counting
      // bytes as they arrive rather than from trusting a header.
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (pushed >= chunksNeeded) return controller.close();
            pushed += 1;
            controller.enqueue(chunk);
          },
        }),
        { status: 200 },
      );
    };

    const store = new TrustedCredentialStore(join(files.root, "secrets"), {
      appEnvFile: files.envFile,
      fetch,
    });

    const result = await store.githubApi({ method: "GET", path: "/user" });
    if (result.allowed) throw new Error("expected an oversized response to be refused");
    expect(result.reasonCode).toBe(ReasonCode.PROBE_FAILED);
    expect(result.evidence).toMatchObject({ limit: GITHUB_API_RESPONSE_LIMIT_BYTES });
    // Stopped at the boundary rather than draining the stream: the refusal is what bounds
    // the memory, so a version that read everything and then measured would fail here even
    // though it returned the same reason code.
    // Bounded near the limit, not at the stream's length. A couple of chunks beyond the
    // boundary are the stream's own read-ahead, not bytes the transport accepted.
    expect(pushed * chunk.byteLength).toBeLessThan(GITHUB_API_RESPONSE_LIMIT_BYTES * 2);
    expect(pushed).toBeLessThan(chunksNeeded);
  });

  it("returns a response that sits just inside the limit", async () => {
    const files = makeAppFiles();
    const body = "x".repeat(1024);
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/app")) {
        return new Response(JSON.stringify({ slug: "acp-production-gate", permissions: appPermissions }), { status: 200 });
      }
      if (url.includes("/access_tokens")) {
        return new Response(JSON.stringify({
          token: "installation-token-small",
          expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
        }), { status: 201 });
      }
      return new Response(body, { status: 200 });
    };
    const store = new TrustedCredentialStore(join(files.root, "secrets"), {
      appEnvFile: files.envFile,
      fetch,
    });

    const result = await store.githubApi({ method: "GET", path: "/user" });
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.value.body).toBe(body);
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

  it("accepts the currently deployed 7-permission grant shape", async () => {
    const files = makeAppFiles();
    const store = storeWithPermissions(files, appPermissions);

    const result = await store.githubApi({ method: "GET", path: "/user" });
    expect(result.allowed).toBe(true);
  });

  it("accepts the narrowed post-575 target grant shape with merge_queues and statuses dropped", async () => {
    const files = makeAppFiles();
    const store = storeWithPermissions(files, narrowedAppPermissions);

    const result = await store.githubApi({ method: "GET", path: "/user" });
    expect(result.allowed).toBe(true);
  });

  it("refuses the narrowed grant shape plus one extra permission — a superset is never accepted", async () => {
    const files = makeAppFiles();
    const store = storeWithPermissions(files, { ...narrowedAppPermissions, discussions: "write" });

    const result = await store.githubApi({ method: "GET", path: "/user" });
    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.GITHUB_APP_PERMISSION_DENIED);
  });

  it("refuses a grant shape with the right keys but one level downgraded", async () => {
    const files = makeAppFiles();
    const store = storeWithPermissions(files, { ...narrowedAppPermissions, contents: "read" });

    const result = await store.githubApi({ method: "GET", path: "/user" });
    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.GITHUB_APP_PERMISSION_DENIED);
  });

  it("refuses a grant shape missing one key", async () => {
    const files = makeAppFiles();
    const { metadata: _dropped, ...withoutMetadata } = narrowedAppPermissions;
    const store = storeWithPermissions(files, withoutMetadata);

    const result = await store.githubApi({ method: "GET", path: "/user" });
    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.GITHUB_APP_PERMISSION_DENIED);
  });

  it("names every approved shape in the refusal message rather than only saying the match failed", async () => {
    const files = makeAppFiles();
    const store = storeWithPermissions(files, { ...narrowedAppPermissions, discussions: "write" });

    const result = await store.githubApi({ method: "GET", path: "/user" });
    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    // Both approved shapes must be nameable from the message. The deployed 7-permission
    // grant has a permission only it carries; the narrowed target does not, because its
    // keys are a strict subset of the deployed one's. So the narrowed shape is identified
    // by its whole rendering — which is the thing an operator actually has to reproduce in
    // GitHub settings, and which a message naming only the deployed shape cannot supply.
    expect(result.message).toContain("merge_queues:write");
    expect(result.message).toContain(
      "{checks:write, contents:write, issues:write, metadata:read, pull_requests:write}",
    );
  });
});

/**
 * FD-R2 — the transport runs the caller's `beforeDispatch` once it holds the installation token (its
 * last await) and immediately before it sends; a refusal or a throw sends nothing. The App's own token
 * exchange (GET /app, POST access_tokens) is authentication and comes before the check by design.
 * `log` records every HTTP request the store makes and every run of the check, in order.
 */
describe("FD-R2 GitHub App transport: the check before dispatch", () => {
  const PUT = { method: "PUT" as const, path: "/repos/o/r/pulls/7/merge", input: JSON.stringify({ sha: "a".repeat(40) }) };

  const transport = (apiStatus = 200) => {
    const files = makeAppFiles();
    let now = Date.parse("2026-08-14T00:00:00.000Z");
    const log: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(requestUrl(input));
      log.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname === "/app") {
        return new Response(JSON.stringify({ slug: "acp-production-gate", permissions: appPermissions }), { status: 200 });
      }
      if (url.pathname.endsWith("/access_tokens")) {
        return new Response(JSON.stringify({
          token: "installation-token-fd-r2",
          expires_at: new Date(now + 60 * 60 * 1_000).toISOString(),
        }), { status: 201 });
      }
      return new Response(JSON.stringify({ merged: true, sha: "b".repeat(40) }), { status: apiStatus });
    };
    const store = new TrustedCredentialStore(join(files.root, "secrets"), { appEnvFile: files.envFile, fetch, now: () => now });
    return {
      store,
      log,
      /** The cached token expires, so the next request refreshes it first. */
      expireToken: () => {
        now += 2 * 60 * 60 * 1_000;
      },
      check: (decision: () => Decision<void>) => (): Decision<void> => {
        log.push("check");
        return decision();
      },
    };
  };
  const allowed = (): Decision<void> => allow(ReasonCode.OK, undefined);
  const refused = (): Decision<void> => deny(ReasonCode.HUMAN_GATE_UNSATISFIED, "the binding changed", { expectedDigest: null });

  it("FD-R2 transport: the check runs after the token refresh completes and right before the one dispatch", async () => {
    const { store, log, check } = transport();
    const result = await store.githubApi({ ...PUT, beforeDispatch: check(allowed) });
    expect(result.allowed).toBe(true);
    expect(log).toEqual(["GET /app", "POST /app/installations/153553922/access_tokens", "check", `PUT ${PUT.path}`]);
  });

  it("FD-R2 transport: on a cached token the check still runs, right before the dispatch", async () => {
    const { store, log, check } = transport();
    expect((await store.authenticate()).allowed).toBe(true);
    log.length = 0;
    expect((await store.githubApi({ ...PUT, beforeDispatch: check(allowed) })).allowed).toBe(true);
    expect(log).toEqual(["check", `PUT ${PUT.path}`]);
  });

  it.each([
    ["refuses", refused, ReasonCode.HUMAN_GATE_UNSATISFIED],
    ["throws", (): Decision<void> => {
      throw new Error("the check failed");
    }, ReasonCode.INTERNAL_ERROR],
  ] as const)("FD-R2 transport: a check that %s after a token refresh sends nothing", async (_how, decision, reasonCode) => {
    const { store, log, check, expireToken } = transport();
    expect((await store.authenticate()).allowed).toBe(true);
    expireToken();
    log.length = 0;
    const result = await store.githubApi({ ...PUT, beforeDispatch: check(decision) });
    expect(result).toMatchObject({ allowed: false, reasonCode });
    // The token was refreshed first; the request itself never left.
    expect(log).toEqual(["GET /app", "POST /app/installations/153553922/access_tokens", "check"]);
  });

  it("FD-R2 transport: GitHubAppClient forwards the check; a refusal rejects with its reason and nothing is sent", async () => {
    const { store, log, check } = transport();
    const client = new GitHubAppClient(store);
    await expect(client.request("PUT", PUT.path, { sha: "a".repeat(40) }, { beforeDispatch: check(refused) }))
      .rejects.toMatchObject({ reasonCode: ReasonCode.HUMAN_GATE_UNSATISFIED, evidence: { expectedDigest: null } });
    expect(log.filter((entry) => entry === `PUT ${PUT.path}`)).toEqual([]);
    expect(log.at(-1)).toBe("check");
  });

  it("FD-R2 transport: no re-send path; a 401 answer is returned after one check and one dispatch, with no re-authentication", async () => {
    const { store, log, check } = transport(401);
    const result = await store.githubApi({ ...PUT, beforeDispatch: check(allowed) });
    expect(result).toMatchObject({ allowed: false, evidence: { status: 401 } });
    expect(log).toEqual(["GET /app", "POST /app/installations/153553922/access_tokens", "check", `PUT ${PUT.path}`]);
  });
});
