// HU #12082 — La guarda HTTP del motor único: `exigirFuncion('<codigo>')`.
//
// ESTE ES EL ÚNICO SITIO donde una ruta pregunta «¿puede este usuario esta función?». Se hereda la
// forma de `exigirAccionSiigo` (siigo.permisos.ts) —401 sin `req.user`, evaluación entera en el
// servidor, bitácora sin `await` con `.catch`, 403 con `{ error, <clave> }`— y cambia UNA cosa: la
// fuente de la decisión pasa del rol del token contra un mapa compilado a la identidad verificada
// contra la base (`resolverPermisos(req.user.sub)`, RN-A5). Del token se usa `sub`, y `role` solo
// para el texto de la bitácora (AC3).
//
// Vive en `shared/middleware/` junto a `requireRole` y `guardiaCanalCliente` porque es transversal a
// todos los módulos. `requirePage(slug)` (shared/permissions.ts) es `exigirFuncion('pagina.<slug>')`:
// páginas y operaciones pasan por el mismo camino (AC7, RN-A4).
//
// Se monta siempre DESPUÉS de `authMiddleware` y A NIVEL DE RUTA (ADR-0016 §2): un
// `exigirFuncion('<codigo>')` en la línea de cada `router.<método>(...)`, nunca en un `router.use`.
// La #12082 lo entregó con un router de laboratorio y `requirePage`; la #12083 lo montó en las 219
// rutas de FLITO, trámites y usuarios en lugar de `requireRole`. Cuando la decisión depende del cuerpo
// o de la identidad (`_forzarContinuar`, contraseña ajena) el handler pregunta con `tieneFuncion`.
//
// ── El 403 distingue los casos (AC5, RN-A9, CF-14) ──────────────────────────────────────────────
//
//   motivo          | cuándo                                                   | error
//   sin_funcion     | el conjunto tiene OTRA función del mismo módulo          | «Su rol no tiene esa función («<nombre>»).»
//   sin_modulo      | el conjunto no tiene NINGUNA función de ese módulo       | «No tiene acceso a este módulo («<modulo>»).»
//   no_reconocida   | el código no está en el catálogo del código              | «Función no reconocida.»
//   no_resuelto     | el resolutor devolvió `ok:false` (fallo de base)         | «No se pudo verificar el permiso. Intente de nuevo.»
//
// `motivo` es el discriminador para la pantalla (#12083); ningún texto lleva correo, nombre ni id.
// El `modulo` de un código sale del catálogo del CÓDIGO (`catalogoCompleto()`), que el arranque ya
// garantiza idéntico al de la base: para las operaciones coincide con el primer segmento del código;
// para las páginas es el grupo de `PAGE_GROUPS`. No hay consulta a `permisos_funciones` en el camino
// del 403.
//
// La `ruta` de la bitácora es la plantilla de la ruta o el path enmascarado (`rutaDe`): ni cédula, ni
// placa, ni VIN, ni token entran en `permisos_intentos_denegados` (ADR-0016 §2).
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { catalogoCompleto } from '../../modules/permisos/catalogo.js';
import { resolverPermisos } from '../permisos-efectivos.js';
import {
  registrarIntentoDenegado, type MotivoDenegacion,
} from '../historial/permisos-intentos-denegados.js';

export type { MotivoDenegacion };

interface EntradaCatalogo { modulo: string; nombreNegocio: string }

let indice: Map<string, EntradaCatalogo> | null = null;

/** El catálogo indexado por código, construido UNA vez y en la primera denegación (no al importar). */
function catalogoIndexado(): Map<string, EntradaCatalogo> {
  if (!indice) {
    indice = new Map(catalogoCompleto().map((f) => [f.codigo, { modulo: f.modulo, nombreNegocio: f.nombreNegocio }]));
  }
  return indice;
}

/**
 * Por qué se niega un código que el conjunto NO contiene. Pura: no consulta nada.
 *
 * «Módulo» es el del catálogo (para `soat.solicitud.crear` es `soat`; para `pagina.users` es el grupo
 * `administracion`). Si el conjunto tiene alguna otra función de ese módulo, el usuario ya está dentro
 * y le falta ESTA; si no tiene ninguna, no está en el módulo.
 */
export function motivoDenegacionFuncion(
  conjunto: ReadonlySet<string>,
  codigo: string,
): Exclude<MotivoDenegacion, 'no_resuelto'> {
  const catalogo = catalogoIndexado();
  const pedida = catalogo.get(codigo);
  if (!pedida) return 'no_reconocida';
  for (const c of conjunto) {
    if (catalogo.get(c)?.modulo === pedida.modulo) return 'sin_funcion';
  }
  return 'sin_modulo';
}

/** El texto canónico de cada motivo. La pantalla no lo analiza: para eso está `motivo`. */
export function textoDe(motivo: MotivoDenegacion, codigo: string): string {
  const entrada = catalogoIndexado().get(codigo);
  switch (motivo) {
    case 'sin_funcion': return `Su rol no tiene esa función («${entrada?.nombreNegocio ?? codigo}»).`;
    case 'sin_modulo': return `No tiene acceso a este módulo («${entrada?.modulo ?? codigo}»).`;
    case 'no_reconocida': return 'Función no reconocida.';
    case 'no_resuelto': return 'No se pudo verificar el permiso. Intente de nuevo.';
  }
}

