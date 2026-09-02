{
  "targets": [
    {
      "target_name": "acp_fd_vfs",
      "type": "shared_library",
      "sources": ["src/acp_fd_vfs.c"],
      # The amalgamation `better-sqlite3` itself was built from. The extension has to agree with
      # the SQLite instance it will be loaded into, and this is the only copy that is guaranteed
      # to — a system `sqlite3ext.h` tracks the OS, not this dependency.
      "include_dirs": ["<!(node -p \"require('path').join(require.resolve('better-sqlite3'), '../../deps/sqlite3')\")"],
      # The shipping identity. Paired with the `#error` in the C source, this makes
      # production-and-testing a compile failure rather than a silently richer artifact: an
      # injected `-DACP_FD_VFS_TESTING` now cannot produce a library at all.
      "defines": ["ACP_FD_VFS_PRODUCTION_BUILD=1"],
      "cflags": ["-fPIC", "-Wall", "-pthread"],
      "conditions": [["OS==\"linux\"", {"libraries": ["-lpthread"]}]],
      "product_prefix": "",
      "xcode_settings": {
        "MACOSX_DEPLOYMENT_TARGET": "11.0",
        "OTHER_CFLAGS": ["-Wall"]
      }
    }
  ]
}
