-- Initial schema. Every vehicle and user belongs to exactly one dealership;
-- all application queries are scoped by dealership_id from the session.

CREATE TABLE dealerships (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  dealership_id INTEGER NOT NULL REFERENCES dealerships (id),
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
  password_hash TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
  -- SHA-256 of the session token; the raw token only exists in the client cookie.
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, -- epoch ms
  expires_at INTEGER NOT NULL  -- epoch ms
) STRICT;

CREATE INDEX sessions_user_id ON sessions (user_id);

CREATE TABLE vehicles (
  id            INTEGER PRIMARY KEY,
  dealership_id INTEGER NOT NULL REFERENCES dealerships (id),
  make          TEXT NOT NULL,
  model         TEXT NOT NULL,
  year          INTEGER NOT NULL CHECK (year BETWEEN 1900 AND 2100),
  status        TEXT NOT NULL CHECK (status IN ('available', 'reserved', 'sold')),
  -- Optimistic concurrency token, incremented by every successful update.
  version       INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by    INTEGER REFERENCES users (id)
) STRICT;

CREATE INDEX vehicles_dealership_id ON vehicles (dealership_id);
