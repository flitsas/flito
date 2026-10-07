// HU #13362 (Feature #13360, Épica #13201) — documentos adicionales en `POST /api/flito/soat/cliente`.
// Diseño: docs/arquitectura/hu-13362-documentos-adicionales-soat.md (D1–D3-bis).
//
// Matriz AC → casos (qa-a-13362, archivo [R]):
//   TC-01 factura + PDF/JPG/PNG con etiqueta → 201; 3 filas del tipo nuevo con lo ESCRITO (etiqueta,
//         mime detectado, soat_id); aceptados = 3, descartados = 0.
//   TC-03 etiqueta vacía → nombre del archivo (por HTTP).
//   TC-04 solo la factura → el 201 de hoy (mismas claves), cero filas del tipo nuevo.
//   TC-05 MZ renombrado .pdf con mime application/pdf + PNG → 1 aceptado, 1 «formato no permitido»;
//         el storage no recibe el ejecutable.
//   TC-10 16 MB + válido por HTTP → 201 (no 413/500), 1 aceptado y 1 descartado.
//   TC-11 21 adicionales por HTTP no dispara el techo técnico → 201, el 21.º descartado.
//   TC-12 repetido por HTTP (incluido el idéntico a la factura) → 1 subida, 1 fila.
//   TC-13 factura inválida + 2 adicionales → el MISMO error de hoy, nada subido ni insertado.
//   TC-14 la transacción falla → mismo error; las claves de los adicionales subidos se BORRAN.
//   TC-22..25 Bitácora: un `audit` por guardado, sin contenido ni nombre completo; descartados no.
//   D3-bis RUNT caído → 202 con adicionales guardados contra la por validar (`soat_id` NULL);
//         `vin_ocupado` → claves borradas.
//   D1 >100 adicionales → 413 con mensaje claro; temporales borrados en todos los caminos.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'express-async-errors';
import request from 'supertest';
import express from 'express';
import { readdirSync } from 'node:fs';
import os from 'node:os';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { testToken } from '../helpers/auth.js';

const kdb = createKeyedDb();
const espia = crearEspia(kdb);

const consultarVehiculoRuntMock = vi.fn();
const uploadMock = vi.fn();
const deleteMock = vi.fn().mockResolvedValue(undefined);
const auditMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: uploadMock, deleteEntityDocument: deleteMock, firmarDescargaEntidad: vi.fn(),
}));
vi.mock('../../src/modules/runt/runt.service.js', () => ({
  consultarVehiculoRunt: consultarVehiculoRuntMock, consultarPersonaRunt: vi.fn(),
}));
const logMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
logMock.child.mockReturnValue(logMock);
vi.mock('../../src/shared/logger.js', () => ({ logger: logMock, loggerFor: () => logMock }));

const COMPANIA = 7;
const INCOMPLETA_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const VIN = '9FKRG2222T2042405';
const MB = 1024 * 1024;
const TIPO = 'documento_adicional_soat';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n');
const pdfDistinto = (s: string) => Buffer.from(`%PDF-1.4\n% ${s}\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n`);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), Buffer.from('JFIF\0'), Buffer.alloc(20)]);
const png = (sufijo = '') => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(17), Buffer.from(sufijo),
]);
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 7)]);

function runtOk() {
  return {
    ok: true,
    data: {
      vehiculo: {
        placa: 'JNH38H', vin: VIN, idAutomotor: '9911', estadoAutomotor: 'ACTIVO',
        marca: 'MAZDA', linea: 'CX-30', modelo: '2026', clase: 'CAMIONETA',
        cilindraje: '1598', tipoServicio: 'Particular', tipoCarroceria: 'WAGON',
        pasajerosSentados: '5', puertas: '5', organismoTransito: 'STRIA TTOyTTE MCPAL FUNZA',
        nombrePropietario: 'JUANA PEREZ',
      },
      soat: { estadoSoat: 'NO VIGENTE', fechaVencimSoat: '01/01/2020' },
    },
  };
}
const CAIDO = { ok: false, message: 'La consulta no pudo ser atendida' };

