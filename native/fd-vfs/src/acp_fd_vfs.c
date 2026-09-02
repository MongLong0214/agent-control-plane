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

static sqlite3_vfs *acp_parent = 0;
static sqlite3_vfs acp_shim;

/** The one active binding. Unit 2 adds the bracket that guarantees at most one caller. */
static struct {
  int active;
  int main_fd;
  int dir_fd;
  char base[ACP_MAX_BASE];
  dev_t dev;
  ino_t ino;
  int main_opens;
  int journal_opens;
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

/** True when `base` is the bound database or one of its sibling journal names. */
static int acp_is_bound_sibling(const char *base) {
  size_t n = strlen(acp_binding.base);
  return strncmp(base, acp_binding.base, n) == 0 && (base[n] == '\0' || base[n] == '-');
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
  if (!acp_binding.active || path == 0) {
    return acp_parent->xOpen(acp_parent, path, file, flags, out);
  }

  const char *base = acp_basename(path);
  AcpFile *f = (AcpFile *)file;

  if (flags & SQLITE_OPEN_MAIN_DB) {
    if (strcmp(base, acp_binding.base) != 0) {
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
    if (!acp_is_bound_sibling(base)) {
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
  if (acp_binding.active && path && acp_is_bound_sibling(acp_basename(path))) {
    int mode = (flags == SQLITE_ACCESS_READWRITE) ? (R_OK | W_OK) : F_OK;
    *out = faccessat(acp_binding.dir_fd, acp_basename(path), mode, 0) == 0;
    return SQLITE_OK;
  }
  return acp_parent->xAccess(acp_parent, path, flags, out);
}

static int acp_delete(sqlite3_vfs *vfs, const char *path, int sync_dir) {
  if (acp_binding.active && path && acp_is_bound_sibling(acp_basename(path))) {
    if (unlinkat(acp_binding.dir_fd, acp_basename(path), 0) != 0 && errno != ENOENT) {
      return SQLITE_IOERR_DELETE;
    }
    if (sync_dir) fsync(acp_binding.dir_fd);
    return SQLITE_OK;
  }
  return acp_parent->xDelete(acp_parent, path, sync_dir);
}

static void acp_fn_bind(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  if (argc != 3) {
    sqlite3_result_error(ctx, "acp_fd_bind(basename, mainFd, dirFd)", -1);
    return;
  }
  const char *base = (const char *)sqlite3_value_text(argv[0]);
  int main_fd = sqlite3_value_int(argv[1]);
  int dir_fd = sqlite3_value_int(argv[2]);
  if (base == 0 || base[0] == '\0' || strchr(base, '/') != 0 || strlen(base) >= ACP_MAX_BASE) {
    sqlite3_result_error(ctx, "basename must be a plain file name", -1);
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
  sqlite3_result_int64(ctx, (sqlite3_int64)st.st_ino);
}

static void acp_fn_unbind(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  (void)argc; (void)argv;
  int was = acp_binding.active;
  memset(&acp_binding, 0, sizeof acp_binding);
  sqlite3_result_int(ctx, was);
}

static void acp_fn_stats(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  (void)argc; (void)argv;
  char out[512];
  snprintf(out, sizeof out, "active=%d mainOpens=%d journalOpens=%d refusals=%d refusal=%s",
           acp_binding.active, acp_binding.main_opens, acp_binding.journal_opens,
           acp_binding.refusals, acp_binding.last_refusal);
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
