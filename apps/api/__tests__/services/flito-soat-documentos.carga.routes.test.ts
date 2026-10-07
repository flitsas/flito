// HU #13364 (Feature #13361, Épica #13201) — `POST /api/flito/soat/:id/documentos-adicionales`:
// carga posterior de documentos adicionales sobre una solicitud existente.
//
// Matriz (qa-a-13364, archivo F1):
//   TC-26 AC1  con la función, solicitud `pagado`, 2 válidos (uno sin etiqueta) → 201; lo ESCRITO en
//              flito_soportes (tipo, soat_id, etiqueta, mime por bytes); respuesta sin clave de storage.
//   TC-27 AC1  sin filtro de estado: pendiente / pagado / anulado → 201.
//   TC-28 AC2  envío mixto: 1 válido, 1 MZ renombrado .pdf, 1 de 15 MB + 1 → 1 aceptado, 2 descartados;
//              solo se sube el válido; temporales borrados.
//   TC-29 AC2  21 válidos → 20 aceptados en orden; el 21.º «supera el máximo de 20»; sin 413.
//   TC-31 AC2  idéntico a un adicional YA guardado o a la factura de venta → «documento repetido»; la
//              lectura de huellas acotada a ESA solicitud y a los tipos adicional + factura_venta.
//   TC-32 AC2  la lectura de huellas lleva el soat_id de la URL (no deduplica entre solicitudes).
//   D4         carrera: el insert que choca con el índice (ON CONFLICT DO NOTHING) sale como repetido
//              y su objeto se borra; el ON CONFLICT lleva target (soat_id, hash) y el predicado.
//   TC-33 AC3  sin `.cargar` → 403 sin tocar acceso, storage, BD ni Bitácora.
//   TC-34 AC4  sin acceso a la solicitud → 404, nada subido; TC-36 id no uuid → 404 sin consultar.
//   TC-45 AC9  Bitácora: una entrada `create` por guardado, nunca por descartado; sin nombre completo.
//   TC-47 AC10 limitador: 30 por usuario y ventana; la 31.ª → 429 sin subir; otro usuario no se bloquea.
//   TC-48 AC10 el limitador no está en el GET ni en el DELETE.
//   + 400 sin archivos / campo ajeno; 413 con >100 archivos; fallo de la transacción → compensación.

import 'express-async-errors';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import { SignJWT } from 'jose';
import type { SQL } from 'drizzle-orm';
import { createKeyedDb } from '../helpers/keyed-db.js';
import { crearEspia } from '../helpers/espia-drizzle.js';
import { ligadoA, ligadosA, renderizar } from '../helpers/sql-ligado.js';
import { registrarUsuarioDePrueba } from '../helpers/auth.js';

const kdb = createKeyedDb();
const espia = crearEspia(kdb);
const accesoMock = vi.hoisted(() => vi.fn());
const auditMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const uploadMock = vi.hoisted(() => vi.fn());
const deleteMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const removeMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../src/db/client.js', () => ({ db: kdb.db, getPoolStats: vi.fn() }));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/shared/pii-audit.js', () => ({ logPiiAccess: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/services/storage.js', () => ({
  firmarDescargaEntidad: vi.fn(() => '/api/files?x'), uploadEntityDocument: uploadMock,
  deleteEntityDocument: deleteMock, removeEntityDocument: removeMock,
}));
vi.mock('../../src/modules/flito-soat/flito-soat.service.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  contextoSoat: vi.fn(async (u: { id: number; username: string; role: string }) => ({
    userId: u.id, username: u.username, role: u.role, externo: false, alcance: 'todo',
  })),
  buscarConAcceso: accesoMock,
}));

