// HU #12875 (Feature #12871, Épica #13411) — La frontera por ENLACE. Sustituye la lista blanca por
// ruta del principal «externo» (`canal-cliente.ts`, Feature #11912). Decisión y alternativas:
// docs/adr/ADR-0024-frontera-por-enlace-declarada-en-el-montaje.md.
//
// ── La regla ────────────────────────────────────────────────────────────────────────────────────
//
//   · Enlace `ninguno` → la frontera no interviene: decide el permiso (`exigirFuncion`, AC4).
//   · Enlace `compania` / `proveedor` / `organismos_transito` → solo alcanza los MÓDULOS que
//     `FRONTERA_POR_ENLACE` (shared-types) le abre, más las `RUTAS_TRANSVERSALES` de sesión. Todo lo
//     demás → 403 (AC2, AC5).
//   · Enlace desconocido o resolutor que no decide (`ok:false`) → solo las transversales (fallo
//     cerrado, la misma dirección que tenía el canal externo).
//
// ── Dónde se declara un módulo: en el MONTAJE ───────────────────────────────────────────────────
//
// `app.use('/api/flito/soat', conAlcance('soat', router))`. `conAlcance` marca la petición con el
// módulo mientras recorre ese router y RESTAURA el valor previo cuando el router la deja pasar (para
// que dos montajes sobre el mismo prefijo no se hereden la marca). Un montaje SIN `conAlcance` no
// marca nada → cerrado para todo enlace. Así nace cerrado cualquier router futuro (AC3), sin que su
// autor tenga que saber que la frontera existe.
//
// ── Dónde se aplica: al final de `authMiddleware` ───────────────────────────────────────────────
//
// La autenticación no está en `app.ts`: cada router monta `authMiddleware` por su cuenta. Un
// `app.use` previo vería `req.user === undefined`. El único punto donde la autenticación termina es
// el final de `authMiddleware`, y ahí se llama `guardiaFrontera`. Es una capa ANTERIOR al permiso: las
// dos se suman y ninguna sustituye a la otra (marcarle todas las funciones a un rol con enlace no lo
// saca de su frontera).
//
// La frontera es CÓDIGO y no configuración: no se lee de ninguna tabla y ninguna ruta la modifica.
// El 403 conserva el cuerpo `{ error: 'Sin permisos' }`, indistinguible del de `requireRole`, y no se
// loguea la ruta cruda.
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { eq } from 'drizzle-orm';
import {
  FRONTERA_POR_ENLACE, MODULOS_FRONTERA, type EnlaceRestringido, type ModuloFrontera, type TipoEnlace,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoGestorOrganismos, users } from '../../db/schema.js';
import { resolverPermisos } from '../permisos-efectivos.js';
import { catalogoCompleto } from '../../modules/permisos/catalogo.js';

/** Lo que la guarda deja en la petición para quien venga detrás (#13426). */
export interface FronteraResuelta {
  enlace: TipoEnlace;
  /** `null` si la petición pasó por una transversal o el enlace es `ninguno`. */
  modulo: ModuloFrontera | null;
}

/** ENGANCHE de #13426: el id concreto del enlace, leído de la base en cada petición (no del token). */
export type AlcanceResuelto =
  | { enlace: 'ninguno' }
  | { enlace: 'compania'; companiaId: number | null }
  | { enlace: 'proveedor'; proveedorId: string | null }
  | { enlace: 'organismos_transito'; organismos: string[] }
  | { enlace: null };

declare module 'express-serve-static-core' {
  interface Request {
    /** Módulo declarado por el montaje que la petición está recorriendo (`conAlcance`). */
    fronteraModulo?: ModuloFrontera;
    /** Lo que decidió `guardiaFrontera`. */
    frontera?: FronteraResuelta;
    /** Memo por petición de `alcanceDe`. */
    alcanceMemo?: Promise<AlcanceResuelto>;
  }
}

export type MetodoHttp = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RutaTransversal {
  metodo: MetodoHttp;
  /** Ruta ABSOLUTA con los mismos `:params` que declara el router. Nunca un prefijo. */
  patron: string;
  /** Qué se rompe si se quita. Sin esto la lista se vuelve incrementable «por si acaso». */
  porque: string;
}

