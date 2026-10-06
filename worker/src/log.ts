// Logs estructurados en JSON: se pueden filtrar por profile_id, tenant_id o event
export function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
}
