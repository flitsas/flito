// TRAM-INNOV B4 — trámites en lote (CSV de flota).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
// OPS-02b r4: mock KEYED por tabla.
import { chain } from '../helpers/db.js';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken } from '../helpers/auth.js';

const computePreflightMock = vi.hoisted(() => vi.fn());

const kdb = createKeyedDb();
const { insert: insertMock, update: updateMock } = kdb;

vi.mock('../../src/db/client.js', () => ({
  // Proxy lazy → evita TDZ (lote.js se importa estáticamente y carga db/client).
  db: new Proxy({} as Record<string, unknown>, { get: (_t, prop) => Reflect.get(kdb.db as Record<string, unknown>, prop) }),
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/modules/tramites/preflight.js', () => ({
  computePreflight: computePreflightMock,
  getLatestPreflight: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

import { parseCsv, previewLote, confirmarLote, reprocesarErroresLote, exportResultadosCsv, listLotes, confirmarLoteDesdeCsv, iniciarLoteAsync, getLoteEstado, procesarLoteAsync, computeCsvSha256, normalizeCsvForHash, PLANTILLA_CSV, MAX_FILAS } from '../../src/modules/tramites/lote.js';

beforeEach(() => {
  kdb.reset(); computePreflightMock.mockReset();
  insertMock.mockReturnValue(chain([{ id: 1, vin: 'ABC123XYZ', placa: 'XYZ123' }]));
  updateMock.mockReturnValue({ set: () => ({ where: () => Promise.resolve([]) }) });
  computePreflightMock.mockResolvedValue({ overall: 'green', checks: [], id: 1, vin: 'X', placa: null, createdAt: '' });
});

describe('B4 · parseCsv', () => {
  it('CSV válido (separador coma) → filas parseadas con default flota_corporativa', () => {
    const r = parseCsv('vin,placa,tipologia_codigo\n9BWZZZ377VT004251,ABC123,\nKMHCT41DAFU123456,,sucesion');
    expect(r.ok).toBe(true);
    expect(r.filas).toHaveLength(2);
    expect(r.filas[0].vin).toBe('9BWZZZ377VT004251');
    expect(r.filas[0].tipologiaCodigo).toBe('flota_corporativa'); // default
    expect(r.filas[1].tipologiaCodigo).toBe('sucesion');
    expect(r.filas.every((f) => f.valido)).toBe(true);
  });

  it('detecta separador punto y coma', () => {
    const r = parseCsv('vin;placa\n9BWZZZ377VT004251;ABC123');
    expect(r.ok).toBe(true);
    expect(r.filas[0].placa).toBe('ABC123');
  });

  it('falta columna vin → error', () => {
    const r = parseCsv('placa,marca\nABC123,Mazda');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/vin/i);
  });

  it('fila con VIN vacío → marcada inválida', () => {
    const r = parseCsv('vin,placa\n,ABC123\n9BWZZZ377VT004251,XYZ');
    expect(r.ok).toBe(true);
    expect(r.filas[0].valido).toBe(false);
    expect(r.filas[1].valido).toBe(true);
  });

  it('más de MAX_FILAS → error', () => {
    const body = Array.from({ length: MAX_FILAS + 1 }, (_, i) => `VIN${i}000000000000`).join('\n');
    const r = parseCsv('vin\n' + body);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(new RegExp(String(MAX_FILAS)));
  });

  it('LOTE-PLUS: VIN duplicado dentro del archivo → 2ª fila inválida (conserva la 1ª)', () => {
    const r = parseCsv('vin,placa\n9BWZZZ377VT004251,ABC123\n9BWZZZ377VT004251,XYZ789\nKMHCT41DAFU123456,');
    expect(r.ok).toBe(true);
    expect(r.filas[0].valido).toBe(true);
    expect(r.filas[1].valido).toBe(false);
    expect(r.filas[1].error).toMatch(/duplicado/i);
    expect(r.filas[2].valido).toBe(true);
  });
});

describe('B4 · previewLote', () => {
  it('pre-vuelo por fila; inválidas sin preflight; resumen correcto', async () => {
    const parsed = parseCsv('vin,placa\n9BWZZZ377VT004251,ABC123\n,SINVIN');
    const preview = await previewLote(parsed.filas, 1);
    expect(preview.resumen).toEqual({ total: 2, validas: 1, errores: 1 });
    const valida = preview.filas.find((f) => f.valido)!;
    expect(valida.preflight?.overall).toBe('green');
    const invalida = preview.filas.find((f) => !f.valido)!;
    expect(invalida.preflight).toBeNull();
    expect(computePreflightMock).toHaveBeenCalledTimes(1); // solo la válida
  });
});

describe('TRAM-TIPO-02 · pre-vuelo lote sin vendedor si !vendedorRequerido', () => {
  it('importacion con vendedor_doc en CSV → NO consulta RUNT vendedor', async () => {
    const parsed = parseCsv('vin,tipologia_codigo,comprador_doc,vendedor_doc,vendedor_nombre\n9BWZZZ377VT004251,importacion,1020304050,80234517,Vend');
    await previewLote(parsed.filas, 1);
    const arg = computePreflightMock.mock.calls[0][0];
    expect(arg.vendedorDoc).toBeUndefined();
    expect(arg.vendedorNombre).toBeUndefined();
    expect(arg.compradorDoc).toBe('1020304050');
  });

  it('traspaso_standard con vendedor_doc → SÍ consulta RUNT vendedor', async () => {
    const parsed = parseCsv('vin,tipologia_codigo,comprador_doc,vendedor_doc,vendedor_nombre\n9BWZZZ377VT004251,traspaso_standard,1020304050,80234517,Vend');
    await previewLote(parsed.filas, 1);
    const arg = computePreflightMock.mock.calls[0][0];
    expect(arg.vendedorDoc).toBe('80234517');
  });
});

describe('LOTE-PLUS-02 · CSV comprador + LAFT', () => {
  it('parseCsv: lee comprador_doc (solo dígitos, máx 15) y comprador_nombre', () => {
    const r = parseCsv('vin,placa,comprador_doc,comprador_nombre\n9BWZZZ377VT004251,ABC,1.020.304-050,Empresa Flota SAS');
    expect(r.filas[0].compradorDoc).toBe('1020304050');
    expect(r.filas[0].compradorNombre).toBe('Empresa Flota SAS');
  });

  it('parseCsv: sin columnas comprador → undefined (sin regresión)', () => {
    const r = parseCsv('vin,placa\n9BWZZZ377VT004251,ABC');
    expect(r.filas[0].compradorDoc).toBeUndefined();
    expect(r.filas[0].compradorNombre).toBeUndefined();
  });

  it('previewLote pasa comprador a computePreflight e incluye laftComprador', async () => {
    computePreflightMock.mockResolvedValue({ overall: 'yellow', checks: [], laftComprador: { status: 'red', matches: 2, topSignal: null }, id: 1, vin: 'X', placa: null, createdAt: '' });
    const parsed = parseCsv('vin,comprador_doc,comprador_nombre\n9BWZZZ377VT004251,1020304050,Juan Perez');
    const preview = await previewLote(parsed.filas, 1);
    expect(computePreflightMock).toHaveBeenCalledWith(expect.objectContaining({ compradorDoc: '1020304050', compradorNombre: 'Juan Perez' }), 1);
    expect(preview.filas[0].preflight!.laftComprador).toEqual({ status: 'red', matches: 2 });
  });

  it('confirmarLote: crea trámite con comprador JSONB y guarda snapshot LAFT (last4) en la fila', async () => {
    const inserted: any[] = [];
    insertMock.mockImplementation(() => ({
      values: (v: any) => { inserted.push(v); return { returning: () => Promise.resolve([{ id: 1, vin: 'ABC123XYZ', placa: 'XYZ' }]) }; },
    }));
    await confirmarLote({ filas: [{ vin: '9BWZZZ377VT004251', placa: 'ABC123', compradorDoc: '1020304050', compradorNombre: 'Juan Perez', laftStatus: 'red', laftMatches: 2, preflightOverall: 'yellow', fila: 1 }] }, 7);
    // createTramite recibió comprador con doc completo (va al trámite)
    const tramiteIns = inserted.find((v) => v.comprador?.documento === '1020304050');
    expect(tramiteIns).toBeTruthy();
    expect(tramiteIns.comprador.nombre).toBe('Juan Perez');
    // la fila guarda SOLO last4 + estado LAFT (Ley 1581, sin cédula completa)
    const filaIns = inserted.find((v) => v.preflight?.compradorDocLast4);
    expect(filaIns.preflight.compradorDocLast4).toBe('4050');
    expect(filaIns.preflight.laftComprador).toEqual({ status: 'red', matches: 2 });
    expect(JSON.stringify(filaIns.preflight)).not.toContain('1020304050'); // sin cédula completa
  });

  it('exportResultadosCsv incluye columnas comprador_doc (last4) y laft_status', async () => {
    kdb.when.selectOnce('tramite_lotes', [{ id: 5, nombre: 'F', totalFilas: 1, ok: 1, errores: 0, estado: 'listo', createdAt: new Date('2026-06-05') }]);
    kdb.when.selectOnce('tramite_lote_filas', [{ fila: 1, vin: 'ABC123XYZ', placa: 'X', tipologiaCodigo: 'flota_corporativa', estado: 'ok', tramiteId: 1, preflight: { overall: 'yellow', laftComprador: { status: 'red', matches: 2 }, compradorDocLast4: '4050' }, errorMsg: null }]);
    const csv = await exportResultadosCsv(5);
    const lines = csv!.trim().split('\n');
    expect(lines[0]).toBe('fila,vin,placa,tipologia,estado,tramite_id,comprador_doc,vendedor_doc,laft_status,error_msg');
    expect(lines[1]).toContain('…4050');
    expect(lines[1]).toContain('red');
    expect(lines[1]).not.toContain('1020304050');
  });
});

describe('B4 · confirmarLote', () => {
  it('crea borradores y cuenta ok/errores', async () => {
    const r = await confirmarLote({
      nombre: 'Flota junio',
      filas: [
        { vin: '9BWZZZ377VT004251', placa: 'ABC123', tipologiaCodigo: 'flota_corporativa', fila: 1 },
        { vin: '', placa: 'SINVIN', fila: 2 }, // inválida
      ],
    }, 7);
    expect(r.loteId).toBe(1);
    expect(r.total).toBe(2);
    expect(r.ok).toBe(1);
    expect(r.errores).toBe(1);
    expect(updateMock).toHaveBeenCalled(); // actualiza ok/errores del lote
  });
});

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------
async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/tramites/tramites.routes.js');
  app.use('/api/tramites', router);
  return app;
}

describe('B4 · rutas', () => {
  it('GET /lote/plantilla.csv → CSV descargable', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/lote/plantilla.csv').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.text).toBe(PLANTILLA_CSV);
  });

  it('POST /lote/preview con CSV → semáforo por fila sin crear trámites', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const csv = 'vin,placa\n9BWZZZ377VT004251,ABC123';
    const r = await request(app).post('/api/tramites/lote/preview').set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from(csv), 'flota.csv');
    expect(r.status).toBe(200);
    expect(r.body.resumen.validas).toBe(1);
    expect(r.body.filas[0].preflight.overall).toBe('green');
  });

  it('POST /lote/preview sin archivo → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/lote/preview').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('POST /lote → 201 con conteo', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/lote').set('Authorization', `Bearer ${token}`)
      .send({ nombre: 'Flota', filas: [{ vin: '9BWZZZ377VT004251', placa: 'ABC123' }] });
    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(1);
    expect(r.body.loteId).toBe(1);
  });

  it('GET /lote/:id no encontrado → 404', async () => {
    kdb.when.selectOnce('tramite_lotes', []); // lote inexistente
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/lote/999').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(404);
  });
});

