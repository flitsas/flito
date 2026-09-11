// HU #12082 — El ÚNICO resolutor de permisos: qué funciones tiene un usuario, leído de la base.
//
// Nació en la HU #12081 resolviendo solo las páginas (`paginasEfectivasDeUsuario`) y desde esta HU
// es el motor entero: `resolverPermisos(userId)` devuelve el conjunto efectivo de funciones
// (`pagina.*` y `operacion.*`), el rol y el `tipo_principal` del rol, y lo cachea 60 s por usuario.
// Lo consumen `exigirFuncion` (la guarda HTTP), `requirePage` (que es `exigirFuncion('pagina.<slug>')`),
// `guardiaCanalCliente` (la frontera del canal externo, que lee `tipoPrincipal` de aquí y no del
// literal del rol), `GET /api/permisos/mios`, el login y `/me`. No hay una segunda definición de
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
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { permisosRoles, permisosRolFuncion, permisosUsuarioFuncion, users } from '../db/schema.js';
import { isValidPage, type PageSlug } from '@operaciones/shared-types';
import { loggerFor } from './logger.js';

const log = loggerFor('permisos');

const PREFIJO = 'pagina.';

export type TipoPrincipal = 'interno' | 'externo';

export interface PermisosOk {
  ok: true;
  userId: number;
  /** `users.role` leído de la base, NO del token. */
  rol: string;
  /** `permisos_roles.tipo_principal` del rol. */
  tipoPrincipal: TipoPrincipal;
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
  tipoPrincipal: TipoPrincipal;
  funcionesDelRol: string[];
  excepciones: { codigo: string; efecto: 'conceder' | 'revocar' }[];
}

export type FuentePermisos = (userId: number) => Promise<FilasPermisos | null>;

export const PERMISOS_CACHE_TTL_MS = 60_000;

const cache = new Map<number, { valor: PermisosOk; expiraEn: number }>();

/**
 * Las tres consultas, en secuencia y con `db.select` (no un CTE): el `chainEspia` de las pruebas
 * captura cada `where` por separado y afirma que el de `permisos_rol_funcion` lleva el rol LEÍDO de
 * la fila de `users` y el de `permisos_usuario_funcion` el `userId`. De `users` se pide `role` y
 * nada más: ni `allowed_pages` (congelada, HU #12087), ni correo, ni nombre, ni documento.
 */
async function leerFilasDePermisos(userId: number): Promise<FilasPermisos | null> {
  const [fila] = await db.select({
    rol: users.role,
    tipoPrincipal: permisosRoles.tipoPrincipal,
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
    tipoPrincipal: fila.tipoPrincipal === 'externo' ? 'externo' : 'interno',
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

/** (R ∪ C) \ V. La resta es lo último: revocar gana ante cualquier colisión. */
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
  for (const e of filas.excepciones) {
    if (e.efecto === 'revocar') conjunto.delete(e.codigo);
  }
  return conjunto;
}

function versionDe(rol: string, tipoPrincipal: TipoPrincipal, funciones: Set<string>): string {
  return createHash('sha256')
    .update(`${rol}|${tipoPrincipal}|${[...funciones].sort().join(',')}`)
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

  let filas: FilasPermisos | null;
  try {
    filas = await fuente(userId);
  } catch (err) {
    log.warn({ userId, err: (err as Error)?.message }, 'resolverPermisos: fallo de base — se niega');
    return { ok: false, userId, motivo: 'resolucion' };
  }
  if (!filas) return { ok: false, userId, motivo: 'sin_usuario' };

  const funciones = conjuntoEfectivo(filas);
  const valor: PermisosOk = {
    ok: true,
    userId,
    rol: filas.rol,
    tipoPrincipal: filas.tipoPrincipal,
    funciones,
    version: versionDe(filas.rol, filas.tipoPrincipal, funciones),
    resueltoEn: new Date(ahora),
  };
  cache.set(userId, { valor, expiraEn: ahora + PERMISOS_CACHE_TTL_MS });
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
 * Las páginas que este usuario ve hoy, como slugs: una VISTA del resolutor para el login y `/me`, que
 * pintan un menú y no deciden nada. Con `ok:false` devuelve `[]`: la decisión la toma `exigirFuncion`
 * en cada petición, y un menú vacío ante un fallo de base es la degradación correcta.
 */
export async function paginasEfectivasDeUsuario(userId: number): Promise<PageSlug[]> {
  const p = await resolverPermisos(userId);
  if (!p.ok) return [];
  const paginas: PageSlug[] = [];
  for (const codigo of p.funciones) {
    if (esPaginaViva(codigo)) paginas.push(codigo.slice(PREFIJO.length) as PageSlug);
  }
  return paginas;
}
