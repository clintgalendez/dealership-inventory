# Dealership Inventory

A small full-stack inventory app for two fictional dealerships, deployed on Cloudflare's free tier.
Users sign in, see only their dealership's vehicles, and administrators edit make, model, year
and availability. The backend enforces authentication, roles and dealership isolation on every
request, and rejects stale edits atomically so two administrators can never overwrite each other.

|                                                          |                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Live app**                                             | https://dealership-inventory.galendez-clintjonathan.workers.dev                                                                                                                                                                                                                               |
| **Health**                                               | https://dealership-inventory.galendez-clintjonathan.workers.dev/api/health                                                                                                                                                                                                                    |
| **Loom walkthrough**                                     | _TODO: add Loom link_                                                                                                                                                                                                                                                                         |
| **Successful pipeline run** (checks, deploy, smoke test) | [run 38340413346](https://github.com/clintgalendez/dealership-inventory/actions/runs/38340413346)                                                                                                                                                                                             |
| **Regression demo**                                      | [PR #2](https://github.com/clintgalendez/dealership-inventory/pull/2): failing [run](https://github.com/clintgalendez/dealership-inventory/actions/runs/38338135288) on `233fa77`, passing [run](https://github.com/clintgalendez/dealership-inventory/actions/runs/38338255265) on `2293399` |
| **Test results and evidence**                            | [docs/verification.md](docs/verification.md)                                                                                                                                                                                                                                                  |

## Demo accounts

All accounts are synthetic and share the password **`Inventory-Demo-2026`**.

| Dealership                      | Administrator                  | Administrator                   | Viewer                           |
| ------------------------------- | ------------------------------ | ------------------------------- | -------------------------------- |
| Northside Motors (vehicles 1–3) | `alex.admin@northside.example` | `blair.admin@northside.example` | `casey.viewer@northside.example` |
| Lakeside Auto (vehicles 4–6)    | `dana.admin@lakeside.example`  | `eli.admin@lakeside.example`    | `finley.viewer@lakeside.example` |

Use Alex and Blair (same dealership) in two browser sessions to reproduce the concurrent-edit conflict.

## Architecture

```
Browser ──HTTPS──▶ Cloudflare Worker "dealership-inventory" (workers.dev)
                     ├─ /*      Workers Static Assets: React SPA (SPA fallback to index.html)
                     └─ /api/*  Hono API (runs first) ──▶ D1 (SQLite) "dealership-inventory"
```

- **One Worker serves both the SPA and the API.** Same origin means a plain cookie session with
  no CORS, one deploy, one version to verify and one rollback unit. The free plan covers it
  (100k requests/day; D1 5 GB, 5M reads/day).
- **D1** is Cloudflare's SQLite database. A single conditional `UPDATE` gives an atomic
  compare-and-set, which is exactly what stale-edit protection needs.
- **Stack:** TypeScript, React 19 + Vite 8 (`@cloudflare/vite-plugin`), Hono 4, zod 4,
  Wrangler 4. Tests: Vitest 4 + `@cloudflare/vitest-plugin`, Playwright, `node:test`.

| Path                                      | Purpose                                                     |
| ----------------------------------------- | ----------------------------------------------------------- |
| `src/worker/index.ts`                     | Routes, validation, error responses, security headers       |
| `src/worker/auth.ts`                      | Sessions, cookie, `requireAuth` / `requireAdmin` middleware |
| `src/worker/password.ts`                  | PBKDF2 hashing (shared with the seed script)                |
| `src/worker/vehicles.ts`                  | Dealership-scoped queries and the atomic update             |
| `src/client/`                             | React SPA: login, inventory, edit form, API client          |
| `migrations/`                             | D1 schema migrations                                        |
| `db/seed.sql`, `scripts/generate-seed.ts` | Repeatable seed data (also the reset script)                |
| `test/`                                   | API tests in the Workers runtime against local D1           |
| `e2e/`                                    | Playwright end-to-end tests                                 |
| `scripts/smoke.test.ts`                   | Smoke test for any deployment                               |
| `.github/workflows/ci.yml`                | Checks, end-to-end tests and gated deployment               |

### API

All errors use `{ "error": { "code", "message", "details?" } }`. API responses send
`Cache-Control: no-store` and secure headers.

| Method & path           | Auth          | Success                             | Rejections                                             |
| ----------------------- | ------------- | ----------------------------------- | ------------------------------------------------------ |
| `GET /api/health`       | none          | 200 `{status, db, version}`         | 503 if D1 is unreachable                               |
| `POST /api/auth/login`  | none          | 200 user + session cookie           | 400 `VALIDATION_ERROR`, 401 `INVALID_CREDENTIALS`      |
| `POST /api/auth/logout` | cookie        | 204, session deleted                | —                                                      |
| `GET /api/auth/me`      | session       | 200 user                            | 401 `UNAUTHENTICATED` / `SESSION_EXPIRED`              |
| `GET /api/vehicles`     | session       | 200 own dealership's vehicles       | 401                                                    |
| `GET /api/vehicles/:id` | session       | 200 vehicle with `version`          | 401, 404 (missing or other dealership)                 |
| `PUT /api/vehicles/:id` | admin session | 200 updated vehicle (`version + 1`) | 401, 403 `FORBIDDEN`, 400, 404, 409 `VERSION_CONFLICT` |

`PUT` takes `{ make, model, year, status, version }`. Checks run in this order: authentication
(401), role (403), body (400), then the atomic update, which yields 404 or 409.

### Authentication and authorization

- **Passwords:** PBKDF2-SHA256, 100,000 iterations (the Workers maximum), with a 16-byte random
  salt. Comparison is constant-time. An unknown email is checked against a dummy hash, so its
  response timing matches a wrong password.
- **Session:** login creates a 256-bit random token. It is sent as a
  `__Host-session` cookie: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`. Only its SHA-256
  is stored in `sessions`, with an absolute expiry (`SESSION_TTL_SECONDS`, default 8 hours).
- **Validation:** every protected request hashes the cookie and joins `sessions → users →
dealerships`. A missing or unknown token returns 401 `UNAUTHENTICATED`. An expired session is
  deleted and returns 401 `SESSION_EXPIRED`. That row is the only trusted source of user id, role
  and dealership.
- **Logout and invalidation:** logout deletes the session row and clears the cookie, so a copied
  token stops working immediately. Deleting a user's rows in `sessions` revokes them server-side.
  Compared with stateless JWTs this costs one indexed D1 read per request; in return, revocation
  is real.
- **Roles:** `requireAdmin` returns 403 for viewers before the body is even parsed.
- **Dealership scoping:** every vehicle query binds `dealership_id` from the session. Another
  dealership's vehicle returns the same 404 as a missing one, so ids cannot be probed. The update
  body uses zod `.strict()`, so a `dealershipId` field is rejected rather than ignored.
- **CSRF:** `SameSite=Strict`, Hono's Origin check for form-style requests, and JSON-only bodies.
- **Frontend:** any 401 from a protected call returns to the login screen and shows the
  server's reason (expired or no longer valid).

### Concurrency: preventing lost updates

Every vehicle has a `version`. The edit form remembers the version it loaded and sends it back.
The storage operation checks and writes in **one statement** (`src/worker/vehicles.ts`):

```sql
UPDATE vehicles
   SET make = ?, model = ?, year = ?, status = ?, version = version + 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_by = ?
 WHERE id = ? AND dealership_id = ? AND version = ?
RETURNING id, make, model, year, status, version, updated_at
```

SQLite evaluates the `WHERE` clause and applies the `SET` as one atomic write. D1 serializes
writes through a single primary. Two requests carrying version 1 therefore cannot both match:
whichever runs second sees version 2 and updates nothing. If no row comes back, a read-only
lookup decides between 404 (not in your dealership) and 409 `VERSION_CONFLICT`. Neither path
writes anything.

In the UI, a 409 shows a warning: someone else changed the vehicle, and the edit (shown) was not
saved. The form stays locked until the user clicks **Refresh**, which loads the latest values and
version. The user then reapplies the change.

**Reproduce the frontend conflict:** open the app in two browser sessions (for example a normal
window and a private window). Sign in as Alex in one and Blair in the other. Both click **Edit**
on the same vehicle (the heading shows the same version). Save in Alex's window, then save a
different change in Blair's window. Blair gets the conflict warning, **Save** is disabled, and
**Refresh** loads Alex's version. `e2e/conflict.spec.ts` automates exactly this.

### Regression test and defect demonstration

`test/concurrency.test.ts`: Alex and Blair both load vehicle 1 at version 1 and submit different
edits concurrently. The test asserts exactly one 200 and one 409, and that the stored row
contains only the winner's values at version 2.

The defective variant is commit [`a96a2ef`](https://github.com/clintgalendez/dealership-inventory/commit/a96a2ef).
It read the row, compared versions in application code, then ran an unconditional `UPDATE`.
Both requests can pass the check before either writes, so both get 200 and the second write
silently replaces the first.

Whether two requests overlap like that depends on scheduling. My first version of the test
**passed against the defect** because the requests happened to run one after the other. The test
now holds every `UPDATE vehicles` statement until both requests reach their write, then releases
them together. That is the widest possible race window. It is test-only interception inside the
Workers test runtime; storage is still the real local D1, so only a truly atomic check can produce
the 409.

| Commit                                                                            | What                                    | CI                                                                                                                                                |
| --------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`a96a2ef`](https://github.com/clintgalendez/dealership-inventory/commit/a96a2ef) | Read-check-write handler (defective)    | —                                                                                                                                                 |
| [`233fa77`](https://github.com/clintgalendez/dealership-inventory/commit/233fa77) | Regression test added                   | ❌ [failed](https://github.com/clintgalendez/dealership-inventory/actions/runs/38338135288): `expected [ 200, 200 ] to deeply equal [ 200, 409 ]` |
| [`2293399`](https://github.com/clintgalendez/dealership-inventory/commit/2293399) | Atomic conditional `UPDATE … RETURNING` | ✅ [passed](https://github.com/clintgalendez/dealership-inventory/actions/runs/38338255265)                                                       |

The defect was never deployed: pull requests never deploy, and the merge to `main` contained the fix.
To reproduce locally:

```bash
git switch --detach 233fa77 && npm ci && npx vitest run test/concurrency.test.ts   # fails: [200, 200]
git switch main && npm ci && npx vitest run test/concurrency.test.ts               # passes
```

## QA strategy

| Layer                | Tool                                 | Runs against                                                                                          | Covers                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API (45 tests)       | Vitest + `@cloudflare/vitest-plugin` | Worker in workerd, real local D1 built from `migrations/` + `db/seed.sql`, reseeded before every test | Valid and invalid login, malformed bodies, missing/forged/unprefixed/expired/logged-out sessions, CSRF, scoped lists, cross-dealership read and update (404), viewer edits (403), invalid bodies (400), admin updates, sequential stale edit (409), concurrent edits, health. **Every rejected write asserts the stored row is unchanged** by reading D1 directly. |
| End-to-end (5 tests) | Playwright (Chromium)                | Production build in the local Workers runtime (`vite preview`), freshly reset D1                      | Admin login → scoped inventory → update → survives reload → logout; invalid credentials; viewer read-only; session invalidated elsewhere; two-admin conflict → refresh → retry                                                                                                                                                                                     |
| Smoke (4 tests)      | `node:test` + `fetch`                | Any deployment (`BASE_URL`)                                                                           | Waits for a stable release with the expected commit; SPA served; invalid login; unauthenticated 401; scoped list; cross-dealership 404 with data unchanged; viewer 403 with data unchanged; allowed update; stale 409; two concurrent edits on the real D1 → exactly one 200; logout invalidation. Restores the vehicle it edits.                                  |

All tests call the API directly or drive the real UI; none mock the backend. Results, run links
and smoke output: [docs/verification.md](docs/verification.md).

## Local setup

Requirements: Node.js 24 (≥ 22.18; see `.nvmrc`) and npm. No Cloudflare account is needed locally.

```bash
npm ci                    # also generates Worker types (wrangler types)
npm run db:reset:local    # apply migrations + seed the local D1
npm run dev               # http://localhost:5173 (SPA + API with hot reload)
```

| Command                                                       | Purpose                                                                                             |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `npm run dev` / `npm run preview`                             | Dev server / production build in the local Workers runtime                                          |
| `npm run build`                                               | Typecheck and build the SPA and Worker into `dist/`                                                 |
| `npm run lint` · `npm run typecheck` · `npm run format:check` | Static checks (CI runs all three)                                                                   |
| `npm test`                                                    | API and regression tests                                                                            |
| `npm run test:e2e`                                            | Playwright tests (resets the local DB and builds first; run `npx playwright install chromium` once) |
| `BASE_URL=… EXPECTED_VERSION=<sha> npm run smoke`             | Smoke-test a deployment                                                                             |
| `npm run db:migrate:local` / `db:migrate:remote`              | Apply pending migrations                                                                            |
| `npm run db:seed:local` / `db:seed:remote`                    | Reset data to the seed (**deletes all rows first**)                                                 |
| `npm run db:reset:local` / `db:reset:remote`                  | Migrate, then seed                                                                                  |
| `npm run db:seed:generate`                                    | Regenerate `db/seed.sql` (only if seed data or password change)                                     |

### Configuration

| Name                           | Where                                                                   | Purpose                                                             |
| ------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `SESSION_TTL_SECONDS`          | `wrangler.jsonc` `vars` (override locally in `.env` or `.dev.vars`)     | Session lifetime, default `28800`. Set `60` locally to demo expiry. |
| `GIT_SHA`                      | `wrangler.jsonc` `vars` (`local`); set by `wrangler deploy --var` in CI | Release reported by `/api/health`                                   |
| `DB`                           | `wrangler.jsonc` `d1_databases`                                         | D1 binding (the database id is not a secret)                        |
| `CLOUDFLARE_API_TOKEN`         | GitHub Actions secret                                                   | Deploy and migrate (Workers Scripts: Edit, D1: Edit)                |
| `CLOUDFLARE_ACCOUNT_ID`        | GitHub Actions secret                                                   | Target account                                                      |
| `BASE_URL`, `EXPECTED_VERSION` | Shell, for `npm run smoke`                                              | Target of the smoke test                                            |

See [`.env.example`](.env.example). No secrets are committed. The seed contains only PBKDF2
hashes of the synthetic demo password.

## Deployment (Cloudflare + GitHub Actions)

### One-time setup

1. `npx wrangler login`, then `npx wrangler d1 create dealership-inventory`. Put the returned
   `database_id` in `wrangler.jsonc`.
2. `npm run db:reset:remote` creates the schema and seeds the six accounts and six vehicles.
3. Create a Cloudflare API token (the "Edit Cloudflare Workers" template plus **D1: Edit**).
   Store it as the repository secret `CLOUDFLARE_API_TOKEN`, and the account id as
   `CLOUDFLARE_ACCOUNT_ID`.
4. Make sure the account has a workers.dev subdomain (Workers & Pages in the dashboard).

### Pipeline (`.github/workflows/ci.yml`)

| Job      | Trigger                                    | Steps                                                                                                                         |
| -------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `check`  | every PR and push to `main`                | `npm ci` → format check → lint → typecheck → API tests → build                                                                |
| `e2e`    | every PR and push to `main`                | Playwright against the production build in the local Workers runtime; report uploaded on failure                              |
| `deploy` | push to `main` only, `needs: [check, e2e]` | build → `wrangler d1 migrations apply --remote` → `wrangler deploy --var GIT_SHA:<sha>` → smoke test against the deployed URL |

**How a failing check blocks deployment:** `deploy` declares `needs: [check, e2e]`, so it never
starts unless both succeed, and its `if` restricts it to pushes to `main`. Pull requests stop
after the checks: PR #2's failing regression run had no deploy. Branch protection on `main`
requires a pull request with `check` and `e2e` passing, enforced for admins too. Cloudflare
secrets reach only the migrate and deploy steps, not `npm ci`. A `deploy-production` concurrency
group prevents overlapping releases. Actions are pinned to commit SHAs, and the workflow token is
read-only.

### Database initialization and migrations

- Schema lives in `migrations/NNNN_name.sql`. Create a migration with
  `npx wrangler d1 migrations create DB <name>`.
- The same files are applied in tests (`readD1Migrations` / `applyD1Migrations`), locally
  (`db:migrate:local`), and in production by the pipeline _before_ the new code goes live.
- Because migrations run while the previous release is still serving, they must be backward
  compatible: expand first (add a column or table), switch code over, and drop old structures in a
  later release. D1 migrations only move forward.

### Health verification

```bash
curl https://dealership-inventory.galendez-clintjonathan.workers.dev/api/health
# {"status":"ok","db":"ok","version":"<commit sha>"}
```

`version` must equal the deployed commit. The pipeline's smoke test waits for five consecutive
healthy probes of the API and SPA reporting that commit before running its functional checks.
Workers Logs (observability) is enabled for runtime errors.

### Release recovery

1. **Roll back the Worker immediately.** List versions with `npx wrangler deployments list`
   (each pipeline deploy is labelled with its commit SHA). Then run
   `npx wrangler rollback <version-id> -m "reason"`, or use Dashboard → Workers →
   dealership-inventory → Deployments → Rollback. This switches traffic within seconds and
   requires no build.
2. **Verify:** `/api/health` should report the old SHA, and
   `BASE_URL=… EXPECTED_VERSION=<old sha> npm run smoke` should pass.
3. **Make `main` match production again:** `git revert -m 1 <bad merge commit>` in a pull
   request. Merging it redeploys through the same gated pipeline.
4. **Database limitations:** a Worker rollback does **not** roll back D1. The previous code must
   still work with the current schema; the expand/contract rule above guarantees it. If data or a
   migration itself is bad, D1 Time Travel can restore the whole database to a point in time
   (`npx wrangler d1 time-travel info DB`, then
   `npx wrangler d1 time-travel restore DB --timestamp=<ISO time>`; 7 days of history on the free
   plan, 30 on paid). This discards every write after that point, so take an export first:
   `npx wrangler d1 export DB --remote --output backup.sql`.

## Decisions and tradeoffs

- **Server-side sessions over JWTs:** real logout and revocation for one indexed read per request.
- **404 for other dealerships' vehicles:** no existence leak. The tradeoff is that a 404 doesn't
  say _why_.
- **`PUT` with every editable field plus `version`:** simple full-replacement semantics. A field
  the user didn't touch still conflicts if someone else changed it, which errs on the side of
  safety.
- **Version integers over timestamps or ETags:** explicit, testable, and immune to clock skew.
  `If-Match` / 412 would be the HTTP-native alternative. 409 fits because the request conflicts
  with the resource's current state and the client resolves it by refreshing.
- **Lock the form on conflict instead of merging:** the user must look at the latest data before
  retrying. No automatic merge can silently pick a winner.
- **Single Worker:** simplest hosting and recovery. The SPA and API always deploy together, so
  they cannot drift apart.

## Known limitations and gaps

- **Loom walkthrough:** not recorded yet (link placeholder above).
- **No login rate limiting or lockout.** This is the next improvement I would make (Workers Rate
  Limiting binding or a WAF rule).
- **Sessions have an absolute expiry only:** no idle timeout, and no "sign out everywhere" UI
  (rows can be deleted manually).
- **Deploy rebuilds from source** at the same commit and lockfile rather than promoting the exact
  artifact CI tested.
- **A failed post-deploy smoke test marks the run red but does not roll back automatically**
  (rollback is the manual steps above). This happened on the first deploy
  ([run 38340037069](https://github.com/clintgalendez/dealership-inventory/actions/runs/38340037069)):
  the release was live and correct, but a brand-new workers.dev hostname was still propagating.
  The readiness wait was then fixed in PR #4.
- **The smoke test edits production demo data.** It restores vehicle 3's values afterwards, but
  that vehicle's version number keeps increasing.
- **One shared synthetic password** for all demo accounts. Seed hashes are committed (synthetic
  only).
- **Static assets get Cloudflare's default headers:** no custom CSP for the SPA.
- **End-to-end tests run on Chromium only.**
- **Vitest is held at 4.1:** `@cloudflare/vitest-plugin` 1.4 fails to start any test under
  Vitest 5 on Windows.
- **Local runtime workaround:** API requests rejected before their body is read drain the body,
  because the local runtime otherwise broke the next keep-alive request (found by the smoke test,
  commit `f568307`).
