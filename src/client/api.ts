export type Role = 'admin' | 'viewer';
export type VehicleStatus = 'available' | 'reserved' | 'sold';

export type User = {
  id: number;
  email: string;
  name: string;
  role: Role;
  dealershipId: number;
  dealershipName: string;
};

export type Vehicle = {
  id: number;
  make: string;
  model: string;
  year: number;
  status: VehicleStatus;
  version: number;
  updatedAt: string;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let onSessionEnded: (error: ApiError) => void = () => {};

/** Called whenever a protected request returns 401 (expired, revoked or missing session). */
export function setSessionEndedHandler(handler: (error: ApiError) => void) {
  onSessionEnded = handler;
}

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      'Could not reach the server. Check your connection and try again.',
    );
  }

  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (res.ok) return data as T;

  const error = new ApiError(
    res.status,
    data?.error?.code ?? 'HTTP_ERROR',
    data?.error?.message ?? `The server returned an unexpected error (${res.status}). Try again.`,
  );
  // Auth endpoints handle their own 401s (bad credentials, or simply not signed in yet).
  if (res.status === 401 && !path.startsWith('/api/auth/')) onSessionEnded(error);
  throw error;
}

export const errorMessage = (error: unknown) =>
  error instanceof ApiError ? error.message : 'Something went wrong. Try again.';

export const api = {
  me: () => request<{ user: User }>('/api/auth/me'),
  login: (email: string, password: string) =>
    request<{ user: User }>('/api/auth/login', 'POST', { email, password }),
  logout: () => request<void>('/api/auth/logout', 'POST'),
  listVehicles: () => request<{ vehicles: Vehicle[] }>('/api/vehicles'),
};
