// HU #11323 — el modelo de datos de la facturación electrónica (Feature #11242).
//
// Las garantías de esta historia son de la BASE DE DATOS, no del código: índices únicos, `CHECK` y
// un disparador. Esta suite corre con la base mockeada, así que **no puede probarlas** — se
// verificaron aplicando la migración contra un PostgreSQL 16 real y provocando cada violación, y el
// resultado está en el PR.
//
// Lo que sí puede hacer esta suite, y es donde de verdad aporta, es **impedir que las dos copias de
// esos catálogos se separen**. Los estados y las estrategias están escritos dos veces: en
// `shared-types` porque el código los necesita, y en un `CHECK` de la migración porque la base de
// datos no puede importar TypeScript. La duplicación es deliberada; lo que no puede pasar es que
// alguien añada un estado en un sitio y no en el otro — el síntoma sería un `UPDATE` rechazado en
// producción por una restricción que nadie recuerda.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ARRENDAMIENTO_EN_PROCESO_MIN_DEFECTO,
  SIIGO_ESTRATEGIAS_LOTE,
  SIIGO_FACTURA_ESTADOS,
  SIIGO_FACTURA_ESTADO_ETIQUETA,
  SIIGO_IDEMPOTENCY_KEY_MAX,
  SIIGO_IDEMPOTENCY_KEY_RE,
  SIIGO_MONEDAS,
  SIIGO_RETENCIONES_ESTRATEGIAS,
} from '@operaciones/shared-types';

const MIGRACION = readFileSync(
  path.resolve(process.cwd(), 'src/db/migrations/0135_siigo_facturacion.sql'),
  'utf8',
);

/** Extrae los literales de un `CHECK (... IN ('a','b'))` por el nombre de su restricción. */
function valoresDelCheck(nombreRestriccion: string): string[] {
  const re = new RegExp(`CONSTRAINT\\s+${nombreRestriccion}[\\s\\S]*?IN\\s*\\(([^)]*)\\)`);
  const m = re.exec(MIGRACION);
  if (!m) throw new Error(`No se encontró el CHECK ${nombreRestriccion} en la migración 0135`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!).sort();
}

describe('los catálogos del código y los de la base no se pueden separar', () => {
  it('los estados de la factura son los mismos en las dos copias', () => {
    expect(valoresDelCheck('siigo_facturas_estado_chk')).toEqual([...SIIGO_FACTURA_ESTADOS].sort());
  });

  it('las estrategias de agrupación también', () => {
    expect(valoresDelCheck('siigo_lotes_estrategia_chk')).toEqual([...SIIGO_ESTRATEGIAS_LOTE].sort());
  });

  it('la estrategia de retenciones también', () => {
    expect(valoresDelCheck('siigo_config_retenciones_chk'))
      .toEqual([...SIIGO_RETENCIONES_ESTRATEGIAS].sort());
  });

  it('la moneda también', () => {
    expect(valoresDelCheck('siigo_config_moneda_chk')).toEqual([...SIIGO_MONEDAS].sort());
  });

  it('cada estado tiene su etiqueta: la pantalla no puede quedarse sin texto', () => {
    for (const estado of SIIGO_FACTURA_ESTADOS) {
      expect(SIIGO_FACTURA_ESTADO_ETIQUETA[estado]).toBeTruthy();
    }
    expect(Object.keys(SIIGO_FACTURA_ESTADO_ETIQUETA).sort())
      .toEqual([...SIIGO_FACTURA_ESTADOS].sort());
  });
});

describe('las decisiones que este modelo deja abiertas siguen abiertas', () => {
  // Si alguien amplía uno de estos catálogos, es porque respondió una pregunta de negocio. Que este
  // test falle es la señal de que esa respuesta tiene que quedar escrita en algún sitio, no de que
  // el test sobre.
  it('la granularidad sigue sin decidirse: una sola estrategia de agrupación', () => {
    expect(SIIGO_ESTRATEGIAS_LOTE).toHaveLength(1);
    expect(SIIGO_ESTRATEGIAS_LOTE[0]).toBe('por_tramite');
  });

  it('las retenciones siguen sin decidirse: una sola estrategia', () => {
    expect(SIIGO_RETENCIONES_ESTRATEGIAS).toEqual(['ninguna']);
  });

  it('la moneda sigue asumida: un solo valor', () => {
    expect(SIIGO_MONEDAS).toEqual(['COP']);
  });

  it('el histórico nace desde la instalación, que es la respuesta conservadora', () => {
    // `current_date` y no una fecha lejana: facturar el histórico entero por omisión sería tomar
    // la decisión por quien no la ha tomado, y ante la DIAN.
    expect(MIGRACION).toMatch(/historico_desde\s+date\s+NOT NULL\s+DEFAULT\s+current_date/);
  });
});