const ID = '0d0c0000-0000-4000-8000-000000013364';
const CARGAR = 'soat.documentos_adicionales.cargar';
const MB = 1024 * 1024;

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n');
const png = (s = '') => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(17), Buffer.from(s)]);
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 7)]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let sub = 13364100;
let ultimoSub = 0;
async function auth(funciones: string[], usar?: number) {
  if (usar === undefined) { sub += 1; ultimoSub = sub; }
  const id = usar ?? sub;
  await registrarUsuarioDePrueba(id, {
    rol: 'rol_prueba', tipoPrincipal: 'interno', tipoEnlace: 'ninguno', excepciones: [],
    funcionesDelRol: ['pagina.flito_soat', ...funciones],
  });
  const t = await new SignJWT({ username: 'operador@flit.co', role: 'rol_prueba' })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(String(id)).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  return `Bearer ${t}`;
}

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: router } = await import('../../src/modules/flito-soat/flito-soat-documentos.routes.js');
  app.use('/api/flito/soat', router);
  app.use((e: Error, _req: Request, res: Response, _next: NextFunction) => { res.status(500).json({ error: e.message }); });
  return app;
}

interface Adjunto { buf: Buffer; nombre: string; etiqueta?: string; campo?: string }
async function cargar(token: string, adjuntos: Adjunto[], id = ID) {
  const req = request(await buildApp()).post(`/api/flito/soat/${id}/documentos-adicionales`).set('Authorization', token);
  for (const a of adjuntos) {
    req.attach(a.campo ?? 'documentosAdicionales', a.buf, { filename: a.nombre, contentType: 'application/octet-stream' });
    if (!a.campo) req.field('etiquetasDocumentosAdicionales', a.etiqueta ?? '');
  }
  return req;
}

/** El `onConflictDoNothing` de cada insert, capturado (el mock lo ignora). */
let conflictos: unknown[] = [];
function capturarConflictos() {
  conflictos = [];
  const base = kdb.insert.getMockImplementation() as (t: unknown) => Record<string, unknown>;
  kdb.insert.mockImplementation((t: unknown) => {
    const c = base(t);
    const o = c.onConflictDoNothing as (cfg: unknown) => unknown;
    c.onConflictDoNothing = (cfg: unknown) => { conflictos.push(cfg); return o(cfg); };
    return c;
  });
}

const insertsSoportes = () => espia.insertsEn('flito_soportes').map((m) => m.datos);
const lecturaDeHuellas = () => espia.condicionesLeidas()
  .map((c) => renderizar(c as SQL)).find((q) => q.sql.includes('"flito_soportes"."hash"') || q.sql.includes('"flito_soportes"."soat_id"'));

let nSoporte = 0;
beforeEach(() => {
  kdb.reset();
  espia.reiniciar();
  capturarConflictos();
  nSoporte = 0;
  kdb.when.select('clients', [{ carpeta: 'clientes/acme' }]);
  kdb.when.select('flito_soportes', []);
  kdb.when.insert('flito_soportes', () => [{ id: `00000000-0000-4000-8000-${String(++nSoporte).padStart(12, '0')}` }]);
  accesoMock.mockReset().mockResolvedValue({ id: ID, companiaId: 7, estado: 'pagado' });
  auditMock.mockClear();
  uploadMock.mockReset().mockImplementation(async (carpeta: string, entity: string, nombre: string) => `${carpeta}/${entity}/${nombre}-key`);
  deleteMock.mockClear();
  removeMock.mockClear();
});

describe('TC-26 AC1 — carga sobre una solicitud pagada', () => {
  it('201; lo ESCRITO en flito_soportes; respuesta sin clave de storage', async () => {
    const r = await cargar(await auth([CARGAR]), [
      { buf: PDF, nombre: 'cedula.pdf', etiqueta: '  Cédula del propietario  ' },
      { buf: png(), nombre: 'foto-placa.png', etiqueta: '' },
    ]);
    expect(r.status).toBe(201);
    expect(uploadMock).toHaveBeenCalledTimes(2);
    expect(uploadMock.mock.calls.map((c) => [c[0], c[1], c[2], c[4]])).toEqual([
      ['clientes/acme/soat/documentos-adicionales', ID, 'cedula.pdf', 'application/pdf'],
      ['clientes/acme/soat/documentos-adicionales', ID, 'foto-placa.png', 'image/png'],
    ]);
    const filas = insertsSoportes();
    expect(filas).toHaveLength(2);
    expect(filas[0]).toMatchObject({
      tipo: 'documento_adicional_soat', soatId: ID, soatIncompletaId: null, etiqueta: 'Cédula del propietario',
      nombreArchivo: 'cedula.pdf', contentType: 'application/pdf', hash: sha(PDF), tamanoBytes: PDF.length,
      storageKey: `clientes/acme/soat/documentos-adicionales/${ID}/cedula.pdf-key`, subidoPorNombre: 'operador@flit.co',
    });
    expect(filas[1]).toMatchObject({ etiqueta: 'foto-placa.png', contentType: 'image/png', soatId: ID });
    expect(r.body.descartados).toEqual([]);
    expect(r.body.aceptados.map((a: { etiqueta: string }) => a.etiqueta)).toEqual(['Cédula del propietario', 'foto-placa.png']);
    expect(JSON.stringify(r.body)).not.toMatch(/key|storage/i);
  });
});

