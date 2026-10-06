import { ApiError } from "./errors";
import { assertSchedulable, localToUtc, parseInstant } from "./time";

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "invalid_json", "El body debe ser un objeto JSON");
  }
}

export function readContent(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError(400, "invalid_content", "content es obligatorio");
  }
  if (value.length > 3000) throw new ApiError(400, "invalid_content", "content: máximo 3000 caracteres");
  return value.trim();
}

export function readStatus(value: unknown): "draft" | "scheduled" {
  if (value !== "draft" && value !== "scheduled") {
    throw new ApiError(400, "invalid_status", "status debe ser draft o scheduled");
  }
  return value;
}

// Acepta un instante absoluto (scheduled_at con zona) o una hora local del
// Embajador (scheduled_local + su timezone). Devuelve undefined si no viene.
export function readSchedule(body: Record<string, unknown>, profileTimezone: string): Date | undefined {
  if (body.scheduled_at !== undefined && body.scheduled_local !== undefined) {
    throw new ApiError(400, "invalid_schedule", "Usa scheduled_at o scheduled_local, no los dos");
  }
  let date: Date | undefined;
  if (typeof body.scheduled_at === "string") date = parseInstant(body.scheduled_at);
  else if (typeof body.scheduled_local === "string") {
    const tz = typeof body.timezone === "string" ? body.timezone : profileTimezone;
    date = localToUtc(body.scheduled_local, tz);
  } else if (body.scheduled_at !== undefined || body.scheduled_local !== undefined) {
    throw new ApiError(400, "invalid_schedule", "Fecha no válida");
  }
  if (date) assertSchedulable(date);
  return date;
}
