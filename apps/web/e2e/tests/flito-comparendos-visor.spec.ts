// FLITO — Comparendos: el visor (HU #11560, AC1..AC7).
//
// Lo que este archivo protege por encima de todo es el **AC4**, que es una afirmación sobre una
// ausencia: «ni el NIT ni la placa aparecen en la barra de direcciones ni en el historial». Una
// ausencia se cumple sola en un test roto, así que aquí se prueba por tres caminos que fallan por
// separado: la URL del navegador tras cada interacción, la query de CADA petición que sale al
// módulo, y el verbo con el que se pide (un `GET` con NIT sería la fuga aunque la barra de
// direcciones estuviera limpia, porque la query viaja al access log del proxy y al `Referer`).
//
// Los datos son SINTÉTICOS: «900123456» y «ABC123» son de ejemplo. Ni un dato real entra en un
// spec, ni siquiera en un fixture (Ley 1581).
import type { Page, Request, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';

const API_REGISTROS = '**/api/flito/comparendos/registros**';
const API_MUNICIPIOS = '**/api/flito/comparendos/municipios';
const API_CAUSALES = '**/api/flito/comparendos/causales';
const API_NITS = '**/api/flito/comparendos/nits';

const CAUSAL_ID = '453cc851-646e-4001-b936-6abe0b7a0570';

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
  // Multa, y con su resolución: la fila de referencia es la que prueba que «Tipo» se traduce y que
  // el número de resolución NO sale a la tabla (HU #11713, AC1 y AC3).
  tipoRegistro: 'multa',
  numeroResolucion: 'RES-2026-4471',
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

// El caso real del entorno sembrado: lo que solo vio el SIMIT no tiene municipio, y hay fuentes que
// no traen placa, fecha ni monto. `null` es información, no un dato que falte.
const FILA_SIMIT = {
  ...FILA,
  id: '22222222-2222-4222-8222-222222222222',
  numeroComparendo: '05001000998877',
  placa: null,
  fechaComparendo: null,
  municipioFuente: null,
  monto: null,
  codigoInfraccion: null,
  descripcionInfraccion: null,
  origenMerge: 'simit',
  // `null` = «no se sabe», que es lo que devuelve TODO el histórico anterior a la migración 0160.
  // En una fila `inactivo` es permanente: ningún sync vuelve a visitarla (CF-10).
  tipoRegistro: null,
  numeroResolucion: null,
  estado: 'inactivo',
  inactivadoEn: '2026-06-28T08:11:00Z',
  causalId: null,
};

const PAGINA = { items: [FILA, FILA_SIMIT], nextCursor: null };

interface Traza {
  /** `${método} ${pathname}${search}` de cada petición al listado. */
  peticiones: string[];
  /** Cuerpos de los `POST /registros/buscar`. */
  cuerpos: string[];
  /** Respuesta que se sirve; el test la cambia cuando quiere. */
  respuesta: { status: number; body: unknown };
  /** Respuestas por cursor: si hay entrada para el cursor pedido, gana sobre `respuesta`. */
  porCursor: Record<string, { status: number; body: unknown }>;
}

/** Mock del listado con traza. Sirve las dos rutas —`GET /registros` y `POST /registros/buscar`—
 *  porque el glob las cubre a las dos: es justo lo que hace comprobable el cambio de verbo. */
async function mockListado(page: Page, inicial: { status: number; body: unknown }): Promise<Traza> {
  const traza: Traza = { peticiones: [], cuerpos: [], respuesta: inicial, porCursor: {} };
  await page.route(API_REGISTROS, (route: Route) => {
    const req: Request = route.request();
    const url = new URL(req.url());
    traza.peticiones.push(`${req.method()} ${url.pathname}${url.search}`);
    if (req.method() === 'POST') traza.cuerpos.push(req.postData() ?? '');
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

/** Catálogos de etiqueta. Son opcionales para la tabla y por eso cada test decide si existen. */
async function mockCatalogos(page: Page, activos = true) {
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(API_MUNICIPIOS, (r) => (activos
    ? r.fulfill(json([{ id: 'm1', codigoFuente: 'ITAGUI', nombre: 'Itagüí', activo: true, creadoEn: '', actualizadoEn: '' }]))
    : r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' })));
  await page.route(API_CAUSALES, (r) => r.fulfill(json([
    { id: CAUSAL_ID, nombre: 'Registrado', activo: true, orden: 1, creadoEn: '', actualizadoEn: '' },
  ])));
  await page.route(API_NITS, (r) => r.fulfill(json([
    { id: 'n1', nit: '900123456', alias: 'Transportes Andinos SAS', activo: true, creadoEn: '', actualizadoEn: '' },
  ])));
}

/**
 * Las formas en las que un NIT o una placa pueden aparecer, y **las dos formas importan**.
 *
 * El campo conserva lo que el usuario escribió («900.123.456») y solo se normaliza al mandarlo
 * («900123456»), así que un camino que algún día mandara el valor CRUDO sería una fuga real — y
 * buscar solo el normalizado no la vería, porque `'900.123.456'.includes('900123456')` es `false`.
 * Cada valor entra además con su codificación de URL: en una query, «ABC 123» viaja como
 * `ABC%20123` o como `ABC+123`, y ninguna de las dos contiene el literal con espacio.
 */
const IDENTIDAD = ['900123456', '900.123.456', 'ABC123', 'ABC 123'];
const IDENTIDAD_EN_URL = IDENTIDAD.flatMap((v) => [v, encodeURIComponent(v), v.replace(/ /g, '+')]);

function sinRastro(texto: string, donde: string, formas = IDENTIDAD) {
  for (const forma of formas) {
    expect(texto, `«${forma}» en ${donde}`).not.toContain(forma);
  }
}

/**
 * Ni el NIT ni la placa pueden acabar en ningún sitio que sobreviva a la pestaña (AGENTS.md §14,
 * AC4). Se miran los cinco que existen, no solo la barra de direcciones:
 *
 *   · la URL —que es el `Referer` de la siguiente petición y la línea del access log del proxy—,
 *   · el título del documento, que es lo que el navegador guarda EN el historial y lo que sale en
 *     la lista de pestañas recientes y en la captura del gestor de tareas,
 *   · `history.length`, porque una entrada nueva por búsqueda es historial aunque la URL no cambie
 *     de aspecto,
 *   · `sessionStorage` y `localStorage`, que es donde acabaría un «recordar la última búsqueda»
 *     escrito sin pensarlo.
 */
async function sinRastroDeIdentidad(page: Page, historialEsperado?: number) {
  const url = page.url();
  sinRastro(url, 'la URL', IDENTIDAD_EN_URL);
  expect(url).toMatch(/\/flito\/comparendos$/);

  const estado = await page.evaluate(() => ({
    titulo: document.title,
    entradas: history.length,
    sesion: JSON.stringify(window.sessionStorage),
    local: JSON.stringify(window.localStorage),
  }));
  sinRastro(estado.titulo, 'document.title');
  sinRastro(estado.sesion, 'sessionStorage');
  sinRastro(estado.local, 'localStorage');
  // Los criterios viven en estado de React: buscar no empuja ninguna entrada al historial, así que
  // el botón «atrás» del navegador no puede devolver a una búsqueda por NIT.
  if (historialEsperado !== undefined) expect(estado.entradas).toBe(historialEsperado);
  return estado.entradas;
}

/** `exact` no es cosmético: «Buscar» también es el nombre del botón del Command Palette del shell,
 *  y «Activos» es prefijo de «Inactivos». */
const boton = (page: Page, nombre: string) => page.getByRole('button', { name: nombre, exact: true });

const campoNumero = (page: Page) => page.getByLabel('N.º de comparendo');
const campoNit = (page: Page) => page.getByLabel('NIT monitoreado');
const campoPlaca = (page: Page) => page.getByLabel('Placa');

test.describe('FLITO — Comparendos · visor (HU #11560)', () => {
  test.use({ viewport: { width: 1600, height: 900 } });

  test('AC1 — la tabla trae los datos consolidados, en pesos y en fechas de Colombia', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    await mockListado(page, { status: 200, body: PAGINA });

    await page.goto('/flito/comparendos');

    const tabla = page.getByRole('table');
    await expect(tabla).toBeVisible();
    // «Estado» era «Estado» hasta la HU #11713, y «Organismo» estaba en esta lista: la primera se
    // renombró a «Monitoreo» y la segunda salió de la tabla (el dato sigue entero en el detalle).
    for (const columna of ['N.º comparendo', 'Tipo', 'Placa', 'NIT monitoreado', 'Fecha', 'Infracción',
      'Municipio', 'Monto', 'Monitoreo', 'Gestión', 'Estado en la fuente', 'Origen', 'Registrado']) {
      await expect(tabla.getByRole('columnheader', { name: columna, exact: true })).toBeVisible();
    }

    const fila = page.getByRole('row').filter({ hasText: '11001000123456' });
    await expect(fila).toContainText('ABC123');
    await expect(fila).toContainText('900123456');
    // El alias del catálogo, que es lo que hace reconocible al NIT.
    await expect(fila).toContainText('Transportes Andinos SAS');
    // `es-CO` con mes corto escribe «12 de jul de 2026». Se afirma el día y el mes, que es lo que
    // se rompería con un desfase de zona: `fechaComparendo` es una fecha SIN instante y pasarla por
    // `new Date()` la llevaría al día anterior en Bogotá.
    await expect(fila).toContainText('12 de jul');
    await expect(fila).toContainText('C29 · Estacionar en zona prohibida');
    // El municipio se pinta con el nombre del catálogo, no con el `codigoFuente` que guarda el sync.
    await expect(fila).toContainText('Itagüí');
    await expect(fila).toContainText('Ambos');
    await expect(fila).toContainText('Activo');
    // La causal resuelta a su nombre: es la respuesta a «¿esto ya lo miró alguien?».
    await expect(fila).toContainText('Registrado');
    // Monto en pesos colombianos, sin decimales.
    await expect(fila).toContainText(/604\.100/);
    // `primeraVistoEn` es 2026-07-02T08:12:00Z → 3:12 en Colombia: el mismo día, y se comprueba que
    // la conversión no se lo lleva a otro.
    await expect(fila).toContainText('2 de jul');

    // La fila que solo vio el SIMIT: cinco nulos seguidos y la fila no se rompe.
    const filaSimit = page.getByRole('row').filter({ hasText: '05001000998877' });
    await expect(filaSimit).toContainText('Inactivo');
    await expect(filaSimit).toContainText('Sin gestión');
    await expect(filaSimit).toContainText('SIMIT');
    expect((await filaSimit.innerText()).split('—').length - 1).toBeGreaterThanOrEqual(4);

    // La fecha de NOTIFICACIÓN no se muestra: ninguna fuente la entrega todavía (spike #11501), y
    // dejar la columna «para cuando llegue» sería prometer un dato que no existe.
    await expect(tabla.getByRole('columnheader', { name: /notificaci/i })).toHaveCount(0);
    // `estadoFuente` SÍ, desde la HU #11713, y **tal cual lo manda el proveedor**: sin `capitalize`,
    // sin `uppercase` y sin recortar. Es lo que el operador tendría que citarle al organismo.
    await expect(fila).toContainText('EN COBRO COACTIVO');
    // «Organismo» ya no está en la tabla (HU #11713, AC7): quince columnas eran demasiadas y el dato
    // vive entero en el panel de detalle. Se comprueba por los dos caminos —la cabecera y el valor—
    // porque quitar solo uno de los dos es exactamente el arreglo a medias que deja la columna coja.
    await expect(tabla.getByRole('columnheader', { name: 'Organismo', exact: true })).toHaveCount(0);
    await expect(tabla.getByText('Secretaría de Movilidad de Medellín')).toHaveCount(0);
    // Y **ninguna columna se llama solo «Estado»** (AC2): con «Estado en la fuente» al lado, las dos
    // primeras palabras serían idénticas al oído.
    await expect(tabla.getByRole('columnheader', { name: 'Estado', exact: true })).toHaveCount(0);
    // El número de resolución no se pinta en la tabla (AC3): es el dato del que se DERIVA el tipo,
    // no una columna más.
    await expect(tabla.getByText('RES-2026-4471')).toHaveCount(0);
    // Y no hay fila de totales: `monto` es una cadena decimal y no se suma en el cliente.
    await expect(page.locator('tfoot')).toHaveCount(0);
  });

  test('AC1 — si el catálogo de municipios falla, se pinta el código crudo y la tabla NO se cae', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page, false);
    await mockListado(page, { status: 200, body: PAGINA });

    await page.goto('/flito/comparendos');

    const fila = page.getByRole('row').filter({ hasText: '11001000123456' });
    await expect(fila).toContainText('ITAGUI');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('AC2 — cargando: filas fantasma anunciadas, con la barra de filtros usable', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    let soltar: (() => void) | null = null;
    const retenida = new Promise<void>((resolve) => { soltar = resolve; });
    await page.route(API_REGISTROS, async (route) => {
      await retenida;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PAGINA) });
    });

    await page.goto('/flito/comparendos');

    const cargando = page.getByRole('status', { name: 'Cargando comparendos' });
    await expect(cargando).toBeVisible();
    await expect(cargando).toHaveAttribute('aria-busy', 'true');
    // La barra nunca se inhabilita mientras carga: quien ve que tarda, lo primero que hace es
    // corregir lo que escribió.
    await expect(campoNumero(page)).toBeEnabled();
    await expect(boton(page, 'Buscar')).toBeEnabled();

    soltar?.();
    await expect(page.getByText('11001000123456')).toBeVisible();
    await expect(cargando).toHaveCount(0);
  });

  test('AC2 — vacío B: dice qué filtros había, explica la búsqueda exacta y los quita', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    const traza = await mockListado(page, { status: 200, body: { items: [], nextCursor: null } });

    await page.goto('/flito/comparendos');
    // Sin filtros es el vacío A, que no ofrece ninguna acción.
    await expect(page.getByText(/Todavía no hay comparendos registrados/)).toBeVisible();
    await expect(boton(page, 'Quitar los filtros')).toHaveCount(0);

    await campoPlaca(page).fill('ABC123');
    await boton(page, 'Buscar').click();

    // Dos veces, y las dos cuentan: el texto del vacío y el anuncio de la región `aria-live`, que
    // es cómo se entera de que la tabla cambió quien navega con lector de pantalla.
    await expect(page.getByText(/Ningún comparendo coincide con lo que buscaste/)).toHaveCount(2);
    await expect(page.getByText(/Filtros puestos:.*placa «ABC123»/)).toBeVisible();
    // La explicación de la búsqueda exacta solo tiene sentido con NIT o placa puestos.
    await expect(page.getByText(/se buscan exactos, aunque no al pie de la letra/)).toBeVisible();
    // Y la explica SIN ejemplos inventados: lo único con forma de placa en esta pantalla es la que
    // el usuario acaba de escribir, que el resumen de filtros repite a propósito. Ese es el aserto
    // que sostiene la política del módulo —sin él, el primer copy con «ABC123» vuelve—.
    const explicacion = await page.getByText(/se buscan exactos, aunque no al pie de la letra/).innerText();
    sinRastro(explicacion, 'la explicación de la búsqueda exacta');
    await expect(page.getByText(/Filtros puestos:.*placa «ABC123»/)).toBeVisible();
    await sinRastroDeIdentidad(page);

    await boton(page, 'Quitar los filtros').click();
    await expect(page.getByText(/Todavía no hay comparendos registrados/)).toBeVisible();
    // La última consulta vuelve a ser el `GET` sin filtros, no el `POST` con la placa.
    expect(traza.peticiones[traza.peticiones.length - 1]).toBe('GET /api/flito/comparendos/registros');
  });

  /**
   * Bug #11648 — el mismo botón del test de arriba, pero llegando al vacío por el ÚNICO camino que
   * lo rompía.
   *
   * El hermano filtra por **placa**, que se aplica con `[Buscar]` y no tiene debounce, y por eso
   * pasaba en verde con el defecto delante. Con el **número** —el único campo diferido— el borrador
   * sobrevivía al vaciado de criterios y el efecto del debounce lo reaplicaba: el vacío por filtros
   * volvía a los 450 ms y el botón parecía no hacer nada.
   *
   * La espera de después del clic es la mitad del test: sin ella pasa igual con el fallo puesto,
   * porque el vacío A llega a pintarse antes de que el número regrese.
   */
  test('AC2 — vacío B por NÚMERO: quitar los filtros los quita, y el debounce no los devuelve', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    const traza = await mockListado(page, { status: 200, body: { items: [], nextCursor: null } });

    await page.goto('/flito/comparendos');
    await expect(page.getByText(/Todavía no hay comparendos registrados/)).toBeVisible();

    await campoNumero(page).fill('11001000999999');
    await expect(page.getByText(/Filtros puestos:.*n\.º «11001000999999»/)).toBeVisible();

    await boton(page, 'Quitar los filtros').click();
    await expect(page.getByText(/Todavía no hay comparendos registrados/)).toBeVisible();

    // Pasada la ventana del debounce, el vacío A SIGUE ahí: el número no ha vuelto solo.
    await page.waitForTimeout(900);
    await expect(page.getByText(/Todavía no hay comparendos registrados/)).toBeVisible();
    await expect(boton(page, 'Quitar los filtros')).toHaveCount(0);
    // Y el campo quedó vacío, que es la causa de que no haya nada que reaplicar.
    await expect(campoNumero(page)).toHaveValue('');
    // Segundo camino, independiente del DOM: la última consulta es la del listado sin filtros.
    expect(traza.peticiones[traza.peticiones.length - 1]).toBe('GET /api/flito/comparendos/registros');
  });

  test('AC2 — error con reintento: la tabla anterior se borra y el reintento repite la consulta', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    const traza = await mockListado(page, { status: 500, body: { error: 'Fallo del NIT 900.123.456-7' } });

    await page.goto('/flito/comparendos');

    const alerta = page.getByRole('alert');
    await expect(alerta).toContainText('No se pudieron cargar los comparendos');
    // El mensaje del servidor NO se pinta (regla heredada de la #11559): un filtro por forma deja
    // pasar el NIT con separadores, que es como lo escriben SIMIT y los organismos.
    expect(await page.locator('body').innerText()).not.toContain('900.123.456');
    expect(await page.content()).not.toContain('900.123.456');

    const antes = traza.peticiones.length;
    traza.respuesta = { status: 200, body: PAGINA };
    await boton(page, 'Reintentar').click();

    await expect(page.getByText('11001000123456')).toBeVisible();
    expect(traza.peticiones.length).toBeGreaterThan(antes);
  });

  test('AC3 — el número de comparendo busca con debounce: una sola consulta, y por GET', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    const traza = await mockListado(page, { status: 200, body: PAGINA });

    await page.goto('/flito/comparendos');
    await expect(page.getByText('11001000123456')).toBeVisible();
    const antes = traza.peticiones.length;

    await campoNumero(page).pressSequentially('1100', { delay: 60 });
    await expect.poll(() => traza.peticiones.filter((p) => p.includes('q=')).length).toBe(1);

    const consultas = traza.peticiones.slice(antes);
    // Una sola, y con el texto completo: el debounce se traga los estados intermedios. Cada consulta
    // escribe una fila en el registro de acceso PII (Ley 1581 art. 17), así que «una por búsqueda»
    // no es una optimización.
    expect(consultas).toEqual(['GET /api/flito/comparendos/registros?q=1100']);
    await sinRastroDeIdentidad(page);
  });

  test('AC3 — con menos de 3 caracteres no sale ninguna consulta y se dice por qué', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    const traza = await mockListado(page, { status: 200, body: PAGINA });

    await page.goto('/flito/comparendos');
    await expect(page.getByText('11001000123456')).toBeVisible();
    const antes = traza.peticiones.length;

    await campoNumero(page).fill('11');
    await expect(page.getByText('Escribe al menos 3 caracteres del número.')).toBeVisible();
    // `[Buscar]` tampoco lo manda: el servidor respondería 400 y el usuario vería un error por
    // haber tecleado dos caracteres.
    await boton(page, 'Buscar').click();
    await page.waitForTimeout(700);
    expect(traza.peticiones.length).toBe(antes);
  });

  test('AC4 — el NIT y la placa van en el CUERPO de un POST, nunca en la URL', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    const traza = await mockListado(page, { status: 200, body: PAGINA });

    await page.goto('/flito/comparendos');
    await expect(page.getByText('11001000123456')).toBeVisible();
    const antes = traza.peticiones.length;
    // El historial ANTES de buscar. Se compara al final: buscar no puede añadir ni una entrada.
    const historial = await sinRastroDeIdentidad(page);

    // Teclear un identificador NO consulta: hace falta un gesto explícito. Es lo que impide que
    // «900123456» deje cuatro filas en el registro de acceso PII y cuatro llamadas del limitador.
    await campoNit(page).pressSequentially('900.123.456', { delay: 20 });
    await campoPlaca(page).fill('ABC 123');
    await page.waitForTimeout(700);
    expect(traza.peticiones.length).toBe(antes);

    await boton(page, 'Buscar').click();
    await expect.poll(() => traza.cuerpos.length).toBe(1);

    // Los dos en el cuerpo, en un solo POST. El NIT normalizado —sin puntos— y la placa tal cual se
    // escribió: normalizarla es cosa del servidor.
    expect(JSON.parse(traza.cuerpos[0])).toEqual({ nit: '900123456', placa: 'ABC 123' });
    // Ni una sola petición del listado lleva el identificador en la query, en NINGUNA de sus
    // formas: ni normalizado, ni tal como se escribió, ni codificado para la URL. Va ANTES del
    // aserto de la forma del endpoint a propósito: los dos se ponen rojos ante la misma fuga, y el
    // que tiene que hablar es el que dice QUÉ se filtró y no el que dice que la URL cambió.
    for (const p of traza.peticiones) {
      sinRastro(p, `la petición «${p}»`, IDENTIDAD_EN_URL);
      expect(p).not.toContain('nit=');
      expect(p).not.toContain('placa=');
    }
    const ultima = traza.peticiones[traza.peticiones.length - 1];
    expect(ultima).toBe('POST /api/flito/comparendos/registros/buscar');
    await sinRastroDeIdentidad(page, historial);
    // Y el campo sigue mostrando los puntos: el texto se normaliza al mandarlo, no al escribirlo.
    await expect(campoNit(page)).toHaveValue('900.123.456');
  });

  test('AC4 — con Enter en cualquiera de los campos se busca igual que con el botón', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    const traza = await mockListado(page, { status: 200, body: PAGINA });

    await page.goto('/flito/comparendos');
    await expect(page.getByText('11001000123456')).toBeVisible();

    await campoPlaca(page).fill('ABC123');
    await campoPlaca(page).press('Enter');

    await expect.poll(() => traza.cuerpos.length).toBe(1);
    expect(JSON.parse(traza.cuerpos[0])).toEqual({ placa: 'ABC123' });
    await sinRastroDeIdentidad(page);
  });

  test('AC4+AC5 — paginar con un NIT puesto sigue siendo POST, con el NIT intacto en el cuerpo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    // El camino que un refactor rompe sin que nada se queje: el sufijo del cursor se concatena a la
    // URL del POST y el NIT se queda en el cuerpo. Mover el manejo del cursor a la rama `GET` —o
    // «simplificar» la segunda página a un GET porque «ya se buscó»— pondría el NIT en la query.
    const traza = await mockListado(page, { status: 200, body: { items: [FILA], nextCursor: 'CURSOR-NIT-1' } });
    traza.porCursor['CURSOR-NIT-1'] = { status: 200, body: { items: [FILA_SIMIT], nextCursor: null } };

    await page.goto('/flito/comparendos');
    await campoNit(page).fill('900.123.456');
    await boton(page, 'Buscar').click();
    await expect(page.getByText(/1 comparendos en esta página · página 1/)).toBeVisible();

    await boton(page, 'Siguiente →').click();
    await expect(page.getByText('05001000998877')).toBeVisible();

    // La segunda página: mismo verbo, mismo endpoint, cursor en la query y NIT en el cuerpo.
    expect(traza.peticiones[traza.peticiones.length - 1])
      .toBe('POST /api/flito/comparendos/registros/buscar?cursor=CURSOR-NIT-1');
    expect(traza.cuerpos).toHaveLength(2);
    expect(JSON.parse(traza.cuerpos[1])).toEqual({ nit: '900123456' });
    // Y ninguna de las dos peticiones —tampoco la que lleva cursor— toca la query con el NIT.
    for (const p of traza.peticiones) {
      sinRastro(p, `la petición «${p}»`, IDENTIDAD_EN_URL);
      expect(p).not.toContain('nit=');
    }
    await sinRastroDeIdentidad(page);

    // Y al volver atrás, otra vez POST: la primera página de una búsqueda por identidad no puede
    // caer al GET, que es la forma silenciosa de que el filtro se pierda y la lista se ensanche.
    await boton(page, '← Anterior').click();
    await expect(page.getByText('11001000123456')).toBeVisible();
    expect(traza.peticiones[traza.peticiones.length - 1])
      .toBe('POST /api/flito/comparendos/registros/buscar');
    expect(JSON.parse(traza.cuerpos[traza.cuerpos.length - 1])).toEqual({ nit: '900123456' });
  });

  test('AC5 — paginación por cursor: se manda tal cual, la página se reemplaza y el tope es del servidor', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    const traza = await mockListado(page, { status: 200, body: { items: [FILA], nextCursor: 'CURSOR-1' } });
    traza.porCursor['CURSOR-1'] = { status: 200, body: { items: [FILA_SIMIT], nextCursor: null } };

    await page.goto('/flito/comparendos');
    await expect(page.getByText('11001000123456')).toBeVisible();

    // La primera petición no manda `cursor` NI `limit`: ausente = COMPARENDOS_REGISTROS_LIMIT_MAX
    // (50), que es a la vez el tope y el valor por defecto del router. No pedirlo es lo que hace
    // imposible pedir de más.
    expect(traza.peticiones[0]).toBe('GET /api/flito/comparendos/registros');
    for (const p of traza.peticiones) expect(p).not.toContain('limit=');

    const anterior = boton(page, '← Anterior');
    const siguiente = boton(page, 'Siguiente →');
    await expect(anterior).toBeDisabled();
    await expect(siguiente).toBeEnabled();
    await expect(page.getByText(/1 comparendos en esta página · página 1/)).toBeVisible();

    await siguiente.click();
    await expect(page.getByText('05001000998877')).toBeVisible();
    // La página se REEMPLAZA: la fila anterior ya no está.
    await expect(page.getByText('11001000123456')).toHaveCount(0);
    expect(traza.peticiones[traza.peticiones.length - 1])
      .toBe('GET /api/flito/comparendos/registros?cursor=CURSOR-1');
    await expect(page.getByText(/página 2/)).toBeVisible();
    // `nextCursor: null` = no hay más. El botón se queda, inhabilitado: es lo que dice que se llegó
    // al final sin un cartel extra en cada consulta corta.
    await expect(siguiente).toBeDisabled();
    await expect(anterior).toBeEnabled();

    await anterior.click();
    await expect(page.getByText('11001000123456')).toBeVisible();
    await expect(anterior).toBeDisabled();
    // El contador no inventa un total que el API no devuelve.
    await expect(page.getByText(/comparendos en esta página · página/)).not.toContainText(/\bde \d/);
  });

  test('AC6 — cambiar de criterio con la lista ya paginada vuelve a la primera página y vacía la pila', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    const traza = await mockListado(page, { status: 200, body: { items: [FILA], nextCursor: 'CURSOR-1' } });
    traza.porCursor['CURSOR-1'] = { status: 200, body: { items: [FILA], nextCursor: 'CURSOR-2' } };
    traza.porCursor['CURSOR-2'] = { status: 200, body: { items: [FILA], nextCursor: 'CURSOR-3' } };

    await page.goto('/flito/comparendos');
    const siguiente = boton(page, 'Siguiente →');
    await siguiente.click();
    await expect(page.getByText(/página 2/)).toBeVisible();
    await siguiente.click();
    await expect(page.getByText(/página 3/)).toBeVisible();

    await boton(page, 'Activos').click();

    await expect(page.getByText(/página 1/)).toBeVisible();
    const ultima = traza.peticiones[traza.peticiones.length - 1];
    // Sin cursor: el que había apuntaba a una posición dentro de un orden que el filtro cambió.
    expect(ultima).toBe('GET /api/flito/comparendos/registros?estado=activo');
    // Y la PILA también se vació: si sobreviviera, «Anterior» desde esta página 1 devolvería una
    // página del listado viejo, con otros filtros y sin avisar.
    await expect(boton(page, '← Anterior')).toBeDisabled();
  });

  test('AC6 — el cursor caducado se explica en cristiano y devuelve al principio', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    const traza = await mockListado(page, { status: 200, body: { items: [FILA], nextCursor: 'CURSOR-1' } });
    traza.porCursor['CURSOR-1'] = {
      status: 400,
      body: {
        error: 'El cursor de paginación no es válido o pertenece a otra versión del listado. '
          + 'Pide la primera página sin `cursor`',
        codigo: 'cursor_invalido',
      },
    };

    await page.goto('/flito/comparendos');
    await boton(page, 'Siguiente →').click();

    const alerta = page.getByRole('alert');
    await expect(alerta).toContainText(/El listado cambió mientras/);
    // El copy es propio: el del backend es correcto para quien integra e incomprensible para quien
    // solo estaba pasando de página. Se detecta por `codigo`, no por el texto.
    await expect(alerta).not.toContainText('cursor');
    await boton(page, 'Volver a la primera página').click();

    await expect(page.getByText('11001000123456')).toBeVisible();
    expect(traza.peticiones[traza.peticiones.length - 1]).toBe('GET /api/flito/comparendos/registros');
  });

  test('AC7 — se llega a todo con el teclado, los campos tienen etiqueta y las pills dicen cuál está puesta', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    await mockListado(page, { status: 200, body: PAGINA });

    await page.goto('/flito/comparendos');
    await expect(page.getByText('11001000123456')).toBeVisible();

    // Las pills se anuncian con su estado, no como tres botones idénticos.
    const grupo = page.getByRole('group', { name: 'Filtrar por estado de monitoreo' });
    await expect(grupo.getByRole('button', { name: 'Todos', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(grupo.getByRole('button', { name: 'Activos', exact: true })).toHaveAttribute('aria-pressed', 'false');

    // Etiqueta asociada de verdad: `getByLabel` falla si el `<label>` no envuelve al control.
    await campoNumero(page).focus();
    await expect(campoNumero(page)).toBeFocused();
    // Y desde ahí se llega al resto de la barra solo con el tabulador.
    await page.keyboard.press('Tab');
    await expect(campoNit(page)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(campoPlaca(page)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(boton(page, 'Buscar')).toBeFocused();

    // La tabla no mete una parada de tabulador por celda: 50 filas × 12 columnas serían 600 paradas
    // para llegar a la paginación.
    //
    // Hasta la HU #11562 esto se afirmaba con `toHaveCount(0)`, porque no había ni un control en la
    // tabla. Ahora el número de comparendo ES un botón —abre el panel de detalle— y ese cero se
    // volvería rojo. **Lo que protege esta línea no es el cero, es la proporción**: UN control por
    // fila y ni uno más. Con el cero se habría borrado la afirmación entera y con ella la única
    // defensa contra la celda enfocable; con la cuenta atada a `PAGINA.items.length` la afirmación
    // sigue viva y además crece sola si mañana el fixture trae más filas.
    const filas = (PAGINA.items as unknown[]).length;
    await expect(page.getByRole('table').getByRole('button')).toHaveCount(filas);
    // Y el control de cada fila lleva su nombre accesible, porque el texto visible —un número de
    // catorce cifras— no dice qué pasa al pulsarlo.
    await expect(
      page.getByRole('button', { name: `Ver el comparendo ${FILA.numeroComparendo}` }),
    ).toBeVisible();
    await expect(page.getByRole('table').locator('caption')).toHaveClass(/sr-only/);
  });
});

// ═══════════════════════════ HU #11713 · «Tipo» y «Estado en la fuente» ═════════════════════════
//
// Dos datos que el backend ya publica desde la HU #11712 (`tipoRegistro`, `estadoFuente`) y que la
// tabla no mostraba. Lo que este bloque protege no son las dos columnas: son las tres maneras de
// equivocarse al añadirlas, y cada una tiene su prueba.
//
//   1. **Rellenar el hueco.** `tipoRegistro: null` es «no se sabe» —todo el histórico anterior a la
//      migración 0160— y pintarlo «Comparendo» lo convertiría en un dato verificado que nadie va a
//      revisar: las filas `inactivo` ya no las visita ningún sync. El front tampoco lo deriva de
//      `numeroResolucion`, que ni siquiera se pinta.
//   2. **Confundir los dos estados.** «Monitoreo» y «Estado en la fuente» hablan de cosas
//      distintas. En modo tabla un lector de pantalla anuncia la cabecera al cambiar de celda, así
//      que dos rótulos que empiezan por la misma palabra se oyen casi iguales.
//   3. **Pagar las columnas con accesibilidad.** Dos celdas más no pueden añadir paradas de
//      tabulador, ni `title`, ni alto de fila, ni hacer saltar el encabezado del esqueleto.

/** El estado del proveedor, largo de verdad: 80 caracteres. Los organismos escriben frases. */
const ESTADO_LARGO = 'RESOLUCIÓN DE COBRO COACTIVO NOTIFICADA POR AVISO — SALDO PENDIENTE POR PAGAR AA';

const FILA_MULTA = {
  ...FILA,
  id: '33333333-3333-4333-8333-333333333333',
  numeroComparendo: '76001000445566',
  tipoRegistro: 'multa',
  numeroResolucion: 'RES-2026-4471',
  estadoFuente: 'Se adeuda',
  causalId: CAUSAL_ID,
};

const FILA_COMPARENDO = {
  ...FILA,
  id: '44444444-4444-4444-8444-444444444444',
  numeroComparendo: '11001000778899',
  tipoRegistro: 'comparendo',
  numeroResolucion: null,
  estadoFuente: null,
};

/** El tipo que este front todavía no conoce: lo manda un backend un paso por delante de la pestaña. */
const FILA_TIPO_DESCONOCIDO = {
  ...FILA,
  id: '55555555-5555-4555-8555-555555555555',
  numeroComparendo: '05001000112233',
  tipoRegistro: 'sancion',
  numeroResolucion: null,
  estadoFuente: ESTADO_LARGO,
};

const PAGINA_TIPOS = {
  items: [FILA_MULTA, FILA_COMPARENDO, FILA_SIMIT, FILA_TIPO_DESCONOCIDO],
  nextCursor: null,
};

/**
 * La clave `tipoRegistro` **AUSENTE**, que no es lo mismo que `null`.
 *
 * Es lo que responde el backend anterior al merge de la HU #11712, y lo que ve durante minutos una
 * pestaña ya cargada el día del despliegue: el mismo escenario que el resto del bloque dice cubrir,
 * pero con el campo sin llegar en vez de llegando en nulo. `ComparendoRegistro` NO admite este
 * payload —por eso la fila se construye quitando la clave con un `rest` y no escribiéndola como
 * `undefined`, que el tipo tampoco aceptaría— pero la red sí lo entrega, y de eso va la prueba.
 *
 * Va en su propia página, con una sola fila: añadirla a `PAGINA_TIPOS` movería el conteo de filas y
 * los altos que miden los otros tests de este bloque.
 */
const { tipoRegistro: _tipoOmitido, ...FILA_SIN_CLAVE_TIPO } = FILA;
const FILA_SIN_TIPO = {
  ...FILA_SIN_CLAVE_TIPO,
  id: '66666666-6666-4666-8666-666666666666',
  numeroComparendo: '08001000334455',
  numeroResolucion: null,
  estadoFuente: null,
};

const PAGINA_SIN_TIPO = { items: [FILA_SIN_TIPO], nextCursor: null };

/**
 * Los tres peores casos de «Estado en la fuente» (HU #11777), y ninguno es el que parecía.
 *
 * La decisión de UX se apoya en que el campo está ACOTADO —`estado_fuente` es `varchar(80)` en
 * `apps/api/src/db/schema.ts`—, así que «entero» tiene un alcance exacto: para todo dato que el
 * contrato puede producir. Estos fixtures son ese contrato llevado al límite, y cada uno rompe una
 * clase distinta de la celda:
 *
 *   · `ESTADO_SIN_ESPACIOS` — 80 caracteres SIN un solo espacio. Sin `wrap-anywhere` el navegador
 *     no tiene dónde partir, la palabra se sale de la caja y el `overflow: hidden` del clamp la
 *     corta EN HORIZONTAL, sin puntos suspensivos y sin aviso: el mismo defecto de la #11713
 *     reaparecido de lado. Medido: `scrollWidth` 734 px contra 224 px de caja.
 *   · `ESTADO_ANCHO` — 80 caracteres de la letra más ancha del alfabeto. Es legal en un
 *     `varchar(80)` y es el que fija la altura del airbag: medido, ocupa CINCO líneas a 14 rem,
 *     no las tres que salían de la cuenta a ojo. Con un `line-clamp-4` este valor quedaría
 *     recortado y el AC1 sería falso para un dato que la base sí admite.
 *   · `ESTADO_FUERA_DE_CONTRATO` — 319 caracteres. La base NO puede producirlo hoy, pero la red sí
 *     lo entrega —el mismo argumento con el que este archivo ya justifica `FILA_SIN_TIPO`— y es el
 *     único que hace ACTUAR al airbag. Sin él nadie comprobaría que el tope existe.
 *
 * Van en su propia página: añadirlos a `PAGINA_TIPOS` movería los altos de fila que miden los otros
 * tests del bloque, que es la razón por la que `FILA_SIN_TIPO` ya vive aparte.
 */
const ESTADO_SIN_ESPACIOS = 'PENDIENTEDEPAGOPORRESOLUCIONDECOBROCOACTIVONOTIFICADAPORAVISO'.padEnd(80, 'X');
const ESTADO_ANCHO = 'W'.repeat(80);
const ESTADO_FUERA_DE_CONTRATO = 'RESOLUCION DE COBRO COACTIVO '.repeat(11);

const FILA_ESTADO_SIN_ESPACIOS = {
  ...FILA, id: '77777777-7777-4777-8777-777777777777',
  numeroComparendo: '13001000112233', estadoFuente: ESTADO_SIN_ESPACIOS,
};
const FILA_ESTADO_ANCHO = {
  ...FILA, id: '88888888-8888-4888-8888-888888888888',
  numeroComparendo: '13001000445566', estadoFuente: ESTADO_ANCHO,
};
const FILA_ESTADO_FUERA = {
  ...FILA, id: '99999999-9999-4999-8999-999999999999',
  numeroComparendo: '13001000778899', estadoFuente: ESTADO_FUERA_DE_CONTRATO,
};
const PAGINA_ESTADOS_LARGOS = {
  items: [FILA_MULTA, FILA_ESTADO_SIN_ESPACIOS, FILA_ESTADO_ANCHO, FILA_ESTADO_FUERA],
  nextCursor: null,
};

/** Las medidas del `<span>` del estado: todo lo que hace falta para saber si algo quedó escondido. */
async function medidasDelEstado(page: Page, numeroDeFila: string) {
  const td = await celdaDe(page, numeroDeFila, 'Estado en la fuente');
  const span = await td.locator('span').evaluate((el) => ({
    alto: el.clientHeight,
    altoReal: el.scrollHeight,
    ancho: el.clientWidth,
    anchoReal: el.scrollWidth,
    linea: parseFloat(getComputedStyle(el).lineHeight),
  }));
  return {
    td,
    ...span,
    /** Lo que la HU #11777 prohíbe: contenido fuera de la caja, en cualquiera de los dos ejes. */
    recortadoEnVertical: span.altoReal > span.alto,
    recortadoEnHorizontal: span.anchoReal > span.ancho + 1,
  };
}

/**
 * La celda de una columna, por el NOMBRE de su cabecera y no por una posición escrita a mano.
 *
 * Un índice literal (`td:nth-child(2)`) se queda en verde cuando alguien mueve la columna: seguiría
 * leyendo «la segunda celda», que ya sería otra cosa. Buscando el índice en el encabezado, mover la
 * columna mueve también el aserto — y quitarla pone el test rojo con un mensaje que se entiende.
 *
 * Se cuentan los `th` con un selector CSS y no por rol: por debajo de 1280 px los de nivel B están
 * en el DOM pero fuera del árbol accesible, y el índice de columna tiene que seguir siendo el mismo
 * en los dos anchos porque los `td` de nivel B tampoco desaparecen del DOM.
 */
async function celdaDe(page: Page, textoDeFila: string, cabecera: string) {
  const cabeceras = await page.locator('table thead th').allTextContents();
  const indice = cabeceras.findIndex((t) => t.trim() === cabecera);
  expect(indice, `no existe la columna «${cabecera}»`).toBeGreaterThanOrEqual(0);
  return page.getByRole('row').filter({ hasText: textoDeFila }).locator('td').nth(indice);
}

test.describe('FLITO — Comparendos · «Tipo» y «Estado en la fuente» (HU #11713)', () => {
  test.use({ viewport: { width: 1600, height: 900 } });

  test('AC1+AC3 — «Multa» en texto plano SIN chip; el tipo nulo es «—» y no «Comparendo»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    await mockListado(page, { status: 200, body: PAGINA_TIPOS });

    await page.goto('/flito/comparendos');
    await expect(page.getByText(FILA_MULTA.numeroComparendo)).toBeVisible();

    const tipoMulta = await celdaDe(page, FILA_MULTA.numeroComparendo, 'Tipo');
    await expect(tipoMulta).toHaveText('Multa');
    // **Texto plano, no un chip**, y se comprueba por dos caminos que fallan por separado:
    //   · la celda no tiene NI UN elemento dentro —un `StatusChip` son dos `span` anidados—,
    //   · y en particular no está el punto decorativo `aria-hidden` que todo chip lleva.
    // Ningún `ChipTone` diría la verdad aquí: `warning`/`danger` editorializan una etapa normal del
    // cobro, `success` sería perverso, `active` ya lo lleva «Monitoreo» en esta misma fila y
    // `draft`/`neutral` son los grises que en esta tabla significan «Inactivo» y «Sin gestión».
    await expect(tipoMulta.locator('*')).toHaveCount(0);
    await expect(tipoMulta.locator('[aria-hidden="true"]')).toHaveCount(0);

    const tipoComparendo = await celdaDe(page, FILA_COMPARENDO.numeroComparendo, 'Tipo');
    await expect(tipoComparendo).toHaveText('Comparendo');
    // Mismo PESO tipográfico en los dos valores: una «Multa» en negrita sería color por otros
    // medios, que es justo lo que la decisión de no usar chip descartó.
    const peso = (c: typeof tipoMulta) => c.evaluate((el) => getComputedStyle(el).fontWeight);
    expect(await peso(tipoMulta)).toBe(await peso(tipoComparendo));

    // El mutante de la HU: `null` pintado «Comparendo». Es la fila del histórico, y en una fila
    // `inactivo` el hueco es permanente porque ningún sync vuelve a visitarla.
    const tipoNulo = await celdaDe(page, FILA_SIMIT.numeroComparendo, 'Tipo');
    await expect(tipoNulo).toHaveText('—');

    // Y en ESA MISMA fila «Sin gestión» sigue siendo un chip: las dos ausencias no se confunden.
    // Sin este aserto, «pintar el guion en todas las celdas vacías» pasaría el test de arriba.
    const gestionNula = await celdaDe(page, FILA_SIMIT.numeroComparendo, 'Gestión');
    await expect(gestionNula).toContainText('Sin gestión');
    await expect(gestionNula.locator('[aria-hidden="true"]')).toHaveCount(1);

    // Un tipo que este front no conoce se pinta CRUDO, no «undefined» y no en blanco: el mapa es un
    // `Record` sobre la unión —añadir un tipo al contrato no compila hasta escribirle su texto— pero
    // el valor llega por la red, y una pestaña cacheada puede recibir uno que el mapa no tiene.
    const tipoRaro = await celdaDe(page, FILA_TIPO_DESCONOCIDO.numeroComparendo, 'Tipo');
    await expect(tipoRaro).toHaveText('sancion');

    // El número de resolución no es una columna: es el dato del que el backend DERIVA el tipo.
    await expect(page.getByRole('table').getByText('RES-2026-4471')).toHaveCount(0);
  });

  test('AC3 — con la clave `tipoRegistro` AUSENTE la celda «Tipo» dice «—» y NO se queda vacía', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    await mockListado(page, { status: 200, body: PAGINA_SIN_TIPO });

    await page.goto('/flito/comparendos');
    await expect(page.getByText(FILA_SIN_TIPO.numeroComparendo)).toBeVisible();

    // El campo ausente NO es `null`, y ese es todo el punto: una comparación estricta contra `null`
    // lo deja pasar, el `Record` devuelve `undefined`, el respaldo al valor crudo devuelve
    // `undefined` y React no pinta nada. La celda vacía es la única de las tres formas prohibidas
    // por el AC3 que todavía se puede conseguir, y se consigue sin tocar ninguna otra línea.
    const tipo = await celdaDe(page, FILA_SIN_TIPO.numeroComparendo, 'Tipo');
    await expect(tipo).toHaveText('—');
    // Y las tres prohibiciones del AC3 por separado, porque fallan por motivos distintos: la celda
    // vacía es un `undefined` renderizado, «null»/«undefined» serían una interpolación descuidada.
    expect((await tipo.innerText()).trim()).not.toBe('');
    await expect(tipo).not.toHaveText(/^(null|undefined)$/i);
  });

  // El título de este test decía «a una línea y sin mover el alto» hasta la HU #11777, y sus tres
  // asertos de recorte afirmaban EXACTAMENTE el defecto que el PO pidió corregir: que el estado se
  // viera a medias. Se enmienda, no se borra —las ocho prohibiciones que traía siguen intactas— y
  // los tres asertos del recorte se invierten o se convierten en cotas. Un test cuyo nombre siga
  // diciendo «a una línea» sería una mentira archivada.
  test('AC1+AC2+AC5 — «Estado en la fuente» tal cual, sin `title`, ENTERO y con el alto acotado', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    await mockListado(page, { status: 200, body: PAGINA_TIPOS });

    await page.goto('/flito/comparendos');
    await expect(page.getByText(FILA_MULTA.numeroComparendo)).toBeVisible();

    // Tal cual llega: ni `capitalize` ni `uppercase`. «Se adeuda» es lo que el operador tendría que
    // citarle al organismo, y «Se Adeuda» ya no sería lo que dijo la fuente.
    const estado = await celdaDe(page, FILA_MULTA.numeroComparendo, 'Estado en la fuente');
    await expect(estado).toHaveText('Se adeuda');
    // `toHaveText` compara el texto renderizado, no el aplicado por CSS, así que la transformación
    // se comprueba aparte: es el único camino por el que un `capitalize` pasaría desapercibido.
    //
    // Y se mide la celda **y todo lo que lleva dentro**, no solo el `<td>`: la clase de Tailwind
    // vive en el `<span>` del `line-clamp`, así que hasta la HU #11771 un `capitalize` en el span
    // pasaba este aserto en verde mientras el operador leía «Se Adeuda» en pantalla. Se recogen los
    // infractores en vez de afirmar un booleano para que el fallo diga QUÉ elemento y con qué
    // valor, y el barrido por descendientes sobrevive a que mañana se envuelva el texto en otra
    // capa: el aserto no queda atado a la forma exacta del DOM de hoy.
    const transformados = await estado.evaluate((el) =>
      [el, ...el.querySelectorAll('*')]
        .filter((n) => getComputedStyle(n).textTransform !== 'none')
        .map((n) => `${n.tagName.toLowerCase()}[${n.className}] → ${getComputedStyle(n).textTransform}`),
    );
    expect(transformados, 'nada dentro de la celda del estado puede llevar `text-transform`').toEqual([]);

    // `null` → «—», igual que el resto de ausencias del módulo.
    const estadoNulo = await celdaDe(page, FILA_COMPARENDO.numeroComparendo, 'Estado en la fuente');
    await expect(estadoNulo).toHaveText('—');

    // 80 caracteres —el peor caso QUE EL CONTRATO PERMITE—, sin `title` en ninguna parte de la
    // celda. La longitud del fixture se afirma aquí, junto al aserto que la usa: sin esto, alguien
    // acorta la constante un día y el caso peor deja de serlo sin que nadie lo note.
    expect(ESTADO_LARGO, '`estado_fuente` es varchar(80): el peor caso son 80 caracteres').toHaveLength(80);
    const estadoLargo = await celdaDe(page, FILA_TIPO_DESCONOCIDO.numeroComparendo, 'Estado en la fuente');
    await expect(estadoLargo).toHaveText(ESTADO_LARGO);
    await expect(estadoLargo.locator('[title]')).toHaveCount(0);
    await expect(estadoLargo).not.toHaveAttribute('title', /.*/);
    // Y el texto NO se recorta con puntos suspensivos en el DOM: se recorta al PINTAR. Lo que llega
    // al portapapeles sigue siendo la frase entera.
    expect((await estadoLargo.innerText()).length).toBe(ESTADO_LARGO.length);

    // EL CORAZÓN DE LA HU, y es el aserto que hasta la #11777 decía justo lo contrario
    // (`expect(clamp.desbordado).toBe(true)`): no queda NI UN carácter escondido.
    //
    // MUTANTE: reponer el `line-clamp-1` de la #11713 (o un `-2`). Medido con el `-1`, estos mismos
    // 80 caracteres dan `scrollHeight` 100 px contra `clientHeight` 20 px, y esto se pone rojo.
    // Honestidad sobre el alcance: un `line-clamp-5` NO lo mata, porque con cinco líneas este valor
    // tampoco se recorta — lo que la HU exige es que no se recorte, no que la clase diga «6».
    const clamp = await medidasDelEstado(page, FILA_TIPO_DESCONOCIDO.numeroComparendo);
    expect(clamp.recortadoEnVertical, `${clamp.altoReal} px de texto en una caja de ${clamp.alto} px`).toBe(false);

    // MUTANTE: estrechar la columna a los 11 rem de antes. Medido, ahí los mismos 80 caracteres
    // necesitan CINCO líneas (100 px) y esta cota de cuatro cae.
    //
    // Este aserto va EN PAREJA con el del ancho, que vive en el test de 2400 px de aquí abajo:
    // cada uno por separado se satisface haciendo la columna absurda en la otra dimensión —una
    // columna de 40 rem también cabría de sobra en cuatro líneas—, y hacen falta los dos para que
    // «14 rem» quede fijado por arriba y por abajo.
    expect(clamp.alto, `${clamp.alto} px con interlínea de ${clamp.linea} px`)
      .toBeLessThanOrEqual(Math.ceil(clamp.linea) * 4 + 2);

    // Y la consecuencia que se ve: la fila CRECE —eso es la HU— pero con techo. Hasta la #11777
    // aquí se exigía que no se moviera ni un píxel, y esa exigencia era exactamente lo que
    // mantenía el dato escondido.
    const altoDe = async (numero: string) => {
      const caja = await page.getByRole('row').filter({ hasText: numero }).boundingBox();
      return caja?.height ?? 0;
    };
    const largo = await altoDe(FILA_TIPO_DESCONOCIDO.numeroComparendo);
    const corto = await altoDe(FILA_MULTA.numeroComparendo);
    expect(largo - corto, `${largo} px frente a ${corto} px`)
      .toBeLessThanOrEqual(Math.ceil(clamp.linea) * 4 + 2);

    // AC5 · el alto de la fila CORTA no se mueve. MUTANTE: la alternativa 8 que UX descartó —subir
    // todas las filas a tres líneas para recuperar la uniformidad—, que costaría ~1.800 px de
    // scroll por página. Un `min-h` en la celda pondría esto rojo.
    const cortito = await medidasDelEstado(page, FILA_MULTA.numeroComparendo);
    expect(cortito.alto, `«Se adeuda» ocupa ${cortito.alto} px`)
      .toBeLessThanOrEqual(Math.ceil(cortito.linea) + 2);

    // AC5 · con un estado de varias líneas, la fila alinea ARRIBA: el número del comparendo no
    // flota a media altura. Se comparan los dos CONTENIDOS y no las cajas de los `<td>`, porque un
    // `<td>` ocupa siempre el alto entero de la fila pase lo que pase con `vertical-align`, así que
    // medir el `<td>` dejaría este aserto en verde para siempre.
    //
    // MUTANTE: quitar el `align-top` de `CELDA`. Medido: con `align-top` la diferencia es de 0 px y
    // con el `middle` de antes es de 30 px.
    const yDelNumero = await page.getByRole('row')
      .filter({ hasText: FILA_TIPO_DESCONOCIDO.numeroComparendo }).getByRole('button').first().boundingBox();
    const yDelEstado = await estadoLargo.locator('span').boundingBox();
    expect(Math.abs((yDelNumero?.y ?? 0) - (yDelEstado?.y ?? 0)),
      `número en y=${yDelNumero?.y}, estado en y=${yDelEstado?.y}`).toBeLessThanOrEqual(4);
  });

  /**
   * AC1 y AC3 en los dos casos que el fixture de 80 caracteres CON espacios no puede provocar, y
   * que son los dos que devolverían el defecto por la puerta de atrás.
   */
  test('AC1+AC3 — 80 caracteres sin un solo espacio: se parten, se ven enteros y NO ensanchan la columna', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    await mockListado(page, { status: 200, body: PAGINA_ESTADOS_LARGOS });

    // El AC1 habla de «a ≥1280 px» y 1280 es el caso más apretado: es justo donde la columna
    // aparece (`hidden xl:table-cell`) y donde la tabla más desplaza en horizontal.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/flito/comparendos');
    await expect(page.getByText(FILA_MULTA.numeroComparendo)).toBeVisible();

    // Los dos fixtures se autocomprueban: si mañana alguien los acorta, dejan de ser el caso peor.
    expect(ESTADO_SIN_ESPACIOS).toHaveLength(80);
    expect(ESTADO_SIN_ESPACIOS, 'el caso peor es el que NO tiene dónde partirse').not.toContain(' ');
    expect(ESTADO_ANCHO).toHaveLength(80);

    // El valor llega entero al DOM y se puede copiar entero: el ajuste de línea no mete saltos.
    const sinEspacios = await celdaDe(page, FILA_ESTADO_SIN_ESPACIOS.numeroComparendo, 'Estado en la fuente');
    await expect(sinEspacios).toHaveText(ESTADO_SIN_ESPACIOS);
    expect((await sinEspacios.innerText()).length).toBe(80);
    await expect(sinEspacios.locator('[title]')).toHaveCount(0);
    await expect(sinEspacios).not.toHaveAttribute('title', /.*/);

    const m = await medidasDelEstado(page, FILA_ESTADO_SIN_ESPACIOS.numeroComparendo);
    // MUTANTE: quitar `wrap-anywhere`. Es el más silencioso de todos, porque el alto sigue estando
    // bien y el texto sigue entero en el DOM: lo que pasa es que la palabra no tiene dónde partirse,
    // se sale de la caja y el `overflow: hidden` del clamp la corta EN HORIZONTAL, sin puntos
    // suspensivos. Medido sin la clase: `scrollWidth` 734 px contra `clientWidth` 224 px.
    expect(m.recortadoEnHorizontal, `${m.anchoReal} px de texto en una caja de ${m.ancho} px`).toBe(false);
    expect(m.recortadoEnVertical, `${m.altoReal} px de texto en una caja de ${m.alto} px`).toBe(false);

    // Y no se paga ensanchando la columna: 14 rem de contenido + `px-4` a cada lado = 16 rem.
    // MUTANTE: quitar `wrap-anywhere` **y** el `max-w`, que es como la palabra de 80 caracteres
    // acaba pidiendo ~672 px de columna y descuadrando el reparto de las otras trece.
    const caja = await m.td.boundingBox();
    expect(caja?.width ?? 0, `la celda mide ${caja?.width} px`).toBeLessThanOrEqual(16 * 16 + 1);

    // 80 caracteres de la letra más ancha del alfabeto: también legal en un `varchar(80)`.
    // MUTANTE: bajar el clamp a `line-clamp-4`. Medido, este valor ocupa CINCO líneas a 14 rem, así
    // que con un tope de cuatro quedaría recortado y el AC1 sería falso para un dato que la base
    // admite. Es la razón por la que el tope es 6 y no 4: una línea de margen sobre el peor caso
    // medido, para que dentro del contrato el airbag NUNCA actúe.
    const ancho = await medidasDelEstado(page, FILA_ESTADO_ANCHO.numeroComparendo);
    await expect(ancho.td).toHaveText(ESTADO_ANCHO);
    expect(ancho.recortadoEnVertical, `${ancho.altoReal} px de texto en una caja de ${ancho.alto} px`).toBe(false);
    expect(ancho.recortadoEnHorizontal).toBe(false);

    // El airbag, en el único caso que lo hace actuar: 319 caracteres que la base no puede producir
    // hoy pero la red sí entrega. Aquí SÍ se recorta, y esa es la decisión: un valor fuera del
    // contrato no puede convertir una fila en quince líneas. El valor entero sigue en el detalle.
    // MUTANTE: quitar el `line-clamp-6`. Sin él la caja mide 300 px (quince líneas) y la cota cae.
    expect(ESTADO_FUERA_DE_CONTRATO.length).toBeGreaterThan(80);
    const fuera = await medidasDelEstado(page, FILA_ESTADO_FUERA.numeroComparendo);
    expect(fuera.alto, `${fuera.alto} px con interlínea de ${fuera.linea} px`)
      .toBeLessThanOrEqual(Math.ceil(fuera.linea) * 6 + 2);
    expect(fuera.recortadoEnVertical, 'fuera del contrato el tope TIENE que actuar').toBe(true);
  });

  /**
   * La otra mitad de la pareja de asertos que fija la columna en 14 rem.
   *
   * A 1600 px la tabla ya desborda, así que el reparto automático la aprieta contra su mínimo y el
   * `max-w` no se nota: quitarlo no cambia ni un píxel y ningún aserto del test de arriba se
   * entera. Hace falta un viewport con HOLGURA para que se vea, y por eso este test existe aparte.
   */
  test('AC3 — con sitio de sobra la columna del estado NO crece: `max-w` la fija en 14 rem', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    await mockListado(page, { status: 200, body: PAGINA_ESTADOS_LARGOS });

    await page.setViewportSize({ width: 2400, height: 900 });
    await page.goto('/flito/comparendos');
    await expect(page.getByText(FILA_MULTA.numeroComparendo)).toBeVisible();

    // MUTANTE: quitar el `max-w-[14rem]`. Medido a 2400 px sin la clase, el reparto automático le
    // regala a esta columna todo el sobrante y el `<span>` pasa de 224 px a **734 px** —el ancho de
    // los 80 caracteres en una sola línea—, que es justo el ensanche que UX descartó.
    const m = await medidasDelEstado(page, FILA_ESTADO_SIN_ESPACIOS.numeroComparendo);
    expect(m.ancho, `el estado ocupa ${m.ancho} px de ancho`).toBeLessThanOrEqual(14 * 16 + 1);

    // Y el alto NO depende del viewport, que es lo que descartó la alternativa 11 (ancho variable
    // por breakpoint): los mismos 80 caracteres ocupan aquí lo mismo que a 1280 px.
    expect(m.alto, `${m.alto} px con interlínea de ${m.linea} px`)
      .toBeLessThanOrEqual(Math.ceil(m.linea) * 4 + 2);
  });

  test('AC5 — el `caption` sigue diciendo las TRES advertencias, y no solo llevando `sr-only`', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    await mockListado(page, { status: 200, body: PAGINA_TIPOS });

    await page.goto('/flito/comparendos');
    await expect(page.getByText(FILA_MULTA.numeroComparendo)).toBeVisible();

    // En modo tabla el `caption` es el único texto que un lector de pantalla anuncia con seguridad
    // al entrar, y por eso el AC5 lo cargó con tres advertencias que ninguna cabecera de once
    // caracteres puede dar. Hasta la HU #11771 lo único que alguien afirmaba de él era que llevaba
    // `sr-only`: devolverle el texto anterior —el que solo hablaba de activo/inactivo— dejaba la
    // suite entera en verde.
    const caption = page.getByRole('table').locator('caption');
    // Sigue siendo para quien escucha y no para quien mira: un caption visible cambiaría la tabla.
    await expect(caption).toHaveClass(/sr-only/);
    // `textContent` y no `innerText`: el `sr-only` recorta la caja a un píxel, y lo que se afirma es
    // lo que se anuncia, no lo que se pinta. El JSX parte la frase en varias líneas.
    const texto = ((await caption.textContent()) ?? '').replace(/\s+/g, ' ').trim();

    // Las TRES cláusulas POR SEPARADO y por sus piezas semánticas, nunca la cadena literal: un
    // aserto sobre el texto exacto se pone rojo con cualquier retoque de redacción, acaba
    // molestando y termina borrado —que es justo como se pierde la cobertura—. Cada cláusula
    // nombra su rótulo Y desactiva UNA lectura falsa concreta, y van en `expect.soft` para que el
    // fallo liste TODAS las que faltan de una vez: si alguien vacía el caption, el informe dice las
    // tres cosas que se perdieron y no solo la primera.

    // 1. «Monitoreo» no habla de pagos: sin esto, «inactivo» se oye como «ya está pagado».
    expect.soft(texto, 'el caption nombra la columna «Monitoreo» por su rótulo').toMatch(/monitoreo/i);
    expect.soft(texto, '…y dice que «inactivo» NO quiere decir pagado').toMatch(/inactivo/i);
    expect.soft(texto, '…negando el pago expresamente').toMatch(/pagad/i);

    // 2. «Estado en la fuente» llega crudo y puede venir vacío: sin esto, una celda en blanco se
    //    lee como «no debe nada» en vez de «la fuente no dijo nada».
    expect.soft(texto, 'el caption nombra «Estado en la fuente»').toMatch(/estado en la fuente/i);
    expect.soft(texto, '…avisa de que NO está normalizado').toMatch(/normaliz/i);
    expect.soft(texto, '…y de que puede venir vacío').toMatch(/vac[ií]/i);

    // 3. Qué separa un comparendo de una multa: sin esto, «Multa» se lee como un error de la
    //    fuente y no como la etapa siguiente del mismo hecho.
    expect.soft(texto, 'el caption nombra la columna «Tipo»').toMatch(/tipo/i);
    expect.soft(texto, '…y contrapone comparendo con multa').toMatch(/comparendo/i);
    expect.soft(texto, '…nombrando la multa').toMatch(/multa/i);
  });

  test('AC2 — la columna del monitoreo se lee «Monitoreo», y ninguna se llama solo «Estado»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    await mockListado(page, { status: 200, body: PAGINA_TIPOS });

    await page.goto('/flito/comparendos');
    const tabla = page.getByRole('table');
    await expect(tabla.getByRole('columnheader', { name: 'Monitoreo', exact: true })).toBeVisible();
    // El mutante: devolverle el nombre «Estado». Con «Estado en la fuente» en la misma tabla, un
    // lector en modo tabla anunciaría «Estado… Activo» y «Estado en la fuente… Se adeuda»: dos
    // primeras palabras idénticas para dos hechos que no tienen nada que ver.
    await expect(tabla.getByRole('columnheader', { name: 'Estado', exact: true })).toHaveCount(0);
    await expect(page.locator('table thead th', { hasText: /^Estado$/ })).toHaveCount(0);

    // Y sigue siendo el chip de siempre, con su etiqueta dentro: lo que cambió es el rótulo de la
    // columna, no la presentación del valor.
    const monitoreo = await celdaDe(page, FILA_MULTA.numeroComparendo, 'Monitoreo');
    await expect(monitoreo).toContainText('Activo');
    await expect(monitoreo.locator('[aria-hidden="true"]')).toHaveCount(1);
  });

  test('AC4+AC5 — sin selector de columnas y con UNA sola parada de tabulador por fila', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    await mockListado(page, { status: 200, body: PAGINA_TIPOS });

    await page.goto('/flito/comparendos');
    await expect(page.getByText(FILA_MULTA.numeroComparendo)).toBeVisible();

    // No hay menú de columnas ni preferencia persistida: sería un patrón nuevo que ninguna otra
    // pantalla de FLITO tiene. El reparto es A/B por breakpoint y nada más.
    for (const nombre of [/columnas/i, /personalizar/i, /mostrar columnas/i]) {
      await expect(page.getByRole('button', { name: nombre })).toHaveCount(0);
    }
    const almacenado = await page.evaluate(
      () => JSON.stringify(window.localStorage) + JSON.stringify(window.sessionStorage),
    );
    expect(almacenado.toLowerCase()).not.toContain('columna');

    // Las dos celdas nuevas son `<td>` MUDOS. Se camina el tabulador de verdad desde el primer
    // botón: tantas paradas dentro de la tabla como filas, ni una más. Un `tabIndex` en la celda de
    // «Tipo» —o un botón para copiar el estado de la fuente— pondría esto rojo al instante.
    const filas = PAGINA_TIPOS.items.length;
    const tabla = page.getByRole('table');
    await expect(tabla.getByRole('button')).toHaveCount(filas);

    await tabla.getByRole('button').first().focus();
    let paradas = 1;
    for (let i = 0; i < 60; i += 1) {
      await page.keyboard.press('Tab');
      const dentro = await page.evaluate(() => !!document.activeElement?.closest('table'));
      if (!dentro) break;
      paradas += 1;
    }
    expect(paradas).toBe(filas);
  });

  test('AC9 — la petición NO manda `tipo` ni `estadoFuente`: el esquema del backend es `.strict()`', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    const traza = await mockListado(page, { status: 200, body: PAGINA_TIPOS });

    await page.goto('/flito/comparendos');
    await expect(page.getByText(FILA_MULTA.numeroComparendo)).toBeVisible();
    // Las dos columnas son de LECTURA. Un filtro por tipo o por estado de la fuente no existe en el
    // contrato, y mandarlo «por si acaso» sería un 400 en cada carga de la pantalla.
    await campoPlaca(page).fill('ABC123');
    await boton(page, 'Buscar').click();
    await expect.poll(() => traza.cuerpos.length).toBe(1);

    for (const p of traza.peticiones) {
      expect(p).not.toContain('tipo');
      expect(p).not.toContain('estadoFuente');
      expect(p).not.toContain('estado_fuente');
    }
    for (const cuerpo of traza.cuerpos) {
      const enviado = JSON.parse(cuerpo) as Record<string, unknown>;
      expect(Object.keys(enviado)).not.toContain('tipo');
      expect(Object.keys(enviado)).not.toContain('tipoRegistro');
      expect(Object.keys(enviado)).not.toContain('estadoFuente');
    }
  });
});

