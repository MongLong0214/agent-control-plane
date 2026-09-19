import Foundation

@main
struct OwnerAuthTests {
    static func main() throws {
        if CommandLine.arguments.count == 4, CommandLine.arguments[1] == "fixture" {
            let mode = CommandLine.arguments[3]
            let input = FileHandle.standardInput.readDataToEndOfFile()
            let outcome = executeOwner(input: input, now: { Date() },
                confirm: { _ in mode != "cancel" },
                authenticate: { _ in mode != "auth-error" },
                readBearer: {
                    if mode == "keychain-error" { throw OwnerFailure.keychain }
                    return Data("native-child-synthetic-bearer".utf8)
                },
                submit: { scope, token in try submitOwner(scope, token, socketPath: CommandLine.arguments[2]) })
            print(outcome)
            return
        }
        let scope: [String: String] = ["projectId": "project-fixture", "role": "PRIMARY_CTO",
            "action": "bind-or-rebind", "ceoActorId": "actor-fixture", "ceoSessionId": "ceo-fixture",
            "ceoIncarnation": "incarnation-fixture", "expiresAt": "2099-01-01T00:00:00.000Z",
            "revokePolicy": "owner-or-ceo-loss"]
        let input = try JSONSerialization.data(withJSONObject: scope)
        let parsed = try OwnerScope(input, now: Date())
        precondition(parsed.display.contains("Project: project-fixture"))
        precondition(parsed.display.contains("PRIMARY_CTO"))
        precondition(parsed.display.contains("actor-fixture"))
        precondition(parsed.display.contains("2099-01-01T00:00:00.000Z"))
        precondition(parsed.payload["revokePolicy"] == "owner-or-ceo-loss")
        var events: [String] = []
        let result = executeOwner(input: input, now: { Date() },
            confirm: { _ in events.append("scope"); return true },
            authenticate: { _ in events.append("auth"); return false },
            readBearer: { events.append("keychain"); return Data("synthetic-only".utf8) },
            submit: { _, _ in events.append("write"); return "11111111-1111-4111-8111-111111111111" })
        precondition(result == "AUTH_DENIED")
        precondition(events == ["scope", "auth"])
        print("SCOPE_PASS AUTH_ORDER_PASS")
    }
}
