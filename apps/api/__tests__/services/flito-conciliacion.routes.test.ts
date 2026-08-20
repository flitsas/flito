// FLITO Conciliación — fronteras HTTP de /api/flito/conciliacion (HU #11676, AC7, AC9, AC10, AC11).
//
// Aquí no se vuelve a probar el cruce (eso es `flito-conciliacion-cruce.test.ts`): lo que se afirma
// es QUIÉN entra, qué se rechaza en el borde antes de tocar la base, y qué rastro queda.
//
// El olfateo de magic-number (`checkMagicNumber` → `file-type`) NO se mockea: los adjuntos llevan
// bytes que de verdad son un .xlsx, generados con exceljs. Mockear el sniffer dejaría el test verde
// aunque la lista blanca estuviera mal enganchada, que es justo lo que el AC7 vino a cubrir.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import ExcelJS from 'exceljs';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { testToken, type TestRole } from '../helpers/auth.js';

const kdb = createKeyedDb();
const espia = crearEspia(kdb);

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
const auditMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
const piiMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: piiMock }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const COMPANIA = 3;
const BOLETA_ID = 'b0000000-0000-4000-8000-000000000001';
const SOAT_ID = '50a70000-0000-4000-8000-000000000001';
const AHORA = new Date('2026-08-20T15:00:00Z');
const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Un .xlsx de verdad, con la forma del reporte del portal. */
async function excelReal(filas: { poliza: string; total: number }[] = [{ poliza: 'P1', total: 740800 }]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Export');
  ws.addRow(['Número de Póliza', 'Nombre', 'Total a Pagar']);
  for (const f of filas) ws.addRow([f.poliza, 'PEREZ PEREZ, JUAN CARLOS', f.total]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Bytes que `file-type` reconoce como PDF real: sirve para probar que el .xlsx NO es cualquier cosa. */
const PDF_REAL = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0)]);

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-conciliacion/flito-conciliacion.routes.js');
  app.use('/api/flito/conciliacion', router);
  return app;
}

/**
 * Un usuario DISTINTO por llamada.
 *
 * No es cosmética: la carga lleva su propio `rateLimiter` de 10/min por usuario (AGENTS.md 18) con
 * store en memoria, así que un `sub` fijo haría que el undécimo test de este archivo recibiera un
 * 429 en vez de lo que está probando. Que el límite sea POR USUARIO es justo lo que permite esto.
 */
let siguienteUsuario = 100;
const auth = async (role: TestRole) =>
  `Bearer ${await testToken({ sub: (siguienteUsuario += 1), username: 'financiera@flit.io', role })}`;

function filaBoleta(over: Record<string, unknown> = {}) {
  return {
    id: BOLETA_ID,
    referencia: 'BOL-000123',
    companiaId: COMPANIA,
    concepto: 'soat',
    estado: 'cargada',
    archivoNombre: 'REPORTE SOAT.xlsx',
    filas: 1,
    totalDeclarado: '740800.00',
    totalCruzado: null,
    fechaPago: '2026-08-13',
    cargadaPorNombre: 'financiera@flit.io',
    conciliadaEn: null,
    conciliadaPorNombre: null,
    createdAt: AHORA,
    ...over,
  };
}

function filaLinea(over: Record<string, unknown> = {}) {
  return {
    id: '11110000-0000-4000-8000-000000000000',
    filaNumero: 1,
    numeroPolizaNorm: 'P1',
    valorDeclarado: '740800.00',
    soatId: SOAT_ID,
    resultado: 'ok',
    detalle: null,
    conciliadaEn: null,
    ...over,
  };
}

/** Escenario feliz de la carga: cliente, sin boleta previa con ese hash, y un SOAT que cuadra. */
function escenarioCargaOk(): void {
  kdb.when
    .select('clients', [{ id: COMPANIA, name: 'ACME S.A.S.' }])
    .select('flito_conciliacion_boletas', [])
    .select('flito_soat', [{
      id: SOAT_ID, numeroPoliza: 'P1', estado: 'pagado', valorPagado: '740800.00',
      companiaId: COMPANIA, companiaNombre: 'ACME S.A.S.', placa: 'ABC123',
    }])
    .select('flito_conciliacion_lineas', [])
    .select('flito_bolsa_movimientos', [])
    .insert('flito_conciliacion_boletas', [filaBoleta()])
    .insert('flito_conciliacion_lineas', [filaLinea()])
    .update('flito_conciliacion_boletas', []);
}

