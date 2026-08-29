// peercred(fd) — reads the kernel's own record of who is on the other end of a connected
// AF_UNIX socket, via getsockopt(SOL_LOCAL, ...). This is deliberately not the legacy
// compile-on-load addon this repository forbade importing (#539): it is new source, built by
// this repository's own binding.gyp / node-addon-api convention (ADR-0010), not the pinned
// Node/compiler/SDK regime recorded elsewhere on this machine.
//
// Darwin only. LOCAL_PEERPID/LOCAL_PEEREPID/LOCAL_PEERCRED are BSD socket options with no Linux
// equivalent (Linux's nearest analogue is SO_PEERCRED, a different option with a different
// payload) — porting is a second decision, not a portability bug in this file, so it is refused
// at compile time rather than approximated.
#ifndef __APPLE__
#error "peercred.cc is Darwin-only; src/core/peercred.ts must not build or load this on other platforms"
#endif

#include <napi.h>

#include <sys/socket.h>
#include <sys/ucred.h>
#include <sys/un.h>

namespace {

Napi::Value PeerCred(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "peercred(fd) requires a numeric file descriptor").ThrowAsJavaScriptException();
    return env.Null();
  }
  const int fd = info[0].As<Napi::Number>().Int32Value();

  pid_t peerPid = -1;
  socklen_t pidLen = sizeof(peerPid);
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &peerPid, &pidLen) != 0) {
    Napi::Error::New(env, std::string("getsockopt(LOCAL_PEERPID) failed: errno ") + std::to_string(errno))
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  pid_t effectivePid = -1;
  socklen_t epidLen = sizeof(effectivePid);
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEEREPID, &effectivePid, &epidLen) != 0) {
    Napi::Error::New(env, std::string("getsockopt(LOCAL_PEEREPID) failed: errno ") + std::to_string(errno))
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  struct xucred cred;
  socklen_t credLen = sizeof(cred);
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERCRED, &cred, &credLen) != 0) {
    Napi::Error::New(env, std::string("getsockopt(LOCAL_PEERCRED) failed: errno ") + std::to_string(errno))
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  // xucred carries the primary gid as cr_groups[0], not a standalone cr_gid field — there is
  // always at least one group when the credential is populated at all.
  const gid_t gid = cred.cr_ngroups > 0 ? cred.cr_groups[0] : static_cast<gid_t>(-1);

  Napi::Object result = Napi::Object::New(env);
  result.Set("peerPid", Napi::Number::New(env, peerPid));
  result.Set("effectivePid", Napi::Number::New(env, effectivePid));
  result.Set("uid", Napi::Number::New(env, cred.cr_uid));
  result.Set("gid", Napi::Number::New(env, gid));
  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set(Napi::String::New(env, "peercred"), Napi::Function::New(env, PeerCred));
  return exports;
}

}  // namespace

NODE_API_MODULE(peercred, Init)
