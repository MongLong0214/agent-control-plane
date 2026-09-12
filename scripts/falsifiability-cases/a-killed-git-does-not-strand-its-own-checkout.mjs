/**
 * #871 — a git that could not run must not make its own operation permanently unretryable.
 *
 * `bootstrapLocalCheckout` writes an ownership marker, binds `cleanup`, and then runs five git
 * calls. `cleanup()` was on each *denial* path and on none of the throwing ones — harmless while
 * three of those calls passed `allowFailure: true` and returned a nonzero exit code instead of
 * throwing. #859's time bound changed that: a git that outlives its bound raises `GIT_TIMEOUT`.
 *
 * The throw skipped `cleanup()`, so the checkout and its ownership marker survived, and
 * `createCheckoutLeafOrDeny` then refused **every** retry with `EEXIST` — *"a same-named resource
 * with unknown provenance is a collision, not a resume"*. One slow git made the operation
 * permanently unretryable, by the exact mechanism the marker was added to prevent: that function's
 * own docstring promises the marker exists "so the same operation can be retried rather than being
 * permanently refused by its own leftover collision".
 *
 * The mutation drops the cleanup from the wrapper's catch, which is the shipped behaviour. It is
 * killed by the case that points `PATH` at a directory with no git in it, runs the producer, then
 * restores `PATH` and runs the *same* `bootstrapOperationId` again — an unresolvable binary throws
 * from `git()` through the identical path as a timeout and does not need a 120 s bound to expire.
 */
const aKilledGitDoesNotStrandItsOwnCheckout = {
  id: "a-killed-git-does-not-strand-its-own-checkout",
  what: "a git that threw cleans up its own checkout, so the same bootstrap operation can be retried",
  file: "src/bootstrap/repo-factory-producer.ts",
  find: "    } catch (err) {\n      cleanup();\n      throw err;\n    }\n",
  replace: "    } catch (err) {\n      throw err;\n    }\n",
  killedBy: [
    "tests/unit/repo-factory-producer.test.ts::cleans up after a git that could not run, so the same operation can still be retried",
  ],
};

export default aKilledGitDoesNotStrandItsOwnCheckout;
