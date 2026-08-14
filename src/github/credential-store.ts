import { createHash, createPrivateKey, sign, type KeyObject } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { ensurePrivateDirectory, inspectPrivatePath } from "../db/state-preflight.ts";

/**
 * Fixture-only compatibility shape. `token` is deliberately never persisted or used to
 * authenticate a request: production authentication is exclusively a GitHub App JWT
 * exchange. Existing kernel fixtures need only a creator identity because they supply a
 * modelled GitHub client.
 */
export interface TrustedCredential {
  token: string;
  creatorIdentity: string;
}

export interface GitHubAppCredentialOptions {
  /** Absolute path to the owner-provisioned GitHub App environment file. */
  appEnvFile?: string;
  /** Explicit launcher override for the key path declared in the environment file. */
  privateKeyPath?: string;
  /** Test seam for a GitHub Enterprise endpoint; production uses GitHub's REST API. */
  apiBaseUrl?: string;
  /** Test seam for direct credential-file read failures. */
  readFile?: typeof readFileSync;
  /** Test seam. The daemon always uses the process-local Fetch implementation. */
  fetch?: typeof globalThis.fetch;
  /** Test seam for expiry behaviour. */
  now?: () => number;
  /** Refresh before this much token lifetime remains. Defaults to five minutes. */
  refreshBeforeExpiryMs?: number;
}

interface GitHubAppConfiguration {
  appId: string;
  installationId: string;
  privateKeyPath: string;
  key: KeyObject;
  keyFingerprint: string;
}

interface CachedInstallationToken {
  token: string;
  expiresAtMs: number;
  appId: string;
  installationId: string;
  keyFingerprint: string;
  creatorIdentity: string;
}

interface CachedCreatorIdentity {
  creatorIdentity: string;
  appId: string;
  installationId: string;
  keyFingerprint: string;
}

interface AppIdentityResponse {
  slug?: unknown;
  permissions?: unknown;
}

interface InstallationTokenResponse {
  token?: unknown;
  expires_at?: unknown;
}

interface GitHubApiResult {
  body: string;
  status: number;
}

const GITHUB_API_BASE_URL = "https://api.github.com";
const DEFAULT_REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * The owner-approved production grant. Keep this exact rather than accepting a superset:
 * adding a new capability to the App must be a deliberate deployment review, never a
 * silent broadening of the daemon's merge authority.
 */
const REQUIRED_APP_PERMISSIONS: Readonly<Record<string, "read" | "write">> = {
  checks: "write",
  contents: "write",
  issues: "write",
  merge_queues: "write",
  metadata: "read",
  pull_requests: "write",
  statuses: "write",
};

const asObject = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const parseJson = (body: string): Record<string, unknown> | null => {
  try {
    return asObject(JSON.parse(body));
  } catch {
    return null;
  }
};

const base64url = (value: string | Buffer): string => Buffer.from(value).toString("base64url");

const hasExactPermissions = (permissions: Record<string, unknown> | null): boolean => {
  if (!permissions) return false;
  const expected = Object.entries(REQUIRED_APP_PERMISSIONS);
  return (
    Object.keys(permissions).length === expected.length &&
    expected.every(([name, level]) => permissions[name] === level)
  );
};

/** Parse only assignments; executing a deployment env file would make it a code-input surface. */
const parseEnvironmentFile = (contents: string): Map<string, string> => {
  const values = new Map<string, string>();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    let value = match[2]!.trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
};

/**
 * CP-HI-05 — the daemon-local GitHub App authority.
 *
 * The private key is read, parsed and used only in this process. A short-lived App JWT
 * is exchanged in-process for an installation token, which is held only in memory until
 * shortly before its GitHub-provided expiry. Neither secret is returned to a caller,
 * written to disk, added to audit evidence, or placed in a child environment.
 */
