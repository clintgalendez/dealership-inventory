import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { api, errorCode, login, PASSWORD, sessionCount, USERS } from './helpers';

describe('POST /api/auth/login', () => {
  it('returns the user and sets a hardened session cookie for valid credentials', async () => {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: { email: USERS.alex, password: PASSWORD },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: {
        id: 1,
        email: USERS.alex,
        name: 'Alex Admin',
        role: 'admin',
        dealershipId: 1,
        dealershipName: 'Northside Motors',
      },
    });
    const cookie = res.headers.get('Set-Cookie')!;
    expect(cookie).toMatch(/^__Host-session=[0-9a-f]{64};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(await sessionCount(1)).toBe(1);
  });

  it.each([
    ['wrong password', { email: USERS.alex, password: 'not-the-password' }],
    ['unknown email', { email: 'nobody@northside.example', password: PASSWORD }],
  ])('rejects %s with the same 401 and no session', async (_, body) => {
    const res = await api('/api/auth/login', { method: 'POST', body });

    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('INVALID_CREDENTIALS');
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(await sessionCount(1)).toBe(0);
  });

  it.each([
    ['malformed JSON', { rawBody: '{not json' }],
    ['missing password', { body: { email: USERS.alex } }],
    ['empty password', { body: { email: USERS.alex, password: '' } }],
  ])('rejects %s with 400', async (_, options) => {
    const res = await api('/api/auth/login', { method: 'POST', ...options });

    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('VALIDATION_ERROR');
  });
});

describe('session validation', () => {
  it.each(['/api/auth/me', '/api/vehicles', '/api/vehicles/1'])(
    'rejects %s without a session cookie',
    async (path) => {
      const res = await api(path);

      expect(res.status).toBe(401);
      expect(await errorCode(res)).toBe('UNAUTHENTICATED');
    },
  );

  it('rejects an unknown or forged session token', async () => {
    const res = await api('/api/vehicles', { cookie: `__Host-session=${'a'.repeat(64)}` });

    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('UNAUTHENTICATED');
  });

  it('ignores a session token sent without the __Host- prefix', async () => {
    const cookie = await login(USERS.alex);
    const res = await api('/api/auth/me', { cookie: cookie.replace('__Host-', '') });

    expect(res.status).toBe(401);
  });

  it('rejects an expired session with SESSION_EXPIRED and deletes it', async () => {
    const cookie = await login(USERS.alex);
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = 1')
      .bind(Date.now() - 1)
      .run();

    const res = await api('/api/vehicles', { cookie });

    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('SESSION_EXPIRED');
    expect(await sessionCount(1)).toBe(0);
  });

  it('returns the current user for a valid session', async () => {
    const cookie = await login(USERS.casey);
    const res = await api('/api/auth/me', { cookie });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user: { role: 'viewer', dealershipId: 1 } });
  });
});

describe('POST /api/auth/logout', () => {
  it('deletes the session server-side so the old cookie stops working', async () => {
    const cookie = await login(USERS.alex);

    const res = await api('/api/auth/logout', { method: 'POST', cookie });

    expect(res.status).toBe(204);
    expect(res.headers.get('Set-Cookie')).toMatch(/^__Host-session=;.*Max-Age=0/);
    expect(await sessionCount(1)).toBe(0);

    const reuse = await api('/api/vehicles', { cookie });
    expect(reuse.status).toBe(401);
    expect(await errorCode(reuse)).toBe('UNAUTHENTICATED');
  });

  it('only ends the session it was called with', async () => {
    const first = await login(USERS.alex);
    const second = await login(USERS.alex);

    await api('/api/auth/logout', { method: 'POST', cookie: first });

    expect((await api('/api/auth/me', { cookie: first })).status).toBe(401);
    expect((await api('/api/auth/me', { cookie: second })).status).toBe(200);
  });

  it('rejects cross-origin form posts (CSRF)', async () => {
    const cookie = await login(USERS.alex);
    const res = await api('/api/auth/logout', {
      method: 'POST',
      cookie,
      rawBody: 'x=1',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    expect(res.status).toBe(403);
    expect(await sessionCount(1)).toBe(1);
  });
});
