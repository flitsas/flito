// HU #12082 — El ÚNICO resolutor de permisos: qué funciones tiene un usuario, leído de la base.
//
// Nació en la HU #12081 resolviendo solo las páginas (`paginasEfectivasDeUsuario`) y desde esta HU
// es el motor entero: `resolverPermisos(userId)` devuelve el conjunto efectivo de funciones
// (`pagina.*` y `operacion.*`), el rol y su `tipo_enlace` (Bug #12869; desde la HU #12875 la única
// frontera, ADR-0024), y lo cachea 60 s por usuario.
// Lo consumen `exigirFuncion` (la guarda HTTP), `requirePage` (que es `exigirFuncion('pagina.<slug>')`),
// `guardiaFrontera` (la frontera por enlace, que lee `tipoEnlace` de aquí y no del literal del rol),
// `GET /api/permisos/mios`, el login y `/me`. No hay una segunda definición de
// «quién puede»: la pantalla y el servidor leen la misma foto.
//
// ── La regla: (R ∪ C) \ V, y qué fuente decide cada familia ─────────────────────────────────────
//
//   · R — `permisos_rol_funcion` del rol del usuario (páginas y operaciones).
//   · C — lo concedido al USUARIO: TODAS las filas `conceder` de `permisos_usuario_funcion`, páginas
//     (`pagina.*`, filtradas por `esPaginaViva`) y operaciones por igual. Desde la HU #12087 la tabla
//     es la ÚNICA fuente de las excepciones por usuario: `users.allowed_pages` está congelada (0188),
//     no se escribe ni se lee aquí (`leerFilasDePermisos` no pide la columna).
//   · V — `permisos_usuario_funcion` con efecto `revocar`, para las dos familias. Un `revocar
//     pagina.<slug>` saca la página del menú y de `requirePage` aunque el rol la dé (AC2).
//
// La resta va ÚLTIMA: ante una colisión (una fila `conceder` del rol y una `revocar` del usuario sobre
// el mismo código) **revocar gana**. Es la lectura de RN-A6 coherente con negar por defecto, y es lo
// que hace observable el mutante del AC8 de la #12087 (quitar el bucle de `revocar`).
//
// ── Fail-closed, al contrario que `getSessionInvalidatedMs` ─────────────────────────────────────
//
// Un fallo al leer la base NO devuelve un conjunto vacío: devuelve `{ ok:false, motivo:'resolucion' }`,
// que no se cachea y que `exigirFuncion` convierte en un 403 cuyo texto dice «no se pudo verificar»,
// no «su rol no tiene esa función». Un conjunto vacío sería indistinguible de «no tiene nada», se
// cachearía 60 s y el 403 mentiría. Este resolutor NUNCA rechaza: `ok:false` es una decisión.
//
// ── La caché ────────────────────────────────────────────────────────────────────────────────────
//
// `Map<user_id, …>` con TTL de 60 s, la forma de `sessInvalMemCache` (auth.ts) sin la capa Redis: el
// API corre en una instancia y la invalidación en memoria es exacta e inmediata. Quien escribe sobre
// un usuario llama `invalidarPermisosDe(id)` DESPUÉS del commit (users.routes.ts); quien edite la
// matriz de un rol (HU #12084) llamará `invalidarPermisosDeRol(codigo)`.
//
// ── El seam de pruebas ──────────────────────────────────────────────────────────────────────────
//
// La lectura de filas es UNA función sustituible (`fijarFuenteDePermisos`, solo pruebas, rechaza en
// producción). La regla, `isValidPage`, el hash y la caché corren igual sobre la fuente real y sobre
// el double: lo que se sustituye son las filas, no la decisión. `__tests__/helpers/auth.ts` la fija al
// importarse, para que los ~172 ficheros que firman tokens de prueba no consuman tres `selectMock` por
// petición. No es una bandera de entorno a propósito (§10 del diseño).
import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { flitoProveedores, permisosRoles, permisosRolFuncion, permisosUsuarioFuncion, users } from '../db/schema.js';
import {
  MODULO_FRONTERA_DE_PAGINA, SERVICIO_DE_MODULO, isValidPage, paginaAbiertaAlEnlace, TIPOS_ENLACE,
  type PageSlug, type ServicioProveedor, type TipoEnlace as TipoEnlaceContrato,
} from '@operaciones/shared-types';
import { loggerFor } from './logger.js';
import { alternativasDe, expandir } from '../modules/permisos/arbol/expansion.js';

