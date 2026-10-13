import { describe, expect, it } from 'vitest';
import { api, errorCode, login, storedVehicle, USERS } from './helpers';

const ids = async (res: Response) =>
  (await res.json<{ vehicles: { id: number }[] }>()).vehicles.map((v) => v.id);

describe('GET /api/vehicles', () => {
  it.each([
    ['Northside admin', USERS.alex, [1, 2, 3]],
    ['Northside viewer', USERS.casey, [1, 2, 3]],
    ['Lakeside admin', USERS.dana, [4, 5, 6]],
    ['Lakeside viewer', USERS.finley, [4, 5, 6]],
  ])('returns only the %s dealership inventory', async (_, email, expected) => {
    const res = await api('/api/vehicles', { cookie: await login(email) });

    expect(res.status).toBe(200);
    expect(await ids(res)).toEqual(expected);
  });

  it('ignores client-supplied dealership filters', async () => {
    const cookie = await login(USERS.alex);
    const res = await api('/api/vehicles?dealershipId=2&dealership_id=2', { cookie });

    expect(await ids(res)).toEqual([1, 2, 3]);
  });
});

describe('GET /api/vehicles/:id', () => {
  it('returns a vehicle from the caller dealership with its version', async () => {
    const res = await api('/api/vehicles/2', { cookie: await login(USERS.casey) });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      vehicle: { id: 2, make: 'Honda', model: 'Civic', year: 2021, status: 'reserved', version: 1 },
    });
  });

  it.each([
    ['Northside admin reading a Lakeside vehicle', USERS.alex, 4],
    ['Lakeside viewer reading a Northside vehicle', USERS.finley, 1],
    ['an id that does not exist', USERS.alex, 999],
  ])('returns 404 for %s', async (_, email, id) => {
    const res = await api(`/api/vehicles/${id}`, { cookie: await login(email) });

    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('NOT_FOUND');
  });
});

describe('PUT /api/vehicles/:id', () => {
  const edit = {
    make: 'Toyota',
    model: 'Camry Hybrid',
    year: 2023,
    status: 'reserved',
    version: 1,
  };

  it('lets an admin update a vehicle in their dealership and persists it', async () => {
    const cookie = await login(USERS.alex);

    const res = await api('/api/vehicles/1', { method: 'PUT', cookie, body: edit });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ vehicle: { id: 1, ...edit, version: 2 } });
    expect(await storedVehicle(1)).toMatchObject({
      make: 'Toyota',
      model: 'Camry Hybrid',
      year: 2023,
      status: 'reserved',
      version: 2,
      updated_by: 1,
    });
    // A fresh read (as after a page reload) returns the saved values.
    const reread = await api('/api/vehicles/1', { cookie });
    expect(await reread.json()).toMatchObject({ vehicle: { ...edit, version: 2 } });
  });

  it('trims text fields before saving', async () => {
    const cookie = await login(USERS.dana);
    const body = { ...edit, make: '  Subaru ', model: ' Forester  ' };

    const res = await api('/api/vehicles/4', { method: 'PUT', cookie, body });

    expect(res.status).toBe(200);
    expect(await storedVehicle(4)).toMatchObject({ make: 'Subaru', model: 'Forester' });
  });

  describe('rejected writes leave the stored row unchanged', () => {
    it.each([
      ['a Northside viewer', USERS.casey, 1, 403, 'FORBIDDEN'],
      ['a Lakeside viewer', USERS.finley, 4, 403, 'FORBIDDEN'],
      ['a viewer targeting another dealership', USERS.finley, 1, 403, 'FORBIDDEN'],
      ['a Northside admin targeting a Lakeside vehicle', USERS.alex, 4, 404, 'NOT_FOUND'],
      ['a Lakeside admin targeting a Northside vehicle', USERS.eli, 1, 404, 'NOT_FOUND'],
    ])('%s gets %i', async (_, email, id, status, code) => {
      const before = await storedVehicle(id);
      const cookie = await login(email);

      const res = await api(`/api/vehicles/${id}`, { method: 'PUT', cookie, body: edit });

      expect(res.status).toBe(status);
      expect(await errorCode(res)).toBe(code);
      expect(await storedVehicle(id)).toEqual(before);
    });

    it.each([
      ['no session cookie', undefined],
      ['a forged session cookie', `__Host-session=${'f'.repeat(64)}`],
    ])('a request with %s gets 401', async (_, cookie) => {
      const before = await storedVehicle(1);

      const res = await api('/api/vehicles/1', { method: 'PUT', cookie, body: edit });

      expect(res.status).toBe(401);
      expect(await errorCode(res)).toBe('UNAUTHENTICATED');
      expect(await storedVehicle(1)).toEqual(before);
    });

    it('a logged-out session gets 401', async () => {
      const before = await storedVehicle(1);
      const cookie = await login(USERS.alex);
      await api('/api/auth/logout', { method: 'POST', cookie });

      const res = await api('/api/vehicles/1', { method: 'PUT', cookie, body: edit });

      expect(res.status).toBe(401);
      expect(await storedVehicle(1)).toEqual(before);
    });

    it.each([
      ['an empty make', { ...edit, make: '   ' }],
      ['a year out of range', { ...edit, year: 1800 }],
      ['a non-integer year', { ...edit, year: 2020.5 }],
      ['an unknown status', { ...edit, status: 'stolen' }],
      ['a missing version', { make: 'Toyota', model: 'Camry', year: 2022, status: 'sold' }],
      ['a version sent as a string', { ...edit, version: '1' }],
      ['an attempt to move the vehicle to another dealership', { ...edit, dealershipId: 2 }],
    ])('a body with %s gets 400', async (_, body) => {
      const before = await storedVehicle(1);
      const cookie = await login(USERS.alex);

      const res = await api('/api/vehicles/1', { method: 'PUT', cookie, body });

      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe('VALIDATION_ERROR');
      expect(await storedVehicle(1)).toEqual(before);
    });

    it('a stale version gets 409 and the newer update is kept', async () => {
      const [alex, blair] = [await login(USERS.alex), await login(USERS.blair)];
      const first = await api('/api/vehicles/1', { method: 'PUT', cookie: alex, body: edit });
      expect(first.status).toBe(200);
      const afterFirst = await storedVehicle(1);

      // Blair still holds version 1 from before Alex saved.
      const stale = { ...edit, model: 'Corolla', status: 'sold' };
      const res = await api('/api/vehicles/1', { method: 'PUT', cookie: blair, body: stale });

      expect(res.status).toBe(409);
      expect(await errorCode(res)).toBe('VERSION_CONFLICT');
      expect(await storedVehicle(1)).toEqual(afterFirst);
      expect(afterFirst).toMatchObject({ model: 'Camry Hybrid', version: 2, updated_by: 1 });
    });
  });
});
