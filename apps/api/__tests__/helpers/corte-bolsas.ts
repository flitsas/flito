// HU #13965 — el corte del descuento por comprobante vive en `flito_bolsas_corte` (una fila, migración 0260),
// no en una variable de entorno. Las pruebas contra PostgreSQL real lo fijan o lo borran con este helper y
// DEVUELVEN la fila original al terminar: la BD de pruebas suele ser la demo local, cuyo corte es el
// instante en que se aplicó la 0260 allí.
//
// Uso: `const corte = corteDePrueba(sql)`; en `beforeEach` `await corte.fijar('2026-12-01')` (o un `Date`);
// `await corte.quitar()` para el caso sin fila; en `afterAll` `await corte.restaurar()`.

import type { Sql } from 'postgres';

/** 'AAAA-MM-DD' = medianoche de Colombia (UTC−5, sin horario de verano) de ese día; un `Date`, tal cual. */
export function instanteCorte(c: string | Date): Date {
  return c instanceof Date ? c : new Date(`${c}T00:00:00-05:00`);
}

export interface CorteDePrueba {
  fijar(c: string | Date): Promise<void>;
  quitar(): Promise<void>;
  restaurar(): Promise<void>;
}

export function corteDePrueba(sql: Sql): CorteDePrueba {
  // Como texto (y `::text::timestamptz` al volver, para que el driver no lo pase por un `Date`): un `Date` de JS
  // pierde los microsegundos de timestamptz y la fila restaurada no sería idéntica.
  let original: { corte_en: string; registrado_en: string } | null | undefined; // undefined = aún no guardado
  const guardar = async (): Promise<void> => {
    if (original !== undefined) return;
    const [f] = await sql<{ corte_en: string; registrado_en: string }[]>`SELECT corte_en::text AS corte_en, registrado_en::text AS registrado_en FROM flito_bolsas_corte WHERE id = 1`;
    original = f ?? null;
  };
  return {
    async fijar(c) {
      await guardar();
      const en = instanteCorte(c);
      await sql`INSERT INTO flito_bolsas_corte (id, corte_en) VALUES (1, ${en})
                ON CONFLICT (id) DO UPDATE SET corte_en = EXCLUDED.corte_en`;
    },
    async quitar() {
      await guardar();
      await sql`DELETE FROM flito_bolsas_corte WHERE id = 1`;
    },
    async restaurar() {
      if (original === undefined) return;
      await sql`DELETE FROM flito_bolsas_corte WHERE id = 1`;
      if (original) {
        await sql`INSERT INTO flito_bolsas_corte (id, corte_en, registrado_en) VALUES (1, ${original.corte_en}::text::timestamptz, ${original.registrado_en}::text::timestamptz)`;
      }
      original = undefined;
    },
  };
}
