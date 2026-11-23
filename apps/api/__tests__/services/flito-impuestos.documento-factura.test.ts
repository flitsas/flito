// HU #14664 — corregir (AC2) o reintentar (AC3) número/fecha/avalúo de la factura, sin tocar el
// semáforo/certificación/comparación RUNT (AC4) y con auditoría del último cambio (AC5). Calco del
// patrón de pruebas de flito-impuestos.direccion.test.ts (memoria: mock-chain-inventa-columnas): los
// asertos van sobre lo que el servicio pasó a `.set()` y su SQL RENDERIZADO, no sobre el mock.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableName, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const selectMock = vi.fn();
const updateMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, update: updateMock, insert: vi.fn(), delete: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));
const logs: unknown[] = [];
vi.mock('../../src/shared/logger.js', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const capt = (...a: unknown[]) => { logs.push(a); };
  const fake = { info: capt, warn: capt, error: capt, debug: capt, child: () => fake };
  return { ...real, loggerFor: () => fake, logger: fake };
});
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const descargarMock = vi.fn();
const extraerMock = vi.fn();
class FacturaNoDisponibleErrorFake extends Error {
  constructor(public readonly motivo: string) { super(`Factura de venta no disponible (${motivo})`); this.name = 'FacturaNoDisponibleError'; }
}
vi.mock('../../src/modules/flito-impuestos/flito-impuestos.extraccion.js', () => ({
  descargarFacturaDeImpuesto: (...a: unknown[]) => descargarMock(...a),
  extraerDeFactura: (...a: unknown[]) => extraerMock(...a),
  FacturaNoDisponibleError: FacturaNoDisponibleErrorFake,
}));

const {
  bloqueDatosDocumentoFacturaDetalle, corregirDatosDocumentoFactura, reintentarLecturaDocumentoFactura,
} = await import('../../src/modules/flito-impuestos/flito-impuestos.documento-factura.js');

const dialect = new PgDialect();
const render = (w: SQL) => dialect.sqlToQuery(w);

interface Grabacion { tabla?: string; set?: Record<string, unknown>; where?: SQL }
function grabador(filas: unknown[], g: Grabacion = {}) {
  const c: Record<string, unknown> = {};
  Object.assign(c, {
    set: (v: Record<string, unknown>) => { g.set = v; return c; },
    where: (w: SQL) => { g.where = w; return c; },
    returning: () => c,
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(filas).then(res, rej),
  });
  return c;
}
function updates(filas: unknown[]): Grabacion[] {
  const g: Grabacion[] = [];
  updateMock.mockImplementationOnce((t: Parameters<typeof getTableName>[0]) => { const x: Grabacion = { tabla: getTableName(t) }; g.push(x); return grabador(filas, x); });
  return g;
}

const ID = '00000000-0000-0000-0000-0000000000f1';
const ACTOR = { userId: 9, nombre: 'ops@flit.io' };
const campo = (valor: string | null, confiable = true) => ({ valor, confianza: confiable ? 1 : 0.4, confiable });

beforeEach(() => {
  selectMock.mockReset(); updateMock.mockReset(); descargarMock.mockReset(); extraerMock.mockReset(); logs.length = 0;
});

describe('bloqueDatosDocumentoFacturaDetalle — AC1/AC8: nunca null, los 3 campos + último cambio', () => {
  it('sin extracción (null o undefined) → los 3 campos y ultimoCambio en null', () => {
    expect(bloqueDatosDocumentoFacturaDetalle(null)).toEqual({
      numeroFactura: null, fechaFactura: null, avaluoComercial: null, ultimoCambio: null,
    });
    expect(bloqueDatosDocumentoFacturaDetalle(undefined)).toEqual({
      numeroFactura: null, fechaFactura: null, avaluoComercial: null, ultimoCambio: null,
    });
  });

  it('con lectura y último cambio → los proyecta tal cual, sin tocar vehículo/dirección/identidad', () => {
    const ultimoCambio = { tipo: 'correccion', usuarioId: '9', usuarioNombre: 'ops@flit.io', en: '2026-11-20T10:00:00.000Z', motivo: 'dato ilegible' };
    const e = {
      numeroFactura: campo('FAC-123'), fechaFactura: campo('2026-11-01'), avaluoComercial: campo('45000000.00'),
      vin: campo('9ZZTEST0000000001'), direccion: campo('CL 1'), ultimoCambioDocumento: ultimoCambio,
    };
    expect(bloqueDatosDocumentoFacturaDetalle(e as never)).toEqual({
      numeroFactura: campo('FAC-123'), fechaFactura: campo('2026-11-01'), avaluoComercial: campo('45000000.00'),
      ultimoCambio,
    });
  });
});

