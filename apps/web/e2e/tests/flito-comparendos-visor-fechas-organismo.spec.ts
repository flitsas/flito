// FLITO — Comparendos: las dos celdas rotuladas de la tabla (HU #11795, AC1..AC5).
//
// La HU mete DOS datos en la tabla y no mete NI UNA columna: «Fecha» pasa a «Fechas» con las dos
// fechas del comparendo rotuladas dentro de la misma celda, y «Municipio» pasa a «Municipio u
// organismo» y muestra el organismo —diciendo que lo es— en las filas cuyo `municipioFuente` es
// `null`. Los dos cambios son el MISMO defecto dos veces: el dato existía, estaba persistido, viajaba
// en el contrato de la lista, y la tabla no lo enseñaba.
//
// ── Lo que este archivo tiene que probar y por qué es fácil probarlo mal ─────────────────────────
// Los dos datos **ya se veían en el panel de detalle antes de esta HU**, así que una aserción sobre
// el panel no demuestra nada del AC3: estaría verde sin el cambio. Todo lo que afirma el AC3 se
// afirma aquí sobre la CELDA de la tabla, localizada por el nombre de su cabecera.
//
// Y las aserciones son sobre los RÓTULOS tanto como sobre los valores. Es la diferencia entre esta
// HU y no hacer nada: «Medellin» ya podría aparecer en una celda por accidente; lo que la enmienda
// exige es que la celda diga CUÁL de los dos datos está enseñando. Un test que solo mire el valor
// pasa con una implementación que funda los dos en silencio, que es justo lo prohibido.
//
// Los datos son SINTÉTICOS. «Medellin», «Bogota D.C.» y «STRIA DE TTOyTTE MEDELLIN» son las tres
// FORMAS de cadena que las dos fuentes producen —medidas en payloads reales el 24 ago—, no valores
// de ningún cliente: un organismo de tránsito es una entidad pública, no un dato personal. Ni un
// NIT ni una placa reales entran en un spec (Ley 1581).
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';

const API_REGISTROS = '**/api/flito/comparendos/registros**';
const API_MUNICIPIOS = '**/api/flito/comparendos/municipios';
const API_CAUSALES = '**/api/flito/comparendos/causales';
const API_NITS = '**/api/flito/comparendos/nits';

const CAUSAL_ID = '453cc851-646e-4001-b936-6abe0b7a0570';

