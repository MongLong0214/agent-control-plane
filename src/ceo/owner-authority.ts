/**
 * PRD §21, §27.2 — who counts as the owner.
 *
 * Owner authority is the one authority the control plane cannot derive from its own
 * state: a human gate exists precisely because no agent may satisfy it. So the identities
 * that may act as owner are configured out of band, per channel, and every owner-only
 * decision is checked against this list. An empty list fails closed — an unconfigured
 * deployment has no owner, rather than an implicit one.
 */
export interface OwnerIdentity {
  /** Channel the owner acts through: "telegram", "buzz", "mcp", "cli". */
  channel: string;
  /** Channel-scoped actor id: telegram user id, buzz pubkey, OS user for the CLI. */
  actor: string;
}

export interface OwnerAuthorityPort {
  isAllowedActor(channel: string, actor: string): boolean;
}

export class OwnerAuthority implements OwnerAuthorityPort {
  readonly #identities: readonly OwnerIdentity[];

  constructor(identities: readonly OwnerIdentity[] = []) {
    this.#identities = [...identities];
  }

  isAllowedActor(channel: string, actor: string): boolean {
    return this.#identities.some((i) => i.channel === channel && i.actor === actor);
  }

  /** Doctor input: a deployment with no owner identity cannot satisfy a human gate. */
  configured(): number {
    return this.#identities.length;
  }
}
