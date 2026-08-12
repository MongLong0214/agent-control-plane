import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";

export interface TrustedCredential {
  token: string;
  /** Login or app slug that will appear as the creator of a published gate. */
  creatorIdentity: string;
}

/**
 * CP-HI-05 — the GitHub authority credential.
 *
 * It lives outside every project repository, in a directory only the daemon user can
 * read, and it is never placed in the environment of a CTO, worker, reviewer,
 * verification subprocess, Repo Factory, Buzz or Telegram adapter. The only way to use
 * it is `run`, which spawns one short-lived child process with the token in that child's
 * environment. No caller ever receives the value, so it cannot be logged, returned or
 * forwarded — a callback that "only uses" the token is not offered.
 */
export class TrustedCredentialStore {
  readonly #path: string;
  readonly #identityPath: string;
  #cached: TrustedCredential | null = null;

  constructor(private readonly directory: string) {
    this.#path = join(directory, "github-authority.token");
    this.#identityPath = join(directory, "github-authority.identity");
  }

  install(credential: TrustedCredential): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    writeFileSync(this.#path, credential.token, { mode: 0o600 });
    writeFileSync(this.#identityPath, credential.creatorIdentity, { mode: 0o600 });
    chmodSync(this.directory, 0o700);
    this.#cached = credential;
  }

  available(): boolean {
    return existsSync(this.#path) && existsSync(this.#identityPath);
  }

  /** The identity a trusted gate must have been created by. Safe to expose. */
  creatorIdentity(): string | null {
    if (this.#cached) return this.#cached.creatorIdentity;
    if (!existsSync(this.#identityPath)) return null;
    return readFileSync(this.#identityPath, "utf8").trim();
  }

  /**
   * Runs one child process with the credential in its environment, under the variable
   * name the tool expects. The token is never handed to JavaScript callers, so there is
   * no surface on which it can be logged, returned or forwarded (CP-HI-05).
   *
   * `env` is the *complete* environment of the child apart from the injected token: the
   * daemon's own environment is not inherited, so nothing else leaks either.
   */
  async run(options: {
    file: string;
    args: readonly string[];
    tokenEnvVar: string;
    env: Readonly<Record<string, string>>;
    input?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
  }): Promise<Decision<{ stdout: string; stderr: string; exitCode: number | null }>> {
    const loaded = this.load();
    if (!loaded.allowed)
      return loaded as Decision<{ stdout: string; stderr: string; exitCode: number | null }>;

    const limit = options.maxOutputBytes ?? 32 * 1024 * 1024;
    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; spawnError: string | null }>(
      (resolve) => {
        const child = spawn(options.file, [...options.args], {
          env: { ...options.env, [options.tokenEnvVar]: loaded.value.token },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let spawnError: string | null = null;
        child.stdout.on("data", (b: Buffer) => {
          if (stdout.length < limit) stdout += b.toString("utf8");
        });
        child.stderr.on("data", (b: Buffer) => {
          if (stderr.length < limit) stderr += b.toString("utf8");
        });
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs ?? 120_000);
        child.on("error", (err) => {
          clearTimeout(timer);
          spawnError = err.message;
          resolve({ stdout, stderr, exitCode: null, timedOut, spawnError });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ stdout, stderr, exitCode: code, timedOut, spawnError });
        });
        // The body must be written *and* stdin closed, or a tool reading from `-` waits
        // forever. Doing it here is the reason this class owns the spawn.
        if (options.input !== undefined) child.stdin.end(options.input);
        else child.stdin.end();
      },
    );

    if (result.spawnError) {
      return deny(ReasonCode.PROBE_FAILED, `could not start ${options.file}: ${result.spawnError}`, {
        file: options.file,
      });
    }
    if (result.timedOut) {
      return deny(ReasonCode.PROBE_FAILED, `${options.file} timed out`, { file: options.file });
    }
    return allow(ReasonCode.OK, {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  }

  /** Permission audit for the doctor: the secret directory must not be world-readable. */
  permissionsOk(): boolean {
    if (!existsSync(this.directory)) return false;
    const mode = statSync(this.directory).mode & 0o777;
    const fileMode = existsSync(this.#path) ? statSync(this.#path).mode & 0o777 : 0;
    return (mode & 0o077) === 0 && (fileMode & 0o077) === 0;
  }

  private load(): Decision<TrustedCredential> {
    if (this.#cached) return allow(ReasonCode.OK, this.#cached);
    if (!this.available()) {
      return deny(
        ReasonCode.TRUSTED_CREDENTIAL_UNAVAILABLE,
        "trusted GitHub credential is not installed",
        { directory: this.directory },
      );
    }
    if (!this.permissionsOk()) {
      return deny(
        ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED,
        "trusted credential store is group- or world-accessible",
        { directory: this.directory },
      );
    }
    this.#cached = {
      token: readFileSync(this.#path, "utf8").trim(),
      creatorIdentity: readFileSync(this.#identityPath, "utf8").trim(),
    };
    return allow(ReasonCode.OK, this.#cached);
  }
}
