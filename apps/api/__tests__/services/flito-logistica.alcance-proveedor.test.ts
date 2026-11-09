// HU #14351 (Feature #14326, ADR-0039 §6.4 y §6.5) — Cada ruta abierta al proveedor, sin base: la guarda está montada y el alcance se
// comprueba antes del negocio. Lectura ajena: 404 igual que inexistente. Escritura ajena: 403 igual que inexistente, sin una sola escritura.
// Aquí corre en CI y mide el cableado y el SQL capturado. Que ese SQL filtre de verdad lo prueba db/flito-logistica.alcance-proveedor.pg.test.ts.
import 'express-async-errors';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registrarUsuarioDePrueba, soloEstas, testToken } from '../helpers/auth.js';
import { conAlcance } from '../helpers/frontera.js';
import type { crearCaptura } from '../helpers/alcance-captura.js';

const h = vi.hoisted(() => ({ cap: null as unknown as ReturnType<typeof crearCaptura>, audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/db/client.js', async () => {
  const { crearCaptura: crear } = await import('../helpers/alcance-captura.js');
  h.cap = crear();
  return { db: h.cap.db, getPoolStats: vi.fn() };
});
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: h.audit }));
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: vi.fn().mockResolvedValue('k'), presignedGetEntityDocument: vi.fn().mockResolvedValue('https://u'), getEntityDocumentStream: vi.fn(),
}));
await import('../../src/db/client.js');

const A = '14351000-0000-4000-8000-00000000000a';
const ID = '14351000-0000-4000-8000-0000000000b1';
const ID2 = '14351000-0000-4000-8000-0000000000b2';
const FUNCIONES = ['logistica.consola.ver', 'logistica.consola.filtrar', 'logistica.actas.listar', 'logistica.actas.ver', 'logistica.actas.descargar', 'logistica.actas.despachar',
  'logistica.actas.entregar', 'logistica.actas.devolver', 'logistica.actas.operar_ajenas', 'logistica.actas.firmar_flit', 'logistica.actas.ver_documento_firmante',
  'logistica.documento.ver', 'logistica.documento.reportar_novedad', 'logistica.documento.escanear', 'logistica.lt.validar', 'logistica.ruta.ver',
  'logistica.recogida.confirmar', 'logistica.traslado.registrar', 'logistica.traslado.anular'];

async function app() {
  const a = express();
  a.use(express.json({ limit: '2mb' }));
  const { default: router } = await import('../../src/modules/flito-logistica/flito-logistica.routes.js');
  const { errorHandler } = await import('../../src/shared/middleware/errorHandler.js');
  a.use('/api/flito/logistica', conAlcance('logistica', router));
  a.use(errorHandler);
  return a;
}
let sub = 14351000;
const como = async (tipoEnlace: string, funciones = FUNCIONES) => `Bearer ${await testToken({ sub: ++sub, role: 'xyz_rol' as never, tipoEnlace, funciones })}`;
const deA = () => h.cap.responder([{ c: null, p: A }]);
const wheres = () => h.cap.sqlDeWheres().filter((w) => !w.sql.includes('"users"."id" = '));
const escrituras = () => h.cap.consultas.filter((c) => c.tipo !== 'select' && c.tipo !== 'selectDistinct');
const url = (r: string) => `/api/flito/logistica${r}`;

beforeEach(() => { h.cap.reset(); h.audit.mockClear(); });

describe('AC2 — lectura ajena: 404, con el cuerpo de lo inexistente', () => {
  const LECTURAS: [string, 'get' | 'post', string, object][] = [
    ['detalle del trámite', 'get', `/${ID}`, { error: 'El trámite no existe' }],
    ['detalle del acta', 'get', `/actas/${ID}`, { error: 'El acta no existe' }],
    ['PDF del acta', 'get', `/actas/${ID}/pdf`, { error: 'El acta no existe' }],
    ['mensajeros del acta', 'get', `/actas/${ID}/mensajeros`, { error: 'El acta no existe' }],
    ['línea de tiempo de la LT', 'get', `/documentos/${ID}/linea-tiempo`, { error: 'La LT no existe' }],
    ['línea de tiempo del trámite', 'get', `/tramites/${ID}/linea-tiempo`, { error: 'El trámite no existe' }],
    ['recogida', 'get', `/recogidas/${ID}`, { error: 'La recogida no existe', codigo: 'RECOGIDA_NO_ENCONTRADA' }],
    ['cédula del firmante', 'post', `/recogidas/${ID}/documento`, { error: 'El documento del firmante no está disponible', codigo: 'DOCUMENTO_NO_DISPONIBLE' }],
  ];
  it.each(LECTURAS)('%s', async (_n, metodo, ruta, cuerpo) => {
    deA();
    const r = await request(await app())[metodo](url(ruta)).set('Authorization', await como('proveedor')).send({});
    expect([r.status, r.body]).toEqual([404, cuerpo]);
    expect(escrituras()).toEqual([]);
  });
});

