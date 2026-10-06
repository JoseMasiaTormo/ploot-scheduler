import { DateTime, IANAZone } from "luxon";
import { ApiError } from "./errors";

const WALL = "yyyy-MM-dd'T'HH:mm:ss";
const MAX_AHEAD_DAYS = 90;

// "Publícalo el 25/10 a las 09:00 hora de Madrid" → instante UTC correcto,
// teniendo en cuenta si ese día es horario de verano (+2) o de invierno (+1).
export function localToUtc(local: string, timezone: string): Date {
  if (!IANAZone.isValidZone(timezone)) {
    throw new ApiError(400, "invalid_timezone", `Zona horaria no válida: ${timezone}`);
  }
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(local)) {
    throw new ApiError(
      400,
      "invalid_local_time",
      "scheduled_local no lleva offset; usa scheduled_at para instantes absolutos",
    );
  }

  const inZone = DateTime.fromISO(local, { zone: timezone });
  const wall = DateTime.fromISO(local, { zone: "UTC" });
  if (!inZone.isValid || !wall.isValid) {
    throw new ApiError(400, "invalid_local_time", `Fecha local no válida: ${local}`);
  }

  // Hora inexistente (salto de primavera, p. ej. 29/03 02:30 en Madrid):
  // Luxon la desplaza en silencio. Preferimos rechazarla y que el usuario elija.
  if (inZone.toFormat(WALL) !== wall.toFormat(WALL)) {
    throw new ApiError(400, "nonexistent_local_time", `${local} no existe en ${timezone} (cambio de hora)`);
  }

  // Hora ambigua (otoño, 02:30 ocurre dos veces): Luxon elige la primera
  // ocurrencia (horario de verano). Asunción documentada en el PDF.
  return inZone.toUTC().toJSDate();
}

export function parseInstant(iso: string): Date {
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(iso)) {
    throw new ApiError(400, "invalid_scheduled_at", "scheduled_at debe llevar zona (Z o +02:00)");
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new ApiError(400, "invalid_scheduled_at", `Fecha no válida: ${iso}`);
  return date;
}

export function assertSchedulable(date: Date, now = new Date()) {
  if (date.getTime() < now.getTime() - 60_000) {
    throw new ApiError(400, "scheduled_in_past", "La fecha programada ya ha pasado");
  }
  if (date.getTime() > now.getTime() + MAX_AHEAD_DAYS * 86_400_000) {
    throw new ApiError(400, "scheduled_too_far", `Máximo ${MAX_AHEAD_DAYS} días de antelación`);
  }
}