let sub = 13362000;
const auth = async () => `Bearer ${await testToken({ sub: ++sub, username: 'cliente@empresa.co', role: 'cliente' as never })}`;

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat-cliente.routes.js');
  app.use('/api/flito/soat', router);
  return app;
}

let nSoporte = 0;
function escenario() {
  kdb.when.scenario({
    users: [{ c: COMPANIA, s: null }],
    clients: [{
      id: COMPANIA, sinTramite: true, carpeta: 'clientes/acme',
      proveedorId: '55555555-5555-4555-8555-555555555555', activo: true,
    }],
    flito_soat: [], flito_soat_incompletas: [],
    organismos_transito_config: [{ codigo: '25286', alias: 'FUNZA' }],
    vehicles: [],
  });
  kdb.when.insert('vehicles', [{ id: 55 }]);
  kdb.when.insert('flito_soat_incompletas', [{ id: INCOMPLETA_ID }]);
  kdb.when.insert('flito_soportes', () => [{ id: `00000000-0000-4000-8000-${String(++nSoporte).padStart(12, '0')}` }]);
}

const CAMPOS: Record<string, string> = {
  vin: VIN.toLowerCase(), tipoDocumento: 'CC', numeroDocumento: '1020304050',
  nombres: 'JUANA', apellidos: 'PEREZ', correo: 'juana@empresa.co', celular: '3001234567',
  direccion: 'CALLE 1 # 2-3', municipio: 'FUNZA', departamento: 'CUNDINAMARCA',
};

interface Adjunto { buf: Buffer; nombre: string; tipo?: string; etiqueta?: string }

async function alta(adicionales: Adjunto[] = [], factura: { buf: Buffer; tipo?: string } = { buf: PDF }) {
  const req = request(await buildApp()).post('/api/flito/soat/cliente').set('Authorization', await auth());
  for (const [k, v] of Object.entries(CAMPOS)) req.field(k, v);
  req.attach('facturaVenta', factura.buf, { filename: 'factura.pdf', contentType: factura.tipo ?? 'application/pdf' });
  for (const a of adicionales) {
    req.attach('documentosAdicionales', a.buf, { filename: a.nombre, contentType: a.tipo ?? 'application/octet-stream' });
    req.field('etiquetasDocumentosAdicionales', a.etiqueta ?? '');
  }
  return req;
}

const filasAdicionales = () => espia.insertsEn('flito_soportes').map((m) => m.datos).filter((d) => d.tipo === TIPO);
const subidasDeAdicionales = () => uploadMock.mock.calls.filter((c) => String(c[0]).includes('documentos-adicionales'));
const auditsDeAdicionales = () => auditMock.mock.calls.map((c) => c[1]).filter((p) => String(p.detail).startsWith('Documento adicional'));
const temporales = () => readdirSync(os.tmpdir()).filter((f) => f.startsWith('flito-soat-adic-'));

beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  nSoporte = 0;
  consultarVehiculoRuntMock.mockReset().mockResolvedValue(runtOk());
  uploadMock.mockReset().mockImplementation(async (carpeta: string, id: string, nombre: string) => `${carpeta}/${id}/${nombre}`);
  deleteMock.mockClear();
  auditMock.mockClear();
});

