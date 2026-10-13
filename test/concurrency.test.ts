import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, errorCode, login, storedVehicle, USERS } from './helpers';

// Regression test for lost updates.
//
// Two admins of the same dealership load vehicle 1 at the same version and submit different
// edits concurrently. A handler that reads the version, compares it in application code and
// then writes unconditionally lets both requests pass the check before either one writes, so
// both get 200 and the last write silently overwrites the first.
//
// Whether two requests overlap that way depends on scheduling, so the test makes the overlap
// deterministic: every `UPDATE vehicles` statement is held until both requests have reached
// their write, then released together. That is the widest possible race window. Storage is
// still the real local D1, so only a version check performed atomically inside the UPDATE
// itself can turn the second write into a 409.

/** Holds `UPDATE vehicles ...` executions until `parties` of them are waiting. */
function holdVehicleWritesUntil(parties: number) {
  let arrived = 0;
  // Each request waits on its own timers: resolving one request's promise from another
  // request is not allowed in Workers ("Cannot perform I/O on behalf of a different request").
  const arrive = async () => {
    arrived++;
    // Bounded (~2s) so a request that never reaches its write cannot hang the test.
    for (let i = 0; arrived < parties && i < 2000; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  };

  const gate = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop === 'bind') return (...args: unknown[]) => gate(target.bind(...args));
        if (prop === 'run' || prop === 'first' || prop === 'all' || prop === 'raw') {
          return async (...args: unknown[]) => {
            await arrive();
            return value.apply(target, args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

  const prepare = env.DB.prepare.bind(env.DB);
  vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) =>
    /^\s*UPDATE\s+vehicles\b/i.test(sql) ? gate(prepare(sql)) : prepare(sql),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

const edits = {
  alex: { make: 'Toyota', model: 'Camry Hybrid', year: 2023, status: 'reserved' },
  blair: { make: 'Lexus', model: 'ES 300h', year: 2024, status: 'sold' },
};
const userIds = { alex: 1, blair: 2 };

describe('concurrent edits from the same starting version', () => {
  it('accepts exactly one edit and rejects the other with 409 without overwriting it', async () => {
    const cookies = { alex: await login(USERS.alex), blair: await login(USERS.blair) };
    const before = await storedVehicle(1);

    // Both admins load the vehicle and see the same version.
    for (const cookie of Object.values(cookies)) {
      const res = await api('/api/vehicles/1', { cookie });
      expect(await res.json()).toMatchObject({ vehicle: { version: 1 } });
    }

    // Both submit different changes from version 1 at the same time.
    holdVehicleWritesUntil(2);
    const results = await Promise.all(
      (['alex', 'blair'] as const).map(async (who) => ({
        who,
        res: await api('/api/vehicles/1', {
          method: 'PUT',
          cookie: cookies[who],
          body: { ...edits[who], version: 1 },
        }),
      })),
    );

    // Exactly one success and one conflict.
    expect(results.map((r) => r.res.status).sort()).toEqual([200, 409]);
    const winner = results.find((r) => r.res.status === 200)!.who;
    const loser = results.find((r) => r.res.status === 409)!;
    expect(await errorCode(loser.res)).toBe('VERSION_CONFLICT');

    // The stored row holds only the successful edit, exactly one version higher.
    expect(await storedVehicle(1)).toEqual({
      ...before,
      ...edits[winner],
      version: 2,
      updated_by: userIds[winner],
      updated_at: expect.any(String),
    });
  });
});
