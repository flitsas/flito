// FLITO — Comparendos: filtros del visor y descarga en Excel (HU #11561, AC1..AC7).
//
// Lo que este archivo protege por encima de todo es una **igualdad**: lo que se descarga tiene que
// ser lo que se está viendo. El fallo que persigue no es «el export no manda los filtros» —eso se
// nota— sino sus dos versiones silenciosas:
//
//   · **El export manda MENOS filtros de los puestos.** El endpoint no se queja: responde 200 con un
//     archivo más ancho, con NITs, placas y observaciones de comparendos que el operador no pidió, y
//     ese archivo se usa para gestionar cobro. Es el desenlace mudo de la placa imposible de la
//     #11560 y por eso la afirmación central de aquí es de PARIDAD (`paridadConElListado`) y no una
//     lista de filtros: enumerar filtros envejece en cuanto se añada el siguiente.
//   · **El filtro cambia de significado solo.** Un `<select>` cuyo `value` no existe entre sus
//     opciones cae al primero, y la tabla sigue enseñando lo que sí se pidió. Ocurre en cuanto una
//     causal o un municipio se dan de baja.
//
// Y una tercera clase de fallo, que es de reparto: los filtros de identidad **no pueden viajar en la
// URL** (AGENTS.md §14) y los demás **tienen que hacerlo** —`exportQuerySchema` es `.strict()` y
// `registrosBusquedaSchema` solo admite `nit` y `placa`—, así que cada uno tiene exactamente un
// sitio correcto y dos formas de equivocarse con 400.
//
// Los datos son SINTÉTICOS: «900123456» y «ABC123» son de ejemplo. Ni un dato real entra en un spec.
import { readFile } from 'node:fs/promises';
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';

const API_REGISTROS = '**/api/flito/comparendos/registros**';
const API_EXPORT = '**/api/flito/comparendos/registros/export**';
const API_MUNICIPIOS = '**/api/flito/comparendos/municipios';
const API_CAUSALES = '**/api/flito/comparendos/causales';
const API_NITS = '**/api/flito/comparendos/nits';

const CAUSAL_ID = '453cc851-646e-4001-b936-6abe0b7a0570';
const CAUSAL_VIEJA_ID = '7f1a2b3c-4d5e-4f60-8a91-b2c3d4e5f607';

/** `content-type` de un xlsx. Es lo que hace que `request()` devuelva un blob y no intente JSON. */
const CT_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** Firma de un ZIP. Un xlsx lo es; sirve para comprobar que lo descargado es el archivo y no otra cosa. */
const CUERPO_XLSX = 'PKFLITO-E2E';

/**
 * El sello del nombre que devuelve el servidor: **una fecha que el reloj del cliente no puede
 * producir**.
 *
 * Si el mock devolviera «hoy», un nombre inventado en el cliente pasaría el test sin que nadie lo
 * notara — que es exactamente el defecto que el AC3 quiere cerrar.
 *
 * Es una fecha FUTURA y no una pasada, y el matiz lo puso el guardia de forma: el sello se valida
 * como instante real y su año tiene que caer en un rango sensato (2020–2100), así que el
 * `19990102-0304` que llevaba este fixture pasó a ser —con razón— un nombre rechazado. 2099 cumple
 * las dos condiciones a la vez: ningún `new Date()` de esta máquina lo produce y sigue siendo un
 * instante que el guardia acepta.
 */
const NOMBRE_SERVIDOR = 'comparendos_20991231-2359.xlsx';

const FILA = {
  id: '11111111-1111-4111-8111-111111111111',
  numeroComparendo: '11001000123456',
  nitMonitoreado: '900123456',
  placa: 'ABC123',
  codigoInfraccion: 'C29',
  descripcionInfraccion: 'Estacionar en zona prohibida',
  fechaComparendo: '2026-07-12',
  organismo: 'Secretaría de Movilidad de Medellín',
  municipioFuente: 'ITAGUI',
  monto: '604100.00',
  estadoFuente: 'EN COBRO COACTIVO',
  origenMerge: 'ambos',
  vistoEnSimit: true,
  vistoEnMunicipal: true,
  estado: 'activo',
  primeraVistoEn: '2026-07-02T08:12:00Z',
  ultimoVistoEn: '2026-08-14T08:07:00Z',
  inactivadoEn: null,
  ultimoSyncRunId: null,
  causalId: CAUSAL_ID,
  observacion: null,
  gestionActualizadaEn: null,
  gestionActualizadaPor: null,
  creadoEn: '2026-07-02T08:12:00Z',
  actualizadoEn: '2026-08-14T08:07:00Z',
};

const PAGINA = { items: [FILA], nextCursor: null };

const MUNICIPIOS = [
  { id: 'm1', codigoFuente: 'ITAGUI', nombre: 'Itagüí', activo: true, creadoEn: '', actualizadoEn: '' },
  { id: 'm2', codigoFuente: 'ENVIGADO', nombre: 'Envigado', activo: false, creadoEn: '', actualizadoEn: '' },
];

const CAUSALES = [
  { id: CAUSAL_ID, nombre: 'Registrado', activo: true, orden: 1, creadoEn: '', actualizadoEn: '' },
  { id: CAUSAL_VIEJA_ID, nombre: 'Notificado por correo', activo: false, orden: 2, creadoEn: '', actualizadoEn: '' },
];

const NITS = [
  { id: 'n1', nit: '900123456', alias: 'Transportes Andinos SAS', activo: true, creadoEn: '', actualizadoEn: '' },
];

// ─────────────────────────────────── Mocks con traza ────────────────────────────────────────────

interface TrazaListado {
  /** `search` de cada petición del LISTADO (no del export). */
  busquedas: string[];
  respuesta: { status: number; body: unknown };
  porCursor: Record<string, { status: number; body: unknown }>;
}

