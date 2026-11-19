// Torre de Control Gerencial (Épica #14590, ADR-0047, B1a) — `/api/flito/torre/detalle` por HTTP, sin base: 401/403 por
// función (AC9), SIN_ORIGEN y SIN_DINERO antes de tocar la base, Zod cerrado (AC11), `logPiiAccess` en toda consulta
// válida que proyecta la placa, también con 0 filas (AC10), y que la placa del filtro solo viaja en el body (AC7).
// Son reales `authMiddleware`, `exigirFuncion`/`tieneFuncion`, Zod y la resolución del servicio; el resultado de la
// consulta (que sí toca la base) se sustituye solo en los casos que lo necesitan.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { SignJWT } from 'jose';
import type { ResultadoDetalle } from '@operaciones/shared-types';

vi.mock('../../../src/db/client.js', () => {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'innerJoin', 'leftJoin']) c[m] = () => c;
  (c as { then: unknown }).then = (res: (v: unknown) => void) => res([]);
  return {
    db: { select: () => c, insert: () => ({ values: () => Promise.resolve() }), transaction: () => Promise.reject(new Error('sin base en este archivo')) },
    getPoolStats: vi.fn(),
  };
});
vi.mock('../../../src/shared/redis.js', () => ({ getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false) }));
const pii = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../src/shared/pii-audit.js', () => ({ logPiiAccess: pii }));
const detalleSvc = { consultarDetalle: vi.fn() };
vi.mock('../../../src/modules/flito-torre/flito-torre.detalle.service.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, (...a: unknown[]) => unknown>>();
  detalleSvc.consultarDetalle.mockImplementation((...a: unknown[]) => real.consultarDetalle!(...a));
  return { ...real, consultarDetalle: (...a: unknown[]) => detalleSvc.consultarDetalle(...a) };
});

const permisos = await import('../../../src/shared/permisos-efectivos.js');
const { default: router } = await import('../../../src/modules/flito-torre/flito-torre.detalle.routes.js');
import type { FilasPermisos } from '../../../src/shared/permisos-efectivos.js';
import { conCadena } from '../../helpers/auth.js';

const filas = new Map<number, FilasPermisos>();
const de = (id: number, funciones: string[]) => {
  filas.set(id, { rol: `r${id}`, tipoEnlace: 'ninguno', proveedor: null, funcionesDelRol: conCadena(funciones), excepciones: [] });
};
const token = (sub: number) => new SignJWT({ username: 'u', role: 'x' }).setProtectedHeader({ alg: 'HS256' }).setSubject(String(sub))
  .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));

const app = express();
app.use(express.json());
app.use('/api/flito/torre/detalle', router);
const pide = async (ruta: string, sub: number, body: object) =>
  request(app).post(`/api/flito/torre/detalle${ruta}`).set('Authorization', `Bearer ${await token(sub)}`).send(body);

const VER = 'accion.torre_detalle.ver';
const MARZO = { rango: { desde: '2035-03-01', hasta: '2035-03-31' } };
const consulta = (o: object = {}) => ({ origen: { tipo: 'conjunto', conjunto: 'borrador_abandonado' }, filtro: MARZO, pagina: 1, tamano: 25, ...o });

const vacio = (o: Partial<ResultadoDetalle> = {}): ResultadoDetalle => ({
  origen: { tipo: 'conjunto', conjunto: 'borrador_abandonado' }, segmentos: [],
  definicion: { etiqueta: 'Borradores abandonados', definicion: 'x', fechaBase: null, campoFecha: 'estado actual' },
  total: 0, valorTotal: null, columnas: [], filas: [], pagina: 1, tamano: 25, truncado: false, filtrosIgnorados: ['rango'],
  rango: null, dineroVisible: false, generadoEn: '2035-03-31T00:00:00.000Z', ...o,
});

beforeEach(() => {
  filas.clear();
  permisos.fijarFuenteDePermisos(async (id: number) => filas.get(id) ?? null);
  for (const i of [1, 2, 3, 4, 5]) permisos.invalidarPermisosDe(i);
  pii.mockClear(); detalleSvc.consultarDetalle.mockClear();
  de(1, ['accion.torre_operativa.ver']);                                                     // sin torre.detalle.ver
  de(2, [VER, 'accion.torre_operativa.ver', 'accion.torre_financiera.ver']);                 // ve, sin dinero
  de(3, [VER, 'accion.torre_comercial.ver', 'accion.torre_explorador.consultar', 'accion.torre_explorador.ver_dinero']); // como gerencia_comercial
  de(4, [VER, 'accion.torre_360.ver']);                                                      // como auditor (sin exportar)
  de(5, [VER, 'accion.torre_detalle.exportar', 'accion.torre_operativa.ver']);
});

