// Smoke test for a running deployment. Uses only the seeded synthetic accounts.
//   BASE_URL=https://<worker>.<subdomain>.workers.dev [EXPECTED_VERSION=<git sha>] npm run smoke
// It edits vehicle 3 (Northside) and restores its original values at the end.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const BASE_URL = process.env.BASE_URL?.replace(/\/+$/, '');
const EXPECTED_VERSION = process.env.EXPECTED_VERSION;
const PASSWORD = 'Inventory-Demo-2026';
const NORTHSIDE_VEHICLE = 3;
const LAKESIDE_VEHICLE = 4;

if (!BASE_URL) throw new Error('Set BASE_URL to the deployment URL.');

type Vehicle = {
  id: number;
  make: string;
  model: string;
  year: number;
  status: string;
  version: number;
};

async function call(path: string, init: { method?: string; cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { Origin: BASE_URL! };
  if (init.cookie) headers.Cookie = init.cookie;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE_URL + path, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  const contentType = res.headers.get('Content-Type') ?? '';
  return {
    status: res.status,
    headers: res.headers,
    body: contentType.includes('json') && text ? JSON.parse(text) : text,
  };
}

async function login(email: string) {
  const res = await call('/api/auth/login', {
    method: 'POST',
    body: { email, password: PASSWORD },
  });
  assert.equal(res.status, 200, `login ${email}`);
  return res.headers.getSetCookie()[0]!.split(';')[0]!;
}

const editable = ({ make, model, year, status, version }: Vehicle) => ({
  make,
  model,
  year,
  status,
  version,
});

async function readVehicle(cookie: string, id: number): Promise<Vehicle> {
  const res = await call(`/api/vehicles/${id}`, { cookie });
  assert.equal(res.status, 200);
  return res.body.vehicle;
}

test('health endpoint is up and serving the expected release', async () => {
  // A new release can take a few seconds to reach every location.
  for (let attempt = 1; ; attempt++) {
    const res = await call('/api/health');
    const ready =
      res.status === 200 && (!EXPECTED_VERSION || res.body.version === EXPECTED_VERSION);
    if (ready || attempt === 20) {
      assert.equal(res.status, 200);
      assert.deepEqual(Object.keys(res.body).sort(), ['db', 'status', 'version']);
      assert.equal(res.body.status, 'ok');
      assert.equal(res.body.db, 'ok');
      if (EXPECTED_VERSION) assert.equal(res.body.version, EXPECTED_VERSION);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
});

test('frontend is served', async () => {
  const res = await call('/');
  assert.equal(res.status, 200);
  assert.match(res.body, /<div id="root">/);
});

test('invalid credentials and missing sessions are rejected', async () => {
  const bad = await call('/api/auth/login', {
    method: 'POST',
    body: { email: 'alex.admin@northside.example', password: 'wrong-password' },
  });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error.code, 'INVALID_CREDENTIALS');

  const anonymous = await call('/api/vehicles');
  assert.equal(anonymous.status, 401);
});

test('access boundaries, allowed update, stale edit conflict and logout', async () => {
  const alex = await login('alex.admin@northside.example');
  const blair = await login('blair.admin@northside.example');
  const casey = await login('casey.viewer@northside.example');
  const dana = await login('dana.admin@lakeside.example');

  // Dealership-scoped list and cross-dealership rejection.
  const list = await call('/api/vehicles', { cookie: alex });
  assert.equal(list.status, 200);
  const ids = list.body.vehicles.map((v: Vehicle) => v.id);
  assert.ok(ids.includes(NORTHSIDE_VEHICLE));
  assert.ok(!ids.includes(LAKESIDE_VEHICLE));

  const lakesideBefore = await readVehicle(dana, LAKESIDE_VEHICLE);
  assert.equal((await call(`/api/vehicles/${LAKESIDE_VEHICLE}`, { cookie: alex })).status, 404);
  const crossWrite = await call(`/api/vehicles/${LAKESIDE_VEHICLE}`, {
    method: 'PUT',
    cookie: alex,
    body: editable({ ...lakesideBefore, model: 'Hijacked' }),
  });
  assert.equal(crossWrite.status, 404);
  assert.deepEqual(await readVehicle(dana, LAKESIDE_VEHICLE), lakesideBefore);

  // Viewer edit rejection.
  const original = await readVehicle(alex, NORTHSIDE_VEHICLE);
  const viewerWrite = await call(`/api/vehicles/${NORTHSIDE_VEHICLE}`, {
    method: 'PUT',
    cookie: casey,
    body: editable({ ...original, model: 'Viewer edit' }),
  });
  assert.equal(viewerWrite.status, 403);
  assert.deepEqual(await readVehicle(alex, NORTHSIDE_VEHICLE), original);

  // Allowed update by an admin.
  const changed = { ...original, model: `${original.model} (smoke)` };
  const update = await call(`/api/vehicles/${NORTHSIDE_VEHICLE}`, {
    method: 'PUT',
    cookie: alex,
    body: editable(changed),
  });
  assert.equal(update.status, 200);
  assert.equal(update.body.vehicle.version, original.version + 1);

  // Stale edit from the version both admins started with.
  const stale = await call(`/api/vehicles/${NORTHSIDE_VEHICLE}`, {
    method: 'PUT',
    cookie: blair,
    body: editable({ ...original, status: 'sold' }),
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
  assert.deepEqual(await readVehicle(alex, NORTHSIDE_VEHICLE), update.body.vehicle);

  // Two concurrent edits from the same version: exactly one wins.
  const current = update.body.vehicle as Vehicle;
  const race = await Promise.all(
    [alex, blair].map((cookie, i) =>
      call(`/api/vehicles/${NORTHSIDE_VEHICLE}`, {
        method: 'PUT',
        cookie,
        body: editable({ ...current, model: `${original.model} (race ${i})` }),
      }),
    ),
  );
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
  const winner = race.find((r) => r.status === 200)!.body.vehicle as Vehicle;
  assert.deepEqual(await readVehicle(alex, NORTHSIDE_VEHICLE), winner);

  // Restore the original values so repeated runs leave the demo data tidy.
  const restore = await call(`/api/vehicles/${NORTHSIDE_VEHICLE}`, {
    method: 'PUT',
    cookie: alex,
    body: editable({ ...original, version: winner.version }),
  });
  assert.equal(restore.status, 200);

  // Logout invalidates the session server-side.
  for (const cookie of [alex, blair, casey, dana]) {
    assert.equal((await call('/api/auth/logout', { method: 'POST', cookie })).status, 204);
  }
  assert.equal((await call('/api/vehicles', { cookie: alex })).status, 401);
});
