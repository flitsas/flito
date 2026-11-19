// Torre de Control Gerencial (Épica #14590, B5) — Operativa › Equipo.
//   · Sin base: catálogo de los 3 conjuntos (origen SOLO `torre.equipo.ver`), columnas declaradas == columnas con SQL,
//     sin `usuario_email` ni otro dato personal del funcionario (B5-AC2), la dimensión `funcionario` fuera de
//     `AGRUPACIONES_TORRE`, Zod del segmento, `tablaPiiDe`, detalle 403 sin la función, migración == generador y reparto
//     solo `gerencia_general` + `admin`.
//   · Contra PostgreSQL real (tx con ROLLBACK, `torre-pg.ts`): B5-AC2 — cada KPI y cada celda de «Por funcionario» abre
//     un detalle cuyo `total` es su cifra (y la suma de las filas es la KPI); orden alfabético; sin correos en ninguna
//     salida. B5-AC1 — la ruta: 401 sin token; 403 para gerencia_comercial, financiera y auditor; 200 para
//     gerencia_general y admin (con su reparto sembrado); sin `/exportar`.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { SignJWT } from 'jose';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  AGRUPACIONES_TORRE, CONJUNTOS_EQUIPO_TORRE, CONJUNTO_POR_COLUMNA_EQUIPO, DIMENSIONES_SEGMENTO_TORRE, FUNCION_EQUIPO_TORRE,
  conjuntoTorre, type ConjuntoTorreId, type ConsultaDetalle, type DestinoCifra, type FiltroTorre,
} from '@operaciones/shared-types';

