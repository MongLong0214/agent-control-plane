/*
 * A SQLite VFS that binds the main database to a descriptor its caller already verified.
 *
 * Why this exists. `migrate-approved-copy` has to open one file that an operator named and that a
 * capability approved, and it has to be *that* file — not whatever the pathname resolves to a
 * moment later. Three designs tried to get there by checking the pathname harder: re-`lstat`
 * before the open, compare identities after it, scan this process's descriptor table for the
 * expected inode. Each was defeated by the same counterexample, because none of them is a
 * statement about the object the connection actually opened:
 *
 *     hold an unrelated descriptor on E, point the pathname at I across the open, put it back.
 *
 * The descriptor-table scan finds the unrelated descriptor and says yes; the pathname re-check
 * finds E and says yes; the connection is on I. A check that a file nobody opened can satisfy is
 * not a check.
 *
 * `better-sqlite3` exposes no way to hand a connection a descriptor — its entire public surface is
 * `prepare`, `pragma`, `backup`, `serialize`, `exec`, `close` and nine more, none of which takes
 * or returns a handle — and its native constructor calls `sqlite3_open_v2(filename, ..., NULL)`.
 * The one entry point that reaches the *same* statically linked SQLite instance is the loadable
 * extension ABI: `SQLITE_EXTENSION_INIT2` receives that instance's own `sqlite3_api_routines`.
 * So the binding is built here, as an extension, and approved as its own load mechanism (ADR-0010
 * covers a node-addon-api addon that Node loads; this is loaded by SQLite).
 *
 * What it does. While a binding is active, `xOpen` for `SQLITE_OPEN_MAIN_DB` hands the connection
 * a `dup()` of the caller's verified descriptor, so no pathname is resolved for the main database
 * at all. Journal objects — and the `xAccess`/`xDelete` calls that manage them — go through
 * `openat`/`faccessat`/`unlinkat` on a directory descriptor the caller also verified, so no path
 * component is walked either. While no binding is active every call is delegated unchanged to the
 * VFS this shim wrapped, which is what keeps registering it as the default harmless.
 *
 * What it deliberately does not do. There is no fallback. If a binding is active and a request
 * does not match it, the answer is a refusal — never an open by pathname, which is the very
 * behaviour this replaces. And there is no shared-memory support: `iVersion` is 1, so SQLite
 * declines to enter WAL mode on a bound connection and stays on a rollback journal. WAL/SHM group
 * ownership would need `xShmMap` and friends and is out of scope; the caller is required to refuse
 * a database that already has a non-empty `-wal`/`-shm` beside it before binding.
 */
/*
 * The shipping build and the testing build are different artifacts, and this makes that a fact the
 * compiler enforces rather than a property of how the build happened to be invoked.
 *
 * `binding.gyp` defines `ACP_FD_VFS_PRODUCTION_BUILD` for the target that ships. Measured before
 * this existed: `CFLAGS=-DACP_FD_VFS_TESTING pnpm native:fd-vfs:build` exited 0 and produced a
 * shipping library carrying the fault injector, because node-gyp's Make generator appends
 * inherited `CFLAGS` and `CPPFLAGS` to the compile command. Default-clean is not fail-closed: it
 * only describes the invocation nobody tampered with.
 */
#if defined(ACP_FD_VFS_PRODUCTION_BUILD) && defined(ACP_FD_VFS_TESTING)
#error "ACP_FD_VFS_TESTING must never be defined for the shipping build: the test seam would ship"
#endif

#include <sqlite3ext.h>
#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>
SQLITE_EXTENSION_INIT1

#define ACP_VFS_NAME "acp-fd-vfs"
#define ACP_MAX_BASE 256
#define ACP_MAX_PATH 1024

static sqlite3_vfs *acp_parent = 0;
static sqlite3_vfs acp_shim;