describe('la clave de idempotencia no admite un id crudo', () => {
  it('acepta lo que Siigo admite', () => {
    expect(SIIGO_IDEMPOTENCY_KEY_RE.test('LOTE001')).toBe(true);
    expect(SIIGO_IDEMPOTENCY_KEY_RE.test('a'.repeat(SIIGO_IDEMPOTENCY_KEY_MAX))).toBe(true);
  });

  it('rechaza un UUID en crudo, que es el error natural', () => {
    // El texto del Feature decía «clave derivada del id del lote». Si el id es un UUID, lleva
    // guiones y 36 caracteres: hay que DERIVARLA, no usarla.
    expect(SIIGO_IDEMPOTENCY_KEY_RE.test('8f14e45f-ea8d-4b3a-9c2e-1a2b3c4d5e6f')).toBe(false);
  });

  it('rechaza espacios, especiales y lo que pase de 30', () => {
    for (const malo of ['LOTE 001', 'LOTE-001', 'LOTE_001', 'a'.repeat(31), '']) {
      expect(SIIGO_IDEMPOTENCY_KEY_RE.test(malo)).toBe(false);
    }
  });

  it('la base de datos afirma el mismo formato que el código', () => {
    // Sin esto, una clave inválida guardada es una emisión que fallará siempre sin que se vea por qué.
    expect(MIGRACION).toContain("idempotency_key ~ '^[A-Za-z0-9]{1,30}$'");
  });
});

describe('las tres carreras que este modelo cierra siguen cerradas', () => {
  it('el lote se identifica por su contenido, no por un id nuevo', () => {
    // Con un id aleatorio, dos encolados del mismo trámite producen dos claves y DOS FACTURAS DIAN.
    expect(MIGRACION).toMatch(
      /CREATE UNIQUE INDEX[^;]*idx_siigo_lotes_natural[\s\S]*?\(ambiente,\s*estrategia,\s*huella\)/,
    );
  });

  it('la clave de idempotencia es única POR AMBIENTE, no global', () => {
    // Global bloquearía en producción un lote ya ensayado en pruebas, y para siempre.
    expect(MIGRACION).toMatch(
      /CREATE UNIQUE INDEX[^;]*idx_siigo_facturas_idem[\s\S]*?\(ambiente,\s*idempotency_key\)/,
    );
  });

  it('un trámite no puede estar en dos facturas vivas, y una fallida no lo ocupa', () => {
    expect(MIGRACION).toMatch(
      /CREATE UNIQUE INDEX[^;]*idx_siigo_factura_tramites_vivo[\s\S]*?\(tramite_id\)\s*WHERE activo/,
    );
    // El espejo lo mantiene un disparador porque el predicado de un índice parcial no admite
    // subconsultas, y comprobarlo en el servicio deja la carrera abierta.
    expect(MIGRACION).toContain('trg_siigo_factura_tramite_activo');
  });

  it('una fila en proceso guarda desde cuándo: sin reloj no hay huérfanas detectables', () => {
    expect(MIGRACION).toContain('siigo_facturas_en_proceso_chk');
    expect(ARRENDAMIENTO_EN_PROCESO_MIN_DEFECTO).toBe(15);
  });

  it('la migración no abre transacción propia (ADR-DB-001)', () => {
    // Se busca la SENTENCIA, con su punto y coma: el `BEGIN` de un bloque `DO $$ ... $$` es
    // plpgsql y no tiene nada que ver con el control de transacción que el runner ya gestiona.
    expect(MIGRACION).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\s*;/im);
  });
});
