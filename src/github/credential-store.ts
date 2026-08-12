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
 * it is `withToken`, which hands the value to a callback and never returns it — so a
 * caller cannot accidentally log it or pass it onward.
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
   * Runs `fn` with the token. The token is not returned, stored on `this` beyond the
   * process, or exposed to any other surface.
   */
  async withToken<T>(fn: (token: string) => Promise<T>): Promise<Decision<T>> {
    const loaded = this.load();
    if (!loaded.allowed) return loaded as Decision<T>;
    return allow(ReasonCode.OK, await fn(loaded.value.token));
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