const log = loggerFor('permisos');

const PREFIJO = 'pagina.';

/**
 * Bug #12869 / HU #12875 — `permisos_roles.tipo_enlace`: a qué entidad ata el rol a sus usuarios.
 * Decide la FRONTERA (qué módulos alcanza, `frontera-enlace.ts`) y el ALCANCE de datos (qué filas ve).
 * `null` = un valor que este código no conoce: quien lo consuma debe tratarlo como «nada» (fallo
 * cerrado), nunca como `ninguno` (que significa «decide el permiso»).
 */
export type TipoEnlace = TipoEnlaceContrato;

/**
 * Alias TRANSITORIO (HU #12875, diseño §7.2): `'proveedor_soat'` es el valor previo a la 0231. Si la
 * imagen nueva arranca antes de que alguien aplique la 0231 a mano (PDN), los gestores no pierden
 * SOAT. Se retira con la columna del tipo interno/externo (retirada) en el WI de contracción.
 */
const ALIAS_ENLACE: Readonly<Record<string, TipoEnlace>> = Object.freeze({ proveedor_soat: 'proveedor' });

export function enlaceConocido(v: string | null | undefined): TipoEnlace | null {
  if (v == null) return null;
  if ((TIPOS_ENLACE as readonly string[]).includes(v)) return v as TipoEnlace;
  return ALIAS_ENLACE[v] ?? null;
}

/**
 * HU #14338 (ADR-0039 §6.1) — El proveedor del usuario, para la frontera por servicio. Solo se lee con
 * enlace `proveedor`. `activo` ya descuenta la baja del padre, y `servicios` son los perfiles vivos.
 */
export interface ProveedorDePermisos {
  id: string;
  activo: boolean;
  servicios: readonly ServicioProveedor[];
}

export interface PermisosOk {
  ok: true;
  userId: number;
  /** `users.role` leído de la base, NO del token. */
  rol: string;
  /** `permisos_roles.tipo_enlace` del rol (Bug #12869); `null` si el valor no es uno conocido. */
  tipoEnlace: TipoEnlace | null;
  /** HU #14338: `null` sin enlace `proveedor`, o con ese enlace y sin proveedor resoluble (fallo cerrado). */
  proveedor: ProveedorDePermisos | null;
  /** El conjunto efectivo: (R ∪ C) \ V. */
  funciones: ReadonlySet<string>;
  /** Hash del conjunto: cambia si y solo si cambia lo que este usuario puede. */
  version: string;
  resueltoEn: Date;
}

export type PermisosResueltos =
  | PermisosOk
  | { ok: false; userId: number; motivo: 'resolucion' | 'sin_usuario' };

/** Las filas crudas de las que sale la decisión. Es lo que el double de pruebas sustituye. */
export interface FilasPermisos {
  rol: string;
  /** Crudo, como viene de la base; `resolverPermisos` lo normaliza (desconocido → `null`). */
  tipoEnlace: string | null;
  /** HU #14338: ausente en los pliegues por lote, que no deciden frontera. */
  proveedor?: ProveedorDePermisos | null;
  funcionesDelRol: string[];
  excepciones: { codigo: string; efecto: 'conceder' | 'revocar' }[];
}

export type FuentePermisos = (userId: number) => Promise<FilasPermisos | null>;

export const PERMISOS_CACHE_TTL_MS = 60_000;

