import Foundation
import Darwin
import AppKit
import LocalAuthentication
import Security

// Fixed one-request UDS transport. Production never accepts an endpoint in input/argv/env.
func submitOwner(_ scope: OwnerScope, _ bearer: Data, socketPath: String) throws -> String {
    var metadata = stat()
    guard lstat(socketPath, &metadata) == 0, metadata.st_mode & S_IFMT == S_IFSOCK,
          metadata.st_uid == getuid(), metadata.st_mode & 0o077 == 0 else { throw OwnerFailure.transport }
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw OwnerFailure.transport }
    defer { close(fd) }
    var timeout = timeval(tv_sec: 10, tv_usec: 0)
    var one: Int32 = 1
    guard setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout))) == 0,
          setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout.size(ofValue: timeout))) == 0,
          setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout.size(ofValue: one))) == 0 else { throw OwnerFailure.transport }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(socketPath.utf8) + [0]
    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw OwnerFailure.transport }
    withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
    let size = socklen_t(MemoryLayout.size(ofValue: address))
    address.sun_len = UInt8(size)
    let connected = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, size) }
    }
    var uid: uid_t = 0; var gid: gid_t = 0
    guard connected == 0, getpeereid(fd, &uid, &gid) == 0, uid == getuid() else { throw OwnerFailure.transport }
    var current = stat()
    guard lstat(socketPath, &current) == 0, current.st_dev == metadata.st_dev,
          current.st_ino == metadata.st_ino, current.st_mode == metadata.st_mode,
          current.st_uid == metadata.st_uid else { throw OwnerFailure.transport }
    guard let token = String(data: bearer, encoding: .utf8), !token.isEmpty,
          token.utf8.allSatisfy({ $0 >= 33 && $0 <= 126 }) else { throw OwnerFailure.keychain }
    var frame = try JSONSerialization.data(withJSONObject: ["token": token,
        "method": "ctoBinding.approveAndDelegate",
        "params": ["scope": scope.payload, "requestId": UUID().uuidString.lowercased()]])
    frame.append(10)
    defer { frame.resetBytes(in: 0..<frame.count) }
    try frame.withUnsafeBytes { raw in
        var sent = 0
        while sent < raw.count {
            let n = Darwin.send(fd, raw.baseAddress!.advanced(by: sent), raw.count - sent, 0)
            guard n > 0 else { throw OwnerFailure.transport }; sent += n
        }
    }
    guard shutdown(fd, SHUT_WR) == 0 else { throw OwnerFailure.transport }
    var reply = Data(); var buffer = [UInt8](repeating: 0, count: 1024)
    while true {
        let n = recv(fd, &buffer, buffer.count, 0)
        guard n >= 0 else { throw OwnerFailure.transport }
        if n == 0 { break }
        guard reply.count + n <= 8192 else { throw OwnerFailure.denied }
        reply.append(contentsOf: buffer.prefix(n))
    }
    guard let result = try JSONSerialization.jsonObject(with: reply) as? [String: Any],
          (result["allowed"] as? Bool) == true,
          let value = result["value"] as? [String: Any],
          let returnedScope = value["scope"] as? [String: String], returnedScope == scope.payload,
          let receipt = value["delegationId"] as? String, UUID(uuidString: receipt) != nil else { throw OwnerFailure.denied }
    return receipt
}

// Immutable, closed nonsecret scope shared by the dialog and wire payload.
struct OwnerScope {
    let payload: [String: String]
    init(_ input: Data, now: Date) throws {
        let keys: Set<String> = ["projectId", "role", "action", "ceoActorId", "ceoSessionId",
                                 "ceoIncarnation", "expiresAt", "revokePolicy"]
        guard input.count <= 8192,
              let object = try JSONSerialization.jsonObject(with: input) as? [String: String],
              Set(object.keys) == keys,
              object.values.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 256 && $0.utf8.allSatisfy({ $0 >= 33 && $0 <= 126 }) }),
              object["role"] == "PRIMARY_CTO", object["action"] == "bind-or-rebind",
              object["revokePolicy"] == "owner-or-ceo-loss" else { throw OwnerFailure.scope }
        let format = ISO8601DateFormatter()
        format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let expiry = format.date(from: object["expiresAt"]!), expiry > now else { throw OwnerFailure.scope }
        payload = object
    }
    var display: String {
        """
        Project: \(payload["projectId"]!)
        Role: PRIMARY_CTO
        Action: reusable CEO → CTO bind/rebind (bind-or-rebind)
        Canonical CEO actor: \(payload["ceoActorId"]!)
        CEO principal/session: \(payload["ceoSessionId"]!)
        CEO incarnation: \(payload["ceoIncarnation"]!)
        Expires at: \(payload["expiresAt"]!)
        Revocation: owner revocation or loss/change of the canonical CEO assignment.
        Survives daemon restart only while that same CEO assignment remains valid.
        This delegates CTO binding only; it does not delegate owner authority.
        """
    }
}

