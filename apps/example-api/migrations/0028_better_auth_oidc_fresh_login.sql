-- Password authentication evidence is opt-in with the OIDC provider.
CREATE TABLE oidc_session_authentication (
  session_id TEXT PRIMARY KEY NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method = 'password'),
  authenticated_at INTEGER NOT NULL CHECK (typeof(authenticated_at) = 'integer' AND authenticated_at > 0)
);
