import { describe, expect, it } from 'vitest';
import { api } from './helpers';

describe('GET /api/health', () => {
  it('reports database reachability and the release version without authentication', async () => {
    const res = await api('/api/health');

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    // Exactly these keys: nothing else (such as configuration or secrets) is exposed.
    expect(await res.json()).toEqual({ status: 'ok', db: 'ok', version: 'local' });
  });
});
