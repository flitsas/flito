// Fixtures compartidos de la suite E2E de la superficie PII (HU #11276).
//
// «Privacy» son DOS vistas y un solo permiso: `/privacy` (derecho al olvido, Ley 1581 art. 16) y
// `/privacy/log-pii` (auditoría de accesos a datos personales, Ley 1581 art. 17). Las dos cuelgan
// del MISMO slug `privacy` en `App.tsx` (líneas 183 y 223), así que aquí NO hay reparto fino de
// permisos como el de LAFT —donde el auditor entraba a 4 de 7 rutas—: una sola guarda cubre las
// dos, y el negativo del AC3 se escribe sabiéndolo.
//
// Reglas de este archivo:
//   · NO modifica `helpers/auth.ts`, `helpers/fixtures.ts` ni `helpers/object-urls.ts` — se añade
//     al lado, igual que `laft-fixtures.ts` y `pesv-fixtures.ts`. Otra sesión depende de ellos.
//   · TODOS los datos son sintéticos y se leen como tales: documentos 9000000xx, nombres
//     «... SINTÉTICO ...», correos en `example.invalid` (TLD reservado, RFC 6761, no resoluble) e
//     IPs en 203.0.113.0/24 (TEST-NET-3, RFC 5737, no enrutable). Ni un dato personal real entra en
//     un spec — AGENTS.md, Ley 1581.
//   · Las formas de respuesta salen de las páginas y de las rutas del API, no de suposiciones:
//     `/privacy/preview/:doc` devuelve `{docNumber, affected:{...6 tablas}}`,
//     `/privacy/pii-access-log` devuelve `{rows,total,limit,offset}` y `/…/stats`
//     `{desde, porUsuario, porRecurso}`.
//
// ── Por qué aquí se mockea por PREDICADO de pathname y no por glob ─────────────────────────────
//
// `helpers/fixtures.ts` instala un catch-all que responde `200 []` a todo `/api/**`. Con globs, un
// patrón mal escrito NO rompe el test: la vista recibe lista vacía y pinta su estado vacío tan
// feliz. Y en este módulo el riesgo es mayor que en LAFT, porque `**/api/privacy/pii-access-log**`
// casa TAMBIÉN con `/pii-access-log/stats` —una ruta es prefijo de la otra— y el reparto quedaría
// dependiendo del orden de registro. `page.route((url) => url.pathname === '…')` compara el
// pathname EXACTO y elimina las dos ambigüedades de golpe.
//
// El espía de peticiones reales se conserva igual: un predicado equivocado tampoco se nota (cae al
// catch-all), así que la afirmación «la vista consultó ESTA ruta» hay que hacerla sobre la petición
// que salió del navegador, no sobre el mock.
import type { Page } from '@playwright/test';
import { loginAs } from './auth';

/** Pathnames exactos del API de la superficie PII. Fuente: `apps/api/src/app.ts` (292 y 334). */
export const RUTA_LOG = '/api/privacy/pii-access-log';
export const RUTA_STATS = '/api/privacy/pii-access-log/stats';
export const PREFIJO_PRIVACY = '/api/privacy';

/**
 * El usuario positivo de la suite es `compliance` con `allowedPages` VACÍO, no un admin comodín.
 *
 * Con `allowedPages: ['*']` la suite pasaría aunque alguien borrara `privacy` de
 * `ROLE_DEFAULT_PAGES.compliance`: el comodín concede todo. Con la lista vacía, el permiso que se
 * ejerce es el REAL del rol. Mismo criterio que `FINANCIERA_USER` en `helpers/auth.ts` y que
 * `COMPLIANCE_LAFT_USER` en `laft-fixtures.ts`.
 *
 * Además es el usuario que hace visible la ÚNICA diferencia por rol que esta superficie tiene hoy:
 * `Privacy.tsx:37` deriva `isAdmin` de `user.role === 'admin'`, así que `compliance` ve la
 * previsualización completa pero NO el botón que ejecuta la anonimización.
 */
export const COMPLIANCE_PRIVACY_USER = {
  id: 2201,
  username: 'e2e_compliance_privacy',
  name: 'Cumplimiento Privacidad E2E',
  role: 'compliance' as const,
  allowedPages: [] as string[],
};

