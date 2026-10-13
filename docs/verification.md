# Verification evidence

Everything below was run and observed. Anything not verified is listed at the end.

## Summary

| Check                    | Command                                                     | Result                                                                                                                                               |
| ------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format, lint, typecheck  | `npm run format:check && npm run lint && npm run typecheck` | ✅ clean (local and CI)                                                                                                                              |
| API and regression tests | `npm test`                                                  | ✅ 45 passed, 4 files (local Windows and CI Ubuntu)                                                                                                  |
| End-to-end tests         | `npm run test:e2e`                                          | ✅ 5 passed (local and CI)                                                                                                                           |
| Build                    | `npm run build`                                             | ✅ (CI `check` job)                                                                                                                                  |
| Deployment               | `deploy` job on `main`                                      | ✅ [run 38340413346](https://github.com/clintgalendez/dealership-inventory/actions/runs/38340413346), version `ad81a003-b514-481d-a0e3-dce584d0f4c9` |
| Deployed smoke test      | `npm run smoke` in the `deploy` job                         | ✅ 4 passed against https://dealership-inventory.galendez-clintjonathan.workers.dev                                                                  |
| Health                   | `curl …/api/health`                                         | ✅ `{"status":"ok","db":"ok","version":"12a4bd948bd6d29482a2e061e483054e90fcf4f3"}` (matches the merged commit)                                      |

## Pipeline runs

| Run                                                                                           | Commit    | Event          | Outcome                                                                             |
| --------------------------------------------------------------------------------------------- | --------- | -------------- | ----------------------------------------------------------------------------------- |
| [38338135288](https://github.com/clintgalendez/dealership-inventory/actions/runs/38338135288) | `233fa77` | PR #2          | ❌ `check` failed: regression test against the defective handler (no deploy on PRs) |
| [38338255265](https://github.com/clintgalendez/dealership-inventory/actions/runs/38338255265) | `2293399` | PR #2          | ✅ `check` passed with the atomic fix                                               |
| [38338580309](https://github.com/clintgalendez/dealership-inventory/actions/runs/38338580309) | `6468c53` | PR #2          | ✅ `check` + `e2e`                                                                  |
| [38340037069](https://github.com/clintgalendez/dealership-inventory/actions/runs/38340037069) | `9167fea` | push to `main` | ⚠️ checks, migrations and deploy succeeded; smoke test failed (see below)           |
| [38340413346](https://github.com/clintgalendez/dealership-inventory/actions/runs/38340413346) | `12a4bd9` | push to `main` | ✅ `check` → `e2e` → `deploy` (migrate, deploy, smoke)                              |

### The first deploy's smoke failure

In run 38340037069, `/api/health` already reported the new commit. The next requests to the
brand-new workers.dev hostname, however, returned Cloudflare 404s (`frontend is served: 404 !==
200`, `login alex.admin@northside.example: 404 !== 200`). Meanwhile an invalid-login request in
the same second reached the Worker and got its 401.

Minutes later the same URLs returned 200, so the cause was edge propagation of a new hostname, not
the release. The smoke test now requires five consecutive healthy probes of the API (with the
expected commit) and the SPA before its functional checks (PR #4). It passed against production
locally and in run 38340413346.

## Concurrency regression: before and after

`npx vitest run test/concurrency.test.ts` at `233fa77` (defective read-check-write handler):

```
 FAIL  test/concurrency.test.ts > concurrent edits from the same starting version > accepts exactly one edit and rejects the other with 409 without overwriting it
AssertionError: expected [ 200, 200 ] to deeply equal [ 200, 409 ]
- Expected
+ Received
  [
    200,
-   409,
+   200,
  ]
 Test Files  1 failed (1)
      Tests  1 failed (1)
```

The same failure appeared on CI (Ubuntu, run 38338135288) and in 5 of 5 local runs.

At `2293399` (atomic conditional `UPDATE … WHERE version = ? RETURNING`):

```
 Test Files  1 passed (1)
      Tests  1 passed (1)
```

This passed in 5 of 5 local runs and on CI.

**Diagnosis note.** The first version of the regression test just fired the two requests with
`Promise.all`, and it _passed_ against the defect. Logging showed why: in one round, Alex's read
and write both finished before Blair's read began, so the race window never opened. In another
round the reads interleaved and the defect appeared. That is timing-dependent, so it is not a
usable regression test.

The test now holds every `UPDATE vehicles` statement until both requests have reached their
write. One more pitfall: an early version released the waiting request's promise from the other
request, which Workers rejects ("Cannot perform I/O on behalf of a different request"). Each
request therefore polls a shared counter with its own timers.

## Deployed smoke test output (run 38340413346)

```
Uploaded dealership-inventory (2.62 sec)
  https://dealership-inventory.galendez-clintjonathan.workers.dev
Current Version ID: ad81a003-b514-481d-a0e3-dce584d0f4c9
✔ health endpoint is up and serving the expected release
✔ frontend is served
✔ invalid credentials and missing sessions are rejected
✔ access boundaries, allowed update, stale edit conflict and logout
ℹ tests 4
ℹ pass 4
ℹ fail 0
```

The last test covers:

- a scoped list;
- a cross-dealership read and update (404), with Lakeside's row unchanged;
- a viewer edit (403), with the row unchanged;
- an allowed admin update;
- a stale-version update (409), with the newer value preserved;
- two concurrent admin edits against the real D1, giving exactly one 200 and one 409;
- restoring the vehicle;
- logout invalidating the session.

## Direct API requests against production

These bypass the frontend. Session cookies are redacted.

```
$ GET /api/vehicles (no cookie)
{"error":{"code":"UNAUTHENTICATED","message":"Sign in to continue."}} -> HTTP 401

$ PUT /api/vehicles/3 as casey (viewer)
{"error":{"code":"FORBIDDEN","message":"Only administrators can edit vehicles."}} -> HTTP 403

$ GET /api/vehicles/4 as alex (Northside admin, Lakeside vehicle)
{"error":{"code":"NOT_FOUND","message":"Vehicle not found."}} -> HTTP 404

$ PUT /api/vehicles/4 as alex
{"error":{"code":"NOT_FOUND","message":"Vehicle not found."}} -> HTTP 404

$ GET /api/vehicles/3 as alex (unchanged after viewer attempt)
{"vehicle":{"id":3,"make":"Ford","model":"F-150","year":2023,"status":"available","version":7,…}} -> HTTP 200
```

Vehicle 3's version is 7 rather than 1 because each smoke run updates it and then restores it.

## Defect found by the smoke test

Running the smoke test against `vite preview` turned up a real bug: a request rejected before its
body was read (401 or 403) made the _next_ request on the same keep-alive connection fail with a
500 (`TypeError: fetch failed` inside the local runtime). A minimal script reproduced it for both
401 and 403. `body.cancel()` did not help; fully draining the body did. The fix is in the `/api/*`
middleware (commit `f568307`).

## End-to-end tests (Playwright, CI run 38340413346)

```
ok 1 › conflict.spec.ts › a stale save shows a conflict and requires a refresh before retrying
ok 2 › inventory.spec.ts › admin signs in, sees only their dealership, updates a vehicle and the change survives a reload
ok 3 › inventory.spec.ts › invalid credentials show a clear error
ok 4 › inventory.spec.ts › viewer sees their inventory without edit controls
ok 5 › inventory.spec.ts › a session invalidated elsewhere sends the user back to login
5 passed
```

## API tests

`npm test` → `Test Files 4 passed (4)`, `Tests 45 passed (45)`:

- `auth.test.ts`: valid login and cookie flags; wrong password and unknown email (same 401);
  malformed, missing and empty bodies (400); missing, forged, unprefixed and expired sessions;
  current user; logout invalidation; per-session logout; CSRF form post (403).
- `vehicles.test.ts`: scoped lists for all four admin/viewer combinations; client dealership
  filters ignored; scoped detail; cross-dealership and unknown-id 404s; an admin update persists;
  trimming. Each of the following asserts the row is unchanged: viewer 403s, cross-dealership
  404s, missing/forged/logged-out 401s, seven invalid bodies (400), and a sequential stale edit
  (409).
- `concurrency.test.ts`: the concurrent same-version regression.
- `health.test.ts`: health shape and no extra fields.

## Not verified

- **Loom recording:** not made yet.
- **A live Worker rollback** (`wrangler rollback`) and **D1 Time Travel restore** are documented
  but were not exercised. Neither was required.
- **Browsers other than Chromium** were not tested.