const BASE = {
  nitMonitoreado: '900123456',
  placa: 'ABC123',
  codigoInfraccion: 'C29',
  descripcionInfraccion: 'Estacionar en zona prohibida',
  fechaComparendo: '2026-07-12',
  fechaNotificacion: '2026-08-03',
  organismo: null as string | null,
  municipioFuente: null as string | null,
  monto: '604100.00',
  estadoFuente: 'EN COBRO COACTIVO',
  tipoRegistro: 'comparendo',
  numeroResolucion: null,
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

/**
 * Fila MUNICIPAL: tiene los DOS campos a la vez, y esa es toda su razón de ser.
 *
 * Con `municipioFuente` puesto la celda enseña el municipio traducido por el catálogo y NO el
 * organismo. Si faltara el organismo en este fixture, la aserción «la celda no contiene STRIA» sería
 * cierta sin el cambio y no probaría nada: es el mutante «pintar los dos ya que están» el que este
 * fixture existe para cazar.
 *
 * El organismo es aquí el nombre de la SECRETARÍA —lo que manda el UTS municipal en
 * `estadoCuenta.secretaria.nombreAutoridadTransito`—, que es una clase de cadena distinta de la que
 * manda SIMIT y no mide lo mismo.
 */
const FILA_MUNICIPAL = {
  ...BASE,
  id: '11111111-1111-4111-8111-111111111111',
  numeroComparendo: '05001000111111',
  municipioFuente: 'MEDELLIN',
  organismo: 'STRIA DE TTOyTTE MEDELLIN',
};

/**
 * Fila de SIMIT: `municipioFuente` `null` —por construcción, lo escribe el sync con el código de la
 * consulta municipal y aquí no hubo ninguna— y `organismo` poblado.
 *
 * Es LA fila del defecto: enseñaba «—» teniendo el dato guardado en la misma fila del contrato. En
 * SIMIT el `organismoTransito` es en la práctica el nombre del municipio, **sin tilde**.
 */
const FILA_SIMIT_MEDELLIN = {
  ...BASE,
  id: '22222222-2222-4222-8222-222222222222',
  numeroComparendo: '05001000222222',
  municipioFuente: null,
  organismo: 'Medellin',
  // Sin notificar: el centinela `01/01/1900` de SIMIT llega como `null` desde el mapa v4 (#11794).
  fechaNotificacion: null,
};

/** El otro valor medido: con punto, sin tilde y con la abreviatura tal cual. */
const FILA_SIMIT_BOGOTA = {
  ...BASE,
  id: '33333333-3333-4333-8333-333333333333',
  numeroComparendo: '11001000333333',
  municipioFuente: null,
  organismo: 'Bogota D.C.',
};

/** Ni uno ni otro. Es el único caso en el que la celda vuelve a ser un «—» pelado. */
const FILA_SIN_LUGAR = {
  ...BASE,
  id: '44444444-4444-4444-8444-444444444444',
  numeroComparendo: '11001000444444',
  municipioFuente: null,
  organismo: null,
};

/** Municipal con el catálogo caído: el código crudo, con su rótulo, y la tabla se pinta igual. */
const FILA_ITAGUI = {
  ...BASE,
  id: '55555555-5555-4555-8555-555555555555',
  numeroComparendo: '05360000555555',
  municipioFuente: 'ITAGUI',
  organismo: 'STRIA DE TTOyTTE ITAGUI',
};

/** Las dos fechas en `null`: dos líneas, dos guiones y la fila conserva sus celdas. */
const FILA_SIN_FECHAS = {
  ...BASE,
  id: '66666666-6666-4666-8666-666666666666',
  numeroComparendo: '11001000666666',
  fechaComparendo: null,
  fechaNotificacion: null,
  municipioFuente: null,
  organismo: 'Medellin',
};

/**
 * El PEOR CASO del contrato: `organismo` es `varchar(120)` y estos son 120 caracteres de la letra
 * más ancha del alfabeto, sin un solo espacio donde partir.
 *
 * Es legal en la base y es el que fija la altura del airbag. Se mide EN EL NAVEGADOR —`scrollWidth`
 * contra `clientWidth` y `scrollHeight` contra `clientHeight`—, no a ojo: es la misma exigencia que
 * la HU #11777 impuso a «Estado en la fuente», donde la cuenta a ojo daba tres líneas y la medida
 * daba cinco.
 */
const ORGANISMO_PEOR_CASO = 'W'.repeat(120);

const FILA_ORGANISMO_LARGO = {
  ...BASE,
  id: '77777777-7777-4777-8777-777777777777',
  numeroComparendo: '11001000777777',
  municipioFuente: null,
  organismo: ORGANISMO_PEOR_CASO,
};

const MUNICIPIOS = [
  { id: 'm1', codigoFuente: 'MEDELLIN', nombre: 'Medellín', activo: true, creadoEn: '', actualizadoEn: '' },
  { id: 'm2', codigoFuente: 'ITAGUI', nombre: 'Itagüí', activo: true, creadoEn: '', actualizadoEn: '' },
];

interface Traza {
  /** `${método} ${pathname}${search}` de cada petición al listado. */
  peticiones: string[];
  items: unknown[];
}

/**
 * Mock del listado que **filtra como el backend**: igualdad exacta contra `municipioFuente`, y nada
 * más. Es lo que hace honesto al AC4.
 *
 * Un mock que devolviera siempre la página entera dejaría el test del filtro en verde con cualquier
 * implementación, incluida una que sí «arreglara» la consecuencia contraintuitiva. Aquí la fila de
 * SIMIT con organismo «Medellin» ESTÁ en el conjunto y el filtro por MEDELLIN no la devuelve, que
 * es exactamente lo que el AC4 afirma y lo que RN-36 y el índice de la 0153 sostienen.
 */
async function mockListado(page: Page, items: unknown[]): Promise<Traza> {
  const traza: Traza = { peticiones: [], items };
  await page.route(API_REGISTROS, (route: Route) => {
    const url = new URL(route.request().url());
    traza.peticiones.push(`${route.request().method()} ${url.pathname}${url.search}`);
    const municipio = url.searchParams.get('municipio');
    // `q` es fragmento sobre el número, `municipio` es igualdad exacta contra `municipioFuente`.
    // Los DOS hacen falta: el AC4 necesita otro filtro que también vacíe la lista para probar que
    // la frase de SIMIT es CONDICIONADA y no incondicional.
    const q = url.searchParams.get('q');
    const filtrados = traza.items.filter((i) => {
      const fila = i as { municipioFuente: string | null; numeroComparendo: string };
      if (municipio && fila.municipioFuente !== municipio) return false;
      if (q && !fila.numeroComparendo.includes(q)) return false;
      return true;
    });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: filtrados, nextCursor: null }),
    });
  });
  return traza;
}