/**
 * Lo que CUALQUIER usuario autenticado alcanza, tenga el enlace que tenga: la sesión. Son las cuatro
 * entradas de la lista del canal externo que no eran de SOAT (las de SOAT las cubre ahora
 * `conAlcance('soat', …)`). Tablero y Ayuda no están: Ayuda es markdown del bundle y no llama al API;
 * el Tablero se abre por módulo (#13426). Congelada (array y cada entrada) para poder afirmarlo.
 */
export const RUTAS_TRANSVERSALES: readonly RutaTransversal[] = congelar([
  {
    metodo: 'GET', patron: '/api/auth/me',
    porque: 'Sin esto no hay sesión: `AuthProvider` la pide al montar y un fallo lo desloguea.',
  },
  {
    metodo: 'GET', patron: '/api/permisos/mios',
    porque: 'La SPA lee de aquí qué pintar (menú). Devuelve SOLO el conjunto del propio usuario.',
  },
  {
    metodo: 'POST', patron: '/api/auth/logout',
    porque: 'Cerrar sesión. Negarlo dejaría el token vivo en el navegador y sin revocar en Redis.',
  },
  {
    metodo: 'PATCH', patron: '/api/users/:id/password',
    porque: 'Cambiar SU PROPIA contraseña desde Perfil (HU #13255). El handler responde 403 a un '
      + 'usuario con enlace sobre un id que no es el suyo o sin `pagina.perfil`, exige la contraseña '
      + 'actual y `passwordChangeLimiter` pone la cuota.',
  },
]);

function congelar(lista: RutaTransversal[]): readonly RutaTransversal[] {
  return Object.freeze(lista.map((r) => Object.freeze({ ...r })));
}

const escapar = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `:param` casa un segmento y solo uno; la barra final es opcional (strict routing desactivado). */
function aExpresion(patron: string): RegExp {
  const cuerpo = patron.split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : escapar(seg))).join('/');
  return new RegExp(`^${cuerpo}/?$`);
}

const COMPILADAS: ReadonlyArray<{ metodo: MetodoHttp; re: RegExp }> = RUTAS_TRANSVERSALES
  .map((r) => ({ metodo: r.metodo, re: aExpresion(r.patron) }));

/** ¿Es este método + ruta (sin query) una transversal? */
export function esRutaTransversal(metodo: string, ruta: string): boolean {
  return COMPILADAS.some((c) => c.metodo === metodo.toUpperCase() && c.re.test(ruta));
}

/** ¿Abre la tabla este módulo a este enlace? `ninguno` no pasa por aquí (lo alcanza todo). */
export function moduloAbiertoA(modulo: ModuloFrontera | undefined, enlace: TipoEnlace | null): boolean {
  if (!modulo || enlace === null || enlace === 'ninguno') return false;
  return (FRONTERA_POR_ENLACE[modulo] as readonly EnlaceRestringido[]).includes(enlace);
}

/**
 * Declara el módulo de un montaje. La marca vive solo mientras la petición recorre ESE router: si el
 * router la deja pasar (`next()` sin respuesta), se restaura el valor previo antes de seguir.
 */
export function conAlcance(modulo: ModuloFrontera, router: RequestHandler): RequestHandler {
  if (!(MODULOS_FRONTERA as readonly string[]).includes(modulo)) {
    throw new Error(`conAlcance: módulo de frontera desconocido «${modulo}»`);
  }
  const envoltorio: RequestHandler = (req, res, next) => {
    const previo = req.fronteraModulo;
    req.fronteraModulo = modulo;
    router(req, res, (err?: unknown) => {
      req.fronteraModulo = previo;
      next(err as Parameters<NextFunction>[0]);
    });
  };
  // Para el test centinela (AC3): qué montajes declaran módulo. No interviene en la decisión.
  // Enumerables a propósito: `express-async-errors` envuelve cada handle y solo copia las propiedades
  // enumerables; sin esto el centinela no vería la declaración. Solo lectura.
  Object.defineProperty(envoltorio, 'fronteraModulo', { value: modulo, enumerable: true });
  Object.defineProperty(envoltorio, 'fronteraRouter', { value: router, enumerable: true });
  return envoltorio;
}

/**
 * La guarda. Se invoca desde el final de `authMiddleware`, con `req.user` ya resuelto. El enlace sale
 * del resolutor (base, caché 60 s), NUNCA del token.
 */
