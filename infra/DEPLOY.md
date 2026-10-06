# Despliegue

| Pieza          | Host    | Región                       | Config                                   |
| -------------- | ------- | ---------------------------- | ---------------------------------------- |
| Postgres       | Neon    | AWS eu-central-1 (Frankfurt) | Esquema y seed con `db/init/*.sql`       |
| App Next.js    | Vercel  | fra1                         | Root directory `app/`, `app/vercel.json` |
| Worker         | Railway | EU West                      | Root directory `worker/`, Dockerfile     |
| Mock proveedor | Railway | EU West                      | Root directory `mock/`, Dockerfile       |

## Variables de entorno (en el host, nunca en el repo)

- **Vercel (app):** `DATABASE_URL` (rol `app_user` vía **pooler** de Neon), `JWT_SECRET`
- **Railway (worker):** `DATABASE_URL` (rol dueño, conexión **directa**), `PROVIDER_URL`, `TOKEN_ENC_KEY`
- **Railway (mock):** `MOCK_429_RATE`, `MOCK_5XX_RATE` (opcionales)

La app usa el pooler porque cada instancia serverless abre conexiones.
El worker usa conexión directa porque es un proceso de larga vida con un pool pequeño y estable.
