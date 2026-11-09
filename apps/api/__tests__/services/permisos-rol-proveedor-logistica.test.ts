// ADR-0040 (Feature #14326, HU #14351 y #14353) — El rol `proveedor` trae el perfil «Coordinador de proveedor» de logística
// (0298) y `/me` publica sus funciones con la frontera por servicio (`funcionesDePermisos`). Sin base: lo doble es la LECTURA de
// filas (`fijarFuenteDePermisos`); la regla en cadena, el hash y la proyección son los reales. Las filas del rol salen del SQL de
// la 0298 (`bloquesRepartoUnRol`), no de una copia en el test: si la migración pierde una fila, aquí se nota.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db/client.js', () => {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'innerJoin', 'leftJoin']) c[m] = () => c;
  (c as { then: unknown }).then = (res: (v: unknown) => void) => res([]);
  return { db: { select: () => c, insert: () => ({ values: () => Promise.resolve() }) }, getPoolStats: vi.fn() };
});
vi.mock('../../src/shared/redis.js', () => ({
  getRedis: () => null, closeRedis: vi.fn(), redisHealthy: vi.fn().mockResolvedValue(false),
}));

const permisos = await import('../../src/shared/permisos-efectivos.js');
const { FUNCION_OPERAR_AJENAS } = await import('../../src/modules/flito-logistica/flito-logistica.mensajeros.js');
const { repartoDePartida } = await import('../../src/modules/permisos/catalogo.js');
import type { FilasPermisos, PermisosOk, ProveedorDePermisos } from '../../src/shared/permisos-efectivos.js';
import { bloquesRepartoUnRol } from '../helpers/permisos-seed-sql.js';
import { leerMigracion } from '../helpers/base-en-tx.js';

const [[ROL_0298, FILAS_0298]] = bloquesRepartoUnRol(leerMigracion('0298_permisos_rol_proveedor_logistica.sql')) as [[string, string[]]];
// Lo que el rol ya traía (SOAT) y la rama del menú que comparten las dos páginas.
const SOAT = ['menu.gestion', 'pagina.flito_soat', 'accion.soat.ver_listado', 'accion.soat.cargar_comprobantes'];
const ROL = [...SOAT, ...FILAS_0298!];

const P = (servicios: ('soat' | 'logistica')[], activo = true): ProveedorDePermisos => ({ id: 'p-a', activo, servicios });
const filas = new Map<number, FilasPermisos>();
const fuente = vi.fn(async (id: number) => filas.get(id) ?? null);
const de = (id: number, proveedor: ProveedorDePermisos | null, o: { tipoEnlace?: string; excepciones?: FilasPermisos['excepciones'] } = {}) => {
  filas.set(id, { rol: 'proveedor', tipoEnlace: o.tipoEnlace ?? 'proveedor', proveedor, funcionesDelRol: ROL, excepciones: o.excepciones ?? [] });
};
const resolver = async (id: number): Promise<PermisosOk> => {
  const p = await permisos.resolverPermisos(id);
  if (!p.ok) throw new Error('resolución fallida');
  return p;
};
const esLogistica = (c: string) => c.startsWith('logistica.') || c.startsWith('accion.logistica.') || c.startsWith('accion.mi_ruta.') || c.startsWith('pagina.flito_logistica');
const esSoat = (c: string) => c.startsWith('soat.') || c.startsWith('accion.soat.') || c === 'pagina.flito_soat';

beforeEach(() => { filas.clear(); fuente.mockClear(); permisos.fijarFuenteDePermisos(fuente); });