/**
 * Un segmento del path que parece un DATO y no un nombre de recurso: cédula/NIT/teléfono (≥5 dígitos
 * seguidos), placa colombiana (`ABC123`, `ABC12D`), VIN (17 alfanuméricos sin I/O/Q) o un token /
 * keyHash / id opaco (≥24 alfanuméricos, hex o base64url seguidos) o un correo (`@`, también
 * codificado como `%40`). Las reglas van SIN anclar a propósito: un uuid con guiones (36 caracteres de
 * esa clase) o un NIT con dígito de verificación (`900123456-1`) también se enmascaran — sobre-
 * enmascarar un id opaco no pierde nada; dejar pasar una cédula sí. Un slug (`cola`, `facetas`,
 * `historial`) no cae en ninguna. Esta heurística es el respaldo: la garantía completa es montar la
 * guarda A NIVEL DE RUTA, donde `rutaDe` guarda la plantilla y no hay dato que enmascarar.
 */
const SEGMENTO_CON_DATO = [
  /\d{5,}/,
  /^[A-Z]{3}\d{2}[A-Z0-9]$/i,
  /^[A-HJ-NPR-Z0-9]{17}$/i,
  /[A-Za-z0-9_-]{24,}/,
  /@|%40/,
];

function enmascarar(path: string): string {
  return path.split('/')
    .map((seg) => (SEGMENTO_CON_DATO.some((re) => re.test(seg)) ? '*' : seg))
    .join('/');
}

/**
 * La `ruta` de la bitácora: la PLANTILLA de la ruta cuando existe, y si no, el path enmascarado.
 * NUNCA el dato. `ruta` es varchar(300) y se corta; la query se descarta siempre.
 *
 * Hay rutas con cédula, NIT, placa, VIN, token o keyHash como parámetro de PATH (`/preview/:docNumber`
 * en privacy, `/candidatos/:placa` en flito-derechos, `/:vin/...` en vehicles, los `/:token` de los
 * portales). Hoy ninguna pasa por aquí; cuando la #12083 monte la guarda, sí. Por eso:
 *
 *   · Guarda a nivel de RUTA (`router.get('/preview/:docNumber', exigirFuncion(...), h)`): Express ya
 *     rellenó `req.route` al entrar a la cadena, y `req.baseUrl + req.route.path` es la plantilla
 *     (`/api/privacy/preview/:docNumber`), sin dato. El `baseUrl` se enmascara por si el router se
 *     montó con un parámetro en el prefijo.
 *   · Guarda a nivel de ROUTER (`router.use(exigirFuncion(...))`), o `req.route.path` que no es un
 *     string (array o RegExp): `originalUrl` sin query con cada segmento con pinta de dato → `*`.
 */
export function rutaDe(req: Request): string {
  const plantilla: unknown = req.route?.path;
  const path = typeof plantilla === 'string'
    ? enmascarar(req.baseUrl || '') + plantilla
    : enmascarar((req.originalUrl || req.url || '').split('?')[0]!);
  return path.slice(0, 300);
}

type Decision = { ok: true } | { ok: false; motivo: MotivoDenegacion };

/**
 * La decisión, y la bitácora cuando es NO. Compartida por la guarda de ruta y por `tieneFuncion`:
 * `p.ok && p.funciones.has(codigo)` es la única línea que decide en todo el API.
 *
 * El intento rechazado se registra ANTES de responder pero sin bloquear la respuesta a que la
 * escritura termine bien: quien es rechazado no debe esperar a la bitácora.
 */
async function decidir(req: Request, codigo: string): Promise<Decision> {
  const p = await resolverPermisos(req.user!.sub);
  if (p.ok && p.funciones.has(codigo)) return { ok: true };

  const motivo: MotivoDenegacion = p.ok ? motivoDenegacionFuncion(p.funciones, codigo) : 'no_resuelto';
  // El `.catch` es cinturón sobre tirantes: el escritor ya se traga sus errores, pero si algún día
  // dejara de hacerlo, una promesa rechazada y sin dueño es un `unhandledRejection` que en Node ≥ 15
  // tumba el proceso entero. Un 403 no puede poder tumbar la API.
  void registrarIntentoDenegado({
    userId: req.user!.sub, rol: req.user!.role, codigo, motivo, metodo: req.method, ruta: rutaDe(req),
  }).catch(() => undefined);
  return { ok: false, motivo };
}

/**
 * Guarda HTTP de una función. Se monta DESPUÉS de `authMiddleware`.
 *
 * La evaluación ocurre entera en el servidor y a partir de la identidad del JWT verificado (`sub`)
 * contra la base: un cliente que llame al endpoint saltándose la interfaz, o que manipule cualquier
 * claim del token, recibe el mismo 403, porque aquí no se lee nada que el navegador pueda decidir.
 */
export function exigirFuncion(codigo: string): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: 'Token requerido' });
      return;
    }
    const d = await decidir(req, codigo);
    if (d.ok) { next(); return; }
    res.status(403).json({ error: textoDe(d.motivo, codigo), funcion: codigo, motivo: d.motivo });
  };
}

/**
 * La misma decisión que `exigirFuncion`, para usarla DENTRO de un handler cuando el permiso solo se
 * pide en una rama (un flag del cuerpo, «otro usuario y no yo»). Registra el intento denegado igual
 * que la guarda; el 403 y su cuerpo los pone el handler, que es quien sabe qué estaba decidiendo.
 * Sin `req.user` es NO: aquí nadie está autenticado todavía.
 */
export async function tieneFuncion(req: Request, codigo: string): Promise<boolean> {
  if (!req.user) return false;
  return (await decidir(req, codigo)).ok;
}