export async function guardiaFrontera(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) { res.status(401).json({ error: 'Token requerido' }); return; }
  const p = await resolverPermisos(req.user.sub);
  const enlace = p.ok ? p.tipoEnlace : null;
  if (enlace === 'ninguno') { req.frontera = { enlace, modulo: null }; next(); return; }

  // `originalUrl` y no `req.path`: dentro del router montado `req.path` es relativo.
  const ruta = (req.originalUrl ?? req.url ?? '').split('?')[0]!;
  if (esRutaTransversal(req.method, ruta)) {
    if (enlace !== null) req.frontera = { enlace, modulo: null };
    next();
    return;
  }
  if (enlace !== null && moduloAbiertoA(req.fronteraModulo, enlace)) {
    req.frontera = { enlace, modulo: req.fronteraModulo! };
    next();
    return;
  }
  res.status(403).json({ error: 'Sin permisos' });
}

/**
 * Middleware de RUTA: cierra a todo enlace una ruta concreta dentro de un router abierto
 * (configuración, catálogo u operación interna de FLIT). Lo usa #13426; ninguna ruta SOAT lo necesita
 * (todas acotan por `contextoSoat`).
 */
export function soloSinEnlace(): RequestHandler {
  const guarda: RequestHandler = (req, res, next) => {
    if (req.frontera?.enlace === 'ninguno') { next(); return; }
    res.status(403).json({ error: 'Sin permisos' });
  };
  // HU #13426: marca para el centinela (qué rutas de un router abierto quedan cerradas a todo enlace).
  // Enumerable por lo mismo que `fronteraModulo` (express-async-errors copia solo las enumerables).
  Object.defineProperty(guarda, 'fronteraSoloSinEnlace', { value: true, enumerable: true });
  return guarda;
}

/** El id del enlace de un usuario, leído de la base. Un id ausente → el módulo devuelve CERO filas. */
export async function alcanceDeUsuario(userId: number, enlace: TipoEnlace | null): Promise<AlcanceResuelto> {
  switch (enlace) {
    case 'ninguno': return { enlace };
    case 'compania': case 'proveedor': {
      const [u] = await db.select({ c: users.companiaId, p: users.flitoProveedorSoatId })
        .from(users).where(eq(users.id, userId)).limit(1);
      return enlace === 'compania'
        ? { enlace, companiaId: u?.c ?? null }
        : { enlace, proveedorId: u?.p ?? null };
    }
    case 'organismos_transito': {
      const filas = await db.select({ c: flitoGestorOrganismos.organismoCodigo })
        .from(flitoGestorOrganismos).where(eq(flitoGestorOrganismos.userId, userId));
      if (filas.length > 0) return { enlace, organismos: filas.map((f) => f.c).sort() };
      // HU #13426 (P-4): fallback a la columna OBSOLETA `users.transito_codigo` (HU #12088) para los
      // usuarios que aún no tengan filas en la puente. Se conserva lo que hacía `transito-scope.ts`.
      const [u] = await db.select({ t: users.transitoCodigo }).from(users).where(eq(users.id, userId)).limit(1);
      const legado = u?.t?.trim();
      return { enlace, organismos: legado ? [legado] : [] };
    }
    default: return { enlace: null };
  }
}

/** ENGANCHE de #13426: el alcance del usuario de esta petición, con memo por petición. */
export function alcanceDe(req: Request): Promise<AlcanceResuelto> {
  if (!req.user) return Promise.resolve({ enlace: null });
  if (!req.alcanceMemo) {
    const userId = req.user.sub;
    req.alcanceMemo = resolverPermisos(userId)
      .then((p) => alcanceDeUsuario(userId, p.ok ? p.tipoEnlace : null));
  }
  return req.alcanceMemo;
}

let moduloDeFuncion: Map<string, string> | null = null;

/**
 * Para el aviso del panel (RN-A1): ¿alcanza este enlace por HTTP una función? Sí si su módulo del
 * catálogo está abierto al enlace. `ninguno` alcanza todo. Una función fuera del catálogo, no.
 */
export function funcionesAlcanzables(enlace: TipoEnlace): (codigo: string) => boolean {
  if (enlace === 'ninguno') return () => true;
  moduloDeFuncion ??= new Map(catalogoCompleto().map((f) => [f.codigo, f.modulo]));
  const mapa = moduloDeFuncion;
  return (codigo) => {
    const modulo = mapa.get(codigo);
    return (MODULOS_FRONTERA as readonly string[]).includes(modulo ?? '')
      && moduloAbiertoA(modulo as ModuloFrontera, enlace);
  };
}
