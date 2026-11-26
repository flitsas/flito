/**
 * Épica #14707 (ADR-0049 §1 y §3) — el sync reconoce la muerte y dispara el descarte en la transición.
 *
 *   · D1: FLIT 1 mapea Abortado/Revocado/Anulado a `anulado`; `rechazado` NO es muerte. FLIT 2 ya mapeaba
 *     `anulado`/`revocado` a `anulado` (`estadoDesdeFlit2`).
 *   · `escribirTramite` (FLIT 1 y FLIT 2) llama a `descartarDeTramiteMuerto` SOLO en la transición vivo → muerto, en la
 *     misma tx y después del UPDATE: ni en el alta (llega ya muerto), ni con `soloSiCambia` sin cambios, ni muerto →
 *     muerto. Pasa la fila YA escrita, con `avisar: true` y el rearranque inyectado.
 *   · Decisión cerrada 5: muerto → vivo deja la anomalía en `audit_logs` (radicado, sin VIN) y no descarta nada.
 *   · `puedeArrancar` / `rearrancarSoatDeVivo` (D3a): mismas condiciones que el arranque del sync.
 * Sin base: `tx` es un doble que registra INSERT/UPDATE; el orquestador es un espía.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';

const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
const descarteMock = vi.hoisted(() => vi.fn(async () => ({ impuestos: 1 })));
vi.mock('../../src/modules/flito-sync/descarte-tramite-muerto.js', () => ({ descartarDeTramiteMuerto: descarteMock }));
const companiaPorNitMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/modules/flito-parametrizacion/flito-parametrizacion.service.js', async (orig) => ({
  ...(await orig() as Record<string, unknown>), companiaPorNit: companiaPorNitMock,
}));

const sync = await import('../../src/modules/flito-sync/flito-sync.service.js');
const { estadoDesdeFlit2 } = await import('../../src/modules/flito-sync/flit2-mapeo.js');
const { auditLogs, flitoTramites } = await import('../../src/db/schema.js');

const T_AUDIT = getTableName(auditLogs);
const T_TRAM = getTableName(flitoTramites);

type Fila = typeof flitoTramites.$inferSelect;
const existente = (over: Partial<Fila> = {}): Fila => ({
  id: 'tram-1', idFlit: 'R-14707', estado: 'asignado', flitEstado: 'Asignado', companiaId: 10, organismoCodigo: '05001',
  vehiculoId: 5, soatId: 'soat-1', retenido: false, companiaNit: '900', fechaAprobacion: null, sincronizadoEn: new Date(0),
  ...over,
} as Fila);

function txFalso(escrita: Partial<Fila>) {
  const inserts: Array<{ tabla: string; v: Record<string, unknown> }> = [];
  const updates: string[] = [];
  const tx = {
    insert: (t: unknown) => ({
      values: (v: Record<string, unknown>) => {
        inserts.push({ tabla: getTableName(t as never), v });
        const p = Promise.resolve([{ ...v }]);
        return Object.assign(p, { returning: async () => [{ id: 'nuevo', ...v }] });
      },
    }),
    update: (t: unknown) => ({
      set: () => ({ where: () => ({ returning: async () => { updates.push(getTableName(t as never)); return [existente(escrita)]; } }) }),
    }),
  };
  return { tx: tx as never, inserts, updates };
}

const valores = (estado: string | null, flitEstado: string) => ({ estado, flitEstado, sincronizadoEn: new Date() }) as never;

beforeEach(() => { descarteMock.mockClear(); });

describe('D1 — mapeo de la muerte', () => {
  it.each([['Anulado', 'anulado'], ['Abortado', 'anulado'], [' REVOCADO ', 'anulado'], ['Rechazado', 'rechazado'], ['Asignado', 'asignado'], ['Borrador', null]])(
    'FLIT 1 %s → %s', (crudo, esperado) => { expect(sync.estadoEnumDesdeFlit(crudo)).toBe(esperado); });
  it('FLIT 2: anulado y revocado → anulado (la sub-vigencia queda en flit_estado)', () => {
    expect(estadoDesdeFlit2('anulado')).toMatchObject({ estado: 'anulado', flitEstado: 'Anulado' });
    expect(estadoDesdeFlit2('revocado')).toMatchObject({ estado: 'anulado', flitEstado: 'Revocado' });
  });
});

describe('escribirTramite — gancho del descarte', () => {
  it('vivo → muerto: descarta en la MISMA tx, después del UPDATE, con la fila escrita y avisos', async () => {
    const { tx, updates } = txFalso({ estado: 'anulado', flitEstado: 'Abortado' });
    descarteMock.mockImplementationOnce(async () => { expect(updates).toEqual([T_TRAM]); return { impuestos: 1 } as never; });
    const r = await sync.escribirTramite(tx, existente(), 'R-14707', valores('anulado', 'Abortado'));
    expect(descarteMock).toHaveBeenCalledTimes(1);
    const [txUsada, fila, o] = descarteMock.mock.calls[0]! as unknown as [unknown, Fila, { avisar: boolean; rearrancar: unknown }];
    expect(txUsada).toBe(tx);
    expect(fila).toMatchObject({ id: 'tram-1', estado: 'anulado', flitEstado: 'Abortado' });
    expect(o).toEqual({ avisar: true, rearrancar: sync.rearrancarSoatDeVivo });
    expect(r.descarte).toEqual({ impuestos: 1 });
  });

  it('alta ya muerta, muerto → muerto, vivo → vivo y soloSiCambia sin cambios: no descarta', async () => {
    await sync.escribirTramite(txFalso({}).tx, null, 'R-1', valores('anulado', 'Anulado'));
    await sync.escribirTramite(txFalso({ estado: 'anulado', flitEstado: 'Revocado' }).tx, existente({ estado: 'anulado', flitEstado: 'Anulado' }), 'R-1', valores('anulado', 'Revocado'));
    await sync.escribirTramite(txFalso({ estado: 'rechazado', flitEstado: 'Rechazado' }).tx, existente(), 'R-1', valores('rechazado', 'Rechazado'));
    const igual = existente();
    await sync.escribirTramite(txFalso({}).tx, igual, 'R-1', { estado: igual.estado, flitEstado: igual.flitEstado } as never, { soloSiCambia: true });
    expect(descarteMock).not.toHaveBeenCalled();
  });

  it('decisión cerrada 5: muerto → vivo audita la anomalía (radicado, sin VIN) y no descarta', async () => {
    const { tx, inserts } = txFalso({ estado: 'asignado', flitEstado: 'Asignado' });
    await sync.escribirTramite(tx, existente({ estado: 'anulado', flitEstado: 'Anulado' }), 'R-14707', valores('asignado', 'Asignado'));
    expect(descarteMock).not.toHaveBeenCalled();
    const audit = inserts.find((i) => i.tabla === T_AUDIT);
    expect(audit?.v).toMatchObject({ resource: 'flito_tramite', resourceId: 'tram-1', userEmail: 'sistema' });
    expect(String(audit?.v.detail)).toMatch(/R-14707.*Lo descartado no revive.*el impuesto no se recrea/);
  });
});

describe('D3a — condiciones del rearranque', () => {
  const compania = { id: 10, active: true, soatAutogestionable: false } as never;
  it('puedeArrancar: Asignado + compañía activa + organismo + no retenido', () => {
    expect(sync.puedeArrancar('Asignado', compania, '05001', false)).toBe(true);
    expect(sync.puedeArrancar('Aprobado', compania, '05001', false)).toBe(false);
    expect(sync.puedeArrancar('Asignado', null, '05001', false)).toBe(false);
    expect(sync.puedeArrancar('Asignado', compania, null, false)).toBe(false);
    expect(sync.puedeArrancar('Asignado', compania, '05001', true)).toBe(false);
    expect(sync.puedeArrancar('Asignado', { id: 10, active: false } as never, '05001', false)).toBe(false);
    expect(sync.puedeArrancar(null, compania, '05001', false)).toBe(false);
  });
  it('rearrancarSoatDeVivo: un vivo que no cumple (no Asignado / sin compañía) no arranca', async () => {
    companiaPorNitMock.mockResolvedValue({ id: 10, active: true, soatAutogestionable: false });
    expect(await sync.rearrancarSoatDeVivo(txFalso({}).tx, existente({ flitEstado: 'Aprobado' }), 'VIN')).toBe(false);
    companiaPorNitMock.mockResolvedValue(null);
    expect(await sync.rearrancarSoatDeVivo(txFalso({}).tx, existente(), 'VIN')).toBe(false);
  });
});