const cache = new Map<number, { valor: PermisosOk; expiraEn: number }>();

/**
 * HU #14338 (AC6): sube con cada `invalidarPermisosDeProveedor`. Una lectura que empezó ANTES del commit y
 * termina DESPUÉS de invalidar traería la foto vieja: no se cachea y la siguiente petición vuelve a leer.
 */
let generacionProveedores = 0;

/** HU #14338: el padre y sus servicios vivos. Un id sin fila devuelve `null` y la frontera cierra (AC4). */
async function leerProveedorDePermisos(id: string): Promise<ProveedorDePermisos | null> {
  const [padre] = await db.select({ id: flitoProveedores.id, activo: flitoProveedores.activo, deletedAt: flitoProveedores.deletedAt })
    .from(flitoProveedores).where(eq(flitoProveedores.id, id)).limit(1);
  if (!padre) return null;
  const rows = await db.execute<{ servicio: ServicioProveedor }>(
    sql`SELECT servicio FROM flito_proveedor_servicios_v WHERE proveedor_id = ${id}`,
  );
  return { id: padre.id, activo: padre.activo && padre.deletedAt == null, servicios: [...rows].map((r) => r.servicio).sort() };
}

/**
 * Las tres consultas, en secuencia y con `db.select` (no un CTE): el `chainEspia` de las pruebas
 * captura cada `where` por separado y afirma que el de `permisos_rol_funcion` lleva el rol LEÍDO de
 * la fila de `users` y el de `permisos_usuario_funcion` el `userId`. De `users` se pide `role` y
 * nada más: ni `allowed_pages` (congelada, HU #12087), ni correo, ni nombre, ni documento.
 */
async function leerFilasDePermisos(userId: number): Promise<FilasPermisos | null> {
  const [fila] = await db.select({
    rol: users.role,
    tipoEnlace: permisosRoles.tipoEnlace,
    proveedorId: users.flitoProveedorId,
  })
    .from(users)
    .innerJoin(permisosRoles, eq(permisosRoles.codigo, users.role))
    .where(eq(users.id, userId))
    .limit(1);
  if (!fila) return null;

  const delRol = await db.select({ codigo: permisosRolFuncion.funcionCodigo })
    .from(permisosRolFuncion)
    .where(eq(permisosRolFuncion.rolCodigo, fila.rol));

  const propias = await db.select({
    codigo: permisosUsuarioFuncion.funcionCodigo,
    efecto: permisosUsuarioFuncion.efecto,
  })
    .from(permisosUsuarioFuncion)
    .where(eq(permisosUsuarioFuncion.userId, userId));

  return {
    rol: fila.rol,
    tipoEnlace: fila.tipoEnlace,
    proveedor: enlaceConocido(fila.tipoEnlace) === 'proveedor' && fila.proveedorId
      ? await leerProveedorDePermisos(fila.proveedorId)
      : null,
    funcionesDelRol: delRol.map((r) => r.codigo),
    excepciones: propias.map((p) => ({
      codigo: p.codigo,
      efecto: p.efecto === 'revocar' ? 'revocar' : 'conceder',
    })),
  };
}

let fuente: FuentePermisos = leerFilasDePermisos;

/**
 * SOLO PRUEBAS. Sustituye la lectura de filas (no la regla) y vacía la caché. `null` repone la real.
 * Lanza en producción: un double de permisos en producción es una puerta abierta.
 */
export function fijarFuenteDePermisos(nueva: FuentePermisos | null): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('fijarFuenteDePermisos es solo para pruebas');
  }
  fuente = nueva ?? leerFilasDePermisos;
  cache.clear();
}

/**
 * Un código de página cuenta solo si lleva el prefijo Y su slug sigue en el catálogo. El
 * `startsWith` NO es redundante con `isValidPage` (medido con un mutante el 9/09/2026): un código de
 * DOS segmentos con un módulo de seis letras —`bolsas.transito`— cortado a ciegas daría el slug
 * `transito` y concedería una pantalla que nadie dio.
 */
