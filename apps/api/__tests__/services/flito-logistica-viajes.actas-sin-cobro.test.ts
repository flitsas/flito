// HU #12619 AC12 — las actas NO exponen el cobro: `GET /actas/:id` (salida real del handler por
// supertest) y el PDF que genera `generarActaPdf` (bytes reales de pdf-lib, capturados en el mock de
// storage) no contienen valor / tarifa / modo / totalAdicionales / «viaje», y ninguna de sus
// consultas lee `flito_tramite_viajes_logistica`.
//
// Control positivo: el nombre de la compañía y la placa de los fixtures SÍ aparecen en el JSON y en
// el texto dibujado del PDF (content streams inflados y cadenas hex decodificadas): si la
// decodificación fallara, el test caería por el control, no pasaría en vacío. Mutante nombrado:
// añadir `totalAdicionales` a `ActaDetalle` o una línea «Viajes adicionales: …» al PDF → cae.
process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { inflateSync } from 'node:zlib';
import { chain } from '../helpers/db.js';
import { testToken } from '../helpers/auth.js';

const selectMock = vi.fn();
const updateMock = vi.fn();
const tablasLeidas: string[] = [];

vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: updateMock, delete: vi.fn(), transaction: vi.fn(), execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]) },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/shared/historial/permisos-intentos-denegados.js', () => ({
  registrarIntentoDenegado: vi.fn().mockResolvedValue(undefined), ventanaActual: () => new Date(), VENTANA_DEDUP_MS: 3_600_000,
}));
const uploadMock = vi.fn().mockResolvedValue('storage/acta.pdf');
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: uploadMock,
  presignedGetEntityDocument: vi.fn().mockResolvedValue('http://signed'),
  getEntityDocumentStream: vi.fn().mockResolvedValue([]),
}));

const svc = await import('../../src/modules/flito-logistica/flito-logistica.service.js');
const { default: logisticaRoutes } = await import('../../src/modules/flito-logistica/flito-logistica.routes.js');

/** Un chain que apunta la tabla de cada `from`/`join` (por su nombre Drizzle). */
function leyendo(rows: unknown[]) {
  const c = chain(rows) as unknown as Record<string, (...a: unknown[]) => unknown>;
  const apuntar = (t: unknown) => { tablasLeidas.push(String((t as { [k: symbol]: unknown })[Symbol.for('drizzle:Name')] ?? '?')); return c; };
  c.from = apuntar; c.leftJoin = apuntar; c.innerJoin = apuntar;
  return c;
}

/**
 * El texto dibujado de un PDF de pdf-lib: los content streams van con FlateDecode y el texto con
 * fuentes estándar se escribe como cadenas hex (`<41434D45> Tj`). Se inflan los streams y se
 * decodifican las cadenas hex (WinAnsi ≈ latin1 para lo que aquí se dibuja).
 */
function textoDibujado(bytes: Buffer): string {
  const crudo = bytes.toString('latin1');
  const trozos: string[] = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (const m of crudo.matchAll(re)) {
    let contenido = m[1]!;
    try { contenido = inflateSync(Buffer.from(contenido, 'latin1')).toString('latin1'); } catch { /* stream sin comprimir */ }
    for (const h of contenido.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) trozos.push(Buffer.from(h[1]!, 'hex').toString('latin1'));
    for (const l of contenido.matchAll(/\(([^)]*)\)\s*Tj/g)) trozos.push(l[1]!);
  }
  return trozos.join('\n');
}

const PALABRAS_DE_COBRO = ['valor', 'tarifa', 'modo', 'totaladicionales', 'viaje'];
const sinCobro = (texto: string) => PALABRAS_DE_COBRO.filter((p) => texto.toLowerCase().includes(p));

