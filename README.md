# Ploot · Scheduler de publicación

Slice del scheduler que publica en nombre de los Embajadores contra un proveedor externo (simulado con un mock): **Next.js** (Route Handlers + UI mínima) + **worker separado** + **PostgreSQL**.

- **App desplegada:** https://ploot-scheduler-beta.vercel.app/
- **Mock del proveedor:** https://ploot-scheduler-production.up.railway.app
- **Tokens JWT de prueba:** en el PDF de respuestas (no se versionan)

## Levantarlo en local (< 10 min)

Requisitos: Docker y Node 22.

```bash
git clone https://github.com/JoseMasiaTormo/ploot-scheduler.git
cd ploot-scheduler
docker compose up --build
```

Levanta Postgres (esquema + roles + seed), el mock, **2 réplicas del worker** y la app en http://localhost:3000. Postgres queda expuesto en `localhost:55432`.

> Con las imágenes ya construidas arranca en menos de 60 s; el primer build compila Next.js y tarda más.

Tokens para la UI (pégalos en el campo "JWT del Embajador"):

```bash
cd app && npm install && npm run tokens
```

- **Ana (tenant Acme):** ve los posts de Acme.
- **Diego (tenant Globex):** no ve nada de Acme (aislamiento por RLS).

## Tests

Con `docker compose up -d db mock` en marcha y el worker parado (`docker compose stop worker`):

```bash
cd worker && npm install && npm test   # N réplicas sin doble publicación, 1 en vuelo por Embajador, crash a mitad, backoff
cd app && npm install && npm test      # aislamiento cross-tenant a nivel SQL, DST Europe/Madrid
```

## Estructura

| Carpeta    | Qué hay                                                                                             |
| ---------- | --------------------------------------------------------------------------------------------------- |
| `app/`     | Next.js: Route Handlers `/api/v1/...`, UI mínima, auth JWT, capa de queries con RLS                 |
| `worker/`  | Worker de larga vida: reparto con `FOR UPDATE SKIP LOCKED`, rate limits, tokens, reintentos, reaper |
| `mock/`    | Mock del proveedor (`/provider/publish`, `/provider/oauth/refresh`)                                 |
| `db/init/` | Esquema, roles y seed (se cargan solos en el contenedor de Postgres)                                |
| `infra/`   | Configuración y pasos del despliegue público                                                        |
| `.github/` | Pipeline de CI                                                                                      |

## API

| Método   | Ruta                                   | Qué hace                                                              |
| -------- | -------------------------------------- | --------------------------------------------------------------------- |
| `POST`   | `/api/v1/posts`                        | Crear (`draft` o `scheduled`, con `scheduled_at` o `scheduled_local`) |
| `PATCH`  | `/api/v1/posts/:id`                    | Editar; 409 si está publicado o publicándose                          |
| `DELETE` | `/api/v1/posts/:id`                    | Cancelar; 409 si está publicado o publicándose                        |
| `POST`   | `/api/v1/posts/:id/publish`            | Publicar ya (202), con cabecera `Idempotency-Key` obligatoria         |
| `GET`    | `/api/v1/posts?status=&limit=&cursor=` | Listado con paginación por cursor                                     |
| `GET`    | `/api/v1/ops/lag`                      | ¿Por qué va atrasado cada Embajador?                                  |

Todas requieren `Authorization: Bearer <JWT>` con `tenant_id` y `profile_id`.

## Despliegue

Vercel (`fra1`) para la app, Neon (Frankfurt) para Postgres y Railway (EU) para el worker y el mock. Detalle en [`infra/DEPLOY.md`](infra/DEPLOY.md). Todos los secretos están en las variables de entorno de cada host; en el repo solo hay valores `dev-only`.

Decisiones, trade-offs y lo que queda pendiente: ver el PDF de respuestas.
