import { env, exports } from 'cloudflare:workers';
import { expect } from 'vitest';

export const PASSWORD = 'Inventory-Demo-2026';

export const USERS = {
  // Northside Motors (dealership 1, vehicles 1-3)
  alex: 'alex.admin@northside.example',
  blair: 'blair.admin@northside.example',
  casey: 'casey.viewer@northside.example',
  // Lakeside Auto (dealership 2, vehicles 4-6)
  dana: 'dana.admin@lakeside.example',
  eli: 'eli.admin@lakeside.example',
  finley: 'finley.viewer@lakeside.example',
} as const;

const ORIGIN = 'https://inventory.test';

type ApiOptions = {
  method?: string;
  cookie?: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
};

/** Calls the Worker directly, bypassing any frontend checks. Sends Origin like a browser would. */
export function api(path: string, { method = 'GET', cookie, body, rawBody, ...opts }: ApiOptions = {}) {
  const headers = new Headers({ Origin: ORIGIN });
  if (cookie) headers.set('Cookie', cookie);
  if (body !== undefined || rawBody !== undefined) headers.set('Content-Type', 'application/json');
  for (const [name, value] of Object.entries(opts.headers ?? {})) headers.set(name, value);
  return exports.default.fetch(
    new Request(ORIGIN + path, {
      method,
      headers,
      body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    }),
  );
}

/** Logs in and returns the "name=value" cookie pair to send on later requests. */
export async function login(email: string): Promise<string> {
  const res = await api('/api/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  expect(res.status).toBe(200);
  return res.headers.get('Set-Cookie')!.split(';')[0]!;
}

export async function errorCode(res: Response) {
  const body = await res.json<{ error: { code: string } }>();
  return body.error.code;
}

export const sessionCount = async (userId: number) =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?')
    .bind(userId)
    .first<number>('n'))!;
