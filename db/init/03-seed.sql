\getenv enc_key TOKEN_ENC_KEY

INSERT INTO tenants (id, name) VALUES
  ('11111111-1111-4111-8111-111111111111', 'Acme'),
  ('22222222-2222-4222-8222-222222222222', 'Globex');

INSERT INTO profiles (id, tenant_id, display_name) VALUES
  ('a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'Ana (token válido)'),
  ('a2222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'Bruno (token caducado, refrescable)'),
  ('a3333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 'Carla (token revocado)'),
  ('b1111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'Diego (Globex, token válido)');

INSERT INTO oauth_tokens (profile_id, tenant_id, access_token_enc, refresh_token_enc, expires_at) VALUES
  ('a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111',
    pgp_sym_encrypt('tok_ok_ana', :'enc_key'), pgp_sym_encrypt('ref_ok_ana', :'enc_key'), now() + interval '1 hour'),
  ('a2222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111',
    pgp_sym_encrypt('tok_exp_bruno', :'enc_key'), pgp_sym_encrypt('ref_ok_bruno', :'enc_key'), now() - interval '1 hour'),
  ('a3333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111',
    pgp_sym_encrypt('tok_rev_carla', :'enc_key'), pgp_sym_encrypt('ref_rev_carla', :'enc_key'), now() - interval '1 hour'),
  ('b1111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
    pgp_sym_encrypt('tok_ok_diego', :'enc_key'), pgp_sym_encrypt('ref_ok_diego', :'enc_key'), now() + interval '1 hour');

INSERT INTO posts (tenant_id, profile_id, content, status, scheduled_at) VALUES
  -- Vencidos: el worker los coge al arrancar
  ('11111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111', 'Ana post 1', 'scheduled', now() - interval '3 minutes'),
  ('11111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111', 'Ana post 2', 'scheduled', now() - interval '2 minutes'),
  ('11111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111', 'Ana post 3', 'scheduled', now() - interval '1 minute'),
  ('11111111-1111-4111-8111-111111111111', 'a2222222-2222-4222-8222-222222222222', 'Bruno: necesita refresh', 'scheduled', now()),
  ('11111111-1111-4111-8111-111111111111', 'a3333333-3333-4333-8333-333333333333', 'Carla: token revocado', 'scheduled', now()),
  ('22222222-2222-4222-8222-222222222222', 'b1111111-1111-4111-8111-111111111111', 'Diego post 1', 'scheduled', now()),
  ('22222222-2222-4222-8222-222222222222', 'b1111111-1111-4111-8111-111111111111', 'Diego post 2', 'scheduled', now()),
  -- Futuros y otros estados
  ('11111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111', 'Ana: dentro de 2 minutos', 'scheduled', now() + interval '2 minutes'),
  ('22222222-2222-4222-8222-222222222222', 'b1111111-1111-4111-8111-111111111111', 'Diego: mañana', 'scheduled', now() + interval '1 day'),
  ('11111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111', 'Ana: borrador', 'draft', NULL);

INSERT INTO posts (tenant_id, profile_id, content, status, scheduled_at, external_id, published_at) VALUES
  ('11111111-1111-4111-8111-111111111111', 'a1111111-1111-4111-8111-111111111111', 'Ana: ya publicado', 'published',
    now() - interval '1 day', 'ext_seed_1', now() - interval '1 day');

INSERT INTO posts (tenant_id, profile_id, content, status, scheduled_at, attempts, last_error_code, last_error_message) VALUES
  ('22222222-2222-4222-8222-222222222222', 'b1111111-1111-4111-8111-111111111111', 'Diego: fallido', 'failed',
    now() - interval '1 hour', 5, 'provider_unavailable', '503 tras 5 intentos');