describe('TC-01 — factura + PDF/JPG/PNG con etiqueta → 201 y tres filas del tipo nuevo', () => {
  it('lo ESCRITO: tipo, etiqueta exacta, mime detectado, soat_id del alta, sin incompleta', async () => {
    const r = await alta([
      { buf: pdfDistinto('a'), nombre: 'cedula.pdf', etiqueta: 'Cédula' },
      { buf: JPG, nombre: 'foto.jpg', etiqueta: 'Foto del vehículo' },
      { buf: png(), nombre: 'runt.png', etiqueta: 'Certificado RUNT' },
    ]);
    expect(r.status).toBe(201);
    const filas = filasAdicionales();
    expect(filas.map((f) => f.etiqueta)).toEqual(['Cédula', 'Foto del vehículo', 'Certificado RUNT']);
    expect(filas.map((f) => f.contentType)).toEqual(['application/pdf', 'image/jpeg', 'image/png']);
    for (const f of filas) {
      expect(f.soatId).toBe(r.body.id);
      expect(f.soatIncompletaId).toBeNull();
      expect(f.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(String(f.storageKey)).toContain(`soat/documentos-adicionales/${r.body.id}/`);
    }
    expect(r.body.documentosAdicionales.aceptados).toHaveLength(3);
    expect(r.body.documentosAdicionales.descartados).toEqual([]);
    expect(r.body.documentosAdicionales.aceptados[0]).toEqual({
      id: '00000000-0000-4000-8000-000000000002', etiqueta: 'Cédula', nombreArchivo: 'cedula.pdf',
      tipoContenido: 'application/pdf', tamanoBytes: pdfDistinto('a').length,
    });
    await vi.waitFor(() => expect(temporales(), 'el directorio temporal se borra').toEqual([]));
  });
});

describe('TC-03 — etiqueta vacía → nombre del archivo', () => {
  it('etiqueta en blanco → la fila lleva el nombre como etiqueta', async () => {
    const r = await alta([{ buf: png(), nombre: 'soporte-pago.png', etiqueta: '   ' }]);
    expect(r.status).toBe(201);
    expect(filasAdicionales().map((f) => f.etiqueta)).toEqual(['soporte-pago.png']);
  });
});

describe('TC-04 — sin adicionales el alta es la de hoy', () => {
  it('mismo cuerpo (mismas claves), cero filas del tipo nuevo, ninguna subida extra', async () => {
    const r = await alta();
    expect(r.status).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(['desenlace', 'estado', 'id']);
    expect(filasAdicionales()).toHaveLength(0);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(auditsDeAdicionales()).toHaveLength(0);
  });
});

describe('TC-05 — el formato se decide por BYTES', () => {
  it('MZ renombrado .pdf con mime application/pdf → descartado; el storage no lo recibe', async () => {
    const r = await alta([
      { buf: EXE, nombre: 'factura-falsa.pdf', tipo: 'application/pdf', etiqueta: 'Falsa' },
      { buf: png(), nombre: 'ok.png', etiqueta: 'Buena' },
    ]);
    expect(r.status).toBe(201);
    expect(r.body.documentosAdicionales.aceptados.map((a: { etiqueta: string }) => a.etiqueta)).toEqual(['Buena']);
    expect(r.body.documentosAdicionales.descartados).toEqual([
      { nombreArchivo: 'factura-falsa.pdf', codigo: 'formato_no_permitido', motivo: 'formato no permitido' },
    ]);
    expect(uploadMock.mock.calls.some((c) => Buffer.isBuffer(c[3]) && (c[3] as Buffer).equals(EXE))).toBe(false);
    expect(filasAdicionales()).toHaveLength(1);
  });
});

describe('TC-10 — un adicional de 16 MB no tumba el alta', () => {
  it('201 (no 413/500): 1 aceptado y 1 «supera el tamaño máximo de 15 MB»', async () => {
    const grande = Buffer.concat([png(), Buffer.alloc(16 * MB)]);
    const r = await alta([
      { buf: grande, nombre: 'enorme.png', etiqueta: 'Enorme' },
      { buf: JPG, nombre: 'ok.jpg', etiqueta: 'Ok' },
    ]);
    expect(r.status).toBe(201);
    expect(r.body.documentosAdicionales.aceptados).toHaveLength(1);
    expect(r.body.documentosAdicionales.descartados).toEqual([
      { nombreArchivo: 'enorme.png', codigo: 'supera_tamano', motivo: 'supera el tamaño máximo de 15 MB' },
    ]);
    await vi.waitFor(() => expect(temporales()).toEqual([]));
  }, 30000);
});

describe('TC-11 — 21 adicionales: el 21.º se descarta, no hay 413', () => {
  it('201, 20 aceptados en orden y el 21.º «supera el máximo de 20 documentos por envío»', async () => {
    const r = await alta(Array.from({ length: 21 }, (_, i) => ({ buf: png(`#${i}`), nombre: `d${i + 1}.png`, etiqueta: `D${i + 1}` })));
    expect(r.status).toBe(201);
    expect(filasAdicionales().map((f) => f.etiqueta)).toEqual(Array.from({ length: 20 }, (_, i) => `D${i + 1}`));
    expect(r.body.documentosAdicionales.descartados).toEqual([
      { nombreArchivo: 'd21.png', codigo: 'supera_cantidad', motivo: 'supera el máximo de 20 documentos por envío' },
    ]);
  });
});

describe('TC-12 — documento repetido', () => {
  it('dos idénticos → 1 subida y 1 fila; el idéntico a la factura también se descarta', async () => {
    const r = await alta([
      { buf: png(), nombre: 'a.png', etiqueta: 'A' },
      { buf: png(), nombre: 'a-copia.png', etiqueta: 'A bis' },
      { buf: PDF, nombre: 'factura-otra-vez.pdf', etiqueta: 'Factura' },
    ]);
    expect(r.status).toBe(201);
    expect(subidasDeAdicionales()).toHaveLength(1);
    expect(filasAdicionales().map((f) => f.etiqueta)).toEqual(['A']);
    expect(r.body.documentosAdicionales.descartados.map((d: { nombreArchivo: string; codigo: string }) => [d.nombreArchivo, d.codigo]))
      .toEqual([['a-copia.png', 'documento_repetido'], ['factura-otra-vez.pdf', 'documento_repetido']]);
  });
});

describe('TC-13 / TC-14 — atomicidad (AC7)', () => {
  it('TC-13 factura que no es PDF + 2 adicionales → el MISMO error de hoy; nada subido ni insertado', async () => {
    const hoy = await alta([], { buf: png('falsa'), tipo: 'application/pdf' });
    escenario();
    const conAdicionales = await alta(
      [{ buf: png(), nombre: 'a.png' }, { buf: JPG, nombre: 'b.jpg' }],
      { buf: png('falsa'), tipo: 'application/pdf' },
    );
    expect(conAdicionales.status).toBe(hoy.status);
    expect(conAdicionales.body).toEqual(hoy.body);
    expect(hoy.status).toBeGreaterThanOrEqual(400);
    expect(uploadMock).not.toHaveBeenCalled();
    expect(espia.insertsEn('flito_soportes')).toHaveLength(0);
    await vi.waitFor(() => expect(temporales()).toEqual([]));
  });

  it('TC-14 la transacción falla tras subir → mismo error; las claves de los adicionales se BORRAN', async () => {
    kdb.when.insert('flito_compradores', () => { throw new Error('fallo de base'); });
    const r = await alta([{ buf: png(), nombre: 'a.png' }, { buf: JPG, nombre: 'b.jpg' }]);
    expect(r.status).toBe(500);
    const claves = subidasDeAdicionales().map((c, i) => uploadMock.mock.results[uploadMock.mock.calls.indexOf(c)]?.value ?? i);
    const subidas = await Promise.all(claves);
    expect(subidas).toHaveLength(2);
    expect(deleteMock.mock.calls.map((c) => c[0]).sort()).toEqual([...subidas].sort());
    expect(auditsDeAdicionales()).toHaveLength(0);
  });
});

describe('TC-22..25 — Bitácora (AC10)', () => {
  it('un `audit` por guardado, en `flito_soat`, con soporte y etiqueta; sin nombre ni contenido', async () => {
    const r = await alta([
      { buf: png(), nombre: 'nombre-secreto-del-archivo.png', etiqueta: 'Cédula' },
      { buf: JPG, nombre: 'otro-nombre-secreto.jpg', etiqueta: 'Foto' },
      { buf: EXE, nombre: 'descartado.exe', etiqueta: 'Malo' },
    ]);
    expect(r.status).toBe(201);
    const audits = auditsDeAdicionales();
    expect(audits).toHaveLength(2);
    const ids = r.body.documentosAdicionales.aceptados.map((a: { id: string }) => a.id);
    expect(audits).toEqual([
      { action: 'create', resource: 'flito_soat', resourceId: r.body.id, detail: `Documento adicional cargado (soporte=${ids[0]}, etiqueta=Cédula)` },
      { action: 'create', resource: 'flito_soat', resourceId: r.body.id, detail: `Documento adicional cargado (soporte=${ids[1]}, etiqueta=Foto)` },
    ]);
    const todo = JSON.stringify(auditMock.mock.calls.map((c) => c[1]));
    expect(todo).not.toContain('nombre-secreto');
    expect(todo).not.toContain('descartado.exe');
    expect(todo).not.toContain(EXE.toString('base64').slice(0, 20));
  });

  it('sin etiqueta: el nombre va truncado a 40 caracteres, nunca completo', async () => {
    const nombre = `${'x'.repeat(60)}.png`;
    await alta([{ buf: png(), nombre }]);
    const [a] = auditsDeAdicionales();
    expect(a.detail).toContain(`nombre=${'x'.repeat(40)}…`);
    expect(a.detail).not.toContain(nombre);
  });
});

describe('D3-bis — RUNT caído (202): los adicionales SÍ se guardan contra la por validar', () => {
  it('filas con soat_incompleta_id y soat_id NULL; clave con el soat_id reservado; audit en la incompleta', async () => {
    consultarVehiculoRuntMock.mockResolvedValue(CAIDO);
    const r = await alta([{ buf: png(), nombre: 'a.png', etiqueta: 'Cédula' }, { buf: EXE, nombre: 'x.pdf' }]);
    expect(r.status).toBe(202);
    const [fila] = filasAdicionales();
    expect(filasAdicionales()).toHaveLength(1);
    expect(fila.soatIncompletaId).toBe(INCOMPLETA_ID);
    expect(fila.soatId).toBeNull();
    const reservado = espia.ultimoInsertEn('flito_soat_incompletas').soatIdReservado;
    expect(subidasDeAdicionales()[0][1]).toBe(reservado);
    expect(r.body.documentosAdicionales.aceptados).toHaveLength(1);
    expect(r.body.documentosAdicionales.descartados.map((d: { codigo: string }) => d.codigo)).toEqual(['formato_no_permitido']);
    expect(auditsDeAdicionales()).toEqual([expect.objectContaining({ resource: 'flito_soat_incompletas', resourceId: INCOMPLETA_ID })]);
  });

  it('sin adicionales el 202 es el de hoy', async () => {
    consultarVehiculoRuntMock.mockResolvedValue(CAIDO);
    const r = await alta();
    expect(r.status).toBe(202);
    expect(Object.keys(r.body).sort()).toEqual(['desenlace', 'estado', 'id', 'mensaje']);
  });

  it('`vin_ocupado` (23505) → 409 de hoy y las claves de los adicionales se borran', async () => {
    consultarVehiculoRuntMock.mockResolvedValue(CAIDO);
    kdb.when.insert('flito_soat_incompletas', () => {
      throw Object.assign(new Error('duplicate key'), { code: '23505' });
    });
    const r = await alta([{ buf: png(), nombre: 'a.png' }]);
    expect(r.status).toBe(409);
    const clave = await uploadMock.mock.results[uploadMock.mock.calls.indexOf(subidasDeAdicionales()[0])].value;
    expect(deleteMock.mock.calls.map((c) => c[0])).toEqual([clave]);
  });
});

describe('D1 — techo técnico de 100 adicionales', () => {
  it('101 adicionales → 413 con mensaje claro, nada guardado, temporales borrados', async () => {
    const r = await alta(Array.from({ length: 101 }, (_, i) => ({ buf: png(`t${i}`), nombre: `t${i}.png` })));
    expect(r.status).toBe(413);
    expect(r.body.error).toMatch(/demasiados archivos/i);
    expect(uploadMock).not.toHaveBeenCalled();
    expect(espia.inserts).toHaveLength(0);
    await vi.waitFor(() => expect(temporales()).toEqual([]));
  });
});

beforeEach(() => escenario());
