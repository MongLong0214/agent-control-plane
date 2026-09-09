const roleAttachmentSocketListenerWiring = {
  "id": "role-attachment-socket-listener-wiring",
  "what": "attachment sockets: the production listener uses the daemon attachment authority",
  "file": "src/daemon/agentcpd.ts",
  "find": "    ...(daemon.attachments ? { attachments: daemon.attachments } : {}),",
  "replace": "",
  "killedBy": [
    "tests/unit/role-attachment-sockets.test.ts::the production listener admits the approved attachment and registers its own endpoint"
  ]
};

export default roleAttachmentSocketListenerWiring;