function esPaginaViva(codigo: string): boolean {
  return codigo.startsWith(PREFIJO) && isValidPage(codigo.slice(PREFIJO.length));
}

/**
 * (R ∪ C) \ V, y desde la HU #12873 (ADR-0025) EXPANDIDO: cada `accion.*` efectiva aporta sus
 * operaciones (`arbol/expansion.ts`). La resta va al final también sobre lo expandido: revocar gana.
 * HU #13429 (P-25, opción A): la excepción del usuario entra en M y DESPUÉS manda la cadena: conceder una
 * acción cuyo ítem (o elemento) no tiene ni su rol ni él no la habilita.
 */
function conjuntoEfectivo(filas: FilasPermisos): Set<string> {
  const conjunto = new Set<string>();
  for (const codigo of filas.funcionesDelRol) {
    if (codigo.startsWith(PREFIJO)) { if (esPaginaViva(codigo)) conjunto.add(codigo); }
    else conjunto.add(codigo);
  }
  for (const e of filas.excepciones) {
    if (e.efecto !== 'conceder') continue;
    // Una página concedida cuenta solo si su slug sigue en el catálogo, igual que las del rol.
    if (e.codigo.startsWith(PREFIJO)) { if (esPaginaViva(e.codigo)) conjunto.add(e.codigo); }
    else conjunto.add(e.codigo);
  }
  const revocados = filas.excepciones.filter((e) => e.efecto === 'revocar').map((e) => e.codigo);
  for (const r of revocados) conjunto.delete(r);
  return expandir(conjunto, revocados);
}