/** The one active binding. Unit 2 adds the bracket that guarantees at most one caller. */
static struct {
  int active;
  int main_fd;
  int dir_fd;
  char base[ACP_MAX_BASE];
  /*
   * The bound database's full path, normalised the way SQLite will present it.
   *
   * Matching on the basename alone was wrong, and wrong in exactly the way this whole unit exists
   * to end: two databases in different directories can share a name, so `/a/copy.sqlite` and
   * `/b/copy.sqlite` were the same key. A connection opening the second one would have been handed
   * the descriptor for the first and would have read and written it believing otherwise. A name
   * standing in for an object is the defect, at whatever length the name happens to be.
   */
  char path[ACP_MAX_PATH];
  dev_t dev;
  ino_t ino;
  int main_opens;
  int journal_opens;
  int deletes;
  int dir_syncs;
  int refusals;
  char last_refusal[256];
} acp_binding;

typedef struct AcpFile AcpFile;
struct AcpFile {
  const sqlite3_io_methods *pMethods;
  int fd;
  int delete_on_close;
  char base[ACP_MAX_BASE];
};

static void acp_refuse(const char *why) {
  acp_binding.refusals++;
  snprintf(acp_binding.last_refusal, sizeof acp_binding.last_refusal, "%s", why);
}

static const char *acp_basename(const char *path) {
  const char *slash = strrchr(path, '/');
  return slash ? slash + 1 : path;
}

/** True when `path` is the bound database itself. Whole path, not a name within some directory. */
static int acp_is_bound_database(const char *path) {
  return strcmp(path, acp_binding.path) == 0;
}

/** True when `path` is one of the bound database's own journal siblings, e.g. `<db>-journal`. */
static int acp_is_bound_sibling(const char *path) {
  size_t n = strlen(acp_binding.path);
  return strncmp(path, acp_binding.path, n) == 0 && path[n] == '-';
}

static int acp_close(sqlite3_file *file) {
  AcpFile *f = (AcpFile *)file;
  if (f->delete_on_close && acp_binding.active && f->base[0]) {
    unlinkat(acp_binding.dir_fd, f->base, 0);
  }
  if (f->fd >= 0) close(f->fd);
  f->fd = -1;
  return SQLITE_OK;
}

static int acp_read(sqlite3_file *file, void *buf, int n, sqlite3_int64 offset) {
  AcpFile *f = (AcpFile *)file;
  ssize_t got = pread(f->fd, buf, (size_t)n, (off_t)offset);
  if (got < 0) return SQLITE_IOERR_READ;
  if (got < n) {
    memset((char *)buf + got, 0, (size_t)(n - got));
    return SQLITE_IOERR_SHORT_READ;
  }
  return SQLITE_OK;
}

static int acp_write(sqlite3_file *file, const void *buf, int n, sqlite3_int64 offset) {
  AcpFile *f = (AcpFile *)file;
  const char *from = buf;
  size_t left = (size_t)n;
  off_t at = (off_t)offset;
  while (left > 0) {
    ssize_t put = pwrite(f->fd, from, left, at);
    if (put <= 0) return SQLITE_IOERR_WRITE;
    from += put;
    left -= (size_t)put;
    at += put;
  }
  return SQLITE_OK;
}

static int acp_truncate(sqlite3_file *file, sqlite3_int64 size) {
  return ftruncate(((AcpFile *)file)->fd, (off_t)size) == 0 ? SQLITE_OK : SQLITE_IOERR_TRUNCATE;
}

static int acp_sync(sqlite3_file *file, int flags) {
  (void)flags;
  return fsync(((AcpFile *)file)->fd) == 0 ? SQLITE_OK : SQLITE_IOERR_FSYNC;
}

static int acp_file_size(sqlite3_file *file, sqlite3_int64 *out) {
  struct stat st;
  if (fstat(((AcpFile *)file)->fd, &st) != 0) return SQLITE_IOERR_FSTAT;
  *out = (sqlite3_int64)st.st_size;
  return SQLITE_OK;
}

