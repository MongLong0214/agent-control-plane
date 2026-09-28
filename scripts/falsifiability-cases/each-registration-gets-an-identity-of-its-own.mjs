/**
 * Each registration of an endpoint gets an identity no earlier one shares.
 *
 * This is what makes the two scoping rules above mean anything. Without a fresh identity per
 * registration, every delivery's `peer.registration === registration` is trivially true -- the
 * comparison is still there, still passes review, and separates nothing -- which is the state the
 * endpoint-string comparison was already in: two registrations of one pathname compared equal, so a
 * delivery from the first wrote into the second.
 *
 * The mutation leaves the counter where it was on re-registration. The killing row holds one
 * registration's wake pending, registers again, and requires the second registration's refusal to
 * survive the first's late success -- which it cannot if both deliveries claim the same identity.
 */
const eachRegistrationGetsAnIdentityOfItsOwn = {
  id: "each-registration-gets-an-identity-of-its-own",
  what: "registering an endpoint gives that registration an identity distinct from the one before it",
  file: "src/mcp/role-conversation.ts",
  find: "      peer.registration += 1;\n",
  replace: "      peer.registration += 0;\n",
  killedBy: [
    "tests/unit/a-late-wake-belongs-to-the-registration-it-began-under.test.ts::a success completing after a later registration does not erase that registration's refusal",
  ],
};

export default eachRegistrationGetsAnIdentityOfItsOwn;
