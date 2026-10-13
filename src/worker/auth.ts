import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { ApiError } from './errors';

export type Role = 'admin' | 'viewer';

/** The only identity the API trusts: loaded from the session row, never from request input. */
export type SessionUser = {
  id: number;
  email: string;
  name: string;
  role: Role;
  dealershipId: number;
  dealershipName: string;
};

export type AppEnv = { Bindings: Env; Variables: { user: SessionUser } };

export type UserRow = {
  id: number;
  email: string;
  name: string;
  role: Role;
  dealership_id: number;
  dealership_name: string;
};

export const USER_COLUMNS =
  'u.id, u.email, u.name, u.role, u.dealership_id, d.name AS dealership_name';

export const toSessionUser = (row: UserRow): SessionUser => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: row.role,
  dealershipId: row.dealership_id,
  dealershipName: row.dealership_name,
});

// Sent as "__Host-session": Secure, Path=/, no Domain, so it cannot be set or read by other hosts.
const COOKIE_NAME = 'session';
const DEFAULT_TTL_SECONDS = 8 * 60 * 60;

const encoder = new TextEncoder();
const toHex = (buffer: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');

// Only the SHA-256 of the token is stored, so a database leak does not expose live sessions.
const hashToken = async (token: string) =>
  toHex(await crypto.subtle.digest('SHA-256', encoder.encode(token)));

const ttlSeconds = (env: Env) => Number(env.SESSION_TTL_SECONDS) || DEFAULT_TTL_SECONDS;

export async function createSession(c: Context<AppEnv>, userId: number) {
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  const ttl = ttlSeconds(c.env);
  await c.env.DB.batch([
    // Housekeeping: drop this user's expired sessions while we are writing anyway.
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?').bind(
      userId,
      now,
    ),
    c.env.DB.prepare(
      'INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    ).bind(await hashToken(token), userId, now, now + ttl * 1000),
  ]);
  setCookie(c, COOKIE_NAME, token, {
    prefix: 'host',
    httpOnly: true,
    sameSite: 'Strict',
    maxAge: ttl,
  });
}

/** Logout: delete the server-side session so the token is useless even if the cookie survives. */
export async function destroySession(c: Context<AppEnv>) {
  const token = getCookie(c, COOKIE_NAME, 'host');
  if (token) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?')
      .bind(await hashToken(token))
      .run();
  }
  deleteCookie(c, COOKIE_NAME, { prefix: 'host', httpOnly: true, sameSite: 'Strict' });
}

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = getCookie(c, COOKIE_NAME, 'host');
  if (!token) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');

  const id = await hashToken(token);
  const row = await c.env.DB.prepare(
    `SELECT s.expires_at, ${USER_COLUMNS}
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN dealerships d ON d.id = u.dealership_id
      WHERE s.id = ?`,
  )
    .bind(id)
    .first<UserRow & { expires_at: number }>();

  if (!row) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'Your session is no longer valid. Sign in again.');
  }
  if (row.expires_at <= Date.now()) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
    throw new ApiError(401, 'SESSION_EXPIRED', 'Your session has expired. Sign in again.');
  }

  c.set('user', toSessionUser(row));
  await next();
});

/** Must run after requireAuth: the role comes from the session, not the request. */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.var.user.role !== 'admin') {
    throw new ApiError(403, 'FORBIDDEN', 'Only administrators can edit vehicles.');
  }
  await next();
});
