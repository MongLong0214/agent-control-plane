import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * An App env file and private key the daemon can read, where `defaultConfig()` looks for them
 * (`<state root>/credentials/github-app.env`): what the trusted gate's credential check asks for.
 *
 * A start that runs the production entry point is judged on this before it opens the database
 * (migrate-before-start), so a test that is about what happens at or after the open needs one.
 */
export const installGitHubAppCredential = (stateRoot: string): void => {
  const credentials = join(stateRoot, "credentials");
  mkdirSync(credentials, { recursive: true, mode: 0o700 });
  chmodSync(credentials, 0o700);
  const key = join(credentials, "github-app.private-key.pem");
  writeFileSync(
    key,
    generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(credentials, "github-app.env"),
    `GITHUB_APP_ID=4586878\nGITHUB_APP_INSTALLATION_ID=153553922\nGITHUB_APP_PRIVATE_KEY_PATH=${key}\n`,
    { mode: 0o600 },
  );
};
