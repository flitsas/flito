/**
 * Épica #14707 (ADR-0049 §4, diseño §6) — guards de AVANCE sobre un trámite muerto, una prueba por familia:
 *
 *   · T  (trámite): asignar un servicio adicional a un trámite muerto → 409 tras el bloqueo del trámite y sin INSERT
 *        (desbloquear, liquidar, aplicar comprobante, revisión y logística usan el mismo `exigirTramiteVivo`, probado
 *        en `tramite-vigente.test.ts`). La compuerta de entrega ya exigía `asignado` (E: un muerto sale no habilitado).
 *   · TL (lote): la elegibilidad Siigo marca `tramite_no_vigente` (no elegible, sin 409).
 *   · I  (impuesto): reanalizar un impuesto descartado → 409 (no el `NO_SOLICITADO` de antes).
 *   · S  (SOAT): reversa, cambio de proveedor y traspaso de gestión sobre un SOAT descartado → 409; los 400 de
 *        siempre (motivo corto, RN-05, pagado) no cambian.
 *   · Tr (trigger FL409): contra la base real en `descarte-tramite-muerto.test.ts`; su traducción HTTP, en
 *        `tramite-vigente.test.ts`.
 *   · Salida: desaplicar un comprobante cuyo dueño está descartado se permite (`flito-comprobantes-desaplicar.test.ts`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { createKeyedDb } from '../helpers/keyed-db.js';

const kdb = createKeyedDb();
vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logMock }));
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { asignar } = await import('../../src/modules/finanzas-servicios-adicionales/finanzas-servicios-adicionales.service.js');
const { motivosLocales } = await import('../../src/modules/siigo/facturacion.elegibilidad.service.js');
const { reanalizarImpuesto } = await import('../../src/modules/flito-impuestos/flito-impuestos.analisis.service.js');
const soatVig = await import('../../src/modules/flito-soat/flito-soat-vigente.js');
const { SoatError } = await import('../../src/modules/flito-soat/flito-soat.service.js');
const { flitoTramites, flitoImpuestos } = await import('../../src/db/schema.js');

beforeEach(() => { kdb.reset?.(); });

describe('T — asignar servicio adicional', () => {
  it('trámite muerto → 409 TRAMITE_NO_VIGENTE con su vigencia y radicado; no se inserta nada', async () => {
    kdb.when.select(getTableName(flitoTramites), [{ id: 't-1', idFlit: '1234567', estado: 'anulado', flitEstado: 'Abortado' }]);
    await expect(asignar('t-1', 'tipo-1', 7)).rejects.toMatchObject({
      status: 409, code: 'TRAMITE_NO_VIGENTE', vigencia: 'abortado', message: expect.stringContaining('1234567'),
    });
    expect(kdb.insert).not.toHaveBeenCalled();
  });
});

describe('TL — elegibilidad Siigo (lote)', () => {
  const fila = (vigencia?: 'vigente' | 'revocado') => ({
    tramiteId: 't', companiaId: 1, estadoLiquidacion: 'facturado', facturadoEn: '2026-11-01', documentacionCompleta: true,
    terceroVinculado: true, facturaViva: false, historicoDesde: '2026-01-01', clienteInactivoNombre: null,
    valores: {} as never, ...(vigencia ? { vigencia } : {}),
  });
  it('revocado → no elegible `tramite_no_vigente`; vigente o sin dato → no aparece', () => {
    expect(motivosLocales(fila('revocado') as never).map((m) => m.motivo)).toContain('tramite_no_vigente');
    expect(motivosLocales(fila('vigente') as never).map((m) => m.motivo)).not.toContain('tramite_no_vigente');
    expect(motivosLocales(fila() as never).map((m) => m.motivo)).not.toContain('tramite_no_vigente');
  });
});

describe('I — impuesto descartado', () => {
  it('reanalizar → 409 (antes devolvía NO_SOLICITADO)', async () => {
    kdb.when.select(getTableName(flitoImpuestos), [{ estado: 'descartado', analisisEstado: null }]);
    await expect(reanalizarImpuesto('i-1')).rejects.toMatchObject({ status: 409, code: 'TRAMITE_NO_VIGENTE' });
  });
  it('control: un impuesto pendiente sigue respondiendo NO_SOLICITADO', async () => {
    kdb.when.select(getTableName(flitoImpuestos), [{ estado: 'pendiente', analisisEstado: null }]);
    await expect(reanalizarImpuesto('i-1')).resolves.toEqual({ resultado: 'NO_SOLICITADO' });
  });
});

describe('S — SOAT descartado', () => {
  const descartado = { estado: 'descartado', motivoDescarte: 'abortado' as const };
  it('reversa, cambio de proveedor y traspaso → 409 con el texto del diseño', () => {
    const e409 = expect.objectContaining({ status: 409, code: 'TRAMITE_NO_VIGENTE', message: 'Este SOAT se descartó porque su trámite ya no existe en FLITO.' });
    expect(() => soatVig.exigirReversable(descartado, 'motivo suficiente')).toThrow(e409);
    expect(() => soatVig.exigirCambioProveedorAdmitido(descartado)).toThrow(e409);
    expect(() => soatVig.noAdmiteTraspaso('descartado')).toThrow(e409);
    expect(() => soatVig.exigirSoatVigente(descartado)).toThrow(e409);
  });
  it('los 400 de siempre no cambian (motivo corto, RN-05, pagado / pendiente en traspaso)', () => {
    expect(() => soatVig.exigirReversable({ estado: 'pagado' }, 'no')).toThrow(new SoatError(400, 'La reversa exige un motivo que explique el porqué'));
    expect(() => soatVig.exigirCambioProveedorAdmitido({ estado: 'solicitado' })).toThrow(/RN-05/);
    expect(() => soatVig.exigirCambioProveedorAdmitido({ estado: 'pendiente' })).not.toThrow();
    expect(soatVig.noAdmiteTraspaso('pagado')).toMatchObject({ status: 400, message: expect.stringMatching(/ya está pagado/) });
    expect(soatVig.noAdmiteTraspaso('pendiente')).toMatchObject({ status: 400, message: expect.stringMatching(/Pendiente/) });
    expect(soatVig.exigirMotivo('  motivo válido ', 'X')).toBe('motivo válido');
  });
  it('SoatError del servicio es la misma clase que la del módulo de vigencia (re-export)', () => {
    expect(SoatError).toBe(soatVig.SoatError);
  });
});
