{
  "targets": [
    {
      "target_name": "mach_launch",
      "sources": ["src/mach_launch.c"],
      # Node-API 8 is the floor both supported runtimes (^22.18.0 || >=24) provide; nothing here
      # touches V8 directly, so one build loads under either interpreter.
      "defines": ["NAPI_VERSION=8"],
      "cflags": ["-Wall", "-Wextra"],
      # audit_token_to_* live in libbsm; proc_pidpath_audittoken and the Mach calls in libSystem.
      "libraries": ["-lbsm"],
      "xcode_settings": {
        "MACOSX_DEPLOYMENT_TARGET": "11.0",
        "OTHER_CFLAGS": ["-Wall", "-Wextra"]
      }
    }
  ]
}
