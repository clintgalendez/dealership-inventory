import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';
import {
  type AppEnv,
  createSession,
  destroySession,
  requireAuth,
  toSessionUser,
  USER_COLUMNS,
  type UserRow,
} from './auth';
import { ApiError, parseBody } from './errors';
import { verifyPassword } from './password';
import { getVehicle, listVehicles } from './vehicles';

// Verified when the email is unknown so both failure paths cost the same PBKDF2 work
// and response timing does not reveal which emails exist.
const DUMMY_HASH = 'pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

const loginSchema = z.object({
  email: z.string().trim().max(254),
  password: z.string().min(1).max(200),
});

// Same response for "does not exist" and "belongs to another dealership" so ids cannot be probed.
const vehicleNotFound = () => new ApiError(404, 'NOT_FOUND', 'Vehicle not found.');

const app = new Hono<AppEnv>();

app.use('/api/*', secureHeaders(), csrf(), async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

app.get('/api/health', (c) => c.json({ status: 'ok' }));

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

app.notFound((c) =>
  c.json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } }, 404),
);

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