describe('corregirDatosDocumentoFactura — AC2: motivo obligatorio (validado en la ruta), confiable=true tras corregir', () => {
  it('corrige solo el campo enviado: UN jsonb_set de ese campo + ultimoCambioDocumento, nada más', async () => {
    const g = updates([{ id: ID, extraccionFacturaVenta: { numeroFactura: campo('FAC-999') } }]);
    const r = await corregirDatosDocumentoFactura(ID, { numeroFactura: 'FAC-999', motivo: 'número ilegible en el OCR' }, ACTOR);

    expect(g).toHaveLength(1);
    expect(g[0]!.tabla).toBe('flito_impuestos');
    const sqlExpr = render(g[0]!.set!.extraccionFacturaVenta as SQL);
    expect(sqlExpr.sql).toContain("jsonb_set(jsonb_set(COALESCE(");
    expect(sqlExpr.sql).toContain("'{numeroFactura}'");
    expect(sqlExpr.sql).toContain("'{ultimoCambioDocumento}'");
    expect(sqlExpr.sql).not.toContain('{fechaFactura}');
    expect(sqlExpr.sql).not.toContain('{avaluoComercial}');
    expect(sqlExpr.params).toContainEqual(JSON.stringify({ valor: 'FAC-999', confianza: 1, confiable: true }));
    const ultimoCambioParam = sqlExpr.params.find((p) => typeof p === 'string' && p.includes('"tipo":"correccion"')) as string;
    expect(JSON.parse(ultimoCambioParam)).toMatchObject({
      tipo: 'correccion', usuarioId: '9', usuarioNombre: 'ops@flit.io', motivo: 'número ilegible en el OCR',
    });
    expect(new Date((JSON.parse(ultimoCambioParam) as { en: string }).en).toString()).not.toBe('Invalid Date');
    expect(g[0]!.set!.updatedAt).toBeInstanceOf(Date);
    expect(r).toEqual(bloqueDatosDocumentoFacturaDetalle({ numeroFactura: campo('FAC-999') } as never));
  });

  it('`\'\'` tras recortar vacía el campo: `valor: null`, pero `confiable: true` se mantiene', async () => {
    const g = updates([{ id: ID, extraccionFacturaVenta: {} }]);
    await corregirDatosDocumentoFactura(ID, { avaluoComercial: '   ', motivo: 'avalúo no aplica para este vehículo' }, ACTOR);
    const sqlExpr = render(g[0]!.set!.extraccionFacturaVenta as SQL);
    expect(sqlExpr.params).toContainEqual(JSON.stringify({ valor: null, confianza: 1, confiable: true }));
  });

  it('corrige los tres campos a la vez: tres jsonb_set de campo + uno de ultimoCambioDocumento', async () => {
    const g = updates([{ id: ID, extraccionFacturaVenta: {} }]);
    await corregirDatosDocumentoFactura(ID, {
      numeroFactura: 'FAC-1', fechaFactura: '2026-11-01', avaluoComercial: '1000.50', motivo: 'corrección completa del documento',
    }, ACTOR);
    const sqlExpr = render(g[0]!.set!.extraccionFacturaVenta as SQL);
    expect(sqlExpr.sql.match(/jsonb_set/g)).toHaveLength(4);
    expect(sqlExpr.sql).toContain("'{numeroFactura}'");
    expect(sqlExpr.sql).toContain("'{fechaFactura}'");
    expect(sqlExpr.sql).toContain("'{avaluoComercial}'");
  });

  it('fila inexistente (RETURNING vacío) → null, sin reventar', async () => {
    updates([]);
    const r = await corregirDatosDocumentoFactura(ID, { numeroFactura: 'FAC-1', motivo: 'motivo cualquiera' }, ACTOR);
    expect(r).toBeNull();
  });
});