/*
 * Locking is a no-op, and that is a statement about the caller rather than a shortcut: this VFS is
 * only ever active inside a migration that already holds the single-instance lock over the
 * database's directory, so there is no second connection to exclude. Unit 2 makes that a checked
 * precondition of binding rather than a comment.
 */
static int acp_lock(sqlite3_file *file, int level) { (void)file; (void)level; return SQLITE_OK; }
static int acp_unlock(sqlite3_file *file, int level) { (void)file; (void)level; return SQLITE_OK; }
static int acp_check_reserved(sqlite3_file *file, int *out) { (void)file; *out = 0; return SQLITE_OK; }
static int acp_file_control(sqlite3_file *file, int op, void *arg) {
  (void)file; (void)op; (void)arg;
  return SQLITE_NOTFOUND;
}
static int acp_sector_size(sqlite3_file *file) { (void)file; return 4096; }
static int acp_device_characteristics(sqlite3_file *file) { (void)file; return 0; }

/*
 * `iVersion` 1 on purpose: the shared-memory methods are absent, so SQLite declines to put a bound
 * connection into WAL mode and keeps it on a rollback journal. Named fields rather than positional
 * ones so that absence reads as a decision — and so the v2/v3 slots stay visibly unfilled instead
 * of being silently zeroed by a positional list that happens to be short.
 */
static const sqlite3_io_methods acp_io_methods = {
  .iVersion = 1,
  .xClose = acp_close,
  .xRead = acp_read,
  .xWrite = acp_write,
  .xTruncate = acp_truncate,
  .xSync = acp_sync,
  .xFileSize = acp_file_size,
  .xLock = acp_lock,
  .xUnlock = acp_unlock,
  .xCheckReservedLock = acp_check_reserved,
  .xFileControl = acp_file_control,
  .xSectorSize = acp_sector_size,
  .xDeviceCharacteristics = acp_device_characteristics
};

static int acp_open(sqlite3_vfs *vfs, const char *path, sqlite3_file *file, int flags, int *out) {
  /*
   * SQLite hands `xOpen` uninitialised memory and then, on some paths, inspects `pMethods` even
   * after a failed open — closing the file if it is non-NULL. Every refusal below returned
   * `SQLITE_CANTOPEN` without touching that field, leaving whatever bytes happened to be on the
   * stack to be read as a methods table. Clearing it here covers every exit, including the ones
   * added later, rather than relying on each refusal to remember.
   */
  if (file) file->pMethods = 0;

  if (!acp_binding.active || path == 0) {
    return acp_parent->xOpen(acp_parent, path, file, flags, out);
  }

  const char *base = acp_basename(path);
  AcpFile *f = (AcpFile *)file;

  if (flags & SQLITE_OPEN_MAIN_DB) {
    if (!acp_is_bound_database(path)) {
      /* No fallback: a bound process does not open some other main database by pathname. */
      acp_refuse("main database does not match the active binding");
      return SQLITE_CANTOPEN;
    }
    struct stat st;
    if (fstat(acp_binding.main_fd, &st) != 0 ||
        st.st_dev != acp_binding.dev || st.st_ino != acp_binding.ino) {
      acp_refuse("the bound descriptor is no longer the verified object");
      return SQLITE_CANTOPEN;
    }
    memset(f, 0, sizeof *f);
    f->fd = dup(acp_binding.main_fd);
    if (f->fd < 0) {
      acp_refuse("could not duplicate the bound descriptor");
      return SQLITE_CANTOPEN;
    }
    f->pMethods = &acp_io_methods;
    if (out) *out = SQLITE_OPEN_READWRITE;
    acp_binding.main_opens++;
    return SQLITE_OK;
  }

  if (flags & SQLITE_OPEN_WAL) {
    /* Out of scope by ruling, and refused rather than delegated: delegating would open a
       shared-memory family this binding does not own. */
    acp_refuse("write-ahead logging is not available on a bound connection");
    return SQLITE_CANTOPEN;
  }

  if (flags & (SQLITE_OPEN_MAIN_JOURNAL | SQLITE_OPEN_SUPER_JOURNAL)) {
    if (!acp_is_bound_sibling(path)) {
      acp_refuse("journal is not a sibling of the bound database");
      return SQLITE_CANTOPEN;
    }
    int how = O_RDWR | O_CREAT;
    if (flags & SQLITE_OPEN_EXCLUSIVE) how |= O_EXCL;
    int fd = openat(acp_binding.dir_fd, base, how, 0600);
    if (fd < 0) {
      acp_refuse("could not open the journal in the bound directory");
      return SQLITE_CANTOPEN;
    }
    memset(f, 0, sizeof *f);
    f->fd = fd;
    f->delete_on_close = (flags & SQLITE_OPEN_DELETEONCLOSE) ? 1 : 0;
    snprintf(f->base, sizeof f->base, "%s", base);
    f->pMethods = &acp_io_methods;
    if (out) *out = SQLITE_OPEN_READWRITE;
    acp_binding.journal_opens++;
    return SQLITE_OK;
  }

  /* Temporary files and everything else the connection needs are not part of the bound family. */
  return acp_parent->xOpen(acp_parent, path, file, flags, out);
}

