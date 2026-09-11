/**
 * Every remaining unisolated operand in the six source files touched by #804.
 * These are answers owed, not claims of unkillability or completed coverage. Each reason states
 * the missing independent witness or the neighbouring invariant that masks removal.
 * The 89-file backlog lives separately in refusal-operand-exclusions.mjs.
 *
 * Entries name source text and its occurrence, never a line coordinate. Identical new operands
 * exceed the recorded occurrences and fail. Remove an entry when its row is established.
 * sol-simplify: requested explicit operand debts; remove each when an independent row replaces it.
 */
const groups = [
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
      ["!only",1],
      ["only.role !== Role.PRIMARY_CTO",1],
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
    reason: "This private operator-parameter parser overlaps object and prototype checks. JSON transport cannot supply a custom prototype; independent in-process and wire witnesses have not been isolated.",
    operands: [
      ["!value",2],
      ["typeof value !== \"object\"",2],
      ["Array.isArray(value)",2],
      ["!params",1],
      ["typeof params !== \"object\"",1],
      ["Array.isArray(params)",1],
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
    file: "src/session/role-attachment-credentials.ts",
    // issue
    reason: "issueSchema requires approvalSchema and returns before this line if approval is absent. After successful parsing approval is always an object, so !approval has no independent input witness without also bypassing the preceding schema.",
    operands: [
      ["!approval",1],
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
];

export const UNANSWERED = new Map(groups.flatMap(({ file, reason, operands }) =>
  operands.map(([text, occurrence]) => [`${file}::${text}::${occurrence}`, reason]),
));
