import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, errorMessage, type User, type Vehicle } from './api';

type Props = { user: User; onLoggedOut: () => void };

export default function Inventory({ user, onLoggedOut }: Props) {
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  const load = useCallback(
    () =>
      api.listVehicles().then(
        (data) => {
          setVehicles(data.vehicles);
          setError(null);
        },
        (err: unknown) => {
          // 401s are handled globally by returning to the login screen.
          if (!(err instanceof ApiError && err.status === 401)) setError(errorMessage(err));
        },
      ),
    [],
  );

  useEffect(() => {
    load();
  }, [load]);

  function retry() {
    setError(null);
    setVehicles(null);
    load();
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
          <span className={`badge role-${user.role}`}>
            {user.role === 'admin' ? 'Administrator' : 'Viewer'}
          </span>
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

        {user.role === 'viewer' && <p className="muted">You have read-only access.</p>}

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
