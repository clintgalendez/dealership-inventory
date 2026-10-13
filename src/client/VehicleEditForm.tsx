import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  errorMessage,
  isSessionEnded,
  type Vehicle,
  VEHICLE_STATUSES,
  type VehicleStatus,
} from './api';

type Props = {
  vehicleId: number;
  /** Must be stable (useCallback): it is a dependency of the load effect. */
  onLoaded: (vehicle: Vehicle) => void;
  onSaved: (vehicle: Vehicle) => void;
  onClose: () => void;
};

type Draft = { make: string; model: string; year: string; status: VehicleStatus };

const toDraft = (v: Vehicle): Draft => ({
  make: v.make,
  model: v.model,
  year: String(v.year),
  status: v.status,
});

export default function VehicleEditForm({ vehicleId, onLoaded, onSaved, onClose }: Props) {
  // `base` is the version this edit started from; it is sent back with the save.
  const [base, setBase] = useState<Vehicle | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api
        .getVehicle(vehicleId)
        .then(
          ({ vehicle }) => {
            setBase(vehicle);
            setDraft(toDraft(vehicle));
            setConflict(null);
            setError(null);
            onLoaded(vehicle);
          },
          (err: unknown) => {
            if (!isSessionEnded(err)) setError(errorMessage(err));
          },
        )
        .finally(() => setLoading(false)),
    [vehicleId, onLoaded],
  );

  useEffect(() => {
    load();
  }, [load]);

  function refresh() {
    setLoading(true);
    load();
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!base || !draft) return;
    const input = { ...draft, year: Number(draft.year), version: base.version };
    setSaving(true);
    setError(null);
    try {
      const { vehicle } = await api.updateVehicle(vehicleId, input);
      onSaved(vehicle);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setConflict(`${input.year} ${input.make} ${input.model}, ${input.status}`);
      } else if (!isSessionEnded(err)) {
        setError(errorMessage(err));
      }
      setSaving(false);
    }
  }

  const set = (field: keyof Draft) => (e: { target: { value: string } }) =>
    setDraft((d) => d && { ...d, [field]: e.target.value });
  // After a conflict the form stays locked until the user reloads the latest version.
  const locked = loading || saving || conflict !== null;

  return (
    <section className="card editor" aria-labelledby="edit-heading">
      <h2 id="edit-heading">
        Edit vehicle {base && <span className="muted">(editing version v{base.version})</span>}
      </h2>

      {loading && <p aria-busy="true">Loading the latest version…</p>}

      {conflict && (
        <div className="warning" role="alert">
          <div>
            <strong>Someone else changed this vehicle after you opened it.</strong> Your changes (
            {conflict}) were not saved. Refresh to load the latest version, then make your changes
            again.
          </div>
          <button type="button" onClick={refresh} disabled={loading}>
            Refresh
          </button>
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {draft ? (
        <form onSubmit={handleSubmit}>
          <fieldset disabled={locked}>
            <label>
              Make
              <input required maxLength={50} value={draft.make} onChange={set('make')} />
            </label>
            <label>
              Model
              <input required maxLength={50} value={draft.model} onChange={set('model')} />
            </label>
            <label>
              Year
              <input
                type="number"
                required
                min={1900}
                max={2100}
                step={1}
                value={draft.year}
                onChange={set('year')}
              />
            </label>
            <label>
              Status
              <select value={draft.status} onChange={set('status')}>
                {VEHICLE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>
          <div className="actions">
            <button type="submit" disabled={locked}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        !loading && (
          <button type="button" className="secondary" onClick={onClose}>
            Close
          </button>
        )
      )}
    </section>
  );
}
