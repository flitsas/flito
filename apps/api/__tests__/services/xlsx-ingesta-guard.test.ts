// Bug #11682 — los tres puntos de ingesta de `.xlsx` miden el archivo ANTES de abrirlo.
//
// El fallo no era teórico. Con un libro de 580 000 filas escrito por el propio ExcelJS —10 016 899
// bytes, POR DEBAJO del `limits.fileSize` de multer, MIME correcto y magic number legítimo, 122 MB
// descomprimidos por dentro— subido a las rutas reales de este repo:
//
//   · POST /api/vehicles/upload        32,5 s de event loop bloqueado, +2553 MB de heap
//   · POST /api/soat/batch-validate    26,5 s, +1925 MB … para contestar «Máximo 200 VINs por lote»
//   · POST /api/soat/upload-purchases  20,7 s, +1418 MB
//
// Con el heap a 512 MB las tres mataban el proceso con `FATAL ERROR: Ineffective mark-compacts near
// heap limit`, que ningún `try/catch` atrapa.
//
// ── Cómo se demuestra aquí que la medición va PRIMERO, sin cronómetros ni medir el heap ──────────
//
// Con un zip cuyo directorio central DECLARA una hoja de 200 MB pero cuyos datos son basura que no
// se puede inflar. Ese archivo tiene dos desenlaces posibles y son distinguibles:
//
//   · si se mide antes de abrirlo  → 413, «ocupa 200,0 MB por dentro y el máximo son …»
//   · si se abriera primero        → la petición NO responde nunca
//
// Ese segundo desenlace se midió mutando el orden, y conviene dejarlo escrito porque no es el que
// uno supondría: no sale un 500. ExcelJS delega en JSZip, que revienta con
// «Bug : uncompressed data size mismatch» desde un worker asíncrono, **fuera de la cadena de
// promesas** de la petición (`jszip/lib/compressedObject.js:38`). El error handler de Express nunca
// lo ve: llega como `Unhandled Rejection` y la petición se queda colgada. Aquí el test muere por
// `Test timed out in 10000ms`; en producción sería una conexión abierta y un handle filtrado — es
// decir, **peor de diagnosticar que un 500**, no mejor.
//
// El primer `describe` comprueba la premisa —que ExcelJS efectivamente no puede con ese buffer—, así
// que el 413 no puede venir de un parseo afortunado. No hay forma de que estas pruebas pasen si el
// orden se invierte: mueren por timeout en vez de por aserción, pero mueren.
//
// A propósito NO se mockea `shared/utils/excel.js` (como sí hacen soat/vehicles.routes.test.ts):
// el guardián vive ahí y mockearlo sería probar el mock.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import ExcelJS from 'exceljs';
import { testToken } from '../helpers/auth.js';
import { xlsxFalso } from '../helpers/zip-falso.js';
import { medirXlsx } from '../../src/shared/utils/xlsx-zip.js';
import { limitesXlsx, parseExcel, MIME_XLSX } from '../../src/shared/utils/excel.js';

const insertMock = vi.fn();
const transactionMock = vi.fn();
const selectMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: (...a: unknown[]) => selectMock(...a),
    insert: (...a: unknown[]) => insertMock(...a),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: (...a: unknown[]) => transactionMock(...a),
    execute: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  },
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));

const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));

const consultarRuntMock = vi.fn();
vi.mock('../../src/modules/runt/runt.service.js', () => ({ consultarVehiculoRunt: consultarRuntMock }));

vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn().mockResolvedValue(undefined), redisHealthy: vi.fn().mockResolvedValue(false),
}));

// El limitador de `batch-validate` (3 cada 5 min) tumbaría las pruebas a partir de la cuarta: no es
// lo que se prueba aquí y su store es de memoria compartida por archivo.
vi.mock('express-rate-limit', () => ({
  default: () => (_req: any, _res: any, next: any) => next(),
  ipKeyGenerator: (s: string) => s,
}));