async function mockCatalogos(page: Page, municipiosOk = true) {
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(API_MUNICIPIOS, (r) => (municipiosOk
    ? r.fulfill(json(MUNICIPIOS))
    : r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' })));
  await page.route(API_CAUSALES, (r) => r.fulfill(json([
    { id: CAUSAL_ID, nombre: 'Registrado', activo: true, orden: 1, creadoEn: '', actualizadoEn: '' },
  ])));
  await page.route(API_NITS, (r) => r.fulfill(json([])));
}

/**
 * La celda de una columna, por el NOMBRE de su cabecera y no por una posición escrita a mano.
 *
 * Mismo helper que el spec de la HU #11713, y por el mismo motivo: un `td:nth-child(7)` se queda en
 * verde cuando alguien mueve la columna, porque sigue leyendo «la séptima celda», que ya es otra
 * cosa. Los `th` se cuentan con un selector CSS y no por rol: por debajo de 1280 px los de nivel B
 * están en el DOM pero fuera del árbol accesible, y el índice tiene que ser el mismo en los dos
 * anchos porque los `td` de nivel B tampoco desaparecen del DOM.
 */
async function celdaDe(page: Page, textoDeFila: string, cabecera: string) {
  const cabeceras = await page.locator('table thead th').allTextContents();
  const indice = cabeceras.findIndex((t) => t.trim() === cabecera);
  expect(indice, `no existe la columna «${cabecera}»`).toBeGreaterThanOrEqual(0);
  return page.getByRole('row').filter({ hasText: textoDeFila }).locator('td').nth(indice);
}

const TH_FECHAS = 'Fechas';
const TH_LUGAR = 'Municipio u organismo';

const celdaFechas = (page: Page, fila: string) => celdaDe(page, fila, TH_FECHAS);
const celdaLugar = (page: Page, fila: string) => celdaDe(page, fila, TH_LUGAR);

async function abrirVisor(page: Page, items: unknown[], municipiosOk = true) {
  await loginAs(page, OPERACIONES_USER);
  await mockCatalogos(page, municipiosOk);
  const traza = await mockListado(page, items);
  await page.goto('/flito/comparendos');
  await expect(page.getByRole('table')).toBeVisible();
  return traza;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// AC1 — la tabla trae las dos fechas, nombradas, en UNA sola columna
// ═════════════════════════════════════════════════════════════════════════════════════════════════

test.describe('FLITO — Comparendos · AC1 · la celda «Fechas» (HU #11795)', () => {
  test.use({ viewport: { width: 1600, height: 900 } });

  test('AC1 — la cabecera es «Fechas»; NINGUNA columna se llama solo «Fecha»', async ({ page }) => {
    await abrirVisor(page, [FILA_MUNICIPAL]);
    const tabla = page.getByRole('table');

    await expect(tabla.getByRole('columnheader', { name: TH_FECHAS, exact: true })).toBeVisible();
    // `exact: true` NO es cosmético aquí y es la nota 1 de QA: «Fechas» CONTIENE «Fecha», así que un
    // `contains` daría verde con la cabecera vieja intacta y este aserto no valdría nada.
    await expect(tabla.getByRole('columnheader', { name: 'Fecha', exact: true })).toHaveCount(0);
    // Por el otro camino, con un selector CSS que también ve los `th` fuera del árbol accesible: sin
    // esta línea, una cabecera oculta con `Fecha` seguiría anunciándose en algún modo de lectura.
    await expect(page.locator('table thead th').filter({ hasText: /^Fecha$/ })).toHaveCount(0);
  });

  test('AC1 — comparendo y notificación se distinguen POR NOMBRE, en dos líneas de la misma celda', async ({ page }) => {
    await abrirVisor(page, [FILA_MUNICIPAL]);
    const celda = await celdaFechas(page, FILA_MUNICIPAL.numeroComparendo);

    // Los DOS rótulos son texto real en el DOM: ni `title` ni `sr-only`. Quien ve la pantalla tiene
    // exactamente el mismo problema de ambigüedad que quien la escucha.
    await expect(celda).toContainText('Comparendo');
    await expect(celda).toContainText('Notificación');
    // Y los dos valores, cada uno con su rótulo delante. Se afirma el PAR completo, no los cuatro
    // fragmentos sueltos: «12 de jul» y «Notificación» en la misma celda serían ciertos también con
    // los dos valores cambiados de sitio.
    await expect(celda).toHaveText(/Comparendo\s*12 de jul(\.)? de 2026\s*Notificación\s*3 de ago(\.)? de 2026/);

    // Dos líneas, no una: los rótulos no comparten línea con el valor de la otra fecha.
    const alturas = await celda.evaluate((td) => {
      const cajas = [...td.querySelectorAll('span')].map((s) => s.getBoundingClientRect().top);
      return [...new Set(cajas.map((t) => Math.round(t)))].length;
    });
    expect(alturas, 'las dos fechas comparten línea').toBeGreaterThanOrEqual(2);
  });

  test('AC1 — `fechaNotificacion: null` deja el RÓTULO y pinta «—»; nunca 1900 y nunca la del comparendo', async ({ page }) => {
    await abrirVisor(page, [FILA_SIMIT_MEDELLIN]);
    const celda = await celdaFechas(page, FILA_SIMIT_MEDELLIN.numeroComparendo);

    // LA aserción que muerde (nota 3 de QA). Una implementación que oculte la línea cuando no hay
    // dato pasa cualquier test que solo mire el valor, y deja filas de distinto alto en la misma
    // tabla: se leería como un fallo de pintado y no como una ausencia.
    await expect(celda).toContainText('Notificación');
    await expect(celda).toHaveText(/Notificación\s*—/);
    // El guion lleva su `sr-only`: un guion solo se lee como un guion, o no se lee.
    await expect(celda.getByText('Sin dato')).toHaveCount(1);

    // **Nunca aproximada con `fechaComparendo`.** La fila tiene fecha de comparendo —«12 de jul»— y
    // ese texto tiene que salir UNA sola vez: si saliera dos, la notificación se estaría deduciendo.
    expect((await celda.innerText()).split('12 de jul').length - 1,
      'la notificación se aproximó con la fecha del comparendo').toBe(1);
    // Y el centinela de SIMIT no se ve en ninguna de sus formas: lo normaliza el mapa v4 (#11794) en
    // UN solo sitio, y el visor no lo vuelve a filtrar a propósito.
    const fila = page.getByRole('row').filter({ hasText: FILA_SIMIT_MEDELLIN.numeroComparendo });
    await expect(fila).not.toContainText('1900');
  });

  test('AC1 — las DOS en `null`: dos líneas, dos «—» y la fila conserva sus celdas', async ({ page }) => {
    await abrirVisor(page, [FILA_MUNICIPAL, FILA_SIN_FECHAS]);
    const celda = await celdaFechas(page, FILA_SIN_FECHAS.numeroComparendo);

    // NO se colapsa a un solo guion: la celda mantiene su forma para que el ojo compare filas por
    // posición, y los dos rótulos siguen ahí porque se sabe QUÉ falta en cada línea.
    // Los «Sin dato» del `sr-only` forman parte del texto de la celda, y se afirman EN SU SITIO:
    // cada guion lleva el suyo, no hay uno solo al final que cubra a los dos.
    await expect(celda).toHaveText(/^Comparendo\s*—\s*Sin dato\s*Notificación\s*—\s*Sin dato$/);
    await expect(celda.getByText('Sin dato')).toHaveCount(2);

    // Y la fila tiene tantas celdas como la que sí trae las dos fechas.
    const celdas = async (numero: string) => page.getByRole('row')
      .filter({ hasText: numero }).locator('td').count();
    expect(await celdas(FILA_SIN_FECHAS.numeroComparendo))
      .toBe(await celdas(FILA_MUNICIPAL.numeroComparendo));
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// AC3 — la tabla dice DÓNDE fue también en las filas de SIMIT
// ═════════════════════════════════════════════════════════════════════════════════════════════════

test.describe('FLITO — Comparendos · AC3 · la celda «Municipio u organismo» (HU #11795)', () => {
  test.use({ viewport: { width: 1600, height: 900 } });

  test('AC3 — la cabecera es «Municipio u organismo»; ni «Municipio» ni «Organismo» sueltas', async ({ page }) => {
    await abrirVisor(page, [FILA_MUNICIPAL]);
    const tabla = page.getByRole('table');

    await expect(tabla.getByRole('columnheader', { name: TH_LUGAR, exact: true })).toBeVisible();
    // Texto exacto, no `contains` (nota 10): «Municipio u organismo» contiene «Municipio».
    await expect(tabla.getByRole('columnheader', { name: 'Municipio', exact: true })).toHaveCount(0);
    await expect(page.locator('table thead th').filter({ hasText: /^Municipio$/ })).toHaveCount(0);
    // Y la columna «Organismo» separada NO vuelve: sería la quince y reabriría la decisión de la
    // #11713. Lo que entra no es una columna, es un rótulo dentro de una celda que ya existía.
    await expect(tabla.getByRole('columnheader', { name: 'Organismo', exact: true })).toHaveCount(0);
    await expect(page.locator('table thead th').filter({ hasText: /^Organismo$/ })).toHaveCount(0);

    // El `caption` gana la frase que ninguna cabecera de tres palabras puede dar.
    await expect(page.locator('table caption'))
      .toContainText('cuando el comparendo solo lo reportó SIMIT, la celda muestra el organismo');
  });

  test('AC3 — la fila MUNICIPAL enseña su municipio traducido, rotulado, y NO el organismo', async ({ page }) => {
    await abrirVisor(page, [FILA_MUNICIPAL]);
    const celda = await celdaLugar(page, FILA_MUNICIPAL.numeroComparendo);

    // Rótulo SIEMPRE, también en el caso común: si solo se rotulara el de SIMIT, un valor desnudo
    // significaría «municipio» por omisión, que es fundir los dos rótulos por la puerta de atrás.
    await expect(celda).toHaveText(/^Municipio\s*Medellín$/);
    // El mutante «pintar los dos ya que están». `STRIA` solo puede venir del organismo de ESTA fila:
    // si aparece, la celda está reponiendo la columna que la #11713 retiró, dentro de otra celda.
    await expect(celda).not.toContainText('STRIA');
    await expect(celda).not.toContainText('Organismo');
  });

  test('AC3 — la fila de SOLO SIMIT enseña el organismo TAL CUAL, rotulado «Organismo», y ya no «—»', async ({ page }) => {
    await abrirVisor(page, [FILA_SIMIT_MEDELLIN, FILA_SIMIT_BOGOTA]);

    const medellin = await celdaLugar(page, FILA_SIMIT_MEDELLIN.numeroComparendo);
    // El rótulo cambia y el valor NO se maquilla: «Medellin» sin tilde, que es lo que dijo la
    // fuente y lo que el operador puede tener que citarle al organismo. Ni traducido por el catálogo
    // —que tiene 'MEDELLIN' → 'Medellín' cargado en este mismo test—, ni capitalizado, ni convertido
    // en municipio. `toHaveText` con anclas: un `contains` de «Medellin» pasaría con «Medellín».
    await expect(medellin).toHaveText(/^Organismo\s*Medellin$/);
    // El defecto original, cerrado por los dos caminos que fallan por separado.
    await expect(medellin).not.toContainText('—');
    await expect(medellin).not.toContainText('Municipio');

    // El otro valor medido, con su punto y sin su tilde.
    const bogota = await celdaLugar(page, FILA_SIMIT_BOGOTA.numeroComparendo);
    await expect(bogota).toHaveText(/^Organismo\s*Bogota D\.C\.$/);
  });

  test('AC3 — sin ninguno de los dos, un «—» SIN rótulo, con su «Sin dato»', async ({ page }) => {
    await abrirVisor(page, [FILA_SIN_LUGAR]);
    const celda = await celdaLugar(page, FILA_SIN_LUGAR.numeroComparendo);

    // Aquí SÍ se diferencia de la celda «Fechas», a propósito: allí hay dos ranuras que siempre
    // existen y se sabe qué falta; aquí no se sabe cuál de los dos falta, y escribir «Municipio —»
    // afirmaría una categoría que nadie puede afirmar. La cabecera ya cubre la celda.
    await expect(celda).toHaveText('—Sin dato');
    await expect(celda).not.toContainText('Municipio');
    await expect(celda).not.toContainText('Organismo');
    await expect(celda.getByText('Sin dato')).toHaveCount(1);
  });

  test('AC3 — con el catálogo de municipios CAÍDO se pinta el código crudo, con rótulo, y la tabla se pinta', async ({ page }) => {
    await abrirVisor(page, [FILA_ITAGUI, FILA_SIMIT_MEDELLIN], false);

    // La nota 35 vigente, con el rótulo añadido: «ITAGUI» sigue siendo cierto, y el rótulo sigue
    // diciendo que es un municipio y no un organismo.
    const itagui = await celdaLugar(page, FILA_ITAGUI.numeroComparendo);
    await expect(itagui).toHaveText(/^Municipio\s*ITAGUI$/);
    await expect(itagui).not.toContainText('STRIA');
    // La fila de SIMIT no depende del catálogo para nada y se pinta igual.
    const simit = await celdaLugar(page, FILA_SIMIT_MEDELLIN.numeroComparendo);
    await expect(simit).toHaveText(/^Organismo\s*Medellin$/);
  });

  test('AC3 — un organismo de 120 caracteres se lee ENTERO: ni cortado en horizontal ni por el clamp', async ({ page }) => {
    expect(ORGANISMO_PEOR_CASO, '`organismo` es varchar(120): el peor caso son 120 caracteres')
      .toHaveLength(120);
    await abrirVisor(page, [FILA_ORGANISMO_LARGO]);

    const celda = await celdaLugar(page, FILA_ORGANISMO_LARGO.numeroComparendo);
    const valor = celda.locator('span').last();
    // Medido EN EL NAVEGADOR, que es la exigencia que dejó la #11777: la cuenta a ojo de aquella HU
    // daba tres líneas donde la medida daba cinco, y un `line-clamp` calculado habría recortado un
    // dato legal dejando el AC en falso sin que nadie se enterara.
    const m = await valor.evaluate((el) => ({
      alto: el.clientHeight,
      altoReal: el.scrollHeight,
      ancho: el.clientWidth,
      anchoReal: el.scrollWidth,
      lineas: getComputedStyle(el).webkitLineClamp,
    }));
    // `wrap-anywhere` es lo que impide que 120 caracteres sin un espacio se salgan de la caja y los
    // corte EN HORIZONTAL el `overflow: hidden` del clamp — el mismo defecto de lado y aún más
    // callado. Con `break-words` esto se rompe.
    expect(m.anchoReal, 'el organismo quedó cortado en horizontal').toBeLessThanOrEqual(m.ancho + 1);
    // Y el airbag no ACTÚA dentro del contrato: existe para que ampliar la columna en la base no
    // convierta una fila en veinte líneas, no para recortar lo que la base sí admite hoy.
    expect(m.altoReal, 'el `line-clamp` recortó un organismo que cabe en varchar(120)')
      .toBeLessThanOrEqual(m.alto);
    // El clamp existe: sin él, la comprobación de arriba sería trivialmente cierta para siempre.
    expect(Number(m.lineas), 'el `line-clamp` de airbag no llegó al CSS').toBeGreaterThan(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// AC4 — el filtro por municipio NO cambia (negativo, y contraintuitivo a propósito)
// ═════════════════════════════════════════════════════════════════════════════════════════════════

test.describe('FLITO — Comparendos · AC4 · el filtro sigue siendo de `municipioFuente` (HU #11795)', () => {
  test.use({ viewport: { width: 1600, height: 900 } });

  const selMunicipio = (page: Page) => page.getByLabel('Municipio', { exact: true });

  test('AC4 — la fila de SIMIT que dice «Medellin» NO sale al filtrar por MEDELLIN', async ({ page }) => {
    // Las dos filas dicen «Medellín»/«Medellin» en la celda, y solo una tiene municipio consultado.
    const traza = await abrirVisor(page, [FILA_MUNICIPAL, FILA_SIMIT_MEDELLIN]);
    // El fixture SÍ tiene la fila que no debe salir, y se ve antes de filtrar: sin esta línea el
    // test pasaría porque no hubiera ninguna, que es la trampa clásica de un negativo.
    await expect(await celdaLugar(page, FILA_SIMIT_MEDELLIN.numeroComparendo))
      .toHaveText(/^Organismo\s*Medellin$/);

    await selMunicipio(page).selectOption('MEDELLIN');
    await expect(page.getByText(FILA_MUNICIPAL.numeroComparendo)).toBeVisible();

    // La consecuencia declarada en la enmienda §13: es correcto —esa fila no tiene municipio
    // consultado, tiene un organismo que lo menciona— y va a llegar reportada como defecto.
    await expect(page.getByText(FILA_SIMIT_MEDELLIN.numeroComparendo)).toHaveCount(0);

    // Y la petición NO manda nada nuevo: el esquema del backend es `.strict()`, así que un parámetro
    // de más no es un filtro más ancho, es un 400. Se afirma sobre el conjunto EXACTO de claves.
    const ultima = traza.peticiones[traza.peticiones.length - 1];
    expect(ultima).toBe('GET /api/flito/comparendos/registros?municipio=MEDELLIN');
    const claves = [...new URL(`http://x${ultima.split(' ')[1]}`).searchParams.keys()];
    expect(claves.sort(), 'la petición ganó un parámetro que el backend no acepta').toEqual(['municipio']);

    // La fila que sí salió sigue rotulada como municipio: no se dedujo nada por el camino.
    await expect(await celdaLugar(page, FILA_MUNICIPAL.numeroComparendo))
      .toHaveText(/^Municipio\s*Medellín$/);
  });

  test('AC4 — el texto de ayuda del filtro está SIEMPRE visible, no solo tras un vacío', async ({ page }) => {
    await abrirVisor(page, [FILA_MUNICIPAL, FILA_SIMIT_MEDELLIN]);

    // Con resultados en pantalla y sin haber tocado nada: la pantalla lo dice ANTES del reporte.
    const ayuda = page.getByText(/Los comparendos que solo reportó SIMIT no tienen municipio y no salen aquí/);
    await expect(ayuda).toBeVisible();
    // Y enlazado al control, que es lo que hace que un lector lo anuncie al llegar al `select`.
    const descrito = await selMunicipio(page).getAttribute('aria-describedby');
    expect(descrito, 'la ayuda no está enlazada con `aria-describedby`').toBeTruthy();
    // Selector por atributo y no `#id`: los `id` de `useId` llevan dos puntos («:r3:») y en un
    // selector CSS eso no es un identificador.
    await expect(page.locator(`[id="${descrito}"]`)).toContainText('aunque su organismo lo mencione');
  });

  test('AC4 — el Vacío B avisa de las filas de SIMIT, y SOLO con el filtro de municipio puesto', async ({ page }) => {
    // Sin ninguna fila municipal: filtrar por MEDELLIN deja el listado en cero.
    await abrirVisor(page, [FILA_SIMIT_MEDELLIN]);
    const frase = page.getByText(/Los comparendos que solo reportó SIMIT no tienen municipio, así que no aparecen con este filtro/);

    // Antes de filtrar no hay vacío y la frase del vacío no está.
    await expect(frase).toHaveCount(0);

    await selMunicipio(page).selectOption('MEDELLIN');
    // Dos nodos: el `sr-only` con `aria-live` que lo ANUNCIA y el del bloque que se ve. Que sean dos
    // es parte del vacío B tal como lo dejó la HU #11637, y por eso se afirma la cuenta.
    await expect(page.getByText('Ningún comparendo coincide con lo que buscaste')).toHaveCount(2);
    await expect(frase).toBeVisible();

    // Y con OTRO filtro que también vacía la lista, la frase NO aparece: con un filtro de número,
    // hablar de municipios es ruido. Es la mitad negativa, y sin ella el aserto de arriba pasaría
    // con la frase pintada incondicionalmente.
    await selMunicipio(page).selectOption('');
    await page.getByLabel('N.º de comparendo').fill('99999999');
    await page.getByRole('button', { name: 'Buscar', exact: true }).click();
    // Dos nodos: el `sr-only` con `aria-live` que lo ANUNCIA y el del bloque que se ve. Que sean dos
    // es parte del vacío B tal como lo dejó la HU #11637, y por eso se afirma la cuenta.
    await expect(page.getByText('Ningún comparendo coincide con lo que buscaste')).toHaveCount(2);
    await expect(frase).toHaveCount(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// AC5 — densidad: CERO columnas nuevas, cero selector, cero preferencia
// ═════════════════════════════════════════════════════════════════════════════════════════════════

test.describe('FLITO — Comparendos · AC5 · la densidad no cambia (HU #11795)', () => {
  /**
   * Las catorce cabeceras, EN ORDEN y con su texto exacto.
   *
   * Se afirma la lista entera y no solo la cuenta, que es la diferencia entre este test y uno que
   * pasaría después de cambiar una columna por otra. La cuenta sola tampoco vería un renombre.
   */
  const CABECERAS = [
    'N.º comparendo', 'Tipo', 'Placa', 'NIT monitoreado', TH_FECHAS, 'Infracción', TH_LUGAR,
    'Monto', 'Monitoreo', 'Gestión',
    'Estado en la fuente', 'Origen', 'Registrado', 'Inactivado',
  ];

  test('AC5 — 14 cabeceras con «Inactivado» y 10 por debajo de 1280 px: ni las fechas ni el organismo añadieron columna', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await abrirVisor(page, [FILA_MUNICIPAL]);
    // La cuenta se hace sobre UNA tabla, y se comprueba que es una: un `page.locator('th')` suelto
    // contaría también las cabeceras de cualquier otra tabla que la página gane algún día, y este
    // test seguiría «pasando» con un número que ya no significa nada.
    await expect(page.locator('table')).toHaveCount(1);

    await page.getByRole('button', { name: 'Inactivos', exact: true }).click();
    const tabla = page.getByRole('table');
    await expect(tabla.getByRole('columnheader')).toHaveCount(14);
    expect((await page.locator('table thead th').allTextContents()).map((t) => t.trim()))
      .toEqual(CABECERAS);

    await page.setViewportSize({ width: 1279, height: 900 });
    await expect(tabla.getByRole('columnheader')).toHaveCount(10);
    // Las dos columnas de esta HU son de nivel A: se ven en los DOS anchos, que es donde más falta
    // hacen. Si alguna hubiera bajado a nivel B para «hacer sitio», esto lo vería.
    await expect(tabla.getByRole('columnheader', { name: TH_FECHAS, exact: true })).toBeVisible();
    await expect(tabla.getByRole('columnheader', { name: TH_LUGAR, exact: true })).toBeVisible();
  });

  test('AC5 — no hay selector de columnas ni preferencia persistida', async ({ page }) => {
    await abrirVisor(page, [FILA_MUNICIPAL, FILA_SIMIT_MEDELLIN]);

    // Ningún control ofrece elegir columnas, ni qué fecha ver: sería un patrón nuevo con estado por
    // usuario que ninguna otra pantalla de FLITO tiene, y dos operadores verían tablas distintas
    // discutiendo la misma fila.
    for (const patron of [/columnas?/i, /qué fecha/i, /mostrar fecha/i, /personalizar/i]) {
      await expect(page.getByRole('button', { name: patron })).toHaveCount(0);
      await expect(page.getByRole('checkbox', { name: patron })).toHaveCount(0);
    }

    // Y nada de lo que la tabla pinta se guarda: ni una clave del módulo en ninguno de los dos
    // almacenes. Se mira DESPUÉS de interactuar, que es cuando una preferencia se escribiría.
    await page.setViewportSize({ width: 1279, height: 900 });
    await page.getByRole('button', { name: 'Inactivos', exact: true }).click();
    await expect(page.getByRole('table')).toBeVisible();
    const almacenes = await page.evaluate(() => ({
      local: Object.keys(localStorage), sesion: Object.keys(sessionStorage),
    }));
    for (const clave of [...almacenes.local, ...almacenes.sesion]) {
      expect(clave.toLowerCase(), `«${clave}» huele a preferencia de columnas`)
        .not.toMatch(/columna|fecha|municipio|organismo/);
    }
  });

  test('AC5 — el esqueleto lleva DOS barras en cada una de las dos celdas: la fila no crece de alto', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogos(page);

    // La respuesta se retiene: mientras tanto en pantalla está el esqueleto.
    let soltar: (() => void) | null = null;
    const retenida = new Promise<void>((resolve) => { soltar = resolve; });
    await page.route(API_REGISTROS, async (route) => {
      await retenida;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [FILA_MUNICIPAL], nextCursor: null }),
      });
    });

    await page.goto('/flito/comparendos');
    const cargando = page.getByRole('status', { name: 'Cargando comparendos' });
    await expect(cargando).toBeVisible();

    const indice = async (cabecera: string) => {
      const th = await cargando.locator('thead th').allTextContents();
      return th.findIndex((t) => t.trim() === cabecera);
    };
    const primeraFila = cargando.locator('tbody tr').first();
    // DOS barras y no una: con una sola, la fila CRECE de alto al llegar los datos, que es el mismo
    // defecto que la #11713 corrigió en las cabeceras y el que el esqueleto existe para evitar.
    for (const cabecera of [TH_FECHAS, TH_LUGAR]) {
      const i = await indice(cabecera);
      expect(i, `el esqueleto no tiene la columna «${cabecera}»`).toBeGreaterThanOrEqual(0);
      await expect(primeraFila.locator('td').nth(i).locator('div'),
        `«${cabecera}» tiene que llevar dos barras`).toHaveCount(2);
    }
    // Y una columna de una sola línea sigue con UNA: sin esto, «dos barras en todas» pasaría.
    await expect(primeraFila.locator('td').nth(await indice('Placa')).locator('div')).toHaveCount(1);

    // El alto de la fila fantasma y el de la fila con datos no se separan más que un pelo. No se
    // exige igualdad exacta —una barra de 16 px no es una línea de texto de 20— sino que el salto
    // deje de ser el de antes, que era una celda de una línea contra una de dos.
    const altoFantasma = (await primeraFila.boundingBox())?.height ?? 0;
    soltar?.();
    await expect(page.getByText(FILA_MUNICIPAL.numeroComparendo)).toBeVisible();
    const altoReal = (await page.getByRole('row')
      .filter({ hasText: FILA_MUNICIPAL.numeroComparendo }).boundingBox())?.height ?? 0;
    expect(Math.abs(altoReal - altoFantasma),
      `la fila saltó de ${altoFantasma} a ${altoReal} px al llegar los datos`).toBeLessThanOrEqual(8);
  });
});