describe('LOTE-PLUS-03 · reprocesarErroresLote', () => {
  it('lote inexistente → null', async () => {
    kdb.when.selectOnce('tramite_lotes', []);
    expect(await reprocesarErroresLote(99, 1)).toBeNull();
  });

  it('reintenta filas en error con VIN; recupera; cuenta no-reintentables (sin VIN); recalcula totales', async () => {
    kdb.when.selectOnce('tramite_lotes', [{ id: 5 }]); // lote existe
    kdb.when.selectOnce('tramite_lote_filas', [
      { id: 10, fila: 1, vin: '9BWZZZ377VT004251', placa: 'ABC123', tipologiaCodigo: 'flota_corporativa', estado: 'error', errorMsg: 'transitorio' },
      { id: 11, fila: 2, vin: null, placa: 'SINVIN', tipologiaCodigo: 'flota_corporativa', estado: 'error', errorMsg: 'VIN vacío' },
    ]); // filas en error
    kdb.when.selectOnce('vehiculo_historial', []); // appendEventoSafe: último hash (genesis)
    kdb.when.selectOnce('tramite_lote_filas', [{ estado: 'ok' }, { estado: 'error' }]); // recompute totales
    const r = await reprocesarErroresLote(5, 7);
    expect(r).toEqual({ loteId: 5, reintentadas: 1, recuperadas: 1, noReintentables: 1, ok: 1, errores: 1 });
    expect(updateMock).toHaveBeenCalled(); // actualiza fila + totales del lote
  });
});

