// Every query takes dealershipId from the authenticated session and filters on it,
// so a vehicle from another dealership is indistinguishable from a missing one.

export const VEHICLE_STATUSES = ['available', 'reserved', 'sold'] as const;
export type VehicleStatus = (typeof VEHICLE_STATUSES)[number];

type VehicleRow = {
  id: number;
  make: string;
  model: string;
  year: number;
  status: VehicleStatus;
  version: number;
  updated_at: string;
};

const COLUMNS = 'id, make, model, year, status, version, updated_at';

const toVehicle = (row: VehicleRow) => ({
  id: row.id,
  make: row.make,
  model: row.model,
  year: row.year,
  status: row.status,
  version: row.version,
  updatedAt: row.updated_at,
});

export type Vehicle = ReturnType<typeof toVehicle>;

export async function listVehicles(db: D1Database, dealershipId: number): Promise<Vehicle[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM vehicles WHERE dealership_id = ? ORDER BY id`)
    .bind(dealershipId)
    .all<VehicleRow>();
  return results.map(toVehicle);
}

export type VehicleUpdate = {
  make: string;
  model: string;
  year: number;
  status: VehicleStatus;
  /** The version the client loaded; the update only applies if it is still current. */
  version: number;
};

export type UpdateResult = Vehicle | 'not_found' | 'conflict';

export async function updateVehicle(
  db: D1Database,
  user: { id: number; dealershipId: number },
  id: number,
  input: VehicleUpdate,
): Promise<UpdateResult> {
  const current = await getVehicle(db, user.dealershipId, id);
  if (!current) return 'not_found';
  if (current.version !== input.version) return 'conflict';

  await db
    .prepare(
      `UPDATE vehicles
          SET make = ?, model = ?, year = ?, status = ?, version = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_by = ?
        WHERE id = ? AND dealership_id = ?`,
    )
    .bind(
      input.make,
      input.model,
      input.year,
      input.status,
      input.version + 1,
      user.id,
      id,
      user.dealershipId,
    )
    .run();

  return (await getVehicle(db, user.dealershipId, id))!;
}

export async function getVehicle(
  db: D1Database,
  dealershipId: number,
  id: number,
): Promise<Vehicle | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM vehicles WHERE id = ? AND dealership_id = ?`)
    .bind(id, dealershipId)
    .first<VehicleRow>();
  return row ? toVehicle(row) : null;
}