function versionDe(rol: string, tipoEnlace: TipoEnlace | null, funciones: Set<string>, proveedor: ProveedorDePermisos | null): string {
  // Sin proveedor el hash es el de siempre: la versión de los demás enlaces no cambia con este despliegue.
  const delProveedor = proveedor ? `|${proveedor.id}|${proveedor.activo}|${[...proveedor.servicios].sort().join(',')}` : '';
  return createHash('sha256')
    .update(`${rol}|${tipoEnlace ?? '?'}|${[...funciones].sort().join(',')}${delProveedor}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * El conjunto efectivo de un usuario. NUNCA rechaza: un `ok:false` es una decisión, no una excepción.
 * Solo se cachea `ok:true`; el fallo se devuelve y se olvida, y la siguiente petición vuelve a leer.
 */
export async function resolverPermisos(userId: number): Promise<PermisosResueltos> {
  const ahora = Date.now();
  const acierto = cache.get(userId);
  if (acierto && acierto.expiraEn > ahora) return acierto.valor;

  const generacion = generacionProveedores;
  let filas: FilasPermisos | null;
  try {
    filas = await fuente(userId);
  } catch (err) {
    log.warn({ userId, err: (err as Error)?.message }, 'resolverPermisos: fallo de base — se niega');
    return { ok: false, userId, motivo: 'resolucion' };
  }
  if (!filas) return { ok: false, userId, motivo: 'sin_usuario' };

  const funciones = conjuntoEfectivo(filas);
  const tipoEnlace = enlaceConocido(filas.tipoEnlace);
  const proveedor = tipoEnlace === 'proveedor' ? filas.proveedor ?? null : null;
  const valor: PermisosOk = {
    ok: true,
    userId,
    rol: filas.rol,
    tipoEnlace,
    proveedor,
    funciones,
    version: versionDe(filas.rol, tipoEnlace, funciones, proveedor),
    resueltoEn: new Date(ahora),
  };
  if (generacion === generacionProveedores) cache.set(userId, { valor, expiraEn: ahora + PERMISOS_CACHE_TTL_MS });
  return valor;
}

/** Borra la entrada de UN usuario. Se llama DESPUÉS del commit de la escritura que lo cambió. */
export function invalidarPermisosDe(userId: number): void {
  cache.delete(userId);
}

/** Borra las entradas de TODOS los usuarios cuyo rol cacheado sea ese código. La llamará la #12084. */
export function invalidarPermisosDeRol(rolCodigo: string): void {
  for (const [userId, { valor }] of cache) {
    if (valor.rol === rolCodigo) cache.delete(userId);
  }
}

/**
 * HU #14338 (ADR-0039 §6.1) — Borra de la caché a todos los usuarios de ese proveedor. Se llama DESPUÉS
 * del commit de cada cambio de servicio o de estado: sin esto el módulo seguiría abierto hasta 60 s.
 */
export function invalidarPermisosDeProveedor(proveedorId: string): void {
  generacionProveedores += 1;
  for (const [userId, { valor }] of cache) {
    if (valor.proveedor?.id === proveedorId) cache.delete(userId);
  }
}

/**
 * HU #14338 (AC1, AC3): ¿deja el enlace `proveedor` esta página en el menú? Tiene que estar abierta a ese
 * enlace y, si su módulo pide un servicio, el proveedor activo debe prestarlo. Falla cerrado sin proveedor.
 */
function paginaVisibleParaProveedor(slug: PageSlug, proveedor: ProveedorDePermisos | null): boolean {
  if (!paginaAbiertaAlEnlace(slug, 'proveedor')) return false;
  const modulo = MODULO_FRONTERA_DE_PAGINA[slug];
  const servicio = modulo ? SERVICIO_DE_MODULO[modulo] : undefined;
  return !servicio || (proveedor?.activo === true && proveedor.servicios.includes(servicio));
}

/** ¿Pide servicio el módulo de esta página y el proveedor no lo presta? Sin proveedor activo, cierra. */
function faltaServicioDePagina(slug: string, proveedor: ProveedorDePermisos | null): boolean {
  const modulo = MODULO_FRONTERA_DE_PAGINA[slug as PageSlug];
  const servicio = modulo ? SERVICIO_DE_MODULO[modulo] : undefined;
  return servicio !== undefined && !(proveedor?.activo === true && proveedor.servicios.includes(servicio));
}

/**
 * ADR-0040 §3 — Las funciones del conjunto que `/me` publica, simétrica a `paginasDePermisos`: con enlace
 * `proveedor` quita las que solo cuelgan de páginas cuyo módulo pide un servicio que el proveedor no presta
 * (sin proveedor activo, falla cerrado). Es una PROYECCIÓN para pintar: no decide nada; la decisión de la ruta
 * la toma la frontera por servicio de `conAlcance`. Una función cuenta si ALGUNA de sus cadenas (`alternativasDe`)
 * pasa por una página que el proveedor sí ve; la que no cuelga de ninguna página (`menu.*`) se conserva.
 */
export function funcionesDePermisos(p: PermisosOk): string[] {
  const todas = [...p.funciones].sort();
  if (p.tipoEnlace !== 'proveedor') return todas;
  return todas.filter((codigo) => {
    const paginas = new Set<string>();
    if (codigo.startsWith(PREFIJO)) paginas.add(codigo);
    for (const cadena of alternativasDe(codigo)) for (const c of cadena) if (c.startsWith(PREFIJO)) paginas.add(c);
    if (paginas.size === 0) return true;
    return [...paginas].some((pg) => !faltaServicioDePagina(pg.slice(PREFIJO.length), p.proveedor));
  });
}

/** Los slugs vivos de un conjunto, ya con la frontera por servicio del enlace `proveedor` aplicada. */
export function paginasDePermisos(p: PermisosOk): PageSlug[] {
  const paginas: PageSlug[] = [];
  for (const codigo of p.funciones) {
    if (!esPaginaViva(codigo)) continue;
    const slug = codigo.slice(PREFIJO.length) as PageSlug;
    if (p.tipoEnlace !== 'proveedor' || paginaVisibleParaProveedor(slug, p.proveedor)) paginas.push(slug);
  }
  return paginas;
}

/**
 * Las páginas que este usuario ve hoy, como slugs: una VISTA del resolutor para el login y `/me`, que
 * pintan un menú y no deciden nada. Con `ok:false` devuelve `[]`: la decisión la toma `exigirFuncion`
 * en cada petición, y un menú vacío ante un fallo de base es la degradación correcta.
 */
export async function paginasEfectivasDeUsuario(userId: number): Promise<PageSlug[]> {
  const p = await resolverPermisos(userId);
  return p.ok ? paginasDePermisos(p) : [];
}

/**
 * HU #13425 — Quién tiene HOY una función (y, opcionalmente, no tiene otra), para reglas del tipo
 * «a quién se le puede asignar» o «quién recibe el aviso» que antes filtraban por `users.role`.
 *
 * Misma semántica que `resolverPermisos` por construcción: lee las mismas filas (rol ∪ conceder ∖
 * revocar, rol presente en `permisos_roles`) y las pliega con el MISMO `conjuntoEfectivo`; lo único
 * que cambia es que son tres consultas para todos los usuarios activos, no N resoluciones. Solo
 * usuarios sin baja lógica. `permisos.usuarios-con-funcion.test.ts` lo compara contra el resolutor
 * sobre el mismo fixture.
 */
export async function usuariosConFuncion(codigo: string, opts: { sin?: string } = {}): Promise<number[]> {
  // HU #12873: una operación absorbida por el árbol ya no tiene filas propias; la dan sus acciones.
  // HU #13429: y con la cadena hacen falta también sus ancestros (ítem y elemento), o el pliegue los cortaría.
  const filasDe = (c: string) => [c, ...alternativasDe(c).flat()];
  const codigos = [...new Set([...filasDe(codigo), ...(opts.sin ? filasDe(opts.sin) : [])])];
  const principales = await db.select({
    id: users.id,
    rol: users.role,
    tipoEnlace: permisosRoles.tipoEnlace,
  })
    .from(users)
    .innerJoin(permisosRoles, eq(permisosRoles.codigo, users.role))
    .where(isNull(users.deletedAt));
  if (principales.length === 0) return [];

  const delRol = await db.select({ rol: permisosRolFuncion.rolCodigo, codigo: permisosRolFuncion.funcionCodigo })
    .from(permisosRolFuncion)
    .where(inArray(permisosRolFuncion.funcionCodigo, codigos));
  const propias = await db.select({
    userId: permisosUsuarioFuncion.userId,
    codigo: permisosUsuarioFuncion.funcionCodigo,
    efecto: permisosUsuarioFuncion.efecto,
  })
    .from(permisosUsuarioFuncion)
    .where(and(inArray(permisosUsuarioFuncion.funcionCodigo, codigos)));

  const filas = new Map<number, FilasPermisos>();
  for (const p of principales) {
    filas.set(p.id, {
      rol: p.rol,
      tipoEnlace: p.tipoEnlace,
      funcionesDelRol: delRol.filter((r) => r.rol === p.rol).map((r) => r.codigo),
      excepciones: propias.filter((e) => e.userId === p.id)
        .map((e) => ({ codigo: e.codigo, efecto: e.efecto === 'revocar' ? 'revocar' : 'conceder' })),
    });
  }
  return filtrarPorFuncion(filas, codigo, opts.sin);
}

/**
 * El pliegue puro de `usuariosConFuncion`, exportado para la prueba de equivalencia con el resolutor.
 * Devuelve los ids ordenados de menor a mayor.
 */
export function filtrarPorFuncion(filas: ReadonlyMap<number, FilasPermisos>, codigo: string, sin?: string): number[] {
  const ids: number[] = [];
  for (const [id, f] of filas) {
    const conjunto = conjuntoEfectivo(f);
    if (conjunto.has(codigo) && !(sin && conjunto.has(sin))) ids.push(id);
  }
  return ids.sort((a, b) => a - b);
}

/**
 * HU #13967 — De estas compañías, cuáles tienen HOY al menos un usuario con la función `codigo`.
 *
 * La usa `GET /clients` para el aviso `permisoSinTramiteSinEfecto` (AC7): una compañía SIN proveedor
 * de SOAT sin trámite cuyos usuarios ya tienen `soat.solicitud.crear` tiene un permiso que no surte
 * efecto. Solo responde ids de compañía: ningún dato de usuario sale de aquí.
 *
 * Misma semántica que `usuariosConFuncion` / `resolverPermisos` por construcción: las mismas filas
 * (rol ∪ conceder ∖ revocar, códigos por `alternativasDe` para la regla de cadena) plegadas con el
 * MISMO `conjuntoEfectivo`. Solo usuarios sin baja lógica, con `users.compania_id` en `companiaIds` y
 * con el enlace `compania` en su rol (otro enlace no radica a nombre de su compañía). Sin ids → no
 * consulta. `permisos.companias-con-funcion.test.ts` lo compara contra el resolutor.
 */
export async function companiasConUsuarioConFuncion(codigo: string, companiaIds: number[]): Promise<Set<number>> {
  const ids = [...new Set(companiaIds)];
  if (ids.length === 0) return new Set();
  const codigos = [...new Set([codigo, ...alternativasDe(codigo).flat()])];
  const principales = await db.select({
    id: users.id,
    companiaId: users.companiaId,
    rol: users.role,
    tipoEnlace: permisosRoles.tipoEnlace,
  })
    .from(users)
    .innerJoin(permisosRoles, eq(permisosRoles.codigo, users.role))
    .where(and(isNull(users.deletedAt), inArray(users.companiaId, ids)));
  const candidatos = principales.filter((p) => p.companiaId != null && enlaceConocido(p.tipoEnlace) === 'compania');
  if (candidatos.length === 0) return new Set();

  const delRol = await db.select({ rol: permisosRolFuncion.rolCodigo, codigo: permisosRolFuncion.funcionCodigo })
    .from(permisosRolFuncion)
    .where(inArray(permisosRolFuncion.funcionCodigo, codigos));
  const propias = await db.select({
    userId: permisosUsuarioFuncion.userId,
    codigo: permisosUsuarioFuncion.funcionCodigo,
    efecto: permisosUsuarioFuncion.efecto,
  })
    .from(permisosUsuarioFuncion)
    .where(and(
      inArray(permisosUsuarioFuncion.funcionCodigo, codigos),
      inArray(permisosUsuarioFuncion.userId, candidatos.map((c) => c.id)),
    ));

  const usuarios = candidatos.map((p) => ({
    companiaId: p.companiaId as number,
    filas: {
      rol: p.rol,
      tipoEnlace: p.tipoEnlace,
      funcionesDelRol: delRol.filter((r) => r.rol === p.rol).map((r) => r.codigo),
      excepciones: propias.filter((e) => e.userId === p.id)
        .map((e) => ({ codigo: e.codigo, efecto: e.efecto === 'revocar' ? 'revocar' as const : 'conceder' as const })),
    } satisfies FilasPermisos,
  }));
  return companiasConFuncion(usuarios, codigo);
}

/**
 * El pliegue puro de `companiasConUsuarioConFuncion`, exportado para la prueba de equivalencia con el
 * resolutor. Un usuario cuenta si su conjunto efectivo tiene `codigo` y su enlace es `compania`.
 */
export function companiasConFuncion(
  usuarios: ReadonlyArray<{ companiaId: number; filas: FilasPermisos }>, codigo: string,
): Set<number> {
  const companias = new Set<number>();
  for (const u of usuarios) {
    if (enlaceConocido(u.filas.tipoEnlace) !== 'compania') continue;
    if (conjuntoEfectivo(u.filas).has(codigo)) companias.add(u.companiaId);
  }
  return companias;
}
