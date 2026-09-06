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

#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/socket.h>
#include <sys/sysctl.h>
#include <sys/types.h>
#include <sys/ucred.h>
#include <sys/un.h>

#include <cerrno>
#include <cstring>
#include <string>
#include <vector>

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

  // xucred carries the primary gid as cr_groups[0], not a standalone cr_gid field (<sys/ucred.h>
  // even #defines cr_gid to cr_groups[0]) — there is always at least one group when the
  // credential is populated at all.
  //
  // Both fields below are the *effective* identity, not the real one: <sys/ucred.h> documents
  // cr_uid itself as "effective user id", and cr_groups (cr_gid's expansion) is read off that
  // same snapshot. A caller comparing this uid/gid against a process's real ids (getuid/getgid)
  // rather than its effective ones (geteuid/getegid) is asserting a property xucred does not
  // carry — it happens to hold for an unprivileged process where real === effective, and silently
  // stops holding the moment one differs.
  const gid_t gid = cred.cr_ngroups > 0 ? cred.cr_groups[0] : static_cast<gid_t>(-1);

  Napi::Object result = Napi::Object::New(env);
  result.Set("peerPid", Napi::Number::New(env, peerPid));
  result.Set("effectivePid", Napi::Number::New(env, effectivePid));
  result.Set("uid", Napi::Number::New(env, cred.cr_uid));
  result.Set("gid", Napi::Number::New(env, gid));
  return result;
}