describe('reintentarLecturaDocumentoFactura — AC3: reemplaza SOLO los 3 campos del documento', () => {
  const extraccionFresca = {
    // Vehículo + dirección + identidad: NO deben escribirse (AC3).
    vin: campo('9ZZTEST0000000002'), marca: campo('TOYOTA'), linea: campo('COROLLA'),
    direccion: campo('CL 10'), municipio: campo('BOGOTA'), departamento: campo('CUNDINAMARCA'),
    nombres: campo('JUAN'), numeroDocumento: campo('123456'),
    numeroFactura: campo('FAC-FRESCA'), fechaFactura: campo('2026-11-15'), avaluoComercial: campo('80000000.00'),
    fuente: 'ocr',
  };

  it('OK: el UPDATE solo toca numeroFactura/fechaFactura/avaluoComercial + ultimoCambioDocumento (tipo=reintento)', async () => {
    descargarMock.mockResolvedValueOnce({ bytes: Buffer.from('x'), contentType: 'application/pdf' });
    extraerMock.mockResolvedValueOnce(extraccionFresca);
    const g = updates([{ id: ID, extraccionFacturaVenta: {
      numeroFactura: campo('FAC-FRESCA'), fechaFactura: campo('2026-11-15'), avaluoComercial: campo('80000000.00'),
    } }]);

    const r = await reintentarLecturaDocumentoFactura(ID, 'vuelve a leer la factura', ACTOR);

    expect(r.resultado).toBe('OK');
    const sqlExpr = render(g[0]!.set!.extraccionFacturaVenta as SQL);
    expect(sqlExpr.sql.match(/jsonb_set/g)).toHaveLength(4); // 3 campos del documento + ultimoCambioDocumento
    for (const claveAusente of ['{vin}', '{marca}', '{linea}', '{direccion}', '{municipio}', '{departamento}', '{nombres}', '{numeroDocumento}']) {
      expect(sqlExpr.sql).not.toContain(claveAusente);
    }
    expect(sqlExpr.params).toContainEqual(JSON.stringify(campo('FAC-FRESCA')));
    expect(sqlExpr.params).toContainEqual(JSON.stringify(campo('2026-11-15')));
    expect(sqlExpr.params).toContainEqual(JSON.stringify(campo('80000000.00')));
    const ultimoCambioParam = sqlExpr.params.find((p) => typeof p === 'string' && p.includes('"tipo":"reintento"')) as string;
    expect(JSON.parse(ultimoCambioParam)).toMatchObject({ tipo: 'reintento', usuarioId: '9', usuarioNombre: 'ops@flit.io', motivo: 'vuelve a leer la factura' });
    if (r.resultado === 'OK') {
      expect(r.datos).toEqual({
        numeroFactura: campo('FAC-FRESCA'), fechaFactura: campo('2026-11-15'), avaluoComercial: campo('80000000.00'), ultimoCambio: null,
      });
    }
  });

  it('AC4: no importa ni llama nada del análisis/certificación/RUNT — ni `reanalizarImpuesto` ni el paso de análisis', () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(path.resolve(dir, '../../src/modules/flito-impuestos/flito-impuestos.documento-factura.ts'), 'utf8');
    // Código real (no el comentario de cabecera que explica el AC): ni import ni llamada.
    expect(src).not.toMatch(/from ['"][^'"]*flito-impuestos\.analisis/);
    expect(src).not.toContain('reanalizarImpuesto(');
    expect(src).not.toContain('AnalisisEstadoImpuesto.');
    expect(src).not.toMatch(/\.where\([^)]*analisisEstado/);
  });

  it('factura no disponible (FacturaNoDisponibleError) → FACTURA_NO_DISPONIBLE, sin UPDATE', async () => {
    descargarMock.mockRejectedValueOnce(new FacturaNoDisponibleErrorFake('sin_factura'));
    const r = await reintentarLecturaDocumentoFactura(ID, 'reintento', ACTOR);
    expect(r).toEqual({ resultado: 'FACTURA_NO_DISPONIBLE', motivo: 'sin_factura' });
    expect(updateMock).not.toHaveBeenCalled();
    expect(extraerMock).not.toHaveBeenCalled();
  });

  it('la fila desapareció entre la descarga y el UPDATE (RETURNING vacío) → NO_ENCONTRADO', async () => {
    descargarMock.mockResolvedValueOnce({ bytes: Buffer.from('x'), contentType: 'application/pdf' });
    extraerMock.mockResolvedValueOnce(extraccionFresca);
    updates([]);
    const r = await reintentarLecturaDocumentoFactura(ID, 'reintento', ACTOR);
    expect(r).toEqual({ resultado: 'NO_ENCONTRADO' });
  });
});
