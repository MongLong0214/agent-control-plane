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
#include <pthread.h>
#include <time.h>
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

/**
 * The lease that authorises one binding, and the lock that makes the state it guards atomic.
 *
 * The first version of this was a counter, and I described it as "an identifier, not a secret".
 * That was a rationalisation of a design that was simply forgeable, and review demonstrated it:
 * the lease was 1, and `acp_fd_unbind(1.9)` released it — `sqlite3_value_int64` coerces a REAL,
 * so even guessing the wrong type worked. A capability that a stranger can guess or coerce is not
 * a capability.
 *
 * So the lease is now sixteen bytes from the kernel's entropy source, presented as thirty-two hex
 * characters, accepted only as TEXT of exactly that length, and compared in constant time. There
 * is no numeric form to coerce and nothing to count up to.
 *
 * The lock exists because the default VFS is process-global and none of this state was
 * synchronised. Review drove two threads through the bind path with a barrier after the
 * active-check and both succeeded, one silently replacing the other. The same shape covers the
 * open cap: check, `dup`, increment were three steps with no mutual exclusion. Recursive, because
 * one entry point drives another (`xDelete` through the probe path) and a self-deadlock would be a
 * worse failure than the race.
 */
#define ACP_LEASE_BYTES 16
#define ACP_LEASE_CHARS 32

static pthread_mutex_t acp_mutex;
static pthread_once_t acp_mutex_once = PTHREAD_ONCE_INIT;

/*
 * Whether the mutex is usable. Every step of bringing it up can fail, and ignoring those returns
 * meant a failed initialisation continued straight into unsynchronised access to the very state
 * the mutex exists to protect — the fault would show up as corruption somewhere else entirely.
 */
static int acp_mutex_ready = 0;

static void acp_mutex_init(void) {
  pthread_mutexattr_t attributes;
  if (pthread_mutexattr_init(&attributes) != 0) return;
  if (pthread_mutexattr_settype(&attributes, PTHREAD_MUTEX_RECURSIVE) != 0) {
    /* Already failing; the destroy result cannot change that, but it is read rather than voided so
       no line here claims a result it did not look at. */
    if (pthread_mutexattr_destroy(&attributes) != 0) return;
    return;
  }
  if (pthread_mutex_init(&acp_mutex, &attributes) != 0) {
    if (pthread_mutexattr_destroy(&attributes) != 0) return;
    return;
  }
  /* Checked like every other step: a destroy that fails means the attributes object is in an
     unknown state, and starting from an unknown state is what this whole function avoids. */
  if (pthread_mutexattr_destroy(&attributes) != 0) return;
  acp_mutex_ready = 1;
}

/* Declared before use: in the shipping build these are nothing at all. */
#ifdef ACP_FD_VFS_TESTING
static void acp_seam_enter_lock_queue(void);
static void acp_seam_leave_lock_queue(void);
static void acp_seam_arrive(void);
#else
#define acp_seam_enter_lock_queue() ((void)0)
#define acp_seam_leave_lock_queue() ((void)0)
#define acp_seam_arrive() ((void)0)
#endif

/** Acquires the state lock. Returns 0 when it could not be taken; the caller must then refuse. */
static int acp_state_lock(void) {
  if (pthread_once(&acp_mutex_once, acp_mutex_init) != 0) return 0;
  if (!acp_mutex_ready) return 0;
  acp_seam_enter_lock_queue();
  int rc = pthread_mutex_lock(&acp_mutex);
  acp_seam_leave_lock_queue();
  return rc == 0;
}

#ifdef ACP_FD_VFS_TESTING
static int acp_test_unlock_fails = 0;
#endif

/**
 * Releases the state lock, balancing exactly one successful acquisition. Returns 0 on failure.
 *
 * An unlock that fails leaves the mutex in a state nothing here can reason about, so the lock is
 * marked permanently unusable and every later acquisition fails. Recording that internally was not
 * enough: callers went on returning a lease, a 1, or `SQLITE_OK` while the state they had just
 * mutated was no longer protected by anything. The status is returned so each caller can say what
 * is actually true — and none of them claims a rollback it cannot perform.
 */
static int acp_state_unlock(void) {
#ifdef ACP_FD_VFS_TESTING
  if (acp_test_unlock_fails > 0) {
    acp_test_unlock_fails -= 1;
    /* Checked like the real one: the seam simulates a failed release, it does not get to skip
       releasing, and an unnoticed failure here would be the same defect wearing a test hat. */
    if (pthread_mutex_unlock(&acp_mutex) != 0) { /* already the failure being simulated */ }
    acp_mutex_ready = 0;
    return 0;
  }
#endif
  if (pthread_mutex_unlock(&acp_mutex) != 0) {
    acp_mutex_ready = 0;
    return 0;
  }
  return 1;
}