test.describe('FLITO — Comparendos · el reparto A/B y el esqueleto (HU #11713, AC6)', () => {
  /**
   * Los dos anchos que importan son 1280 y 1279: `xl` de Tailwind es `min-width: 1280px`, así que el
   * píxel de diferencia es la frontera exacta. Se prueban los DOS porque un `lg:` en lugar de un
   * `xl:` pasaría cualquier test escrito solo a 1600.
   *
   * A 1280 son **catorce** cabeceras (diez de nivel A + tres de B + «Inactivado», que solo existe
   * con el filtro «Inactivos» puesto) y a 1279 son **diez**.
   */
  const ANCHO = { xl: 1280, previo: 1279 };

  /** Con el filtro «Inactivos» puesto, que es lo que hace existir la columna condicional. */
  async function abrirInactivos(page: Page) {
    await page.goto('/flito/comparendos');
    await boton(page, 'Inactivos').click();
    await expect(page.getByText(FILA_SIMIT.numeroComparendo)).toBeVisible();
  }

  test('a 1280 px hay 14 cabeceras y a 1279 px hay 10; el nivel B sale del árbol accesible', async ({ page }) => {
    await page.setViewportSize({ width: ANCHO.xl, height: 900 });
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);
    await mockListado(page, { status: 200, body: { items: [FILA_SIMIT], nextCursor: null } });
    await abrirInactivos(page);

    const tabla = page.getByRole('table');
    await expect(tabla.getByRole('columnheader')).toHaveCount(14);
    for (const b of ['Estado en la fuente', 'Origen', 'Registrado', 'Inactivado']) {
      await expect(tabla.getByRole('columnheader', { name: b, exact: true })).toBeVisible();
    }

    await page.setViewportSize({ width: ANCHO.previo, height: 900 });
    // **`toHaveCount(10)` sobre el ROL**: lo que se afirma es que las cuatro de nivel B salieron del
    // árbol accesible, no solo que no se ven. Una columna «oculta» con `opacity: 0` o `visibility`
    // mal elegida seguiría anunciándose a un lector de pantalla y este aserto la vería.
    await expect(tabla.getByRole('columnheader')).toHaveCount(10);
    // El mismo hecho por el otro camino, con un selector CSS que SÍ encuentra los nodos ocultos: sin
    // esta línea, un encabezado borrado del DOM daría el mismo 10 de arriba.
    for (const b of ['Estado en la fuente', 'Origen', 'Registrado', 'Inactivado']) {
      const th = page.locator('table thead th').filter({ hasText: new RegExp(`^${b}$`) });
      await expect(th).toHaveCount(1);
      await expect(th).toBeHidden();
    }
    // «Tipo» es de nivel A: se ve en los DOS anchos. Es la columna que dice qué es la fila, y a
    // 1279 px —un portátil de 13"— es cuando más falta hace.
    await expect(tabla.getByRole('columnheader', { name: 'Tipo', exact: true })).toBeVisible();
    await expect(tabla.getByRole('columnheader', { name: 'Monitoreo', exact: true })).toBeVisible();
  });

  /**
   * El esqueleto y la tabla llena, medidos EN LA MISMA CORRIDA y comparados entre sí: el número no
   * se escribe a mano en ninguno de los dos lados, así que el test sigue siendo cierto el día que la
   * tabla gane o pierda una columna. Lo que afirma es la ausencia del SALTO.
   */
  for (const ancho of [ANCHO.xl, ANCHO.previo]) {
    test(`a ${ancho} px el esqueleto tiene las MISMAS columnas que la tabla llena`, async ({ page }) => {
      await page.setViewportSize({ width: ancho, height: 900 });
      await loginAs(page, OPERACIONES_USER);
      await mockCatalogos(page);

      // La respuesta del listado con «Inactivos» se retiene: mientras tanto en pantalla está el
      // esqueleto, ya con el filtro puesto —que es lo que hace existir la columna condicional—.
      let soltar: (() => void) | null = null;
      const retenida = new Promise<void>((resolve) => { soltar = resolve; });
      await page.route(API_REGISTROS, async (route) => {
        const inactivos = new URL(route.request().url()).searchParams.get('estado') === 'inactivo';
        if (inactivos) await retenida;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ items: inactivos ? [FILA_SIMIT] : [], nextCursor: null }),
        });
      });

      await page.goto('/flito/comparendos');
      await boton(page, 'Inactivos').click();

      const cargando = page.getByRole('status', { name: 'Cargando comparendos' });
      await expect(cargando).toBeVisible();
      const delEsqueleto = await cargando.getByRole('columnheader').count();
      // Este es el defecto que la HU arregla: el esqueleto pintaba nueve cabeceras en duro y ni una
      // de nivel B, así que a ≥1280 px el encabezado SALTABA de nueve a trece en cuanto llegaban los
      // datos — justo el salto que el esqueleto existe para evitar.
      expect(delEsqueleto).toBe(ancho === ANCHO.xl ? 14 : 10);
      // Y cada fila fantasma trae tantas celdas visibles como cabeceras visibles: una columna nueva
      // no puede dejar el esqueleto con una celda de menos y las filas desalineadas.
      const celdas = await cargando.locator('tbody tr').first().locator('td:visible').count();
      expect(celdas).toBe(delEsqueleto);

      soltar?.();
      await expect(page.getByText(FILA_SIMIT.numeroComparendo)).toBeVisible();
      await expect(cargando).toHaveCount(0);
      const deLaTabla = await page.getByRole('table').getByRole('columnheader').count();
      expect(deLaTabla, `el encabezado saltó al llegar los datos (${ancho} px)`).toBe(delEsqueleto);
    });
  }
});
