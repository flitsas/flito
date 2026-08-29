// Negación por defecto para el rol `cliente` (Feature #11912, HU #11913).
//
// ── Por qué existe ───────────────────────────────────────────────────────────────────────────────
//
// Hasta esta HU, «autenticado» y «empleado de la operación» eran lo mismo. Por eso ~115 routers
// montan `router.use(authMiddleware)` y confían el resto a `requireRole`/`requirePage` SOLO donde
// alguien se acordó de ponerlo: un token válido bastaba para `GET /api/vehicles` (nombre y CÉDULA
// del propietario de todas las compañías, hasta 500 por página), `POST /api/runt/consulta-persona`
// (el RUNT de cualquier cédula colombiana), `POST /api/runt/ocr-cedula` (que además quema un modelo
// de pago con imágenes de 5 MB) o `GET /api/fasecolda/buscar`. Nada de eso estaba mal mientras el
// conjunto de titulares de un token fuera la plantilla de FLIT.
//
// `cliente` es el primer principal EXTERNO: entra desde fuera, es de una empresa tercera y ve una
// sola pantalla. La frontera de confianza la mueve este PR, así que el hueco se cierra en este PR.
//
// ── Por qué una allowlist y no parchear router por router ────────────────────────────────────────
//
// Decisión de David en la sesión del 2026-08-29. Parchear los ~115 routers con un `requireRole` que
// excluya a `cliente` es una LISTA NEGRA repartida en 115 sitios: el router número 116 —el que
// escriba dentro de tres meses quien no sepa que este rol existe— nace ABIERTO, y nadie se entera
// hasta que alguien lo mida. Con esto nace CERRADO, sin que nadie tenga que acordarse: para que el
// `cliente` alcance una ruta nueva hay que escribirla aquí, a la vista, con su motivo.
//
// ── Dónde se aplica, y por qué no es un `app.use` en `app.ts` ────────────────────────────────────
//
// El guarda tiene que correr DESPUÉS de la autenticación (necesita `req.user.role`) y ANTES del
// handler. En esta aplicación **la autenticación no está en `app.ts`**: cada router monta
// `authMiddleware` por su cuenta (115 de los 121 ficheros `*.routes.ts`; los 6 restantes son los
// públicos —`files`, el webhook de firma, el portal de participantes y la verificación por QR—, que
// no autentican a nadie y a los que este rol no añade exposición). Un `app.use('/api', …)` colocado
// antes de los routers vería `req.user === undefined` SIEMPRE y no podría decidir nada; para poder
// hacerlo tendría que verificar el JWT por segunda vez en cada petición de toda la API —dos
// `jwtVerify` por request— o, peor, decodificarlo sin verificar y confiar en un campo `role` que en
// ese punto todavía no está firmado por nadie.
//
// Por eso se invoca desde el ÚNICO punto en el que la autenticación termina: el final de
// `authMiddleware` (`shared/middleware/auth.ts`). Eso da exactamente la propiedad que se buscaba —un
// router nuevo nace cerrado— porque un router nuevo que sirva datos monta `authMiddleware`, y si no
// lo monta el problema es otro y mayor. `app.ts` lleva un comentario que apunta aquí para que quien
// lea el montaje encuentre la frontera.
//
// ── Lo que este guarda NO hace ───────────────────────────────────────────────────────────────────
//
// No sustituye a `requireRole` ni a `requirePage`: es una capa de más. Las 9 rutas de MUTACIÓN de
// `flito-soat` ya las niega `requireRole` y siguen negadas ahí; al no estar en esta lista quedan
// negadas dos veces, que es lo que se quiere de una defensa en profundidad.
//
// Tampoco es el sitio donde se decide QUÉ CAMPOS ve el `cliente` de lo que sí puede pedir: eso es la
// proyección por rol de `flito-soat.service.ts` y `soportes-consulta.ts`.

import type { Request, Response, NextFunction } from 'express';

/** El rol del canal Cliente. Literal en un solo sitio para que el grep lo encuentre entero. */
export const ROL_CLIENTE = 'cliente';

export type MetodoHttp = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RutaCliente {
  metodo: MetodoHttp;
  /**
   * Ruta ABSOLUTA con los mismos `:params` que declara el router (`/api/flito/soat/:id/historial`).
   *
   * Absoluta y no un prefijo: `/api/flito/soat` como prefijo abriría de un plumazo `POST
   * /api/flito/soat/enviar`, `/:id/reversar` y las otras siete mutaciones del mismo router, que es
   * justo lo contrario de lo que esta lista hace.
   */
  patron: string;
  /** Qué se rompe si se quita. Sin esto la lista se vuelve incrementable «por si acaso». */
  porque: string;
}

/**
 * Lo ÚNICO que un `cliente` puede pedir a la API. Todo lo demás → 403.
 *
 * **Medida, no adivinada.** Sale de recorrer la sesión completa de un `cliente` en la SPA —login →
 * `/auth/me` → shell → `/flito/soat`— sobre `apps/web/src/lib/auth.tsx`, `pages/FlitoSoat.tsx`,
 * `components/flit/HistorialEstados.tsx` y `components/flit/VisorSoportes.tsx`. Ni una llamada más:
 * el shell (`components/shell/*`, `App.tsx`) no pide nada al API, la ayuda in-app es markdown del
 * bundle y `/flito/parametrizacion/proveedores-soat` está detrás de `if (!esOperaciones) return`.
 *
 * **Creció con la HU #11914 (radicar) y crecerá con la #11915 (subsanar/revisión)**, que son las que
 * le dan al canal sus rutas de escritura. Añadir una entrada aquí es una decisión de exposición: se
 * escribe con su `porque` o no se escribe.
 *
 * Fuera a propósito, aunque el `cliente` las use:
 *   · `POST /api/auth/login` — no pasa por `authMiddleware` (todavía no hay usuario); este guarda no
 *     la ve y no tiene que verla.
 *   · `GET /api/files?...` — la descarga de un soporte. Router público cuyo token HMAC firmado ES la
 *     autenticación; tampoco pasa por `authMiddleware`.
 *   · `POST /api/rum` — Web Vitals, público y pre-login.
 */
