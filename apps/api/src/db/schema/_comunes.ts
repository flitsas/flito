/**
 * Hojas del esquema: lo que otro archivo de `schema/` evalúa AL CARGAR (no dentro de un callback perezoso).
 *
 * `.references(() => users.id)` admite el ciclo con `../schema.js` porque se resuelve tarde, pero
 * `miEnum('col')` y `bytea('col')` se ejecutan al definir la tabla: si vinieran de un módulo del ciclo, el
 * orden de entrada daría un `ReferenceError` (TDZ) con `tsc` en verde. Por eso este archivo NO importa nada
 * de `../schema.js` ni de otro archivo de `schema/`. Va aquí lo que usan dos o más archivos, y nada más.
 * `bytea` es interno: `schema.ts` no lo re-exporta.
 */
import { customType, pgEnum } from 'drizzle-orm/pg-core';

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() { return 'bytea'; },
});

// Modalidad del organismo: requiere_gestion | autogestionado (default). 'sin_clasificar' se deprecó.
export const flitoModalidadEnum = pgEnum('flito_modalidad_organismo', ['requiere_gestion', 'autogestionado']);
