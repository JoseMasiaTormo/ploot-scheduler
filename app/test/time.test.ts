// Corrección de DST para Europe/Madrid (cambios de hora de 2026:
// 29 de marzo, 02:00 → 03:00; 25 de octubre, 03:00 → 02:00)
import { test } from "node:test";
import assert from "node:assert/strict";
import { localToUtc } from "../lib/time";

const TZ = "Europe/Madrid";

test("Las 09:00 de Madrid son 07:00 UTC en verano y 08:00 UTC en invierno", () => {
  assert.equal(localToUtc("2026-10-24T09:00", TZ).toISOString(), "2026-10-24T07:00:00.000Z"); // CEST, +2
  assert.equal(localToUtc("2026-10-26T09:00", TZ).toISOString(), "2026-10-26T08:00:00.000Z"); // CET, +1
  assert.equal(localToUtc("2026-03-28T09:00", TZ).toISOString(), "2026-03-28T08:00:00.000Z"); // CET, +1
  assert.equal(localToUtc("2026-03-30T09:00", TZ).toISOString(), "2026-03-30T07:00:00.000Z"); // CEST, +2
});

test("Programar 'a las 09:00' cada día no se desplaza al cambiar la hora", () => {
  // Entre el 24 y el 26 de octubre pasan 49 h reales (el día 25 dura 25 h)
  const before = localToUtc("2026-10-24T09:00", TZ).getTime();
  const after = localToUtc("2026-10-26T09:00", TZ).getTime();
  assert.equal((after - before) / 3_600_000, 49);
});

test("Una hora que no existe (salto de primavera) se rechaza", () => {
  assert.throws(() => localToUtc("2026-03-29T02:30", TZ), { code: "nonexistent_local_time" });
});

test("Una hora ambigua (otoño, ocurre dos veces) se resuelve a la primera ocurrencia", () => {
  assert.equal(localToUtc("2026-10-25T02:30", TZ).toISOString(), "2026-10-25T00:30:00.000Z"); // aún +2
});

test("Una zona horaria inventada se rechaza", () => {
  assert.throws(() => localToUtc("2026-10-24T09:00", "Europe/Castellon"), { code: "invalid_timezone" });
});