/*
 * `xAccess` and `xDelete` are half of the journal's lifecycle — "is there a hot journal?" and
 * "remove it" — so leaving them on the parent would put the pathname back in charge of exactly the
 * files this binding exists to own.
 */
static int acp_access(sqlite3_vfs *vfs, const char *path, int flags, int *out) {
  if (acp_binding.active && path && acp_is_bound_sibling(path)) {
    int mode = (flags == SQLITE_ACCESS_READWRITE) ? (R_OK | W_OK) : F_OK;
    *out = faccessat(acp_binding.dir_fd, acp_basename(path), mode, 0) == 0;
    return SQLITE_OK;
  }
  return acp_parent->xAccess(acp_parent, path, flags, out);
}

/*
 * One-shot fault injection for the directory sync — compiled only into the test artifact.
 *
 * There is no portable way to make `fsync` on a healthy directory descriptor fail on demand:
 * closing the descriptor breaks the `unlinkat` first, and every other trick either fails both
 * calls or fails neither. Without it the error branch would ship unexecuted, which is the
 * condition it exists to survive.
 *
 * It is behind `ACP_FD_VFS_TESTING` because "the production loader does not expose it" was not a
 * boundary. The extension registers SQL functions on whichever connection loads it, so any caller
 * able to load the library could arm a fault in a migration's own VFS regardless of what
 * `FdVfsControl` chose to surface. A hidden method is not a limit; an absent symbol is. The
 * production build never defines this macro, and a test proves the symbols are gone by loading the
 * shipped artifact and finding no such function.
 */
#ifdef ACP_FD_VFS_TESTING
static int acp_fail_next_dir_sync = 0;
#endif

static int acp_delete(sqlite3_vfs *vfs, const char *path, int sync_dir) {
  if (acp_binding.active && path && acp_is_bound_sibling(path)) {
    acp_binding.deletes++;
    if (unlinkat(acp_binding.dir_fd, acp_basename(path), 0) != 0 && errno != ENOENT) {
      return SQLITE_IOERR_DELETE;
    }
    if (sync_dir) {
      acp_binding.dir_syncs++;
      /*
       * Removing a rollback journal is what makes a commit durable: until the directory entry is
       * on stable storage, a power loss can bring the journal back and roll the committed
       * migration away. Discarding this result reported that as success — the failure mode being
       * "the migration you were told finished did not", which is the worst shape an error can
       * take here.
       */
#ifdef ACP_FD_VFS_TESTING
      int failed = acp_fail_next_dir_sync ? (acp_fail_next_dir_sync = 0, 1)
                                          : (fsync(acp_binding.dir_fd) != 0);
#else
      int failed = fsync(acp_binding.dir_fd) != 0;
#endif
      if (failed) return SQLITE_IOERR_DIR_FSYNC;
    }
    return SQLITE_OK;
  }
  return acp_parent->xDelete(acp_parent, path, sync_dir);
}