function postCarga(app: express.Express, token: string, buffer: Buffer, campos: Record<string, string> = {}) {
  const req = request(app).post('/api/flito/conciliacion/boletas').set('Authorization', token);
  for (const [k, v] of Object.entries({ companiaId: String(COMPANIA), fechaPago: '2026-08-13', ...campos })) {
    req.field(k, v);
  }
  return req;
}

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  auditMock.mockClear();
  piiMock.mockClear();
});

describe('flito-conciliacion · AC9 · solo admin y financiera', () => {
  const prohibidos: TestRole[] = ['proveedor', 'transito', 'auditor', 'gestor_impuestos', 'conductor'];

  for (const rol of prohibidos) {
    it(`403 para ${rol} en las seis rutas`, async () => {
      const app = await buildApp();
      const token = await auth(rol);
      const rutas: [string, string][] = [
        ['get', '/api/flito/conciliacion/boletas'],
        ['get', `/api/flito/conciliacion/boletas/${BOLETA_ID}`],
        ['post', `/api/flito/conciliacion/boletas/${BOLETA_ID}/recruzar`],
        ['post', `/api/flito/conciliacion/boletas/${BOLETA_ID}/descartar`],
        // HU #11677 AC8: la ruta que mueve el dinero, tras el mismo muro que las demás.
        ['post', `/api/flito/conciliacion/boletas/${BOLETA_ID}/conciliar`],
      ];
      for (const [metodo, ruta] of rutas) {
        const res = await (request(app) as never as Record<string, (r: string) => request.Test>)[metodo](ruta)
          .set('Authorization', token);
        expect(res.status, `${metodo} ${ruta}`).toBe(403);
      }
      const carga = await postCarga(app, token, await excelReal())
        .attach('archivo', await excelReal(), { filename: 'b.xlsx', contentType: MIME_XLSX });
      expect(carga.status).toBe(403);
      // Y nada llegó a la base: ni un INSERT ni un UPDATE. Ninguna bolsa se movió.
      expect(espia.inserts).toHaveLength(0);
      expect(espia.updates).toHaveLength(0);
    });
  }

  it('401 sin token', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/flito/conciliacion/boletas');
    expect(res.status).toBe(401);
  });

  it('financiera y admin sí entran', async () => {
    const app = await buildApp();
    for (const rol of ['admin', 'financiera'] as TestRole[]) {
      kdb.reset(); espia.reiniciar();
      kdb.when.select('flito_conciliacion_boletas', []);
      const res = await request(app).get('/api/flito/conciliacion/boletas').set('Authorization', await auth(rol));
      expect(res.status, rol).toBe(200);
    }
  });
});