// processArgv(pid) — the kernel's own record of a process's real argv vector, via
// sysctl(CTL_KERN, KERN_PROCARGS2, pid). No procfs exists on Darwin, and this MIB takes a raw
// numeric array that includes the target pid, which only the sysctl(3) C function accepts — the
// sysctl(8) CLI has no named OID for it. This exists so `src/core/process-argv.ts` never has to
// fall back to `ps`'s rendered, whitespace-joined text, which cannot preserve the boundary between
// a real argv element and text merely sitting inside one quoted positional argument.
//
// Returns each argv element as a raw `Buffer` — never a JS string — so this file makes no claim
// about the bytes' encoding; UTF-8 validation is the caller's job (`src/core/process-argv.ts`
// decodes with `TextDecoder(..., { fatal: true })`, failing closed on anything invalid).
Napi::Value ProcessArgv(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "processArgv(pid) requires a numeric pid").ThrowAsJavaScriptException();
    return env.Null();
  }
  const pid_t pid = static_cast<pid_t>(info[0].As<Napi::Number>().Int32Value());

  int mib[3] = {CTL_KERN, KERN_PROCARGS2, pid};
  size_t size = 0;
  if (sysctl(mib, 3, nullptr, &size, nullptr, 0) != 0) {
    Napi::Error::New(env, std::string("sysctl(KERN_PROCARGS2) size probe failed: errno ") + std::to_string(errno))
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  if (size == 0) {
    Napi::Error::New(env, "sysctl(KERN_PROCARGS2) reported zero size").ThrowAsJavaScriptException();
    return env.Null();
  }

  std::vector<char> buffer(size);
  size_t fetchSize = size;
  if (sysctl(mib, 3, buffer.data(), &fetchSize, nullptr, 0) != 0) {
    Napi::Error::New(env, std::string("sysctl(KERN_PROCARGS2) fetch failed: errno ") + std::to_string(errno))
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  if (fetchSize < sizeof(int)) {
    Napi::Error::New(env, "sysctl(KERN_PROCARGS2) returned a buffer smaller than argc")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  int argc = 0;
  std::memcpy(&argc, buffer.data(), sizeof(argc));
  if (argc <= 0) {
    Napi::Error::New(env, "sysctl(KERN_PROCARGS2) reported a non-positive argc").ThrowAsJavaScriptException();
    return env.Null();
  }

  const char* cp = buffer.data() + sizeof(argc);
  const char* dataEnd = buffer.data() + fetchSize;

  // The kernel's own layout: argc, then the saved exec path (NUL-terminated), then padding NUL
  // bytes before argv[0] begins. The padding is *computed*, never found by scanning for the first
  // non-NUL byte: that scan cannot tell real alignment padding apart from an argv[0] that is
  // itself an empty string, and would silently shift every element read afterward — the last of
  // which then reads out of envp instead of argv. The kernel pads (path bytes + its NUL
  // terminator) up to the next pointer-size-aligned boundary, counted from the first byte of the
  // exec path (i.e. from right after argc) — a fixed offset derivable from the path's own length
  // alone, with no dependency on what byte value follows it.
  const char* execPathStart = cp;
  for (; cp < dataEnd && *cp != '\0'; ++cp) {
  }
  if (cp >= dataEnd) {
    Napi::Error::New(env, "sysctl(KERN_PROCARGS2) exec path was not NUL-terminated within the buffer")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  const size_t execPathLen = static_cast<size_t>(cp - execPathStart);
  ++cp;  // the exec path's own NUL terminator

  constexpr size_t kAlign = sizeof(void*);
  const size_t consumed = execPathLen + 1;
  const size_t aligned = ((consumed + kAlign - 1) / kAlign) * kAlign;
  const size_t paddingLen = aligned - consumed;
  if (static_cast<size_t>(dataEnd - cp) < paddingLen) {
    Napi::Error::New(env, "sysctl(KERN_PROCARGS2) argv region begins past the end of the returned buffer")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  cp += paddingLen;  // now at argv[0]'s first byte exactly, empty or not

  Napi::Array result = Napi::Array::New(env, static_cast<size_t>(argc));
  for (int i = 0; i < argc; ++i) {
    if (cp >= dataEnd) {
      Napi::Error::New(env, "sysctl(KERN_PROCARGS2) argv vector truncated before argc was satisfied")
          .ThrowAsJavaScriptException();
      return env.Null();
    }
    const char* start = cp;
    for (; cp < dataEnd && *cp != '\0'; ++cp) {
    }
    const size_t len = static_cast<size_t>(cp - start);
    result.Set(static_cast<uint32_t>(i),
               Napi::Buffer<uint8_t>::Copy(env, reinterpret_cast<const uint8_t*>(start), len));
    if (cp < dataEnd) ++cp;  // skip the NUL terminator between elements
  }

  return result;
}

// processStartToken(pid) — the kernel's own record of when a process started, with microsecond
// precision, via proc_pidinfo(PROC_PIDTBSDINFO). `ps -o lstart=` renders this to whole-second,
// locale-dependent text: two different processes started within the same rendered second are
// indistinguishable through it, which a pid-reuse race can produce. `pbi_start_tvsec`/
// `pbi_start_tvusec` are the same kernel-tracked value at its native resolution, never rendered.
Napi::Value ProcessStartToken(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "processStartToken(pid) requires a numeric pid").ThrowAsJavaScriptException();
    return env.Null();
  }
  const int pid = info[0].As<Napi::Number>().Int32Value();

  struct proc_bsdinfo bsdInfo;
  const int rc = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsdInfo, sizeof(bsdInfo));
  if (rc != static_cast<int>(sizeof(bsdInfo))) {
    Napi::Error::New(env, std::string("proc_pidinfo(PROC_PIDTBSDINFO) failed: errno ") + std::to_string(errno))
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Object result = Napi::Object::New(env);
  result.Set("sec", Napi::Number::New(env, static_cast<double>(bsdInfo.pbi_start_tvsec)));
  result.Set("usec", Napi::Number::New(env, static_cast<double>(bsdInfo.pbi_start_tvusec)));
  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set(Napi::String::New(env, "peercred"), Napi::Function::New(env, PeerCred));
  exports.Set(Napi::String::New(env, "processArgv"), Napi::Function::New(env, ProcessArgv));
  exports.Set(Napi::String::New(env, "processStartToken"), Napi::Function::New(env, ProcessStartToken));
  return exports;
}

}  // namespace

NODE_API_MODULE(peercred, Init)