static void acp_fn_bind(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  if (argc != 3) {
    sqlite3_result_error(ctx, "acp_fd_bind(basename, mainFd, dirFd)", -1);
    return;
  }
  const char *given = (const char *)sqlite3_value_text(argv[0]);
  int main_fd = sqlite3_value_int(argv[1]);
  int dir_fd = sqlite3_value_int(argv[2]);
  if (given == 0 || given[0] != '/' || strlen(given) >= ACP_MAX_PATH) {
    sqlite3_result_error(ctx, "the database must be named by an absolute path", -1);
    return;
  }
  /*
   * Normalised through the wrapped VFS's own `xFullPathname`, because that is the form SQLite will
   * hand back to `xOpen`. Comparing against the string the caller happened to type would leave the
   * match depending on spelling rather than on what SQLite resolved.
   */
  char full[ACP_MAX_PATH];
  /*
   * `SQLITE_OK_SYMLINK` is a success, and treating it as a failure cost a debugging round: every
   * temporary directory on macOS lives under `/var`, which is a symlink to `/private/var`, so this
   * call resolves a symlink component and says so with a distinct OK code. The primary result code
   * is the low byte — comparing the whole value against `SQLITE_OK` rejects every extended success
   * as well as every error.
   */
  int rc = acp_parent->xFullPathname(acp_parent, given, (int)sizeof full, full);
  if ((rc & 0xff) != SQLITE_OK) {
    char msg[128];
    snprintf(msg, sizeof msg, "could not resolve the database path (rc=%d)", rc);
    sqlite3_result_error(ctx, msg, -1);
    return;
  }
  const char *base = acp_basename(full);
  if (base[0] == '\0' || strlen(base) >= ACP_MAX_BASE) {
    sqlite3_result_error(ctx, "the database path has no usable file name", -1);
    return;
  }
  struct stat st;
  if (fstat(main_fd, &st) != 0 || !S_ISREG(st.st_mode)) {
    sqlite3_result_error(ctx, "mainFd is not an open regular file", -1);
    return;
  }
  struct stat dst;
  if (fstat(dir_fd, &dst) != 0 || !S_ISDIR(dst.st_mode)) {
    sqlite3_result_error(ctx, "dirFd is not an open directory", -1);
    return;
  }
  memset(&acp_binding, 0, sizeof acp_binding);
  acp_binding.active = 1;
  acp_binding.main_fd = main_fd;
  acp_binding.dir_fd = dir_fd;
  acp_binding.dev = st.st_dev;
  acp_binding.ino = st.st_ino;
  snprintf(acp_binding.base, sizeof acp_binding.base, "%s", base);
  snprintf(acp_binding.path, sizeof acp_binding.path, "%s", full);
  sqlite3_result_int64(ctx, (sqlite3_int64)st.st_ino);
}

static void acp_fn_unbind(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  (void)argc; (void)argv;
  int was = acp_binding.active;
  memset(&acp_binding, 0, sizeof acp_binding);
  sqlite3_result_int(ctx, was);
}

#ifdef ACP_FD_VFS_TESTING

/** Arms the one-shot directory-sync fault. Test-only; see `acp_fail_next_dir_sync`. */
static void acp_fn_fail_next_dir_sync(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  (void)argc; (void)argv;
  acp_fail_next_dir_sync = 1;
  sqlite3_result_int(ctx, 1);
}