describe('flito-conciliacion · AC1 · la carga responde con el cuadre resuelto', () => {
  it('201 con la boleta, sus líneas y el conteo por resultado', async () => {
    escenarioCargaOk();
    const app = await buildApp();
    const res = await postCarga(app, await auth('financiera'), await excelReal())
      .attach('archivo', await excelReal(), { filename: 'REPORTE SOAT.xlsx', contentType: MIME_XLSX });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: BOLETA_ID, referencia: 'BOL-000123', estado: 'cargada', filas: 1, sinCuadrar: 0,
    });
    expect(res.body.conteo).toMatchObject({ ok: 1, no_encontrada: 0 });
    expect(res.body.lineas).toHaveLength(1);
    expect(res.body.lineas[0]).toMatchObject({ resultado: 'ok', placa: 'ABC123', valorSoat: 740800 });
  });

  it('AC9 · deja bitácora de la carga, sin póliza ni placa en el detalle', async () => {
    escenarioCargaOk();
    const app = await buildApp();
    await postCarga(app, await auth('financiera'), await excelReal())
      .attach('archivo', await excelReal(), { filename: 'b.xlsx', contentType: MIME_XLSX });

    expect(auditMock).toHaveBeenCalledTimes(1);
    const entrada = auditMock.mock.calls[0][1];
    expect(entrada).toMatchObject({
      action: 'create', resource: 'flito_conciliacion_boleta', resourceId: BOLETA_ID,
    });
    expect(entrada.detail).toContain('BOL-000123');
    expect(entrada.detail).not.toContain('ABC123');
    expect(entrada.detail).not.toContain('P1');
  });

  it('AC10 · registra el acceso a PII porque la respuesta lleva póliza y placa', async () => {
    escenarioCargaOk();
    const app = await buildApp();
    await postCarga(app, await auth('financiera'), await excelReal())
      .attach('archivo', await excelReal(), { filename: 'b.xlsx', contentType: MIME_XLSX });

    expect(piiMock).toHaveBeenCalledTimes(1);
    const opts = piiMock.mock.calls[0][1];
    expect(opts).toMatchObject({
      resourceTipo: 'flito_conciliacion_boleta', accion: 'read',
      camposAccedidos: ['numero_poliza', 'placa'],
    });
    // El motivo lleva la REFERENCIA legible, no el uuid ni ninguna póliza.
    expect(opts.motivo).toContain('BOL-000123');
    expect(opts.motivo).not.toContain(BOLETA_ID);
  });

  it('AC11 · el nombre del titular no aparece en la respuesta ni en ningún rastro', async () => {
    escenarioCargaOk();
    const app = await buildApp();
    const res = await postCarga(app, await auth('financiera'), await excelReal())
      .attach('archivo', await excelReal(), { filename: 'b.xlsx', contentType: MIME_XLSX });

    expect(JSON.stringify(res.body)).not.toContain('PEREZ');
    expect(JSON.stringify(espia.inserts)).not.toContain('PEREZ');
    // Solo el segundo argumento: el primero es el `req` de Express, que es circular y no es lo que
    // se está afirmando.
    expect(JSON.stringify(auditMock.mock.calls.map((c) => c[1]))).not.toContain('PEREZ');
    expect(JSON.stringify(piiMock.mock.calls.map((c) => c[1]))).not.toContain('PEREZ');
  });
});

describe('flito-conciliacion · AC7 · lo que se rechaza en el borde', () => {
  it('400 si el MIME declarado no es el de un xlsx —y no llega a la base—', async () => {
    escenarioCargaOk();
    const app = await buildApp();
    const res = await postCarga(app, await auth('financiera'), PDF_REAL)
      .attach('archivo', PDF_REAL, { filename: 'boleta.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(400);
    expect(res.body.codigo).toBe('archivo_invalido');
    // El motivo lo escribimos nosotros: el content-type que mandó el cliente NO vuelve en la
    // respuesta. Devolverlo era hacerle de eco a una cadena ajena en un cuerpo que alguien pinta.
    expect(res.body.error).toBe('El archivo tiene que ser el .xlsx que descargas del portal.');
    expect(JSON.stringify(res.body)).not.toContain('application/pdf');
    expect(espia.inserts).toHaveLength(0);
  });

  it('400 si el CONTENIDO no es un xlsx aunque el MIME declarado lo diga (magic number)', async () => {
    escenarioCargaOk();
    const app = await buildApp();
    const res = await postCarga(app, await auth('financiera'), PDF_REAL)
      .attach('archivo', PDF_REAL, { filename: 'boleta.xlsx', contentType: MIME_XLSX });

    expect(res.status).toBe(400);
    expect(res.body.codigo).toBe('archivo_invalido');
    expect(espia.inserts).toHaveLength(0);
  });

  it('400 si el multipart trae una avalancha de campos: lo corta multer, no el schema', async () => {
    // Sin `limits.fields`/`parts`, busboy parsea los sesenta campos ENTEROS y los deja en
    // `req.body` antes de que `cargaSchema.strict()` diga que sobran. El tope los corta al vuelo.
    escenarioCargaOk();
    const app = await buildApp();
    const req = request(app).post('/api/flito/conciliacion/boletas')
      .set('Authorization', await auth('financiera'))
      .field('companiaId', String(COMPANIA))
      .field('fechaPago', '2026-08-13');
    for (let i = 0; i < 60; i += 1) req.field(`relleno${i}`, 'x');
    const res = await req.attach('archivo', await excelReal(), { filename: 'b.xlsx', contentType: MIME_XLSX });

    expect(res.status).toBe(400);
    expect(res.body.codigo).toBe('archivo_invalido');
    expect(res.body.error).toMatch(/demasiad/i);
    expect(espia.inserts).toHaveLength(0);
  });

  it('400 sin archivo', async () => {
    escenarioCargaOk();
    const app = await buildApp();
    const res = await postCarga(app, await auth('financiera'), Buffer.alloc(0));
    expect(res.status).toBe(400);
    expect(res.body.codigo).toBe('archivo_invalido');
  });

  it('400 con fecha de pago futura, y no queda ninguna boleta huérfana', async () => {
    escenarioCargaOk();
    const app = await buildApp();
    const res = await postCarga(app, await auth('financiera'), await excelReal(), { fechaPago: '2099-01-01' })
      .attach('archivo', await excelReal(), { filename: 'b.xlsx', contentType: MIME_XLSX });

    expect(res.status).toBe(400);
    expect(res.body.codigo).toBe('fecha_invalida');
    expect(espia.inserts).toHaveLength(0);
  });

  it('AC8 · 400 nombrando la columna que falta', async () => {
    escenarioCargaOk();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Export');
    ws.addRow(['Otra cosa', 'Nombre', 'Total a Pagar']);
    ws.addRow(['P1', 'X', 100]);
    const sinColumna = Buffer.from(await wb.xlsx.writeBuffer());

    const app = await buildApp();
    const res = await postCarga(app, await auth('financiera'), sinColumna)
      .attach('archivo', sinColumna, { filename: 'b.xlsx', contentType: MIME_XLSX });

    expect(res.status).toBe(400);
    expect(res.body.codigo).toBe('archivo_invalido');
    expect(res.body.error).toContain('Número de Póliza');
    expect(res.body.columnaFaltante).toBe('Número de Póliza');
    expect(espia.inserts).toHaveLength(0);
  });

  it('400 por encima del tope de filas, con el máximo dentro del cuerpo', async () => {
    escenarioCargaOk();
    const filas = Array.from({ length: 501 }, (_, i) => ({ poliza: `P${i}`, total: 100 }));
    const grande = await excelReal(filas);

    const app = await buildApp();
    const res = await postCarga(app, await auth('financiera'), grande)
      .attach('archivo', grande, { filename: 'b.xlsx', contentType: MIME_XLSX });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ codigo: 'demasiadas_filas', filas: 501, maximo: 500 });
    expect(espia.inserts).toHaveLength(0);
  });

  it('409 con el id de la boleta que ya tiene ese archivo, para poder llevar a ella', async () => {
    escenarioCargaOk();
    kdb.when.select('flito_conciliacion_boletas', [{ id: BOLETA_ID, referencia: 'BOL-000123' }]);
    const app = await buildApp();
    const res = await postCarga(app, await auth('financiera'), await excelReal())
      .attach('archivo', await excelReal(), { filename: 'b.xlsx', contentType: MIME_XLSX });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      codigo: 'boleta_duplicada', boletaId: BOLETA_ID, referencia: 'BOL-000123',
    });
  });
});