const CABECERA_DETALLE = {
  id: 'acta1', companiaId: 5, companiaNombre: 'ACME', estado: 'despachada', mensajeroId: 9, mensajeroNombre: 'Msj',
  receptorNombre: null, entregadoEn: null, creadoEn: new Date('2026-09-16T08:00:00Z'), pdfStorageKey: 'k/acta.pdf',
  firmaEntregaKey: null, entregaNombre: 'Operaciones', firmaRecibeKey: null,
};
const DOC = { id: 'd1', estado: 'despachado', placa: 'QOX858', secretaria: 'STT', propietario: 'EMMANUEL', numeroLicencia: '100', numeroLt: 'LT-1', idFlit: 'F1' };
const EVENTO = { id: 'e1', documentoId: 'd1', placa: 'QOX858', estadoAnterior: 'en_acta', estadoNuevo: 'despachado', actorNombre: 'Op', motivo: null, origen: 'usuario', creadoEn: new Date('2026-09-16T09:00:00Z') };

beforeEach(() => {
  selectMock.mockReset(); updateMock.mockReset(); uploadMock.mockClear();
  tablasLeidas.length = 0;
});

describe('AC12 — GET /actas/:id no lleva cobro', () => {
  it('la salida real del handler no contiene valor/tarifa/modo/totalAdicionales/viaje y no lee la tabla de viajes', async () => {
    selectMock.mockReturnValueOnce(leyendo([CABECERA_DETALLE])).mockReturnValueOnce(leyendo([DOC])).mockReturnValueOnce(leyendo([EVENTO]));
    const app = express();
    app.use(express.json());
    app.use('/api/flito/logistica', logisticaRoutes);
    const r = await request(app).get('/api/flito/logistica/actas/acta1')
      .set('Authorization', `Bearer ${await testToken({ sub: 1, username: 'op', role: 'admin' })}`);
    expect(r.status).toBe(200);
    const json = JSON.stringify(r.body);
    expect(json).toContain('ACME'); // control positivo
    expect(json).toContain('QOX858');
    expect(sinCobro(json)).toEqual([]);
    expect(Object.keys(r.body).sort()).toEqual(['acta', 'bitacora', 'documentos', 'entregaNombre', 'firmaEntrega', 'firmaRecibe', 'tienePdf']);
    expect(tablasLeidas.length).toBeGreaterThan(0);
    expect(tablasLeidas).not.toContain('flito_tramite_viajes_logistica');
  });
});

describe('AC12 — el PDF del acta no lleva cobro', () => {
  it('los bytes reales del PDF no contienen valor/tarifa/modo/totalAdicionales/viaje; sí la compañía y la placa; no lee la tabla de viajes', async () => {
    selectMock
      .mockReturnValueOnce(leyendo([{
        companiaNombre: 'ACME', direccion: 'Calle 1', contactoNombre: 'Contacto', creadoEn: new Date('2026-09-16T08:00:00Z'),
        firmaEntregaKey: null, entregaNombre: 'Operaciones', firmaRecibeKey: null, receptorNombre: null, receptorDocumento: null, entregadoEn: null,
      }]))
      .mockReturnValueOnce(leyendo([{ placa: 'QOX858', secretaria: 'STT', organismoCodigo: '001', propietario: 'EMMANUEL', numeroLicencia: '100', numeroLt: 'LT-1' }]));
    updateMock.mockReturnValueOnce(chain([]));
    const key = await svc.generarActaPdf('acta1');
    expect(key).toBe('storage/acta.pdf');
    expect(uploadMock).toHaveBeenCalledTimes(1);
    const bytes = uploadMock.mock.calls[0]![3] as Buffer;
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.toString('latin1').startsWith('%PDF-')).toBe(true);
    const texto = textoDibujado(bytes);
    expect(texto).toContain('ACME'); // control positivo: el texto dibujado, ya inflado y decodificado
    expect(texto).toContain('QOX858');
    expect(sinCobro(texto)).toEqual([]);
    expect(tablasLeidas).not.toContain('flito_tramite_viajes_logistica');
  });
});