describe('AC3 — escritura ajena: 403 sin escribir y antes de validar negocio', () => {
  const FIRMA = 'data:image/png;base64,iVBORw0KGgo=';
  const ENTREGA = { receptorNombre: 'Ana Demo', receptorDocumento: '1234', firma: FIRMA };
  const ESCRITURAS: [string, string, object][] = [
    ['novedad', `/documentos/${ID}/novedad`, { motivo: 'dañada' }],
    ['despachar acta', `/actas/${ID}/despachar`, { mensajeroId: 1, firmaEntrega: FIRMA }],
    ['entregar acta', `/actas/${ID}/entregar`, ENTREGA],
    ['devolver acta', `/actas/${ID}/devolucion`, { motivo: 'ausente' }],
    ['registrar viaje', '/traslados', { companiaId: 1, destino: 'cliente', lts: [{ documentoId: ID }, { documentoId: ID2 }] }],
    ['despachar viaje', `/traslados/${ID}/despachar`, { mensajeroId: 1 }],
    ['entregar viaje', `/traslados/${ID}/entregar`, ENTREGA],
    ['devolver viaje', `/traslados/${ID}/devolucion`, { motivo: 'ausente' }],
    ['anular viaje', `/traslados/${ID}/anular`, { motivo: 'error' }],
    ['confirmar recogida', '/recogidas/confirmar', { organismoCodigo: '05001', documentoIds: [ID], firmante: { nombre: 'F', documento: '12345', firma: FIRMA } }],
  ];
  it.each(ESCRITURAS)('%s', async (_n, ruta, cuerpo) => {
    deA();
    const r = await request(await app()).post(url(ruta)).set('Authorization', await como('proveedor')).send(cuerpo);
    expect([r.status, r.body]).toEqual([403, { error: 'Sin permisos' }]);
    expect(escrituras()).toEqual([]);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('el id que llega a la condición va en el WHERE, con el dueño', async () => {
    deA();
    await request(await app()).post(url(`/documentos/${ID}/novedad`)).set('Authorization', await como('proveedor')).send({ motivo: 'x' });
    const [w] = wheres();
    expect(w!.sql).toMatch(/"flito_logistica_documentos"\."proveedor_logistica_id" = \$\d/);
    expect(w!.params).toEqual(expect.arrayContaining([A, ID]));
  });

  it('un lote con una sola LT ajena es 403 entero', async () => {
    deA();
    h.cap.responder([{ id: ID }]); // de dos, alcanza una
    const r = await request(await app()).post(url('/traslados')).set('Authorization', await como('proveedor'))
      .send({ companiaId: 1, destino: 'cliente', lts: [{ documentoId: ID }, { documentoId: ID2 }] });
    expect(r.status).toBe(403);
    expect(escrituras()).toEqual([]);
  });
});

describe('§6.3 — la condición va en el WHERE de las listas', () => {
  const dePropietario = (w: { sql: string; params: unknown[] }) => { expect(w.params).toContain(A); };

  it('GET /: en el COUNT y en la página, por LT o por compañía', async () => {
    deA();
    h.cap.responder([{ total: 0 }], []);
    const r = await request(await app()).get(url('/')).set('Authorization', await como('proveedor'));
    expect(r.status).toBe(200);
    const w = wheres();
    expect(w).toHaveLength(2);
    for (const x of w) { expect(x.sql).toContain('d.proveedor_logistica_id'); expect(x.sql).toContain('c.flito_proveedor_logistica_id'); dePropietario(x); }
  });

  it('GET /actas: dueño, corte, sin históricas y sin organismo', async () => {
    deA();
    await request(await app()).get(url('/actas')).set('Authorization', await como('proveedor'));
    const [w] = wheres();
    expect(w!.sql).toContain('"flito_logistica_actas"."proveedor_logistica_id" = ');
    expect(w!.sql).toContain('"flito_logistica_corte_proveedor"');
    expect(w!.sql).toContain('tr.legado');
    expect(w!.sql).toContain('"flito_logistica_actas"."punto" <> ');
    dePropietario(w!);
  });

  it('Operaciones no se afecta: su lista de actas no lee la fecha de corte (AC8 de #14349)', async () => {
    const r = await request(await app()).get(url('/actas')).set('Authorization', await como('ninguno'));
    expect(r.status).toBe(200);
    for (const w of wheres()) expect(w.sql).not.toContain('corte');
  });

  it('un usuario de proveedor sin id de proveedor recibe CERO filas (falla cerrado)', async () => {
    h.cap.responder([{ c: null, p: null }], [{ total: 0 }], []);
    await request(await app()).get(url('/')).set('Authorization', await como('proveedor'));
    const w = wheres();
    expect(w).toHaveLength(2);
    for (const x of w) expect(x.sql).toMatch(/\bfalse\b/);
  });
});

describe('AC6 y R2 — facetas sin precios', () => {
  it('sin cifras: `destinos` por compañía, solo con lo que devuelve la condición', async () => {
    deA();
    h.cap.responder([], [], [{ documentoId: ID, placa: 'ZZA101', numeroLt: 'LT1', idFlit: 'F1', companiaId: 7, nombre: 'Cia', estado: 'clasificado' }], [], [{ valor: 18500, vigenciaId: ID }], []);
    const r = await request(await app()).get(url('/facetas')).set('Authorization', await como('proveedor'));
    expect(r.status).toBe(200);
    const texto = JSON.stringify(r.body);
    for (const prohibido of ['precio', 'tarifa', 'vigencia', '18500', 'proveedorId', 'proveedorLogisticaId']) expect(texto).not.toContain(prohibido);
    expect(r.body.companiasCerrables[0].destinos).toEqual(expect.objectContaining({ cliente: expect.any(Boolean), flit: expect.any(Boolean) }));
  });

  it('H3: con `traslado.registrar` y sin `consola.filtrar` las recibe; sin ninguna de las dos, 403', async () => {
    const conExactas = async (funciones: string[]) => {
      const usuario = ++sub;
      const token = `Bearer ${await testToken({ sub: usuario, role: 'xyz_rol' as never, tipoEnlace: 'proveedor', funciones: [] })}`;
      await registrarUsuarioDePrueba(usuario, { rol: 'xyz_rol', tipoEnlace: 'proveedor', ...soloEstas(funciones) });
      return token;
    };
    deA();
    const si = await request(await app()).get(url('/facetas')).set('Authorization', await conExactas(['logistica.traslado.registrar']));
    expect(si.status).toBe(200);
    h.cap.reset();
    const no = await request(await app()).get(url('/facetas')).set('Authorization', await conExactas(['logistica.consola.ver']));
    expect(no.status).toBe(403);
    expect(h.cap.consultas.filter((c) => c.tipo === 'selectDistinct')).toEqual([]);
  });
});

describe('AC10 — búsqueda, bitácora y PDF', () => {
  it.each(['ninguno', 'proveedor'])('la búsqueda por query se rechaza también a %s, sin consultar', async (enlace) => {
    const r = await request(await app()).get(url('/?buscar=ZZA101')).set('Authorization', await como(enlace));
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain('ZZA101');
    expect(h.cap.consultas.filter((c) => c.tipo === 'selectDistinct')).toEqual([]);
    expect(wheres().filter((w) => w.sql.includes('flito_tramites'))).toEqual([]);
  });

  it('POST /buscar lleva el término al WHERE y la condición del proveedor, sin auditarlo', async () => {
    deA();
    h.cap.responder([{ total: 0 }], []);
    const r = await request(await app()).post(url('/buscar')).set('Authorization', await como('proveedor')).send({ buscar: 'ZZA101' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ items: [], total: 0, page: 1, pageSize: 50 });
    const [w] = wheres();
    expect(w!.params).toEqual(expect.arrayContaining(['%ZZA101%', A]));
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('la ruta `/actas/:id/entregar` ya no escribe el nombre del receptor en el detalle', async () => {
    const fuente = (await import('node:fs')).readFileSync(new URL('../../src/modules/flito-logistica/flito-logistica.routes.ts', import.meta.url), 'utf8');
    expect(fuente).not.toMatch(/detail: `Entrega a \$\{/);
    expect(fuente).toContain("detail: 'Entrega de acta'");
  });
});

describe('D7 — la compañía no despacha actas', () => {
  it('403 antes de consultar el acta, aunque tenga la función', async () => {
    const r = await request(await app()).post(url(`/actas/${ID}/despachar`)).set('Authorization', await como('compania'))
      .send({ mensajeroId: 1, firmaEntrega: 'x' });
    expect([r.status, r.body]).toEqual([403, { error: 'Sin permisos' }]);
    expect(h.cap.consultas).toEqual([]);
  });

  it('y tampoco ve los mensajeros de un acta', async () => {
    const r = await request(await app()).get(url(`/actas/${ID}/mensajeros`)).set('Authorization', await como('compania'));
    expect([r.status, r.body]).toEqual([403, { error: 'Sin permisos' }]);
  });
});

describe('Rutas que la compañía conserva cerradas (P-2): el nuevo enlace no se las abre', () => {
  it.each([
    ['get', '/mi-ruta'], ['post', '/escanear'], ['post', '/validar-lt'], ['post', '/consultar-vehiculo'], ['post', '/traslados'], ['post', '/traslados/buscar'],
    ['post', `/traslados/${ID}/despachar`], ['post', `/traslados/${ID}/entregar`], ['post', `/traslados/${ID}/devolucion`], ['post', `/traslados/${ID}/anular`],
    ['post', '/recogidas/confirmar'], ['get', '/recogidas/mias'], ['get', '/recogidas/pendientes-firma'], ['get', `/recogidas/${ID}`], ['post', `/recogidas/${ID}/documento`],
    ['get', `/documentos/${ID}/linea-tiempo`], ['get', `/tramites/${ID}/linea-tiempo`],
  ] as const)('%s %s', async (metodo, ruta) => {
    const r = await request(await app())[metodo](url(ruta)).set('Authorization', await como('compania')).send({});
    expect([r.status, r.body]).toEqual([403, { error: 'Sin permisos' }]);
    expect(h.cap.consultas).toEqual([]);
  });
});
