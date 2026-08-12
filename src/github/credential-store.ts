import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    this.assertInstallTarget(this.#path);
    this.assertInstallTarget(this.#identityPath);
    writeFileSync(this.#path, credential.token, { mode: 0o600 });
    writeFileSync(this.#identityPath, credential.creatorIdentity, { mode: 0o600 });
    chmodSync(this.directory, 0o700);
    // `writeFileSync({ mode })` only affects a file at creation time. An existing
    // permissive token file must be repaired before it is ever cached or used.
    chmodSync(this.#path, 0o600);
    chmodSync(this.#identityPath, 0o600);
    this.#cached = credential;
  }

  available(): boolean {
    return this.metadataOk();
  }

  /** The identity a trusted gate must have been created by. Safe to expose. */
  creatorIdentity(): string | null {
    // Identity is not a secret, but returning it from a store whose isolation has been
    // lost would let a caller mistake an unsafe credential for a trusted producer.
    if (!this.metadataOk()) return null;
    return this.#cached?.creatorIdentity ?? readFileSync(this.#identityPath, "utf8").trim();
  }

  /**
   * Executes the one fixed GitHub CLI form the daemon needs. This deliberately is not a
   * generic process runner: allowing callers to choose an executable or token variable
   * would make `printenv` an authority-token read API (CP-HI-05).
   *
   * `env` is the *complete* environment of the child apart from the injected token: the
   * daemon's own environment is not inherited, so nothing else leaks either.
   */
  async githubApi(options: {
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    path: string;
    input?: string;
  }): Promise<Decision<{ stdout: string; stderr: string; exitCode: number | null }>> {
    const loaded = this.load();
    if (!loaded.allowed)
      return loaded as Decision<{ stdout: string; stderr: string; exitCode: number | null }>;

    const args = ["api", "-X", options.method, options.path, "-H", "Accept: application/vnd.github+json"];
    if (options.input !== undefined) args.push("--input", "-");
    const limit = 32 * 1024 * 1024;
    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; spawnError: string | null }>(
      (resolve) => {
        const child = spawn("gh", args, {
          env: {
            PATH: process.env["PATH"] ?? "/usr/bin:/bin",
            HOME: process.env["HOME"] ?? "",
            GH_PROMPT_DISABLED: "1",
            GH_TOKEN: loaded.value.token,
          },
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
        }, 120_000);
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
      return deny(ReasonCode.PROBE_FAILED, `could not start GitHub CLI: ${result.spawnError}`, {
        operation: options.method,
        path: options.path,
      });
    }
    if (result.timedOut) {
      return deny(ReasonCode.PROBE_FAILED, "GitHub CLI timed out", {
        operation: options.method,
        path: options.path,
      });
    }
    return allow(ReasonCode.OK, {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  }

  /** Permission audit for the doctor: the secret directory must not be world-readable. */
  permissionsOk(): boolean {
    return this.metadataOk();
  }

  private load(): Decision<TrustedCredential> {
    // Check metadata before consulting cached bytes. A cache is an optimisation, never
    // evidence that the token file remains isolated after installation.
    if (!existsSync(this.#path) || !existsSync(this.#identityPath)) {
      return deny(
        ReasonCode.TRUSTED_CREDENTIAL_UNAVAILABLE,
        "trusted GitHub credential is not installed",
        { directory: this.directory },
      );
    }
    if (!this.metadataOk()) {
      return deny(
        ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED,
        "trusted credential store is not a daemon-owned private directory with regular private files",
        { directory: this.directory },
      );
    }
    if (this.#cached) return allow(ReasonCode.OK, this.#cached);
    this.#cached = {
      token: readFileSync(this.#path, "utf8").trim(),
      creatorIdentity: readFileSync(this.#identityPath, "utf8").trim(),
    };
    return allow(ReasonCode.OK, this.#cached);
  }

  private metadataOk(): boolean {
    try {
      if (!existsSync(this.directory) || !existsSync(this.#path) || !existsSync(this.#identityPath)) {
        return false;
      }
      const directory = lstatSync(this.directory);
      const token = lstatSync(this.#path);
      const identity = lstatSync(this.#identityPath);
      if (!directory.isDirectory() || !token.isFile() || !identity.isFile()) return false;
      if ((directory.mode & 0o077) !== 0 || (token.mode & 0o077) !== 0 || (identity.mode & 0o077) !== 0) {
        return false;
      }
      const uid = typeof process.getuid === "function" ? process.getuid() : null;
      return uid === null || (directory.uid === uid && token.uid === uid && identity.uid === uid);
    } catch {
      return false;
    }
  }

  private assertInstallTarget(path: string): void {
    if (!existsSync(path)) return;
    const target = lstatSync(path);
    if (!target.isFile()) {
      throw new Error(`trusted credential install refuses non-regular target: ${path}`);
    }
  }
}
