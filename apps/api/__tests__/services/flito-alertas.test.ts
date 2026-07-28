// HU #10961 — alertas operativas del tablero (Feature #10942).
//
// Aquí se prueba lo que es verificable sin base de datos: el guarda de entrada y la FORMA del SQL
// generado (que referencia las columnas y los umbrales correctos). El comportamiento real de cada
// predicado —cuántas filas devuelve— se verifica contra Postgres, porque el helper `chain()` de los
// tests descarta los argumentos de `where()` y no puede detectar un SQL sintácticamente inválido.
// Ese fue exactamente el agujero por el que se coló `<> ALL(array)` en el Feature anterior.

import { describe, it, expect, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { ALERTAS_OPERATIVAS, SLA_OPERATIVO, esAlertaOperativa } from '@operaciones/shared-types';

vi.mock('../../src/db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/modules/flito-soat/flito-soat.service.js', () => ({ enviarAlGestor: vi.fn() }));
vi.mock('../../src/modules/flito-impuestos/flito-impuestos.service.js', () => ({ enviarAlGestor: vi.fn() }));

const { condicionAlerta } = await import('../../src/modules/flito-tramites/flito-tramites.service.js');

// Se renderiza con el dialecto real de drizzle, no a mano: es la única forma de ver el SQL que de
// verdad llega a Postgres, con sus nombres de columna resueltos.
const dialecto = new PgDialect();

/** SQL generado + sus parámetros, aplanados en un solo texto inspeccionable. */
function sqlDe(alerta: (typeof ALERTAS_OPERATIVAS)[number]): string {
  const q = dialecto.sqlToQuery(condicionAlerta(alerta));
  const params = q.params.map((p) => `'${String(p)}'`).join(' ');
  return `${q.sql.replace(/\s+/g, ' ')} ${params}`;
}

describe('esAlertaOperativa — el guarda de entrada', () => {
  it('acepta las cuatro alertas del requerimiento', () => {
    for (const a of ALERTAS_OPERATIVAS) expect(esAlertaOperativa(a)).toBe(true);
    expect(ALERTAS_OPERATIVAS).toHaveLength(4);
  });

  it('rechaza cualquier otro valor en vez de dejarlo llegar al SQL', () => {
    for (const v of ['', 'borrador', 'BORRADOR_5D', "'; DROP TABLE", undefined, null, 7, {}]) {
      expect(esAlertaOperativa(v)).toBe(false);
    }
  });
});

describe('condicionAlerta — cada alerta mira lo que dice el requerimiento', () => {
  it('borrador se apoya en el historial de estados y cae a la fecha de creación', () => {
    const s = sqlDe('borrador_5d');
    expect(s).toContain("'borrador'");
    expect(s).toContain('flito_tramite_historial');
    expect(s).toContain("'flit_estado'");
    // Un trámite que nació en Borrador no tiene fila de historial: el COALESCE es lo que evita
    // que quede fuera de la alerta para siempre.
    expect(s).toContain('COALESCE');
    expect(s).toContain(String(SLA_OPERATIVO.BORRADOR_DIAS));
  });

  it('sin aprobar cuenta Entregado y Rechazado, que es lo que espera al organismo', () => {
    // El ciclo es Borrador → Enviado a OT → Asignado → Entregado → Aprobado, y los estados pueden
    // retroceder: un Entregado que se Rechaza se subsana y vuelve a Entregado. Ambos están ya en
    // manos del organismo, así que son exactamente el cuello de botella que la alerta busca.
    const s = sqlDe('sin_aprobar_1d');
    for (const estado of ['entregado', 'rechazado']) {
      expect(s).toContain(`'${estado}'`);
    }
    expect(s).toContain(String(SLA_OPERATIVO.SIN_APROBAR_DIAS));
  });

  it('sin aprobar deja fuera lo que aún no ha llegado al organismo', () => {
    // Un borrador o un asignado pueden llevar semanas parados, pero la demora no es del organismo:
    // meterlos aquí es lo que inflaba la alerta y la volvía inservible para priorizar.
    const s = sqlDe('sin_aprobar_1d');
    for (const estado of ['borrador', 'asignado', 'aprobado', 'anulado', 'abortado']) {
      expect(s).not.toContain(`'${estado}'`);
    }
    // Ya no se filtra por fecha_aprobacion: el estado es la autoridad, y ese guardia escondía los
    // trámites que se aprobaron y luego retrocedieron a Entregado.
    expect(s).not.toContain('fecha_aprobacion');
  });

  it('SOAT sin gestión usa el SLA del proveedor con respaldo por defecto', () => {
    const s = sqlDe('soat_sin_gestion');
    expect(s).toContain("'solicitado'");
    expect(s).toContain('sla_horas');
    // Sin respaldo, los proveedores sin SLA configurado quedarían invisibles para la alerta.
    expect(s).toContain(String(SLA_OPERATIVO.SIN_GESTION_HORAS_DEFECTO));
  });

  it('impuesto sin gestión usa el SLA del organismo con el mismo respaldo', () => {
    const s = sqlDe('impuesto_sin_gestion');
    expect(s).toContain("'solicitado'");
    expect(s).toContain('flito_sla_horas');
    expect(s).toContain(String(SLA_OPERATIVO.SIN_GESTION_HORAS_DEFECTO));
  });

  it('ninguna alerta concatena texto para construir el intervalo', () => {
    // `$1 || ' days'` deja el tipo del parámetro ambiguo y Postgres lo rechaza; make_interval no.
    for (const a of ALERTAS_OPERATIVAS) {
      expect(sqlDe(a)).toContain('make_interval');
      expect(sqlDe(a)).not.toContain("|| ' days'");
      expect(sqlDe(a)).not.toContain("|| ' hours'");
    }
  });

  it('las condiciones de SOAT e impuesto exigen fecha de envío', () => {
    // Sin este guarda, un registro solicitado sin `enviado_en` haría que la comparación fuera NULL
    // y desaparecería de la alerta sin dejar rastro.
    expect(sqlDe('soat_sin_gestion')).toContain('IS NOT NULL');
    expect(sqlDe('impuesto_sin_gestion')).toContain('IS NOT NULL');
  });
});
