import { describe, expect, it } from 'vitest';
import { api, errorCode, login, USERS } from './helpers';

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