/**
 * Reports what a caller would see in `pMethods` after a refused open.
 *
 * The contract cannot be observed from outside C: SQLite owns the `sqlite3_file` memory, so a test
 * in TypeScript has nothing to inspect. This allocates that memory itself, fills it with a
 * sentinel no valid pointer could be, drives a real refusal through the registered shim, and
 * reports the field. Poisoning it here rather than reading back what this file just wrote is what
 * keeps the check from being circular.
 */
static void acp_fn_probe_refusal_methods(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  (void)argc; (void)argv;
  if (!acp_binding.active) {
    sqlite3_result_text(ctx, "no binding", -1, SQLITE_TRANSIENT);
    return;
  }
  int size = acp_shim.szOsFile;
  sqlite3_file *file = sqlite3_malloc(size);
  if (file == 0) {
    sqlite3_result_text(ctx, "out of memory", -1, SQLITE_TRANSIENT);
    return;
  }
  memset(file, 0xAA, (size_t)size);
  int out = 0;
  /* A main-database open that cannot match the binding: the shortest real refusal path. */
  int rc = acp_shim.xOpen(&acp_shim, "/nonexistent/not-the-bound-database.sqlite", file,
                          SQLITE_OPEN_MAIN_DB | SQLITE_OPEN_READWRITE, &out);
  char answer[128];
  snprintf(answer, sizeof answer, "rc=%d methodsNull=%d", rc, file->pMethods == 0);
  sqlite3_free(file);
  sqlite3_result_text(ctx, answer, -1, SQLITE_TRANSIENT);
}

/**
 * Drives `xDelete` with `sync_dir = 1` and reports the result code. Test-only.
 *
 * Measured on this platform: across seven `xDelete` calls spanning bound and unbound databases in
 * both journal modes, SQLite asked for a directory sync zero times. So no ordinary workload
 * reaches this branch, and a test written against one would pass whether or not the error is
 * reported. The contract still requires reporting it — a rollback journal whose removal is not on
 * stable storage can come back after a power loss and roll away a migration this code already
 * called finished — so the branch is exercised directly instead.
 */
static void acp_fn_probe_dir_sync(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  if (!acp_binding.active) {
    sqlite3_result_text(ctx, "no binding", -1, SQLITE_TRANSIENT);
    return;
  }
  int arm = (argc == 1) ? sqlite3_value_int(argv[0]) : 0;
  char journal[ACP_MAX_PATH + 16];
  snprintf(journal, sizeof journal, "%s-journal", acp_binding.path);
  if (arm) acp_fail_next_dir_sync = 1;
  int rc = acp_shim.xDelete(&acp_shim, journal, 1);
  char answer[64];
  snprintf(answer, sizeof answer, "rc=%d", rc);
  sqlite3_result_text(ctx, answer, -1, SQLITE_TRANSIENT);
}

#endif /* ACP_FD_VFS_TESTING */

static void acp_fn_stats(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  (void)argc; (void)argv;
  char out[512];
  snprintf(out, sizeof out,
           "active=%d mainOpens=%d journalOpens=%d deletes=%d dirSyncs=%d refusals=%d refusal=%s",
           acp_binding.active, acp_binding.main_opens, acp_binding.journal_opens,
           acp_binding.deletes, acp_binding.dir_syncs, acp_binding.refusals,
           acp_binding.last_refusal);
  sqlite3_result_text(ctx, out, -1, SQLITE_TRANSIENT);
}

static void acp_fn_probe(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  (void)argc; (void)argv;
  /* Answers "did the shim actually register?" from inside the loaded extension, so the caller
     checks the effect rather than trusting that `loadExtension` had one. */
  sqlite3_vfs *found = sqlite3_vfs_find(ACP_VFS_NAME);
  sqlite3_vfs *deflt = sqlite3_vfs_find(0);
  char out[256];
  snprintf(out, sizeof out, "registered=%d isDefault=%d version=%s",
           found != 0, deflt == &acp_shim, sqlite3_libversion());
  sqlite3_result_text(ctx, out, -1, SQLITE_TRANSIENT);
}

