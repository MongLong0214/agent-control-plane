/**
 * Every remaining unisolated operand in the six source files touched by #804, and in
 * `canonical-self-claim-listener.ts`, which left the file-exclusion backlog under #833.
 * These are answers owed, not claims of unkillability or completed coverage. Each reason states
 * the missing independent witness or the neighbouring invariant that masks removal.
 * The file-exclusion backlog lives separately in refusal-operand-exclusions.mjs. Its size used
 * to be restated here and went stale every time a file left that list — eighty-nine, then
 * eighty-eight, then eighty-seven, each step landing in whichever of the two files the branch
 * happened to touch. (Spelled out: the guard forbids today's count, not any number, so a
 * historical numeral here goes red the day the live count drifts onto it.) `pnpm
 * guards:operands` now prints both counts from the lists themselves, so neither header states a
 * number that can disagree with what it describes.
 *
 * Entries name source text and its occurrence, never a line coordinate. Identical new operands
 * exceed the recorded occurrences and fail. Remove an entry when its row is established.
 * sol-simplify: requested explicit operand debts; remove each when an independent row replaces it.
 */
const groups = [
  {
    file: "src/runtime/reviewer-codex-home.ts",
    // path-shape
    reason: "NO WITNESS. Measured by weakening the whole condition to its first operand and running all five cases in tests/unit/reviewer-codex-home.test.ts: 5 passed. The shape check is pre-empted by the three privateDirectory() calls below it \u2014 a path that is not <namespace>/<uuid>/home still fails on the namespace, capsule or home directory it does not own, so no fixture distinguishes which check refused. The operands stay because that pre-emption is implicit: a deployment that relaxed the directory checks, or a capsule created with the right mode under the wrong parent, would make this the only thing naming where a private home may live.",
    operands: [
      ["resolve(root) !== root",1],
      ["basename(root) !== \"home\"",1],
      ["dirname(capsule) !== namespace()",1],
      ["!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(basename(capsule))",1],
    ],
  },
  {
    file: "src/runtime/reviewer-codex-home.ts",
    // symlink-ancestor
    reason: "NO WITNESS. Measured by replacing the loop body's condition with `false` and running all five cases: 5 passed. privateDirectory() re-checks isSymbolicLink and realpathSync on the namespace, capsule and home, so every symlink the fixtures build is caught one frame later. The walk stays because it is the only check above the namespace: a symlink at ~/.agent-control-plane or higher turns the private namespace into a shared credential store, and no fixture yet builds one.",
    operands: [
      ["lstatSync(path).isSymbolicLink()",1],
      ["realpathSync(path) !== path",2],
    ],
  },
  {
    file: "src/runtime/reviewer-codex-home.ts",
    // receipt-stat
    reason: "NO WITNESS. Measured by weakening the condition to `!stat.isFile()` and running all five cases: 5 passed. Every fixture that damages the receipt replaces the home or capsule too, so the identity comparison below fails first and nothing distinguishes a hardlinked, group-readable or oversized receipt from an absent one. The operands stay because each names a different way the receipt stops being this capsule's own record \u2014 a second link, another uid, a widened mode, a payload \u2014 and none of those needs the home to change.",
    operands: [
      ["!stat.isFile()",1],
      ["stat.isSymbolicLink()",2],
      ["stat.nlink !== 1",1],
      ["stat.uid !== process.getuid?.()",2],
      ["(stat.mode & 0o7777) !== 0o600",1],
      ["stat.size > 2048",1],
    ],
  },
  {
    file: "src/runtime/reviewer-codex-home.ts",
    // receipt-shape
    reason: "NO WITNESS. Measured by dropping the key-set comparison and running all five cases: 5 passed. A receipt carrying extra or missing keys still fails the four device/inode comparisons below whenever the fixtures alter it. The operand stays because the key set is what makes JSON.parse's result the declared shape rather than whatever parsed: a receipt with the right four inode fields and an extra key would otherwise be admitted and frozen into the binding.",
    operands: [
      ["Object.keys(identity).sort().join(\",\") !== \"capsuleDev,capsuleIno,dev,ino,root\"",1],
      ["identity.root !== root",1],
    ],
  },
  {
    file: "src/runtime/reviewer-codex-home.ts",
    // claim-identity
    reason: "NO WITNESS. Measured by weakening the condition to `identity.dev !== home.dev` and running all five cases: 5 passed. The fixtures that move a home change its device and inode together, so the first operand catches them and the other three are never the deciding one. They stay because a same-device replacement \u2014 a rename within one filesystem, which is the ordinary case \u2014 changes the inode and not the device, and then identity.ino is the only comparison that refuses.",
    operands: [
      ["identity.dev !== home.dev",1],
      ["identity.ino !== home.ino",1],
      ["identity.capsuleDev !== capsule.dev",1],
      ["identity.capsuleIno !== capsule.ino",1],
    ],
  },
  {
    file: "src/daemon/canonical-self-claim-operator.ts",
    // The request-field checks TypeScript enforces, and the one a second authority re-checks.
    // `value.length > 0` used to sit here through `an-empty-string-nonce-is-not-a-nonce`; the
    // nonce is gone and the operand is not, so it carries `an-empty-string-is-not-a-request-field`.
    reason: "Three of these four cannot carry a row and the harness says so: `isNonEmptyString` is a type predicate, so removing any `!isNonEmptyString(...)` operand — or the `typeof value === \"string\"` inside it — leaves an `unknown` value flowing into a `string` field, and the mutant refuses to compile. TypeScript is the enforcement site, not a test. The fourth, `!Number.isSafeInteger(expectedBindingGeneration)`, compiles when removed and SURVIVED: `CanonicalSelfClaim.claim()` re-checks the same property (`canonical-self-claim.ts`, \"expectedBindingGeneration must be a positive safe integer\") and denies with the same `INVALID_ARGUMENT`, so no input distinguishes the two. That is a second authority on one fact rather than defence in depth, and it is worth saying plainly: this operand's only effect today is to refuse earlier and with a different message.",
    operands: [
      ["typeof value === \"string\"",1],
      ["!isNonEmptyString(claimedSessionUuid)",1],
      ["!isNonEmptyString(projectId)",1],
      ["!Number.isSafeInteger(expectedBindingGeneration)",1],
    ],
  },
  {
    file: "src/registry/canonical-self-claim.ts",
    // The same-live recovery branch (#831) — reachable in production, no fixture distinguishes it.
    reason: "Twenty operands in the two predecessor branches, every one run and either SURVIVED or refused as an uncompilable mutant. This is the code #831 was about — a rule keyed on a session row's lifecycle rather than on a process's liveness — so the reasons matter more here than the count does.\n\nUncompilable, TypeScript enforcing: `predecessor !== null` narrows before `predecessor.osPid` is read, and the `incumbent`/`predecessor` truthiness guards at the second branch narrow `| null` rows the block then dereferences. Removing any of the three leaves a possibly-null value flowing into a field read.\n\nSubsumed, measured SURVIVED: `osPid === null` and `osProcessStartedAt === null` in `#predecessorProcessIsGone` are each caught by the other plus `probeSessionLiveness`'s own fail-closed `UNKNOWN`, which is the answer the docblock says joins the fail-closed set; `#predecessorProcessIsGone(...)` itself survives because the fixtures whose predecessor row is READY also have a gone process, so the conjunct never decides alone; the two `incumbent`/`predecessor` guards on the first branch survive because no fixture reaches it without both.\n\nAnswers owed — reachable and unfixtured: `!revoked`, `incumbent.current_session_incarnation !== predecessor.incarnation`, `predecessor.osPid !== identity.pid`, `predecessor.osProcessStartedAt !== identity.startedAt`, `predecessor.workdir !== identity.cwd`, `predecessor.buzzAddress !== buzzAddress`, `predecessor.provider !== \"claude\"` and `predecessor.model !== \"claude-cli\"` are eight conjuncts of one eleven-way refusal, and the suite's mismatch cases exercise four of them; the four lifecycle exclusions across both branches survive because every fixture's predecessor is READY or DRAINING rather than STOPPED or ERROR. Each needs a fixture that differs in exactly one field, which is a real gap and stated as one rather than as unkillability.",
    operands: [
      ["predecessor !== null",1],
      ["this.#predecessorProcessIsGone(predecessor.osPid, predecessor.osProcessStartedAt)",1],
      ["osPid === null",1],
      ["osProcessStartedAt === null",1],
      ["incumbent",1],
      ["predecessor",1],
      ["predecessor.lifecycle !== SessionLifecycle.STOPPED",1],
      ["predecessor.lifecycle !== SessionLifecycle.ERROR",1],
      ["incumbent",2],
      ["predecessor",2],
      ["predecessor.lifecycle !== SessionLifecycle.STOPPED",2],
      ["predecessor.lifecycle !== SessionLifecycle.ERROR",2],
      ["!revoked",1],
      ["incumbent.current_session_incarnation !== predecessor.incarnation",1],
      ["predecessor.osPid !== identity.pid",1],
      ["predecessor.osProcessStartedAt !== identity.startedAt",1],
      ["predecessor.workdir !== identity.cwd",1],
      ["predecessor.buzzAddress !== buzzAddress",1],
      ["predecessor.provider !== \"claude\"",1],
      ["predecessor.model !== \"claude-cli\"",1],
    ],
  },
  {
    file: "src/registry/canonical-self-claim.ts",
    // NO WITNESS — the operand's own effect is subsumed, so no input can distinguish it.
    reason: "Three operands whose removal changes nothing observable, each measured rather than argued. `firstElement !== undefined` (looksLikeClaudeInvocation): the mutant needs a non-null assertion to compile, and `/(^|\\/)claude$/.test(undefined!)` coerces to the string \"undefined\", which does not match — SURVIVED. `typeof value !== \"string\"` (requireDeploymentValue): every caller reaches it through a `CanonicalSelfClaimConfig` field typed `string`, so a non-string cannot arrive without bypassing the type; removing the operand leaves `value.trim()`, which would throw rather than refuse if one ever did — SURVIVED, and TypeScript is what stands between that throw and a caller. `stat.dev !== reportedDevice` (openVerifiedDarwinImageFd): its sibling inode check catches every fixture, and distinguishing it needs a decoy on a *different device* — a cross-device fixture this suite has no way to build on one volume. All three are kept because each is the half that would matter first if the other changed.",
    operands: [
      ["firstElement !== undefined",1],
      ["typeof value !== \"string\"",1],
      ["stat.dev !== reportedDevice",1],
    ],
  },
  {
    file: "src/registry/canonical-self-claim.ts",
    // TYPESCRIPT IS THE ENFORCEMENT SITE — the mutant does not compile, so no test can kill it.
    reason: "Five operands the harness refused as uncompilable mutants, which is the answer rather than a gap. `ppidRaw === null` and `command === null` narrow two `string | null` reads before `Number.parseInt` and the argv split; removing either leaves `null` flowing into a `string` parameter. `rawValue === undefined` narrows before `rawValue.toLowerCase()`. `entry.device === null` and `entry.inode === null` narrow before `BigInt(...)`. In each case the guard is what makes the next line type-check, so the property is enforced at compile time and a row claiming a test proves it would be claiming the wrong thing.",
    operands: [
      ["ppidRaw === null",1],
      ["command === null",1],
      ["rawValue === undefined",1],
      ["entry.device === null",1],
      ["entry.inode === null",1],
    ],
  },
  {
    file: "src/registry/canonical-self-claim.ts",
    // WITNESSED BUT NOT ISOLABLE — reachable in production, no input in this suite reaches it.
    reason: "Eleven operands that are answers owed rather than claims of unkillability. Each is reachable in production and none of this suite's inputs distinguishes it; all eleven were run and SURVIVED, several after the killedBy was retargeted at a better-fitting case first. `!Number.isSafeInteger(callerPid)` and `callerPid <= 0`: callerPid arrives from the kernel peer credential the claim socket established, so no production caller and no test supplies a malformed one — defence for a caller that cannot exist yet. `request.claimedPid !== identity.pid`: no case supplies a *matching* claimedPid, so removing the inequality (leaving the `!== undefined` half) refuses nothing any test asks for. `entry.fd === \"cwd\"` and `entry.type === \"DIR\"`: the synthetic lsof scans carry a single cwd/DIR entry, so neither half selects differently; distinguishing them needs a scan with a decoy directory or a non-directory `cwd`. `rawValue === \"\"`: a selector with a following token is always present in the fixtures, so the empty-attached-value path is reached only through its sibling. `runId !== null` and `candidateSnapshotDigest !== null`: no case presents an approval that binds a run or a candidate, which is what this refusal exists to reject. `!Number.isSafeInteger(request.expectedBindingGeneration)`: the suite supplies non-positive generations but never a fractional one. `candidate.fd === \"txt\"` and `candidate.type === \"REG\"`: the synthetic scans carry one txt/REG entry, so neither half discriminates. Every one of these is a fixture this suite does not have rather than a property nothing enforces, and that distinction is why they are listed separately from the group above.",
    operands: [
      ["!Number.isSafeInteger(callerPid)",1],
      ["callerPid <= 0",1],
      ["request.claimedPid !== identity.pid",1],
      ["entry.fd === \"cwd\"",1],
      ["entry.type === \"DIR\"",1],
      ["rawValue === \"\"",1],
      ["!Number.isSafeInteger(request.expectedBindingGeneration)",1],
      ["candidate.fd === \"txt\"",1],
      ["candidate.type === \"REG\"",1],
    ],
  },
  {
    file: "src/session/session-registry.ts",
    // verifySecret's stored-hash shape check.
    reason: "`typeof row.session_secret_hash === \"string\"` has no runtime effect its neighbouring regex does not already have, measured rather than argued: removing it leaves `SESSION_SECRET_HASH.test(row.session_secret_hash!)`, and for a NULL hash `RegExp.test` coerces its argument to the string \"null\", which the 64-hex pattern rejects — so `validStoredHash` is false either way and the row is refused with the same code. That mutant was run against a case built for exactly that input (a raw-inserted pre-migration row with a NULL hash) and SURVIVED. What the operand actually enforces is the type narrowing: without it the expression does not compile without a non-null assertion, which is what the surviving mutant had to add to get past `tsc`, so TypeScript is the enforcement site. Its sibling `SESSION_SECRET_HASH.test(...)` carries the runtime half and has a row of its own.",
    operands: [
      ["typeof row.session_secret_hash === \"string\"",1],
    ],
  },
  {
    file: "src/session/session-registry.ts",
    // verifySecret's stored-hash guard inside the refusal condition.
    reason: "`!validStoredHash` is defence in depth behind `!matches`, and the zero-buffer fallback is what makes it unkillable. When the stored hash is not a hash, `stored` is `Buffer.alloc(SESSION_SECRET_BYTES)` — all zeros — so `timingSafeEqual(expected, stored)` compares the presented secret's hash against 32 zero bytes and returns false. Removing this operand therefore denies on `!matches` for exactly the same inputs, with the same reason code. Killing it would require a secret whose SHA-256 is 32 zero bytes, which is a preimage rather than a test case. It is kept because the fallback and the guard are one decision: a later change making `stored` anything but constant zeros would make this operand load-bearing again, and the comparison it protects has no other check.",
    operands: [
      ["!validStoredHash",1],
    ],
  },
  {
    file: "src/session/session-registry.ts",
    // bindBuzzActor's terminal-lifecycle refusal.
    reason: "Both operands are unreachable from this call site, and the guard that pre-empts them is eleven lines up in the same file. `bindBuzzActor` begins with `this.verifySecret(input.sessionId, input.sessionSecret)` and returns on refusal; `verifySecret` already denies `SESSION_SECRET_INVALID` when `row.lifecycle` is STOPPED or ERROR. So `authenticated.value.lifecycle` cannot be terminal when this condition is evaluated, and both mutants were run against the existing actor-release case and SURVIVED — the measurement, not the argument. They are kept because the refusal they would produce is a different one (`SESSION_NOT_READY`, naming the lifecycle) and because the coupling to `verifySecret` is implicit: a future change that authenticated a terminal session on purpose, or split the secret check out, would make this the only check, and nothing would fail to say so.",
    operands: [
      ["authenticated.value.lifecycle === SessionLifecycle.STOPPED",1],
      ["authenticated.value.lifecycle === SessionLifecycle.ERROR",1],
    ],
  },
  {
    file: "src/session/session-registry.ts",
    // The catch that discriminates the actor-conflict error from every other throw.
    reason: "`isAcpError(err)` is enforced by TypeScript, not by a test: `err` is `unknown`, so removing the type guard makes the next two reads fail TS18046 and the harness refuses the mutant as uncompilable (measured: exit 2, three errors at 331:11 and 332). `err.reasonCode === ReasonCode.SESSION_BUZZ_ACTOR_ALREADY_BOUND` compiles when removed and SURVIVED, because this `db.run` can raise exactly one AcpError. The two constraints on `sessions.buzz_actor_id` map to different codes — the partial unique index to ALREADY_BOUND and `sessions_buzz_actor_immutable` to IMMUTABLE — but the statement's own `WHERE session_id = ? AND (buzz_actor_id IS NULL OR buzz_actor_id = ?)` pre-empts the trigger: a session already holding a different actor matches zero rows and is denied through the `changes !== 1` branch, so the trigger never fires from here. With one reachable code, no input distinguishes the equality. It stays because the trigger becomes reachable the moment that WHERE clause is widened, and then swallowing IMMUTABLE as ALREADY_BOUND would report a write-once violation as a contention.",
    operands: [
      ["isAcpError(err)",1],
      ["err.reasonCode === ReasonCode.SESSION_BUZZ_ACTOR_ALREADY_BOUND",1],
    ],
  },
  {
    file: "src/daemon/daemon.ts",
    // buzzMentionSubscriberFindings
    reason: "Neither operand can carry a row. `!receipt` cannot be mutated in isolation at all: removing it leaves `receipt` typed `| null`, and every later use of it fails TS18047, so the harness refuses the mutant as uncompilable — TypeScript is what enforces this one, not a test. `receipt.configuredIdentities === 0` compiles when removed but nothing can kill it: `setBuzzMentionReceipt` has one production caller, the agentcpd startup block, and it sets the receipt only behind `socketCount > 0`, so a receipt with zero configured identities cannot reach this line. It is defence for a caller that does not exist yet.",
    operands: [
      ["!receipt",1],
      ["receipt.configuredIdentities === 0",1],
    ],
  },
  {
    file: "src/daemon/agentcpd.ts",
    // The startup block that hands the subscriber's receipt to the daemon.
    reason: "Both operands need a daemon-startup fixture that reaches this block, and the listener-only tests do not have one. `startedSubscriber` is null on exactly one path — `startDaemonBuzzMentionSubscriberOrRefuse` swallowing a BuzzMentionBindingUnavailableError after dead-binding recovery left the role unbound — and `socketCount > 0` is false on exactly one other, the DISABLED handle returned when the Buzz config is absent. Each is reachable in production and neither is constructible from the unit level, so these are answers owed rather than claims of unkillability.",
    operands: [
      ["startedSubscriber",1],
      ["startedSubscriber.socketCount > 0",1],
    ],
  },
  {
    file: "src/registry/conversational-actor-registry.ts",
    // The two null-guards in front of the monotonic comparison.
    reason: "Neither guard has an independent witness, because the operand they protect cannot observe the difference. `validateGenerationInput` has already refused any actorGeneration that is not a positive safe integer, and for every positive n: `n <= null` is `n <= 0`, which is false, and `n <= undefined` is a NaN comparison, which is also false. So with either guard removed the denial is skipped on exactly the inputs it was skipped on before. The `undefined` case additionally cannot arise here — the query is `SELECT MAX(...)`, an aggregate, which returns a row even when the table is empty. Witnessing these would mean admitting a non-positive generation, which is the neighbouring invariant's job.",
    operands: [
      ["prior?.actor_generation !== null",1],
      ["prior?.actor_generation !== undefined",1],
    ],
  },
  {
    file: "src/daemon/agentcpd.ts",
    // startLocalMcpListeners
    reason: "Listener timeout validation is not isolated by the connection fixture: it starts with a valid timeout. An independent witness must distinguish fractional and nonpositive values before any listener is installed.",
    operands: [
      ["!Number.isInteger(handshakeTimeoutMs)",1],
      ["handshakeTimeoutMs <= 0",1],
    ],
  },
  {
    file: "src/daemon/agentcpd.ts",
    // startBuzzActorIngressListener
    reason: "Signing-policy validation precedes the actor listener fixture. Empty and absent secrets overlap the trim check; an independent witness must distinguish the intended configuration error from a later missing-secret failure.",
    operands: [
      ["!policy.secret",1],
      ["policy.secret.trim().length === 0",1],
    ],
  },
  {
    file: "src/daemon/agentcpd.ts",
    // startBuzzMessageIngressListener
    reason: "Signing-policy validation precedes the message fixture, which supplies a valid secret. Empty and absent secrets overlap the trim check; no independent configuration-error witness has been established.",
    operands: [
      ["!policy.secret",2],
      ["policy.secret.trim().length === 0",2],
    ],
  },
  {
    file: "src/daemon/agentcpd.ts",
    // buzzMentionSubscriberRegistry
    reason: "Subscriber routing needs independently controlled session ownership and role occupancy. The MCP/Buzz envelope fixture does not constitute a subscriber or exercise its null and non-primary alternatives.",
    operands: [
      ["!session",1],
      ["session.buzz_actor_id === null",1],
      // `!only` and `only.role !== Role.PRIMARY_CTO` used to be one `||` here and are two `if`s
      // now, so neither is an operand this census can see any more. They were split so each
      // refusal could name itself: a lookup that answered `null` four ways without saying which
      // cost a day of narrowing the live daemon from outside. The conditions still decide, and
      // `tests/unit/buzz-mention-subscriber.test.ts` drives each branch and requires it to print
      // its own reason, which is a stronger witness than the entry these two stood in for.
    ],
  },
  {
    file: "src/daemon/agentcpd.ts",
    // assertBuzzChannelMatchesSubscriberRooms
    reason: "This compares startup channel configuration with subscriber-room selection. The isolated message fixture has neither a subscriber-room set nor the answering-channel conflict needed to distinguish its operands.",
    operands: [
      ["!answeringBuzzChannel",1],
      ["subscriberRooms.length === 0",1],
    ],
  },
  {
    file: "src/daemon/agentcpd.ts",
    // startOperatorSocket
    reason: "Operator startup mixes token fallback, peer configuration and two deadlines. The focused MCP/message fixture does not start this separate operator service; no per-operand configuration or token-fallback witness has been established.",
    operands: [
      ["options.mcpToken?.trim()",1],
      ["process.env[\"ACP_MCP_TOKEN\"]?.trim()",1],
      ["mcpToken",1],
      ["token === mcpToken",1],
      ["credential.peerId.trim().length === 0",1],
      ["credential.actor.trim().length === 0",1],
      ["!Number.isInteger(handshakeTimeoutMs)",2],
      ["handshakeTimeoutMs <= 0",2],
      ["!Number.isInteger(requestTimeoutMs)",1],
      ["requestTimeoutMs <= 0",1],
    ],
  },
  {
    file: "src/daemon/agentcpd.ts",
    // operatorRequestMethod
    reason: "This private operator-envelope parser is upstream of operator authentication. Its falsy/type/array checks overlap; a witness must distinguish parser refusal from the later missing-method refusal, not merely observe a rejected request.",
    operands: [
      ["!value",1],
      ["typeof value !== \"object\"",1],
      ["Array.isArray(value)",1],
    ],
  },
  {
    file: "src/daemon/agentcpd.ts",
    // operatorRequestParams
    // The three `params` operands left this list on 2026-09-20: the adopted row
    // `delegation-operator-object-params-are-admissible` names the range that contains them, and a
    // debt that survives its row is reported as stale — correctly, since it would then claim an
    // answer is owed for something already answered.
    reason: "This private operator-parameter parser overlaps object and prototype checks. JSON transport cannot supply a custom prototype; independent in-process and wire witnesses have not been isolated.",
    operands: [
      ["!value",2],
      ["typeof value !== \"object\"",2],
      ["Array.isArray(value)",2],
      ["prototype === Object.prototype",1],
      ["prototype === null",1],
    ],
  },
  {
    file: "src/daemon/agentcpd.ts",
    // receive
    reason: "The launch receiver needs a pending credential with independently controlled expiration; the MCP receiver also routes attachment versus session credentials. The focused holder fixture proves session admission, not these launch/dispatch operands.",
    operands: [
      ["!launch",1],
      ["launch.expiresAtMs <= Date.now()",1],
      ["presented",1],
      ["typeof presented === \"object\"",1],
      ["\"attachmentId\" in presented",1],
    ],
  },
  {
    file: "src/daemon/agentcpd.ts",
    // launchExternalSessionId
    reason: "The launch parser is private and its object/type/length checks feed the same missing-launch refusal. No witness separates parser validation from lookup refusal without first arranging the pending launch channel.",
    operands: [
      ["!value",3],
      ["typeof value !== \"object\"",3],
      ["typeof externalSessionId === \"string\"",1],
      ["externalSessionId.length > 0",1],
    ],
  },
  {
    file: "src/daemon/agentcpd.ts",
    // presentedBuzzActorBinding
    reason: "The actor-binding envelope uses a separate listener and session-secret verification, not message ingress. Its per-field and optional-signature refusals have not been isolated from downstream binding authentication.",
    operands: [
      ["!value",4],
      ["typeof value !== \"object\"",4],
      ["typeof actor !== \"string\"",1],
      ["typeof sessionId !== \"string\"",1],
      ["typeof sessionSecret !== \"string\"",1],
      ["typeof nonce !== \"string\"",1],
      ["signature !== undefined",1],
      ["signature !== null",1],
      ["typeof signature !== \"string\"",1],
    ],
  },
  {
    file: "src/daemon/agentcpd.ts",
    // presentedBuzzMessage
    reason: "The outer falsy/object tests overlap downstream field validation. A malformed envelope is already incomplete when its required string fields are absent; no independent accepting witness for either outer operand was established.",
    operands: [
      ["!value",5],
      ["typeof value !== \"object\"",5],
    ],
  },
  {
    file: "src/daemon/agentcpd.ts",
    // authenticateSocketPeer
    reason: "Lifecycle and pending-handoff admission require READY/DRAINING/ineligible sessions and a pending normal handoff controlled independently. The focused identity fixtures hold lifecycle READY and have no handoff, so they cannot isolate these decisions.",
    operands: [
      ["session.value.lifecycle !== SessionLifecycle.READY",1],
      ["session.value.lifecycle !== SessionLifecycle.DRAINING",1],
      ["permitPendingHandoffAck",1],
      ["session.value.lifecycle === SessionLifecycle.READY",1],
    ],
  },
  {
    file: "src/daemon/agentcpd.ts",
    // currentPendingNormalHandoff
    reason: "The outgoing session/generation tuple is produced by the handoff transaction. An independent witness must vary its completeness or current binding without a neighbouring handoff invariant rejecting first; none is established here.",
    operands: [
      ["handoff.from_session_id === null",1],
      ["handoff.from_generation === null",1],
      ["!outgoing",1],
      ["outgoing.sessionId !== handoff.from_session_id",1],
      ["outgoing.bindingGeneration !== handoff.from_generation",1],
    ],
  },
  {
    file: "src/daemon/agentcpd.ts",
    // lifecyclePermitsBoundSocket
    reason: "This combines role and READY/DRAINING lifecycle policy at reauthentication. The admission fixture stays READY; it cannot distinguish draining CTO permission from refusal of another draining role.",
    operands: [
      ["lifecycle === SessionLifecycle.READY",1],
      ["lifecycle === SessionLifecycle.DRAINING",1],
      ["role === Role.PRIMARY_CTO",1],
    ],
  },
  {
    file: "src/daemon/agentcpd.ts",
    // reject
    reason: "This conjunction controls whether a refusal can still be written to a closing socket. It does not decide admission; a disconnect/write race is needed to isolate response delivery and is absent from the injected connection fixture.",
    operands: [
      ["respond",1],
      ["!socket.destroyed",1],
    ],
  },
  {
    file: "src/daemon/agentcpd.ts",
    // presentedCredential
    reason: "Credential shape validation feeds verifySecret, which also refuses missing or invalid credentials. Per-field parser-error witnesses, preserving the neighbouring narrowing and distinguishing authentication refusal, have not been isolated.",
    operands: [
      ["!value",6],
      ["typeof value !== \"object\"",6],
      ["typeof sessionId !== \"string\"",2],
      ["sessionId.length === 0",1],
      ["typeof sessionSecret !== \"string\"",2],
      ["sessionSecret.length === 0",1],
    ],
  },
  {
    file: "src/daemon/agentcpd.ts",
    // peerAuthenticator
    reason: "Pending-handoff reauthentication must compare the opening handoff with a later registry reading. The ordinary holder fixture never opens this path; no independent handoff ID/generation change witness is established.",
    operands: [
      ["!pending.allowed",1],
      ["pending.value.handoffId !== opening.handoffId",1],
      ["pending.value.fromGeneration !== opening.fromGeneration",1],
    ],
  },
  {
    file: "src/daemon/agentcpd.ts",
    // localMcpTokenMatches
    reason: "Token object shape and constant-time byte comparison overlap. The connection fixture presents a valid token; isolating null, non-object, absent-token, length and byte equality needs separate expected-refusal witnesses.",
    operands: [
      ["!value",7],
      ["typeof value !== \"object\"",7],
      ["!(\"token\" in value)",1],
      ["actualBytes.length === expectedBytes.length",1],
      ["timingSafeEqual(actualBytes, expectedBytes)",1],
    ],
  },
  {
    file: "src/daemon/agentcpd.ts",
    // processBuffer
    reason: "Operator framing first parses JSON and then checks envelope shape. The injected MCP/message receivers do not use this operator buffer; parser versus request-validation failure has not been isolated.",
    operands: [
      ["!parsed",1],
      ["typeof parsed !== \"object\"",1],
    ],
  },
  {
    file: "src/daemon/agentcpd.ts",
    // configuredBuzzActorIngressPolicy
    reason: "This assembles ingress policy from environment configuration. The listener fixtures pass an already-formed policy, so they do not isolate empty-secret versus empty-actor configuration.",
    operands: [
      ["secret.length === 0",1],
      ["allowedActors.length === 0",1],
    ],
  },
  {
    file: "src/daemon/agentcpd.ts",
    // pointerOn
    reason: "Delivery reads the durable outbox row and checks its message kind. The malformed-envelope tests stop before journaling; isolating absent row versus wrong kind needs a separately controlled outbox delivery fixture.",
    operands: [
      ["!row",1],
      ["row.kind !== MessageKind.OWNER_MESSAGE",1],
    ],
  },
  {
    file: "src/daemon/agentcpd.ts",
    // rolledBackClaim
    reason: "The rollback marker is private to the claim transaction. Its type/presence checks overlap, and a normal caller cannot construct the marked thrown object independently; no isolated refusal witness is established.",
    operands: [
      ["typeof err === \"object\"",1],
      ["err !== null",1],
      ["CLAIM_ROLLBACK in err",1],
    ],
  },
  {
    file: "src/daemon/agentcpd.ts",
    // main
    reason: "The module entrypoint combines canonical activation configuration and operator-identity fallback. The in-process listeners do not run main; no isolated startup configuration witness is established for these operands.",
    operands: [
      ["canonicalActivationPresentCount > 0",1],
      ["missingCanonicalActivation.length > 0",1],
      ["canonicalActivationPresentCount > 0",2],
      ["!canonicalBuzzChannelId",1],
      ["process.env[\"BUZZ_PRIVATE_KEY\"]",1],
      ["!buzzActorIngressPolicy",1],
      ["process.env[\"ACP_OPERATOR_ACTOR\"]?.trim()",1],
      ["process.env[\"USER\"]?.trim()",1],
      ["\"\"",1],
    ],
  },
  {
    file: "src/daemon/agentcpd.ts",
    // dispositionForStartupError
    reason: "Startup error classification determines whether to park or exit, after listener construction fails. The focused tests start successfully and do not supply independent typed and untyped startup failures.",
    operands: [
      ["!isAcpError(err)",1],
      ["err.reasonCode !== ReasonCode.SCHEMA_MIGRATION_NOT_APPROVED",1],
    ],
  },
  {
    file: "src/daemon/agentcpd.ts",
    // <module>
    reason: "This is the direct-execution/import dispatch condition, not a refusal predicate. Its operands need separate process-entrypoint observations; mutating a value in an imported unit test cannot establish that behaviour.",
    operands: [
      ["process.argv[1]",1],
      ["fileURLToPath(import.meta.url) === resolve(process.argv[1])",1],
    ],
  },
  {
    file: "src/daemon/daemon.ts",
    // canParkForBootstrap
    reason: "The every() operand contains nested finding-category predicates. Existing category anchors do not isolate the outer all-findings decision or these two categories; mixed blocking findings need an independent parking witness.",
    operands: [
      ["blockingFindings.every(\n    (finding) =>\n      finding.code.startsWith(\"ROLE_COVERAGE_\") ||\n      finding.code.startsWith(\"CAPACITY_\") ||\n      // A contradicted conversation meets this rule the moment a door exists that clears it,\n      // and until one did, the rule read as \"park for capacity\" rather than as what it says.\n      // Parking does not weaken the quarantine: a claim is refused by the ledger, not by the\n      // daemon's mode, so a parked daemon admits no new turn for that actor either.\n      finding.code.startsWith(\"CANONICAL_TURN_\") ||\n      // The CRITICAL that used to end the process. It is admitted here only because\n      // `OPERATOR_METHOD.BINDING_RECOVER_DEAD` exists to clear it: this entry and that method\n      // are one change and must not be separated. Alone, this line is the bypass — a daemon\n      // parking on a finding no reachable command can answer, waiting forever behind a held\n      // lock. Alone, that method is unreachable, because the door serving it only opens for a\n      // park this line has to permit.\n      //\n      // Parking is not admission. The daemon holds its lock, serves `BOOTSTRAP_OPERATOR_METHODS`\n      // and nothing else, runs no dispatch, no delivery timer and no continuity coordinator, and\n      // `parkForBootstrap` promotes only after the doctor itself stops blocking. A project that\n      // still owns live runs is refused by `BindingRegistry.revoke` and goes on blocking here,\n      // which is the property this must not cost.\n      finding.code === \"CTO_BINDING_POINTS_AT_DEAD_SESSION\",\n  )",1],
      ["finding.code.startsWith(\"ROLE_COVERAGE_\")",1],
      ["finding.code.startsWith(\"CAPACITY_\")",1],
    ],
  },
  {
    file: "src/daemon/daemon.ts",
    // handleOperatorRequest
    reason: "This conjunction selects the idempotency-cache path based on daemon mode, method and key. It does not itself deny; independent replay/cache observations across modes have not been isolated.",
    operands: [
      ["this.#mode !== \"BOOTSTRAP\"",1],
      ["OPERATOR_MUTATION_METHODS.has(request.method)",1],
      ["request.idempotencyKey",1],
    ],
  },
  {
    file: "src/daemon/daemon.ts",
    // executeOperatorRequest
    reason: "Operator dispatch includes bootstrap policy, optional argument validation and promotion after recovery. The connection fixture exercises none of these method-specific transactions; independent per-operand dispatch witnesses remain unestablished.",
    operands: [
      ["this.#mode === \"BOOTSTRAP\"",1],
      ["!BOOTSTRAP_OPERATOR_METHODS.has(request.method)",1],
      ["target !== undefined",1],
      ["target !== null",1],
      ["typeof target !== \"string\"",1],
      ["scope === \"system\"",1],
      ["target === undefined",1],
      ["state !== undefined",1],
      ["state !== null",1],
      ["!isRunState(state)",1],
      ["recovered.allowed",1],
      ["this.#mode === \"BOOTSTRAP\"",2],
      ["observed.allowed",1],
      ["this.#mode === \"BOOTSTRAP\"",3],
      ["resolved.allowed",1],
      ["this.#mode === \"BOOTSTRAP\"",4],
    ],
  },
  {
    file: "src/daemon/daemon.ts",
    // executeRepair
    reason: "Optional run-ID validation precedes repair lookup and execution. A malformed or absent run also affects those later steps; the parser refusal has not been isolated from repair admission.",
    operands: [
      ["runId !== undefined",1],
      ["runId !== null",1],
      ["typeof runId !== \"string\"",1],
    ],
  },
  {
    file: "src/daemon/daemon.ts",
    // registerProject
    reason: "Optional project-ID validation precedes manifest-based registration. An independent witness must preserve the manifest and authorization while varying the optional ID; no such operand-specific witness is established.",
    operands: [
      ["projectId !== undefined",1],
      ["projectId !== null",1],
      ["typeof projectId !== \"string\"",1],
    ],
  },
  {
    file: "src/daemon/daemon.ts",
    // start
    reason: "Startup retry timing, doctor status and bootstrap-door availability jointly select parking versus exit. The message/holder fixture never runs daemon startup; controlled clock and doctor-result witnesses remain unestablished.",
    operands: [
      ["priorFailures.retryNotBefore",1],
      ["Date.parse(priorFailures.retryNotBefore) > Date.parse(startedAt)",1],
      ["report.doctorStatus === \"BLOCKED\"",1],
      ["report.doctorStatus === \"ERROR\"",1],
      ["options.bootstrapDoor",1],
      ["canParkForBootstrap(report.blockingFindings)",1],
    ],
  },
  {
    file: "src/daemon/daemon.ts",
    // reconcile
    reason: "Dead-process reconciliation needs process identity and liveness varied separately from session/worker ownership. No independent OS-process witness is provided by the socket-free fixture.",
    operands: [
      ["session.osPid",1],
      ["!isAlive(session.osPid)",1],
      ["row.worker_process_id == null",1],
      ["!isAlive(row.worker_process_id)",1],
    ],
  },
  {
    file: "src/daemon/daemon.ts",
    // reconcileContinuity
    reason: "Capacity failover and restoration require controlled capacity, provider and committed holder snapshots. The current tests fix one READY holder and do not exercise this state transition, so its per-operand witnesses remain unestablished.",
    operands: [
      ["session !== null",1],
      ["this.cp.capacity.manages(session.provider)",1],
      ["session?.lifecycle === SessionLifecycle.READY",1],
      ["!active",1],
      ["!replacement",1],
      ["replacement.lifecycle !== SessionLifecycle.READY",1],
      ["replacement.provider !== failedOver.value.provider",1],
      ["active.bindingGeneration !== failedOver.value.generation",1],
      ["assignment.reason === \"preferred\"",1],
      ["this.cp.bindings.active(assignment.roleKey)?.mode === \"FALLBACK\"",1],
      ["restorationNeeded",1],
      ["unresolved.length === 0",1],
    ],
  },
  {
    file: "src/daemon/daemon.ts",
    // startTimers
    reason: "This disjunction decides whether a timer publishes progress after overdue/finalized work. It does not itself refuse; independent scheduling/publication observations have not been isolated.",
    operands: [
      ["tick.overdue.length > 0",1],
      ["finalized.length > 0",1],
    ],
  },
  {
    file: "src/daemon/daemon.ts",
    // telegramIngressFindings
    reason: "Telegram configured/running status is an external subscriber observation. The local Buzz fixture does not create this subscriber or isolate its diagnostic alternatives.",
    operands: [
      ["!status?.configured",1],
      ["status.running",1],
    ],
  },
  {
    file: "src/daemon/daemon.ts",
    // runPeriodic
    reason: "Retry presence and retry timestamp jointly suppress periodic work. No controlled-clock witness separates absent retry state from an unexpired retry here.",
    operands: [
      ["previous",1],
      ["Date.parse(previous.retryNotBefore) > Date.parse(now)",1],
    ],
  },
  {
    file: "src/daemon/daemon.ts",
    // parkForBootstrap
    reason: "Promotion compares doctor and subsequent sweep results. Independent BLOCKED/ERROR results at both stages need a parked-daemon fixture; the listener-only tests do not enter that loop.",
    operands: [
      ["doctorReport.status !== \"BLOCKED\"",1],
      ["doctorReport.status !== \"ERROR\"",1],
      ["swept.doctorStatus !== \"BLOCKED\"",1],
      ["swept.doctorStatus !== \"ERROR\"",1],
    ],
  },
  {
    file: "src/daemon/daemon.ts",
    // isAlive
    reason: "PID shape checks guard OS process probing. Number.isInteger and positivity overlap later process failures; no independent process-probe observation distinguishes these checks here.",
    operands: [
      ["!Number.isInteger(pid)",1],
      ["pid <= 0",1],
    ],
  },
  {
    file: "src/daemon/daemon.ts",
    // parseAuthenticatedOperatorPeer
    reason: "The operator peer is supplied by its authenticated socket service. Its channel and nonempty identity fields require an independent operator fixture; the focused MCP peer has a different credential shape.",
    operands: [
      ["!peer",1],
      ["peer.channel !== \"cli\"",1],
      ["peer.peerId.trim().length === 0",1],
      ["peer.actor.trim().length === 0",1],
      ["peer.incarnation.trim().length === 0",1],
    ],
  },
  {
    file: "src/daemon/daemon.ts",
    // parseOperatorRequest
    reason: "Operator request shape, allowlisted method and optional idempotency key overlap downstream dispatch. No exact parser-refusal witness with all neighbouring fields held valid has been isolated.",
    operands: [
      ["typeof requestId !== \"string\"",1],
      ["requestId.length === 0",1],
      ["typeof method !== \"string\"",1],
      ["!isOperatorMethod(method)",1],
      ["idempotencyKey !== undefined",1],
      ["typeof idempotencyKey !== \"string\"",1],
    ],
  },
  {
    file: "src/daemon/daemon.ts",
    // isPlainRecord
    reason: "Object/type/array/prototype checks overlap, and JSON cannot carry a custom prototype. No independent in-process witness separates these helper operands from outer operator-envelope checks.",
    operands: [
      ["typeof value !== \"object\"",1],
      ["value === null",1],
      ["Array.isArray(value)",1],
      ["prototype === Object.prototype",1],
      ["prototype === null",1],
    ],
  },
  {
    file: "src/daemon/daemon.ts",
    // requiredOperatorString
    reason: "Type and nonempty-string validation are private to operator dispatch. No per-parameter dispatch witness has isolated them from later semantic checks; a type mutation must also preserve narrowing.",
    operands: [
      ["typeof value === \"string\"",1],
      ["value.length > 0",1],
    ],
  },
  {
    file: "src/daemon/daemon.ts",
    // requiredOperatorInteger
    reason: "Number.isSafeInteger already rejects nonnumbers, so the type operand has no independent accepting witness. Safe-integer and minimum checks still need separate valid operator-dispatch fixtures; those are not established here.",
    operands: [
      ["typeof value === \"number\"",1],
      ["Number.isSafeInteger(value)",1],
      ["value >= minimum",1],
    ],
  },
  {
    file: "src/daemon/daemon.ts",
    // requiredOperatorIntegerList
    reason: "The integer-list parser overlaps array shape, nonemptiness, number type, safe-integer and positivity. Number.isSafeInteger masks type removal; the remaining cases require exact parameter-refusal witnesses absent from this fixture.",
    operands: [
      ["!Array.isArray(value)",1],
      ["value.length === 0",1],
      ["typeof entry !== \"number\"",1],
      ["!Number.isSafeInteger(entry)",1],
      ["entry < 1",1],
    ],
  },
  {
    file: "src/db/database.ts",
    // assertReadQuery
    reason: "SQL verb and table-info PRAGMA alternatives gate the database facade. The focused ingress tests read valid queries; they do not separately observe refusal of unsupported verbs versus acceptance of schema introspection.",
    operands: [
      ["[\"SELECT\", \"WITH\", \"EXPLAIN\"].includes(firstSqlVerb(sql))",1],
      ["TABLE_INFO_PRAGMA.test(sql)",1],
    ],
  },
  {
    file: "src/db/database.ts",
    // belongsTo
    reason: "These capability checks require a private #minted brand. A nonobject cannot carry that brand, so the shape guards have no independent well-typed accepting witness; isolating brand possession requires the class-specific capability issuance path.",
    operands: [
      ["typeof value !== \"object\"",1],
      ["value === null",1],
      ["!(#minted in value)",1],
      ["typeof value !== \"object\"",2],
      ["value === null",2],
      ["!(#minted in value)",2],
      ["typeof value !== \"object\"",3],
      ["value === null",3],
      ["!(#minted in value)",3],
    ],
  },
  {
    file: "src/db/database.ts",
    // <module>
    reason: "Database construction includes file-existence policy, requested/observed temp storage, and private SQL authorization markers. The in-memory fixture does not control filesystem/SQLite observations or expose each private marker field independently.",
    operands: [
      ["persistent",1],
      ["existsSync(filename)",1],
      ["this.options.temporaryStorage === \"MEMORY\"",1],
      ["temporaryStorage !== \"MEMORY\"",1],
      ["marker",1],
      ["marker.runId === runId",1],
      ["marker.toState === toState",1],
      ["marker",2],
      ["marker.turnRequestId === turnRequestId",1],
    ],
  },
  {
    file: "src/db/database.ts",
    // applySchema
    reason: "The zero-version/populated-database refusal needs a pre-existing populated version-zero copy. The focused tests build the current schema; neither operand has an independent startup fixture here.",
    operands: [
      ["version === 0",1],
      ["alreadyPopulated.n > 0",1],
    ],
  },
  {
    file: "src/db/database.ts",
    // guardSync
    reason: "This checks a transaction result for a thenable. Null/falsy results cannot have a callable then member; an independent witness must distinguish rollback on asynchronous completion from mere shape failure.",
    operands: [
      ["out",1],
      ["typeof (out as { then?: unknown }).then === \"function\"",1],
    ],
  },
  {
    file: "src/db/database.ts",
    // isAsyncTransactionError
    reason: "The async-transaction symbol is module-private and the object guards protect its access. A normal caller cannot independently supply the marked thrown object; no per-operand witness preserves its private marker while varying shape.",
    operands: [
      ["err",1],
      ["typeof err === \"object\"",1],
      ["ASYNC_TRANSACTION in err",1],
      ["(err as { [ASYNC_TRANSACTION]?: unknown })[ASYNC_TRANSACTION] === true",1],
    ],
  },
  {
    file: "src/db/database.ts",
    // isTxDenialSignal
    reason: "The denial symbol is module-private and its shape guards overlap symbol membership. No independent well-typed accepting witness exists for a nonobject carrying that symbol; transaction rollback is broader than an operand test.",
    operands: [
      ["err",2],
      ["typeof err === \"object\"",2],
      ["TX_DENIAL in err",1],
    ],
  },
  {
    file: "src/db/database.ts",
    // translate
    reason: "These alternatives preserve non-Errors and already-typed ACP errors. The focused tests do not isolate error translation identity from the downstream message-to-reason-code mapping.",
    operands: [
      ["!(err instanceof Error)",1],
      ["isAcpError(err)",1],
    ],
  },
  {
    file: "src/db/database.ts",
    // versionFromDescriptor
    reason: "Header length and SQLite magic need separate descriptor byte fixtures; a short zero-filled header also fails the magic comparison. No independent descriptor witness was established for these checks.",
    operands: [
      ["read < SQLITE_HEADER_BYTES",1],
      ["header.toString(\"latin1\", 0, 16) !== SQLITE_MAGIC",1],
    ],
  },
  {
    file: "src/db/database.ts",
    // assertNotTheDeploymentsOwnDatabase
    reason: "Device and inode identity must be varied independently against the deployment database. A real same-inode/different-device pair is not supplied by this workspace; a controlled identity fixture is required before either operand can be credited.",
    operands: [
      ["canonical.device === target.device",1],
      ["canonical.inode === target.inode",1],
    ],
  },
  {
    file: "src/db/database.ts",
    // assertApprovedCopyIdentity
    reason: "Approval version endpoints and ordered migration IDs must be varied after descriptor/approval authentication succeeds. The in-memory fixture has no approved-copy transaction, so the individual comparisons are not isolated.",
    operands: [
      ["approval.fromVersion !== expected.fromVersion",1],
      ["approval.toVersion !== expected.toVersion",1],
      ["approval.migrations.length !== expected.migrations.length",1],
      ["approval.migrations.some((id: string, index: number) => id !== expected.migrations[index])",1],
    ],
  },
  {
    file: "src/db/database.ts",
    // migrateApprovedCopy
    reason: "Sidecar state, checkpoint mode, diagnostic fallback and applied-receipt order depend on a descriptor-bound migration. The in-memory fixture supplies none of those independent observations; some operands only format an error rather than decide refusal.",
    operands: [
      ["existsSync(sidecar)",1],
      ["statSync(sidecar).size > 0",1],
      ["mode === \"wal\"",1],
      ["mode === \"\"",1],
      ["mode",1],
      ["\"nothing\"",1],
      ["receipts.length !== planned.length",1],
      ["receipts.some((receipt, index) => receipt.id !== planned[index])",1],
    ],
  },
  {
    file: "src/mcp/role-conversation.ts",
    // attach
    reason: "Absent peer session/incarnation is also rejected by #isCurrentHolder equality against a real nonempty holder. With the other checks intact, no independent admission witness for either preliminary truthiness operand was established.",
    operands: [
      ["!peer.sessionId",1],
      ["!peer.sessionIncarnation",1],
    ],
  },
  {
    file: "src/mcp/role-conversation.ts",
    // wake
    reason: "These socket error-code alternatives classify ECONNRESET/EPIPE as a lost peer. The socket-free ownership fixture does not deliver wake traffic or generate either independent transport error.",
    operands: [
      ["error.code === \"ECONNRESET\"",1],
      ["error.code === \"EPIPE\"",1],
    ],
  },
  {
    file: "src/session/binding-registry.ts",
    // resolveRoleKey
    reason: "Scope, ancestor scope and role-key consistency are validated together before bind. No fixture here varies each field while preserving the related scope/registry invariants, so individual rejection witnesses remain unestablished.",
    operands: [
      ["scope !== \"none\"",1],
      ["!required[scope]",1],
      ["scope === \"run\"",1],
      ["name === \"project\"",1],
      ["scope === \"task\"",1],
      ["name === \"run\"",1],
      ["name === \"project\"",2],
      ["input.roleKey",1],
      ["input.roleKey !== derived",1],
      ["previous",1],
      ["previous.role !== input.role",1],
    ],
  },
  {
    file: "src/session/binding-registry.ts",
    // bind
    reason: "Binding combines reviewer independence, authenticated target identity and receipt persistence. The simple holder fixture supplies a primary role without a target receipt; it cannot isolate the reviewer and attestation operands.",
    operands: [
      ["input.role === \"BLIND_REVIEWER\"",1],
      ["input.runId",1],
      ["!claimedTarget",1],
      ["!authenticated",1],
      ["!this.sameTarget(authenticated, claimedTarget)",1],
      ["input.authenticatedTarget",1],
      ["targetBinding.value",1],
    ],
  },
  {
    file: "src/session/binding-registry.ts",
    // switchTo
    reason: "Takeover combines expected generation, target attestation, conversation survival and live execution ownership. Independent committed/rollback witnesses must vary those dimensions without a neighbouring registry refusal; none is established for these operands here.",
    operands: [
      ["input.expectedCurrentGeneration !== undefined",1],
      ["current?.bindingGeneration !== input.expectedCurrentGeneration",1],
      ["effectiveConversation === \"SURVIVED\"",1],
      ["input.requireCurrentTargetAttestation",1],
      ["current",1],
      ["effectiveConversation === \"REPLACED\"",1],
      ["orphaned.length > 0",1],
      ["!input.takeover",1],
      ["input.role === \"BLIND_REVIEWER\"",2],
      ["input.runId",2],
      ["current",2],
      ["input.takeover",1],
    ],
  },
  {
    file: "src/session/binding-registry.ts",
    // producerHistory
    reason: "History requires a complete dispatched owner tuple and a producer-role binding. Normal writes establish those fields together; no independent incomplete-tuple or nonproducer-history fixture is established here.",
    operands: [
      ["!run.dispatched_at",1],
      ["!run.owner_session_id",1],
      ["run.owner_binding_generation === null",1],
      ["!run.owner_role_key",1],
      ["!owner",1],
      ["!PRODUCER_ROLES.includes(owner.role)",1],
    ],
  },
  {
    file: "src/session/binding-registry.ts",
    // workerProducerHistory
    reason: "Worker history compares session and OS process provenance. The focused holder fixture launches no worker and has no independently controlled bound/process worker sets.",
    operands: [
      ["execution.worker_process_id === null",1],
      ["workerProcessIdentity === null",1],
      ["!execution.worker_session_id",1],
      ["boundWorkers.length === 0",1],
      ["processWorkers.length === 0",1],
    ],
  },
  {
    file: "src/session/binding-registry.ts",
    // assertFinalCeoIndependence
    reason: "The filter includes three producer roles before comparing session identity. No dispatched producer-history fixture here independently witnesses each role alternative and the final CEO overlap.",
    operands: [
      ["b.role === \"PRIMARY_CTO\"",1],
      ["b.role === \"BOOTSTRAP_CTO\"",1],
      ["b.role === \"BLIND_REVIEWER\"",1],
      ["b.sessionId === ceoSessionId",1],
    ],
  },
  {
    file: "src/session/binding-registry.ts",
    // currentHermesTargetBindReceipt
    reason: "The current receipt comes from persisted attestation history; absence and digest mismatch share refusal. No controlled receipt-row witness holds the surrounding actor/generation identity valid while varying only this comparison.",
    operands: [
      ["!receipt",1],
      ["receipt.receipt_digest !== row.attestation_digest",1],
    ],
  },
  {
    file: "src/session/binding-registry.ts",
    // historicalHermesTargetBindReceipt
    reason: "Historical runtime identity, serialized receipt and digest must agree. The focused fixture has no verified Hermes target history and cannot independently vary these durable fields.",
    operands: [
      ["row.target_bind_receipt_json === null",1],
      ["row.target_bind_executor_runtime_identity === null",1],
      ["!receipt",2],
      ["receipt.receipt_digest !== row.attestation_digest",2],
    ],
  },
  {
    file: "src/session/binding-registry.ts",
    // authenticateBoundSession
    reason: "Binding presence, session and generation are checked after authentication. The admission fixture exercises the separate socket path, not this registry method; no exact registry-refusal witness was isolated.",
    operands: [
      ["!binding",1],
      ["binding.sessionId !== input.sessionId",1],
      ["binding.bindingGeneration !== input.bindingGeneration",1],
    ],
  },
  {
    file: "src/session/binding-registry.ts",
    // sameTarget
    reason: "Executor kind, locator and locator digest are produced together by target attestation. No independent target pair was established with just one unequal component while the others remain valid.",
    operands: [
      ["left.executorKind === right.executorKind",1],
      ["left.targetLocator === right.targetLocator",1],
      ["left.targetLocatorDigest === right.targetLocatorDigest",1],
    ],
  },
  {
    file: "src/session/binding-registry.ts",
    // validateHermesTargetBindReceipt
    reason: "Runtime identity type/nonemptiness is downstream of verified target issuance. No independent authenticated receipt fixture here separates this validation from earlier target refusal.",
    operands: [
      ["typeof expectedExecutorRuntimeIdentity !== \"string\"",1],
      ["expectedExecutorRuntimeIdentity.length === 0",1],
    ],
  },
  {
    file: "src/session/binding-registry.ts",
    // parseHermesTargetBindReceipt
    reason: "Receipt shape, exact keyset and canonical field/digest validation overlap. No per-field counterexample with all preceding and neighbouring receipt requirements satisfied was isolated; whole-receipt rejection cannot credit each operand.",
    operands: [
      ["input === null",1],
      ["typeof input !== \"object\"",1],
      ["Array.isArray(input)",1],
      ["keys.length !== HERMES_TARGET_BIND_RECEIPT_KEYS.length",1],
      ["HERMES_TARGET_BIND_RECEIPT_KEYS.some((key) => !Object.hasOwn(record, key))",1],
      ["record.domain !== \"hermes.target-bind\"",1],
      ["record.version !== 1",1],
      ["record.actor_id !== expected.actorId",1],
      ["record.binding_generation !== expected.generation",1],
      ["record.requested_session_id !== expected.requestedSessionId",1],
      ["record.lineage_root_digest !== expected.lineageRootDigest",1],
      ["expected.executorRuntimeIdentity !== undefined",1],
      ["record.executor_runtime_identity !== expected.executorRuntimeIdentity",1],
      ["typeof record.executor_runtime_identity !== \"string\"",1],
      ["record.executor_runtime_identity.length === 0",1],
      ["!Number.isSafeInteger(record.binding_generation)",1],
      ["!isDigest(record.lineage_root_digest)",1],
      ["!isDigest(record.receipt_digest)",1],
    ],
  },
  {
    file: "src/cli/attach-relay.ts",
    // performClaim, receipt body and receipt value shape
    reason: "NO WITNESS. The field checks below refuse the same inputs. A number, a string or an array body reaches finish({malformed}) through typeof value.sessionId !== \"string\" after the cast, and a non-object value reaches it the same way, so removing either operand changes no observable. Measured one operand at a time against nineteen inputs covering every non-object JSON body and value: only the null cases differ, and those are the operands beside these, which carry rows.",
    operands: [
      ["typeof parsed !== \"object\"",1],
      ["Array.isArray(parsed)",1],
      ["typeof value !== \"object\"",1],
    ],
  },
  {
    file: "src/cli/attach-relay.ts",
    // classifyFirstLine, null and non-object first lines
    // This entry is NOT "no witness was found". The witness exists and runs; what does not exist
    // is a mutation that isolates these operands. The two read the same in a census listing and
    // mean opposite things, so the reason names the test and the exact obstruction.
    reason: "WITNESSED BUT NOT ISOLABLE. The witness is tests/unit/attach-relay.test.ts :: \"forwards a first line that is not an object as client traffic, never as a refusal to parse\", which drives a first line of null and of 42 and asserts each is forwarded to the client verbatim; without either operand that test fails, because the following `\"jsonrpc\" in parsed` throws on both. No row can credit them: these operands ARE the narrowing that `in` depends on, so the isolated mutant does not type-check (removing !parsed gives TS18047 'parsed is possibly null'; removing the typeof gives TS2638), and the smallest mutation that does compile spans Array.isArray(parsed) as well, which has no witness of its own and would be credited without one.",
    operands: [
      ["!parsed",2],
      ["typeof parsed !== \"object\"",2],
    ],
  },
  {
    file: "src/cli/attach-relay.ts",
    // classifyFirstLine, array first line
    reason: "NO WITNESS. An array first line reaches the same traffic outcome through body.ok !== false below — [1].ok is undefined, which is not false — so removing this operand changes no observable. Measured by removing it alone and diffing nineteen inputs against a recorded baseline, not inferred.",
    operands: [
      ["Array.isArray(parsed)",2],
    ],
  },
  {
    file: "src/daemon/canonical-self-claim-listener.ts",
    // rawFd, the socket handle itself
    // This entry is not "a test was not written". No input reaches the branch AND no row could
    // credit it if one did, so both halves are stated: an absence of reach, and an obstruction.
    reason: "NO WITNESS AND NOT ISOLABLE. `_handle` is non-null on every socket this listener is handed \u2014 measured on a real AF_UNIX accept, where it is an object whose `fd` is a number \u2014 and becomes null only after `destroy()`, which no peer can cause before the connection listener runs. There is therefore no input that reaches the null branch and no test that drives it. Nor could a row credit this operand if one did: the isolated mutant does not type-check (removing `handle &&` gives TS18049 \"'handle' is possibly 'null' or 'undefined'\" at both reads on that line), and the smallest mutation that does compile spans `typeof handle.fd === \"number\"` beside it, which has no witness of its own and would be credited without one.",
    operands: [
      ["handle",1],
    ],
  },
  {
    file: "src/daemon/canonical-self-claim-listener.ts",
    // rawFd, the shape of the handle's fd field
    reason: "NO WITNESS. `_handle.fd` is a number on every socket this platform hands the listener \u2014 measured on a real AF_UNIX accept: `typeof _handle.fd` is \"number\". This operand defends against a Node-internal shape reached through a cast (Node exposes no public API for a socket's raw fd), and no reachable input produces a handle whose `fd` is not a number, so removing it changes no observable. Measured, not inferred: the isolated mutant `return handle ? handle.fd : null;` compiles under `tsc --noEmit` and the three canonical self-claim listener suites pass 27 of 27 against it.",
    operands: [
      ["typeof handle.fd === \"number\"",1],
    ],
  },
  {
    file: "src/daemon/canonical-self-claim-listener.ts",
    // serveCanonicalSelfClaimConnection, the params falsiness check
    reason: "NO WITNESS. The `?? {}` on the line above absorbs both nullish values, so `rawParams` is never null or undefined here; every remaining falsy JSON value \u2014 false, 0, -0 and the empty string \u2014 has a typeof of boolean, number or string, so `typeof rawParams !== \"object\"` beside it is true whenever this operand is. Removing it changes no observable. Measured one operand at a time over all fifteen JSON-expressible params shapes (absent, null, 0, -0, 1, -1, 1.5, \"\", \"x\", false, true, [], [1], {}, {a:1}): zero differ.",
    operands: [
      ["!rawParams",1],
    ],
  },
  {
    file: "src/ceo/cto-binding-delegation.ts",
    // the parse-result discriminants on the principal and the request
    reason: "TYPESCRIPT IS THE GUARD, not a test. #975's rows for these (`delegation-grant-parsed-scope`, `delegation-parsed-request-is-admissible`, `durable-request-preflight-opens-fence`) produced only uncompilable mutants and were removed. Each operand is the discriminant of a parse result, and the statements below read `.data` from it: remove or invert one and the narrowing that makes `.data` reachable is gone, so the mutant fails to typecheck rather than failing a test. What is owed is a witness that the *refusal* is reported correctly -- that a malformed request is denied with its own reason rather than folded into the neighbouring one -- and no fixture distinguishes that today. Four siblings stood here until the owner gate was removed: the discriminants on a grant scope and an owner receipt, which no longer have a scope or a receipt to parse.",
    operands: [
      ["!principal.success",1],
      ["!parsed.success",1],
      // Occurrence 2 is the release door, which parses the same principal against its own request
      // schema and reads `.data` from both the same way. The debt is the identical one, so it is
      // listed under the identical reason rather than given a second wording that could drift.
      ["!principal.success",2],
      ["!parsed.success",2],
    ],
  },
  {
    file: "src/ceo/cto-binding-delegation.ts",
    // the release's "there is a binding to remove" guard
    reason: "TYPESCRIPT IS THE GUARD, not a test. `bindings.active(roleKey)` returns `RoleBinding | null`, and the operand beside this one reads `current.bindingGeneration` while the body below reads `current.sessionId`. Removing `!current` leaves those reads on a possibly-null value and the mutant fails to typecheck (measured: four TS18047 errors, at the sibling comparison and at all three later reads), so a row claiming a test proves it would be claiming the wrong thing. The behaviour itself is witnessed — `tests/unit/cto-binding-delegation.test.ts::releases the binding it names` asks for a release before anything is bound and requires a refusal — but that case is killed by the sibling generation comparison too, so it does not isolate this operand.",
    operands: [
      ["!current",1],
    ],
  },
  {
    file: "src/daemon/agentcpd.ts",
    // New incumbent-adoption configuration and ingress checks. Existing scenario, CLI and
    // operator-socket tests cover refusals, not independent removal of every operand here.
    reason: "NO INDEPENDENT MUTATION WITNESS. Adoption configuration and operator ingress reject invalid input or lost authority, but the current tests have not shown that removing this individual operand changes an asserted outcome. Preserve the guard; do not claim per-operand coverage from a nearby refusal test.",
    operands: [
      ["typeof value === \"string\"",1],
      ["value.trim() === value",1],
      ["value.length > 0",1],
      ["value.length <= 512",1],
      ["!/[\\x00-\\x1f\\x7f]/.test(value)",1],
      ["!HERMES_ADOPTION_VARS.every((key) => validText(values[key]))",1],
      ["!isDigest(values.ACP_HERMES_LINEAGE_ROOT_DIGEST)",1],
      ["!/^[\\x21-\\x7e]+$/.test(values.ACP_HERMES_GATEWAY_API_KEY ?? \"\")",1],
      ["ports.authorityHeld",1],
      ["!ports.authorityHeld()",1],
      ["ports.authorityHeld",2],
      ["!ports.authorityHeld()",2],
      ["ports.authorityHeld",3],
      ["!ports.authorityHeld()",3],
      ["!params",1],
      ["Object.keys(params).length !== 0",1],
    ],
  },
  {
    file: "src/bootstrap/hermes-incumbent-adoption.ts",
    reason: "NO INDEPENDENT MUTATION WITNESS. The adoption scenarios exercise refusal and successful adoption, but have not established that removing this individual operand changes an asserted outcome. These exact operands remain unanswered, not tested; new operands must be accounted for separately.",
    operands: [
      ["!proof",1],
      ["!Number.isSafeInteger(proof.process_pid)",1],
      ["proof.process_pid <= 0",1],
      ["!expectedLiveSessionId",1],
      ["proof.session_id !== expectedLiveSessionId",1],
      ["proof.lineage_root_digest !== options.target.lineageRootDigest",1],
      ["proof.process_pid !== request.gatewayPid",1],
      ["proof.process_started_at !== request.gatewayStartToken",1],
      ["!proof.process_started_at",1],
      ["readProcessStartToken(proof.process_pid) !== proof.process_started_at",1],
      ["!startedAt",1],
      ["readProcessStartToken(proof.process_pid) !== proof.process_started_at",2],
      ["!previous",1],
      ["previous.status !== \"REVOKED\"",1],
      ["!actor",1],
      ["actor.kind !== Role.CEO",1],
      ["actor.retired_at !== null",1],
      ["actor.current_session_id !== previous.session_id",1],
      ["actor.current_session_incarnation !== previous.session_incarnation",1],
      ["lineage",1],
      ["lineage.executor_kind !== \"hermes\"",1],
      ["lineage.target_locator_digest !== proof.lineage_root_digest",1],
      ["lineage.target_locator !== options.target.sessionId",1],
      ["!incumbent",1],
      ["incumbent.incarnation !== previous.session_incarnation",1],
      ["probeSessionLiveness(incumbent.osPid, incumbent.osProcessStartedAt) !== \"DEAD\"",1],
      ["!current",1],
      ["current.session_id !== expectedLiveSessionId",1],
      ["current.lineage_root_digest !== proof.lineage_root_digest",1],
      ["current.process_pid !== proof.process_pid",1],
      ["current.process_started_at !== proof.process_started_at",1],
      ["readProcessStartToken(proof.process_pid) !== proof.process_started_at",3],
      ["cp.bindings.active(\"CEO\")",1],
      ["!latest",1],
      ["latest.actor_id !== previous.actor_id",1],
      ["latest.binding_generation !== previous.binding_generation",1],
      ["latest.session_id !== previous.session_id",1],
      ["latest.session_incarnation !== previous.session_incarnation",1],
      ["latest.status !== \"REVOKED\"",1],
      ["!servingActor",1],
      ["servingActor.kind !== Role.CEO",1],
      ["servingActor.retired_at !== null",1],
      ["servingActor.current_session_id !== previous.session_id",1],
      ["servingActor.current_session_incarnation !== previous.session_incarnation",1],
      ["!ready.allowed",1],
      ["!created.sessionSecret",1],
      ["!cp.sessions.verifySecret(created.sessionId, created.sessionSecret).allowed",1],
      ["restored?.actor_id !== previous.actor_id",1],
      ["serving?.current_session_id !== created.sessionId",1],
      ["serving.current_session_incarnation !== created.incarnation",1],
      ["active?.assignmentId !== binding.value.assignmentId",1],
    ],
  },
  {
    file: "src/runtime/hermes-gateway-identity.ts",
    reason: "NO INDEPENDENT MUTATION WITNESS. Gateway reader tests exercise envelope validation and failures, but have not established that removing this individual operand changes an asserted outcome. These exact operands remain unanswered, not tested; new operands must be accounted for separately.",
    operands: [
      ["!value",1],
      ["typeof value !== \"object\"",1],
      ["Array.isArray(value)",1],
      ["typeof record.session_id === \"string\"",1],
      ["record.session_id.length > 0",1],
      ["record.session_id.length <= 512",1],
      ["!/[\\x00-\\x1f\\x7f]/.test(record.session_id)",1],
      ["isDigest(record.lineage_root_digest)",1],
      ["typeof record.process_pid === \"number\"",1],
      ["Number.isSafeInteger(record.process_pid)",1],
      ["record.process_pid > 0",1],
      ["typeof record.process_started_at === \"string\"",1],
      ["record.process_started_at.length > 0",1],
      ["record.process_started_at.length <= 256",1],
      ["!/[\\x00-\\x1f\\x7f]/.test(record.process_started_at)",1],
      ["typeof options.apiKey !== \"string\"",1],
      ["!/^[\\x21-\\x7e]+$/.test(options.apiKey)",1],
      ["!Number.isSafeInteger(port)",1],
      ["port < 1",1],
      ["port > 65535",1],
      ["res.statusCode !== 200",1],
      ["(res.headers[\"content-type\"] ?? \"\").split(\";\")[0]?.trim().toLowerCase() !== \"application/json\"",1],
      ["Number(res.headers[\"content-length\"] ?? 0) > MAX_BYTES",1],
    ],
  },
];

export const UNANSWERED = new Map(groups.flatMap(({ file, reason, operands }) =>
  operands.map(([text, occurrence]) => [`${file}::${text}::${occurrence}`, reason]),
));
