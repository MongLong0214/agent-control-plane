// Reverting just the remedy must fail at the message assertion, even though registration
// still refuses the same path with the same reason and evidence.
const endpointDirectoryRemedy = {
  id: "endpoint-directory-remedy",
  what: "an endpoint directory refusal tells the operator how to launch the client",
  file: "src/mcp/role-conversation.ts",
  find:
    '        "a wake endpoint must sit directly in this deployment\'s owner-only state directory; " +\n' +
    '          `start the client with --messaging-socket-path pointing to a socket directly inside ${dir}`,',
  replace: '        "a wake endpoint must sit directly in this deployment\'s owner-only state directory",',
  killedBy: [
    "tests/unit/role-attachment-endpoints.test.ts::directory refusal tells the operator how to start the client without echoing the rejected path",
  ],
};

export default endpointDirectoryRemedy;
