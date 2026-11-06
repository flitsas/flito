// Certificar sin trámite — frontera HTTP de /api/flito/impuestos/certificacion-directa (Épica #14163).
// Desarrollo local de pruebas, sin HU/Bug. Mocks: db (por tabla), storage, OCR, RUNT, auditoría PII.
// Se prueba el comportamiento real del servicio y las rutas; nada toca la BD, MinIO ni el RUNT.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { testToken, neutralizarEnlaceDe } from '../helpers/auth.js';
import { textoDelPdf } from '../helpers/texto-pdf.js';
import { audit } from '../../src/shared/middleware/audit.js';

neutralizarEnlaceDe('gestor_impuestos', 'conductor'); // mide la función, no el enlace

const kdb = createKeyedDb();
const FILA = 'flito_impuesto_certificacion_directa';
const ORG = 'organismos_transito_config';

vi.mock('../../src/db/client.js', () => ({
  db: kdb.db,
  getPoolStats: vi.fn().mockResolvedValue({ utilization: 0, total: 0, idle: 0, waiting: 0 }),
}));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const storage = vi.hoisted(() => ({
  upload: vi.fn(), remove: vi.fn(), stream: vi.fn(),
}));
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: (...a: unknown[]) => storage.upload(...a),
  removeEntityDocument: (...a: unknown[]) => storage.remove(...a),
  getEntityDocumentStream: (...a: unknown[]) => storage.stream(...a),
}));

const ocr = vi.hoisted(() => ({ extraer: vi.fn() }));
vi.mock('../../src/modules/flito-ocr/flito-ocr.service.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  extraerVehiculoFacturaVenta: (...a: unknown[]) => ocr.extraer(...a),
}));

const runt = vi.hoisted(() => ({ consultar: vi.fn() }));
vi.mock('../../src/modules/runt/runt.service.js', () => ({
  consultarVehiculoRunt: (...a: unknown[]) => runt.consultar(...a),
}));

const pii = vi.hoisted(() => ({ registrar: vi.fn() }));
vi.mock('../../src/modules/flito-impuestos/flito-impuestos.pii.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  registrarAccesoImpuesto: (...a: unknown[]) => pii.registrar(...a),
}));

const FN = 'impuestos.certificacion_directa.gestionar';
const ID = '71030cce-1a4c-4fb6-855d-fcc80aadc4e9';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF');

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-impuestos/flito-impuestos.routes.js');
  const { conAlcance } = await import('../../src/shared/middleware/frontera-enlace.js');
  app.use('/api/flito/impuestos', conAlcance('impuestos', router));
  return app;
}

let sub = 100;
/** Cada test usa su propio usuario: el limiter de /consultar cuenta por usuario y vive en memoria. */
const gestor = async (s = sub++) => `Bearer ${await testToken({ sub: s, username: 'gestor@flit.io', role: 'gestor_impuestos', funciones: [FN] })}`;
const sinFuncion = async () => `Bearer ${await testToken({ sub: sub++, username: 'cond@flit.io', role: 'conductor' })}`;

const BASE = '/api/flito/impuestos/certificacion-directa';

const datos = {
  organismoCodigo: '11001', placa: 'abc123', documentoPropietario: '900123456', tipoDocumentoPropietario: 'NIT', nombrePropietario: 'Empresa Prueba SAS',
  vin: '9ZZTEST0000000001', marca: 'KIA', linea: 'K3', anio: '2024', color: 'BLANCO', cilindrada: '1598',
};

function conCampos(r: request.Test, d: Record<string, string>): request.Test {
  for (const [k, v] of Object.entries(d)) r.field(k, v);
  return r;
}

const filaBd = (extra: Record<string, unknown> = {}) => ({
  id: ID, organismoCodigo: '11001', placa: 'ABC123', placaNorm: 'ABC123',
  documentoPropietario: '900123456', tipoDocumentoPropietario: 'NIT', nombrePropietario: 'Empresa Prueba SAS',
  vin: '9ZZTEST0000000001', vinNorm: '9ZZTEST0000000001', marca: 'KIA', linea: 'K3', anio: '2024',
  color: 'BLANCO', cilindrada: '1598', estado: 'radicado', comparacion: null, snapshot: null,
  facturaStorageKey: 'impuesto-certificacion-directa/x/factura.pdf', facturaBytes: 10,
  certificadoEn: null, certificadoPorId: null, certificadoPorNombre: null,
  createdAt: new Date('2026-10-30T10:00:00Z'), updatedAt: new Date('2026-10-30T10:00:00Z'),
  ...extra,
});

const runtOk = (v: Record<string, string> = {}) => ({
  ok: true,
  data: {
    vehiculo: { vin: datos.vin, marca: 'KIA', linea: 'K3', modelo: '2024', color: 'BLANCO', cilindraje: '1598', ...v },
    datosTecnicos: {},
  },
});

beforeEach(() => {
  kdb.reset();
  storage.upload.mockReset().mockResolvedValue('impuesto-certificacion-directa/x/factura.pdf');
  storage.remove.mockReset().mockResolvedValue(undefined);
  storage.stream.mockReset();
  ocr.extraer.mockReset();
  runt.consultar.mockReset();
  pii.registrar.mockReset().mockResolvedValue(undefined);
  kdb.when.select(ORG, [{ alias: 'Bogotá', codigo: '11001' }]);
});

describe('seguridad: token y función', () => {
  const rutas: [string, 'get' | 'post' | 'patch', string][] = [
    ['catálogo', 'get', '/catalogo'],
    ['extraer', 'post', '/extraer'],
    ['listado', 'get', ''],
    ['crear', 'post', ''],
    ['factura', 'get', `/${ID}/factura`],
    ['certificado', 'get', `/${ID}/certificado`],
    ['consultar', 'post', `/${ID}/consultar`],
    ['detalle', 'get', `/${ID}`],
    ['editar', 'patch', `/${ID}`],
  ];

  it.each(rutas)('%s: sin token es 401', async (_n, m, p) => {
    const r = await request(await buildApp())[m](BASE + p);
    expect(r.status).toBe(401);
  });

  it.each(rutas)('%s: con token pero sin la función gestionar es 403 y no toca datos', async (_n, m, p) => {
    const r = await request(await buildApp())[m](BASE + p).set('Authorization', await sinFuncion());
    expect(r.status).toBe(403);
    expect(r.body.funcion).toBe(FN);
    expect(kdb.insert).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
  });
});

