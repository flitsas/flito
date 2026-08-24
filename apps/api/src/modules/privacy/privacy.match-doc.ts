import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/**
 * Match de documento para el derecho de supresión (Ley 1581) — Bug #11776.
 *
 * `normalizeDocument` en JS quita todo lo que no es dígito (`/\D/g`). El equivalente en SQL
 * NO puede escribirse `regexp_replace(col, '\D', '', 'g')` dentro de un tagged template
 * `sql\`...\``: en JavaScript `\D` es un escape desconocido, el array *cooked* del template
 * vale `'D'`, y Drizzle usa ese array. PostgreSQL recibe `regexp_replace(col, 'D', '', 'g')`.
 *
 * Consecuencia: solo coinciden documentos ya guardados como dígitos puros. `1.036.640.908`,
 * `CC1036640908` o espacios sobreviven al olvido mientras el endpoint responde `ok: true`.
 *
 * La clase explícita `'[^0-9]'` es un literal del template: no depende del cooked. Una sola
 * definición para SELECT de correos (HU #11708 → `purgarDestinatariosDeLotes`), UPDATE de las
 * ~16 tablas, JSONB de `tramites_digitales` y preview — si SELECT y UPDATE divergieran, uno
 * encontraría filas que el otro no anonimiza.
 */

/** Clase POSIX «no es dígito». Literal en el SQL, nunca interpolada como `'\D'`. */
export const REGEXP_NO_DIGITOS = '[^0-9]' as const;

/** `regexp_replace(col, '[^0-9]', '', 'g')` — paridad con `normalizeDocument`. */
export function sqlSoloDigitos(col: SQLWrapper): SQL {
  return sql`regexp_replace(${col}, '[^0-9]', '', 'g')`;
}

/**
 * Predicado de olvido: dígitos del documento = los buscados, y aún no anonimizado.
 * Drop-in de lo que `/forget` y `/preview` aplicaban en línea.
 */
export function matchDocumentoNormalizado(col: SQLWrapper, docNormalized: string): SQL {
  return sql`${sqlSoloDigitos(col)} = ${docNormalized} AND ${col} NOT LIKE 'ANON-%'`;
}

/**
 * El comprador de `tramites_digitales` vive en JSONB. SELECT de su correo (antes de
 * `purgarDestinatariosDeLotes`) y UPDATE del paso 5 tienen que usar ESTE mismo fragmento.
 */
export function matchDocumentoCompradorJsonb(docNormalized: string): SQL {
  return matchDocumentoNormalizado(sql`(comprador->>'documento')`, docNormalized);
}