/** Una vista de la superficie PII: su ruta, su permiso y su huella de montaje. */
export interface VistaPrivacy {
  /** Ruta del SPA. */
  ruta: string;
  /** `page=` de su `ProtectedRoute` en `App.tsx`. Las DOS comparten `privacy`. */
  slug: 'privacy';
  /** Etiqueta del slug en `PAGES` (shared-types): es lo que escribe `NoAccess`. */
  etiqueta: string;
  /** `<h1>` de la vista (`PageHeaderCard`). */
  titulo: string;
  /** Nombre del componente lazy (`App.tsx`). En dev el módulo se pide por su ruta de origen
   *  (`/src/pages/PesvLogPii.tsx`) y en build por su chunk (`PesvLogPii-<hash>.js`). */
  componente: string;
  /**
   * Rutas del API que la vista consulta AL MONTAR.
   *
   * `/privacy` va VACÍA a propósito y no es un olvido: `Privacy.tsx` no pide nada al montar — su
   * única llamada de lectura nace del `submit` del formulario (`Privacy.tsx:46`). Es la razón de
   * que el smoke de esa vista no pueda escribirse con el mismo bucle que el de `/privacy/log-pii`.
   */
  rutasApiAlMontar: string[];
  /** Señal de CUERPO que distingue «montada» de «montada a medias»: no es el `<h1>`. */
  huellaCuerpo: RegExp;
}

export const VISTAS_PRIVACY: VistaPrivacy[] = [
  {
    ruta: '/privacy',
    slug: 'privacy',
    etiqueta: 'Privacidad y datos',
    titulo: 'Privacidad y datos personales',
    componente: 'Privacy',
    rutasApiAlMontar: [],
    huellaCuerpo: /La operación anonimiza, no elimina/,
  },
  {
    ruta: '/privacy/log-pii',
    slug: 'privacy',
    etiqueta: 'Privacidad y datos',
    titulo: 'Auditoría accesos a datos personales',
    componente: 'PesvLogPii',
    rutasApiAlMontar: [RUTA_LOG, RUTA_STATS],
    huellaCuerpo: /Top usuarios \(últimos 30 días\)/,
  },
];

// ── Fixtures del log de accesos ────────────────────────────────────────────────────────────────

/**
 * Los campos que la fila del log SÍ debe pintar: son NOMBRES de campo accedido, nunca valores. Esa
 * es la redacción real de esta pantalla y conviene tenerla nombrada.
 */
export const CAMPOS_ACCEDIDOS = ['nombre', 'documento', 'telefono'];

/**
 * Valores identificables que viajan en la MISMA fila y que la pantalla NO puede pintar.
 *
 * No son decorado: `pii-access.routes.ts:34` hace `db.select().from(piiAccessLog)` —un `SELECT *`
 * sin proyección—, así que el día que la tabla `pii_access_log` gane una columna con el valor
 * accedido, el titular o su correo, esa columna saldrá hacia el navegador sola, sin que nadie toque
 * el frontend. Estas cuatro claves simulan ese día. El aserto que exige su ausencia en el DOM se
 * pondrá rojo justo entonces, que es cuando hace falta.
 */
export const PII_QUE_NO_DEBE_PINTARSE = {
  titularNombre: 'TITULAR SINTÉTICO UNO',
  titularDocumento: '99000088',
  titularEmail: 'titular.uno@example.invalid',
  valorAccedido: '+57 300 000 0088',
};

const FILA_LOG = {
  id: 9601,
  userId: 2201,
  userRole: 'compliance',
  resourceTipo: 'conductor',
  resourceId: 9701,
  accion: 'read',
  camposAccedidos: CAMPOS_ACCEDIDOS,
  motivo: 'Verificación sintética de la suite E2E HU 11276',
  ipOrigen: '203.0.113.7',
  userAgent: 'e2e-fixture/1.0',
  requestId: 'req-e2e-11276-0001',
  accessedAt: '2026-05-14T15:04:05.000Z',
  ...PII_QUE_NO_DEBE_PINTARSE,
};

const FILA_LOG_EXPORT = {
  ...FILA_LOG,
  id: 9602,
  accion: 'export',
  resourceTipo: 'comparendo',
  resourceId: 9702,
  requestId: 'req-e2e-11276-0002',
  accessedAt: '2026-05-15T09:30:00.000Z',
};

export const LOG_CON_FILAS = { rows: [FILA_LOG, FILA_LOG_EXPORT], total: 2, limit: 100, offset: 0 };
export const LOG_VACIO = { rows: [], total: 0, limit: 100, offset: 0 };