/*
 * A rendezvous inside `bind`, compiled only into the test artifact, driven by the parent.
 *
 * The first version used a timeout as its authority: the arriving thread waited a second, and with
 * the lock held the second thread could not arrive, so the first proceeded when the clock said so.
 * That makes elapsed time the evidence, and it cannot show the mutant deterministically either —
 * measured, with the lock removed, forty unsynchronised rounds produced a double binding only
 * three times.
 *
 * So the parent decides. Two counters are published: how many threads have reached the seam, and
 * how many are queued for the state lock. Both worlds then have a definite predicate the parent can
 * wait for rather than a duration:
 *
 *   - with the lock: one thread arrives and the other is queued  (arrived >= 1 && waiters >= 1)
 *   - without it:    both threads arrive                          (arrived >= 2)
 *
 * The parent releases once its predicate holds and then joins both workers, so the assertion runs
 * against finished threads rather than against a hope about timing. These counters live under
 * their own mutex — never the state lock — because the parent has to be able to read them while a
 * worker is inside the critical section.
 */
#ifdef ACP_FD_VFS_TESTING
static pthread_mutex_t acp_seam_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t acp_seam_cond = PTHREAD_COND_INITIALIZER;
static int acp_seam_armed = 0;
static int acp_seam_arrived = 0;
static int acp_seam_released = 0;
static int acp_seam_waiters = 0;

static void acp_seam_enter_lock_queue(void) {
  pthread_mutex_lock(&acp_seam_mutex);
  if (acp_seam_armed) acp_seam_waiters += 1;
  pthread_mutex_unlock(&acp_seam_mutex);
}

static void acp_seam_leave_lock_queue(void) {
  pthread_mutex_lock(&acp_seam_mutex);
  if (acp_seam_armed && acp_seam_waiters > 0) acp_seam_waiters -= 1;
  pthread_mutex_unlock(&acp_seam_mutex);
}

static void acp_seam_arrive(void) {
  pthread_mutex_lock(&acp_seam_mutex);
  if (!acp_seam_armed) {
    pthread_mutex_unlock(&acp_seam_mutex);
    return;
  }
  acp_seam_arrived += 1;
  pthread_cond_broadcast(&acp_seam_cond);
  while (!acp_seam_released) pthread_cond_wait(&acp_seam_cond, &acp_seam_mutex);
  pthread_mutex_unlock(&acp_seam_mutex);
}
#endif

static unsigned char acp_lease[ACP_LEASE_BYTES];static unsigned char acp_lease[ACP_LEASE_BYTES];
static int acp_lease_held = 0;

/*
 * Syscall seams, compiled only into the test artifact.
 *
 * The entropy path has three failure modes that never occur on a healthy machine and all of which
 * decide whether a lease is trustworthy: a short read, an interrupted read, and a close that
 * fails. Without a way to induce them the retry and the cleanup ship unexecuted, which is the
 * condition they exist for. The seams are one-shot counters, absent from the shipping build, and
 * they can only make entropy collection *fail* — never succeed with weaker bytes.
 */
#ifdef ACP_FD_VFS_TESTING
static int acp_test_short_reads = 0;   /* serve one byte at a time for this many reads */
static int acp_test_eintr_reads = 0;   /* fail this many reads with EINTR before serving */
static int acp_test_close_fails = 0;   /* report the descriptor close as failed */
#endif

static ssize_t acp_entropy_read(int fd, unsigned char *out, size_t want) {
#ifdef ACP_FD_VFS_TESTING
  if (acp_test_eintr_reads > 0) {
    acp_test_eintr_reads -= 1;
    errno = EINTR;
    return -1;
  }
  if (acp_test_short_reads > 0) {
    acp_test_short_reads -= 1;
    want = 1;
  }
#endif
  return read(fd, out, want);
}

static int acp_entropy_close(int fd) {
#ifdef ACP_FD_VFS_TESTING
  if (acp_test_close_fails > 0) {
    acp_test_close_fails -= 1;
    close(fd);
    return -1;
  }
#endif
  return close(fd);
}

/**
 * Fills `out` from the kernel's entropy source. Returns 0 on failure; the caller must refuse.
 *
 * An interrupted read is retried rather than treated as failure — `read` returning -1 with EINTR
 * has produced no bytes and says nothing about the source. A close that fails is treated as
 * failure even though the bytes are already in hand: this is the one place where being wrong is
 * unrecoverable, and refusing to bind costs an operator a retry.
 */