describe('flito-conciliacion · lectura de una boleta', () => {
  it('200 con el cuadre, y deja el registro de acceso a PII (AC10)', async () => {
    kdb.when
      .select('flito_conciliacion_boletas', [{ b: filaBoleta(), companiaNombre: 'ACME S.A.S.' }])
      .selectOnce('flito_conciliacion_lineas', [filaLinea()])
      .select('flito_conciliacion_lineas', [])
      .select('flito_soat', [{
        id: SOAT_ID, numeroPoliza: 'P1', estado: 'pagado', valorPagado: '740800.00',
        companiaId: COMPANIA, companiaNombre: 'ACME S.A.S.', placa: 'ABC123',
      }])
      .select('flito_bolsa_movimientos', []);

    const app = await buildApp();
    const res = await request(app).get(`/api/flito/conciliacion/boletas/${BOLETA_ID}`)
      .set('Authorization', await auth('admin'));

    expect(res.status).toBe(200);
    expect(res.body.lineas[0]).toMatchObject({ placa: 'ABC123', numeroPolizaNorm: 'P1' });
    expect(piiMock).toHaveBeenCalledTimes(1);
    expect(piiMock.mock.calls[0][1]).toMatchObject({ accion: 'read' });
  });

  it('404 si no existe, y 404 —no 500— si el id ni siquiera es un uuid', async () => {
    kdb.when.select('flito_conciliacion_boletas', []);
    const app = await buildApp();
    const token = await auth('admin');

    const noExiste = await request(app).get(`/api/flito/conciliacion/boletas/${BOLETA_ID}`).set('Authorization', token);
    expect(noExiste.status).toBe(404);
    expect(noExiste.body.codigo).toBe('boleta_no_existe');

    // Un id que no es uuid reventaría en PostgreSQL con un 22P02 (un 500) si llegara a la consulta.
    const basura = await request(app).get('/api/flito/conciliacion/boletas/no-soy-un-uuid').set('Authorization', token);
    expect(basura.status).toBe(404);
  });

  it('el listado NO devuelve póliza ni placa, y por eso no registra acceso a PII', async () => {
    kdb.when.select('flito_conciliacion_boletas', [{ b: filaBoleta(), companiaNombre: 'ACME S.A.S.' }]);
    const app = await buildApp();
    const res = await request(app).get('/api/flito/conciliacion/boletas?estado=cargada')
      .set('Authorization', await auth('financiera'));

    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({ referencia: 'BOL-000123', estado: 'cargada' });
    expect(JSON.stringify(res.body)).not.toContain('placa');
    expect(JSON.stringify(res.body)).not.toContain('numeroPoliza');
    expect(piiMock).not.toHaveBeenCalled();
  });

  it('AC10 · ni la póliza ni la placa se admiten como filtro de la query', async () => {
    kdb.when.select('flito_conciliacion_boletas', []);
    const app = await buildApp();
    const token = await auth('financiera');
    for (const query of ['poliza=1508007030296000', 'placa=ABC123', 'numeroPoliza=P1']) {
      const res = await request(app).get(`/api/flito/conciliacion/boletas?${query}`).set('Authorization', token);
      // El esquema es `.strict()`: una clave de más no se ignora en silencio, se rechaza.
      expect(res.status, query).toBe(400);
    }
  });
});