vi.mock('../../../src/db/client.js', async () => ({ db: (await import('./torre-pg.js')).dbProxy, getPoolStats: vi.fn() }));
vi.mock('../../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));

const { abrirTx, cerrarBase, cerrarTx, sembrador, URL_BASE } = await import('./torre-pg.js');
const { tableroEquipo } = await import('../../../src/modules/flito-torre/flito-torre.equipo.service.js');
const { consultarDetalle, DetalleSinOrigenError, tablaPiiDe, proyectaPlaca } = await import('../../../src/modules/flito-torre/flito-torre.detalle.service.js');
const { CONJUNTOS_SQL, fragmentoConjunto, SIN_UMBRALES } = await import('../../../src/modules/flito-torre/flito-torre.conjuntos.js');
const { valoresUmbrales } = await import('../../../src/modules/flito-torre/flito-torre.umbrales.service.js');
const { sqlRepartoTorre, sqlSiembraTorre } = await import('../../../src/modules/permisos/arbol/sql-torre.js');
const { catalogoCompleto } = await import('../../../src/modules/permisos/catalogo.js');
const { leerRepartoSembrado } = await import('../../helpers/permisos-seed-sql.js');
const permisos = await import('../../../src/shared/permisos-efectivos.js');
const { default: tableros } = await import('../../../src/modules/flito-torre/flito-torre.tableros.routes.js');
import type { FilasPermisos } from '../../../src/shared/permisos-efectivos.js';

const TODO = { enlace: 'ninguno' } as const;
const HOY = '2035-03-31';
const FUNCIONES = new Set([FUNCION_EQUIPO_TORRE]);
const IDS = CONJUNTOS_EQUIPO_TORRE.map((c) => c.id) as ConjuntoTorreId[];
const dialecto = new PgDialect();
const texto = (s: Parameters<PgDialect['sqlToQuery']>[0]) => dialecto.sqlToQuery(s).sql;
const MARZO_FILTRO = { rango: { desde: '2035-03-01', hasta: HOY } } as FiltroTorre;
const ctxSinBase = { filtro: MARZO_FILTRO, alcance: TODO, dinero: true, hoy: HOY };
const U_PRUEBA = { ...SIN_UMBRALES, horas_soat_impuesto_sin_soporte: 24, dias_traslado_abierto: 3 } as never;
const MIG = (n: string) => readFileSync(join(__dirname, `../../../src/db/migrations/${n}`), 'utf8');
const bloque = (s: string) => s.slice(s.indexOf('-- ÁRBOL GENERADO (inicio)\n') + '-- ÁRBOL GENERADO (inicio)\n'.length, s.indexOf('-- ÁRBOL GENERADO (fin)'));
/** Cualquier dato personal del funcionario distinto del nombre. */
const DATO_PERSONAL = /usuario_email|"email"|username|password|"document"|telefono|phone|cedula/;

describe('catálogo de Equipo (B5) — sin base', () => {
  it('3 conjuntos de entidad funcionario que solo abre `torre.equipo.ver`, con definición, frase y frase en 0', () => {
    expect(IDS).toEqual(['gestiones_funcionario_periodo', 'carga_funcionario', 'fuera_ans_funcionario']);
    for (const id of IDS) {
      const c = conjuntoTorre(id);
      expect(c.entidad, id).toBe('funcionario');
      expect(c.funcionesOrigen, id).toEqual(['torre.equipo.ver']);
      expect(c.segmentosAdmitidos, id).toContain('funcionario');
      expect(c.definicion.length, id).toBeGreaterThan(40);
      expect(c.frase, id).toContain('{n}');
      expect(CONJUNTOS_SQL[id], id).toBeDefined();
    }
    expect(Object.values(CONJUNTO_POR_COLUMNA_EQUIPO).sort()).toEqual([...IDS].sort());
    // Rótulos de la UX (no es un ranking).
    expect(conjuntoTorre('carga_funcionario').etiqueta).toBe('Carga abierta');
    expect(conjuntoTorre('fuera_ans_funcionario').etiqueta).toBe('Pendientes fuera de ANS');
  });

  it('la dimensión `funcionario` es de segmento pero NO una agrupación del Explorador', () => {
    expect(DIMENSIONES_SEGMENTO_TORRE).toContain('funcionario');
    expect(AGRUPACIONES_TORRE as readonly string[]).not.toContain('funcionario');
  });

  it('cada columna declarada tiene su SQL y el orden por defecto es una de ellas', () => {
    for (const id of IDS) {
      const f = fragmentoConjunto(id, ctxSinBase, U_PRUEBA);
      for (const col of conjuntoTorre(id).columnas) expect(f.cols[col], `${id}.${col}`).toBeDefined();
      expect(conjuntoTorre(id).columnas, id).toContain(conjuntoTorre(id).ordenDefecto.columna);
    }
  });

  it('B5-AC2: ni las columnas ni el FROM ni las condiciones leen `usuario_email` u otro dato personal del funcionario', () => {
    for (const id of IDS) {
      const f = fragmentoConjunto(id, ctxSinBase, U_PRUEBA, [{ dimension: 'funcionario', valores: ['7'] }]);
      for (const col of conjuntoTorre(id).columnas) expect(texto(f.cols[col]!), `${id}.${col}`).not.toMatch(DATO_PERSONAL);
      expect(texto(f.desde), id).not.toMatch(DATO_PERSONAL);
      for (const c of [...f.base, ...f.propia]) expect(texto(c), id).not.toMatch(DATO_PERSONAL);
      // Del funcionario, solo el nombre.
      expect(texto(f.cols.funcionario!)).toBe('"users"."name"');
    }
  });

  it('el segmento `funcionario` solo admite el id del usuario (entero positivo) y sin «Sin valor»', async () => {
    const { consultaDetalleSchema } = await import('../../../src/modules/flito-torre/flito-torre.esquemas.js');
    const con = (valores: (string | null)[]) => consultaDetalleSchema.safeParse({
      origen: { tipo: 'conjunto', conjunto: 'carga_funcionario' }, segmentos: [{ dimension: 'funcionario', valores }],
      filtro: MARZO_FILTRO, pagina: 1, tamano: 25,
    }).success;
    expect(con(['12'])).toBe(true);
    expect(con(['Ana Restrepo'])).toBe(false);
    expect(con(['ana@flit.co'])).toBe(false);
    expect(con(['0'])).toBe(false);
    expect(con([null])).toBe(false);
    // El servicio lo vuelve a exigir.
    expect(() => fragmentoConjunto('carga_funcionario', ctxSinBase, U_PRUEBA, [{ dimension: 'funcionario', valores: ['x'] }])).toThrow();
  });

  it('tablaPiiDe y proyectaPlaca: los detalles de Equipo listan placas (se registran en pii_access_log)', () => {
    for (const id of IDS) {
      expect(tablaPiiDe({ origen: { tipo: 'conjunto', conjunto: id }, filtro: MARZO_FILTRO }), id).toBe('flito_estado_historial');
      expect(proyectaPlaca({ origen: { tipo: 'conjunto', conjunto: id }, filtro: MARZO_FILTRO }), id).toBe(true);
    }
  });

  it('sin `torre.equipo.ver` el detalle de un conjunto de Equipo es 403 SIN_ORIGEN (aunque vea Operativa y el 360°)', async () => {
    const c: ConsultaDetalle = { origen: { tipo: 'conjunto', conjunto: 'carga_funcionario' }, filtro: MARZO_FILTRO, pagina: 1, tamano: 25 };
    const acc = { alcance: TODO, dinero: true, funciones: new Set(['torre.tablero_operativo.ver', 'torre.tablero_ejecutivo.ver']), hoy: HOY };
    await expect(consultarDetalle(c, acc)).rejects.toBeInstanceOf(DetalleSinOrigenError);
  });
});

describe('permisos de Equipo (B5): su migración', () => {
  const SQL_EQUIPO = MIG('0309_flito_torre_equipo.sql');
  const reparto = leerRepartoSembrado();
  const con = (fn: string) => [...reparto].filter(([, fns]) => fns.has(fn)).map(([r]) => r).sort();

  it('lo pegado entre las marcas es exactamente la salida del generador (tramo «equipo»)', () => {
    expect(bloque(SQL_EQUIPO).trim()).toBe(`${sqlSiembraTorre(catalogoCompleto(), 'equipo')}\n\n${sqlRepartoTorre('equipo')}`.trim());
  });

  it('el tramo nuevo no cambia los anteriores (ni la 0303, ni la 0306, ni la 0307, ni la 0308)', () => {
    const previas = { fundacion: '0303_flito_torre_fundacion.sql', detalle: '0306_flito_torre_detalle_permisos.sql',
      productos: '0307_flito_torre_productos.sql', logistica: '0308_flito_torre_logistica.sql' } as const;
    for (const [tramo, archivo] of Object.entries(previas) as [keyof typeof previas, string][]) {
      expect(bloque(MIG(archivo)), archivo).not.toContain('ver_equipo');
      expect(sqlRepartoTorre(tramo), tramo).not.toContain('ver_equipo');
      expect(sqlSiembraTorre(catalogoCompleto(), tramo), tramo).not.toContain('ver_equipo');
    }
    expect(bloque(MIG(previas.logistica)).trim()).toBe(`${sqlSiembraTorre(catalogoCompleto(), 'logistica')}\n\n${sqlRepartoTorre('logistica')}`.trim());
  });

  it('cuelga de `pagina.torre_operativa` (sin PageSlug nuevo) y concede `torre.equipo.ver`; idempotente', () => {
    const f = catalogoCompleto().find((x) => x.codigo === 'accion.torre_operativa.ver_equipo')!;
    expect(f.padre).toBe('pagina.torre_operativa');
    expect(SQL_EQUIPO).not.toMatch(/^\s+\('pagina\./m);
    expect(SQL_EQUIPO).toMatch(/INSERT INTO permisos_funciones[\s\S]+ON CONFLICT \(codigo\) DO UPDATE/);
    expect(SQL_EQUIPO).toMatch(/INSERT INTO permisos_rol_funcion[\s\S]+ON CONFLICT \(rol_codigo, funcion_codigo\) DO NOTHING;/);
  });

  it('reparto: SOLO admin y gerencia_general (ni auditor, ni financiera, ni gerencia_comercial)', () => {
    expect(con('accion.torre_operativa.ver_equipo')).toEqual(['admin', 'gerencia_general']);
    expect(catalogoCompleto().find((x) => x.codigo === 'accion.torre_operativa.ver_equipo')!.roles).toEqual(['admin', 'gerencia_general']);
    // El auditor ve Operativa pero no el equipo.
    expect(con('accion.torre_operativa.ver')).toContain('auditor');
  });
});

// ── Con base ─────────────────────────────────────────────────────────────────────────────────────────

const haceHoras = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

describe.skipIf(!URL_BASE)('Torre › Operativa › Equipo contra PostgreSQL (tx con ROLLBACK)', () => {
  let tx: Awaited<ReturnType<typeof abrirTx>>;
  let s: ReturnType<typeof sembrador>;
  beforeEach(async () => { tx = await abrirTx(); s = sembrador(tx); await s.organismos('05001'); });
  afterEach(cerrarTx);
  afterAll(cerrarBase);

  let n = 0;
  const usuario = async (nombre: string): Promise<number> => {
    const [r] = await tx`INSERT INTO users (username, name, email, password_hash, role, active)
      VALUES (${`torre_eq_${Date.now()}_${n++}`}, ${nombre}, ${`${nombre.split(' ')[0]!.toLowerCase()}@secreto.co`}, 'h', 'admin', true) RETURNING id`;
    return r!.id as number;
  };
  const estado = async (tramiteId: string, usuarioId: number | null, en: string) => {
    await tx`INSERT INTO flito_tramite_historial (tramite_id, campo, valor_anterior, valor_nuevo, origen, usuario_id, created_at)
      VALUES (${tramiteId}, 'flit_estado', 'Borrador', 'Asignado', ${usuarioId ? 'usuario' : 'sync'}, ${usuarioId}, ${en})`;
  };
  const historialProducto = async (concepto: 'soat' | 'impuesto', registro: string, usuarioId: number, en: string) => {
    await tx`INSERT INTO flito_estado_historial (concepto, registro_id, estado_anterior, estado_nuevo, usuario_id, usuario_email, created_at)
      VALUES (${concepto}, ${registro}, 'pendiente', 'solicitado', ${usuarioId}, 'quien@secreto.co', ${en})`;
  };
  const soat = async (cia: number, est: string): Promise<string> => {
    const vin = `VIN${Math.random().toString(36).slice(2, 12).toUpperCase()}`;
    const [v] = await tx`INSERT INTO vehicles (plate, vin) VALUES (${`ZQ${Math.random().toString(36).slice(2, 6).toUpperCase()}`}, ${vin}) RETURNING id`;
    const [r] = await tx`INSERT INTO flito_soat (vin, vehiculo_id, compania_id, estado) VALUES (${vin}, ${v!.id}, ${cia}, ${est}) RETURNING id`;
    return r!.id as string;
  };

  async function escenario() {
    const [a, b, c] = [await usuario('Ana Restrepo'), await usuario('Bruno Cárdenas'), await usuario('Carla Zuluaga')];
    const u = await valoresUmbrales();
    const x = await s.cia('Cía X');
    const y = await s.cia('Cía Y');
    // ── Trámites de x.
    const t1 = await s.tramite({ cia: x, flitEstado: 'Asignado', placa: 'ZQE001' });
    await estado(t1, a, '2035-03-05T15:00:00Z');
    await estado(t1, b, '2035-03-06T15:00:00Z'); // último: Bruno → su carga
    const t2 = await s.tramite({ cia: x, aprobado: '2035-03-08T15:00:00Z' });
    await estado(t2, a, '2035-03-07T15:00:00Z'); // cerrado: gestión, no carga
    const t3 = await s.tramite({ cia: x, flitEstado: 'Asignado' });
    await estado(t3, a, haceHoras(24 * 5)); // carga de Ana fuera de ANS (> 2 días)
    const t4 = await s.tramite({ cia: x, flitEstado: 'Asignado' });
    await estado(t4, a, haceHoras(1)); // carga de Ana dentro del ANS
    const t5 = await s.tramite({ cia: x, flitEstado: 'Asignado' });
    await estado(t5, a, haceHoras(24 * 5));
    await estado(t5, null, haceHoras(24 * 4)); // el último lo hizo el sistema: de nadie
    // RN-TOR-EQ5, borde del trámite: 36 h pasa el umbral de SOAT/impuesto (24 h) pero no el del trámite (48 h).
    const t7 = await s.tramite({ cia: x, flitEstado: 'Asignado' });
    await estado(t7, b, haceHoras(36)); // carga de Bruno dentro del ANS
    // ── SOAT, impuesto, derecho, traslado e incompleta de y.
    const s1 = await soat(y, 'solicitado');
    await historialProducto('soat', s1, c, '2035-03-10T15:00:00Z'); // gestión y carga de Carla
    const s2 = await soat(y, 'pagado');
    await tx`UPDATE flito_soat SET gestion_operaciones = true, gestion_operaciones_por_id = ${b}, gestion_operaciones_en = '2035-03-11T15:00:00Z' WHERE id = ${s2}`;
    const t6 = await s.tramite({ cia: y, flitEstado: 'Asignado' });
    await s.impuesto({ tramiteId: t6, cia: y, organismo: '05001', valorPagado: null, pagadoEn: null, estado: 'solicitado' });
    const [imp] = await tx`SELECT id FROM flito_impuestos WHERE tramite_id = ${t6}`;
    await historialProducto('impuesto', imp!.id as string, b, haceHoras(u.horas_soat_impuesto_sin_soporte * 2)); // carga de Bruno fuera de ANS
    await s.derecho({ tramiteId: t6, cia: y, organismo: '05001', valor: 100, fechaPago: '2035-03-12' });
    await tx`UPDATE flito_derechos_tramite SET registrado_por_id = ${c}, created_at = '2035-03-12T15:00:00Z' WHERE tramite_id = ${t6}`;
    await tx`INSERT INTO flito_logistica_traslados (compania_id, origen, destino, estado, registrado_en, registrado_por_id)
      VALUES (${y}, 'organismo', 'flit', 'registrado', '2035-03-15T15:00:00Z', ${a})`;
    // RN-TOR-EQ5, borde del traslado: 12 h antes de su umbral (`dias_traslado_abierto` × 24) y por encima de los de
    // trámite (48 h) y SOAT/impuesto (24 h) con el valor por defecto (3 días = 72 h → 60 h).
    expect(u.dias_traslado_abierto * 24 - 12).toBeGreaterThan(48);
    await tx`INSERT INTO flito_logistica_traslados (compania_id, origen, destino, estado, registrado_en, registrado_por_id)
      VALUES (${y}, 'flit', 'cliente', 'en_ruta', ${haceHoras(u.dias_traslado_abierto * 24 - 12)}, ${c})`; // carga de Carla dentro del ANS
    await tx`INSERT INTO flito_soat_incompletas (soat_id_reservado, compania_id, tipo_soat, modalidad_consulta, placa,
        solicitado_por_nombre, estado, motivo_descarte, resuelta_por_id, resuelta_por_nombre, resuelta_en)
      VALUES (gen_random_uuid(), ${y}, 'renovacion', 'placa', 'ZQE009', 'Quien pidió', 'descartada', 'soat_vigente', ${a},
        'Ana Restrepo', '2035-03-20T15:00:00Z')`;
    return { a, b, c, filtro: { rango: { desde: '2035-03-01', hasta: HOY }, companiaIds: [x, y] } as FiltroTorre };
  }

  const detalle = (filtro: FiltroTorre, d: DestinoCifra) => {
    if (d.tipo !== 'conjunto') throw new Error('se esperaba un destino de conjunto');
    return consultarDetalle({ origen: d.origen, segmentos: d.segmentos, filtro, pagina: 1, tamano: 100 },
      { alcance: TODO, dinero: true, funciones: FUNCIONES, hoy: HOY });
  };

  it('B5-AC2: cada KPI y cada celda por funcionario abre un detalle con su mismo número; la suma de las filas es la KPI', async () => {
    const { a, b, c, filtro } = await escenario();
    const t = await tableroEquipo({ filtro, alcance: TODO, dinero: true, hoy: HOY });
    expect(t.cifras).toEqual({ funcionarios: 3, gestionesPeriodo: 8, cargaAbierta: 8, fueraAns: 2 });
    expect(t.porFuncionario.map((f) => [f.funcionarioId, f.nombre, f.gestionesPeriodo, f.cargaAbierta, f.fueraAns])).toEqual([
      [String(a), 'Ana Restrepo', 4, 3, 1],
      [String(b), 'Bruno Cárdenas', 2, 3, 1],
      [String(c), 'Carla Zuluaga', 2, 2, 0],
    ]);
    expect(t.frase).toBe('3 funcionarios registraron gestiones en el periodo; hoy tienen 8 gestiones abiertas a su cargo.');
    for (const col of Object.keys(CONJUNTO_POR_COLUMNA_EQUIPO) as (keyof typeof CONJUNTO_POR_COLUMNA_EQUIPO)[]) {
      const kpi = t.explicaciones[col]!;
      expect((await detalle(filtro, kpi.destino)).total, `kpi ${col}`).toBe(t.cifras[col]);
      expect(t.porFuncionario.reduce((acc, f) => acc + f[col], 0), `suma ${col}`).toBe(t.cifras[col]);
      for (const f of t.porFuncionario) {
        const d = f.destinos[col];
        if (f[col] === 0) { expect(d, `${f.nombre}.${col}`).toEqual({ tipo: 'ninguno' }); continue; }
        expect(d).toEqual({ tipo: 'conjunto', origen: { tipo: 'conjunto', conjunto: CONJUNTO_POR_COLUMNA_EQUIPO[col] },
          segmentos: [{ dimension: 'funcionario', valores: [f.funcionarioId] }] });
        const r = await detalle(filtro, d);
        expect(r.total, `${f.nombre}.${col}`).toBe(f[col]);
        expect(r.filas.every((fila) => fila.celdas.funcionario === f.nombre), `${f.nombre}.${col}`).toBe(true);
      }
    }
  });

  it('el detalle lista qué se gestionó, la placa y el último movimiento, sin correos en ninguna salida', async () => {
    const { a, filtro } = await escenario();
    const t = await tableroEquipo({ filtro, alcance: TODO, dinero: true, hoy: HOY });
    expect(JSON.stringify(t)).not.toMatch(/@|secreto/);
    const seg = [{ dimension: 'funcionario' as const, valores: [String(a)] }];
    const periodo = await detalle(filtro, { tipo: 'conjunto', origen: { tipo: 'conjunto', conjunto: 'gestiones_funcionario_periodo' }, segmentos: seg });
    expect(periodo.filas.map((f) => f.celdas.que_se_gestiono).sort()).toEqual(['Solicitud', 'Traslado', 'Trámite', 'Trámite']);
    expect(periodo.filas.map((f) => f.celdas.placa)).toContain('ZQE001');
    const carga = await detalle(filtro, { tipo: 'conjunto', origen: { tipo: 'conjunto', conjunto: 'carga_funcionario' } });
    expect(carga.columnas.map((c) => c.id)).toEqual(conjuntoTorre('carga_funcionario').columnas);
    expect(carga.filas.every((f) => f.celdas.ultimo_movimiento != null)).toBe(true);
    for (const id of IDS) {
      const d = await detalle(filtro, { tipo: 'conjunto', origen: { tipo: 'conjunto', conjunto: id } });
      expect(JSON.stringify(d), id).not.toMatch(/@|secreto/);
    }
  });

  it('sin gestiones: todo en 0, sin filas, frase de vacío y destinos «ninguno»', async () => {
    const x = await s.cia('Cía vacía');
    const t = await tableroEquipo({ filtro: { rango: { desde: '2035-03-01', hasta: HOY }, companiaIds: [x] } as FiltroTorre, alcance: TODO, dinero: true, hoy: HOY });
    expect(t.cifras).toEqual({ funcionarios: 0, gestionesPeriodo: 0, cargaAbierta: 0, fueraAns: 0 });
    expect(t.porFuncionario).toEqual([]);
    expect(t.explicaciones.cargaAbierta!.destino).toEqual({ tipo: 'ninguno' });
    expect(t.frase).toBe('Nadie del equipo registró gestiones en el periodo ni tiene gestiones abiertas.');
  });

  // ── B5-AC1: la ruta ───────────────────────────────────────────────────────────────────────────────
  const reparto = leerRepartoSembrado();
  const ROLES = ['admin', 'gerencia_general', 'gerencia_comercial', 'financiera', 'auditor'] as const;
  const filas = new Map<number, FilasPermisos>();
  const token = (sub: number) => new SignJWT({ username: 'u', role: 'x' }).setProtectedHeader({ alg: 'HS256' }).setSubject(String(sub))
    .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const app = express();
  app.use(express.json());
  app.use('/api/flito/torre/tableros', tableros);
  const MARZO = { filtro: { rango: { desde: '2035-03-01', hasta: '2035-03-31' }, companiaIds: [1] } };

  it('B5-AC1: 401 sin token; 403 para gerencia_comercial, financiera y auditor; 200 para gerencia_general y admin; sin /exportar', async () => {
    filas.clear();
    permisos.fijarFuenteDePermisos(async (id: number) => filas.get(id) ?? null);
    ROLES.forEach((rol, i) => {
      permisos.invalidarPermisosDe(i + 1);
      filas.set(i + 1, { rol, tipoEnlace: 'ninguno', proveedor: null, funcionesDelRol: [...(reparto.get(rol) ?? [])], excepciones: [] });
    });
    const ruta = '/api/flito/torre/tableros/operativa/equipo';
    expect((await request(app).post(ruta).send(MARZO)).status).toBe(401);
    const estados: Record<string, number> = {};
    for (const [i, rol] of ROLES.entries()) estados[rol] = (await request(app).post(ruta).set('Authorization', `Bearer ${await token(i + 1)}`).send(MARZO)).status;
    expect(estados).toEqual({ admin: 200, gerencia_general: 200, gerencia_comercial: 403, financiera: 403, auditor: 403 });
    // El auditor sí ve Operativa: el 403 es por el equipo, no por la Torre.
    expect((await request(app).post('/api/flito/torre/tableros/operativa/soportes').set('Authorization', `Bearer ${await token(5)}`).send(MARZO)).status).toBe(200);
    expect((await request(app).post(`${ruta}/exportar`).set('Authorization', `Bearer ${await token(1)}`).send(MARZO)).status).toBe(404);
  });
});
