// HU #14349 y #14351 (Feature #14326, ADR-0039 §6.3 a §6.5, §7.2) — A sobre B en cada ruta, contra PostgreSQL de verdad: un mock no prueba un WHERE. Todo
// dentro de una transacción con ROLLBACK, por HTTP y con los routers reales. Se SALTA sin TEST_DATABASE_URL. En la tx `now()` no avanza y la fecha de
// corte es anterior a ella: lo «anterior al corte» se fabrica con `created_at` en el pasado.
import 'express-async-errors';
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { abrirBase, enTx, URL_BASE } from '../helpers/base-en-tx.js';
import { conAlcance } from '../helpers/frontera.js';
import { testToken } from '../helpers/auth.js';

const actual: { db: ReturnType<typeof drizzle<typeof schema>> | null } = { db: null };
vi.mock('../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn() }));
const auditMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../src/shared/middleware/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: vi.fn().mockResolvedValue('k'), presignedGetEntityDocument: vi.fn().mockResolvedValue('https://firmada'), getEntityDocumentStream: vi.fn(),
}));
vi.mock('../../src/modules/flito-logistica/flito-logistica.acta-pdf.js', async (original) => ({
  ...await original<object>(), generarActaPdf: vi.fn().mockResolvedValue('pdf'), urlActaPdf: vi.fn().mockResolvedValue('https://firmada'),
}));
vi.mock('../../src/modules/flito-parametrizacion/flito-tarifas.service.js', () => ({
  tarifaDe: vi.fn().mockImplementation(async (_c: number, concepto: string) => (concepto === 'logistica_flit'
    ? { valor: null, origen: null, vigenciaId: null } : { valor: 18500, origen: 'generica', vigenciaId: null })),
}));
vi.mock('../../src/db/client.js', () => ({
  db: new Proxy({}, {
    get(_t, prop) {
      if (prop === 'transaction') return (fn: (tx: unknown) => unknown) => fn(actual.db);
      const d = actual.db as unknown as Record<string | symbol, unknown>;
      const v = d[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(d) : v;
    },
  }),
  getPoolStats: vi.fn(),
}));

const FUNCIONES = ['logistica.consola.ver', 'logistica.consola.filtrar', 'logistica.actas.listar', 'logistica.actas.ver', 'logistica.actas.descargar', 'logistica.actas.despachar',
  'logistica.actas.entregar', 'logistica.actas.devolver', 'logistica.actas.operar_ajenas', 'logistica.actas.ver_documento_firmante',
  'logistica.documento.ver', 'logistica.documento.reportar_novedad', 'logistica.documento.escanear', 'logistica.lt.validar', 'logistica.ruta.ver',
  'logistica.recogida.confirmar', 'logistica.traslado.registrar', 'logistica.traslado.anular'];
const FIRMA = 'data:image/png;base64,iVBORw0KGgo=';
const INEXISTENTE = '14351000-0000-4000-8000-0000000000ff';
const AYER = new Date(Date.now() - 86_400_000).toISOString();
let n = 0;
const sello = () => `${String(Date.now()).slice(-6)}${n++}`;

type Tx = postgres.TransactionSql;
interface Mundo {
  tx: Tx; A: string; B: string; org: string; app: express.Express;
  usuarioA: number; usuarioB: number; ops: number; mensajeroA: number; mensajeroB: number; mensajeroFlito: number;
  tokenA: string; tokenOps: string; tokenMensajeroA: string;
  cia: (p: string | null, auto?: boolean) => Promise<number>;
  lt: (cia: number, dueno: string | null, o?: { estado?: string; actaId?: string; actor?: number; propietario?: string; firmante?: string; creado?: string }) => Promise<{ doc: string; tramite: string; placa: string }>;
  tramiteSinLt: (cia: number) => Promise<string>;
  viaje: (cia: number, dueno: string | null, o?: { estado?: string; destino?: string; creado?: string; legado?: boolean; mensajero?: number }) => Promise<{ traslado: string; acta: string }>;
  firmante: (dueno: string | null, o?: { registradoPor?: number; firmado?: string }) => Promise<string>;
  fila: (id: string) => Promise<unknown>;
}

async function conMundo(fn: (m: Mundo) => Promise<void>) {
  const sql = abrirBase();
  try {
    await enTx(sql, async (tx) => {
      actual.db = drizzle(Object.assign(tx, { options: sql.options }) as unknown as postgres.Sql, { schema });
      const prov = async (nombre: string) => (await tx`INSERT INTO flito_proveedores_logistica (nombre, activo, nit, contacto, telefono)
        VALUES (${`${nombre} ${sello()}`}, true, ${`9${sello()}`}, 'Ana', '3001112233') RETURNING id`)[0]!.id as string;
      const A = await prov('A'); const B = await prov('B');
      const rolProv = `hu14351_${sello()}`;
      await tx`INSERT INTO permisos_roles (codigo, nombre, tipo_enlace, tipo_principal, es_sistema, activo) VALUES (${rolProv}, ${rolProv}, 'proveedor', 'interno', false, true)`;
      await tx`INSERT INTO permisos_rol_funcion (rol_codigo, funcion_codigo) SELECT ${rolProv}, funcion_codigo FROM permisos_rol_funcion WHERE rol_codigo = 'mensajero'`;
      const usuario = async (role: string, nombre: string, proveedor: string | null = null) => (await tx`INSERT INTO users (username, name, password_hash, role, flito_proveedor_id)
        VALUES (${`hu14351-${sello()}`}, ${nombre}, 'x', ${role}, ${proveedor}) RETURNING id`)[0]!.id as number;
      const usuarioA = await usuario(rolProv, 'Coordinador de A', A);
      const usuarioB = await usuario(rolProv, 'Coordinador de B', B);
      const ops = await usuario('admin', 'Operador de FLITO');
      const mensajeroA = await usuario(rolProv, 'Mensajero de A', A);
      const mensajeroB = await usuario(rolProv, 'Mensajero de B', B);
      const mensajeroFlito = await usuario('mensajero', 'Mensajero de FLITO');
      const org = (await tx`SELECT codigo FROM organismos_transito_config LIMIT 1`)[0]?.codigo as string
        ?? (await tx`INSERT INTO organismos_transito_config (codigo, activo) VALUES ('99999', true) RETURNING codigo`)[0]!.codigo as string;
      const { default: router } = await import('../../src/modules/flito-logistica/flito-logistica.routes.js');
      const { default: motivos } = await import('../../src/modules/flito-logistica/flito-logistica-motivos.routes.js');
      const { errorHandler } = await import('../../src/shared/middleware/errorHandler.js');
      const app = express();
      app.use(express.json({ limit: '2mb' }));
      app.use('/api/flito/logistica/motivos-llegada', conAlcance('logistica', motivos));
      app.use('/api/flito/logistica', conAlcance('logistica', router));
      app.use(errorHandler);
      const firmar = async (sub: number, role: string, tipoEnlace: string, funciones: string[]) => `Bearer ${await testToken({ sub, role: role as never, tipoEnlace, funciones })}`;
      const nuevoVehiculo = async () => {
        const placa = `Z${sello().slice(-6)}`;
        const [v] = await tx`INSERT INTO vehicles (plate, vin) VALUES (${placa}, ${`VIN${placa}`}) RETURNING id`;
        return { id: v!.id as number, placa };
      };
      const nuevoTramite = async (cia: number, vehiculoId: number) => (await tx`INSERT INTO flito_tramites (id_flit, sincronizado_en, vehiculo_id, compania_id, compania_nit, organismo_codigo, flit_estado)
        VALUES (${`F${sello()}`}, now(), ${vehiculoId}, ${cia}, ${`9${sello()}`}, ${org}, 'Aprobado') RETURNING id`)[0]!.id as string;
      const m: Mundo = {
        tx, A, B, org, app, usuarioA, usuarioB, ops, mensajeroA, mensajeroB, mensajeroFlito,
        tokenA: await firmar(usuarioA, rolProv, 'proveedor', FUNCIONES),
        tokenOps: await firmar(ops, 'admin', 'ninguno', [...FUNCIONES, 'logistica.documento.dejar_pendiente']),
        tokenMensajeroA: await firmar(mensajeroA, rolProv, 'proveedor', FUNCIONES.filter((f) => f !== 'logistica.actas.operar_ajenas')),
        cia: async (p, auto = false) => (await tx`INSERT INTO clients (name, document, flito_proveedor_logistica_id, logistica_autogestionable)
          VALUES (${`Cia ${sello()}`}, ${`D${sello()}`}, ${p}, ${auto}) RETURNING id`)[0]!.id as number,
        tramiteSinLt: async (cia) => nuevoTramite(cia, (await nuevoVehiculo()).id),
        lt: async (cia, dueno, o = {}) => {
          const v = await nuevoVehiculo();
          const tramite = await nuevoTramite(cia, v.id);
          const [d] = await tx`INSERT INTO flito_logistica_documentos (tramite_id, tipo, estado, organismo_codigo, compania_id, vehiculo_id, identificador, numero_licencia, numero_lt, proveedor_logistica_id, acta_id,
              propietario_nombre, propietario_documento, foto_storage_key, combustible, recogida_firmante_id, acta_organismo_pendiente, created_at)
            VALUES (${tramite}, 'licencia_transito', ${o.estado ?? 'clasificado'}, ${org}, ${cia}, ${v.id}, ${v.placa}, ${`L${sello()}`}, 'LT1', ${dueno}, ${o.actaId ?? null},
              ${o.propietario ?? 'Propietaria Demo'}, '998877', 'foto/key', 'GASOLINA', ${o.firmante ?? null}, ${o.firmante ? false : true}, ${o.creado ?? new Date().toISOString()}) RETURNING id`;
          if (o.actor !== undefined) {
            await tx`INSERT INTO flito_logistica_documento_eventos (documento_id, estado_anterior, estado_nuevo, actor_id, origen, tipo, lat, lng) VALUES (${d!.id as string}, NULL, 'recogido', ${o.actor}, 'usuario', 'recogida', '4.1', '-74.1')`;
          }
          return { doc: d!.id as string, tramite, placa: v.placa };
        },
        viaje: async (cia, dueno, o = {}) => {
          const estadoActa = o.estado ?? 'generada';
          const estadoViaje = estadoActa === 'generada' ? 'registrado' : estadoActa === 'despachada' ? 'en_ruta' : 'entregado';
          const destino = o.destino ?? 'cliente';
          const origen = 'organismo';
          const [t] = await tx`INSERT INTO flito_logistica_traslados (compania_id, destino, origen, estado, registrado_por_id, registrado_en, mensajero_id, legado)
            VALUES (${cia}, ${destino}, ${origen}, ${estadoViaje}, ${ops}, now(), ${o.mensajero ?? null}, ${o.legado ?? false}) RETURNING id`;
          const [a] = await tx`INSERT INTO flito_logistica_actas (compania_id, punto, estado, proveedor_logistica_id, traslado_id, mensajero_id, created_at)
            VALUES (${cia}, ${destino}, ${estadoActa}, ${dueno}, ${t!.id as string}, ${o.mensajero ?? null}, ${o.creado ?? new Date().toISOString()}) RETURNING id`;
          return { traslado: t!.id as string, acta: a!.id as string };
        },
        firmante: async (dueno, o = {}) => (await tx`INSERT INTO flito_logistica_recogida_firmantes (id, organismo_codigo, nombre, documento_ultimos, firma_storage_key, registrado_por_id, firmado_en, proveedor_logistica_id)
          VALUES (gen_random_uuid(), ${org}, 'Funcionario Demo', '1234', 'firma/k', ${o.registradoPor ?? ops}, ${o.firmado ?? new Date().toISOString()}, ${dueno}) RETURNING id`)[0]!.id as string,
        fila: async (id) => (await tx`SELECT row_to_json(x) j FROM (
          SELECT id, estado::text, updated_at, acta_id, numero_lt, proveedor_logistica_id FROM flito_logistica_documentos WHERE id = ${id}
          UNION ALL SELECT id, estado::text, updated_at, NULL, NULL, proveedor_logistica_id FROM flito_logistica_actas WHERE id = ${id}) x`)[0]?.j,
      };
      await fn(m);
    });
  } finally { actual.db = null; await sql.end(); }
}

const ruta = (r: string) => `/api/flito/logistica${r}`;
const obtener = (m: Mundo, r: string, t: string) => request(m.app).get(ruta(r)).set('Authorization', t);
const enviar = (m: Mundo, r: string, t: string, cuerpo: object = {}) => request(m.app).post(ruta(r)).set('Authorization', t).send(cuerpo);
const cuerpoIgual = (a: request.Response, b: request.Response) => { expect([a.status, a.text]).toEqual([b.status, b.text]); };

describe.skipIf(!URL_BASE)('alcance del proveedor (PostgreSQL, tx con ROLLBACK)', () => {
  describe('#14351 AC1 — los trámites llegan al proveedor', () => {
    it('A ve el trámite de su compañía, con y sin LT; B y una autogestionada no', () => conMundo(async (m) => {
      const ciaA = await m.cia(m.A);
      const sinLt = await m.tramiteSinLt(ciaA);
      const conLt = await m.lt(ciaA, m.A);
      const deB = await m.lt(await m.cia(m.B), m.B);
      const auto = await m.tramiteSinLt(await m.cia(m.A, true));
      const r = await obtener(m, '/?pageSize=200', m.tokenA);
      const ids = r.body.items.map((i: { tramiteId: string }) => i.tramiteId);
      expect(ids).toEqual(expect.arrayContaining([sinLt, conLt.tramite]));
      expect(ids).not.toContain(deB.tramite);
      expect(ids).not.toContain(auto);
      expect(r.body.total).toBe(ids.length);
    }));

    it('el nuevo proveedor no ve por la compañía lo que entregó el anterior: manda el dueño estampado', () => conMundo(async (m) => {
      const c = await m.cia(m.A);
      const entregada = await m.lt(c, m.B, { estado: 'entregado' });
      const r = await obtener(m, '/?pageSize=200', m.tokenA);
      expect(r.body.items.map((i: { tramiteId: string }) => i.tramiteId)).not.toContain(entregada.tramite);
    }));

    it('POST /buscar y GET / dan la misma respuesta y la misma condición', () => conMundo(async (m) => {
      const c = await m.cia(m.A);
      const propia = await m.lt(c, m.A);
      await m.lt(await m.cia(m.B), m.B);
      const b = await enviar(m, '/buscar', m.tokenA, { buscar: propia.placa, pageSize: 50 });
      expect(b.status).toBe(200);
      expect(b.body.items.map((i: { tramiteId: string }) => i.tramiteId)).toEqual([propia.tramite]);
      expect(Object.keys(b.body).sort()).toEqual(['items', 'page', 'pageSize', 'total']);
    }));
  });

  describe('#14351 AC2 — lectura de filas de B: 404, igual que inexistente', () => {
    it('en cada ruta de lectura', () => conMundo(async (m) => {
      const ciaB = await m.cia(m.B);
      const b = await m.lt(ciaB, m.B);
      const v = await m.viaje(ciaB, m.B);
      const f = await m.firmante(m.B);
      const pares: [string, string][] = [
        [`/${b.tramite}`, `/${INEXISTENTE}`],
        [`/actas/${v.acta}`, `/actas/${INEXISTENTE}`],
        [`/actas/${v.acta}/pdf`, `/actas/${INEXISTENTE}/pdf`],
        [`/actas/${v.acta}/mensajeros`, `/actas/${INEXISTENTE}/mensajeros`],
        [`/documentos/${b.doc}/linea-tiempo`, `/documentos/${INEXISTENTE}/linea-tiempo`],
        [`/tramites/${b.tramite}/linea-tiempo`, `/tramites/${INEXISTENTE}/linea-tiempo`],
        [`/recogidas/${f}`, `/recogidas/${INEXISTENTE}`],
      ];
      for (const [ajena, inexistente] of pares) {
        const x = await obtener(m, ajena, m.tokenA);
        const y = await obtener(m, inexistente, m.tokenA);
        expect(x.status, ajena).toBe(404);
        cuerpoIgual(x, y);
      }
      // H5 (§9.5): la cédula completa está cerrada al proveedor; ajena e inexistente responden el mismo 403.
      const x = await enviar(m, `/recogidas/${f}/documento`, m.tokenA);
      expect(x.status).toBe(403);
      cuerpoIgual(x, await enviar(m, `/recogidas/${INEXISTENTE}/documento`, m.tokenA));
    }));

    it('en las listas: ni el acta de B ni sus compañías ni sus viajes', () => conMundo(async (m) => {
      const ciaB = await m.cia(m.B);
      const b = await m.lt(ciaB, m.B, { actor: m.usuarioB });
      const v = await m.viaje(ciaB, m.B);
      const f = await m.firmante(m.B, { registradoPor: m.usuarioA });
      const texto = (await Promise.all([
        obtener(m, '/actas', m.tokenA), obtener(m, '/facetas', m.tokenA), enviar(m, '/traslados/buscar', m.tokenA), obtener(m, '/mi-ruta', m.tokenA),
        obtener(m, '/recogidas/mias', m.tokenA), obtener(m, '/recogidas/pendientes-firma', m.tokenA), obtener(m, '/?pageSize=200', m.tokenA),
      ])).map((r) => { expect(r.status).toBe(200); return r.text; }).join(' ');
      for (const ajeno of [b.doc, b.tramite, v.acta, v.traslado, f]) expect(texto).not.toContain(ajeno);
      const companias = (await enviar(m, '/traslados/buscar', m.tokenA)).body.companias;
      expect(companias.map((c: { companiaId: number }) => c.companiaId)).not.toContain(ciaB);
    }));
  });

  describe('#14351 AC3 — escritura de filas de B: 403 igual que inexistente, antes del negocio, sin cambiar la fila', () => {
    it('en cada ruta de escritura y en cada estado', () => conMundo(async (m) => {
      const ciaB = await m.cia(m.B);
      for (const estado of ['generada', 'despachada', 'entregada', 'devuelta']) {
        const v = await m.viaje(ciaB, m.B, { estado });
        const b = await m.lt(ciaB, m.B, { actaId: v.acta, estado: estado === 'entregada' ? 'entregado' : 'en_acta' });
        const antes = [await m.fila(v.acta), await m.fila(b.doc)];
        const ENTREGA = { receptorNombre: 'Ana', receptorDocumento: '1234', firma: FIRMA };
        const casos: [string, string, object][] = [
          [`/documentos/${b.doc}/novedad`, `/documentos/${INEXISTENTE}/novedad`, { motivo: 'x' }],
          [`/actas/${v.acta}/despachar`, `/actas/${INEXISTENTE}/despachar`, { mensajeroId: m.mensajeroA, firmaEntrega: FIRMA }],
          [`/actas/${v.acta}/entregar`, `/actas/${INEXISTENTE}/entregar`, ENTREGA],
          [`/actas/${v.acta}/devolucion`, `/actas/${INEXISTENTE}/devolucion`, { motivo: 'x' }],
          [`/traslados/${v.traslado}/despachar`, `/traslados/${INEXISTENTE}/despachar`, { mensajeroId: m.mensajeroA }],
          [`/traslados/${v.traslado}/entregar`, `/traslados/${INEXISTENTE}/entregar`, ENTREGA],
          [`/traslados/${v.traslado}/devolucion`, `/traslados/${INEXISTENTE}/devolucion`, { motivo: 'x' }],
          [`/traslados/${v.traslado}/anular`, `/traslados/${INEXISTENTE}/anular`, { motivo: 'x' }],
        ];
        for (const [ajena, inexistente, cuerpo] of casos) {
          const x = await enviar(m, ajena, m.tokenA, cuerpo);
          expect([ajena, x.status, x.body]).toEqual([ajena, 403, { error: 'Sin permisos' }]);
          cuerpoIgual(x, await enviar(m, inexistente, m.tokenA, cuerpo));
        }
        const lote = (id: string) => ({ companiaId: ciaB, destino: 'cliente', lts: [{ documentoId: id }] });
        const x = await enviar(m, '/traslados', m.tokenA, lote(b.doc));
        expect(x.status).toBe(403);
        cuerpoIgual(x, await enviar(m, '/traslados', m.tokenA, lote(INEXISTENTE)));
        const recogida = (id: string) => ({ organismoCodigo: m.org, documentoIds: [id], firmante: { nombre: 'F', documento: '12345', firma: FIRMA } });
        const y = await enviar(m, '/recogidas/confirmar', m.tokenA, recogida(b.doc));
        expect(y.status).toBe(403);
        cuerpoIgual(y, await enviar(m, '/recogidas/confirmar', m.tokenA, recogida(INEXISTENTE)));
        expect([await m.fila(v.acta), await m.fila(b.doc)]).toEqual(antes);
      }
    }));

    it('una sola LT ajena en el lote de un viaje propio: 403 y nada se crea', () => conMundo(async (m) => {
      const ciaA = await m.cia(m.A);
      const propia = await m.lt(ciaA, m.A, { actor: m.usuarioA });
      const ajena = await m.lt(await m.cia(m.B), m.B);
      const r = await enviar(m, '/traslados', m.tokenA, { companiaId: ciaA, destino: 'cliente', lts: [{ documentoId: propia.doc }, { documentoId: ajena.doc }] });
      expect(r.status).toBe(403);
      expect((await m.tx`SELECT count(*)::int c FROM flito_logistica_traslados WHERE compania_id = ${ciaA}`)[0]!.c).toBe(0);
    }));
  });

  describe('#14351 AC4 — el flujo completo funciona con lo propio', () => {
    it('registra, despacha con su mensajero y entrega; sin la función de un paso, 403', () => conMundo(async (m) => {
      const ciaA = await m.cia(m.A);
      const lt = await m.lt(ciaA, m.A, { actor: m.usuarioA });
      const reg = await enviar(m, '/traslados', m.tokenA, { companiaId: ciaA, destino: 'cliente', lts: [{ documentoId: lt.doc }] });
      expect(reg.status).toBe(200);
      const desp = await enviar(m, `/traslados/${reg.body.id}/despachar`, m.tokenA, { mensajeroId: m.mensajeroA });
      expect(desp.status).toBe(200);
      const sinEntregar = await testToken({ sub: m.usuarioA, role: 'x' as never, tipoEnlace: 'proveedor', funciones: [] });
      const noPuede = await enviar(m, `/traslados/${reg.body.id}/devolucion`, `Bearer ${sinEntregar}`, { motivo: 'x' });
      expect(noPuede.status).toBe(403);
      const entrega = await enviar(m, `/traslados/${reg.body.id}/entregar`, m.tokenMensajeroA, { receptorNombre: 'Ana', receptorDocumento: '123456', firma: FIRMA });
      expect(entrega.status).toBe(200);
      expect(entrega.body.estado).toBe('entregado');
    }));

    it('recogida: confirma sus LT, el firmante queda con A y el acta de organismo no sale en la lista; devolución del viaje propio', () => conMundo(async (m) => {
      const ciaA = await m.cia(m.A);
      const lt = await m.lt(ciaA, m.A, { actor: m.usuarioA });
      const r = await enviar(m, '/recogidas/confirmar', m.tokenA, { organismoCodigo: m.org, documentoIds: [lt.doc], firmante: { nombre: 'Funcionario', documento: '123456', firma: FIRMA } });
      expect(r.status).toBe(200);
      expect((await m.tx`SELECT proveedor_logistica_id p FROM flito_logistica_recogida_firmantes WHERE id = ${r.body.firmanteId as string}`)[0]!.p).toBe(m.A);
      const detalle = await obtener(m, `/recogidas/${r.body.firmanteId}`, m.tokenA);
      expect(detalle.status).toBe(200);
      expect(detalle.text).not.toContain('123456');
      expect(detalle.body.documentoEnmascarado).toMatch(/3456$/);
      const actaOrganismo = r.body.actas[0].actaId as string;
      expect((await obtener(m, '/actas', m.tokenA)).body.map((a: { id: string }) => a.id)).not.toContain(actaOrganismo);
      expect((await obtener(m, `/actas/${actaOrganismo}`, m.tokenA)).status).toBe(200);
      const logPii = async () => (await m.tx`SELECT count(*)::int c FROM pii_access_log WHERE resource_tipo = 'flito_logistica_recogida_firmante'`)[0]!.c as number;
      const antes = await logPii();
      // H5 (§9.5): ni la propia cédula completa sale al proveedor, aunque tenga la función; no hay lectura que registrar.
      const cedula = await enviar(m, `/recogidas/${r.body.firmanteId}/documento`, m.tokenA);
      expect([cedula.status, cedula.text.includes('123456')]).toEqual([403, false]);
      expect(await logPii()).toBe(antes);

      const dev = await m.viaje(ciaA, m.A, { estado: 'despachada', mensajero: m.mensajeroA });
      const enRuta = await m.lt(ciaA, m.A, { actaId: dev.acta, estado: 'despachado' });
      await m.tx`INSERT INTO flito_logistica_traslado_lts (traslado_id, destino, documento_id, estado, concepto_precio, precio) VALUES (${dev.traslado}, 'cliente', ${enRuta.doc}, 'en_ruta', 'logistica_cliente', 18500)`;
      const devuelto = await enviar(m, `/traslados/${dev.traslado}/devolucion`, m.tokenMensajeroA, { motivo: 'Ausente' });
      expect([devuelto.status, devuelto.body.estado]).toEqual([200, 'devuelto']);
    }));

    it('AC10: entregar un acta no deja el nombre del receptor en la bitácora; el PDF queda en `pii_access_log`', () => conMundo(async (m) => {
      const ciaA = await m.cia(m.A);
      const v = await m.viaje(ciaA, m.A, { estado: 'despachada', mensajero: m.mensajeroA });
      const lt = await m.lt(ciaA, m.A, { actaId: v.acta, estado: 'despachado' });
      await m.tx`INSERT INTO flito_logistica_traslado_lts (traslado_id, destino, documento_id, estado, concepto_precio, precio) VALUES (${v.traslado}, 'cliente', ${lt.doc}, 'en_ruta', 'logistica_cliente', 18500)`;
      auditMock.mockClear();
      const r = await enviar(m, `/actas/${v.acta}/entregar`, m.tokenMensajeroA, { receptorNombre: 'Receptora Privada', receptorDocumento: '555444', firma: FIRMA });
      expect(r.status).toBe(200);
      expect(JSON.stringify(auditMock.mock.calls.map((c) => c[1]))).not.toContain('Receptora Privada');
      const pdf = async () => (await m.tx`SELECT count(*)::int c FROM pii_access_log WHERE resource_tipo = 'flito_logistica_acta_pdf'`)[0]!.c as number;
      const antes = await pdf();
      const url = await obtener(m, `/actas/${v.acta}/pdf`, m.tokenA);
      expect([url.status, url.headers['cache-control']]).toEqual([200, 'no-store']);
      expect(await pdf()).toBe(antes + 1);
    }));

    it('N4: el viaje a FLIT no se firma por el proveedor, ni por el viaje ni por el acta, aunque sea suyo', () => conMundo(async (m) => {
      const ciaA = await m.cia(m.A);
      const v = await m.viaje(ciaA, m.A, { estado: 'despachada', destino: 'flit', mensajero: m.usuarioA });
      const b = await m.lt(ciaA, m.A, { actaId: v.acta, estado: 'despachado' });
      const antes = [await m.fila(v.acta), await m.fila(b.doc)];
      const token = `Bearer ${await testToken({ sub: m.usuarioA, role: 'x' as never, tipoEnlace: 'proveedor', funciones: [...FUNCIONES, 'logistica.actas.firmar_flit'] })}`;
      expect((await enviar(m, `/traslados/${v.traslado}/entregar`, token, { firma: FIRMA })).status).toBe(403);
      expect((await enviar(m, `/actas/${v.acta}/entregar`, token, { receptorNombre: 'A', receptorDocumento: '123', firma: FIRMA })).status).toBe(403);
      expect((await enviar(m, `/actas/${v.acta}/devolucion`, token, { motivo: 'x' })).status).toBe(403);
      expect([await m.fila(v.acta), await m.fila(b.doc)]).toEqual(antes);
    }));
  });

  describe('#14351 AC6 — proyección', () => {
    it('`POST /traslados`: sin precio ni vigencia; Operaciones los conserva', () => conMundo(async (m) => {
      const ciaA = await m.cia(m.A);
      const lt = await m.lt(ciaA, m.A, { actor: m.usuarioA });
      const r = await enviar(m, '/traslados', m.tokenA, { companiaId: ciaA, destino: 'cliente', lts: [{ documentoId: lt.doc }] });
      expect(r.status).toBe(200);
      for (const prohibido of ['precio', 'tarifa', '18500', 'proveedorLogisticaId']) expect(r.text).not.toContain(prohibido);
      const otra = await m.lt(ciaA, m.A);
      const o = await enviar(m, '/traslados', m.tokenOps, { companiaId: ciaA, destino: 'cliente', lts: [{ documentoId: otra.doc }] });
      expect(o.body.lts[0].precio).toBe(18500);
    }));

    it('R2 y sin precio configurado: `destinos` sin cifras y un mensaje sin la palabra precio ni Tarifas', () => conMundo(async (m) => {
      const ciaA = await m.cia(m.A);
      const lt = await m.lt(ciaA, m.A, { actor: m.usuarioA });
      const f = await obtener(m, '/facetas', m.tokenA);
      const c = f.body.companiasCerrables.find((x: { companiaId: number }) => x.companiaId === ciaA);
      expect(c.destinos).toEqual({ cliente: true, flit: false });
      expect(f.text).not.toMatch(/precio|tarifa|18500|proveedorId/i);
      const sin = await enviar(m, '/traslados', m.tokenA, { companiaId: ciaA, destino: 'flit', motivoLlegadaId: await motivo(m), lts: [{ documentoId: lt.doc }] });
      expect(sin.status).toBe(422);
      expect(sin.body.codigo).toBe('PRECIO_TRASLADO_NO_CONFIGURADO');
      expect(sin.body.error).not.toMatch(/precio|tarifa|\d/i);
    }));

    it('H2: fuera de las listas; en `GET /:id` sigue el nombre, sin documento ni foto. Operaciones no cambia', () => conMundo(async (m) => {
      const ciaA = await m.cia(m.A);
      const v = await m.viaje(ciaA, m.A);
      const lt = await m.lt(ciaA, m.A, { actaId: v.acta, propietario: 'Propietaria Unica' });
      const lista = await obtener(m, '/?pageSize=200', m.tokenA);
      expect(lista.text).not.toContain('Propietaria Unica');
      expect(lista.body.items[0]).not.toHaveProperty('propietario');
      const acta = await obtener(m, `/actas/${v.acta}`, m.tokenA);
      expect(acta.status).toBe(200);
      expect(acta.text).not.toContain('Propietaria Unica');
      expect(acta.body.documentos[0]).not.toHaveProperty('propietario');
      const detalle = await obtener(m, `/${lt.tramite}`, m.tokenA);
      expect(detalle.body.propietario).toBe('Propietaria Unica');
      expect(detalle.text).not.toContain('998877');
      expect(detalle.body).not.toHaveProperty('propietarioDocumento');
      expect(detalle.body).not.toHaveProperty('tieneFoto');
      const ops = await obtener(m, `/${lt.tramite}`, m.tokenOps);
      expect(ops.body.propietarioDocumento).toBe('998877');
      expect(ops.body.tieneFoto).toBe(true);
      expect((await obtener(m, `/actas/${v.acta}`, m.tokenOps)).body.documentos[0].propietario).toBe('Propietaria Unica');
    }));

    it('`GET /actas`: sin `proveedorLogisticaId`, que Operaciones sí recibe; un mensajero ajeno sale sin nombre', () => conMundo(async (m) => {
      const ciaA = await m.cia(m.A);
      const v = await m.viaje(ciaA, m.A, { mensajero: m.mensajeroFlito });
      await m.lt(ciaA, m.A, { actaId: v.acta });
      const a = (await obtener(m, '/actas', m.tokenA)).body.find((x: { id: string }) => x.id === v.acta);
      expect(a).not.toHaveProperty('proveedorLogisticaId');
      expect(a).not.toHaveProperty('mensajeroProveedorId');
      expect(a.mensajeroNombre).toBeNull();
      expect(a.documentos).toBe(1);
      const o = (await obtener(m, '/actas', m.tokenOps)).body.find((x: { id: string }) => x.id === v.acta);
      expect(o.proveedorLogisticaId).toBe(m.A);
      expect(o.mensajeroNombre).toBe('Mensajero de FLITO');
      expect(o).not.toHaveProperty('mensajeroProveedorId');
    }));

    it('el actor ajeno llega nulo, con la misma forma; el suyo, con nombre', () => conMundo(async (m) => {
      const ciaA = await m.cia(m.A);
      const lt = await m.lt(ciaA, m.A, { actor: m.ops });
      await m.tx`INSERT INTO flito_logistica_documento_eventos (documento_id, estado_anterior, estado_nuevo, actor_id, origen, tipo) VALUES (${lt.doc}, 'recogido', 'clasificado', ${m.usuarioA}, 'usuario', 'novedad')`;
      const linea = await obtener(m, `/documentos/${lt.doc}/linea-tiempo`, m.tokenA);
      const nombres = linea.body.hitos.map((h: { actorNombre: string | null }) => h.actorNombre).sort();
      expect(nombres).toEqual(['Coordinador de A', null].sort());
      const detalle = await obtener(m, `/${lt.tramite}`, m.tokenA);
      const ajeno = detalle.body.eventos.find((e: { estadoNuevo: string }) => e.estadoNuevo === 'recogido');
      expect(ajeno).toMatchObject({ actorNombre: null, lat: null, lng: null });
      expect(ajeno).not.toHaveProperty('actorProveedorId');
      expect((await obtener(m, `/documentos/${lt.doc}/linea-tiempo`, m.tokenOps)).body.hitos.map((h: { actorNombre: string }) => h.actorNombre)).toContain('Operador de FLITO');
    }));

    it('un acta de A con una LT de B no se la muestra a A: ni fila, ni conteo, ni bitácora', () => conMundo(async (m) => {
      const ciaA = await m.cia(m.A);
      const v = await m.viaje(ciaA, m.A);
      const propia = await m.lt(ciaA, m.A, { actaId: v.acta, actor: m.usuarioA });
      const deB = await m.lt(ciaA, m.B, { actaId: v.acta, actor: m.usuarioB });
      const r = await obtener(m, `/actas/${v.acta}`, m.tokenA);
      expect(r.body.documentos.map((d: { id: string }) => d.id)).toEqual([propia.doc]);
      expect(r.body.acta.documentos).toBe(1);
      expect(r.text).not.toContain(deB.doc);
      expect(r.text).not.toContain(deB.placa);
      expect((await obtener(m, '/actas', m.tokenA)).body.find((x: { id: string }) => x.id === v.acta).documentos).toBe(1);
      expect((await obtener(m, `/actas/${v.acta}`, m.tokenOps)).body.documentos).toHaveLength(2);
    }));
  });

  describe('#14351 AC7 — el mensajero, lo suyo; el coordinador, lo de A', () => {
    it('ruta y recogidas', () => conMundo(async (m) => {
      const ciaA = await m.cia(m.A);
      const delMensajero = await m.viaje(ciaA, m.A, { estado: 'despachada', mensajero: m.mensajeroA });
      const deOtro = await m.viaje(ciaA, m.A, { estado: 'despachada', mensajero: m.usuarioA });
      const deB = await m.viaje(await m.cia(m.B), m.B, { estado: 'despachada', mensajero: m.mensajeroB });
      const actas = (r: request.Response) => r.body.entregas.map((e: { actaId: string }) => e.actaId);
      const suyo = actas(await obtener(m, '/mi-ruta', m.tokenMensajeroA));
      expect(suyo).toContain(delMensajero.acta);
      expect(suyo).not.toContain(deOtro.acta);
      const coordinador = actas(await obtener(m, '/mi-ruta', m.tokenA));
      expect(coordinador).toEqual(expect.arrayContaining([delMensajero.acta, deOtro.acta]));
      expect(coordinador).not.toContain(deB.acta);

      const sinFirmaMia = await m.lt(ciaA, m.A, { actor: m.mensajeroA, estado: 'clasificado' });
      const sinFirmaOtro = await m.lt(ciaA, m.A, { actor: m.usuarioA, estado: 'clasificado' });
      const sinFirmaB = await m.lt(await m.cia(m.B), m.B, { actor: m.usuarioB, estado: 'clasificado' });
      const pend = (r: request.Response) => r.body.pendientes.map((p: { documentoId: string }) => p.documentoId);
      const delMens = pend(await obtener(m, '/recogidas/pendientes-firma', m.tokenMensajeroA));
      expect(delMens).toEqual(expect.arrayContaining([sinFirmaMia.doc]));
      expect(delMens).not.toContain(sinFirmaOtro.doc);
      const delCoord = pend(await obtener(m, '/recogidas/pendientes-firma', m.tokenA));
      expect(delCoord).toEqual(expect.arrayContaining([sinFirmaMia.doc, sinFirmaOtro.doc]));
      expect(delCoord).not.toContain(sinFirmaB.doc);

      const f1 = await m.firmante(m.A, { registradoPor: m.mensajeroA });
      const f2 = await m.firmante(m.A, { registradoPor: m.usuarioA });
      const fB = await m.firmante(m.B, { registradoPor: m.mensajeroB });
      const firmantes = (r: request.Response) => r.body.recogidas.map((x: { firmanteId: string }) => x.firmanteId);
      const delM = firmantes(await obtener(m, '/recogidas/mias', m.tokenMensajeroA));
      expect(delM).toContain(f1);
      expect(delM).not.toContain(f2);
      const delC = firmantes(await obtener(m, '/recogidas/mias', m.tokenA));
      expect(delC).toEqual(expect.arrayContaining([f1, f2]));
      expect(delC).not.toContain(fB);
      expect((await obtener(m, `/recogidas/${f2}`, m.tokenMensajeroA)).status).toBe(404);
      expect((await obtener(m, `/recogidas/${f2}`, m.tokenA)).status).toBe(200);
    }));

    it('R4: la ruta incluye al mensajero sus viajes a FLIT', () => conMundo(async (m) => {
      const v = await m.viaje(await m.cia(m.A), m.A, { estado: 'despachada', destino: 'flit', mensajero: m.mensajeroA });
      const e = (await obtener(m, '/mi-ruta', m.tokenMensajeroA)).body.entregas.find((x: { actaId: string }) => x.actaId === v.acta);
      expect(e).toMatchObject({ destino: 'flit', trasladoId: v.traslado });
    }));

    it('un firmante mixto (`NULL`) solo lo ve Operaciones (H5)', () => conMundo(async (m) => {
      const f = await m.firmante(null, { registradoPor: m.usuarioA });
      expect((await obtener(m, `/recogidas/${f}`, m.tokenA)).status).toBe(404);
      expect((await obtener(m, `/recogidas/${f}`, m.tokenOps)).status).toBe(200);
    }));
  });

  describe('#14351 AC8 y AC9, R1 — despacho', () => {
    it('al proveedor, solo los suyos y sin `grupo`; a Operaciones, FLITO y el dueño de ESA acta, con grupo y nombre', () => conMundo(async (m) => {
      const v = await m.viaje(await m.cia(m.A), m.A);
      const prov = await obtener(m, `/actas/${v.acta}/mensajeros`, m.tokenA);
      expect(prov.status).toBe(200);
      const ids = prov.body.map((x: { id: number }) => x.id);
      expect(ids).toContain(m.mensajeroA);
      expect(ids).not.toContain(m.mensajeroB);
      expect(ids).not.toContain(m.mensajeroFlito);
      for (const x of prov.body) expect(Object.keys(x).sort()).toEqual(['id', 'nombre']);

      const ops = await obtener(m, `/actas/${v.acta}/mensajeros`, m.tokenOps);
      const de = (id: number) => ops.body.find((x: { id: number }) => x.id === id);
      expect(de(m.mensajeroFlito)).toEqual({ id: m.mensajeroFlito, nombre: 'Mensajero de FLITO', grupo: 'flito' });
      expect(de(m.mensajeroA)).toMatchObject({ grupo: 'proveedor', proveedorNombre: expect.stringContaining('A ') });
      expect(de(m.mensajeroB)).toBeUndefined();
    }));

    it('el servidor lo exige igual, no solo el listado', () => conMundo(async (m) => {
      const ciaA = await m.cia(m.A);
      const lt = await m.lt(ciaA, m.A, { actor: m.usuarioA });
      const reg = await enviar(m, '/traslados', m.tokenA, { companiaId: ciaA, destino: 'cliente', lts: [{ documentoId: lt.doc }] });
      for (const ajeno of [m.mensajeroB, m.mensajeroFlito]) {
        const r = await enviar(m, `/actas/${reg.body.actaId}/despachar`, m.tokenA, { mensajeroId: ajeno, firmaEntrega: FIRMA });
        expect([r.status, r.body.codigo]).toEqual([422, 'MENSAJERO_NO_ASIGNABLE']);
      }
      expect((await enviar(m, `/traslados/${reg.body.id}/despachar`, m.tokenOps, { mensajeroId: m.mensajeroB })).status).toBe(422);
      expect((await enviar(m, `/traslados/${reg.body.id}/despachar`, m.tokenOps, { mensajeroId: m.mensajeroFlito })).status).toBe(200);
    }));
  });

  describe('#14351 — motivos de llegada', () => {
    it('el GET llega al proveedor; la escritura sigue cerrada aunque tenga la función', () => conMundo(async (m) => {
      await motivo(m);
      const token = `Bearer ${await testToken({ sub: m.usuarioA, role: 'x' as never, tipoEnlace: 'proveedor', funciones: [...FUNCIONES, 'logistica.motivos.gestionar'] })}`;
      expect((await request(m.app).get('/api/flito/logistica/motivos-llegada?soloActivos=true').set('Authorization', token)).status).toBe(200);
      const w = await request(m.app).post('/api/flito/logistica/motivos-llegada').set('Authorization', token).send({ nombre: 'Otro' });
      expect([w.status, w.body]).toEqual([403, { error: 'Sin permisos' }]);
    }));
  });

  describe('#14349 — fecha de corte', () => {
    it('AC3: actas anteriores, abiertas y terminadas, con A registrado: como si no existieran; Operaciones las ve', () => conMundo(async (m) => {
      const ciaA = await m.cia(m.A);
      for (const estado of ['generada', 'entregada']) {
        const v = await m.viaje(ciaA, m.A, { estado, creado: AYER });
        await m.lt(ciaA, null, { actaId: v.acta, creado: AYER });
        await m.tx`UPDATE flito_logistica_corte_proveedor SET corte_en = now()`;
        expect((await obtener(m, '/actas', m.tokenA)).body.map((a: { id: string }) => a.id)).not.toContain(v.acta);
        for (const r of [`/actas/${v.acta}`, `/actas/${v.acta}/pdf`, `/actas/${v.acta}/mensajeros`]) {
          const x = await obtener(m, r, m.tokenA);
          expect(x.status, r).toBe(404);
          expect(x.body).toEqual({ error: 'El acta no existe' });
        }
        expect((await obtener(m, '/actas', m.tokenOps)).body.map((a: { id: string }) => a.id)).toContain(v.acta);
        expect((await obtener(m, `/actas/${v.acta}`, m.tokenOps)).status).toBe(200);
      }
    }));

    it('AC3 y R5: la LT lleva `actaId` nulo al proveedor si el acta es anterior; Operaciones lo ve', () => conMundo(async (m) => {
      const ciaA = await m.cia(m.A);
      const v = await m.viaje(ciaA, m.A, { creado: AYER });
      const lt = await m.lt(ciaA, m.A, { actaId: v.acta, estado: 'devuelto' });
      const fila = (await obtener(m, '/?pageSize=200', m.tokenA)).body.items.find((i: { tramiteId: string }) => i.tramiteId === lt.tramite);
      expect(fila.actaId).toBeNull();
      expect((await obtener(m, `/${lt.tramite}`, m.tokenA)).body.actaId).toBeNull();
      expect((await obtener(m, '/?pageSize=200', m.tokenOps)).body.items.find((i: { tramiteId: string }) => i.tramiteId === lt.tramite).actaId).toBe(v.acta);
    }));

    it('AC4: un acta desde el corte la ve; un acta `legado` de un traslado histórico, no', () => conMundo(async (m) => {
      const ciaA = await m.cia(m.A);
      const v = await m.viaje(ciaA, m.A);
      const legado = await m.viaje(ciaA, m.A, { legado: true });
      const ids = (await obtener(m, '/actas', m.tokenA)).body.map((a: { id: string }) => a.id);
      expect(ids).toContain(v.acta);
      expect(ids).not.toContain(legado.acta);
    }));

    it('un firmante anterior al corte no lo alcanza', () => conMundo(async (m) => {
      const f = await m.firmante(m.A, { firmado: AYER, registradoPor: m.usuarioA });
      expect((await obtener(m, `/recogidas/${f}`, m.tokenA)).status).toBe(404);
    }));

    it('AC7: al cerrar un acta anterior, lo no entregado pasa al proveedor vigente; el acta y lo entregado siguen con Operaciones', () => conMundo(async (m) => {
      const ciaB = await m.cia(m.B);
      const v = await m.viaje(ciaB, null, { estado: 'despachada', creado: AYER, mensajero: m.ops });
      const entregada = await m.lt(ciaB, null, { actaId: v.acta, estado: 'despachado', creado: AYER });
      const devuelta = await m.lt(ciaB, null, { actaId: v.acta, estado: 'despachado', creado: AYER });
      for (const d of [entregada.doc, devuelta.doc]) {
        await m.tx`INSERT INTO flito_logistica_traslado_lts (traslado_id, destino, documento_id, estado, concepto_precio, precio) VALUES (${v.traslado}, 'cliente', ${d}, 'en_ruta', 'logistica_cliente', 18500)`;
      }
      const r = await enviar(m, `/traslados/${v.traslado}/entregar`, m.tokenOps, { receptorNombre: 'Ana', receptorDocumento: '123456', firma: FIRMA, ltsDevueltas: [devuelta.doc] });
      expect(r.status).toBe(200);
      const dueno = async (id: string) => (await m.tx`SELECT proveedor_logistica_id p FROM flito_logistica_documentos WHERE id = ${id}`)[0]!.p;
      expect(await dueno(devuelta.doc)).toBe(m.B);
      expect(await dueno(entregada.doc)).toBeNull();
      const tokenB = `Bearer ${await testToken({ sub: m.usuarioB, role: 'x' as never, tipoEnlace: 'proveedor', funciones: FUNCIONES })}`;
      const lista = (await obtener(m, '/?pageSize=200', tokenB)).body.items.map((i: { tramiteId: string }) => i.tramiteId);
      expect(lista).toContain(devuelta.tramite);
      expect(lista).not.toContain(entregada.tramite);
      expect((await obtener(m, `/actas/${v.acta}`, tokenB)).status).toBe(404);
    }));

    it('AC8: sin fecha legible el proveedor no ve ninguna acta y Operaciones no se afecta', () => conMundo(async (m) => {
      const v = await m.viaje(await m.cia(m.A), m.A);
      await m.tx`DELETE FROM flito_logistica_corte_proveedor`;
      const r = await obtener(m, '/actas', m.tokenA);
      expect(r.status).toBe(200);
      expect(r.body).toEqual([]);
      expect((await obtener(m, `/actas/${v.acta}`, m.tokenA)).status).toBe(404);
      expect((await obtener(m, '/actas', m.tokenOps)).body.map((a: { id: string }) => a.id)).toContain(v.acta);
    }));
  });

  describe('autogestionada = sin proveedor (decisión del agente, declarada)', () => {
    it('al cerrarse su acta, sus LT no toman el proveedor que conserva', () => conMundo(async (m) => {
      const auto = await m.cia(m.A, true);
      const v = await m.viaje(auto, null, { estado: 'despachada', mensajero: m.ops });
      const lt = await m.lt(auto, null, { actaId: v.acta, estado: 'despachado' });
      await m.tx`INSERT INTO flito_logistica_traslado_lts (traslado_id, destino, documento_id, estado, concepto_precio, precio) VALUES (${v.traslado}, 'cliente', ${lt.doc}, 'en_ruta', 'logistica_cliente', 18500)`;
      const r = await enviar(m, `/traslados/${v.traslado}/devolucion`, m.tokenOps, { motivo: 'x' });
      expect(r.status).toBe(200);
      expect((await m.tx`SELECT proveedor_logistica_id p FROM flito_logistica_documentos WHERE id = ${lt.doc}`)[0]!.p).toBeNull();
    }));
  });
});

async function motivo(m: Mundo): Promise<string> {
  return (await m.tx`INSERT INTO flito_logistica_motivos_llegada (nombre, activo) VALUES (${`Motivo ${sello()}`}, true) RETURNING id`)[0]!.id as string;
}