/**
 * Declara 200 MB de hoja; los datos son basura que no se puede inflar. Es el archivo que separa
 * «se midió» de «se abrió»: ver la cabecera.
 */
const BOMBA = xlsxFalso({
  nombre: 'xl/worksheets/sheet1.xml',
  datos: Buffer.from('esto no es un flujo deflate'),
  crudo: true,
  declarado: 200 * 1024 * 1024,
});

/** Un xlsx legítimo y diminuto, para comprobar que el guardián no rechaza a todo el mundo. */
async function xlsxReal(cabecera: string[], filas: string[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Datos');
  ws.addRow(cabecera);
  for (const f of filas) ws.addRow(f);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function montar(modulo: string, base: string) {
  const app = express();
  const { default: router } = await import(modulo);
  app.use(base, router);
  return app;
}

async function subir(app: express.Express, ruta: string, buffer: Buffer, mime = MIME_XLSX) {
  const token = await testToken({ sub: 1, role: 'admin' });
  return request(app).post(ruta)
    .set('Authorization', `Bearer ${token}`)
    .attach('file', buffer, { filename: 'carga.xlsx', contentType: mime });
}

beforeEach(() => {
  insertMock.mockReset();
  transactionMock.mockReset();
  selectMock.mockReset();
  auditMock.mockClear();
  consultarRuntMock.mockReset();
});

describe('Bug #11682 · la premisa de la que cuelga todo lo demás', () => {
  it('la bomba ES un .xlsx por fuera y ExcelJS NO puede abrirla: un 413 solo puede venir de medirla sin abrirla', async () => {
    expect(BOMBA.subarray(0, 4).toString('hex')).toBe('504b0304'); // PK\x03\x04
    expect(BOMBA.length).toBeLessThan(4096); // pasa cualquier `limits.fileSize`
    await expect(new ExcelJS.Workbook().xlsx.load(BOMBA as unknown as ArrayBuffer)).rejects.toThrow();
  });

  it('medida por fuera declara los 200 MB, y eso cuesta microsegundos', async () => {
    const t0 = Date.now();
    const medida = await medirXlsx(BOMBA, limitesXlsx(6 * 1024 * 1024));
    expect(medida).toMatchObject({ estado: 'excede', segun: 'cabeceras' });
    expect(Date.now() - t0).toBeLessThan(100);
  });
});

describe('punto 1 · POST /api/vehicles/upload (carga masiva de vehículos)', () => {
  const montarVehiculos = () => montar('../../src/modules/vehicles/vehicles.routes.js', '/api/vehicles');

  it('la bomba se rechaza con 413 antes de abrir el libro, y no se inserta nada', async () => {
    const r = await subir(await montarVehiculos(), '/api/vehicles/upload', BOMBA);

    expect(r.status).toBe(413);
    // El techo de esta ruta, escrito a mano a propósito: si alguien mueve la constante, esto cae y
    // le obliga a rehacer el cálculo del comentario, no a actualizar un número contra sí mismo.
    expect(r.body.error).toContain('200,0 MB por dentro y el máximo son 6,0 MB');
    expect(insertMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('un xlsx legítimo sigue cargándose: el guardián no rechaza a todo el mundo', async () => {
    insertMock.mockReturnValue({
      values: () => ({ onConflictDoNothing: () => ({ returning: async () => [{ id: 1 }] }) }),
    });
    const libro = await xlsxReal(
      ['Numero de VIN', 'Numero de Placa', 'Marca de Vehiculo'],
      [['9BWZZZ377VT004251', 'ABC123', 'RENAULT'], ['9BWZZZ377VT004252', 'ABC124', 'MAZDA']],
    );

    const r = await subir(await montarVehiculos(), '/api/vehicles/upload', libro);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 2, inserted: 2 });
  });

  it('lo que no declara ser un .xlsx no llega ni al parser (fileFilter, que esta ruta no tenía)', async () => {
    const r = await subir(await montarVehiculos(), '/api/vehicles/upload', Buffer.from('vin,placa\n1,2'), 'text/csv');

    expect(r.status).toBe(400);
    // El mensaje distingue el rechazo de multer del de `medirXlsx`: sin `fileFilter` el csv llegaría
    // al guardián y saldría «No pudimos leer el archivo», que es otra cosa.
    expect(r.body.error).toBe('El archivo debe ser un .xlsx');
  });
});

describe('punto 2 · POST /api/soat/batch-validate (validación RUNT por lotes)', () => {
  const montarBatch = () => montar('../../src/modules/soat/batch.routes.js', '/api/soat');

  it('la bomba se rechaza con 413 antes de abrir el libro, y sin consultar RUNT', async () => {
    const r = await subir(await montarBatch(), '/api/soat/batch-validate', BOMBA);

    expect(r.status).toBe(413);
    expect(r.body).toMatchObject({ ok: false });
    expect(r.body.message).toContain('200,0 MB por dentro y el máximo son 2,0 MB');
    // Antes de este arreglo la respuesta llegaba —«Máximo 200 VINs por lote»— pero DESPUÉS de 26,5 s
    // y +1925 MB de heap. Que el mensaje sea otro es justo la señal de que ya no se abre el libro.
    expect(r.body.message).not.toContain('Máximo 200 VINs');
    expect(consultarRuntMock).not.toHaveBeenCalled();
  });

  it('el tope de 200 VINs sigue vivo para los archivos que sí caben', async () => {
    const filas = Array.from({ length: 250 }, (_, i) => [`9BWZZZ377VT00${String(i).padStart(4, '0')}`]);
    const libro = await xlsxReal(['Numero de VIN'], filas);
    expect((await medirXlsx(libro, limitesXlsx(2 * 1024 * 1024))).estado).toBe('ok');

    const r = await subir(await montarBatch(), '/api/soat/batch-validate', libro);

    expect(r.status).toBe(400);
    expect(r.body.message).toBe('Máximo 200 VINs por lote');
  });

  it('lo que no declara ser un .xlsx no llega ni al parser (fileFilter, que esta ruta no tenía)', async () => {
    const r = await subir(await montarBatch(), '/api/soat/batch-validate', Buffer.from('vin\n1'), 'text/csv');

    expect(r.status).toBe(400);
    expect(r.body.message).toBe('El archivo debe ser un .xlsx');
  });
});

describe('punto 3 · parseExcel y POST /api/soat/upload-purchases (carga masiva de compras)', () => {
  const montarSoat = () => montar('../../src/modules/soat/soat.routes.js', '/api/soat');

  it('parseExcel devuelve el rechazo en vez de abrir el libro', async () => {
    const r = await parseExcel(BOMBA, (row) => row.getCell(1).text, limitesXlsx(4 * 1024 * 1024));

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.rechazo).toMatchObject({ estado: 'excede', segun: 'cabeceras' });
  });

  it('la bomba se rechaza con 413 antes de abrir el libro, y sin tocar la transacción', async () => {
    const r = await subir(await montarSoat(), '/api/soat/upload-purchases', BOMBA);

    expect(r.status).toBe(413);
    expect(r.body.error).toContain('200,0 MB por dentro y el máximo son 4,0 MB');
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('un xlsx legítimo sigue cargándose: el guardián no rechaza a todo el mundo', async () => {
    transactionMock.mockResolvedValue({ updated: 0, notFound: 2 });
    const libro = await xlsxReal(
      ['Vin', 'Poliza', 'Aseguradora', 'Compra', 'Vence'],
      [
        ['9BWZZZ377VT004251', '1508007030291000', 'SEGUROS DEL ESTADO', '2026-01-15', '2027-01-15'],
        ['9BWZZZ377VT004252', '1508007030291001', 'SEGUROS DEL ESTADO', '2026-01-15', '2027-01-15'],
      ],
    );

    const r = await subir(await montarSoat(), '/api/soat/upload-purchases', libro);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 2, notFound: 2 });
  });

  it('la evidencia de compra sigue admitiendo PDF: el filtro de xlsx es de otro multer', async () => {
    // `PATCH /:id/purchase` comparte fichero con la carga de compras pero sube un soporte, no un
    // libro. Si el `fileFilter` se hubiera puesto en el multer compartido, esto sería un 400.
    selectMock.mockReturnValue({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    });
    const token = await testToken({ sub: 1, role: 'admin' });
    const r = await request(await montarSoat()).patch('/api/soat/1/purchase')
      .set('Authorization', `Bearer ${token}`)
      .field('policyNumber', '123')
      .attach('evidence', Buffer.from('%PDF-1.4 soporte'), { filename: 'soporte.pdf', contentType: 'application/pdf' });

    // 404 = la solicitud no existe (el mock devuelve []); lo que importa es que multer NO lo rechazó.
    expect(r.status).toBe(404);
  });
});

describe('los techos admiten el volumen real de cada flujo (el cálculo de los comentarios)', () => {
  /** El formato ancho de RUNT: 36 columnas. Es el que llega a vehículos y a batch. */
  const CAB_RUNT = Array.from({ length: 36 }, (_, i) => `col${i}`);
  CAB_RUNT[17] = 'Numero de VIN';
  const filaRunt = (i: number) => CAB_RUNT.map((_c, k) => (
    k === 17 ? `9BWZZZ377VT${String(i).padStart(6, '0')}` : `valor-${k}-${i}`
  ));

  it('6 MB en vehículos dan para ~2 500 filas del formato RUNT (36 columnas)', async () => {
    const libro = await xlsxReal(CAB_RUNT, Array.from({ length: 2500 }, (_, i) => filaRunt(i)));

    const medida = await medirXlsx(libro, limitesXlsx(6 * 1024 * 1024));
    expect(medida.estado).toBe('ok');
    // Y no por los pelos ni de sobra: entre 4 y 6 MB. Si el techo se quedara corto sería `excede`;
    // si estuviera holgadísimo, este rango lo delataría y habría que rehacer el cálculo.
    expect(medida.estado === 'ok' && medida.bytes).toBeLessThan(6 * 1024 * 1024);
    expect(medida.estado === 'ok' && medida.bytes).toBeGreaterThan(4 * 1024 * 1024);
  }, 60000);

  it('4 MB en compras dan para ~14 000 filas de su formato de 5 columnas', async () => {
    const filas = Array.from({ length: 14000 }, (_, i) => [
      `9BWZZZ377VT${String(i).padStart(6, '0')}`, `15080070302${i}`, 'SEGUROS DEL ESTADO', '2026-01-15', '2027-01-15',
    ]);
    const libro = await xlsxReal(['Vin', 'Poliza', 'Aseguradora', 'Compra', 'Vence'], filas);

    const medida = await medirXlsx(libro, limitesXlsx(4 * 1024 * 1024));
    expect(medida.estado).toBe('ok');
    expect(medida.estado === 'ok' && medida.bytes).toBeGreaterThan(2 * 1024 * 1024);
  }, 60000);

  it('2 MB en batch dan cuatro veces su tope de 200 VINs, incluso en formato RUNT', async () => {
    const libro = await xlsxReal(CAB_RUNT, Array.from({ length: 200 }, (_, i) => filaRunt(i)));

    const medida = await medirXlsx(libro, limitesXlsx(2 * 1024 * 1024));
    expect(medida.estado).toBe('ok');
    // 0,43 MB medidos: el techo es cuatro veces eso, para que al que se pasa por poco le siga
    // contestando «Máximo 200 VINs por lote» y no «archivo demasiado grande».
    expect(medida.estado === 'ok' && medida.bytes).toBeLessThan(512 * 1024);
  });
});