/**
 * Huellas del estado CARGADO, una por fila. Salen del fixture, no del microcopy de la plantilla.
 *
 * OJO con el `requestId`: NO sirve como huella porque la tabla no lo pinta (ver
 * `CAMPOS_NO_PINTADOS`). Lo que identifica a cada fila en pantalla es la celda «Recurso», que
 * compone `resourceTipo` + `#resourceId` (`PesvLogPii.tsx:111`).
 */
export const HUELLA_FILA_READ = 'conductor#9701';
export const HUELLA_FILA_EXPORT = 'comparendo#9702';

/**
 * Columnas que el API SÍ envía hoy y que la tabla NO pinta — y esto no es un descuido del fixture,
 * es la otra mitad de la redacción efectiva de esta pantalla.
 *
 * `pii-access.routes.ts:34` hace `SELECT *`, así que `motivo`, `userAgent` y `requestId` llegan al
 * navegador en cada fila. La tabla de `PesvLogPii.tsx:102-116` tiene seis columnas y ninguna es
 * esas tres. `motivo` es el caso que importa: es texto LIBRE que escribe un operador, así que es el
 * campo del log con más probabilidad de acabar conteniendo un nombre o una cédula. El día que
 * alguien añada una columna «Motivo» —una petición razonable para una auditoría— ese texto libre se
 * publicará en pantalla. El aserto que exige su ausencia es lo que obligará a pensarlo.
 */
export const CAMPOS_NO_PINTADOS = {
  motivo: 'Verificación sintética de la suite E2E HU 11276',
  userAgent: 'e2e-fixture/1.0',
  requestId: 'req-e2e-11276-0001',
};
/** Lo que escribe la tabla cuando no hay filas (`PesvLogPii.tsx:106`). */
export const VACIO_LOG = 'Sin accesos para los filtros';
/** Lo que escriben las dos tarjetas de resumen cuando no hay agregados (`PesvLogPii.tsx:64` y 74). */
export const VACIO_STATS = 'Sin accesos';

export const STATS_CON_DATOS = {
  desde: '2026-04-14T00:00:00.000Z',
  porUsuario: [{ user_id: 2201, user_role: 'compliance', accesos: 2 }],
  porRecurso: [{ resource_tipo: 'conductor', accion: 'read', accesos: 1 }],
};
export const STATS_VACIO = { desde: '2026-04-14T00:00:00.000Z', porUsuario: [], porRecurso: [] };

// ── Fixtures del derecho al olvido ─────────────────────────────────────────────────────────────

/**
 * Documento sintético que el spec teclea en el formulario.
 *
 * NO se usa `1036640908`: ese número está escrito como `placeholder` en `Privacy.tsx:88` y tiene
 * forma de cédula colombiana real. Un fixture que lo repitiera (a) haría ambiguo cualquier aserto
 * sobre el DOM —¿es el valor tecleado o el placeholder?— y (b) metería en la suite un identificador
 * con formato de dato personal real, que es justo lo que AGENTS.md y la Ley 1581 prohíben.
 */
export const DOC_SINTETICO = '99000077';

export const PREVIEW_CON_REGISTROS = {
  docNumber: DOC_SINTETICO,
  affected: {
    clients: 3,
    vehicles: 2,
    soat_requests: 1,
    tramites_digitales: 0,
    laft_counterparties: 0,
    laft_beneficial_owners: 0,
  },
};

export const PREVIEW_SIN_REGISTROS = {
  docNumber: DOC_SINTETICO,
  affected: {
    clients: 0,
    vehicles: 0,
    soat_requests: 0,
    tramites_digitales: 0,
    laft_counterparties: 0,
    laft_beneficial_owners: 0,
  },
};

// ── Espías y mocks ─────────────────────────────────────────────────────────────────────────────

export interface PeticionPrivacy {
  /** `${método} ${pathname}` con el documento REDACTADO (ver `redactar`). */
  huella: string;
  /** Solo los parámetros seguros de la query: fechas, paginación y filtros no identificables. */
  params: Record<string, string>;
}

