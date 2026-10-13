import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, isSessionEnded, type User, type Vehicle } from './api';
import VehicleEditForm from './VehicleEditForm';

type Props = { user: User; onLoggedOut: () => void };

export default function Inventory({ user, onLoggedOut }: Props) {
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const isAdmin = user.role === 'admin';

  const load = useCallback(
    () =>
      api.listVehicles().then(
        (data) => {
          setVehicles(data.vehicles);
          setError(null);
        },
        (err: unknown) => {
          if (!isSessionEnded(err)) setError(errorMessage(err));
        },
      ),
    [],
  );

  useEffect(() => {
    load();
  }, [load]);

  // Keeps the table in step with whatever version the edit form last loaded or saved.
  const replaceRow = useCallback(
    (vehicle: Vehicle) =>
      setVehicles((list) => list && list.map((v) => (v.id === vehicle.id ? vehicle : v))),
    [],
  );

  function retry() {
    setError(null);
    setVehicles(null);
    load();
  }

  function startEdit(id: number) {
    setSaved(null);
    setEditingId(id);
  }

  function handleSaved(vehicle: Vehicle) {
    replaceRow(vehicle);
    setEditingId(null);
    setSaved(
      `Saved ${vehicle.year} ${vehicle.make} ${vehicle.model} (now version v${vehicle.version}).`,
    );
  }

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await api.logout();
      onLoggedOut();
    } catch (err) {
      setError(`Could not sign out: ${errorMessage(err)}`);
      setLoggingOut(false);
    }
  }

  return (
    <>
      <header className="topbar">
        <div>
          <strong>{user.dealershipName}</strong> <span className="muted">inventory</span>
        </div>
        <div className="who">
          <span>{user.name}</span>
          <span className={`badge role-${user.role}`}>{isAdmin ? 'Administrator' : 'Viewer'}</span>
          <button type="button" className="secondary" onClick={handleLogout} disabled={loggingOut}>
            {loggingOut ? 'Signing out…' : 'Log out'}
          </button>
        </div>
      </header>

      <main className="content">
        {error && (
          <div className="error" role="alert">
            <span>{error}</span>
            {vehicles === null && (
              <button type="button" className="secondary" onClick={retry}>
                Retry
              </button>
            )}
          </div>
        )}

        {saved && (
          <p className="success" role="status">
            {saved}
          </p>
        )}

        {!isAdmin && <p className="muted">You have read-only access.</p>}

        {editingId !== null && (
          <VehicleEditForm
            key={editingId}
            vehicleId={editingId}
            onLoaded={replaceRow}
            onSaved={handleSaved}
            onClose={() => setEditingId(null)}
          />
        )}

        {vehicles === null && !error && <p aria-busy="true">Loading vehicles…</p>}

        {vehicles && (
          <div className="table-wrap">
            <table aria-label="Vehicles">
              <thead>
                <tr>
                  <th>Year</th>
                  <th>Make</th>
                  <th>Model</th>
                  <th>Status</th>
                  <th>Version</th>
                  <th>Last updated</th>
                  {isAdmin && <th aria-label="Actions" />}
                </tr>
              </thead>
              <tbody>
                {vehicles.map((v) => (
                  <tr key={v.id}>
                    <td>{v.year}</td>
                    <td>{v.make}</td>
                    <td>{v.model}</td>
                    <td>
                      <span className={`badge status-${v.status}`}>{v.status}</span>
                    </td>
                    <td>v{v.version}</td>
                    <td>{new Date(v.updatedAt).toLocaleString()}</td>
                    {isAdmin && (
                      <td>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => startEdit(v.id)}
                          aria-label={`Edit ${v.year} ${v.make} ${v.model}`}
                        >
                          Edit
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {vehicles?.length === 0 && <p>No vehicles in this dealership yet.</p>}
      </main>
    </>
  );
}
