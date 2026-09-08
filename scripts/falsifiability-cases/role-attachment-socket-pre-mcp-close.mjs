export default {
  "id": "role-attachment-socket-pre-mcp-close",
  "what": "attachment sockets: raw close invalidates admission before MCP installs onclose",
  "file": "src/daemon/agentcpd.ts",
  "find": "        socket.once(\"close\", attached.value);\n",
  "replace": "",
  "killedBy": [
    "tests/unit/role-attachment-sockets.test.ts::a close before MCP installs onclose permanently spends the attachment"
  ]
};