async function mockListado(page: Page, inicial = { status: 200, body: PAGINA as unknown }) {
  const traza: TrazaListado = { busquedas: [], respuesta: inicial, porCursor: {} };
  await page.route(API_REGISTROS, (route: Route) => {
    const url = new URL(route.request().url());
    traza.busquedas.push(url.search);
    const cursor = url.searchParams.get('cursor');
    const elegida = (cursor && traza.porCursor[cursor]) || traza.respuesta;
    return route.fulfill({
      status: elegida.status,
      contentType: 'application/json',
      body: JSON.stringify(elegida.body),
    });
  });
  return traza;
}

interface RespuestaExport {
  status: number;
  /** Cuando falta, se sirve el xlsx de siempre. */
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

interface TrazaExport {
  /** Una entrada por POST: el `search` de la URL y el cuerpo crudo. */
  peticiones: { search: string; cuerpo: string; metodo: string }[];
  respuesta: RespuestaExport;
}

/**
 * Mock del export. **Se registra DESPUÉS del listado a propósito**: el glob del listado
 * (`…/registros**`) también casa con `…/registros/export`, y Playwright evalúa las rutas en orden
 * inverso al de registro. Registrarlo antes lo dejaría muerto y el test mediría el mock equivocado.
 */
async function mockExport(page: Page, inicial: RespuestaExport = { status: 200 }) {
  const traza: TrazaExport = { peticiones: [], respuesta: inicial };
  await page.route(API_EXPORT, (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    traza.peticiones.push({ search: url.search, cuerpo: req.postData() ?? '', metodo: req.method() });
    const r = traza.respuesta;
    return route.fulfill({
      status: r.status,
      contentType: r.contentType ?? CT_XLSX,
      headers: r.headers ?? { 'content-disposition': `attachment; filename="${NOMBRE_SERVIDOR}"` },
      body: r.body ?? CUERPO_XLSX,
    });
  });
  return traza;
}

interface OpcionesCatalogos {
  municipios?: unknown[] | 'error' | 'retenido';
  causales?: unknown[] | 'error' | 'retenido';
}

/** Sirve los tres catálogos. Devuelve el gatillo que suelta los que se pidieron «retenido». */
async function mockCatalogos(page: Page, opciones: OpcionesCatalogos = {}) {
  let soltar = () => {};
  const retenido = new Promise<void>((r) => { soltar = r; });

  const servir = async (route: Route, valor: unknown[] | 'error' | 'retenido' | undefined, porDefecto: unknown[]) => {
    if (valor === 'error') {
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' });
    }
    if (valor === 'retenido') await retenido;
    const cuerpo = Array.isArray(valor) ? valor : porDefecto;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(cuerpo) });
  };

  await page.route(API_MUNICIPIOS, (r) => servir(r, opciones.municipios, MUNICIPIOS));
  await page.route(API_CAUSALES, (r) => servir(r, opciones.causales, CAUSALES));
  await page.route(API_NITS, (r) => servir(r, undefined, NITS));
  return { soltar };
}

/**
 * Instrumenta `URL.createObjectURL` / `revokeObjectURL` ANTES de que cargue la app.
 *
 * Cuenta cuántos se crean y cuántos se revocan, y —lo que de verdad importa— si alguno se revocó
 * dentro del mismo despacho del clic que lo creó, que es la carrera que el AC3 pide cerrar.
 */
async function instrumentarObjectUrls(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __urls: { creados: string[]; revocados: string[]; revocadosEnElClic: number };
    };
    w.__urls = { creados: [], revocados: [], revocadosEnElClic: 0 };
    const crear = URL.createObjectURL.bind(URL);
    const revocar = URL.revokeObjectURL.bind(URL);
    let dentroDelClic = false;
    URL.createObjectURL = (blob: Blob) => {
      const url = crear(blob);
      w.__urls.creados.push(url);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      w.__urls.revocados.push(url);
      if (dentroDelClic) w.__urls.revocadosEnElClic += 1;
      revocar(url);
    };
    const clicOriginal = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function marcado(this: HTMLAnchorElement) {
      dentroDelClic = true;
      try { clicOriginal.call(this); } finally { dentroDelClic = false; }
    };
  });
}

const leerUrls = (page: Page) => page.evaluate(
  () => (window as unknown as { __urls: { creados: string[]; revocados: string[]; revocadosEnElClic: number } }).__urls,
);

// ───────────────────────────────────── Localizadores ────────────────────────────────────────────

const boton = (page: Page, nombre: string) => page.getByRole('button', { name: nombre, exact: true });
const selMunicipio = (page: Page) => page.getByLabel('Municipio', { exact: true });
const selFuente = (page: Page) => page.getByLabel('Fuente', { exact: true });
const selCausal = (page: Page) => page.getByLabel('Causal de gestión', { exact: true });
const botonExportar = (page: Page) => boton(page, 'Exportar a Excel');