describe('AC9 · permisos', () => {
  it('401 sin token', async () => {
    const r = await request(app).post('/api/flito/torre/detalle/consultar').send(consulta());
    expect(r.status).toBe(401);
  });

  it('403 sin torre.detalle.ver, en consultar y exportar', async () => {
    expect((await pide('/consultar', 1, consulta())).status).toBe(403);
    expect((await pide('/exportar', 1, { origen: { tipo: 'conjunto', conjunto: 'borrador_abandonado' }, filtro: MARZO })).status).toBe(403);
  });

  it('un rol como gerencia_comercial (sin el tablero financiero) que pide margen_aprobados recibe 403 SIN_ORIGEN', async () => {
    const r = await pide('/consultar', 3, consulta({ origen: { tipo: 'conjunto', conjunto: 'margen_aprobados' } }));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SIN_ORIGEN');
  });

  it('la métrica del Explorador exige torre.metricas.consultar: sin ella, SIN_ORIGEN', async () => {
    const r = await pide('/consultar', 2, consulta({ origen: { tipo: 'metrica', metrica: 'tramites_creados' } }));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SIN_ORIGEN');
  });

  it('un conjunto requiereDinero sin torre.metricas.dinero es 403 SIN_DINERO; una métrica de dinero, también', async () => {
    const r = await pide('/consultar', 2, consulta({ origen: { tipo: 'conjunto', conjunto: 'margen_aprobados' } }));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SIN_DINERO');
    de(6, [VER, 'accion.torre_explorador.consultar']);
    permisos.invalidarPermisosDe(6);
    const m = await pide('/consultar', 6, consulta({ origen: { tipo: 'metrica', metrica: 'ingreso_liquidado' } }));
    expect(m.status).toBe(403);
    expect(m.body.code).toBe('SIN_DINERO');
  });

  it('el auditor (ver sin exportar) recibe 403 al exportar', async () => {
    const r = await pide('/exportar', 4, { origen: { tipo: 'conjunto', conjunto: 'tramites_creados' }, filtro: MARZO });
    expect(r.status).toBe(403);
  });
});

describe('AC11 · Zod cerrado (400 DATOS_INVALIDOS)', () => {
  const casos: [string, object][] = [
    ['conjunto desconocido', consulta({ origen: { tipo: 'conjunto', conjunto: 'no_existe' } })],
    ['segmento desconocido', consulta({ segmentos: [{ dimension: 'cedula', valores: ['1'] }] })],
    ['segmento no admitido por el conjunto', consulta({ segmentos: [{ dimension: 'tipo_tramite', valores: ['Traspaso'] }] })],
    ['columna de orden desconocida', consulta({ orden: { columna: 'flit_raw', dir: 'asc' } })],
    ['columna de orden no ordenable', consulta({ orden: { columna: 'compania', dir: 'asc' } })],
    ['campo desconocido', consulta({ sql: '1=1' })],
    ['tamano de 37', consulta({ tamano: 37 })],
    ['placa con comodín', consulta({ filtrosDetalle: { placa: 'AB%' } })],
    ['más de 2 segmentos', consulta({ origen: { tipo: 'conjunto', conjunto: 'tramites_creados' }, segmentos: [
      { dimension: 'compania', valores: ['1'] }, { dimension: 'organismo', valores: ['05001'] }, { dimension: 'mes', valores: ['2035-03'] }] })],
    ['página más allá de 10.000 filas', consulta({ pagina: 101, tamano: 100 })],
    ['fecha base fuera de la matriz', consulta({ origen: { tipo: 'metrica', metrica: 'tramites_creados', fechaBase: 'pago' } })],
  ];
  it.each(casos)('%s', async (_, body) => {
    const r = await pide('/consultar', 3, body);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('DATOS_INVALIDOS');
    expect(detalleSvc.consultarDetalle).not.toHaveBeenCalled();
  });

  it('un valor de severidad desconocido lo rechaza el servicio (400), no la base', async () => {
    const r = await pide('/consultar', 2, consulta({ segmentos: [{ dimension: 'severidad', valores: ['grave'] }] }));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('DATOS_INVALIDOS');
  });
});

describe('AC10 · Habeas Data', () => {
  it('registra read + placa + recurso de la entidad en toda consulta válida, aunque traiga 0 filas', async () => {
    detalleSvc.consultarDetalle.mockResolvedValueOnce(vacio());
    const r = await pide('/consultar', 2, consulta({ filtrosDetalle: { placa: 'abc123' } }));
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(pii).toHaveBeenCalledTimes(1);
    expect(pii.mock.calls[0]![1]).toEqual({
      resourceTipo: 'flito_tramite', accion: 'read', camposAccedidos: ['placa'], motivo: 'Torre de Control: detalle borrador_abandonado',
    });
    // AC7: la placa llega normalizada en el body (y nunca en el motivo del log).
    expect(detalleSvc.consultarDetalle.mock.calls[0]![0]).toMatchObject({ filtrosDetalle: { placa: 'ABC123' } });
    expect(JSON.stringify(pii.mock.calls[0]![1])).not.toContain('ABC123');
  });

  it('la gestión de SOAT se registra contra flito_soat', async () => {
    detalleSvc.consultarDetalle.mockResolvedValueOnce(vacio());
    await pide('/consultar', 2, consulta({ origen: { tipo: 'conjunto', conjunto: 'soat_sin_gestion' } }));
    expect(pii.mock.calls[0]![1]).toMatchObject({ resourceTipo: 'flito_soat', accion: 'read' });
  });

  it('un 403 no registra acceso (no se proyectó nada)', async () => {
    await pide('/consultar', 3, consulta({ origen: { tipo: 'conjunto', conjunto: 'margen_aprobados' } }));
    expect(pii).not.toHaveBeenCalled();
  });
});