describe('flito-conciliacion · AC5 y AC6 · re-cruce y descarte por HTTP', () => {
  it('200 al re-cruzar una boleta cargada, con bitácora y registro de acceso', async () => {
    kdb.when
      .select('flito_conciliacion_boletas', [filaBoleta()])
      .selectOnce('flito_conciliacion_lineas', [filaLinea({ resultado: 'no_pagado', soatId: SOAT_ID })])
      .select('flito_conciliacion_lineas', [])
      .select('flito_soat', [{
        id: SOAT_ID, numeroPoliza: 'P1', estado: 'pagado', valorPagado: '740800.00',
        companiaId: COMPANIA, companiaNombre: 'ACME S.A.S.', placa: 'ABC123',
      }])
      .select('flito_bolsa_movimientos', [])
      .update('flito_conciliacion_lineas', [])
      .update('flito_conciliacion_boletas', []);
    kdb.when.select('clients', [{ nombre: 'ACME S.A.S.' }]);

    const app = await buildApp();
    const res = await request(app).post(`/api/flito/conciliacion/boletas/${BOLETA_ID}/recruzar`)
      .set('Authorization', await auth('financiera')).send({});

    expect(res.status).toBe(200);
    expect(res.body.lineas[0].resultado).toBe('ok');
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0][1]).toMatchObject({ action: 'update', resourceId: BOLETA_ID });
    expect(piiMock).toHaveBeenCalledTimes(1);
  });

  it('409 al re-cruzar una conciliada y 409 distinto al re-cruzar una descartada', async () => {
    const app = await buildApp();
    const token = await auth('financiera');

    kdb.when.select('flito_conciliacion_boletas', [filaBoleta({ estado: 'conciliada', conciliadaEn: AHORA })]);
    const conciliada = await request(app).post(`/api/flito/conciliacion/boletas/${BOLETA_ID}/recruzar`)
      .set('Authorization', token).send({});
    expect(conciliada.status).toBe(409);
    expect(conciliada.body.codigo).toBe('boleta_ya_conciliada');

    kdb.reset(); espia.reiniciar();
    kdb.when.select('flito_conciliacion_boletas', [filaBoleta({ estado: 'descartada' })]);
    const descartada = await request(app).post(`/api/flito/conciliacion/boletas/${BOLETA_ID}/recruzar`)
      .set('Authorization', token).send({});
    expect(descartada.status).toBe(409);
    expect(descartada.body.codigo).toBe('boleta_descartada');

    expect(auditMock).not.toHaveBeenCalled();
  });

  it('200 al descartar: estado descartada, bitácora, y sin registro de PII (no devuelve líneas)', async () => {
    kdb.when
      .select('flito_conciliacion_boletas', [filaBoleta()])
      .select('flito_conciliacion_lineas', [])
      .select('clients', [{ nombre: 'ACME S.A.S.' }])
      .update('flito_conciliacion_boletas', []);

    const app = await buildApp();
    const res = await request(app).post(`/api/flito/conciliacion/boletas/${BOLETA_ID}/descartar`)
      .set('Authorization', await auth('financiera')).send({});

    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('descartada');
    expect(res.body.lineas).toBeUndefined();
    expect(auditMock.mock.calls[0][1].detail).toContain('descartada');
    expect(piiMock).not.toHaveBeenCalled();
  });

  it('409 al descartar una boleta ya conciliada', async () => {
    kdb.when.select('flito_conciliacion_boletas', [filaBoleta({ estado: 'conciliada', conciliadaEn: AHORA })]);
    const app = await buildApp();
    const res = await request(app).post(`/api/flito/conciliacion/boletas/${BOLETA_ID}/descartar`)
      .set('Authorization', await auth('admin')).send({});
    expect(res.status).toBe(409);
    expect(res.body.codigo).toBe('boleta_ya_conciliada');
    expect(espia.updates).toHaveLength(0);
  });

  it('400 si alguien manda datos en el cuerpo de una acción que no los recibe', async () => {
    const app = await buildApp();
    const res = await request(app).post(`/api/flito/conciliacion/boletas/${BOLETA_ID}/descartar`)
      .set('Authorization', await auth('admin')).send({ motivo: 'me equivoqué' });
    expect(res.status).toBe(400);
  });
});