export const RUTAS_PERMITIDAS_CLIENTE: readonly RutaCliente[] = [
  {
    metodo: 'GET', patron: '/api/auth/me',
    porque: 'Sin esto no hay sesión: `AuthProvider` la pide al montar y un fallo lo desloguea.',
  },
  {
    metodo: 'POST', patron: '/api/auth/logout',
    porque: 'Cerrar sesión. Negarlo dejaría el token vivo en el navegador y sin revocar en Redis.',
  },
  {
    metodo: 'GET', patron: '/api/flito/soat',
    porque: 'La cola de su compañía: la pantalla entera. Acotada por `contextoSoat()`.',
  },
  {
    metodo: 'GET', patron: '/api/flito/soat/facetas',
    porque: 'Los valores de los filtros de esa cola; sin ellos los desplegables salen vacíos.',
  },
  {
    metodo: 'GET', patron: '/api/flito/soat/:id',
    porque: 'El detalle. La pertenencia la resuelve `buscarConAcceso()` con 404-no-403.',
  },
  {
    metodo: 'GET', patron: '/api/flito/soat/:id/historial',
    porque: 'Los cambios de estado de SU solicitud, sin los nombres de los empleados que la tocaron.',
  },
  {
    metodo: 'GET', patron: '/api/flito/soat/:id/soportes',
    porque: 'El visor de documentos del detalle. Los de origen interno se filtran en la consulta.',
  },
  // ── Las DOS rutas de ESCRITURA del canal (HU #11914). Son las primeras de esta lista que no son
  // una lectura, y por eso llevan encima tres cosas que las de arriba no necesitan: `requireRole
  // ('cliente')` en su propio router, un rate limit propio (`soatClienteLimiter`) y validación del
  // MIME REAL del adjunto. Esta entrada solo dice que el rol puede ALCANZARLAS.
  {
    metodo: 'POST', patron: '/api/flito/soat/cliente/preconsulta',
    porque: 'Paso 1 del alta: sin el RUNT no hay marca, línea, organismo ni bloqueo por SOAT vigente, y el formulario no podría empezar.',
  },
  {
    metodo: 'POST', patron: '/api/flito/soat/cliente',
    porque: 'Radicar la solicitud. Es la razón de ser del canal; sin ella el rol solo mira.',
  },
];

const escapar = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * El patrón, como expresión anclada. `:param` casa un segmento y solo uno (`[^/]+`): un `.*` dejaría
 * que `/api/flito/soat/:id` cubriera `/api/flito/soat/<uuid>/lo-que-sea`.
 *
 * La barra final es opcional porque Express enruta con `strict routing` desactivado y `/api/flito/
 * soat/` llega al mismo handler que `/api/flito/soat`.
 */
function aExpresion(patron: string): RegExp {
  const cuerpo = patron.split('/')
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : escapar(seg)))
    .join('/');
  return new RegExp(`^${cuerpo}/?$`);
}

/** Se compila una vez al cargar el módulo, no en cada petición. */
const COMPILADAS: ReadonlyArray<{ metodo: MetodoHttp; re: RegExp }> = RUTAS_PERMITIDAS_CLIENTE
  .map((r) => ({ metodo: r.metodo, re: aExpresion(r.patron) }));

/**
 * ¿Está este método + esta ruta en la lista? La ruta va SIN query string.
 *
 * Exportada para poder afirmarla en pruebas sin levantar la aplicación, y para que quien añada un
 * endpoint del canal pueda comprobar su patrón de un vistazo.
 */
export function rutaPermitidaParaCliente(metodo: string, ruta: string): boolean {
  return COMPILADAS.some((c) => c.metodo === metodo.toUpperCase() && c.re.test(ruta));
}

/**
 * El guarda. Se invoca desde el final de `authMiddleware`, con `req.user` ya resuelto.
 *
 * Para los 11 roles internos es un `next()` y nada más: ni una consulta, ni una lectura de la
 * lista, ni un cambio de comportamiento. Es el requisito duro de esta corrección y lo primero que
 * hace la función.
 *
 * El 403 es literalmente el mismo cuerpo que devuelve `requireRole` (`{ error: 'Sin permisos' }`):
 * quien sondee no puede distinguir «esta ruta no está en mi lista» de «esta ruta exige otro rol», y
 * por tanto no puede usar la diferencia para mapear la API.
 */
export function guardiaCanalCliente(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== ROL_CLIENTE) { next(); return; }

  // `originalUrl` y no `req.path`: cuando esto corre, la petición está DENTRO del router montado, y
  // ahí `req.path` es el resto relativo (`/` para la cola). Lo que hay que comparar es la ruta
  // absoluta, que es la que la lista escribe. La query se descarta: no forma parte del patrón.
  const ruta = req.originalUrl.split('?')[0];
  if (rutaPermitidaParaCliente(req.method, ruta)) { next(); return; }

  res.status(403).json({ error: 'Sin permisos' });
}