/**
 * El pathname con el documento fuera.
 *
 * `Privacy.tsx:46` mete el número de documento EN LA RUTA (`/privacy/preview/1036640908`). Aunque el
 * de los fixtures es sintético, un espía que acumulara el pathname crudo lo escribiría en el reporte
 * del runner y de ahí a un artefacto de CI (AGENTS.md §14). Se sustituye por `:doc` antes de
 * guardarlo: los asertos ganan además estabilidad, porque afirman sobre la RUTA y no sobre el dato.
 */
export function redactar(pathname: string): string {
  return pathname.replace(/^\/api\/privacy\/preview\/.+$/, '/api/privacy/preview/:doc');
}

/**
 * Acumula toda petición real a `/api/privacy*`. Es el seguro contra el catch-all: si un mock no
 * llegara a interceptar, la vista recibiría `200 []` y pintaría su vacío sin chistar; solo este
 * espía —que mira la petición y no la respuesta— lo ve.
 */
export function espiarApiPrivacy(page: Page): PeticionPrivacy[] {
  const peticiones: PeticionPrivacy[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (!url.pathname.startsWith(PREFIJO_PRIVACY)) return;
    const params: Record<string, string> = {};
    // Lista blanca explícita: NUNCA se vuelca la query entera, que es justo el sitio por el que un
    // documento se colaría a un artefacto de CI. `userId` es un id interno, no un dato personal.
    for (const clave of ['limit', 'offset', 'from', 'to', 'accion', 'resourceTipo', 'userId']) {
      const valor = url.searchParams.get(clave);
      if (valor !== null) params[clave] = valor;
    }
    peticiones.push({ huella: `${req.method()} ${redactar(url.pathname)}`, params });
  });
  return peticiones;
}

/** Las huellas `${método} ${pathname}` de lo que salió, en orden. */
export const huellas = (peticiones: PeticionPrivacy[]): string[] => peticiones.map((p) => p.huella);

/** Espía de módulos/chunks lazy de la superficie PII, por nombre de componente. */
export function espiarChunks(page: Page): string[] {
  const chunks: string[] = [];
  page.on('request', (req) => {
    const { pathname } = new URL(req.url());
    if (/\/pages\/(Privacy|PesvLogPii)\.tsx$|\/(Privacy|PesvLogPii)-[A-Za-z0-9_]+\.js$/.test(pathname)) {
      chunks.push(pathname);
    }
  });
  return chunks;
}

/** El chunk de ESTA vista y no el de su vecina. */
export function chunkDe(chunks: string[], vista: VistaPrivacy): string[] {
  const suyo = new RegExp(`/pages/${vista.componente}\\.tsx$|/${vista.componente}-[A-Za-z0-9_]+\\.js$`);
  return chunks.filter((p) => suyo.test(p));
}

type Respuesta = { status?: number; cuerpo: unknown };
const json = (r: Respuesta) => ({
  status: r.status ?? 200,
  contentType: 'application/json',
  body: JSON.stringify(r.cuerpo),
});

/**
 * Mockea las DOS llamadas de `/privacy/log-pii` por pathname exacto.
 *
 * ██ HAY QUE MOCKEAR LAS DOS, SIEMPRE. ██ Dejar `/stats` al catch-all no da un vacío silencioso: da
 * una caída. El catch-all responde `200 []`, y `[]` es TRUTHY, así que `PesvLogPii.tsx:60` entra en
 * la rama del resumen y evalúa `stats.porUsuario.length` sobre `undefined` → TypeError y árbol
 * desmontado. Comprobado en node: `!![] === true`. Por eso `stats` tiene un valor por defecto con la
 * forma correcta y no se deja nunca sin registrar.
 *
 * `log` acepta una función para los escenarios que cambian de respuesta entre llamadas (el fallo del
 * filtro, la paginación); recibe el número de llamada empezando en 1 y la `URL` de la petición, para
 * poder responder como respondería el backend de verdad ante ese `offset` o ese rango.
 */
export async function mockLogPii(page: Page, opciones: {
  log?: Respuesta | ((ctx: { llamada: number; url: URL }) => Respuesta);
  stats?: Respuesta;
} = {}) {
  const log = opciones.log ?? { cuerpo: LOG_CON_FILAS };
  const stats = opciones.stats ?? { cuerpo: STATS_CON_DATOS };
  let llamada = 0;
  await page.route((url) => url.pathname === RUTA_LOG, async (route) => {
    llamada += 1;
    const url = new URL(route.request().url());
    await route.fulfill(json(typeof log === 'function' ? log({ llamada, url }) : log));
  });
  await page.route((url) => url.pathname === RUTA_STATS, (route) => route.fulfill(json(stats)));
}

