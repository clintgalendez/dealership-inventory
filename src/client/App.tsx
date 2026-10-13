import { useEffect, useState } from 'react';
import { api, ApiError, setSessionEndedHandler, type User } from './api';
import Inventory from './Inventory';
import LoginForm from './LoginForm';

type Session =
  | { status: 'loading' }
  | { status: 'signedOut'; notice?: string }
  | { status: 'signedIn'; user: User };

export default function App() {
  const [session, setSession] = useState<Session>({ status: 'loading' });

  useEffect(() => {
    // Any 401 from a protected call (expired or revoked session) sends the user back to login.
    setSessionEndedHandler((error) => setSession({ status: 'signedOut', notice: error.message }));
    api
      .me()
      .then(({ user }) => setSession({ status: 'signedIn', user }))
      .catch((error: unknown) =>
        setSession({
          status: 'signedOut',
          notice: error instanceof ApiError && error.status !== 401 ? error.message : undefined,
        }),
      );
  }, []);

  if (session.status === 'loading') {
    return (
      <main className="centered" aria-busy="true">
        <p>Loading…</p>
      </main>
    );
  }

  if (session.status === 'signedOut') {
    return (
      <LoginForm
        notice={session.notice}
        onLoggedIn={(user) => setSession({ status: 'signedIn', user })}
      />
    );
  }

  return (
    <Inventory
      user={session.user}
      onLoggedOut={() => setSession({ status: 'signedOut', notice: 'You have signed out.' })}
    />
  );
}