// One synchronous, child-owned chain; callers never receive a credential.
func executeOwner(input: Data, now: () -> Date,
                  confirm: (OwnerScope) throws -> Bool,
                  authenticate: (OwnerScope) throws -> Bool,
                  readBearer: () throws -> Data,
                  submit: (OwnerScope, Data) throws -> String) -> String {
    do {
        let scope = try OwnerScope(input, now: now())
        guard try confirm(scope), try authenticate(scope) else { throw OwnerFailure.cancelled }
        _ = try OwnerScope(input, now: now()) // Expiry may have passed while the human answered.
        var bearer = try readBearer()
        defer { bearer.resetBytes(in: 0..<bearer.count) }
        guard !bearer.isEmpty, bearer.count <= 4096 else { throw OwnerFailure.keychain }
        _ = try OwnerScope(input, now: now())
        let receipt = try submit(scope, bearer)
        guard let uuid = UUID(uuidString: receipt) else { throw OwnerFailure.denied }
        return "GRANTED " + uuid.uuidString.lowercased()
    } catch let failure as OwnerFailure { return failure.rawValue }
    catch { return OwnerFailure.denied.rawValue }
}

#if !OWNER_AUTH_TEST
@main
struct NativeOwnerAuth {
    static func main() {
        // No arguments, endpoint overrides, credential subprocess, or alternate authentication mode.
        guard CommandLine.arguments.count == 1, getuid() == geteuid(), let pw = getpwuid(getuid()) else {
            print("SCOPE_INVALID"); exit(1)
        }
        let socketPath = String(cString: pw.pointee.pw_dir) + "/.agent-control-plane/agentcpd.operator.sock"
        var input = Data()
        var part = [UInt8](repeating: 0, count: 1024)
        while true {
            var wait = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)
            guard poll(&wait, 1, 10000) > 0 else { print("SCOPE_INVALID"); exit(1) }
            let n = read(STDIN_FILENO, &part, part.count)
            guard n >= 0, input.count + n <= 8192 else { print("SCOPE_INVALID"); exit(1) }
            if n == 0 { break }; input.append(contentsOf: part.prefix(n))
        }
        let context = LAContext()
        context.touchIDAuthenticationAllowableReuseDuration = 0
        defer { context.invalidate() }
        let outcome = executeOwner(input: input, now: { Date() }, confirm: { scope in
            _ = NSApplication.shared
            NSApp.setActivationPolicy(.accessory)
            let alert = NSAlert()
            alert.messageText = "Authorize reusable CTO binding delegation"
            alert.informativeText = scope.display
            alert.addButton(withTitle: "Continue to macOS authentication")
            alert.addButton(withTitle: "Cancel")
            return alert.runModal() == .alertFirstButtonReturn
        }, authenticate: { scope in
            var error: NSError?
            guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { return false }
            let completed = DispatchSemaphore(value: 0)
            let answer = AuthenticationAnswer()
            context.evaluatePolicy(.deviceOwnerAuthentication,
                localizedReason: "Authorize the exact CTO delegation scope shown: " + scope.payload["projectId"]!) { success, error in
                answer.set(success && error == nil); completed.signal()
            }
            guard completed.wait(timeout: .now() + 120) == .success else { context.invalidate(); return false }
            return answer.get()
        }, readBearer: {
            // An existing ACL may refuse this new executable. Never prompt for ACL changes or repair it.
            context.interactionNotAllowed = true
            var result: CFTypeRef?
            let query: [CFString: Any] = [kSecClass: kSecClassGenericPassword,
                kSecAttrService: "com.agentcontrolplane.agentcpd", kSecAttrAccount: "ACP_OPERATOR_TOKEN",
                kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne,
                kSecUseAuthenticationContext: context]
            guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
                  let secret = result as? Data else { throw OwnerFailure.keychain }
            return secret
        }, submit: { scope, bearer in try submitOwner(scope, bearer, socketPath: socketPath) })
        print(outcome)
        exit(outcome.hasPrefix("GRANTED ") ? 0 : 1)
    }
}

// The LocalAuthentication callback has no log/error/secret output and cannot race a timed-out caller.
private final class AuthenticationAnswer: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    func set(_ next: Bool) { lock.lock(); defer { lock.unlock() }; value = next }
    func get() -> Bool { lock.lock(); defer { lock.unlock() }; return value }
}
#endif

enum OwnerFailure: String, Error {
    case scope = "SCOPE_INVALID"
    case cancelled = "AUTH_DENIED"
    case keychain = "KEYCHAIN_UNAVAILABLE"
    case transport = "DAEMON_UNAVAILABLE"
    case denied = "DAEMON_DENIED"
}