describe('LOTE-PLUS-03 · exportResultadosCsv', () => {
  it('lote inexistente → null', async () => {
    kdb.when.selectOnce('tramite_lotes', []);
    expect(await exportResultadosCsv(99)).toBeNull();
  });

  it('genera CSV con header + filas, escapando comas en error_msg', async () => {
    kdb.when.selectOnce('tramite_lotes', [{ id: 5, nombre: 'Flota', totalFilas: 2, ok: 1, errores: 1, estado: 'listo', createdAt: new Date('2026-06-05') }]);
    kdb.when.selectOnce('tramite_lote_filas', [
      { fila: 1, vin: 'ABC123XYZ', placa: 'XYZ123', tipologiaCodigo: 'flota_corporativa', estado: 'ok', tramiteId: 100, preflight: null, errorMsg: null },
      { fila: 2, vin: 'KMH456', placa: null, tipologiaCodigo: 'sucesion', estado: 'error', tramiteId: null, preflight: null, errorMsg: 'falló, motivo X' },
    ]);
    const csv = await exportResultadosCsv(5);
    expect(csv).not.toBeNull();
    const lines = csv!.trim().split('\n');
    expect(lines[0]).toBe('fila,vin,placa,tipologia,estado,tramite_id,comprador_doc,vendedor_doc,laft_status,error_msg');
    expect(lines[1]).toBe('1,ABC123XYZ,XYZ123,flota_corporativa,ok,100,,,,');
    expect(lines[2]).toContain('"falló, motivo X"'); // coma escapada con comillas
  });
});

