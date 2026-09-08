const aSubscriberRechecksTheLiveBindingBeforeDelivery = {
  id: "a-subscriber-rechecks-the-live-binding-before-delivery",
  what: "a subscriber rechecks the live binding before delivery",
  file: "src/buzz/buzz-mention-subscriber.ts",
  find: "    const bound = this.#deps.registry.primaryCtoBindingFor(this.#pubkey);",
  replace: "    const bound = { roleKey: this.#roleKey, buzzActorId: this.#pubkey };",
  killedBy: [
    "tests/unit/buzz-mention-subscriber.test.ts::delivers no mention after the PRIMARY_CTO binding is revoked in the daemon registry",
  ],
};

export default aSubscriberRechecksTheLiveBindingBeforeDelivery;
