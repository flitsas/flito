// HU #14112 (C1.5, ADR-0030 C8a) — script de cifrado del legado: 2.ª corrida no-op, conteo en claro = 0,
// no loguea cédulas ni nombres. Doubles de BD (mismo patrón que laft.backfill.test.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { revelarDocumento } from '../../src/modules/flito-logistica/flito-logistica.cifrado.js';

const executeMock = vi.fn();
const transactionMock = vi.fn();
const logLlamadas: unknown[][] = [];

vi.mock('../../src/db/client.js', () => ({
  db: {
    execute: executeMock,
    transaction: transactionMock,
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const CEDULA_RECEPTOR = '1036640908';
const CEDULA_CONTACTO = '9001234567';
const NOMBRE = 'Ana Receptor Histórica';
const ACTA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FIRMA_RECIBE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FIRMA_ENTREGA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const rowEnClaro = {
  id: ACTA,
  receptor_documento: CEDULA_RECEPTOR,
  receptor_nombre: NOMBRE,
  contacto_documento: CEDULA_CONTACTO,
  contacto_nombre: 'Contacto Compañía',
  firma_storage_key: 'firmas/recibe.png',
  firma_entrega_storage_key: 'firmas/entrega.png',
  entrega_nombre: 'Operaciones',
  entregado_en: new Date('2026-01-15T10:00:00Z'),
  recibe_firma_id: FIRMA_RECIBE,
  recibe_cifrado: null,
  entrega_firma_id: FIRMA_ENTREGA,
  entrega_cifrado: null,
};

beforeEach(() => {
  executeMock.mockReset();
  transactionMock.mockReset();
  logLlamadas.length = 0;
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logLlamadas.push(a); });
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { logLlamadas.push(a); });
});

describe('HU #14112 — planActa cifra con el helper y AAD = firmaId', () => {
  it('receptor → recibe y contacto → entrega; revelarDocumento recupera el valor; el plan no lleva el claro', async () => {
    const { planActa } = await import('../../src/scripts/flito-logistica-cifrar-cedulas-historicas.js');
    const plan = planActa(rowEnClaro);
    expect(plan.actaId).toBe(ACTA);
    expect(plan.firmas).toHaveLength(2);
    const recibe = plan.firmas.find((f) => f.rol === 'recibe')!;
    const entrega = plan.firmas.find((f) => f.rol === 'entrega')!;
    expect(recibe.crear).toBe(false);
    expect(recibe.firmaId).toBe(FIRMA_RECIBE);
    expect(revelarDocumento(recibe.cifrado, FIRMA_RECIBE)).toBe(CEDULA_RECEPTOR);
    expect(revelarDocumento(entrega.cifrado, FIRMA_ENTREGA)).toBe(CEDULA_CONTACTO);
    expect(JSON.stringify(plan.firmas.map((f) => f.cifrado))).not.toContain(CEDULA_RECEPTOR);
    expect(JSON.stringify(plan.firmas.map((f) => f.cifrado))).not.toContain(CEDULA_CONTACTO);
  });

  it('si ya hay documento_cifrado no re-cifra (no pisa C1.3) y sin documento no arma firma', async () => {
    const { planActa } = await import('../../src/scripts/flito-logistica-cifrar-cedulas-historicas.js');
    const plan = planActa({
      ...rowEnClaro,
      recibe_cifrado: 'v1:ya:cifrado',
      contacto_documento: null,
    });
    expect(plan.firmas).toEqual([]);
  });

  it('sin fila de firma: crea una con id nuevo y cifra sobre ese id', async () => {
    const { planActa } = await import('../../src/scripts/flito-logistica-cifrar-cedulas-historicas.js');
    const plan = planActa({
      ...rowEnClaro,
      recibe_firma_id: null,
      entrega_firma_id: null,
      contacto_documento: null,
    });
    expect(plan.firmas).toHaveLength(1);
    const f = plan.firmas[0]!;
    expect(f.crear).toBe(true);
    expect(f.rol).toBe('recibe');
    expect(revelarDocumento(f.cifrado, f.firmaId)).toBe(CEDULA_RECEPTOR);
  });
});

describe('HU #14112 — run idempotente y conteo en claro = 0', () => {
  it('1.ª corrida cifra; 2.ª corrida no escribe; contarEnClaro = 0; logs sin cédula ni nombre', async () => {
    // Orden: fetch con filas → fetch vacío (sale) → conteo; 2.ª corrida: fetch vacío → conteo; conteo extra.
    const cola: unknown[] = [
      [rowEnClaro], [], [{ n: 0 }],
      [], [{ n: 0 }],
      [{ n: 0 }],
    ];
    executeMock.mockImplementation(async () => cola.shift() ?? []);

    const writes: number[] = [];
    transactionMock.mockImplementation(async (cb: (tx: { execute: typeof executeMock }) => Promise<void>) => {
      const tx = {
        execute: vi.fn(async () => { writes.push(writes.length + 1); return []; }),
      };
      await cb(tx);
    });

    const { run, contarEnClaro } = await import('../../src/scripts/flito-logistica-cifrar-cedulas-historicas.js');
    const stats1 = await run();
    expect(stats1.total).toBe(1);
    expect(stats1.cifradas).toBe(1);
    expect(stats1.firmasEscritas).toBe(2);
    expect(stats1.enClaroAlFinal).toBe(0);
    expect(writes.length).toBeGreaterThan(0);
    expect(transactionMock).toHaveBeenCalledTimes(1);

    const stats2 = await run();
    expect(stats2.total).toBe(0);
    expect(stats2.cifradas).toBe(0);
    expect(transactionMock).toHaveBeenCalledTimes(1);

    expect(await contarEnClaro()).toBe(0);

    const volcado = JSON.stringify(logLlamadas);
    expect(volcado).not.toContain(CEDULA_RECEPTOR);
    expect(volcado).not.toContain(CEDULA_CONTACTO);
    expect(volcado).not.toContain(NOMBRE);
  });
});