describe('GET /catalogo', () => {
  it('devuelve organismos y no compañías', async () => {
    kdb.when.select(ORG, [{ codigo: '11001', alias: 'Bogotá' }, { codigo: '05001', alias: null }]);
    const r = await request(await buildApp()).get(`${BASE}/catalogo`).set('Authorization', await gestor());
    expect(r.status).toBe(200);
    expect(r.body.organismos).toEqual([{ codigo: '11001', nombre: 'Bogotá' }, { codigo: '05001', nombre: '05001' }]);
    expect(r.body).not.toHaveProperty('companias');
  });
});

describe('POST crear', () => {
  const crear = async (d: Record<string, string>, archivo: { buf: Buffer; mime: string } | null = { buf: PDF, mime: 'application/pdf' }) => {
    const req = request(await buildApp()).post(BASE).set('Authorization', await gestor());
    conCampos(req, d);
    if (archivo) req.attach('factura', archivo.buf, { filename: 'f.pdf', contentType: archivo.mime });
    return req;
  };

  it('factura válida y datos completos: 201, normaliza placa y la fila no trae compañía ni storage', async () => {
    kdb.when.insert(FILA, [filaBd()]);
    const r = await crear(datos);
    expect(r.status).toBe(201);
    expect(r.body.placa).toBe('ABC123');
    expect(r.body.estado).toBe('radicado');
    expect(r.body.organismoNombre).toBe('Bogotá');
    expect(r.body).not.toHaveProperty('companiaId');
    expect(r.body).not.toHaveProperty('companiaNombre');
    expect(r.body).not.toHaveProperty('facturaStorageKey');
    expect(storage.upload).toHaveBeenCalledTimes(1);
  });

  describe('propietario opcional', () => {
    const capturarValues = () => {
      const valores: Record<string, unknown>[] = [];
      kdb.insert.mockImplementation(() => {
        const t: Record<string, unknown> = {};
        t.values = (v: Record<string, unknown>) => { valores.push(v); return t; };
        t.returning = () => Promise.resolve([filaBd({ documentoPropietario: null, nombrePropietario: null })]);
        return t;
      });
      return valores;
    };

    it('sin los dos campos: 201, guarda null y la respuesta los trae en null', async () => {
      const valores = capturarValues();
      const { documentoPropietario: _d, nombrePropietario: _n, ...sinPropietario } = datos;
      const r = await crear(sinPropietario);
      expect(r.status).toBe(201);
      expect(valores[0]).toMatchObject({ documentoPropietario: null, nombrePropietario: null });
      expect(r.body.documentoPropietario).toBeNull();
      expect(r.body.nombrePropietario).toBeNull();
    });

    it.each([['vacíos', ''], ['con solo espacios', '   ']])('strings %s: guarda null', async (_n, v) => {
      const valores = capturarValues();
      const r = await crear({ ...datos, documentoPropietario: v, nombrePropietario: v });
      expect(r.status).toBe(201);
      expect(valores[0]).toMatchObject({ documentoPropietario: null, nombrePropietario: null });
    });

    it('son independientes: nombre sin documento conserva el nombre', async () => {
      const valores = capturarValues();
      const r = await crear({ ...datos, documentoPropietario: '', nombrePropietario: '  Ana Prueba ' });
      expect(r.status).toBe(201);
      expect(valores[0]).toMatchObject({ documentoPropietario: null, nombrePropietario: 'Ana Prueba' });
    });

    describe('tipo de documento (Bug #14406: la pasarela RUNT exige el código)', () => {
      it('con documento y tipo: lo guarda y la respuesta lo trae', async () => {
        const valores: Record<string, unknown>[] = [];
        kdb.insert.mockImplementation(() => {
          const t: Record<string, unknown> = {};
          t.values = (v: Record<string, unknown>) => { valores.push(v); return t; };
          t.returning = () => Promise.resolve([filaBd({ tipoDocumentoPropietario: 'CC' })]);
          return t;
        });
        const r = await crear({ ...datos, tipoDocumentoPropietario: 'CC' });
        expect(r.status).toBe(201);
        expect(valores[0]).toMatchObject({ documentoPropietario: '900123456', tipoDocumentoPropietario: 'CC' });
        expect(r.body.tipoDocumentoPropietario).toBe('CC');
      });

      it.each([['ausente', undefined], ['vacío', ''], ['con solo espacios', '  ']])(
        'documento con tipo %s: 400 con el mensaje del campo y no sube la factura', async (_n, tipo) => {
          const { tipoDocumentoPropietario: _t, ...sinTipo } = datos;
          const r = await crear(tipo === undefined ? sinTipo : { ...sinTipo, tipoDocumentoPropietario: tipo });
          expect(r.status).toBe(400);
          expect(r.body.error).toBe('Falta el tipo de documento del propietario');
          expect(storage.upload).not.toHaveBeenCalled();
          expect(kdb.insert).not.toHaveBeenCalled();
        },
      );

      it('sin documento, el tipo que llegue se guarda null: no hay nada que tipificar', async () => {
        const valores = capturarValues();
        const r = await crear({ ...datos, documentoPropietario: '  ', tipoDocumentoPropietario: 'NIT' });
        expect(r.status).toBe(201);
        expect(valores[0]).toMatchObject({ documentoPropietario: null, tipoDocumentoPropietario: null });
      });

      it('sin documento y sin tipo: 201, tipo null', async () => {
        const valores = capturarValues();
        const { documentoPropietario: _d, tipoDocumentoPropietario: _t, ...sinNada } = datos;
        const r = await crear(sinNada);
        expect(r.status).toBe(201);
        expect(valores[0]).toMatchObject({ tipoDocumentoPropietario: null });
      });

      it.each(['N', 'XX', 'nit'])('tipo %s, fuera del catálogo: 400 y no sube la factura', async (tipo) => {
        const r = await crear({ ...datos, tipoDocumentoPropietario: tipo });
        expect(r.status).toBe(400);
        expect(storage.upload).not.toHaveBeenCalled();
      });
    });

    it('un documento de más de 30 caracteres sigue siendo 400', async () => {
      const r = await crear({ ...datos, documentoPropietario: '1'.repeat(31) });
      expect(r.status).toBe(400);
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('un nombre de más de 200 caracteres sigue siendo 400', async () => {
      const r = await crear({ ...datos, nombrePropietario: 'a'.repeat(201) });
      expect(r.status).toBe(400);
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it.each(['placa', 'vin'] as const)('%s sigue siendo obligatorio', async (campo) => {
      const r = await crear({ ...datos, [campo]: '' });
      expect(r.status).toBe(400);
      expect(storage.upload).not.toHaveBeenCalled();
    });
  });

  it('sin organismo es 400 y no guarda la factura', async () => {
    const { organismoCodigo: _o, ...sinOrg } = datos;
    const r = await crear(sinOrg);
    expect(r.status).toBe(400);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('organismo inexistente es 400', async () => {
    kdb.when.select(ORG, []);
    const r = await crear(datos);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('El organismo de tránsito no existe');
  });

  it('texto con MIME application/pdf que no es PDF es 400 «La factura de venta debe ser un PDF»', async () => {
    const r = await crear(datos, { buf: Buffer.from('esto no es un pdf'), mime: 'application/pdf' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('La factura de venta debe ser un PDF');
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('MIME que no es PDF es 400 «La factura de venta debe ser un PDF»', async () => {
    const r = await crear(datos, { buf: PDF, mime: 'image/png' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('La factura de venta debe ser un PDF');
  });

  it('archivo de más de 15 MB es 400 «El archivo supera el tamaño máximo permitido»', async () => {
    const grande = Buffer.concat([PDF, Buffer.alloc(15 * 1024 * 1024)]);
    const r = await crear(datos, { buf: grande, mime: 'application/pdf' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('El archivo supera el tamaño máximo permitido');
  });

  it('sin factura es 400', async () => {
    const r = await crear(datos, null);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Falta la factura de venta');
  });

  it('VIN ya certificado es 409 y no sube la factura', async () => {
    kdb.when.select(FILA, [{ vin: '9ZZTEST0000000001', placa: 'OTRA99' }]);
    const r = await crear(datos);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('Ya existe una certificación para este VIN');
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('placa ya certificada es 409', async () => {
    kdb.when.select(FILA, [{ vin: 'OTROVIN12345', placa: 'ABC123' }]);
    const r = await crear(datos);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('Ya existe una certificación para esta placa');
  });

  it('VIN y placa ya certificados: mensaje de ambos', async () => {
    kdb.when.select(FILA, [{ vin: '9ZZTEST0000000001', placa: 'ABC123' }]);
    const r = await crear(datos);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('Ya existe una certificación para este VIN y esta placa');
  });

  it('carrera contra el índice único: 409 y se borra la factura recién subida', async () => {
    kdb.when.insert(FILA, () => { throw Object.assign(new Error('dup'), { code: '23505' }); });
    const r = await crear(datos);
    expect(r.status).toBe(409);
    expect(storage.remove).toHaveBeenCalledTimes(1);
  });
});

describe('POST /extraer', () => {
  const extraer = async (buf: Buffer, mime = 'application/pdf') =>
    request(await buildApp()).post(`${BASE}/extraer`).set('Authorization', await gestor())
      .attach('factura', buf, { filename: 'f.pdf', contentType: mime });

  it('PDF válido devuelve vin, marca, línea, año, color y cilindrada, sin aviso', async () => {
    const c = (valor: string) => ({ valor, confianza: 0.99, confiable: true });
    ocr.extraer.mockResolvedValue({
      vin: c('9ZZTEST0000000001'), marca: c('KIA'), linea: c('K3'), anioVehiculo: c('2024'),
      color: c('BLANCO'), cilindrada: c('1598'),
    });
    const r = await extraer(PDF);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      vin: '9ZZTEST0000000001', marca: 'KIA', linea: 'K3', anio: '2024', color: 'BLANCO', cilindrada: '1598', aviso: null,
    });
  });

  it('lectura sin ningún dato: devuelve vacíos con aviso', async () => {
    const v = { valor: '', confianza: 0, confiable: false };
    ocr.extraer.mockResolvedValue({ vin: v, marca: v, linea: v, anioVehiculo: v, color: v, cilindrada: v });
    const r = await extraer(PDF);
    expect(r.status).toBe(200);
    expect(r.body.vin).toBe('');
    expect(r.body.aviso).toBe('No se pudo leer la factura. Completa los datos del vehículo.');
  });

  it('OCR no disponible: 200 con campos vacíos y aviso, no rompe', async () => {
    const { OcrNoDisponibleError } = await import('../../src/modules/flito-ocr/flito-ocr.service.js');
    ocr.extraer.mockRejectedValue(new OcrNoDisponibleError('sin motor'));
    const r = await extraer(PDF);
    expect(r.status).toBe(200);
    expect(r.body.marca).toBe('');
    expect(r.body.aviso).toBe('No se pudo leer la factura. Completa los datos del vehículo.');
  });

  it('archivo que no es PDF es 400 y no llama al OCR', async () => {
    const r = await extraer(Buffer.from('texto plano'));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('La factura de venta debe ser un PDF');
    expect(ocr.extraer).not.toHaveBeenCalled();
  });
});

describe('PATCH editar', () => {
  const editar = async (d: Record<string, string>, archivo: Buffer | null = null) => {
    const req = request(await buildApp()).patch(`${BASE}/${ID}`).set('Authorization', await gestor());
    conCampos(req, d);
    if (archivo) req.attach('factura', archivo, { filename: 'f.pdf', contentType: 'application/pdf' });
    return req;
  };
  const sets = () => kdb.update.mock.results.length;

  it('cambiar datos sin archivo conserva la factura y no sube ni borra nada', async () => {
    kdb.when.selectOnce(FILA, [filaBd({ estado: 'sin_coincidencia' })]).select(FILA, []); // 1.º cargar; luego «sin duplicado» (la BD excluye el propio id)
    kdb.when.update(FILA, [filaBd({ marca: 'MAZDA', estado: 'radicado' })]);
    const r = await editar({ ...datos, marca: 'MAZDA' });
    expect(r.status).toBe(200);
    expect(r.body.marca).toBe('MAZDA');
    expect(r.body.estado).toBe('radicado');
    expect(storage.upload).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
    expect(sets()).toBe(1);
  });

  it('reemplazar la factura sube la nueva, borra la anterior y el estado vuelve a radicado', async () => {
    kdb.when.selectOnce(FILA, [filaBd({ estado: 'sin_respuesta' })]).select(FILA, []); // 1.º cargar; luego «sin duplicado» (la BD excluye el propio id)
    kdb.when.update(FILA, [filaBd({ estado: 'radicado', facturaStorageKey: 'nueva' })]);
    storage.upload.mockResolvedValue('nueva');
    const r = await editar(datos, PDF);
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('radicado');
    expect(storage.upload).toHaveBeenCalledTimes(1);
    expect(storage.remove).toHaveBeenCalledWith('impuesto-certificacion-directa/x/factura.pdf');
  });

  it('borrar el documento y el nombre guarda null, para poder volver a consultar por VIN', async () => {
    kdb.when.selectOnce(FILA, [filaBd({ estado: 'sin_vehiculo' })]).select(FILA, []);
    const sets: Record<string, unknown>[] = [];
    kdb.update.mockImplementation(() => {
      const t: Record<string, unknown> = {};
      t.set = (v: Record<string, unknown>) => { sets.push(v); return t; };
      t.where = () => t;
      t.returning = () => Promise.resolve([filaBd({ documentoPropietario: null, nombrePropietario: null })]);
      return t;
    });
    const r = await editar({ ...datos, documentoPropietario: '', nombrePropietario: '  ' });
    expect(r.status).toBe(200);
    expect(sets[0]).toMatchObject({ documentoPropietario: null, nombrePropietario: null, estado: 'radicado' });
    expect(r.body.documentoPropietario).toBeNull();
  });

  it('corregir el tipo de un registro anterior lo guarda', async () => {
    kdb.when.selectOnce(FILA, [filaBd({ tipoDocumentoPropietario: null })]).select(FILA, []);
    const sets: Record<string, unknown>[] = [];
    kdb.update.mockImplementation(() => {
      const t: Record<string, unknown> = {};
      t.set = (v: Record<string, unknown>) => { sets.push(v); return t; };
      t.where = () => t;
      t.returning = () => Promise.resolve([filaBd({ tipoDocumentoPropietario: 'CE' })]);
      return t;
    });
    const r = await editar({ ...datos, tipoDocumentoPropietario: 'CE' });
    expect(r.status).toBe(200);
    expect(sets[0]).toMatchObject({ tipoDocumentoPropietario: 'CE' });
    expect(r.body.tipoDocumentoPropietario).toBe('CE');
  });

  it('borrar el documento borra también el tipo aunque llegue', async () => {
    kdb.when.selectOnce(FILA, [filaBd()]).select(FILA, []);
    const sets: Record<string, unknown>[] = [];
    kdb.update.mockImplementation(() => {
      const t: Record<string, unknown> = {};
      t.set = (v: Record<string, unknown>) => { sets.push(v); return t; };
      t.where = () => t;
      t.returning = () => Promise.resolve([filaBd({ documentoPropietario: null, tipoDocumentoPropietario: null })]);
      return t;
    });
    const r = await editar({ ...datos, documentoPropietario: '', tipoDocumentoPropietario: 'NIT' });
    expect(r.status).toBe(200);
    expect(sets[0]).toMatchObject({ documentoPropietario: null, tipoDocumentoPropietario: null });
  });

  it('documento sin tipo: 400 con el mensaje del campo y el registro no cambia', async () => {
    const { tipoDocumentoPropietario: _t, ...sinTipo } = datos;
    const r = await editar(sinTipo);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Falta el tipo de documento del propietario');
    expect(kdb.update).not.toHaveBeenCalled();
  });

  it('tipo fuera del catálogo: 400 y el registro no cambia', async () => {
    const r = await editar({ ...datos, tipoDocumentoPropietario: 'XX' });
    expect(r.status).toBe(400);
    expect(kdb.update).not.toHaveBeenCalled();
  });

  it('un registro certificado no se edita: 409', async () => {
    kdb.when.select(FILA, [filaBd({ estado: 'certificado' })]); // 1.º cargar; luego «sin duplicado» (la BD excluye el propio id)
    const r = await editar(datos);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('Este registro ya está certificado');
    expect(kdb.update).not.toHaveBeenCalled();
  });

  it('registro inexistente: 404', async () => {
    kdb.when.select(FILA, []);
    const r = await editar(datos);
    expect(r.status).toBe(404);
  });

  it('reemplazo con un archivo que no es PDF: 400 y el registro no cambia', async () => {
    kdb.when.selectOnce(FILA, [filaBd()]).select(FILA, []); // 1.º cargar; luego «sin duplicado» (la BD excluye el propio id)
    const r = await editar(datos, Buffer.from('no es pdf'));
    expect(r.status).toBe(400);
    expect(kdb.update).not.toHaveBeenCalled();
  });
});

describe('POST /:id/consultar', () => {
  const consultar = async (s?: number) =>
    request(await buildApp()).post(`${BASE}/${ID}/consultar`).set('Authorization', await gestor(s));

  /** 1.º select: cargar la fila; los siguientes: «sin duplicado» (la BD filtra por estado y excluye el propio id). */
  const filaSinDuplicado = (extra: Record<string, unknown> = {}) => {
    kdb.when.selectOnce(FILA, [filaBd(extra)]).select(FILA, []);
  };

  /** El UPDATE que escribe el servicio, para comprobar lo que queda en la fila y no solo la respuesta. */
  const capturarSets = (estado: string) => {
    const sets: Record<string, unknown>[] = [];
    kdb.update.mockImplementation(() => {
      const t: Record<string, unknown> = {};
      t.set = (v: Record<string, unknown>) => { sets.push(v); return t; };
      t.where = () => t;
      t.returning = () => Promise.resolve([filaBd({ estado })]);
      return t;
    });
    return sets;
  };

  it('con documento consulta por placa y documento, sin VIN, y certifica cuando los seis campos coinciden', async () => {
    filaSinDuplicado();
    kdb.when.update(FILA, [filaBd({ estado: 'certificado', certificadoEn: new Date('2026-10-30T12:00:00Z'), certificadoPorNombre: 'gestor@flit.io' })]);
    runt.consultar.mockResolvedValue(runtOk());
    const r = await consultar();
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('certificado');
    expect(r.body.certificadoEn).toBe('2026-10-30T12:00:00.000Z');
    expect(runt.consultar).toHaveBeenCalledTimes(1);
    expect(runt.consultar).toHaveBeenCalledWith('ABC123', undefined, '900123456', 'N');
    expect(kdb.update).toHaveBeenCalledTimes(1);
  });

  it('sin documento ni nombre consulta solo por VIN y certifica cuando los seis campos coinciden', async () => {
    filaSinDuplicado({ documentoPropietario: null, nombrePropietario: null });
    const sets = capturarSets('certificado');
    runt.consultar.mockResolvedValue(runtOk());
    const r = await consultar();
    expect(r.status).toBe(200);
    expect(sets[0]).toMatchObject({ estado: 'certificado' });
    expect(runt.consultar).toHaveBeenCalledTimes(1);
    expect(runt.consultar).toHaveBeenCalledWith(undefined, '9ZZTEST0000000001');
  });

  it('nombre sin documento consulta solo por VIN: decide el documento', async () => {
    filaSinDuplicado({ documentoPropietario: null });
    capturarSets('certificado');
    runt.consultar.mockResolvedValue(runtOk());
    await consultar();
    expect(runt.consultar).toHaveBeenCalledTimes(1);
    expect(runt.consultar).toHaveBeenCalledWith(undefined, '9ZZTEST0000000001');
  });

  it('documento sin nombre consulta por placa y documento: decide el documento', async () => {
    filaSinDuplicado({ nombrePropietario: null });
    capturarSets('certificado');
    runt.consultar.mockResolvedValue(runtOk());
    await consultar();
    expect(runt.consultar).toHaveBeenCalledWith('ABC123', undefined, '900123456', 'N');
  });

  it.each([
    ['NIT', 'N'], ['CC', 'C'], ['CE', 'E'], ['TI', 'T'], ['PAS', 'P'], ['PPT', 'Y'], ['RC', 'R'], ['PT', 'PT'],
  ])('tipo %s del formulario viaja al RUNT como el código %s', async (tipo, codigo) => {
    filaSinDuplicado({ tipoDocumentoPropietario: tipo });
    capturarSets('certificado');
    runt.consultar.mockResolvedValue(runtOk());
    const r = await consultar();
    expect(r.status).toBe(200);
    expect(runt.consultar).toHaveBeenCalledTimes(1);
    expect(runt.consultar).toHaveBeenCalledWith('ABC123', undefined, '900123456', codigo);
  });

  it.each<[string, string | null]>([
    ['sin tipo (anterior a esta corrección)', null],
    ['con un tipo que no mapea al RUNT', 'XX'],
  ])('registro con documento %s: 400 sin enviar nada al RUNT, sin escribir y sin auditar', async (_n, tipo) => {
    vi.mocked(audit).mockClear();
    filaSinDuplicado({ tipoDocumentoPropietario: tipo });
    const r = await consultar();
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Falta el tipo de documento del propietario');
    expect(runt.consultar).not.toHaveBeenCalled();
    expect(kdb.update).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('registro anterior sin documento ni tipo: sigue consultando por VIN', async () => {
    filaSinDuplicado({ documentoPropietario: null, tipoDocumentoPropietario: null });
    capturarSets('certificado');
    runt.consultar.mockResolvedValue(runtOk());
    const r = await consultar();
    expect(r.status).toBe(200);
    expect(runt.consultar).toHaveBeenCalledWith(undefined, '9ZZTEST0000000001');
  });

  it('un registro ya duplicado responde 409 antes de exigir el tipo', async () => {
    kdb.when.selectOnce(FILA, [filaBd({ tipoDocumentoPropietario: null })]).select(FILA, [{ vin: '9ZZTEST0000000001', placa: 'OTRA99' }]);
    const r = await consultar();
    expect(r.status).toBe(409);
    expect(runt.consultar).not.toHaveBeenCalled();
  });

  it('el snapshot congela la modalidad usada, porque el PDF se rearma al descargar', async () => {
    filaSinDuplicado();
    const conDoc = capturarSets('certificado');
    runt.consultar.mockResolvedValue(runtOk());
    await consultar();
    expect(conDoc[0]!.snapshot).toMatchObject({ modalidadConsulta: 'placa_documento' });

    filaSinDuplicado({ documentoPropietario: null });
    const sinDoc = capturarSets('certificado');
    await consultar();
    expect(sinDoc[0]!.snapshot).toMatchObject({ modalidadConsulta: 'vin' });
  });

  it('rechazo del RUNT con documento: una sola llamada, no cae a VIN, queda sin_vehiculo y no certifica', async () => {
    filaSinDuplicado();
    const sets = capturarSets('sin_vehiculo');
    runt.consultar.mockResolvedValue({
      ok: false, message: 'Los datos no corresponden con los propietarios activos del vehículo', httpStatus: 200,
    });
    const r = await consultar();
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('sin_vehiculo');
    expect(runt.consultar).toHaveBeenCalledTimes(1);
    expect(runt.consultar).toHaveBeenCalledWith('ABC123', undefined, '900123456', 'N');
    expect(sets[0]).toMatchObject({ estado: 'sin_vehiculo', comparacion: null });
    expect(sets[0]).not.toHaveProperty('snapshot');
    expect(sets[0]).not.toHaveProperty('certificadoEn');
  });

  it('el RUNT no responde con documento: una sola llamada, no cae a VIN, queda sin_respuesta y no certifica', async () => {
    filaSinDuplicado();
    const sets = capturarSets('sin_respuesta');
    runt.consultar.mockResolvedValue({ ok: false, message: 'Timeout 90s' });
    const r = await consultar();
    expect(r.body.estado).toBe('sin_respuesta');
    expect(runt.consultar).toHaveBeenCalledTimes(1);
    expect(sets[0]).not.toHaveProperty('snapshot');
  });

  it('respuesta ok sin vehículo detrás (eco de la placa) con documento: sin_vehiculo, sin caer a VIN ni certificar', async () => {
    filaSinDuplicado();
    const sets = capturarSets('sin_vehiculo');
    runt.consultar.mockResolvedValue({ ok: true, data: { vehiculo: { placa: 'ABC123', marca: null, linea: null } } });
    const r = await consultar();
    expect(r.body.estado).toBe('sin_vehiculo');
    expect(runt.consultar).toHaveBeenCalledTimes(1);
    expect(sets[0]).toMatchObject({ estado: 'sin_vehiculo', comparacion: null });
    expect(sets[0]).not.toHaveProperty('snapshot');
  });

  it('con documento, un VIN del RUNT distinto al diligenciado no certifica (sin_coincidencia)', async () => {
    filaSinDuplicado();
    const sets = capturarSets('sin_coincidencia');
    runt.consultar.mockResolvedValue(runtOk({ vin: 'OTROVIN0000000099' }));
    const r = await consultar();
    expect(r.body.estado).toBe('sin_coincidencia');
    expect(sets[0]).not.toHaveProperty('snapshot');
  });

  it('el UPDATE de certificación guarda estado, fecha, snapshot y quién certificó', async () => {
    filaSinDuplicado();
    const sets: Record<string, unknown>[] = [];
    kdb.update.mockImplementation(() => {
      const t: Record<string, unknown> = {};
      t.set = (v: Record<string, unknown>) => { sets.push(v); return t; };
      t.where = () => t;
      t.returning = () => Promise.resolve([filaBd({ estado: 'certificado', certificadoEn: new Date() })]);
      return t;
    });
    runt.consultar.mockResolvedValue(runtOk());
    const r = await consultar();
    expect(r.status).toBe(200);
    expect(sets[0]).toMatchObject({ estado: 'certificado', certificadoPorNombre: 'gestor@flit.io' });
    expect(sets[0]!.certificadoEn).toBeInstanceOf(Date);
    expect((sets[0]!.snapshot as { campos: unknown[] }).campos).toHaveLength(6);
  });

  it('sin_coincidencia cuando difieren datos: no deja certificado ni snapshot', async () => {
    filaSinDuplicado();
    const sets: Record<string, unknown>[] = [];
    kdb.update.mockImplementation(() => {
      const t: Record<string, unknown> = {};
      t.set = (v: Record<string, unknown>) => { sets.push(v); return t; };
      t.where = () => t;
      t.returning = () => Promise.resolve([filaBd({ estado: 'sin_coincidencia' })]);
      return t;
    });
    runt.consultar.mockResolvedValue(runtOk({ marca: 'MAZDA' }));
    const r = await consultar();
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('sin_coincidencia');
    expect(sets[0]).toMatchObject({ estado: 'sin_coincidencia' });
    expect(sets[0]).not.toHaveProperty('snapshot');
    expect(sets[0]).not.toHaveProperty('certificadoEn');
  });

  it('un dato que el RUNT no trae tampoco certifica (sin_coincidencia)', async () => {
    filaSinDuplicado();
    kdb.when.update(FILA, [filaBd({ estado: 'sin_coincidencia' })]);
    runt.consultar.mockResolvedValue({ ok: true, data: { vehiculo: { vin: datos.vin, marca: 'KIA', linea: 'K3', modelo: '2024', cilindraje: '1598' } } });
    const r = await consultar();
    expect(r.body.estado).toBe('sin_coincidencia');
  });

  it('sin_vehiculo cuando el RUNT dice que no encuentra el vehículo', async () => {
    filaSinDuplicado();
    kdb.when.update(FILA, [filaBd({ estado: 'sin_vehiculo' })]);
    runt.consultar.mockResolvedValue({ ok: false, message: 'No se encuentra información del vehículo' });
    const r = await consultar();
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('sin_vehiculo');
    expect(r.body.certificadoEn).toBeNull();
  });

  it('sin_respuesta cuando el RUNT falla o no responde', async () => {
    filaSinDuplicado();
    kdb.when.update(FILA, [filaBd({ estado: 'sin_respuesta' })]);
    runt.consultar.mockResolvedValue({ ok: false, message: 'timeout de la pasarela' });
    const r = await consultar();
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('sin_respuesta');
    expect(r.body.certificadoEn).toBeNull();
  });

  it('un registro ya certificado no se consulta de nuevo: 409 sin llamar al RUNT', async () => {
    kdb.when.select(FILA, [filaBd({ estado: 'certificado' })]);
    const r = await consultar();
    expect(r.status).toBe(409);
    expect(runt.consultar).not.toHaveBeenCalled();
  });

  describe('otro registro ya certificó ese VIN o esa placa', () => {
    it.each<[string, Record<string, string>, string]>([
      ['VIN', { vin: '9ZZTEST0000000001', placa: 'OTRA99' }, 'Ya existe una certificación para este VIN'],
      ['placa', { vin: 'OTROVIN12345', placa: 'ABC123' }, 'Ya existe una certificación para esta placa'],
    ])('duplicado por %s: 409 sin enviar nada al RUNT y sin auditar consulta', async (_n, duplicado, mensaje) => {
      vi.mocked(audit).mockClear();
      kdb.when.selectOnce(FILA, [filaBd()]).select(FILA, [duplicado]); // 1.º cargar; luego el duplicado
      kdb.when.update(FILA, [filaBd({ estado: 'certificado' })]);
      runt.consultar.mockResolvedValue(runtOk());

      const r = await consultar();

      expect(r.status).toBe(409);
      expect(r.body.error).toBe(mensaje);
      expect(runt.consultar).not.toHaveBeenCalled();
      expect(kdb.update).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    });
  });

  it('índice único al certificar: 409 y no certifica', async () => {
    filaSinDuplicado();
    kdb.when.update(FILA, () => { throw Object.assign(new Error('dup'), { code: '23505' }); });
    runt.consultar.mockResolvedValue(runtOk());
    const r = await consultar();
    expect(r.status).toBe(409);
  });

  describe('auditoría de la consulta (quién mandó datos del titular al RUNT)', () => {
    const conDocumento = {};
    const porVin = { documentoPropietario: null, nombrePropietario: null };
    const timeout = { ok: false, message: 'timeout de la pasarela' };
    const noEncontrado = { ok: false, message: 'No se encuentra información del vehículo' };

    it.each<[string, Record<string, unknown>, unknown, string, string]>([
      ['con documento que certifica', conDocumento, runtOk(), 'placa_documento', 'certificado'],
      ['con documento sin coincidencia', conDocumento, runtOk({ marca: 'MAZDA' }), 'placa_documento', 'sin_coincidencia'],
      ['con documento sin vehículo', conDocumento, noEncontrado, 'placa_documento', 'sin_vehiculo'],
      ['con documento sin respuesta', conDocumento, timeout, 'placa_documento', 'sin_respuesta'],
      ['por VIN que certifica', porVin, runtOk(), 'vin', 'certificado'],
      ['por VIN sin respuesta', porVin, timeout, 'vin', 'sin_respuesta'],
    ])('%s: audita modalidad y estado, sin datos del titular', async (_n, extra, respuestaRunt, modalidad, estado) => {
      vi.mocked(audit).mockClear();
      filaSinDuplicado(extra);
      const sets = capturarSets(estado);
      runt.consultar.mockResolvedValue(respuestaRunt);

      const r = await consultar();

      expect(r.status).toBe(200);
      expect(sets[0]!.estado).toBe(estado); // el estado auditado es el que escribió el servicio
      expect(r.body).not.toHaveProperty('modalidad');
      expect(audit).toHaveBeenCalledTimes(1);
      const [, entrada] = vi.mocked(audit).mock.calls[0]!;
      expect(entrada).toMatchObject({ action: 'update', resource: 'flito_impuesto', resourceId: ID });
      expect(entrada.detail).toContain(`modalidad ${modalidad}`);
      expect(entrada.detail).toContain(`estado ${estado}`);
      for (const dato of ['ABC123', '900123456', '9ZZTEST0000000001', 'Empresa Prueba SAS']) {
        expect(entrada.detail).not.toContain(dato);
      }
    });

    it('un registro ya certificado no llama al RUNT y no audita consulta', async () => {
      vi.mocked(audit).mockClear();
      kdb.when.select(FILA, [filaBd({ estado: 'certificado' })]);
      const r = await consultar();
      expect(r.status).toBe(409);
      expect(audit).not.toHaveBeenCalled();
    });
  });

  it('la consulta 11 en un minuto responde 429 «Demasiadas consultas al RUNT. Espera un minuto.»', async () => {
    kdb.when.select(FILA, [filaBd({ estado: 'certificado' })]); // 409 barato: lo que cuenta es el limiter
    const app = await buildApp();
    const auth = await gestor(9000);
    for (let i = 1; i <= 10; i++) {
      const ok = await request(app).post(`${BASE}/${ID}/consultar`).set('Authorization', auth);
      expect(ok.status).toBe(409);
    }
    const r = await request(app).post(`${BASE}/${ID}/consultar`).set('Authorization', auth);
    expect(r.status).toBe(429);
    expect(r.body.error).toBe('Demasiadas consultas al RUNT. Espera un minuto.');
  });
});

describe('GET listado, detalle, factura y certificado', () => {
  it('el listado devuelve filas de esta pantalla sin storage key, sin bytes ni snapshot, y registra el acceso', async () => {
    kdb.when.select(FILA, [filaBd(), filaBd({ id: 'otro' })]);
    const r = await request(await buildApp()).get(BASE).set('Authorization', await gestor());
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(2);
    const txt = JSON.stringify(r.body);
    for (const prohibido of ['facturaStorageKey', 'facturaBytes', 'snapshot', 'companiaId', 'companiaNombre', 'creadoPorId']) {
      expect(txt).not.toContain(prohibido);
    }
    expect(pii.registrar).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accion: 'search', filas: 2 }));
  });

  it('el detalle registra lectura PII y no expone la storage key', async () => {
    kdb.when.select(FILA, [filaBd()]);
    const r = await request(await buildApp()).get(`${BASE}/${ID}`).set('Authorization', await gestor());
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('facturaStorageKey');
    expect(pii.registrar).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accion: 'read', impuestoId: ID }));
  });

  it('detalle inexistente es 404', async () => {
    kdb.when.select(FILA, []);
    const r = await request(await buildApp()).get(`${BASE}/${ID}`).set('Authorization', await gestor());
    expect(r.status).toBe(404);
  });

  it('la factura se entrega como PDF adjunto y registra acceso PII', async () => {
    kdb.when.select(FILA, [filaBd()]);
    storage.stream.mockResolvedValue((async function* () { yield PDF; })());
    const r = await request(await buildApp()).get(`${BASE}/${ID}/factura`).set('Authorization', await gestor()).buffer(true).parse((res, cb) => {
      const partes: Buffer[] = []; res.on('data', (c: Buffer) => partes.push(c)); res.on('end', () => cb(null, Buffer.concat(partes)));
    });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.headers['content-disposition']).toContain('factura-ABC123.pdf');
    expect((r.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect(pii.registrar).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accion: 'export', impuestoId: ID }));
  });

  it('el certificado de un registro no certificado es 409 y no registra acceso', async () => {
    kdb.when.select(FILA, [filaBd({ estado: 'sin_coincidencia' })]);
    const r = await request(await buildApp()).get(`${BASE}/${ID}/certificado`).set('Authorization', await gestor());
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('Este registro todavía no tiene certificado');
    expect(pii.registrar).not.toHaveBeenCalled();
  });

  it('el certificado de un registro certificado sale como PDF y registra acceso PII', async () => {
    const campos = ['vin', 'marca', 'linea', 'anio', 'color', 'cilindrada'].map((campo) => ({
      campo, resultado: 'coincide', bloqueante: false, valorFactura: 'x', valorRunt: 'x',
    }));
    kdb.when.select(FILA, [filaBd({
      estado: 'certificado', certificadoEn: new Date('2026-10-30T12:00:00Z'), certificadoPorNombre: 'gestor@flit.io',
      snapshot: { campos, registroRunt: {} },
    })]);
    const r = await request(await buildApp()).get(`${BASE}/${ID}/certificado`).set('Authorization', await gestor()).buffer(true).parse((res, cb) => {
      const partes: Buffer[] = []; res.on('data', (c: Buffer) => partes.push(c)); res.on('end', () => cb(null, Buffer.concat(partes)));
    });
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toContain('certificado-runt-ABC123.pdf');
    expect((r.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    expect(pii.registrar).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accion: 'export', archivo: 'certificado_runt' }));
  });

  const descargarCertificado = async (extra: Record<string, unknown>, snapshotExtra: Record<string, unknown> = {}) => {
    const campos = ['vin', 'marca', 'linea', 'anio', 'color', 'cilindrada'].map((campo) => ({
      campo, resultado: 'coincide', bloqueante: false, valorFactura: 'x', valorRunt: 'x',
    }));
    kdb.when.select(FILA, [filaBd({
      estado: 'certificado', certificadoEn: new Date('2026-10-30T12:00:00Z'), certificadoPorNombre: 'gestor@flit.io',
      snapshot: { campos, registroRunt: {}, ...snapshotExtra }, ...extra,
    })]);
    const r = await request(await buildApp()).get(`${BASE}/${ID}/certificado`).set('Authorization', await gestor()).buffer(true).parse((res, cb) => {
      const partes: Buffer[] = []; res.on('data', (c: Buffer) => partes.push(c)); res.on('end', () => cb(null, Buffer.concat(partes)));
    });
    expect(r.status).toBe(200);
    return textoDelPdf(r.body as Buffer);
  };

  it('un certificado sin propietario sale sin esas líneas y declara el VIN como consultado', async () => {
    const t = await descargarCertificado({ documentoPropietario: null, nombrePropietario: null }, { modalidadConsulta: 'vin' });
    expect(t).not.toContain('Nombre (dato de FLITO)');
    expect(t).not.toContain('Documento (dato de FLITO)');
    expect(t).toContain('VIN consultado: 9ZZTEST0000000001');
  });

  it('un certificado consultado con documento declara la placa como consultada, no el VIN', async () => {
    const t = await descargarCertificado({}, { modalidadConsulta: 'placa_documento' });
    expect(t).toContain('Placa consultada: ABC123');
    expect(t).toContain('VIN (dato de FLITO): 9ZZTEST0000000001');
    expect(t).not.toContain('VIN consultado');
    expect(t).toContain('Documento (dato de FLITO): 900123456');
  });

  it('un certificado emitido antes del cambio (snapshot sin modalidad, con documento) sigue diciendo VIN consultado', async () => {
    const t = await descargarCertificado({});
    expect(t).toContain('VIN consultado: 9ZZTEST0000000001');
    expect(t).toContain('Placa (dato de FLITO): ABC123');
    expect(t).toContain('Documento (dato de FLITO): 900123456');
    expect(t).not.toContain('Placa consultada');
  });
});

describe('límites de uso (regla 18)', () => {
  const MSG = 'Demasiadas solicitudes. Espera un minuto.';

  it('la solicitud 21 a /extraer en un minuto responde 429 sin llegar al OCR', async () => {
    const app = await buildApp();
    const auth = await gestor(9100);
    const enviar = () => request(app).post(`${BASE}/extraer`).set('Authorization', auth)
      .attach('factura', Buffer.from('texto plano'), { filename: 'f.pdf', contentType: 'application/pdf' });
    for (let i = 1; i <= 20; i++) expect((await enviar()).status).toBe(400); // rechazo barato por bytes
    const r = await enviar();
    expect(r.status).toBe(429);
    expect(r.body.error).toBe(MSG);
    expect(ocr.extraer).not.toHaveBeenCalled();
  });

  it('la subida 31 (POST) en un minuto responde 429 y no sube a MinIO', async () => {
    const app = await buildApp();
    const auth = await gestor(9101);
    const enviar = () => request(app).post(BASE).set('Authorization', auth).field('placa', 'x'); // 400 barato
    for (let i = 1; i <= 30; i++) expect((await enviar()).status).toBe(400);
    const r = await enviar();
    expect(r.status).toBe(429);
    expect(r.body.error).toBe(MSG);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('la subida 31 (PATCH) en un minuto responde 429', async () => {
    const app = await buildApp();
    const auth = await gestor(9102);
    const enviar = () => request(app).patch(`${BASE}/${ID}`).set('Authorization', auth).field('placa', 'x');
    for (let i = 1; i <= 30; i++) expect((await enviar()).status).toBe(400);
    const r = await enviar();
    expect(r.status).toBe(429);
    expect(r.body.error).toBe(MSG);
  });
});