describe('0298 — reparto del rol proveedor', () => {
  it('siembra el perfil Coordinador y nada de lo que ADR-0040 deja fuera', () => {
    expect(ROL_0298).toBe('proveedor');
    expect(FILAS_0298).toHaveLength(15);
    for (const cerrada of ['accion.logistica.cerrar_lote', 'accion.logistica.reversar_paso', 'accion.logistica.registrar_viajes',
      'logistica.actas.firmar_flit', 'logistica.documento.dejar_pendiente', 'logistica.documento.resolver_tramite',
      'logistica.actas.ver_documento_firmante', 'logistica.motivos.gestionar']) expect(FILAS_0298).not.toContain(cerrada);
  });

  it('el reparto de partida del código trae las mismas 15 filas para proveedor', () => {
    const delCodigo = new Set(repartoDePartida().filter(([r]) => r === 'proveedor').map(([, c]) => c));
    for (const c of FILAS_0298!) expect(delCodigo.has(c), c).toBe(true);
  });
});

describe('funcionesDePermisos — la frontera por servicio en `/me`', () => {
  it('proveedor solo de SOAT: sin logística ni Mi ruta; conserva SOAT y el menú', async () => {
    de(1, P(['soat']));
    const p = await resolver(1);
    expect([...p.funciones].some(esLogistica)).toBe(true); // las filas existen (latentes)…
    const f = permisos.funcionesDePermisos(p);
    expect(f.filter(esLogistica)).toEqual([]); // …pero `/me` no las publica
    expect(f).toContain('soat.solicitud.ver');
    expect(f).toContain('pagina.flito_soat');
    expect(f).toContain('menu.gestion');
  });

  it('proveedor solo de Logística: sin SOAT; con consola, actas, Mi ruta y viaje a cliente', async () => {
    de(2, P(['logistica']));
    const f = permisos.funcionesDePermisos(await resolver(2));
    expect(f.filter(esSoat)).toEqual([]);
    for (const c of ['pagina.flito_logistica', 'pagina.flito_logistica_ruta', 'logistica.consola.ver', 'logistica.lt.validar',
      'logistica.actas.entregar', 'logistica.ruta.ver', 'logistica.traslado.registrar', 'logistica.recogida.confirmar']) expect(f, c).toContain(c);
  });

  it('sin proveedor activo, falla cerrado para los dos servicios', async () => {
    de(3, P(['soat', 'logistica'], false));
    de(4, null);
    for (const id of [3, 4]) {
      const f = permisos.funcionesDePermisos(await resolver(id));
      expect(f.filter((c) => esSoat(c) || esLogistica(c))).toEqual([]);
      expect(f).toContain('menu.gestion');
    }
  });

  it('otro enlace no se proyecta: devuelve el conjunto entero, ordenado', async () => {
    de(5, null, { tipoEnlace: 'ninguno' });
    const p = await resolver(5);
    expect(permisos.funcionesDePermisos(p)).toEqual([...p.funciones].sort());
  });
});

describe('ADR-0040 §2 y el mensajero de proveedor', () => {
  it('anular un viaje es efectiva con despachar_entregar_devolver, sin reversar_paso', async () => {
    de(6, P(['logistica']));
    const p = await resolver(6);
    expect(p.funciones.has('accion.logistica.reversar_paso')).toBe(false);
    expect(p.funciones.has('logistica.documento.reversar')).toBe(false);
    expect(p.funciones.has('logistica.traslado.anular')).toBe(true);
    expect(permisos.funcionesDePermisos(p)).toContain('logistica.traslado.anular');
  });

  it('con operar ajenas (el coordinador) no es mensajero; revocada al usuario, sí', async () => {
    de(7, P(['logistica']));
    de(8, P(['logistica']), { excepciones: [{ codigo: FUNCION_OPERAR_AJENAS, efecto: 'revocar' }] });
    const coordinador = await resolver(7);
    const mensajero = await resolver(8);
    // La regla de `flito-logistica.mensajeros.ts`: tiene `logistica.actas.entregar` y no tiene `operar_ajenas`.
    const esMensajero = (p: PermisosOk) => p.funciones.has('logistica.actas.entregar') && !p.funciones.has(FUNCION_OPERAR_AJENAS);
    expect(esMensajero(coordinador)).toBe(false);
    expect(esMensajero(mensajero)).toBe(true);
  });
});
