import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';
import {
  type AppEnv,
  createSession,
  destroySession,
  requireAdmin,
  requireAuth,
  toSessionUser,
  USER_COLUMNS,
  type UserRow,
} from './auth';
import { ApiError, parseBody } from './errors';
import { verifyPassword } from './password';
import { getVehicle, listVehicles, updateVehicle, VEHICLE_STATUSES } from './vehicles';

// Verified when the email is unknown so both failure paths cost the same PBKDF2 work
// and response timing does not reveal which emails exist.
const DUMMY_HASH =
  'pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

const loginSchema = z.object({
  email: z.string().trim().max(254),
  password: z.string().min(1).max(200),
});

// .strict() rejects anything else (e.g. dealershipId or id) instead of silently ignoring it.
const vehicleUpdateSchema = z
  .object({
    make: z.string().trim().min(1).max(50),
    model: z.string().trim().min(1).max(50),
    year: z.number().int().min(1900).max(2100),
    status: z.enum(VEHICLE_STATUSES),
    version: z.number().int().positive(),
  })
  .strict();

// Same response for "does not exist" and "belongs to another dealership" so ids cannot be probed.
const vehicleNotFound = () => new ApiError(404, 'NOT_FOUND', 'Vehicle not found.');

const app = new Hono<AppEnv>();

app.use('/api/*', secureHeaders(), csrf(), async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
  // Requests rejected before their body is parsed (401/403) must still release it; otherwise
  // the local runtime breaks the next request on the same keep-alive connection.
  if (c.req.raw.body && !c.req.raw.bodyUsed) await c.req.raw.arrayBuffer();
});

// Public and unauthenticated: reports only database reachability and the deployed commit.
app.get('/api/health', async (c) => {
  let db = 'ok';
  try {
    await c.env.DB.prepare('SELECT 1').first();
  } catch (err) {
    console.error('Health check: database unavailable', err);
    db = 'unavailable';
  }
  const healthy = db === 'ok';
  return c.json(
    { status: healthy ? 'ok' : 'degraded', db, version: c.env.GIT_SHA },
    healthy ? 200 : 503,
  );
});

app.post('/api/auth/login', async (c) => {
  const { email, password } = await parseBody(c, loginSchema);
  const row = await c.env.DB.prepare(
    `SELECT ${USER_COLUMNS}, u.password_hash
       FROM users u JOIN dealerships d ON d.id = u.dealership_id
      WHERE u.email = ?`,
  )
    .bind(email)
    .first<UserRow & { password_hash: string }>();

  const valid = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !valid) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
  }

  await createSession(c, row.id);
  return c.json({ user: toSessionUser(row) });
});

app.post('/api/auth/logout', async (c) => {
  await destroySession(c);
  return c.body(null, 204);
});

app.get('/api/auth/me', requireAuth, (c) => c.json({ user: c.var.user }));

app.get('/api/vehicles', requireAuth, async (c) =>
  c.json({ vehicles: await listVehicles(c.env.DB, c.var.user.dealershipId) }),
);

// Non-numeric ids never match the route and fall through to the JSON 404.
app.get('/api/vehicles/:id{[0-9]+}', requireAuth, async (c) => {
  const vehicle = await getVehicle(c.env.DB, c.var.user.dealershipId, Number(c.req.param('id')));
  if (!vehicle) throw vehicleNotFound();
  return c.json({ vehicle });
});

// PUT: the client always sends every editable field plus the version it loaded.
// Order of checks: 401 (requireAuth) -> 403 (requireAdmin) -> 400 (body) -> 404 / 409.
app.put('/api/vehicles/:id{[0-9]+}', requireAuth, requireAdmin, async (c) => {
  const input = await parseBody(c, vehicleUpdateSchema);
  const result = await updateVehicle(c.env.DB, c.var.user, Number(c.req.param('id')), input);
  if (result === 'not_found') throw vehicleNotFound();
  if (result === 'conflict') {
    throw new ApiError(
      409,
      'VERSION_CONFLICT',
      'This vehicle was changed by someone else after you loaded it. Refresh to load the latest version, then reapply your changes.',
    );
  }
  return c.json({ vehicle: result });
});

app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } }, 404));

app.onError((err, c) => {
  if (err instanceof ApiError) {
    const { code, message, details } = err;
    return c.json({ error: { code, message, ...(details ? { details } : {}) } }, err.status);
  }
  if (err instanceof HTTPException) {
    // e.g. the CSRF middleware rejecting a cross-origin form post
    const message = err.message || 'The request was rejected.';
    return c.json({ error: { code: 'FORBIDDEN', message } }, err.status);
  }
  console.error('Unhandled API error', err);
  return c.json(
    { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' } },
    500,
  );
});

export default app;