export class TrustedCredentialStore {
  readonly #directory: string;
  readonly #appEnvFile: string;
  readonly #privateKeyPathOverride: string | undefined;
  readonly #apiBaseUrl: string;
  readonly #readFile: typeof readFileSync;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #refreshBeforeExpiryMs: number;
  #cachedToken: CachedInstallationToken | null = null;
  #creator: CachedCreatorIdentity | null = null;
  #refreshing: {
    configuration: Pick<GitHubAppConfiguration, "appId" | "installationId" | "keyFingerprint">;
    promise: Promise<Decision<CachedInstallationToken>>;
  } | null = null;
  #fixtureIdentity: string | null = null;

  constructor(
    directory: string,
    options: GitHubAppCredentialOptions = {},
  ) {
    this.#directory = directory;
    this.#appEnvFile = options.appEnvFile ?? join(dirname(directory), "credentials", "github-app.env");
    this.#privateKeyPathOverride = options.privateKeyPath;
    this.#apiBaseUrl = (options.apiBaseUrl ?? GITHUB_API_BASE_URL).replace(/\/$/, "");
    this.#readFile = options.readFile ?? readFileSync;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? Date.now;
    this.#refreshBeforeExpiryMs = options.refreshBeforeExpiryMs ?? DEFAULT_REFRESH_BEFORE_EXPIRY_MS;
  }

  /**
   * Fixtures using an injected `GitHubClient` have no live authority transport. Preserve
   * that narrow setup hook without reviving a static token store: the supplied token is
   * ignored and never reaches `githubApi`.
   */
  install(credential: TrustedCredential): void {
    ensurePrivateDirectory(this.#directory);
    const identity = credential.creatorIdentity.trim();
    if (!identity) throw new Error("fixture trusted creator identity is required");
    this.#fixtureIdentity = identity;
  }

  /** True only when the App env file and private key are usable by this daemon process. */
  available(): boolean {
    return this.availability().allowed;
  }

  /** A safe, reasoned readiness check for callers that must fail closed before a write. */
  availability(): Decision<void> {
    if (this.#fixtureIdentity) return this.#fixtureMetadataOk();
    const loaded = this.#loadConfiguration();
    return loaded.allowed
      ? allow(ReasonCode.OK, undefined)
      : loaded as Decision<void>;
  }

  /**
   * Proves that this process can authenticate as the installed App without exposing the
   * resulting installation token. Write paths call this before reserving an irreversible
   * GitHub operation so token-exchange and permission failures retain their exact reason.
   */
  async authenticate(): Promise<Decision<void>> {
    if (this.#fixtureIdentity) return this.#fixtureMetadataOk();
    const token = await this.#installationToken();
    return token.allowed
      ? allow(ReasonCode.OK, undefined)
      : token as Decision<void>;
  }

  /**
   * The identity is populated from the App-authenticated `GET /app` response, not an
   * operator-configured slug. It is safe to expose and is revalidated against the current
   * credential files before use.
   */
  creatorIdentity(): string | null {
    if (this.#fixtureIdentity) {
      return this.#fixtureMetadataOk().allowed ? this.#fixtureIdentity : null;
    }
    const configuration = this.#loadConfiguration();
    if (!configuration.allowed || !this.#creator) return null;
    return this.#matchesConfiguration(this.#creator, configuration.value)
      ? this.#creator.creatorIdentity
      : null;
  }

  /**
   * The sole GitHub transport entrypoint. It obtains an installation token internally and
   * sends the HTTPS request in the daemon process; callers receive only response bytes.
   */
  async githubApi(options: {
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    path: string;
    input?: string;
  }): Promise<Decision<GitHubApiResult>> {
    const token = await this.#installationToken();
    if (!token.allowed) return token as Decision<GitHubApiResult>;

    return this.#request({
      method: options.method,
      path: options.path,
      authorization: `Bearer ${token.value.token}`,
      ...(options.input === undefined ? {} : { input: options.input }),
      failureCode: ReasonCode.PROBE_FAILED,
      failureMessage: "GitHub App API request failed",
    });
  }

  /** Permission audit for the doctor: both credential files remain direct, private files. */
  permissionsOk(): boolean {
    return this.availability().allowed;
  }

  /** Safe paths that every non-daemon child must be denied from reading. */
  sensitivePaths(): string[] {
    const configuredKeyPath = this.#privateKeyPathOverride ?? this.#keyPathFromEnvironmentFile();
    return [...new Set([this.#appEnvFile, ...(configuredKeyPath ? [configuredKeyPath] : [])])];
  }

  #fixtureMetadataOk(): Decision<void> {
    const directory = inspectPrivatePath(this.#directory, "directory");
    return directory.secure
      ? allow(ReasonCode.OK, undefined)
      : deny(
        ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED,
        "fixture credential directory is not a daemon-owned private directory",
        { directory: this.#directory },
      );
  }

  async #installationToken(): Promise<Decision<CachedInstallationToken>> {
    if (this.#fixtureIdentity) {
      const metadata = this.#fixtureMetadataOk();
      if (!metadata.allowed) return metadata as Decision<CachedInstallationToken>;
      return deny(
        ReasonCode.TRUSTED_CREDENTIAL_UNAVAILABLE,
        "fixture credential has no live GitHub App transport",
        {},
      );
    }
    const configuration = this.#loadConfiguration();
    if (!configuration.allowed) return configuration as Decision<CachedInstallationToken>;
    const current = this.#cachedToken;
    if (current && this.#matchesConfiguration(current, configuration.value) && this.#tokenIsFresh(current)) {
      return allow(ReasonCode.OK, current);
    }

    // One refresh per process prevents concurrent finalizers from creating a small storm of
    // App JWT exchanges. A failed refresh is not masked by a near-expired cached token.
    if (this.#refreshing && this.#matchesConfiguration(this.#refreshing.configuration, configuration.value)) {
      return this.#refreshing.promise;
    }
    const refreshing = this.#mintInstallationToken(configuration.value);
    const refresh = {
      configuration: {
        appId: configuration.value.appId,
        installationId: configuration.value.installationId,
        keyFingerprint: configuration.value.keyFingerprint,
      },
      promise: refreshing,
    };
    this.#refreshing = refresh;
    try {
      return await refreshing;
    } finally {
      if (this.#refreshing === refresh) this.#refreshing = null;
    }
  }

  async #mintInstallationToken(
    configuration: GitHubAppConfiguration,
  ): Promise<Decision<CachedInstallationToken>> {
    const jwt = this.#signAppJwt(configuration);
    if (!jwt.allowed) return jwt as Decision<CachedInstallationToken>;

    const app = await this.#request({
      method: "GET",
      path: "/app",
      authorization: `Bearer ${jwt.value}`,
      failureCode: ReasonCode.GITHUB_APP_IDENTITY_UNVERIFIED,
      failureMessage: "GitHub App identity request failed",
    });
    if (!app.allowed) return app as Decision<CachedInstallationToken>;
    const identity = this.#appIdentity(app.value.body);
    if (!identity.allowed) return identity as Decision<CachedInstallationToken>;

    const exchanged = await this.#request({
      method: "POST",
      path: `/app/installations/${configuration.installationId}/access_tokens`,
      authorization: `Bearer ${jwt.value}`,
      failureCode: ReasonCode.GITHUB_APP_TOKEN_EXCHANGE_FAILED,
      failureMessage: "GitHub App installation-token exchange failed",
    });
    if (!exchanged.allowed) return exchanged as Decision<CachedInstallationToken>;
    const parsed = parseJson(exchanged.value.body) as InstallationTokenResponse | null;
    const expiresAtMs = typeof parsed?.expires_at === "string" ? Date.parse(parsed.expires_at) : Number.NaN;
    if (
      !parsed ||
      typeof parsed.token !== "string" ||
      parsed.token.length === 0 ||
      !Number.isFinite(expiresAtMs) ||
      expiresAtMs <= this.#now()
    ) {
      return deny(
        ReasonCode.GITHUB_APP_TOKEN_EXCHANGE_FAILED,
        "GitHub App installation-token exchange returned no usable token expiry",
        {},
      );
    }

    const token: CachedInstallationToken = {
      token: parsed.token,
      expiresAtMs,
      appId: configuration.appId,
      installationId: configuration.installationId,
      keyFingerprint: configuration.keyFingerprint,
      creatorIdentity: identity.value,
    };
    this.#cachedToken = token;
    this.#creator = {
      creatorIdentity: identity.value,
      appId: configuration.appId,
      installationId: configuration.installationId,
      keyFingerprint: configuration.keyFingerprint,
    };
    return allow(ReasonCode.OK, token);
  }

  #signAppJwt(configuration: GitHubAppConfiguration): Decision<string> {
    try {
      const nowSeconds = Math.floor(this.#now() / 1_000);
      const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
      // GitHub permits an expiry no more than ten minutes ahead. Backdating iat slightly
      // tolerates small clock skew without extending the authority lifetime.
      const payload = base64url(JSON.stringify({
        iat: nowSeconds - 60,
        exp: nowSeconds + 9 * 60,
        iss: configuration.appId,
      }));
      const unsigned = `${header}.${payload}`;
      return allow(
        ReasonCode.OK,
        `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), configuration.key).toString("base64url")}`,
      );
    } catch {
      return deny(
        ReasonCode.GITHUB_APP_JWT_SIGNING_FAILED,
        "GitHub App private key could not sign an authentication JWT",
        {},
      );
    }
  }

  #appIdentity(body: string): Decision<string> {
    const parsed = parseJson(body) as AppIdentityResponse | null;
    const permissions = asObject(parsed?.permissions);
    if (!parsed || typeof parsed.slug !== "string" || parsed.slug.trim().length === 0) {
      return deny(
        ReasonCode.GITHUB_APP_IDENTITY_UNVERIFIED,
        "GitHub App identity response did not contain an App slug",
        {},
      );
    }
    if (!hasExactPermissions(permissions)) {
      return deny(
        ReasonCode.GITHUB_APP_PERMISSION_DENIED,
        "GitHub App permissions do not match the owner-approved production merge grant",
        {},
      );
    }
    return allow(ReasonCode.OK, parsed.slug.trim());
  }

  async #request(input: {
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    path: string;
    authorization: string;
    input?: string;
    failureCode: ReasonCode;
    failureMessage: string;
  }): Promise<Decision<GitHubApiResult>> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#apiBaseUrl}${input.path}`, {
        method: input.method,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          Authorization: input.authorization,
          ...(input.input === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(input.input === undefined ? {} : { body: input.input }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return deny(input.failureCode, input.failureMessage, { operation: input.method });
    }

    let body: string;
    try {
      body = await response.text();
    } catch {
      return deny(input.failureCode, input.failureMessage, { operation: input.method, status: response.status });
    }
    if (!response.ok) {
      // Deliberately omit the response body: no diagnostic path is allowed to accidentally
      // preserve an echoed credential, JWT, or installation token.
      return deny(input.failureCode, input.failureMessage, { operation: input.method, status: response.status });
    }
    return allow(ReasonCode.OK, { body, status: response.status });
  }

  #loadConfiguration(): Decision<GitHubAppConfiguration> {
    const environment = this.#readEnvironmentFile();
    if (!environment.allowed) return environment as Decision<GitHubAppConfiguration>;
    const appId = environment.value.get("GITHUB_APP_ID")?.trim() ?? "";
    const installationId = environment.value.get("GITHUB_APP_INSTALLATION_ID")?.trim() ?? "";
    const privateKeyPath = (this.#privateKeyPathOverride ?? environment.value.get("GITHUB_APP_PRIVATE_KEY_PATH") ?? "").trim();
    if (!/^\d+$/.test(appId) || !/^\d+$/.test(installationId) || privateKeyPath.length === 0) {
      return deny(
        ReasonCode.GITHUB_APP_CONFIGURATION_INVALID,
        "GitHub App env file must provide numeric GITHUB_APP_ID, numeric GITHUB_APP_INSTALLATION_ID, and GITHUB_APP_PRIVATE_KEY_PATH",
        {},
      );
    }

    const keyFile = this.#inspectCredentialFile(
      privateKeyPath,
      "GitHub App private key",
      ReasonCode.GITHUB_APP_PRIVATE_KEY_MISSING,
      ReasonCode.GITHUB_APP_PRIVATE_KEY_UNREADABLE,
      ReasonCode.GITHUB_APP_PRIVATE_KEY_INSECURE,
    );
    if (!keyFile.allowed) return keyFile as Decision<GitHubAppConfiguration>;
    let keyBytes: Buffer;
    try {
      keyBytes = this.#readFile(privateKeyPath) as Buffer;
    } catch {
      return deny(
        ReasonCode.GITHUB_APP_PRIVATE_KEY_UNREADABLE,
        "GitHub App private key is not readable by the daemon",
        {},
      );
    }
    try {
      const keyFingerprint = createHash("sha256").update(keyBytes).digest("hex");
      const key = createPrivateKey(keyBytes);
      return allow(ReasonCode.OK, { appId, installationId, privateKeyPath, key, keyFingerprint });
    } catch {
      return deny(
        ReasonCode.GITHUB_APP_PRIVATE_KEY_UNREADABLE,
        "GitHub App private key could not be parsed by the daemon",
        {},
      );
    } finally {
      keyBytes?.fill(0);
    }
  }

  #readEnvironmentFile(): Decision<Map<string, string>> {
    const file = this.#inspectCredentialFile(
      this.#appEnvFile,
      "GitHub App env file",
      ReasonCode.GITHUB_APP_ENV_FILE_MISSING,
      ReasonCode.GITHUB_APP_ENV_FILE_UNREADABLE,
      ReasonCode.GITHUB_APP_ENV_FILE_INSECURE,
    );
    if (!file.allowed) return file as Decision<Map<string, string>>;
    try {
      return allow(ReasonCode.OK, parseEnvironmentFile(this.#readFile(this.#appEnvFile, "utf8") as string));
    } catch {
      return deny(
        ReasonCode.GITHUB_APP_ENV_FILE_UNREADABLE,
        "GitHub App env file is not readable by the daemon",
        {},
      );
    }
  }

  /** Read no values outward; this is only for installing a child-process deny rule. */
  #keyPathFromEnvironmentFile(): string | null {
    try {
      const path = parseEnvironmentFile(this.#readFile(this.#appEnvFile, "utf8") as string)
        .get("GITHUB_APP_PRIVATE_KEY_PATH")
        ?.trim();
      return path && path.length > 0 ? path : null;
    } catch {
      return null;
    }
  }

  #inspectCredentialFile(
    path: string,
    label: string,
    missingCode: ReasonCode,
    unreadableCode: ReasonCode,
    insecureCode: ReasonCode,
  ): Decision<void> {
    try {
      lstatSync(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT"
        ? deny(missingCode, `${label} is missing`, {})
        : deny(unreadableCode, `${label} is not readable by the daemon`, {});
    }
    const file = inspectPrivatePath(path, "file");
    if (!file.secure) return deny(insecureCode, `${label} is not daemon-owned and mode 0600`, {});
    return allow(ReasonCode.OK, undefined);
  }

  #matchesConfiguration(
    cache: Pick<CachedInstallationToken, "appId" | "installationId" | "keyFingerprint"> | CachedCreatorIdentity,
    configuration: GitHubAppConfiguration,
  ): boolean {
    return (
      cache.appId === configuration.appId &&
      cache.installationId === configuration.installationId &&
      cache.keyFingerprint === configuration.keyFingerprint
    );
  }

  #tokenIsFresh(token: CachedInstallationToken): boolean {
    return token.expiresAtMs - this.#now() > this.#refreshBeforeExpiryMs;
  }
}