describe('TC-27 AC1 — sin filtro de estado', () => {
  it.each(['pendiente', 'pagado', 'anulado'])('estado %s → 201', async (estado) => {
    accesoMock.mockResolvedValue({ id: ID, companiaId: 7, estado });
    const r = await cargar(await auth([CARGAR]), [{ buf: PDF, nombre: 'a.pdf', etiqueta: 'A' }]);
    expect(r.status).toBe(201);
    expect(insertsSoportes()).toHaveLength(1);
    for (const c of espia.condicionesLeidas()) expect(renderizar(c as SQL).sql).not.toContain('estado');
  });
});

describe('TC-28 AC2 — envío mixto: las reglas del alta se aplican archivo por archivo', () => {
  it('1 aceptado, MZ «formato no permitido», 15 MB + 1 «supera el tamaño»; solo se sube el válido', async () => {
    const grande = Buffer.concat([png('g'), Buffer.alloc(15 * MB + 1 - png('g').length)]);
    const r = await cargar(await auth([CARGAR]), [
      { buf: PDF, nombre: 'ok.pdf', etiqueta: 'Ok' },
      { buf: EXE, nombre: 'malo.pdf', etiqueta: 'Malo' },
      { buf: grande, nombre: 'grande.png', etiqueta: 'Grande' },
    ]);
    expect(r.status).toBe(201);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(insertsSoportes()).toHaveLength(1);
    expect(r.body.descartados).toEqual([
      { nombreArchivo: 'malo.pdf', codigo: 'formato_no_permitido', motivo: 'formato no permitido' },
      { nombreArchivo: 'grande.png', codigo: 'supera_tamano', motivo: 'supera el tamaño máximo de 15 MB' },
    ]);
  });
});

describe('TC-29 AC2 — 20 por envío', () => {
  it('21 válidos → 20 aceptados en orden; el 21.º descartado; sin 413', async () => {
    const adj = Array.from({ length: 21 }, (_, i) => ({ buf: png(`n${i}`), nombre: `f${i}.png`, etiqueta: `E${i}` }));
    const r = await cargar(await auth([CARGAR]), adj);
    expect(r.status).toBe(201);
    expect(insertsSoportes().map((f) => f.etiqueta)).toEqual(adj.slice(0, 20).map((a) => a.etiqueta));
    expect(r.body.descartados).toEqual([
      { nombreArchivo: 'f20.png', codigo: 'supera_cantidad', motivo: 'supera el máximo de 20 documentos por envío' },
    ]);
  });
});

describe('TC-31/TC-32 AC2 — repetido contra lo YA guardado y contra la factura de venta', () => {
  it('el idéntico a una huella guardada no se sube ni se inserta; el distinto sí', async () => {
    kdb.when.select('flito_soportes', [{ hash: sha(PDF) }]);
    const r = await cargar(await auth([CARGAR]), [
      { buf: PDF, nombre: 'otra-vez.pdf', etiqueta: 'Repetido' },
      { buf: png('nuevo'), nombre: 'nuevo.png', etiqueta: 'Nuevo' },
    ]);
    expect(r.status).toBe(201);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(insertsSoportes().map((f) => f.etiqueta)).toEqual(['Nuevo']);
    expect(r.body.descartados).toEqual([
      { nombreArchivo: 'otra-vez.pdf', codigo: 'documento_repetido', motivo: 'documento repetido' },
    ]);
  });

  it('la lectura de huellas: soat_id de la URL, tipos adicional + factura_venta, solo vivos (SQL leído)', async () => {
    await cargar(await auth([CARGAR]), [{ buf: PDF, nombre: 'a.pdf', etiqueta: 'A' }]);
    const q = lecturaDeHuellas()!;
    expect(ligadoA(q, '"flito_soportes"."soat_id"')).toBe(ID);
    expect([...ligadosA(q, '"flito_soportes"."tipo"')].sort()).toEqual(['documento_adicional_soat', 'factura_venta']);
    expect(ligadoA(q, '"flito_soportes"."descartado"')).toBe(false);
  });
});