static int acp_random_bytes(unsigned char *out, size_t count) {
  int fd = open("/dev/urandom", O_RDONLY);
  if (fd < 0) return 0;
  size_t filled = 0;
  while (filled < count) {
    ssize_t got = acp_entropy_read(fd, out + filled, count - filled);
    if (got < 0) {
      if (errno == EINTR) continue;
      acp_entropy_close(fd);
      return 0;
    }
    if (got == 0) {
      acp_entropy_close(fd);
      return 0;
    }
    filled += (size_t)got;
  }
  if (acp_entropy_close(fd) != 0) return 0;
  return 1;
}

static void acp_to_hex(const unsigned char *bytes, size_t count, char *out) {
  static const char digits[] = "0123456789abcdef";
  for (size_t i = 0; i < count; i += 1) {
    out[i * 2] = digits[bytes[i] >> 4];
    out[i * 2 + 1] = digits[bytes[i] & 0x0f];
  }
  out[count * 2] = '\0';
}

/**
 * Strict decode: exactly `count` bytes from `2*count` **lowercase** hex digits.
 *
 * Uppercase was accepted, and review used it: `acp_fd_unbind(upper(lease))` released the binding
 * from a second connection. A capability with more than one spelling has more than one holder in
 * every sense that matters — the lease is minted in exactly one form, so exactly one form is
 * accepted, and `A`-`F` is a refusal rather than an alias.
 */
static int acp_from_hex(const char *text, size_t chars, unsigned char *out, size_t count) {
  if (chars != count * 2) return 0;
  for (size_t i = 0; i < count; i += 1) {
    int high = -1, low = -1;
    for (int half = 0; half < 2; half += 1) {
      char c = text[i * 2 + half];
      int value;
      if (c >= '0' && c <= '9') value = c - '0';
      else if (c >= 'a' && c <= 'f') value = c - 'a' + 10;
      else return 0;
      if (half == 0) high = value; else low = value;
    }
    out[i] = (unsigned char)((high << 4) | low);
  }
  return 1;
}

/** Constant time: a comparison that returns early leaks how much of a guess was right. */
static int acp_same_lease(const unsigned char *candidate) {
  unsigned char difference = 0;
  for (size_t i = 0; i < ACP_LEASE_BYTES; i += 1) difference |= candidate[i] ^ acp_lease[i];
  return difference == 0;
}

/** The one active binding, held under `acp_lease`. */
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
  int main_opens;   /* cumulative, for observation */
  int main_ever;    /* whether this lease has ever admitted a main open — the cap */
  int live_files;   /* every binding-owned file currently open — the lifetime guard for release */
  int journal_opens;
  int deletes;
  int dir_syncs;
  int refusals;
  char last_refusal[256];
} acp_binding;

typedef struct AcpFile AcpFile;
/**
 * What one open file needs, held on the file rather than read back off the binding.
 *
 * `xClose` used to consult the global binding for the directory descriptor it unlinks through. A
 * release is allowed to happen while a file is still open, and it clears exactly those fields — so
 * a close racing a valid unbind could unlink through a descriptor that had been cleared, or worse,
 * reused for something else by then. A file that carries its own duplicate of the directory
 * descriptor does not need the binding to still exist, and closing it touches nothing shared.
 */