/** Pares clave=valor de una query, ordenados: compara CONTENIDO, no el orden en que se serializó. */
function pares(search: string): string[] {
  return [...new URLSearchParams(search).entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort();
}

/**
 * **La afirmación central de esta HU.**
 *
 * El export tiene que llevar en la query exactamente lo mismo que la última consulta del listado,
 * menos `cursor` y `limit` —que `exportQuerySchema` OMITE y, por ser `.strict()`, convierte en 400—.
 * Escrita como igualdad y no como lista de filtros, sigue cazando la omisión cuando el Feature 17c
 * añada el octavo criterio.
 */
function paridadConElListado(searchExport: string, searchListado: string) {
  const esperado = pares(searchListado).filter((p) => !p.startsWith('cursor=') && !p.startsWith('limit='));
  expect(pares(searchExport), 'la query del export no es la del listado').toEqual(esperado);
  expect(searchExport, 'el cursor no puede viajar al export').not.toContain('cursor');
  expect(searchExport, 'el export no pagina: `limit` es un 400').not.toContain('limit');
}

/** Ni el NIT ni la placa pueden estar en la URL, en ninguna de sus formas (AGENTS.md §14). */
function sinIdentidadEnLaUrl(search: string) {
  for (const forma of ['900123456', '900.123.456', 'ABC123', 'ABC%20123', 'nit=', 'placa=']) {
    expect(search, `«${forma}» en la query`).not.toContain(forma);
  }
}

async function abrirVisor(page: Page) {
  await page.goto('/flito/comparendos');
  await expect(page.getByText('11001000123456')).toBeVisible();
}

// ═════════════════════════════════ AC1 · AC2 — los filtros ══════════════════════════════════════

test.describe('FLITO — Comparendos · filtros del visor (HU #11561, AC1 y AC2)', () => {
  test.use({ viewport: { width: 1600, height: 900 } });

  test('AC1 — los cuatro filtros viajan en la QUERY, y el municipio con su codigoFuente', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    const listado = await mockListado(page);
    await abrirVisor(page);

    // El valor del `<option>` ES el `codigoFuente`, no el `id` del catálogo. Mandar el UUID no
    // devuelve error: devuelve 200 con cero filas, y la pantalla diría «no hay nada» teniendo
    // comparendos de ese municipio delante.
    await selMunicipio(page).selectOption({ label: 'Itagüí' });
    await expect.poll(() => listado.busquedas.at(-1)).toContain('municipio=ITAGUI');
    expect(listado.busquedas.at(-1), 'se mandó el id del catálogo en vez del codigoFuente')
      .not.toContain('m1');

    await selFuente(page).selectOption({ label: 'Solo SIMIT' });
    await expect.poll(() => listado.busquedas.at(-1)).toContain('fuente=simit');

    await selCausal(page).selectOption({ label: 'Registrado' });
    await expect.poll(() => listado.busquedas.at(-1)).toContain(`causalId=${CAUSAL_ID}`);

    // Los tres juntos y ninguno perdido por el camino.
    expect(pares(listado.busquedas.at(-1) ?? '')).toEqual(
      [`causalId=${CAUSAL_ID}`, 'fuente=simit', 'municipio=ITAGUI'].sort(),
    );
    sinIdentidadEnLaUrl(listado.busquedas.at(-1) ?? '');
  });

  test('AC1 — «sin causal» y «con esta causal» son el MISMO selector: no se pueden pedir a la vez', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    const listado = await mockListado(page);
    await abrirVisor(page);

    await selCausal(page).selectOption({ label: 'Sin causal asignada' });
    await expect.poll(() => listado.busquedas.at(-1)).toBe('?sinCausal=true');

    // Elegir una causal apaga `sinCausal` en la MISMA aplicación de criterios: mandarlos juntos es
    // un 400 del servidor, y aquí no hay ningún camino que pueda producirlo.
    await selCausal(page).selectOption({ label: 'Registrado' });
    await expect.poll(() => listado.busquedas.at(-1)).toBe(`?causalId=${CAUSAL_ID}`);
    expect(listado.busquedas.at(-1)).not.toContain('sinCausal');
  });

  test('AC2/RN-36 — lo inactivo se OFRECE, marcado: dar de baja una fuente no esconde su deuda', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    const listado = await mockListado(page);
    await abrirVisor(page);

    // El AC2 dice «solo activos»; la RN-36 dice que un municipio o una causal dados de baja siguen
    // teniendo comparendos que hay que poder filtrar. Gana la RN-36 y la opción se marca.
    await expect(selMunicipio(page).getByRole('option', { name: 'Envigado (inactivo)' })).toHaveCount(1);
    await expect(selCausal(page).getByRole('option', { name: 'Notificado por correo (inactiva)' })).toHaveCount(1);

    await selMunicipio(page).selectOption({ label: 'Envigado (inactivo)' });
    await expect.poll(() => listado.busquedas.at(-1)).toBe('?municipio=ENVIGADO');
  });

  /**
   * El reintento del AC2, y el único camino por el que el catálogo cambia sin recargar la página.
   *
   * Es además el que hace ALCANZABLE la opción de respaldo de `conElValorAplicado`: el catálogo se
   * vuelve a pedir con la pantalla montada, y entre una respuesta y la siguiente puede desaparecer
   * lo que el filtro tiene puesto. (La otra mitad de esa función —la entrada dada de baja— la cubre
   * el test de la RN-36 de aquí arriba, y esa sí se ve en cada carga.)
   */
  test('AC2 — el reintento recupera el catálogo, y el valor aplicado no se pierde por el camino', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    // El catálogo empieza caído y se arregla al reintentar. Es la secuencia real de un despliegue
    // del API a mitad de jornada.
    let municipios: unknown[] | 'error' = 'error';
    await page.route(API_MUNICIPIOS, (r) => (municipios === 'error'
      ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' })
      : r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(municipios) })));
    await page.route(API_CAUSALES, (r) => r.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(CAUSALES),
    }));
    await page.route(API_NITS, (r) => r.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(NITS),
    }));
    const listado = await mockListado(page);
    await abrirVisor(page);

    await expect(selMunicipio(page)).toBeDisabled();
    const consultas = listado.busquedas.length;

    municipios = MUNICIPIOS;
    await boton(page, 'Volver a cargar los municipios').click();

    await expect(selMunicipio(page)).toBeEnabled();
    await expect(page.getByText(/No se pudo cargar el catálogo de municipios/)).toHaveCount(0);
    // Recargar el catálogo NO es cambiar el filtro: ni una consulta nueva salió por el camino.
    expect(listado.busquedas.length, 'el catálogo lanzó una consulta por su cuenta').toBe(consultas);

    await selMunicipio(page).selectOption({ label: 'Itagüí' });
    await expect.poll(() => listado.busquedas.at(-1)).toBe('?municipio=ITAGUI');
    await expect(selMunicipio(page)).toHaveValue('ITAGUI');
  });

  test('AC2 — un catálogo caído deshabilita SU selector, con SU mensaje, y el otro sigue usable', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page, { municipios: 'error' });
    const listado = await mockListado(page);
    await abrirVisor(page);

    await expect(selMunicipio(page)).toBeDisabled();
    await expect(page.getByText(/No se pudo cargar el catálogo de municipios/)).toBeVisible();
    // Un indicador compartido habría matado también este, que cargó perfectamente.
    await expect(selCausal(page)).toBeEnabled();
    await expect(page.getByText(/No se pudo cargar el catálogo de causales/)).toHaveCount(0);
    // Y la tabla no se entera: los catálogos son etiquetas, no datos.
    await expect(page.getByRole('table')).toBeVisible();

    await selCausal(page).selectOption({ label: 'Registrado' });
    await expect.poll(() => listado.busquedas.at(-1)).toBe(`?causalId=${CAUSAL_ID}`);
  });

  test('AC2 — un catálogo LENTO no deja muerto al otro (no es un `Promise.all`)', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    // Un 500 resuelve al instante y por eso no detecta esto: hace falta latencia de verdad.
    const { soltar } = await mockCatalogos(page, { municipios: 'retenido' });
    await mockListado(page);
    await abrirVisor(page);

    await expect(selMunicipio(page)).toBeDisabled();
    await expect(page.getByText('Cargando municipios…')).toBeVisible();
    // El de causales ya contestó y tiene que ser usable AHORA, sin esperar al municipio.
    await expect(selCausal(page)).toBeEnabled();
    await expect(selCausal(page).getByRole('option', { name: 'Registrado' })).toHaveCount(1);

    soltar();
    await expect(selMunicipio(page)).toBeEnabled();
  });

  test('AC1 — «Limpiar» se habilita con SOLO un filtro nuevo puesto, y limpia de verdad', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    const listado = await mockListado(page);
    await abrirVisor(page);

    // Hasta esta HU, `hayFiltros` solo miraba estado/número/NIT/placa: con un municipio puesto y
    // nada más, «Limpiar» quedaba inhabilitado y no había forma de volver a «ver todos».
    await expect(boton(page, 'Limpiar')).toBeDisabled();
    await selMunicipio(page).selectOption({ label: 'Itagüí' });
    await expect(boton(page, 'Limpiar')).toBeEnabled();

    const consultas = listado.busquedas.length;
    await boton(page, 'Limpiar').click();
    await expect.poll(() => listado.busquedas.length).toBeGreaterThan(consultas);
    expect(listado.busquedas.at(-1)).toBe('');
    await expect(selMunicipio(page)).toHaveValue('');
    await expect(boton(page, 'Limpiar')).toBeDisabled();
  });

  /**
   * Quitar un filtro es quitar ESE filtro, y hasta ahora nada lo protegía.
   *
   * El hueco lo destapó el gate de QA: cableando el selector de municipio a `limpiar()` —un mutante
   * destructivo y perfectamente observable— los 103 tests del módulo seguían en verde. Ninguno
   * comprobaba qué queda puesto DESPUÉS de retirar uno; todos miraban el filtro que se acababa de
   * poner.
   *
   * Y es el modo de fallo que esta HU existe para cerrar, con su nombre y todo: quien acota por
   * municipio, causal y estado, quita el municipio y exporta, se llevaría un archivo con TODOS los
   * estados y TODAS las causales creyendo que solo ensanchó una dimensión. Nada falla, nada avisa;
   * solo hay más NITs, más placas y más observaciones dentro. Por eso el test no acaba en la
   * consulta: sigue hasta el export, que es donde el error se materializa en un archivo.
   */
  test('AC1 — quitar UN filtro conserva los demás, y el export sigue siendo el de la tabla', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    const listado = await mockListado(page);
    const exportado = await mockExport(page);
    await abrirVisor(page);

    await boton(page, 'Activos').click();
    await selMunicipio(page).selectOption({ label: 'Itagüí' });
    await selCausal(page).selectOption({ label: 'Registrado' });
    await expect.poll(() => pares(listado.busquedas.at(-1) ?? '')).toEqual(
      [`causalId=${CAUSAL_ID}`, 'estado=activo', 'municipio=ITAGUI'].sort(),
    );
    const consultas = listado.busquedas.length;

    // Se retira SOLO el municipio, por el camino por el que lo retira un operador: volviendo el
    // selector a «Todos los municipios».
    await selMunicipio(page).selectOption({ label: 'Todos los municipios' });

    await expect.poll(() => listado.busquedas.length).toBeGreaterThan(consultas);
    expect(pares(listado.busquedas.at(-1) ?? ''), 'quitar el municipio se llevó por delante el resto')
      .toEqual([`causalId=${CAUSAL_ID}`, 'estado=activo'].sort());
    // Y la pantalla lo cuenta igual que la consulta: los otros dos controles siguen puestos.
    await expect(selCausal(page)).toHaveValue(CAUSAL_ID);
    await expect(selMunicipio(page)).toHaveValue('');
    await expect(boton(page, 'Activos')).toHaveAttribute('aria-pressed', 'true');

    await Promise.all([page.waitForEvent('download'), botonExportar(page).click()]);
    paridadConElListado(exportado.peticiones[0].search, listado.busquedas.at(-1) ?? '');
  });

  test('AC1 — el vacío nombra los filtros NUEVOS, no solo los viejos', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    const listado = await mockListado(page, { status: 200, body: { items: [], nextCursor: null } });
    await page.goto('/flito/comparendos');
    await expect(page.getByText(/Todavía no hay comparendos registrados/)).toBeVisible();

    await selMunicipio(page).selectOption({ label: 'Itagüí' });
    await selCausal(page).selectOption({ label: 'Sin causal asignada' });

    // «No hay comparendos» y «no hay comparendos DE ESTO» son conclusiones distintas, y solo la
    // segunda es accionable. Con el resumen sin actualizar, este vacío mentía por omisión.
    await expect(page.getByText(/Filtros puestos:.*municipio «Itagüí»/)).toBeVisible();
    await expect(page.getByText(/Filtros puestos:.*causal «sin asignar»/)).toBeVisible();
    expect(listado.busquedas.at(-1)).toBe('?municipio=ITAGUI&sinCausal=true');
  });

  test('AC7 — cada selector tiene etiqueta asociada y se alcanza con el teclado', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    await mockListado(page);
    await abrirVisor(page);

    // `getByLabel` falla si la etiqueta no está asociada de verdad; los tres localizadores de arriba
    // ya lo prueban. Aquí se comprueba el recorrido y que la barra vieja no cambió de orden.
    await selMunicipio(page).focus();
    await expect(selMunicipio(page)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(selFuente(page)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(selCausal(page)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('N.º de comparendo')).toBeFocused();
  });
});

