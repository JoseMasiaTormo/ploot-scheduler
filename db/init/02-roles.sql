\getenv app_pw APP_DB_PASSWORD

-- La app (Next.js) entra con un rol SIN privilegios: RLS se le aplica.
-- El worker entra con el rol dueño de las tablas: es multi-tenant por naturaleza.
CREATE ROLE app_user LOGIN PASSWORD :'app_pw';

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT ON profiles TO app_user;
GRANT SELECT, INSERT, UPDATE ON posts TO app_user;
GRANT SELECT, INSERT ON idempotency_keys TO app_user;
GRANT SELECT, INSERT ON post_events TO app_user;
GRANT USAGE ON SEQUENCE post_events_id_seq TO app_user;
-- Nunca las columnas cifradas del token: solo metadatos
GRANT SELECT (profile_id, tenant_id, status, expires_at) ON oauth_tokens TO app_user;
GRANT SELECT ON profile_lag TO app_user;