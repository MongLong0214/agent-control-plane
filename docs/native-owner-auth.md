# Native macOS CTO delegation connector (not deployed or launched)

This rollback-safe slice adds one native executable and one operation-specific admission
branch on the existing authenticated operator socket. It changes neither the existing
`ctoBinding.delegate` receipt path nor the frozen delegation/CEO restoration guards.

## Invocation contract — for a later reviewed launch only

Build with the installed Apple command-line tools, from the repository root:

```sh
npm run build
xcrun swiftc -parse-as-library native/owner-auth/OwnerAuth.swift -o dist/acp-owner-auth
```

The artifact is `dist/acp-owner-auth`. A later launcher must spawn that exact reviewed
artifact with **no arguments, an empty environment, and a nonsecret JSON object on stdin**,
then close stdin. Do not run it as part of this slice. No terminal action by the owner
is required: the later launcher owns the pipe and the native application owns the dialogs.
The input is a closed object with exactly these eight string keys:

- `projectId`: exact project identity
- `role`: `PRIMARY_CTO`
- `action`: `bind-or-rebind`
- `ceoActorId`: current canonical CEO actor
- `ceoSessionId`: current CEO principal/session
- `ceoIncarnation`: current CEO incarnation
- `expiresAt`: explicit future UTC timestamp, including fractional seconds
- `revokePolicy`: `owner-or-ceo-loss`

Values are visible ASCII, nonempty, at most 256 bytes each; the complete input is at most
8192 bytes. There is no credential, socket, Keychain service/account, method override,
receipt, environment selector, or test flag in the production invocation contract.

The exact immutable scope is shown in an AppKit confirmation dialog, including recurring
CEO→CTO binding, expiry, owner/CEO-loss revocation, and restart survival conditional on the
same canonical CEO assignment. Confirmation is **not authentication**. A fresh
`LAContext.deviceOwnerAuthentication` (biometric or the system password/passcode policy)
must affirmatively succeed next. Cancellation, error, timeout or elapsed expiry denies
before credential read. The native child then uses `SecItemCopyMatching` for the existing
canonical generic-password item, service `com.agentcontrolplane.agentcpd`, account
`ACP_OPERATOR_TOKEN`. Keychain interaction is disabled after native authentication;
there is no ACL edit, Always Allow, credential CLI, AppleScript or GUI automation.

The bearer exists only inside the native child and its authenticated socket frame. It
never travels through parent stdin/argv/environment, a credential file, stdout/stderr,
logs or the returned receipt. Mutable bearer/frame buffers are cleared on scope exit;
Swift/Foundation may retain intermediate in-memory copies until process exit. This is
not a guarantee of zero-copy secret memory or a general secure-memory framework.

The child derives the real UID's home using `getpwuid`, ignoring HOME. It connects only to
`<home>/.agent-control-plane/agentcpd.operator.sock`, checks private socket ownership/mode,
connected peer UID and socket-path stability, and sends exactly one newline JSON request:
`{token, method:"ctoBinding.approveAndDelegate", params:{scope, requestId}}`.
No reconnect or automatic retry is performed. The configured local same-UID state directory
is a trust boundary; this does not claim protection against a malicious same-UID process
that controls the daemon's installation/state directory.

The daemon authenticates its existing bearer, requires its lock and configured CLI owner,
strictly checks the operation-specific scope, and admits/consumes the owner decision and
durable grant in one transaction. It uses the existing canonical-CEO and delegation checks.
The new branch was necessary because `ctoBinding.delegate` requires an *already-admitted*
receipt and `owner.approve` only admits run decisions for `owner_decision_submit`; neither
can mint this delegation's scope. There is no generic owner-approval minting endpoint.

Only `GRANTED <delegation UUID>` or a fixed nonsecret failure code is emitted. A successful
reply must echo exactly the approved scope. Cancellation, auth failure, inaccessible
Keychain, invalid scope, transport failure, daemon denial and malformed receipt fail
closed. If the response is lost after a committed grant, success is unknown and **must not
be retried automatically**. Owner revocation remains the existing separately admitted
`ctoBinding.revoke` operation; this connector does not grant an agent revocation authority.

## Verification and release boundary

Automated checks compile a separate fixture entry point rather than launching the
production entry point. Disposable socket tests exercise scope validation, ordering
and transport with synthetic native authentication and credential-store callbacks.
Daemon-socket tests exercise durable admission, wrong credentials, non-owner callers,
lost lock, mismatched scope, expiry and extra fields against a disposable database.
These tests do not establish live owner authentication or credential-store access.

Release qualification must independently establish the artifact's architecture,
signing and distribution requirements, and access under the installed credential-store
policy. Linker ad-hoc signing is not Developer ID signing, notarization or an ACL grant.
Building the connector does not authorize launching its UI, reading credentials,
changing an allowlist, restarting a service or deploying the feature.

Rollback removes the connector and its operation-specific admission branch. No schema
migration is required; existing receipt-based grant and revocation paths remain separate.
