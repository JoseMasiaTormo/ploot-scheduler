CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE post_status AS ENUM ('draft','scheduled','publishing','published','failed','cancelled');

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  display_name text NOT NULL,
  timezone text NOT NULL DEFAULT 'Europe/Madrid',
  blocked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);
CREATE INDEX profiles_tenant_idx ON profiles (tenant_id);

CREATE TABLE oauth_tokens (
  profile_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  access_token_enc bytea NOT NULL,
  refresh_token_enc bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 3000),
  status post_status NOT NULL DEFAULT 'draft',
  scheduled_at timestamptz,
  next_attempt_at timestamptz,
  attempts int NOT NULL DEFAULT 0,
  locked_by text,
  locked_at timestamptz,
  external_id text,
  last_error_code text,
  last_error_message text,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (profile_id, tenant_id) REFERENCES profiles (id, tenant_id),
  CHECK (status NOT IN ('scheduled','publishing') OR scheduled_at IS NOT NULL)
);

-- Query caliente del worker: índice parcial, solo contiene lo pendiente
CREATE INDEX posts_due_idx ON posts (scheduled_at) WHERE status = 'scheduled';
-- 1 publicación en vuelo por Embajador + reaper de bloqueos caídos
CREATE INDEX posts_publishing_idx ON posts (profile_id, locked_at) WHERE status = 'publishing';
-- Listado paginado de la API (keyset)
CREATE INDEX posts_tenant_list_idx ON posts (tenant_id, created_at DESC, id DESC);
CREATE INDEX posts_tenant_status_idx ON posts (tenant_id, status, created_at DESC, id DESC);

CREATE TABLE idempotency_keys (
  tenant_id uuid NOT NULL,
  key text NOT NULL,
  post_id uuid NOT NULL REFERENCES posts(id),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE post_events (
  id bigserial PRIMARY KEY,
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  from_status post_status,
  to_status post_status NOT NULL,
  error_code text,
  detail text,
  worker_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX post_events_profile_idx ON post_events (profile_id, created_at DESC);

-- Aislamiento de tenant a nivel SQL (Row Level Security)
-- Sin app.tenant_id fijado, no se ve ninguna fila (falla cerrado)
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON posts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON profiles
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON oauth_tokens
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON idempotency_keys
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON post_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- "¿Por qué va atrasado el Embajador X?" sin leer código
CREATE VIEW profile_lag WITH (security_invoker = true) AS
SELECT
  pr.id AS profile_id,
  pr.tenant_id,
  pr.display_name,
  pr.blocked_until,
  t.status AS token_status,
  t.expires_at AS token_expires_at,
  (SELECT count(*) FROM posts p
     WHERE p.profile_id = pr.id AND p.status = 'scheduled' AND p.scheduled_at <= now()) AS overdue_posts,
  (SELECT min(p.scheduled_at) FROM posts p
     WHERE p.profile_id = pr.id AND p.status = 'scheduled' AND p.scheduled_at <= now()) AS oldest_overdue_at,
  (SELECT count(*) FROM posts p
     WHERE p.profile_id = pr.id AND p.status = 'publishing') AS in_flight,
  (SELECT e.error_code FROM post_events e
     WHERE e.profile_id = pr.id AND e.error_code IS NOT NULL
     ORDER BY e.created_at DESC LIMIT 1) AS last_error_code
FROM profiles pr
LEFT JOIN oauth_tokens t ON t.profile_id = pr.id;