describe('LOTE-PLUS-03 · rutas', () => {
  it('POST /lote/:id/reprocesar-errores rol transito → 403 (admin only)', async () => {
    const token = await testToken({ sub: 1, role: 'transito' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/lote/5/reprocesar-errores').set('Authorization', `Bearer ${token}`).send({});
    expect(r.status).toBe(403);
  });

  it('POST /lote/:id/reprocesar-errores admin, lote inexistente → 404', async () => {
    kdb.when.selectOnce('tramite_lotes', []); // lote no existe
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/lote/999/reprocesar-errores').set('Authorization', `Bearer ${token}`).send({});
    expect(r.status).toBe(404);
  });

  it('GET /lote/:id/resultados.csv admin → 200 text/csv', async () => {
    kdb.when.selectOnce('tramite_lotes', [{ id: 5, nombre: 'F', totalFilas: 1, ok: 1, errores: 0, estado: 'listo', createdAt: new Date('2026-06-05') }]);
    kdb.when.selectOnce('tramite_lote_filas', [{ fila: 1, vin: 'ABC123XYZ', placa: 'X', tipologiaCodigo: 'flota_corporativa', estado: 'ok', tramiteId: 1, preflight: null, errorMsg: null }]);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/lote/5/resultados.csv').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.text).toContain('fila,vin,placa,tipologia,estado,tramite_id,comprador_doc,vendedor_doc,laft_status,error_msg');
  });
});

describe('LOTE-PLUS-05 · vendedor CSV + idempotencia', () => {
  it('parseCsv: lee vendedor_doc y vendedor_nombre', () => {
    const r = parseCsv('vin,vendedor_doc,vendedor_nombre\n9BWZZZ377VT004251,80.123.456,Juan Perez');
    expect(r.filas[0].vendedorDoc).toBe('80123456');
    expect(r.filas[0].vendedorNombre).toBe('Juan Perez');
  });

  it('computeCsvSha256: estable tras normalizar BOM/CRLF', () => {
    const a = computeCsvSha256('vin\nABC\n');
    const b = computeCsvSha256('\uFEFFvin\r\nABC\r\n');
    expect(a).toBe(b);
    expect(normalizeCsvForHash('  x  ')).toBe('x');
  });

  it('iniciarLoteAsync: CSV duplicado → idempotente (mismo loteId)', async () => {
    const csv = 'vin,placa\n9BWZZZ377VT004251,ABC';
    kdb.when.selectOnce('tramite_lotes', [{
      id: 77, estado: 'listo', totalFilas: 1, ok: 1, errores: 0,
    }]);
    const r = await iniciarLoteAsync(csv, undefined, 7);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.loteId).toBe(77);
    expect(r.idempotente).toBe(true);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('confirmarLote: createTramite recibe vendedor cuando fila trae vendedorDoc', async () => {
    const inserted: any[] = [];
    insertMock.mockImplementation(() => ({
      values: (v: any) => { inserted.push(v); return { returning: () => Promise.resolve([{ id: 1, vin: 'ABC', placa: null }]) }; },
    }));
    await confirmarLote({
      filas: [{ vin: '9BWZZZ377VT004251', vendedorDoc: '80123456', vendedorNombre: 'Juan', fila: 1 }],
    }, 7);
    const tramiteIns = inserted.find((v) => (v.vehiculo as any)?._vendedor?.documento === '80123456');
    expect(tramiteIns).toBeTruthy();
  });
});

describe('LOTE-PLUS-04 · listLotes (historial)', () => {
  it('devuelve lotes paginados + total', async () => {
    kdb.when.selectOnce('tramite_lotes', [
      { id: 2, nombre: 'Flota jun', totalFilas: 50, ok: 48, errores: 2, estado: 'listo', createdAt: new Date('2026-06-05') },
      { id: 1, nombre: null, totalFilas: 3, ok: 3, errores: 0, estado: 'listo', createdAt: new Date('2026-06-04') },
    ]);
    kdb.when.selectOnce('tramite_lotes', [{ count: 2 }]);
    const r = await listLotes({ page: 1, limit: 20 });
    expect(r.total).toBe(2);
    expect(r.page).toBe(1);
    expect(r.items).toHaveLength(2);
    expect(r.items[0].id).toBe(2);
  });
});

describe('LOTE-PLUS-04 · confirmarLoteDesdeCsv (G4: fuente confiable)', () => {
  it('CSV inválido (sin columna vin) → ok:false', async () => {
    const r = await confirmarLoteDesdeCsv('placa,marca\nABC,Mazda', undefined, 1);
    expect(r.ok).toBe(false);
  });

  it('CSV sin filas válidas → ok:false', async () => {
    const r = await confirmarLoteDesdeCsv('vin\n,', undefined, 1); // VIN vacío
    expect(r.ok).toBe(false);
  });

  it('CSV válido → re-parsea, pre-vuela y crea (ok:true con conteo)', async () => {
    const r = await confirmarLoteDesdeCsv('vin,placa\n9BWZZZ377VT004251,ABC123', 'Flota', 7);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.loteId).toBe(1);
    expect(r.result.ok).toBe(1);
    expect(computePreflightMock).toHaveBeenCalled(); // re-pre-vuelo en servidor
  });
});

describe('LOTE-PLUS-04 · rutas', () => {
  it('GET /lote → 200 con lotes + total', async () => {
    kdb.when.selectOnce('tramite_lotes', [{ id: 1, nombre: 'F', totalFilas: 2, ok: 2, errores: 0, estado: 'listo', createdAt: new Date('2026-06-05') }]);
    kdb.when.selectOnce('tramite_lotes', [{ count: 1 }]);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/lote?page=1&limit=20').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
    expect(r.body.items[0].id).toBe(1);
  });

  it('POST /lote/confirm sin archivo → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/lote/confirm').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });

  it('POST /lote/confirm con CSV → 201 (servidor re-parsea y crea)', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/lote/confirm').set('Authorization', `Bearer ${token}`)
      .field('nombre', 'Flota servidor')
      .attach('file', Buffer.from('vin,placa\n9BWZZZ377VT004251,ABC123'), 'flota.csv');
    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(1);
    expect(r.body.loteId).toBe(1);
  });
});