// ══════════════════════════ AC3 · AC4 · AC5 · AC6 — la descarga ═════════════════════════════════

test.describe('FLITO — Comparendos · export a Excel (HU #11561, AC3..AC6)', () => {
  test.use({ viewport: { width: 1600, height: 900 } });

  test('AC3 — cada filtro en su sitio: los no identitarios en la query, NIT y placa en el CUERPO', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    const listado = await mockListado(page);
    const exportado = await mockExport(page);
    await abrirVisor(page);

    await boton(page, 'Activos').click();
    await selMunicipio(page).selectOption({ label: 'Itagüí' });
    await page.getByLabel('N.º de comparendo').fill('110010');
    await page.getByLabel('NIT monitoreado').fill('900.123.456');
    await page.getByLabel('Placa').fill('ABC123');
    await boton(page, 'Buscar').click();
    await expect.poll(() => listado.busquedas.at(-1)).toContain('q=110010');

    const [descarga] = await Promise.all([
      page.waitForEvent('download'),
      botonExportar(page).click(),
    ]);

    expect(exportado.peticiones).toHaveLength(1);
    const peticion = exportado.peticiones[0];
    expect(peticion.metodo, 'no hay variante GET de este endpoint').toBe('POST');

    // 1 · La identidad NO está en la URL. **Va primero, y el orden es el test.**
    //
    //     Debajo hay una enumeración posicional de la query, y esa afirmación es más fuerte: si el
    //     NIT se colara en la URL, el `toEqual` reventaría por «sobra un par» antes de que este
    //     guardia llegara a mirar. El §14 quedaría cubierto por accidente, por un aserto que habla
    //     de otra cosa, y el día que alguien relaje la enumeración —añadir un filtro es relajarla—
    //     la fuga pasaría sin que nada la nombre. Poniéndolo delante, lo que mata al mutante de
    //     `?nit=` es la regla que dice «ni el NIT ni la placa tocan la URL».
    sinIdentidadEnLaUrl(peticion.search);

    // 2 · Y lo que no identifica a nadie va TODO en la query: si faltara, el servidor respondería
    //     200 con un archivo más ancho del que se pidió, sin decir nada.
    paridadConElListado(peticion.search, listado.busquedas.at(-1) ?? '');
    expect(pares(peticion.search)).toEqual(
      ['estado=activo', 'municipio=ITAGUI', 'q=110010'].sort(),
    );

    // 3 · La identidad viaja en el cuerpo, normalizada al mandarla y no al escribirla.
    expect(JSON.parse(peticion.cuerpo)).toEqual({ nit: '900123456', placa: 'ABC123' });

    expect(descarga.suggestedFilename()).toBe(NOMBRE_SERVIDOR);
  });

  test('AC3 — los filtros NUEVOS y ninguno de los viejos: el fallo más probable de esta HU', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    const listado = await mockListado(page);
    const exportado = await mockExport(page);
    await abrirVisor(page);

    // El export lo escribió la #11558 contra estado/q/nit/placa. Si la barra crece y su constructor
    // no, el archivo sale filtrado por lo viejo y NO por municipio ni causal: un superconjunto
    // silencioso, con más NITs, más placas y más observaciones de las que el operador pidió.
    await selMunicipio(page).selectOption({ label: 'Itagüí' });
    await selFuente(page).selectOption({ label: 'Ambas fuentes' });
    await selCausal(page).selectOption({ label: 'Registrado' });
    await expect.poll(() => listado.busquedas.at(-1)).toContain('causalId=');

    await Promise.all([page.waitForEvent('download'), botonExportar(page).click()]);

    expect(pares(exportado.peticiones[0].search)).toEqual(
      [`causalId=${CAUSAL_ID}`, 'fuente=ambos', 'municipio=ITAGUI'].sort(),
    );
    paridadConElListado(exportado.peticiones[0].search, listado.busquedas.at(-1) ?? '');
    // Sin filtros de identidad el cuerpo es un objeto vacío, no una ausencia: el servidor lo valida
    // igual (`registrosBusquedaSchema.safeParse(req.body ?? {})`).
    expect(JSON.parse(exportado.peticiones[0].cuerpo)).toEqual({});
  });

  test('AC3 — el «sin causal» también viaja: un booleano perdido es un archivo más ancho', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    const listado = await mockListado(page);
    const exportado = await mockExport(page);
    await abrirVisor(page);

    await selCausal(page).selectOption({ label: 'Sin causal asignada' });
    await expect.poll(() => listado.busquedas.at(-1)).toBe('?sinCausal=true');

    await Promise.all([page.waitForEvent('download'), botonExportar(page).click()]);
    expect(pares(exportado.peticiones[0].search)).toEqual(['sinCausal=true']);
  });

  test('AC3 — el CURSOR no viaja al export: un export no pagina', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    const listado = await mockListado(page, { status: 200, body: { items: [FILA], nextCursor: 'CURSOR-1' } });
    listado.porCursor['CURSOR-1'] = { status: 200, body: { items: [FILA], nextCursor: null } };
    const exportado = await mockExport(page);
    await abrirVisor(page);

    await selMunicipio(page).selectOption({ label: 'Itagüí' });
    await boton(page, 'Siguiente →').click();
    await expect.poll(() => listado.busquedas.at(-1)).toContain('cursor=CURSOR-1');

    await Promise.all([page.waitForEvent('download'), botonExportar(page).click()]);

    // `exportQuerySchema` OMITE `cursor` y es `.strict()`: reutilizar el armado de query del visor
    // tal cual —con el cursor de la página en la que está el usuario— sería un 400.
    expect(exportado.peticiones[0].search).toBe('?municipio=ITAGUI');
    paridadConElListado(exportado.peticiones[0].search, listado.busquedas.at(-1) ?? '');
  });

  /**
   * El parser de `Content-Disposition` y el guardia de FORMA, que `apps/web` no puede probar de
   * otra manera: no hay runner unitario, así que o se cubren aquí o no los prueba nadie.
   *
   * `prohibido` es la mitad que importa de los dos últimos casos: no basta con que la descarga se
   * llame de otra forma —hay que comprobar que la cadena rechazada **no quedó en ninguna parte**,
   * ni en el disco ni en el «Archivo descargado: …» que la pantalla pinta.
   */
  const NOMBRES: {
    caso: string;
    cabecera: Record<string, string>;
    esperado: string;
    prohibido?: string;
  }[] = [
    {
      caso: 'filename normal, con un sello que el reloj del cliente no puede producir',
      cabecera: { 'content-disposition': `attachment; filename="${NOMBRE_SERVIDOR}"` },
      esperado: NOMBRE_SERVIDOR,
    },
    {
      // El `filename` de compatibilidad lleva OTRO sello, así que el aserto distingue de verdad cuál
      // de los dos ganó; y el guion del `filename*` va percent-encoded para recorrer el `decodeURIComponent`.
      caso: 'gana `filename*` sobre el `filename` de compatibilidad, y se decodifica',
      cabecera: {
        'content-disposition':
          'attachment; filename="comparendos_00000000-0000.xlsx"; '
          + "filename*=UTF-8''comparendos_20991231%2D2359.xlsx",
      },
      esperado: NOMBRE_SERVIDOR,
    },
    {
      caso: 'sin cabecera: el respaldo del cliente, sin fecha inventada',
      cabecera: {},
      esperado: 'comparendos.xlsx',
    },
    {
      caso: 'con separadores de ruta: se queda el último segmento y nada más',
      cabecera: { 'content-disposition': `attachment; filename="../../etc/${NOMBRE_SERVIDOR}"` },
      esperado: NOMBRE_SERVIDOR,
    },
    {
      // Con `\r\n` sería más fiel al ataque clásico, pero Chromium rechaza esa cabecera antes de
      // que llegue a la página y `route.fulfill` se queda colgado: el test mediría al navegador, no
      // al saneado. `\u0001` y `\u007F` recorren la MISMA rama del filtro y sí llegan.
      caso: 'con caracteres de control: no se escriben en la carpeta de descargas',
      cabecera: { 'content-disposition': 'attachment; filename="comparendos_2099\u00011231-2359\u007F.xlsx"' },
      esperado: NOMBRE_SERVIDOR,
    },
    {
      // **El nombre del archivo es la última superficie por la que podría salir PII.** El servidor
      // promete no meter el filtro en el nombre (`nombreArchivoExport()`), pero una promesa del
      // emisor no es una comprobación del receptor: sin el guardia de forma, este NIT acabaría en el
      // disco del usuario —de donde el archivo se reenvía— y pintado en «Archivo descargado: …».
      // Y es el caso que obligó a apretar el patrón: con «dígitos y guiones» —que es lo que parece
      // suficiente— este nombre PASABA, porque un NIT es exactamente dígitos.
      caso: 'un NIT dentro del nombre NO se usa: cae al respaldo',
      // El NIT del nombre hostil es OTRO que el de la tabla a propósito: con el mismo, el aserto
      // «no está en el documento» sería imposible de cumplir —el NIT monitoreado se pinta en su
      // columna, y debe— y habría que rebajarlo a mirar solo la banda del export. Con uno que no
      // sale por ningún otro camino, el barrido puede ser del documento ENTERO, que es la forma en
      // la que este módulo comprueba las fugas desde la #11560.
      cabecera: { 'content-disposition': 'attachment; filename="comparendos_830009988.xlsx"' },
      esperado: 'comparendos.xlsx',
      prohibido: '830009988',
    },
    {
      // La segunda sonda del guardia, y la que obligó a validar el sello por COMPONENTES: estos
      // ocho dígitos encajan en `\d{8}` y son una cédula colombiana. Con el patrón que solo contaba
      // dígitos, este nombre atravesaba el guardia, quedaba en el disco y se pintaba en el DOM.
      // Mes 56 y día 78 no existen, así que ahora muere solo.
      caso: 'doce dígitos que NO son un instante (una cédula) caen al respaldo',
      cabecera: { 'content-disposition': 'attachment; filename="comparendos_19345678-0304.xlsx"' },
      esperado: 'comparendos.xlsx',
      prohibido: '19345678',
    },
    {
      caso: 'una extensión que no es la del contrato tampoco se usa',
      cabecera: { 'content-disposition': 'attachment; filename="comparendos_20991231-2359.exe"' },
      esperado: 'comparendos.xlsx',
      prohibido: '.exe',
    },
  ];

  for (const { caso, cabecera, esperado, prohibido } of NOMBRES) {
    test(`AC3 — el nombre lo pone el servidor: ${caso}`, async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      await mockCatalogos(page);
      await mockListado(page);
      await mockExport(page, { status: 200, headers: cabecera });
      await abrirVisor(page);

      const [descarga] = await Promise.all([
        page.waitForEvent('download'),
        botonExportar(page).click(),
      ]);
      expect(descarga.suggestedFilename()).toBe(esperado);
      // Y el nombre que la pantalla anuncia es EL MISMO con el que se guardó: si se anunciara otro,
      // el usuario buscaría en su carpeta un archivo que no existe.
      // DOS veces, y las dos cuentan: la banda visible y la región viva que lo anuncia a quien
      // navega con lector. Sin la segunda, el final de la descarga no se oye.
      await expect(page.getByText(`Archivo descargado: ${esperado}`)).toHaveCount(2);

      if (prohibido) {
        // Ni en el nombre del archivo que quedó en el disco ni en ninguna parte del documento: un
        // nombre rechazado que aun así se pinte en pantalla no está rechazado.
        expect(descarga.suggestedFilename()).not.toContain(prohibido);
        expect(await page.content(), `«${prohibido}» sobrevivió en el DOM`).not.toContain(prohibido);
      }
    });
  }

  test('AC3 — el object URL se libera DESPUÉS de la descarga, y el archivo llega entero', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await instrumentarObjectUrls(page);
    await mockCatalogos(page);
    await mockListado(page);
    await mockExport(page);
    await abrirVisor(page);

    for (let i = 0; i < 3; i += 1) {
      const [descarga] = await Promise.all([
        page.waitForEvent('download'),
        botonExportar(page).click(),
      ]);
      // Que el contenido llegue es lo que prueba que liberar no dejó al blob sin origen: un revoke
      // demasiado pronto da un archivo vacío o una descarga fallida, no un error visible.
      const ruta = await descarga.path();
      expect(await readFile(ruta, 'utf8')).toBe(CUERPO_XLSX);
      await expect(page.getByText(`Archivo descargado: ${NOMBRE_SERVIDOR}`)).toHaveCount(2);
    }

    // `expect.poll` y no un assert inmediato: la liberación es deliberadamente de la vuelta
    // siguiente, y exigirla ya empujaría a devolverla al despacho del clic — que es la carrera que
    // este test existe para cerrar.
    await expect.poll(async () => (await leerUrls(page)).revocados.length).toBe(3);
    const urls = await leerUrls(page);
    expect(urls.creados).toHaveLength(3);
    expect(urls.revocados.sort()).toEqual(urls.creados.sort());
    expect(urls.revocadosEnElClic, 'se revocó en el mismo despacho del clic').toBe(0);
  });

  test('AC4 — el segundo clic NO sale a la red, aunque se salte el `disabled`', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    await mockListado(page);
    const exportado = await mockExport(page);
    let soltar = () => {};
    const retenido = new Promise<void>((r) => { soltar = r; });
    // Contador propio, incrementado ANTES de retener. `traza.peticiones` no sirve para este test: su
    // `push` vive en el mock de abajo, al que solo se llega tras `soltar()`, así que mientras la
    // petición está en vuelo —que es justo cuando hay que contar— la traza está vacía.
    let salidas = 0;
    await page.route(API_EXPORT, async (route) => {
      salidas += 1;
      await retenido;
      return route.fallback();
    });
    await abrirVisor(page);

    /**
     * **Los tres clics van en UNA sola evaluación, y ahí está todo el test.**
     *
     * `locator.click()` no sirve —Playwright espera a que el botón esté habilitado—, pero tampoco
     * sirve llamar tres veces a `page.evaluate()`: cada `await` es un viaje de ida y vuelta al
     * navegador, y en ese hueco React ya hizo el commit que escribe `disabled`. El segundo clic ni
     * siquiera se despacha, así que lo que mediría el test es el atributo del botón — justo lo que
     * el AC4 dice que NO basta. El TC quedaba vacuo: verde con el candado y verde sin él.
     *
     * Con los tres en el mismo despacho síncrono, ninguno ve el `disabled` del anterior y lo único
     * que puede detener al segundo y al tercero es la `ref`. Medido en las dos direcciones: con el
     * candado, 1 POST; sin él, 3.
     */
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')]
        .find((x) => x.textContent?.includes('Exportar a Excel') || x.textContent?.includes('Preparando'));
      const boton = b as HTMLButtonElement;
      boton.click();
      boton.click();
      boton.click();
    });

    await expect(botonExportar(page)).toHaveCount(0);
    await expect(boton(page, 'Preparando el archivo…')).toBeVisible();
    await expect(boton(page, 'Preparando el archivo…')).toHaveAttribute('aria-busy', 'true');
    // El estado ocupado se ANUNCIA: el rótulo del botón cambia, y un cambio de nombre accesible no
    // se anuncia solo.
    await expect(page.getByText('Preparando el archivo de comparendos.')).toBeAttached();

    // **La afirmación del AC4, y va AQUÍ: antes de soltar y antes de mirar la descarga.**
    //
    // Los tres clics salieron del mismo despacho síncrono, así que las peticiones que fueran a salir
    // ya salieron cuando el botón se pintó ocupado. Puesta después de la descarga, esta línea es
    // inalcanzable en el caso que importa: sin candado salen tres peticiones, y una tormenta de tres
    // respuestas concurrentes rompe antes el aserto del NOMBRE — el mutante moriría, sí, pero por un
    // aserto que habla de otra cosa, y el día que ese otro cambie el AC4 se queda sin red.
    expect(salidas, 'el candado dejó pasar un segundo POST').toBe(1);

    const [descarga] = await Promise.all([page.waitForEvent('download'), soltar()]);
    expect(exportado.peticiones).toHaveLength(1);
    expect(descarga.suggestedFilename()).toBe(NOMBRE_SERVIDOR);
    // Y al terminar vuelve a reposo: el candado se suelta, no se queda puesto.
    await expect(botonExportar(page)).toBeEnabled();
  });

  test('AC5 — el 422 del tope muestra el mensaje del SERVIDOR y no descarga nada', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    await mockListado(page);
    const mensajeServidor = 'El filtro aplicado supera las 1.500 filas que admite un export. '
      + 'Acota la búsqueda —por municipio, por estado, por NIT o por placa— y vuelve a intentarlo.';
    await mockExport(page, {
      status: 422,
      contentType: 'application/json',
      headers: {},
      body: JSON.stringify({ error: mensajeServidor, codigo: 'export_demasiado_grande' }),
    });
    await abrirVisor(page);

    let descargas = 0;
    page.on('download', () => { descargas += 1; });
    await botonExportar(page).click();

    const alerta = page.getByRole('alert');
    await expect(alerta).toContainText(mensajeServidor);
    // **1.500 y no 5.000**: el tope es configurable por entorno y el cuerpo del 422 es lo único que
    // sabe el de verdad. Una cifra escrita en la pantalla sería falsa en cualquier despliegue que lo
    // mueva, y este mock es justo uno de esos.
    await expect(alerta).toContainText('1.500');
    expect(await page.locator('body').innerText(), 'la pantalla tiene su propia cifra escrita')
      .not.toContain('5.000');
    // Repetir la misma petición daría el mismo 422: lo que hay que cambiar es el filtro.
    await expect(alerta.getByRole('button', { name: /Reintentar/ })).toHaveCount(0);

    await alerta.getByRole('button', { name: 'Cerrar el aviso' }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(botonExportar(page)).toBeEnabled();
    expect(descargas, 'un error acabó en la carpeta de descargas').toBe(0);
  });

  test('AC5 — un 422 VESTIDO de xlsx tampoco se descarga', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    await mockListado(page);
    // `request()` mira el `content-type` ANTES que `res.ok`, así que una respuesta de error con
    // cabecera de xlsx sale por la rama del blob: con `api.downloadPost` acabaría en la carpeta de
    // descargas del usuario, con extensión `.xlsx` y un JSON de error dentro.
    await mockExport(page, {
      status: 422,
      contentType: CT_XLSX,
      headers: { 'content-disposition': 'attachment; filename="trampa.xlsx"' },
      body: JSON.stringify({ error: 'El filtro aplicado supera las 900 filas que admite un export.', codigo: 'export_demasiado_grande' }),
    });
    await abrirVisor(page);

    let descargas = 0;
    page.on('download', () => { descargas += 1; });
    await botonExportar(page).click();

    await expect(page.getByRole('alert')).toContainText('supera las 900 filas');
    expect(descargas, 'se descargó un JSON de error llamado .xlsx').toBe(0);
  });

  test('AC6 — el 429 dice que se espere un minuto, y NO cae en el genérico', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    await mockListado(page);
    const traza = await mockExport(page, {
      status: 429,
      contentType: 'application/json',
      headers: {},
      body: JSON.stringify({ error: 'Demasiados exports seguidos, espere 1 minuto' }),
    });
    await abrirVisor(page);

    await botonExportar(page).click();
    const alerta = page.getByRole('alert');
    await expect(alerta).toContainText('Demasiados exports seguidos, espere 1 minuto');
    // Hay TRES textos candidatos y dos son incorrectos: el genérico de `statusToMessage` y el del
    // limitador del LISTADO, que es otra cuota (60/min) y otra explicación.
    await expect(alerta).not.toContainText('Demasiadas solicitudes, espere un momento');
    await expect(alerta).not.toContainText('Se hicieron demasiadas consultas seguidas');

    // Este sí se puede reintentar: en un minuto la cuota vuelve.
    traza.respuesta = { status: 200 };
    await Promise.all([
      page.waitForEvent('download'),
      alerta.getByRole('button', { name: 'Reintentar la descarga' }).click(),
    ]);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText(`Archivo descargado: ${NOMBRE_SERVIDOR}`)).toHaveCount(2);
    expect(traza.peticiones).toHaveLength(2);
  });

  test('AC5 — un 500 NO hace eco del texto del servidor (regla del módulo desde la #11559)', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    await mockListado(page);
    await mockExport(page, {
      status: 500,
      contentType: 'application/json',
      headers: {},
      body: JSON.stringify({ error: 'Fallo consultando el NIT 900.123.456-7' }),
    });
    await abrirVisor(page);

    await botonExportar(page).click();
    await expect(page.getByRole('alert')).toContainText('No se pudo generar el archivo');
    // El eco del tope y del limitador es una excepción acotada a dos frases FIJAS del servidor. Todo
    // lo demás sigue la regla: un 500 sí puede llevar en su texto lo que se estaba consultando.
    expect(await page.content()).not.toContain('900.123.456');
  });
});
