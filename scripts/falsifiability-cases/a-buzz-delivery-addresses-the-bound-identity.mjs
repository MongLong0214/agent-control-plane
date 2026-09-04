/**
 * #760. The recipient is not new information: `sessions.buzz_actor_id` is the same column the
 * inbound side resolves, written only by an authenticated bind. Dropping the recipient from
 * this call is how the daemon would go back to putting envelopes in a room without addressing
 * the session they are for — the shape the outbox cannot tell apart from a delivery.
 */
const aBuzzDeliveryAddressesTheBoundIdentity = {
  id: "a-buzz-delivery-addresses-the-bound-identity",
  what: "outbound delivery names the target session's bound Buzz channel identity",
  file: "src/buzz/buzz-adapter.ts",
  find: "        await this.transport.send(channel, render(message), [recipient]);",
  replace: "        await this.transport.send(channel, render(message), [recipient, \"\"].slice(1));",
  killedBy: [
    "tests/unit/outbox-buzz-claims-r2.test.ts::#321/#124/#214 delivery addresses the target session's bound identity",
  ],
};

export default aBuzzDeliveryAddressesTheBoundIdentity;