describe('LOTE-PLUS-01 · iniciarLoteAsync + getLoteEstado', () => {
  it('CSV sin filas válidas → ok:false', async () => {
    const r = await iniciarLoteAsync('vin\n,', undefined, 1);
    expect(r.ok).toBe(false);
  });

  it('inicia lote en procesando con filas pendiente + errores de parseo', async () => {
    kdb.when.selectOnce('tramite_lotes', []); // sin duplicado idempotente
    const inserted: any[] = [];
    insertMock.mockImplementation(() => ({
      values: (v: any) => {
        inserted.push(v);
        const isLote = v.totalFilas != null && v.estado != null;
        return { returning: () => Promise.resolve([{ id: 42, ...(isLote ? {} : { vin: v.vin }) }]) };
      },
    }));
    const r = await iniciarLoteAsync('vin,placa\n9BWZZZ377VT004251,ABC\n,SINVIN', 'Async', 7);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.loteId).toBe(42);
    expect(r.estado).toBe('procesando');
    expect(r.totalFilas).toBe(2);
    const loteIns = inserted.find((v) => v.estado === 'procesando');
    expect(loteIns.errores).toBe(1);
    const pendiente = inserted.find((v) => v.estado === 'pendiente');
    expect(pendiente?.preflight?._pending).toBe(true);
    const errorFila = inserted.find((v) => v.estado === 'error');
    expect(errorFila).toBeTruthy();
  });

  it('getLoteEstado calcula pct y procesadas', async () => {
    kdb.when.selectOnce('tramite_lotes', [{ id: 9, totalFilas: 10, ok: 6, errores: 2, estado: 'procesando' }]);
    const st = await getLoteEstado(9);
    expect(st).toEqual({ loteId: 9, estado: 'procesando', totalFilas: 10, ok: 6, errores: 2, procesadas: 8, pct: 80 });
  });

  it('procesarLoteAsync: fila pendiente → ok y lote listo', async () => {
    kdb.when.selectOnce('tramite_lotes', [{ id: 42, estado: 'procesando', totalFilas: 1, ok: 0, errores: 0 }]);
    kdb.when.selectOnce('tramite_lote_filas', [{
      id: 100, loteId: 42, fila: 1, vin: '9BWZZZ377VT004251', placa: 'ABC123', tipologiaCodigo: 'flota_corporativa',
      estado: 'pendiente', preflight: { _pending: true }, tramiteId: null, errorMsg: null,
    }]);
    kdb.when.selectOnce('tramite_lote_filas', [{ estado: 'ok' }]); // recalc
    kdb.when.selectOnce('tramite_lote_filas', [{ estado: 'ok' }]); // recalc final
    await procesarLoteAsync(42, 7);
    expect(computePreflightMock).toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalled();
  });
});

describe('LOTE-PLUS-01 · rutas', () => {
  it('POST /lote/async con CSV → 202 procesando', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/lote/async').set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('vin,placa\n9BWZZZ377VT004251,ABC123'), 'flota.csv');
    expect(r.status).toBe(202);
    expect(r.body.estado).toBe('procesando');
    expect(r.body.loteId).toBe(1);
  });

  it('GET /lote/:id/estado → progreso', async () => {
    kdb.when.selectOnce('tramite_lotes', [{ id: 5, totalFilas: 4, ok: 2, errores: 1, estado: 'procesando' }]);
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).get('/api/tramites/lote/5/estado').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.pct).toBe(75);
    expect(r.body.procesadas).toBe(3);
  });

  it('POST /lote/async sin archivo → 400', async () => {
    const token = await testToken({ sub: 1, role: 'admin' });
    const app = await buildApp();
    const r = await request(app).post('/api/tramites/lote/async').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
  });
});
