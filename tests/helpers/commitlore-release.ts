import type { CommitLoreReleaseLookup } from "../../src/bootstrap/commitlore-pin.ts";

/** The answer GitHub's `releases/latest` gives for a published stable release tagged `v<version>`. */
export const stableReleaseAnswer = (version: string, id = 1): Record<string, unknown> => ({
  id,
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  published_at: "2026-10-18T22:20:31Z",
});

/**
 * #1268 — a release lookup that confirms `version` as the newest published stable release, so a fixture CLI
 * answering that version is the latest release; no test reaches the network through it. `calls` counts the
 * lookups made.
 */
export const latestRelease = (version: string, id = 1): CommitLoreReleaseLookup & { readonly calls: () => number } => {
  let calls = 0;
  const lookup = async (): Promise<unknown> => {
    calls += 1;
    return stableReleaseAnswer(version, id);
  };
  return Object.assign(lookup, { calls: () => calls });
};