struct AcpFile {
  const sqlite3_io_methods *pMethods;
  int fd;
  int dir_fd;            /* this file's own duplicate; -1 when it needs none */
  int delete_on_close;
  int owned_by_binding;  /* so the live-file accounting is balanced by this file's own close */
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

#ifdef ACP_FD_VFS_TESTING
/*
 * What the last `xClose` returned.
 *
 * `sqlite3_close` does not surface a VFS close failure to its caller — SQLite discards the result
 * on most paths — so a test that watches the connection's close cannot see this at all. The
 * requirement is about what `xClose` returns, so that is what is recorded and asserted.
 */
static int acp_last_close_rc = -1;
#endif

static int acp_close(sqlite3_file *file) {
  AcpFile *f = (AcpFile *)file;
  int outcome = SQLITE_OK;
  if (f->delete_on_close && f->dir_fd >= 0 && f->base[0]) {
    unlinkat(f->dir_fd, f->base, 0);
  }
  if (f->owned_by_binding) {
    /* Balanced against the increment in `xOpen`, under the same lock, so the live count means
       currently open. */
    if (acp_state_lock()) {
      if (acp_binding.live_files > 0) acp_binding.live_files -= 1;
      /*
       * The count has already moved, so a failed release here leaves the accounting unprotected.
       * Reporting `SQLITE_OK` after that was a false success: the caller was told the file closed
       * cleanly while the state describing it was no longer guarded by anything. Ownership is
       * cleared exactly once either way — the decrement happened — and the descriptors below are
       * still closed, so the answer is "closed, but the outcome is not trustworthy".
       */
      if (!acp_state_unlock()) outcome = SQLITE_IOERR_CLOSE;
      f->owned_by_binding = 0;
    } else {
      /* The lock was already gone before the decrement, so the count is left as it is: a release
         is refused while anything is open, which keeps the binding held rather than freeing it
         wrongly. The close is still not a success. */
      outcome = SQLITE_IOERR_CLOSE;
    }
  }
  if (f->dir_fd >= 0) close(f->dir_fd);
  f->dir_fd = -1;
  if (f->fd >= 0) close(f->fd);
  f->fd = -1;
#ifdef ACP_FD_VFS_TESTING
  acp_last_close_rc = outcome;
#endif
  return outcome;
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

  /*
   * Everything from here to the return reads and writes the binding, so it is one critical
   * section. The open cap in particular was three separate steps — check the count, `dup` the
   * descriptor, increment — and two threads could each pass the check before either incremented.
   */
  if (!acp_state_lock()) {
    /* Without the lock nothing here can tell whether a binding is active, and guessing is the
       failure this exists to prevent. */
    return SQLITE_CANTOPEN;
  }
  if (!acp_binding.active || path == 0) {
    if (!acp_state_unlock()) return SQLITE_IOERR;
    return acp_parent->xOpen(acp_parent, path, file, flags, out);
  }

  const char *base = acp_basename(path);
  AcpFile *f = (AcpFile *)file;

  if (flags & SQLITE_OPEN_MAIN_DB) {
    if (!acp_is_bound_database(path)) {
      /*
       * A different database is not this binding's business.
       *
       * This used to refuse every main open that was not the bound one, which read as caution and
       * was actually over-broad: the binding is a promise about one pathname — that it can only
       * ever open the verified descriptor — not a sandbox over every database the process might
       * touch. Wiring the migration made the cost visible. `Db.migrate` takes its recovery point
       * with `VACUUM INTO`, and SQLite opens that destination as a database, so the refusal
       * removed the backup the whole approval mechanism rests on.
       *
       * Delegation gives the stranger its own file through the wrapped VFS. It never receives the
       * bound descriptor and never touches this binding's accounting, which is what the refusal
       * was there to prevent.
       */
      if (!acp_state_unlock()) return SQLITE_IOERR;
      return acp_parent->xOpen(acp_parent, path, file, flags, out);
    }
    if (acp_binding.main_ever) {
      /*
       * One lease, one connection — and "one" is counted for the life of the lease, not for the
       * moment. Making this a live count weakened the contract into "not concurrently open", which
       * lets a lease open, close, and open again; I had even written a test that codified the
       * weaker rule as if it were the intended one. Admission is monotonic, and it is decided
       * before the descriptor is duplicated so a refusal costs nothing.
       */
      acp_refuse("the bound database has already been opened under this lease");
      return acp_state_unlock() ? SQLITE_CANTOPEN : SQLITE_IOERR;
    }
    struct stat st;
    if (fstat(acp_binding.main_fd, &st) != 0 ||
        st.st_dev != acp_binding.dev || st.st_ino != acp_binding.ino) {
      acp_refuse("the bound descriptor is no longer the verified object");
      return acp_state_unlock() ? SQLITE_CANTOPEN : SQLITE_IOERR;
    }
    memset(f, 0, sizeof *f);
    f->dir_fd = -1;
    f->fd = dup(acp_binding.main_fd);
    if (f->fd < 0) {
      acp_refuse("could not duplicate the bound descriptor");
      return acp_state_unlock() ? SQLITE_CANTOPEN : SQLITE_IOERR;
    }
    f->pMethods = &acp_io_methods;
    if (out) *out = SQLITE_OPEN_READWRITE;
    f->owned_by_binding = 1;
    acp_binding.main_opens++;
    acp_binding.main_ever = 1;
    acp_binding.live_files++;
    if (!acp_state_unlock()) {
      /* This one *is* reversible: nothing has been read or written through the handle yet, so the
         descriptor is closed and the open fails rather than succeeding under a broken lock. */
      close(f->fd);
      f->fd = -1;
      f->pMethods = 0;
      return SQLITE_IOERR;
    }
    return SQLITE_OK;
  }

  if (flags & SQLITE_OPEN_WAL) {
    if (!acp_is_bound_sibling(path)) {
      /* Another database's log. Delegated for the same reason its main file is. */
      if (!acp_state_unlock()) return SQLITE_IOERR;
      return acp_parent->xOpen(acp_parent, path, file, flags, out);
    }
    /* The bound target's own log: refused rather than delegated, because this binding cannot own
       a shared-memory family and opening one beside the bound file would be exactly that. */
    acp_refuse("write-ahead logging is not available on a bound connection");
    return acp_state_unlock() ? SQLITE_CANTOPEN : SQLITE_IOERR;
  }

  if (flags & (SQLITE_OPEN_MAIN_JOURNAL | SQLITE_OPEN_SUPER_JOURNAL)) {
    if (!acp_is_bound_sibling(path)) {
      /* Another database's journal. It belongs to whoever opened that database. */
      if (!acp_state_unlock()) return SQLITE_IOERR;
      return acp_parent->xOpen(acp_parent, path, file, flags, out);
    }
    int how = O_RDWR | O_CREAT;
    if (flags & SQLITE_OPEN_EXCLUSIVE) how |= O_EXCL;
    int fd = openat(acp_binding.dir_fd, base, how, 0600);
    if (fd < 0) {
      acp_refuse("could not open the journal in the bound directory");
      return acp_state_unlock() ? SQLITE_CANTOPEN : SQLITE_IOERR;
    }
    memset(f, 0, sizeof *f);
    f->dir_fd = dup(acp_binding.dir_fd);
    if (f->dir_fd < 0) {
      close(fd);
      acp_refuse("could not duplicate the bound directory descriptor");
      return acp_state_unlock() ? SQLITE_CANTOPEN : SQLITE_IOERR;
    }
    f->fd = fd;
    f->delete_on_close = (flags & SQLITE_OPEN_DELETEONCLOSE) ? 1 : 0;
    snprintf(f->base, sizeof f->base, "%s", base);
    f->pMethods = &acp_io_methods;
    if (out) *out = SQLITE_OPEN_READWRITE;
    /* A journal is as much this binding's file as the database is: it was opened through the
       binding's directory descriptor and its close decrements the same counter. Counting only main
       opens meant a live journal did not keep its own lease alive. */
    f->owned_by_binding = 1;
    acp_binding.journal_opens++;
    acp_binding.live_files++;
    if (!acp_state_unlock()) {
      close(f->fd);
      if (f->dir_fd >= 0) close(f->dir_fd);
      f->fd = -1;
      f->dir_fd = -1;
      f->pMethods = 0;
      return SQLITE_IOERR;
    }
    return SQLITE_OK;
  }

  /* Temporary files and everything else the connection needs are not part of the bound family. */
  if (!acp_state_unlock()) return SQLITE_IOERR;
  return acp_parent->xOpen(acp_parent, path, file, flags, out);
}

/*
 * `xAccess` and `xDelete` are half of the journal's lifecycle — "is there a hot journal?" and
 * "remove it" — so leaving them on the parent would put the pathname back in charge of exactly the
 * files this binding exists to own.
 */
static int acp_access(sqlite3_vfs *vfs, const char *path, int flags, int *out) {
  if (!acp_state_lock()) return SQLITE_IOERR_ACCESS;
  if (acp_binding.active && path && acp_is_bound_sibling(path)) {
    int mode = (flags == SQLITE_ACCESS_READWRITE) ? (R_OK | W_OK) : F_OK;
    *out = faccessat(acp_binding.dir_fd, acp_basename(path), mode, 0) == 0;
    return acp_state_unlock() ? SQLITE_OK : SQLITE_IOERR_ACCESS;
  }
  if (!acp_state_unlock()) return SQLITE_IOERR_ACCESS;
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
  if (!acp_state_lock()) return SQLITE_IOERR_DELETE;
  if (acp_binding.active && path && acp_is_bound_sibling(path)) {
    acp_binding.deletes++;
    if (unlinkat(acp_binding.dir_fd, acp_basename(path), 0) != 0 && errno != ENOENT) {
      if (!acp_state_unlock()) return SQLITE_IOERR_DELETE;
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
      if (failed) {
        if (!acp_state_unlock()) return SQLITE_IOERR_DELETE;
        return SQLITE_IOERR_DIR_FSYNC;
      }
    }
    return acp_state_unlock() ? SQLITE_OK : SQLITE_IOERR_DELETE;
  }
  if (!acp_state_unlock()) return SQLITE_IOERR_DELETE;
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
  if (!acp_state_lock()) {
    sqlite3_result_error(ctx, "the binding lock is unavailable; refusing to bind", -1);
    return;
  }
  if (acp_binding.active) {
    if (!acp_state_unlock()) {
      sqlite3_result_error(ctx, "the state lock failed while refusing a second binding", -1);
      return;
    }
    sqlite3_result_error(
        ctx, "a binding is already active; release it with its lease before taking another", -1);
    return;
  }
  /* The scheduling point the race test drives; a no-op in the shipping build. */
  acp_seam_arrive();
  unsigned char minted[ACP_LEASE_BYTES];
  if (!acp_random_bytes(minted, sizeof minted)) {
    if (!acp_state_unlock()) {
      sqlite3_result_error(ctx, "the state lock failed while refusing to bind", -1);
      return;
    }
    sqlite3_result_error(ctx, "could not obtain entropy for a lease; refusing to bind", -1);
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
  memcpy(acp_lease, minted, sizeof acp_lease);
  acp_lease_held = 1;
  if (!acp_state_unlock()) {
    /* The binding is already taken and the lock is gone, so it cannot be undone under exclusion.
       Saying so is the only honest answer: claiming a rollback here would be a lie, and returning
       the lease would be a promise nothing can keep. */
    sqlite3_result_error(
        ctx, "the binding was taken but the state lock failed; this process can no longer manage it",
        -1);
    return;
  }
  /* The lease, as text. No integer form exists, so there is nothing for a caller to coerce. */
  char hex[ACP_LEASE_CHARS + 1];
  acp_to_hex(acp_lease, ACP_LEASE_BYTES, hex);
  sqlite3_result_text(ctx, hex, ACP_LEASE_CHARS, SQLITE_TRANSIENT);
}

static void acp_fn_unbind(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  if (argc != 1) {
    sqlite3_result_error(ctx, "acp_fd_unbind(lease)", -1);
    return;
  }
  /*
   * TEXT only, and of exactly the minted length. Accepting anything SQLite would coerce is how the
   * previous lease fell: it was the integer 1, and `acp_fd_unbind(1.9)` released it because
   * `sqlite3_value_int64` rounds a REAL. There is no numeric representation of a lease to coerce
   * into, and a wrong type is a refusal rather than a conversion.
   */
  if (sqlite3_value_type(argv[0]) != SQLITE_TEXT) {
    sqlite3_result_error(ctx, "a lease is text; nothing else is accepted", -1);
    return;
  }
  const char *text = (const char *)sqlite3_value_text(argv[0]);
  int chars = sqlite3_value_bytes(argv[0]);
  unsigned char candidate[ACP_LEASE_BYTES];
  if (text == 0 || chars != ACP_LEASE_CHARS ||
      !acp_from_hex(text, (size_t)chars, candidate, ACP_LEASE_BYTES)) {
    sqlite3_result_error(ctx, "that is not the shape of a lease", -1);
    return;
  }

  if (!acp_state_lock()) {
    sqlite3_result_error(ctx, "the binding lock is unavailable; refusing to release", -1);
    return;
  }
  if (!acp_binding.active) {
    /* Releasing nothing is not an error: a bracket must be able to run its release without having
       to know whether the acquire got that far. */
    if (!acp_state_unlock()) {
      sqlite3_result_error(ctx, "the state lock failed while releasing nothing", -1);
      return;
    }
    sqlite3_result_int(ctx, 0);
    return;
  }
  if (!acp_lease_held || !acp_same_lease(candidate)) {
    if (!acp_state_unlock()) {
      sqlite3_result_error(ctx, "the state lock failed while refusing a release", -1);
      return;
    }
    sqlite3_result_error(ctx, "that lease does not hold the active binding", -1);
    return;
  }
  if (acp_binding.live_files > 0) {
    /*
     * The lifetime, made explicit. Releasing while a file is still open leaves that file holding
     * descriptors whose owner has gone: its closes would have to consult state that no longer
     * describes anything. Refusing is the honest answer — the holder still has the connection and
     * can close it — and it removes the whole class rather than making the close defensive.
     */
    if (!acp_state_unlock()) {
      sqlite3_result_error(ctx, "the state lock failed while refusing a release", -1);
      return;
    }
    sqlite3_result_error(
        ctx, "a file of this binding is still open; close it before releasing", -1);
    return;
  }
  memset(&acp_binding, 0, sizeof acp_binding);
  memset(acp_lease, 0, sizeof acp_lease);
  acp_lease_held = 0;
  if (!acp_state_unlock()) {
    sqlite3_result_error(
        ctx, "the binding was released but the state lock failed; this process can no longer bind",
        -1);
    return;
  }
  sqlite3_result_int(ctx, 1);
}

#ifdef ACP_FD_VFS_TESTING

/** Reports what the last `xClose` returned, or -1 if none has run. Test-only. */
static void acp_fn_last_close_rc(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  (void)argc; (void)argv;
  sqlite3_result_int(ctx, acp_last_close_rc);
}

/** Arms `n` forced unlock failures. Test-only; see `acp_state_unlock`. */
static void acp_fn_test_break_unlock(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  acp_test_unlock_fails = (argc == 1) ? sqlite3_value_int(argv[0]) : 1;
  sqlite3_result_int(ctx, acp_test_unlock_fails);
}

/**
 * Marks the state lock unusable, or usable again. Test-only.
 *
 * A healthy machine never fails to create a mutex, so without a way to induce it the fail-closed
 * branches on every entry point would ship unexecuted — the same reason the entropy seams exist.
 */
static void acp_fn_test_break_lock(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  int broken = (argc == 1) ? sqlite3_value_int(argv[0]) : 1;
  acp_mutex_ready = broken ? 0 : 1;
  if (!broken) acp_test_unlock_fails = 0;
  sqlite3_result_int(ctx, broken ? 1 : 0);
}

/** Arms the entropy syscall seams: short reads, EINTR reads, close failures. Test-only. */
static void acp_fn_test_entropy(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  if (argc != 3) {
    sqlite3_result_error(ctx, "acp_fd_test_entropy(shortReads, eintrReads, closeFails)", -1);
    return;
  }
  acp_test_short_reads = sqlite3_value_int(argv[0]);
  acp_test_eintr_reads = sqlite3_value_int(argv[1]);
  acp_test_close_fails = sqlite3_value_int(argv[2]);
  sqlite3_result_int(ctx, 1);
}

/** Arms or disarms the bind rendezvous. Test-only. */
static void acp_fn_test_seam(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  int arm = (argc == 1) ? sqlite3_value_int(argv[0]) : 0;
  pthread_mutex_lock(&acp_seam_mutex);
  acp_seam_armed = arm ? 1 : 0;
  acp_seam_arrived = 0;
  acp_seam_released = 0;
  acp_seam_waiters = 0;
  pthread_mutex_unlock(&acp_seam_mutex);
  sqlite3_result_int(ctx, arm ? 1 : 0);
}

/** Publishes the rendezvous counters. Never takes the state lock — the parent reads these while a
    worker is inside the critical section. Test-only. */
static void acp_fn_test_seam_state(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  (void)argc; (void)argv;
  pthread_mutex_lock(&acp_seam_mutex);
  char out[96];
  snprintf(out, sizeof out, "arrived=%d waiters=%d released=%d",
           acp_seam_arrived, acp_seam_waiters, acp_seam_released);
  pthread_mutex_unlock(&acp_seam_mutex);
  sqlite3_result_text(ctx, out, -1, SQLITE_TRANSIENT);
}

/** Releases everyone waiting at the rendezvous, and anyone who reaches it later. Test-only. */
static void acp_fn_test_seam_release(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  (void)argc; (void)argv;
  pthread_mutex_lock(&acp_seam_mutex);
  acp_seam_released = 1;
  pthread_cond_broadcast(&acp_seam_cond);
  pthread_mutex_unlock(&acp_seam_mutex);
  sqlite3_result_int(ctx, 1);
}

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
  /* Snapshot under the mutex: reading the binding unlocked is the defect this file just fixed
     everywhere else, and a probe is not exempt from it. */
  if (!acp_state_lock()) {
    sqlite3_result_text(ctx, "lock unavailable", -1, SQLITE_TRANSIENT);
    return;
  }
  int active = acp_binding.active;
  if (!acp_state_unlock()) {
    sqlite3_result_text(ctx, "lock unavailable", -1, SQLITE_TRANSIENT);
    return;
  }
  if (!active) {
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
  /* Same reason as above: the path is shared state and is copied under the mutex. */
  if (!acp_state_lock()) {
    sqlite3_result_text(ctx, "lock unavailable", -1, SQLITE_TRANSIENT);
    return;
  }
  int active = acp_binding.active;
  char journal[ACP_MAX_PATH + 16];
  if (active) snprintf(journal, sizeof journal, "%s-journal", acp_binding.path);
  if (!acp_state_unlock()) {
    sqlite3_result_text(ctx, "lock unavailable", -1, SQLITE_TRANSIENT);
    return;
  }
  if (!active) {
    sqlite3_result_text(ctx, "no binding", -1, SQLITE_TRANSIENT);
    return;
  }
  int arm = (argc == 1) ? sqlite3_value_int(argv[0]) : 0;
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
  /* Seven shared fields; reading them unlocked can report a mixture of two states that never
     existed at any instant. */
  if (!acp_state_lock()) {
    sqlite3_result_text(ctx, "lock unavailable", -1, SQLITE_TRANSIENT);
    return;
  }
  snprintf(out, sizeof out,
           "active=%d mainOpens=%d journalOpens=%d liveFiles=%d deletes=%d dirSyncs=%d "
           "refusals=%d refusal=%s",
           acp_binding.active, acp_binding.main_opens, acp_binding.journal_opens,
           acp_binding.live_files, acp_binding.deletes, acp_binding.dir_syncs,
           acp_binding.refusals, acp_binding.last_refusal);
  /*
   * This exit had no unlock at all. A recursive mutex stays held by the thread that took it, so
   * every other thread blocked on the next open, forever — a reader of counters wedged the whole
   * process. It vanished when a later edit changed the text an earlier patch had anchored the
   * unlock to, which is why the pairing is now stated on every path rather than trusted.
   */
  if (!acp_state_unlock()) {
    sqlite3_result_text(ctx, "lock unavailable", -1, SQLITE_TRANSIENT);
    return;
  }
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
      sqlite3_create_function(db, "acp_fd_unbind", 1, SQLITE_UTF8, 0, acp_fn_unbind, 0, 0) != SQLITE_OK ||
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
                              acp_fn_probe_dir_sync, 0, 0) != SQLITE_OK ||
      sqlite3_create_function(db, "acp_fd_test_seam", 1, SQLITE_UTF8, 0,
                              acp_fn_test_seam, 0, 0) != SQLITE_OK ||
      sqlite3_create_function(db, "acp_fd_test_seam_state", 0, SQLITE_UTF8, 0,
                              acp_fn_test_seam_state, 0, 0) != SQLITE_OK ||
      sqlite3_create_function(db, "acp_fd_test_seam_release", 0, SQLITE_UTF8, 0,
                              acp_fn_test_seam_release, 0, 0) != SQLITE_OK ||
      sqlite3_create_function(db, "acp_fd_test_entropy", 3, SQLITE_UTF8, 0,
                              acp_fn_test_entropy, 0, 0) != SQLITE_OK ||
      sqlite3_create_function(db, "acp_fd_test_break_lock", 1, SQLITE_UTF8, 0,
                              acp_fn_test_break_lock, 0, 0) != SQLITE_OK ||
      sqlite3_create_function(db, "acp_fd_test_break_unlock", 1, SQLITE_UTF8, 0,
                              acp_fn_test_break_unlock, 0, 0) != SQLITE_OK ||
      sqlite3_create_function(db, "acp_fd_last_close_rc", 0, SQLITE_UTF8, 0,
                              acp_fn_last_close_rc, 0, 0) != SQLITE_OK) {
    return SQLITE_ERROR;
  }
#endif