/** Mockea `/privacy/preview/:doc` por prefijo de pathname exacto (el documento va en la ruta). */
export async function mockPreview(page: Page, respuesta: Respuesta = { cuerpo: PREVIEW_CON_REGISTROS }) {
  await page.route(
    (url) => url.pathname.startsWith(`${PREFIJO_PRIVACY}/preview/`),
    (route) => route.fulfill(json(respuesta)),
  );
}

const CANARIO = '/api/__qa_canary';

/** Punto de reposo: cuando el canario ha salido, lo que fuera a salir en el montaje ya salió. */
export async function reposo(page: Page): Promise<void> {
  const salida = page.waitForRequest((r) => r.url().includes('__qa_canary'), { timeout: 10_000 });
  await page.evaluate((ruta) => { void fetch(ruta).catch(() => {}); }, CANARIO);
  await salida;
}

// ── Esperas ────────────────────────────────────────────────────────────────────────────────────
//
// `PesvLogPii` NO tiene estado de carga: `rows` arranca en `[]` y la tabla pinta «Sin accesos para
// los filtros» ANTES de que llegue la respuesta. Cualquier aserto de vacío que no espere a la
// respuesta es verde por accidente —está midiendo el instante previo a la carga, no el resultado—.
// Estas dos esperas son obligatorias en todo spec que afirme sobre el cuerpo de esa vista.

/** Se resuelve cuando llega la respuesta del LISTADO. Hay que llamarla ANTES de navegar/filtrar. */
export function esperarLog(page: Page) {
  return page.waitForResponse((r) => new URL(r.url()).pathname === RUTA_LOG);
}

/**
 * Se resuelve cuando llega la respuesta del listado que lleva EXACTAMENTE estos parámetros.
 *
 * Hace falta porque rellenar los dos `input[type=date]` dispara DOS consultas: el `onChange` del
 * primero ya provoca su `useEffect` con `from` puesto y `to` todavía vacío. Un `esperarLog` a secas
 * se resuelve con esa primera —la del filtro a medio aplicar— y el aserto siguiente mide la petición
 * equivocada, con el resultado dependiendo de una carrera. Comprobado: así fallaba.
 */
export function esperarLogCon(page: Page, params: Record<string, string>) {
  return page.waitForResponse((r) => {
    const url = new URL(r.url());
    if (url.pathname !== RUTA_LOG) return false;
    return Object.entries(params).every(([k, v]) => url.searchParams.get(k) === v);
  });
}

/** Se resuelve cuando llega la respuesta del RESUMEN. Hay que llamarla ANTES de navegar. */
export function esperarStats(page: Page) {
  return page.waitForResponse((r) => new URL(r.url()).pathname === RUTA_STATS);
}

// ── `loginAs` con el tipo de usuario ensanchado ────────────────────────────────────────────────
//
// `helpers/auth.ts:79` declara `loginAs(page, user = ADMIN_USER)`. Sin anotación explícita,
// TypeScript infiere el parámetro como la FORMA EXACTA de `ADMIN_USER` —con `role: 'admin'` como
// tipo literal—, así que pasarle `CONDUCTOR_USER`, `AUDITOR_USER` o cualquier otro usuario del
// PROPIO catálogo de ese archivo es un TS2345.
//
// Nadie lo ha visto porque `apps/web/tsconfig.json` tiene `include: ["src", …]`: el gate
// `npm run typecheck -w apps/web` NO mira `e2e/`, y el runner de Playwright transpila sin
// comprobar tipos. Comprobado: los specs de LAFT ya mergeados en `develop` acumulan 7 errores
// TS2345 idénticos, invisibles hoy para toda la tubería.
//
// `auth.ts` no se toca —otra sesión depende de él y arreglarlo allí es cambio compartido—, así que
// el ensanchado vive aquí, en un solo sitio y con el motivo escrito. Es un cast de TIPO, no de
// comportamiento: `loginAs` solo serializa el objeto a `/api/auth/me`.
export interface UsuarioE2E {
  id: number;
  username: string;
  name: string;
  role: string;
  allowedPages: string[];
}

export function entrar(page: Page, usuario: UsuarioE2E) {
  return loginAs(page, usuario as unknown as Parameters<typeof loginAs>[1]);
}