#ifdef _WIN32
__declspec(dllexport)
#endif
int sqlite3_extension_init(sqlite3 *db, char **err, const sqlite3_api_routines *api) {
  SQLITE_EXTENSION_INIT2(api)
  if (err) *err = 0;

  /*
   * The ABI this was compiled against has to be the ABI it is running in. A dependency bump
   * changes `better-sqlite3`'s bundled amalgamation, and an extension built against the old header
   * that keeps loading is the quiet kind of wrong. Fail closed, by name.
   */
  if (strcmp(sqlite3_libversion(), SQLITE_VERSION) != 0) {
    if (err) *err = sqlite3_mprintf("acp-fd-vfs was built against SQLite %s but is running in %s",
                                    SQLITE_VERSION, sqlite3_libversion());
    return SQLITE_ERROR;
  }

  if (sqlite3_create_function(db, "acp_fd_bind", 3, SQLITE_UTF8, 0, acp_fn_bind, 0, 0) != SQLITE_OK ||
      sqlite3_create_function(db, "acp_fd_unbind", 0, SQLITE_UTF8, 0, acp_fn_unbind, 0, 0) != SQLITE_OK ||
      sqlite3_create_function(db, "acp_fd_stats", 0, SQLITE_UTF8, 0, acp_fn_stats, 0, 0) != SQLITE_OK ||
      sqlite3_create_function(db, "acp_fd_probe", 0, SQLITE_UTF8, 0, acp_fn_probe, 0, 0) != SQLITE_OK) {
    return SQLITE_ERROR;
  }
#ifdef ACP_FD_VFS_TESTING
  if (sqlite3_create_function(db, "acp_fd_fail_next_dir_sync", 0, SQLITE_UTF8, 0,
                              acp_fn_fail_next_dir_sync, 0, 0) != SQLITE_OK ||
      sqlite3_create_function(db, "acp_fd_probe_refusal_methods", 0, SQLITE_UTF8, 0,
                              acp_fn_probe_refusal_methods, 0, 0) != SQLITE_OK ||
      sqlite3_create_function(db, "acp_fd_probe_dir_sync", 1, SQLITE_UTF8, 0,
                              acp_fn_probe_dir_sync, 0, 0) != SQLITE_OK) {
    return SQLITE_ERROR;
  }
#endif

  if (acp_parent == 0) {
    acp_parent = sqlite3_vfs_find(0);
    if (acp_parent == 0) return SQLITE_ERROR;
    acp_shim = *acp_parent;
    acp_shim.zName = ACP_VFS_NAME;
    acp_shim.pNext = 0;
    acp_shim.xOpen = acp_open;
    acp_shim.xAccess = acp_access;
    acp_shim.xDelete = acp_delete;
    if ((int)sizeof(AcpFile) > acp_shim.szOsFile) acp_shim.szOsFile = (int)sizeof(AcpFile);
    int rc = sqlite3_vfs_register(&acp_shim, 1);
    if (rc != SQLITE_OK) return rc;
  }

  /*
   * The registration outlives the connection that performed it, so the library must too.
   *
   * By default SQLite unloads an extension when the connection that loaded it closes. Everything
   * registered here — the VFS struct itself, every method pointer in it, the binding state — lives
   * in this library's image, and the default VFS pointer keeps referring to all of it after the
   * control connection goes away. That is a use-after-unload: the next database opened anywhere in
   * the process jumps through freed pointers.
   *
   * It was not theoretical. The unit-1 suite found it as a nondeterministic worker crash the moment
   * two cases ran in one process — each case passed alone, because a process that exits right
   * after closing its control connection never opens anything again. `SQLITE_OK_LOAD_PERMANENTLY`
   * is SQLite's own answer for extensions that register a VFS: the library stays resident for the
   * life of the process.
   */
  return SQLITE_OK_LOAD_PERMANENTLY;
}