describe('D4 — carrera con otra carga simultánea (índice único parcial)', () => {
  it('ON CONFLICT (soat_id, hash) con el predicado del índice; el que choca sale repetido y su objeto se borra', async () => {
    let n = 0;
    kdb.when.insert('flito_soportes', () => (++n === 1 ? [] : [{ id: '00000000-0000-4000-8000-000000000009' }]));
    const r = await cargar(await auth([CARGAR]), [
      { buf: PDF, nombre: 'gana-otro.pdf', etiqueta: 'A' },
      { buf: png('b'), nombre: 'b.png', etiqueta: 'B' },
    ]);
    expect(r.status).toBe(201);
    expect(r.body.aceptados.map((a: { etiqueta: string }) => a.etiqueta)).toEqual(['B']);
    expect(r.body.descartados).toEqual([
      { nombreArchivo: 'gana-otro.pdf', codigo: 'documento_repetido', motivo: 'documento repetido' },
    ]);
    expect(deleteMock.mock.calls.map((c) => c[0])).toEqual([`clientes/acme/soat/documentos-adicionales/${ID}/gana-otro.pdf-key`]);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(conflictos).toHaveLength(2);
    const cfg = conflictos[0] as { target: { name: string }[]; where: SQL };
    expect(cfg.target.map((c) => c.name)).toEqual(['soat_id', 'hash']);
    expect(renderizar(cfg.where).sql).toBe("tipo = 'documento_adicional_soat' AND descartado = false AND soat_id IS NOT NULL");
  });

  it('si la transacción falla, se borra TODO lo subido y no hay Bitácora', async () => {
    kdb.when.insert('flito_soportes', () => { throw new Error('fallo de base'); });
    const r = await cargar(await auth([CARGAR]), [
      { buf: PDF, nombre: 'a.pdf', etiqueta: 'A' }, { buf: png('b'), nombre: 'b.png', etiqueta: 'B' },
    ]);
    expect(r.status).toBe(500);
    expect(deleteMock).toHaveBeenCalledTimes(2);
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('TC-33 AC3 — sin la función de cargar → 403 antes de leer bytes', () => {
  it('con ver y eliminar, sin cargar', async () => {
    const r = await cargar(await auth(['soat.documentos_adicionales.ver', 'soat.documentos_adicionales.eliminar']), [
      { buf: PDF, nombre: 'a.pdf', etiqueta: 'A' },
    ]);
    expect(r.status).toBe(403);
    expect(accesoMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(kdb.insert).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('TC-34/TC-36 AC4 — sin acceso o id inválido → 404', () => {
  it('proveedor con la función sin la solicitud asignada: 404 y nada escrito', async () => {
    accesoMock.mockResolvedValue(null);
    const r = await cargar(await auth([CARGAR]), [{ buf: PDF, nombre: 'a.pdf', etiqueta: 'A' }]);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'Solicitud de SOAT no encontrada' });
    expect(uploadMock).not.toHaveBeenCalled();
    expect(kdb.insert).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('id que no es uuid → 404 sin consultar', async () => {
    const r = await cargar(await auth([CARGAR]), [{ buf: PDF, nombre: 'a.pdf', etiqueta: 'A' }], 'no-es-uuid');
    expect(r.status).toBe(404);
    expect(accesoMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });
});

describe('Contrato — 400 / 413', () => {
  it('sin archivos → 400 «Adjunta al menos un documento»; nada escrito', async () => {
    const r = await cargar(await auth([CARGAR]), []);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'Adjunta al menos un documento' });
    expect(kdb.insert).not.toHaveBeenCalled();
  });

  it('archivo en otro campo (facturaVenta) → 400 «Campo de archivo no permitido»', async () => {
    const r = await cargar(await auth([CARGAR]), [{ buf: PDF, nombre: 'f.pdf', campo: 'facturaVenta' }]);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'Campo de archivo no permitido' });
    expect(accesoMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('más de 100 archivos → 413 con el mensaje del techo técnico; nada escrito', async () => {
    const adj = Array.from({ length: 101 }, (_, i) => ({ buf: png(`t${i}`), nombre: `t${i}.png`, etiqueta: '' }));
    const r = await cargar(await auth([CARGAR]), adj);
    expect(r.status).toBe(413);
    expect(r.body.error).toMatch(/máximo técnico 100/);
    expect(uploadMock).not.toHaveBeenCalled();
    expect(kdb.insert).not.toHaveBeenCalled();
  });
});

describe('TC-45 AC9 — Bitácora de la carga', () => {
  it('una entrada `create` por guardado, nunca por descartado; nombre largo truncado cuando no hubo etiqueta', async () => {
    const largo = `${'n'.repeat(60)}.png`;
    await cargar(await auth([CARGAR]), [
      { buf: PDF, nombre: 'cedula-de-juan.pdf', etiqueta: 'Cédula' },
      { buf: png('l'), nombre: largo, etiqueta: '' },
      { buf: EXE, nombre: 'malo.pdf', etiqueta: 'Malo' },
    ]);
    expect(auditMock).toHaveBeenCalledTimes(2);
    const entradas = auditMock.mock.calls.map((c) => c[1]);
    expect(entradas[0]).toEqual({
      action: 'create', resource: 'flito_soat', resourceId: ID,
      detail: 'Documento adicional cargado (soporte=00000000-0000-4000-8000-000000000001, etiqueta=Cédula)',
    });
    expect(entradas[0].detail).not.toContain('cedula-de-juan');
    expect(entradas[1].detail).toBe(`Documento adicional cargado (soporte=00000000-0000-4000-8000-000000000002, nombre=${'n'.repeat(40)}…)`);
  });
});

describe('TC-47/TC-48 AC10 — limitador de la carga', () => {
  it('30 por usuario: la 31.ª → 429 legible sin subir nada; otro usuario sigue; GET y DELETE no limitados', async () => {
    const token = await auth([CARGAR, 'soat.documentos_adicionales.ver', 'soat.documentos_adicionales.eliminar']);
    const quien = ultimoSub;
    const app = await buildApp();
    for (let i = 0; i < 30; i += 1) {
      const r = await request(app).post(`/api/flito/soat/${ID}/documentos-adicionales`).set('Authorization', token);
      expect(r.status, `petición ${i + 1}`).toBe(400);
    }
    const r31 = await request(app).post(`/api/flito/soat/${ID}/documentos-adicionales`).set('Authorization', token)
      .attach('documentosAdicionales', PDF, { filename: 'a.pdf' });
    expect(r31.status).toBe(429);
    expect(r31.body).toEqual({ error: 'Demasiadas cargas de documentos adicionales. Espera unos minutos e intenta de nuevo.' });
    expect(uploadMock).not.toHaveBeenCalled();
    expect(kdb.insert).not.toHaveBeenCalled();

    const otro = await cargar(await auth([CARGAR]), [{ buf: PDF, nombre: 'a.pdf', etiqueta: 'A' }]);
    expect(otro.status).toBe(201);

    const mismo = await auth([CARGAR, 'soat.documentos_adicionales.ver', 'soat.documentos_adicionales.eliminar'], quien);
    const g = await request(app).get(`/api/flito/soat/${ID}/documentos-adicionales`).set('Authorization', mismo);
    expect(g.status).toBe(200);
    const d = await request(app).delete(`/api/flito/soat/${ID}/documentos-adicionales/00000000-0000-4000-8000-000000000001`)
      .set('Authorization', mismo);
    expect(d.status).toBe(404); // sin fila en el mock: lo que importa es que NO es 429
  });
});
