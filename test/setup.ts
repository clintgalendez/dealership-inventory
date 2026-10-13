import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach } from 'vitest';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Every test starts from the documented seed state (the seed clears tables first).
beforeEach(async () => {
  await env.DB.exec(env.TEST_SEED);
});
