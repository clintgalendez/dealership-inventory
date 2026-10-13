// Writes db/seed.sql with predictable synthetic data: two dealerships, six users
// (two admins + one viewer each) and three vehicles per dealership.
// The SQL deletes existing rows first, so applying it is also the reset command.
// Run: npm run db:seed:generate  (only needed if this data or the password changes)
import { writeFileSync } from 'node:fs';
import { hashPassword } from '../src/worker/password.ts';

// Synthetic password shared by every demo account; documented in the README.
const DEMO_PASSWORD = 'Inventory-Demo-2026';

const dealerships = [
  { id: 1, name: 'Northside Motors' },
  { id: 2, name: 'Lakeside Auto' },
];

const users = [
  { id: 1, dealershipId: 1, email: 'alex.admin@northside.example', name: 'Alex Admin', role: 'admin' },
  { id: 2, dealershipId: 1, email: 'blair.admin@northside.example', name: 'Blair Admin', role: 'admin' },
  { id: 3, dealershipId: 1, email: 'casey.viewer@northside.example', name: 'Casey Viewer', role: 'viewer' },
  { id: 4, dealershipId: 2, email: 'dana.admin@lakeside.example', name: 'Dana Admin', role: 'admin' },
  { id: 5, dealershipId: 2, email: 'eli.admin@lakeside.example', name: 'Eli Admin', role: 'admin' },
  { id: 6, dealershipId: 2, email: 'finley.viewer@lakeside.example', name: 'Finley Viewer', role: 'viewer' },
];

const vehicles = [
  { id: 1, dealershipId: 1, make: 'Toyota', model: 'Camry', year: 2022, status: 'available' },
  { id: 2, dealershipId: 1, make: 'Honda', model: 'Civic', year: 2021, status: 'reserved' },
  { id: 3, dealershipId: 1, make: 'Ford', model: 'F-150', year: 2023, status: 'available' },
  { id: 4, dealershipId: 2, make: 'Subaru', model: 'Outback', year: 2020, status: 'available' },
  { id: 5, dealershipId: 2, make: 'Mazda', model: 'CX-5', year: 2022, status: 'sold' },
  { id: 6, dealershipId: 2, make: 'Tesla', model: 'Model 3', year: 2023, status: 'available' },
];

const sql = (value: string | number) =>
  typeof value === 'number' ? String(value) : `'${value.replaceAll("'", "''")}'`;
const row = (...values: (string | number)[]) => `(${values.map(sql).join(', ')})`;

// One statement per line so the file also works with D1's exec() in tests.
const lines = [
  'DELETE FROM sessions;',
  'DELETE FROM vehicles;',
  'DELETE FROM users;',
  'DELETE FROM dealerships;',
  `INSERT INTO dealerships (id, name) VALUES ${dealerships.map((d) => row(d.id, d.name)).join(', ')};`,
];

for (const u of users) {
  const hash = await hashPassword(DEMO_PASSWORD);
  lines.push(
    `INSERT INTO users (id, dealership_id, email, name, role, password_hash) VALUES ${row(u.id, u.dealershipId, u.email, u.name, u.role, hash)};`,
  );
}

lines.push(
  `INSERT INTO vehicles (id, dealership_id, make, model, year, status, version, updated_at) VALUES ${vehicles
    .map((v) => row(v.id, v.dealershipId, v.make, v.model, v.year, v.status, 1, '2026-01-01T00:00:00.000Z'))
    .join(', ')};`,
);

writeFileSync(new URL('../db/seed.sql', import.meta.url), lines.join('\n') + '\n');
console.log(`Wrote db/seed.sql (${users.length} users, ${vehicles.length} vehicles)`);
