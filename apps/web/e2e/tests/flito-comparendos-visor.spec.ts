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
    for (const columna of ['N.º comparendo', 'Placa', 'NIT monitoreado', 'Fecha', 'Infracción',
      'Municipio', 'Monto', 'Estado', 'Gestión', 'Organismo', 'Origen', 'Registrado']) {
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
    await expect(fila).toContainText('Secretaría de Movilidad de Medellín');
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
    // `estadoFuente` tampoco: es texto libre del proveedor y en columna sugeriría que se filtra.
    await expect(page.getByText('EN COBRO COACTIVO')).toHaveCount(0);
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
    await expect(page.getByRole('table').getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('table').locator('caption')).toHaveClass(/sr-only/);
  });
});
