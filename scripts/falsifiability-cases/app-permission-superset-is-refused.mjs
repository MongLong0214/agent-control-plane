/**
 * #575: the App permission check moved from a single exact shape to an append-only list of exact
 * shapes, precisely so the App's grant and this code no longer have to narrow in the same instant.
 * Removing the key-count check turns every shape's match into "contains at least these keys at
 * these levels" — a superset would then match, which is exactly the silent broadening the list
 * exists to prevent.
 *
 * Migrated out of the array in `verify-guards-are-falsifiable.mjs` by #741, unchanged.
 */
const appPermissionSupersetIsRefused = {
  id: "app-permission-superset-is-refused",
  what: "an App permission grant with an extra key beyond an approved shape is refused, not accepted as a superset",
  file: "src/github/credential-store.ts",
  find: "    Object.keys(permissions).length === expected.length &&\n",
  replace: "",
  killedBy: [
    "tests/unit/github-app-credential-store.test.ts::refuses the narrowed grant shape plus one extra permission — a superset is never accepted",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default appPermissionSupersetIsRefused;
