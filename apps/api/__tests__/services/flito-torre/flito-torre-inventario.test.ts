// Torre de Control Gerencial (Épica #14590, B2) — Operativa › Inventario por estado y › Soportes, contra PostgreSQL real
// (tx con ROLLBACK, `torre-pg.ts`; se salta sin TEST_DATABASE_URL):
//   · B2-AC1: cada celda de la matriz (y los totales de fila, columna y general) == `total` del detalle con sus segmentos;
//     ▲ solo en las celdas que pasan el umbral de SU estado; el total general == O3 «Trámites en curso».
//   · B2-AC2: la regla única de borrador abandonado (entrada al estado, umbral `dias_borrador_abandonado`): la Torre y
//     la alerta `borrador_5d` de Gestión Trámites cuentan los mismos trámites.
//   · B2-AC3: soportes por faltante == su detalle; el total de incompletos == niveles 0+1+2 de `soportes_aprobados`.
//   · La ruta: 401 sin token, 403 sin `torre.tablero_operativo.ver`, 400 con un organismo inválido.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { SignJWT } from 'jose';
import { and, inArray, sql } from 'drizzle-orm';
import { TRAMOS_ANTIGUEDAD_TORRE, type ConsultaDetalle, type DestinoCifra, type FiltroTorre } from '@operaciones/shared-types';