  if (!acp_state_lock()) {
    if (err) *err = sqlite3_mprintf("acp-fd-vfs could not initialise its state lock");
    return SQLITE_ERROR;
  }
  if (acp_parent == 0) {
    acp_parent = sqlite3_vfs_find(0);
    if (acp_parent == 0) {
      if (!acp_state_unlock()) {
        if (err) *err = sqlite3_mprintf("acp-fd-vfs could not release its state lock during load");
      }
      return SQLITE_ERROR;
    }
    acp_shim = *acp_parent;
    acp_shim.zName = ACP_VFS_NAME;
    acp_shim.pNext = 0;
    acp_shim.xOpen = acp_open;
    acp_shim.xAccess = acp_access;
    acp_shim.xDelete = acp_delete;
    if ((int)sizeof(AcpFile) > acp_shim.szOsFile) acp_shim.szOsFile = (int)sizeof(AcpFile);
    int rc = sqlite3_vfs_register(&acp_shim, 1);
    if (rc != SQLITE_OK) {
      if (!acp_state_unlock()) {
        if (err) *err = sqlite3_mprintf("acp-fd-vfs could not release its state lock during load");
      }
      return rc;
    }
  }
  if (!acp_state_unlock()) {
    if (err) *err = sqlite3_mprintf("acp-fd-vfs could not release its state lock during load");
    return SQLITE_ERROR;
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