// ─────────────────── HU #11677 · la ruta que mueve el dinero ─────────────────
//
// El asiento en sí se prueba en `flito-conciliacion-conciliar.test.ts`, con los dos libros
// simulados. Aquí solo se afirma la FRONTERA: quién entra, qué código sale y qué rastro queda.

describe('flito-conciliacion · HU #11677 · POST /boletas/:id/conciliar', () => {
  const MOVIMIENTO_ID = 'aaaa1111-0000-4000-8000-000000000001';

  /** Escenario feliz: una boleta cargada con su única línea en `ok` y bolsa de cliente con saldo. */
  function escenarioConciliarOk(): void {
    kdb.when
      .select('flito_conciliacion_boletas', [filaBoleta()])
      // `selectOnce` para las líneas de ESTA boleta; el fallback vacío es la consulta de
      // `ya_conciliada`, que busca líneas de OTRAS boletas y aquí no hay ninguna.
      .selectOnce('flito_conciliacion_lineas', [filaLinea()])
      .select('flito_conciliacion_lineas', [])
      .select('flito_soat', [{
        id: SOAT_ID, numeroPoliza: 'P1', estado: 'pagado', valorPagado: '740800.00',
        companiaId: COMPANIA, companiaNombre: 'ACME S.A.S.', placa: 'ABC123',
        organismoCodigo: '05001',
      }])
      .select('clients', [{ nombre: 'ACME S.A.S.' }])
      .select('flito_bolsa_movimientos', [])
      .select('flito_bolsas', [{ id: 'bolsa-cliente', saldo: '5000000' }])
      .select('flito_bolsa_cierres', [])
      // Ninguna bolsa de tránsito cubre este par: la línea descuenta solo la del cliente.
      .select('flito_bolsa_transito_cobertura', [])
      .insert('flito_bolsa_movimientos', [{
        id: MOVIMIENTO_ID, companiaId: COMPANIA, tipo: 'salida', origen: 'conciliacion',
        concepto: 'soat', organismoCodigo: '05001', tramiteId: null, valor: '740800.00',
        saldoResultante: '4259200.00', periodo: '2026-07', fecha: '2026-08-13',
        observacion: 'Conciliación de la boleta BOL-000123', soporteId: null,
        registradoPorNombre: 'financiera@flit.io', createdAt: AHORA,
        llaveIdempotencia: `salida:soat:${SOAT_ID}`,
      }])
      .update('flito_bolsas', [])
      .update('flito_conciliacion_lineas', [])
      .update('flito_conciliacion_boletas', []);
  }

  it('200 con el resumen que necesita el aviso de éxito', async () => {
    escenarioConciliarOk();
    const app = await buildApp();
    const res = await request(app).post(`/api/flito/conciliacion/boletas/${BOLETA_ID}/conciliar`)
      .set('Authorization', await auth('financiera')).send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ soatConciliados: 1, totalConciliado: 740800, adoptados: [] });
    expect(res.body.cliente).toMatchObject({ companiaId: COMPANIA, descontado: 740800 });
    expect(res.body.boleta).toMatchObject({ estado: 'conciliada', referencia: 'BOL-000123' });
  });

  it('AC8 · deja bitácora con actor, boleta y total, sin póliza ni placa', async () => {
    escenarioConciliarOk();
    const app = await buildApp();
    await request(app).post(`/api/flito/conciliacion/boletas/${BOLETA_ID}/conciliar`)
      .set('Authorization', await auth('admin')).send({});

    expect(auditMock).toHaveBeenCalledTimes(1);
    const entrada = auditMock.mock.calls[0][1];
    expect(entrada).toMatchObject({
      action: 'update', resource: 'flito_conciliacion_boleta', resourceId: BOLETA_ID,
    });
    expect(entrada.detail).toContain('BOL-000123');
    expect(entrada.detail).toContain('740800');
    expect(entrada.detail).not.toContain('ABC123');
    expect(entrada.detail).not.toContain('P1');
  });

  it('registra el acceso a PII: la respuesta lleva las líneas con póliza y placa', async () => {
    escenarioConciliarOk();
    const app = await buildApp();
    await request(app).post(`/api/flito/conciliacion/boletas/${BOLETA_ID}/conciliar`)
      .set('Authorization', await auth('financiera')).send({});

    expect(piiMock).toHaveBeenCalledTimes(1);
    expect(piiMock.mock.calls[0][1]).toMatchObject({
      resourceTipo: 'flito_conciliacion_boleta', accion: 'read',
      camposAccedidos: ['numero_poliza', 'placa'],
    });
  });

  it('AC2 · 409 boleta_incompleta con el cuadre actualizado, y ninguna bolsa se mueve', async () => {
    kdb.when
      .select('flito_conciliacion_boletas', [filaBoleta()])
      .selectOnce('flito_conciliacion_lineas', [filaLinea()])
      .select('flito_conciliacion_lineas', [])
      .select('flito_soat', [{
        id: SOAT_ID, numeroPoliza: 'P1', estado: 'pendiente', valorPagado: '740800.00',
        companiaId: COMPANIA, companiaNombre: 'ACME S.A.S.', placa: 'ABC123',
        organismoCodigo: '05001',
      }])
      .select('clients', [{ nombre: 'ACME S.A.S.' }])
      .select('flito_bolsa_movimientos', [])
      .update('flito_conciliacion_lineas', [])
      .update('flito_conciliacion_boletas', []);

    const app = await buildApp();
    const res = await request(app).post(`/api/flito/conciliacion/boletas/${BOLETA_ID}/conciliar`)
      .set('Authorization', await auth('financiera')).send({});

    expect(res.status).toBe(409);
    expect(res.body.codigo).toBe('boleta_incompleta');
    expect(res.body.boleta.lineas[0].resultado).toBe('no_pagado');
    expect(espia.insertsEn('flito_bolsa_movimientos')).toHaveLength(0);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('AC6 · 409 boleta_ya_conciliada al pedirlo dos veces', async () => {
    kdb.when.select('flito_conciliacion_boletas',
      [filaBoleta({ estado: 'conciliada', conciliadaEn: AHORA, conciliadaPorNombre: 'laura' })]);

    const app = await buildApp();
    const res = await request(app).post(`/api/flito/conciliacion/boletas/${BOLETA_ID}/conciliar`)
      .set('Authorization', await auth('financiera')).send({});

    expect(res.status).toBe(409);
    expect(res.body.codigo).toBe('boleta_ya_conciliada');
    expect(espia.inserts).toHaveLength(0);
    expect(espia.updates).toHaveLength(0);
  });

  it('404 si el id del path no es un uuid: no se filtra si la boleta existe o no', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/flito/conciliacion/boletas/no-es-uuid/conciliar')
      .set('Authorization', await auth('financiera')).send({});
    expect(res.status).toBe(404);
    expect(res.body.codigo).toBe('boleta_no_existe');
  });

  it('400 si alguien manda datos en el cuerpo: conciliar no recibe importes', async () => {
    const app = await buildApp();
    const res = await request(app).post(`/api/flito/conciliacion/boletas/${BOLETA_ID}/conciliar`)
      .set('Authorization', await auth('admin')).send({ valor: 1 });
    expect(res.status).toBe(400);
    expect(espia.inserts).toHaveLength(0);
  });
});