vi.mock('../../../src/db/client.js', async () => ({ db: (await import('./torre-pg.js')).dbProxy, getPoolStats: vi.fn() }));
vi.mock('../../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { abrirTx, cerrarBase, cerrarTx, dbProxy, sembrador, URL_BASE } = await import('./torre-pg.js');
const { inventarioEstado, soportesFaltantes, umbralDeEstado } = await import('../../../src/modules/flito-torre/flito-torre.inventario.service.js');
const { tableroOperativo } = await import('../../../src/modules/flito-torre/flito-torre.operativa.service.js');
const { consultarDetalle } = await import('../../../src/modules/flito-torre/flito-torre.detalle.service.js');
const { consultarMetrica } = await import('../../../src/modules/flito-torre/flito-torre.metricas.service.js');
const { valoresUmbrales } = await import('../../../src/modules/flito-torre/flito-torre.umbrales.service.js');
const { tramoDeDias } = await import('../../../src/modules/flito-torre/flito-torre.filtro.js');
const { condicionAlerta, umbralBorradorDe } = await import('../../../src/modules/flito-tramites/flito-tramites.service.js');
const { flitoTramites } = await import('../../../src/db/schema.js');
const permisos = await import('../../../src/shared/permisos-efectivos.js');
const { default: tableros } = await import('../../../src/modules/flito-torre/flito-torre.tableros.routes.js');
import type { FilasPermisos } from '../../../src/shared/permisos-efectivos.js';
import { conCadena } from '../../helpers/auth.js';

const TODO = { enlace: 'ninguno' } as const;
const HOY = '2035-03-31';
const FUNCIONES = new Set(['torre.tablero_operativo.ver', 'torre.tablero_financiero.ver', 'torre.tablero_ejecutivo.ver']);
const haceDias = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

const totalDe = async (filtro: FiltroTorre, destino: DestinoCifra): Promise<number> => {
  if (destino.tipo !== 'conjunto') throw new Error('se esperaba un destino de conjunto');
  const c: ConsultaDetalle = { origen: destino.origen, segmentos: destino.segmentos, filtro, pagina: 1, tamano: 25 };
  return (await consultarDetalle(c, { alcance: TODO, dinero: true, funciones: FUNCIONES, hoy: HOY })).total;
};

describe.skipIf(!URL_BASE)('tramoDeDias — los cortes del SQL son los de TRAMOS_ANTIGUEDAD_TORRE', () => {
  afterEach(cerrarTx);
  it('cada borde del catálogo cae en su tramo', async () => {
    await abrirTx();
    const ejecutar = (dbProxy as unknown as { execute: (q: unknown) => Promise<{ k: string }[]> }).execute;
    for (const t of TRAMOS_ANTIGUEDAD_TORRE) {
      for (const d of [t.desde, t.hasta ?? t.desde + 400]) {
        const [fila] = await ejecutar(sql`SELECT ${tramoDeDias(sql`${d}::int`)} AS k`);
        expect(fila!.k, `${d} días`).toBe(t.clave);
      }
    }
  });
});

describe.skipIf(!URL_BASE)('inventario por estado y soportes (tx con ROLLBACK)', () => {
  let s: ReturnType<typeof sembrador>;
  let tx: Awaited<ReturnType<typeof abrirTx>>;
  beforeEach(async () => { tx = await abrirTx(); s = sembrador(tx); await s.organismos('05001', '11001'); });
  afterEach(cerrarTx);
  afterAll(cerrarBase);

  /** Borradores y trámites en el organismo a ambos lados de su umbral, en tramos distintos y en dos organismos. */
  async function escenario() {
    const u = await valoresUmbrales();
    const x = await s.cia('X'); const y = await s.cia('Y');
    const dB = u.dias_borrador_abandonado; const dOt = u.dias_respuesta_ot;
    const ids = {
      // Nació en Borrador hace dB+1 días, sin historial: cuenta desde la creación → abandonado.
      bViejo: await s.tramite({ cia: x, flitEstado: 'Borrador', creadoFlit: haceDias(dB + 1.5) }),
      bReciente: await s.tramite({ cia: x, flitEstado: 'Borrador', creadoFlit: haceDias(1) }),
      // Creado hace mucho pero VOLVIÓ a Borrador hace 1 día: con la regla unificada NO está abandonado.
      bVuelto: await s.tramite({ cia: x, flitEstado: 'Borrador', creadoFlit: haceDias(dB + 40) }),
      bOtroOrg: await s.tramite({ cia: y, flitEstado: 'Borrador', organismo: '11001', creadoFlit: haceDias(dB + 20.5) }),
      eViejo: await s.tramite({ cia: x, flitEstado: 'Entregado', organismo: '11001', creadoFlit: haceDias(dOt + 60) }),
      eReciente: await s.tramite({ cia: x, flitEstado: 'Enviado a OT', creadoFlit: haceDias(dOt + 60) }),
      asignado: await s.tramite({ cia: y, flitEstado: 'Asignado', creadoFlit: haceDias(45) }),
    };
    await s.historial(ids.bVuelto, 'Entregado', 'Borrador', haceDias(1));
    await s.historial(ids.eViejo, 'Asignado', 'Entregado', haceDias(dOt + 1.5));
    await s.historial(ids.eReciente, 'Asignado', 'Enviado a OT', haceDias(2));
    // Fuera del inventario: aprobado y anulado.
    await s.tramite({ cia: x, aprobado: '2035-03-05T15:00:00Z', creadoFlit: '2035-03-02T15:00:00Z' });
    await s.tramite({ cia: x, flitEstado: 'Anulado', creadoFlit: haceDias(3) });
    return { u, x, y, ids, filtro: { rango: { desde: '2035-03-01', hasta: HOY }, companiaIds: [x, y] } as FiltroTorre };
  }

  it('B2-AC1: cada celda y cada total abren un detalle con su mismo número; ▲ solo sobre el umbral de su estado', async () => {
    const { u, filtro } = await escenario();
    const ctx = { filtro, alcance: TODO, dinero: true, hoy: HOY };
    const m = await inventarioEstado(ctx, null);

    expect(m.tramos.map((t) => t.clave)).toEqual(TRAMOS_ANTIGUEDAD_TORRE.map((t) => t.clave));
    expect(m.filas.map((f) => f.estado)).toEqual(['Borrador', 'Enviado a OT', 'Asignado', 'Entregado']);
    let comprobadas = 0;
    for (const f of m.filas) {
      let suma = 0;
      for (const t of m.tramos) {
        const c = f.celdas[t.clave];
        suma += c.n;
        if (c.n === 0) { expect(c.destino).toEqual({ tipo: 'ninguno' }); expect(c.sobreUmbral).toBe(false); continue; }
        expect(await totalDe(filtro, c.destino), `${f.estado} × ${t.clave}`).toBe(c.n);
        comprobadas++;
      }
      expect(f.total.n).toBe(suma);
      expect(await totalDe(filtro, f.total.destino)).toBe(f.total.n);
      expect(f.total.sobreUmbral).toBe(false);
    }
    for (const t of m.tramos) {
      const c = m.totales.celdas[t.clave];
      expect(c.n).toBe(m.filas.reduce((a, f) => a + f.celdas[t.clave].n, 0));
      if (c.n) expect(await totalDe(filtro, c.destino)).toBe(c.n);
    }
    expect(comprobadas).toBeGreaterThanOrEqual(6);
    expect(m.totales.total.n).toBe(7);
    expect(await totalDe(filtro, m.totales.total.destino)).toBe(7);
    // El total general es O3 «Trámites en curso» con el mismo filtro.
    expect((await tableroOperativo(ctx)).cifras.wip).toBe(m.totales.total.n);

    // ▲: Borrador — solo los tramos con un borrador de más de dB días; Entregado — más de dOt; Asignado nunca.
    const fila = (e: string) => m.filas.find((f) => f.estado === e)!;
    const marcadas = (e: string) => m.tramos.filter((t) => fila(e).celdas[t.clave].sobreUmbral).map((t) => t.clave);
    // Días completos (floor): los sembrados van a media jornada del borde para no depender de los milisegundos.
    const tramo = (d: number) => TRAMOS_ANTIGUEDAD_TORRE.find((t) => Math.floor(d) >= t.desde && (t.hasta == null || Math.floor(d) <= t.hasta))!.clave;
    expect(marcadas('Borrador')).toEqual([...new Set([tramo(u.dias_borrador_abandonado + 1.5), tramo(u.dias_borrador_abandonado + 20.5)])]);
    expect(marcadas('Entregado')).toEqual([tramo(u.dias_respuesta_ot + 1.5)]);
    expect(marcadas('Enviado a OT')).toEqual([]);
    expect(marcadas('Asignado')).toEqual([]);
    expect(fila('Asignado').umbral).toBeNull();
    expect(fila('Borrador').umbral).toEqual({ clave: 'dias_borrador_abandonado', valor: u.dias_borrador_abandonado });
    expect(m.leyendaUmbral).toContain(`Borrador: ${u.dias_borrador_abandonado} días`);
    expect(m.frase).toBe('7 trámites en curso hoy, por estado y por días en ese estado.');
    expect(m.organismos.map((o) => o.codigo)).toEqual(['05001', '11001']);
  });

  it('B2-AC1: con organismo, la matriz se acota y cada celda lleva el organismo en su detalle', async () => {
    const { filtro } = await escenario();
    const m = await inventarioEstado({ filtro, alcance: TODO, dinero: true, hoy: HOY }, '11001');
    expect(m.totales.total.n).toBe(2);
    expect(m.filas.map((f) => f.estado)).toEqual(['Borrador', 'Entregado']);
    for (const f of m.filas) {
      for (const t of m.tramos) {
        const c = f.celdas[t.clave];
        if (!c.n) continue;
        expect(c.destino.tipo === 'conjunto' && c.destino.segmentos?.some((g) => g.dimension === 'organismo')).toBe(true);
        expect(await totalDe(filtro, c.destino)).toBe(c.n);
      }
    }
    // El selector sigue ofreciendo todos los organismos con trámites en curso.
    expect(m.organismos.map((o) => o.codigo)).toEqual(['05001', '11001']);
  });

  it('B2-AC2: la Torre y la alerta borrador_5d de Trámites cuentan lo mismo, con el umbral configurable', async () => {
    const { x, y, ids, filtro } = await escenario();
    const ctx = { filtro, alcance: TODO, dinero: true, hoy: HOY };
    const torre = (await tableroOperativo(ctx)).cifras.borradoresAbandonados;
    const dias = await umbralBorradorDe('borrador_5d');
    const alerta = await (dbProxy as unknown as { select: typeof import('../../../src/db/client.js').db.select })
      .select({ id: flitoTramites.id }).from(flitoTramites)
      .where(and(condicionAlerta('borrador_5d', dias), inArray(flitoTramites.companiaId, [x, y])));
    expect(alerta.map((r) => r.id).sort()).toEqual([ids.bViejo, ids.bOtroOrg].sort());
    expect(torre).toBe(alerta.length);
    expect(await totalDe(filtro, { tipo: 'conjunto', origen: { tipo: 'conjunto', conjunto: 'borrador_abandonado' } })).toBe(alerta.length);

    // Mover el umbral mueve las dos cifras igual.
    await tx`UPDATE flito_torre_umbrales SET valor = 30 WHERE clave = 'dias_borrador_abandonado'`;
    const dias30 = await umbralBorradorDe('borrador_5d');
    expect(dias30).toBe(30);
    const alerta30 = await (dbProxy as unknown as { select: typeof import('../../../src/db/client.js').db.select })
      .select({ id: flitoTramites.id }).from(flitoTramites)
      .where(and(condicionAlerta('borrador_5d', dias30), inArray(flitoTramites.companiaId, [x, y])));
    expect((await tableroOperativo(ctx)).cifras.borradoresAbandonados).toBe(alerta30.length);
    expect(umbralDeEstado('  BORRADOR ', { ...(await valoresUmbrales()) })?.valor).toBe(30);
  });

  it('Explorador: dias_en_estado y la agrupación tramo_antiguedad; cada fila == su detalle', async () => {
    const { filtro } = await escenario();
    const wip = await consultarMetrica({ metrica: 'wip_activo', filtro, agrupacion: 'tramo_antiguedad' }, TODO, { dinero: true, hoy: HOY });
    expect(wip.total.valor).toBe(7);
    for (const f of wip.filas) {
      const d = await consultarDetalle({ origen: { tipo: 'metrica', metrica: 'wip_activo' }, segmentos: [{ dimension: 'tramo_antiguedad', valores: [f.clave] }],
        filtro, pagina: 1, tamano: 25 }, { alcance: TODO, dinero: true, funciones: new Set(['torre.metricas.consultar']), hoy: HOY });
      expect(d.total, String(f.clave)).toBe(f.valor);
    }
    const horas = await consultarMetrica({ metrica: 'dias_en_estado', filtro, agrupacion: 'flit_estado' }, TODO, { dinero: true, hoy: HOY });
    expect(horas.total.n).toBe(7);
    const asignado = horas.filas.find((f) => f.clave === 'Asignado')!;
    expect(asignado.valor).toBeGreaterThan(45 * 24 - 1);
    expect(asignado.valor).toBeLessThan(45 * 24 + 1);
  });

  it('B2-AC3: soportes por faltante == su detalle, e incompletos == niveles 0+1+2 de soportes_aprobados', async () => {
    const z = await s.cia('Z');
    const filtro = { rango: { desde: '2035-03-01', hasta: HOY }, companiaIds: [z] } as FiltroTorre;
    // Tres aprobados: uno con derecho (le faltan SOAT e impuesto), dos sin nada.
    const a = await s.tramite({ cia: z, creadoFlit: '2035-03-10T13:00:00Z', aprobado: '2035-03-10T18:00:00Z' });
    await s.tramite({ cia: z, creadoFlit: '2035-03-11T13:00:00Z', aprobado: '2035-03-11T18:00:00Z' });
    await s.tramite({ cia: z, creadoFlit: '2035-03-12T13:00:00Z', aprobado: '2035-03-12T18:00:00Z' });
    await s.derecho({ tramiteId: a, cia: z, organismo: '05001', valor: 10_000, fechaPago: '2035-03-10' });
    const [d] = await tx`SELECT id FROM flito_derechos_tramite WHERE tramite_id = ${a}`;
    await tx`INSERT INTO flito_soportes (tipo, nombre_archivo, content_type, storage_key, hash, tamano_bytes, derecho_id, subido_por_nombre)
      VALUES ('comprobante', 'p.pdf', 'application/pdf', ${`torre/inv/${Date.now()}`}, ${`hinv${Date.now()}`}, 10, ${d!.id}, 'Prueba')`;

    const r = await soportesFaltantes({ filtro, alcance: TODO, dinero: true, hoy: HOY });
    expect(r.aprobados).toBe(3);
    expect(r.incompletos.n).toBe(3);
    expect(Object.fromEntries(r.porFaltante.map((p) => [p.faltante, p.n]))).toEqual({ soat: 3, impuesto: 3, derecho: 2 });
    for (const p of r.porFaltante) expect(await totalDe(filtro, p.destino)).toBe(p.n);
    expect(await totalDe(filtro, r.incompletos.destino)).toBe(r.incompletos.n);
    // = los niveles 0, 1 y 2 del mismo universo (soportes_aprobados).
    const niveles = await totalDe(filtro, { tipo: 'conjunto', origen: { tipo: 'conjunto', conjunto: 'soportes_aprobados' },
      segmentos: [{ dimension: 'nivel', valores: ['0', '1', '2'] }] });
    expect(niveles).toBe(r.incompletos.n);
    // Y el faltante equivale al de soportes_aprobados.
    const derechoAprob = await totalDe(filtro, { tipo: 'conjunto', origen: { tipo: 'conjunto', conjunto: 'soportes_aprobados' },
      segmentos: [{ dimension: 'faltante', valores: ['derecho'] }] });
    expect(derechoAprob).toBe(2);
  });
});

// ── La ruta (sin base: las guardas y Zod responden antes del servicio) ──────────────────────────────────

const filas = new Map<number, FilasPermisos>();
const token = (sub: number) => new SignJWT({ username: 'u', role: 'x' }).setProtectedHeader({ alg: 'HS256' }).setSubject(String(sub))
  .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
const app = express();
app.use(express.json());
app.use('/api/flito/torre/tableros', tableros);
const MARZO = { filtro: { rango: { desde: '2035-03-01', hasta: '2035-03-31' } } };

describe('POST /tableros/operativa/inventario y /soportes — guardas', () => {
  beforeEach(() => {
    filas.clear();
    permisos.fijarFuenteDePermisos(async (id: number) => filas.get(id) ?? null);
    for (const i of [1, 2]) permisos.invalidarPermisosDe(i);
    filas.set(1, { rol: 'r1', tipoEnlace: 'ninguno', proveedor: null, funcionesDelRol: conCadena(['accion.torre_comercial.ver']), excepciones: [] });
    filas.set(2, { rol: 'r2', tipoEnlace: 'ninguno', proveedor: null, funcionesDelRol: conCadena(['accion.torre_operativa.ver']), excepciones: [] });
  });

  for (const ruta of ['/operativa/inventario', '/operativa/soportes']) {
    it(`${ruta}: 401 sin token y 403 sin torre.tablero_operativo.ver`, async () => {
      expect((await request(app).post(`/api/flito/torre/tableros${ruta}`).send(MARZO)).status).toBe(401);
      const r = await request(app).post(`/api/flito/torre/tableros${ruta}`).set('Authorization', `Bearer ${await token(1)}`).send(MARZO);
      expect(r.status).toBe(403);
    });
  }

  it('400 con un organismo que no es DIVIPOLA o un campo desconocido (antes de tocar la base)', async () => {
    const pide = async (body: object) => request(app).post('/api/flito/torre/tableros/operativa/inventario')
      .set('Authorization', `Bearer ${await token(2)}`).send(body);
    expect((await pide({ ...MARZO, organismo: "05001' OR 1=1" })).status).toBe(400);
    expect((await pide({ ...MARZO, otro: 1 })).status).toBe(400);
    expect((await request(app).post('/api/flito/torre/tableros/operativa/soportes').set('Authorization', `Bearer ${await token(2)}`)
      .send({ ...MARZO, organismo: '05001' })).status).toBe(400);
  });
});
