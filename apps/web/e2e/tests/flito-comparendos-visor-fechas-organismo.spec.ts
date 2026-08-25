// FLITO — Comparendos: las dos celdas de la tabla que llevan más de un dato dentro.
//
//   · «Fechas» (HU #11795): las dos fechas del comparendo, ROTULADAS, en una sola celda.
//   · «Municipio» (HU #11879): un solo dato, SIN rótulo, con el organismo de respaldo.
//
// ── Lo que cambió el 25 ago, y por qué este archivo se reescribió a la mitad ─────────────────────
// La HU #11795 dejó una columna llamada «Municipio u organismo» cuya celda ROTULABA cuál de los dos
// datos traía. Era la única salida honesta mientras el dato de la tabla fuera `municipioFuente` —el
// municipio al que se PREGUNTÓ, `null` en toda fila que solo vio el SIMIT—: la celda mostraba de
// verdad dos cosas distintas según la fila. La HU #11878 acabó con esa premisa publicando
// `municipioComparendo`, el municipio de donde ES el comparendo, que el SERVIDOR deriva y audita; y
// la #11879 escribe la consecuencia en pantalla: la cabecera vuelve a ser **«Municipio»**, a secas,
// y **ninguna celda rotula su contenido**.
//
// Los tests del AC3, del AC4 y del esqueleto que este archivo traía de la #11795 AFIRMABAN LO
// CONTRARIO —los rótulos «Municipio»/«Organismo» dentro de la celda, la fila de SIMIT que NO salía
// al filtrar, dos barras fantasma en esa celda—. No se dejan «por si acaso»: un test que afirma lo
// contrario de la decisión vigente no protege nada, bloquea.
//
// ── Lo que este archivo tiene que probar y por qué es fácil probarlo mal ─────────────────────────
// Los dos datos **ya se veían en el panel de detalle antes de la #11795**, así que una aserción
// sobre el panel no demuestra nada de la celda: estaría verde sin el cambio. Todo lo que se afirma
// de la celda se afirma aquí sobre la CELDA de la tabla, localizada por el nombre de su cabecera.
//
// Y las aserciones de «Municipio» miran la AUSENCIA de rótulo tanto como el valor, y sobre todo QUÉ
// campo alimenta el valor. Es lo que distingue esta HU de la anterior: la fila que solo reportó el
// SIMIT tiene `municipioFuente: null` y `municipioComparendo: 'MEDELLIN'`, así que una
// implementación que se quedara leyendo el campo viejo pintaría el organismo «Medellin» —sin
// tilde— donde tiene que decir «Medellín». Un fixture que no distinga los dos campos deja el
// archivo entero sin comprobar la HU (mutación a de las notas de QA).
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
  // Los DOS campos, siempre, en todos los fixtures y sin excepción (HU #11878): `municipioFuente`
  // es a quién se le PREGUNTÓ y `municipioComparendo` es de dónde ES el comparendo. Un fixture que
  // solo trajera uno de los dos dejaría en verde la implementación que lee el otro, que es
  // exactamente el mutante a).
  municipioFuente: null as string | null,
  municipioComparendo: null as string | null,
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
 * Fila MUNICIPAL: tiene los TRES campos a la vez, y esa es toda su razón de ser.
 *
 * Con `municipioComparendo` puesto la celda enseña el municipio traducido por el catálogo y NO el
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
  municipioComparendo: 'MEDELLIN',
  organismo: 'STRIA DE TTOyTTE MEDELLIN',
};

/**
 * **LA fila de esta HU**: solo la reportó el SIMIT y su municipio SÍ quedó resuelto.
 *
 * `municipioFuente` es `null` —por construcción: lo escribe el sync con el código de la consulta
 * municipal, y aquí no hubo ninguna— y `municipioComparendo` es `'MEDELLIN'`, que el sync dedujo del
 * texto del organismo contra el catálogo (HU #11878). La celda tiene que decir **«Medellín», CON
 * tilde**, porque viene del catálogo y no del organismo.
 *
 * Es la fila que separa la #11879 de la #11795 y la que caza el mutante a): una implementación que
 * siguiera leyendo `municipioFuente` pintaría aquí «Medellin» sin tilde —el organismo— y este
 * fixture es el único del archivo que nota la diferencia.
 */
const FILA_SIMIT_MEDELLIN = {
  ...BASE,
  id: '22222222-2222-4222-8222-222222222222',
  numeroComparendo: '05001000222222',
  municipioFuente: null,
  municipioComparendo: 'MEDELLIN',
  organismo: 'Medellin',
  // Sin notificar: el centinela `01/01/1900` de SIMIT llega como `null` desde el mapa v4 (#11794).
  fechaNotificacion: null,
};

/**
 * Municipio SIN resolver: ni hubo consulta municipal ni el organismo reconoció un municipio del
 * catálogo (o reconoció dos, que es el otro camino al `null`: la ambigüedad se declara, no se
 * desempata).
 *
 * Es la rama de respaldo: la celda enseña el organismo **tal cual**, «Medellin» sin tilde, sin
 * rótulo y sin traducir. El catálogo de este spec tiene `'MEDELLIN' → 'Medellín'` cargado, así que
 * la tilde solo puede aparecer si alguien tradujo el organismo — mutación b).
 */
const FILA_SIN_MUNICIPIO = {
  ...BASE,
  id: '33333333-3333-4333-8333-333333333333',
  numeroComparendo: '11001000333333',
  municipioFuente: null,
  municipioComparendo: null,
  organismo: 'Medellin',
};

/** El otro valor medido, en la misma rama: con punto, sin tilde y con la abreviatura tal cual. */
const FILA_SIN_MUNICIPIO_BOGOTA = {
  ...BASE,
  id: '88888888-8888-4888-8888-888888888888',
  numeroComparendo: '11001000888888',
  municipioFuente: null,
  municipioComparendo: null,
  organismo: 'Bogota D.C.',
};

/** Ni uno ni otro. Es el único caso en el que la celda es un «—» pelado. */
const FILA_SIN_LUGAR = {
  ...BASE,
  id: '44444444-4444-4444-8444-444444444444',
  numeroComparendo: '11001000444444',
  municipioFuente: null,
  municipioComparendo: null,
  organismo: null,
};

/** Municipal con el catálogo caído: el código crudo, y la tabla se pinta igual. */
const FILA_ITAGUI = {
  ...BASE,
  id: '55555555-5555-4555-8555-555555555555',
  numeroComparendo: '05360000555555',
  municipioFuente: 'ITAGUI',
  municipioComparendo: 'ITAGUI',
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
  municipioComparendo: 'MEDELLIN',
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
  // Sin municipio resuelto: es la ÚNICA rama en la que el organismo se pinta, y por tanto la única
  // en la que su peor caso llega a la celda. Con el municipio puesto, este fixture no mediría nada.
  municipioComparendo: null,
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
 * Mock del listado que **filtra como el backend desde la HU #11878**: igualdad exacta contra
 * `municipioComparendo`, y nada más. Es lo que hace honesto al AC5.
 *
 * Un mock que devolviera siempre la página entera dejaría el test del filtro en verde con cualquier
 * implementación. Y uno que siguiera comparando `municipioFuente` —como hasta la #11795— dejaría el
 * AC5 en ROJO con la implementación correcta, que es la trampa contraria: la fila que solo reportó
 * el SIMIT tiene `municipioFuente: null` y `municipioComparendo: 'MEDELLIN'`, y el backend la
 * devuelve. Se compara el mismo campo que compara el servidor (RN-36 y el índice
 * `(municipio_comparendo, created_at DESC, id DESC)` de la migración 0165).
 */
async function mockListado(page: Page, items: unknown[]): Promise<Traza> {
  const traza: Traza = { peticiones: [], items };
  await page.route(API_REGISTROS, (route: Route) => {
    const url = new URL(route.request().url());
    traza.peticiones.push(`${route.request().method()} ${url.pathname}${url.search}`);
    const municipio = url.searchParams.get('municipio');
    // `q` es fragmento sobre el número, `municipio` es igualdad exacta contra `municipioComparendo`.
    // Los DOS hacen falta: el AC5 necesita otro filtro que también vacíe la lista para probar que
    // la frase del municipio sin determinar es CONDICIONADA y no incondicional.
    const q = url.searchParams.get('q');
    const filtrados = traza.items.filter((i) => {
      const fila = i as { municipioComparendo: string | null; numeroComparendo: string };
      if (municipio && fila.municipioComparendo !== municipio) return false;
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
/** Una palabra, desde la HU #11879. Se llamó «Municipio u organismo» mientras la celda rotulaba. */
const TH_MUNICIPIO = 'Municipio';

const celdaFechas = (page: Page, fila: string) => celdaDe(page, fila, TH_FECHAS);
const celdaMunicipio = (page: Page, fila: string) => celdaDe(page, fila, TH_MUNICIPIO);

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
// AC1..AC3 de la HU #11879 — una columna «Municipio», un solo dato, ningún rótulo
// ═════════════════════════════════════════════════════════════════════════════════════════════════

test.describe('FLITO — Comparendos · la celda «Municipio» (HU #11879)', () => {
  test.use({ viewport: { width: 1600, height: 900 } });

  test('AC1 — la cabecera dice «Municipio», a secas; ni «Municipio u organismo» ni «Organismo»', async ({ page }) => {
    await abrirVisor(page, [FILA_MUNICIPAL]);
    const tabla = page.getByRole('table');

    // Texto EXACTO, no `contains` (nota 1 de QA), y por los dos caminos: el rol —que es lo que oye
    // un lector— y el selector CSS, que también ve los `th` fuera del árbol accesible.
    await expect(tabla.getByRole('columnheader', { name: TH_MUNICIPIO, exact: true })).toBeVisible();
    await expect(page.locator('table thead th').filter({ hasText: /^Municipio$/ })).toHaveCount(1);
    // La cabecera de la #11795 no puede sobrevivir en ninguna forma: es la que anunciaba una
    // disyunción que ya no existe. `contains` a propósito aquí, que es lo que caza el renombre a
    // medias («Municipio u organismo de tránsito» y variantes).
    await expect(page.locator('table thead th').filter({ hasText: /organismo/i })).toHaveCount(0);
    // Y la columna «Organismo» separada NO vuelve: sería la quince y reabriría la decisión de la
    // #11713. El organismo entra como VALOR de una celda que ya existía, nunca como columna.
    await expect(tabla.getByRole('columnheader', { name: 'Organismo', exact: true })).toHaveCount(0);

    // El `caption` es lo que compensa que la celda no rotule: es el único texto que un lector
    // anuncia con seguridad al entrar en la tabla, y sirve igual a quien mira y a quien escucha.
    const caption = page.locator('table caption');
    await expect(caption).toContainText('«Municipio» es el municipio donde se impuso el comparendo');
    await expect(caption).toContainText('Cuando no se pudo determinar, la celda muestra el organismo');
    // Y la frase de la #11795, que hoy sería falsa, no está en ninguna parte de la tabla.
    await expect(caption).not.toContainText('a qué municipio se consultó');
  });

  test('AC1/AC2 — la fila MUNICIPAL enseña su municipio traducido, SIN rótulo y sin el organismo', async ({ page }) => {
    await abrirVisor(page, [FILA_MUNICIPAL]);
    const celda = await celdaMunicipio(page, FILA_MUNICIPAL.numeroComparendo);

    // El valor DESNUDO: la celda es exactamente el nombre del municipio, sin una palabra más. Con
    // anclas, que es lo que hace fallar a un rótulo repuesto (mutación c) — «Municipio Medellín» no
    // casa con esto.
    await expect(celda).toHaveText('Medellín');
    // El mutante «pintar los dos ya que están». `STRIA` solo puede venir del organismo de ESTA fila:
    // si aparece, la celda está reponiendo la columna que la #11713 retiró, dentro de otra celda.
    await expect(celda).not.toContainText('STRIA');
    await expect(celda).not.toContainText('Organismo');
    await expect(celda).not.toContainText('Municipio');
  });

  test('AC2 — la fila de SOLO SIMIT con municipio resuelto dice «Medellín», CON tilde', async ({ page }) => {
    // Nota 3 de QA y la razón de ser de la HU: `municipioFuente` es `null` —nadie le preguntó a
    // Medellín— y `municipioComparendo` es 'MEDELLIN' porque el sync lo dedujo del organismo.
    await abrirVisor(page, [FILA_SIMIT_MEDELLIN]);
    const celda = await celdaMunicipio(page, FILA_SIMIT_MEDELLIN.numeroComparendo);

    // **La tilde es la aserción.** Solo puede venir del catálogo ('MEDELLIN' → 'Medellín'), nunca
    // del organismo, que en este fixture es 'Medellin' pelado. Una implementación que leyera
    // `municipioFuente` caería aquí, y solo aquí: es la mutación a).
    await expect(celda).toHaveText('Medellín');
    // La fila se ve «igual que cualquier otra» (AC2 del work item): ni «—», ni rótulo, ni marca de
    // que su municipio sea de segunda.
    await expect(celda).not.toContainText('—');
    await expect(celda).not.toContainText('Municipio');
    await expect(celda).not.toContainText('Organismo');
  });

  test('AC3 — sin municipio resuelto: el organismo TAL CUAL, sin rótulo, sin tilde y sin «—»', async ({ page }) => {
    await abrirVisor(page, [FILA_SIN_MUNICIPIO, FILA_SIN_MUNICIPIO_BOGOTA]);

    const medellin = await celdaMunicipio(page, FILA_SIN_MUNICIPIO.numeroComparendo);
    // El valor NO se maquilla: «Medellin» SIN tilde, que es lo que dijo la fuente y lo que el
    // operador puede tener que citarle al organismo. Ni traducido por el catálogo —que tiene
    // 'MEDELLIN' → 'Medellín' cargado en este mismo test, y esa es la mutación b)—, ni capitalizado,
    // ni convertido en municipio. `toHaveText` con la cadena exacta: un `contains` de «Medellin»
    // pasaría con «Medellín», y un rótulo repuesto pasaría con cualquier `contains`.
    await expect(medellin).toHaveText('Medellin');
    // Y ni rastro de los dos rótulos ni del guion: los tres son mutaciones distintas de la misma
    // decisión, y cada una falla por su cuenta.
    await expect(medellin).not.toContainText('—');
    await expect(medellin).not.toContainText('Municipio');
    await expect(medellin).not.toContainText('Organismo');
    // Tampoco un rótulo escondido para quien escucha: sería desambiguar solo a la mitad de la
    // audiencia, que es la asimetría que la #11795 ya rechazó (con el signo contrario).
    await expect(medellin.locator('.sr-only')).toHaveCount(0);

    // El otro valor medido, con su punto y sin su tilde.
    const bogota = await celdaMunicipio(page, FILA_SIN_MUNICIPIO_BOGOTA.numeroComparendo);
    await expect(bogota).toHaveText('Bogota D.C.');
  });

  test('AC3 — el organismo NO se atenúa: va en el mismo color que un municipio', async ({ page }) => {
    // Atenuarlo con `--flit-text-muted` sería reponer el rótulo por medio del color —que además
    // ningún lector anuncia— y perder los 4.5:1: es el gris de los guiones. Se comparan las dos
    // celdas de la misma tabla, que es lo que hace la aserción independiente del tema.
    await abrirVisor(page, [FILA_MUNICIPAL, FILA_SIN_MUNICIPIO]);
    const color = async (numero: string) => (await celdaMunicipio(page, numero))
      .evaluate((td) => {
        const nodo = td.querySelector('span') ?? td;
        return getComputedStyle(nodo).color;
      });

    expect(await color(FILA_SIN_MUNICIPIO.numeroComparendo),
      'el organismo está atenuado: es el rótulo repuesto por color')
      .toBe(await color(FILA_MUNICIPAL.numeroComparendo));
  });

  test('AC3 — sin ninguno de los dos, un «—» con su «Sin dato»', async ({ page }) => {
    await abrirVisor(page, [FILA_SIN_LUGAR]);
    const celda = await celdaMunicipio(page, FILA_SIN_LUGAR.numeroComparendo);

    // El `sr-only` del guion SÍ se queda (a diferencia del rótulo): un guion suelto o se lee
    // «guion» o no se lee, y en ningún caso significa nada.
    await expect(celda).toHaveText('—Sin dato');
    await expect(celda).not.toContainText('Municipio');
    await expect(celda).not.toContainText('Organismo');
    await expect(celda.getByText('Sin dato')).toHaveCount(1);
  });

  test('AC3 — con el catálogo de municipios CAÍDO se pinta el código crudo y la tabla se pinta igual', async ({ page }) => {
    await abrirVisor(page, [FILA_ITAGUI, FILA_SIN_MUNICIPIO], false);

    // La nota 35 vigente del documento madre: «ITAGUI» sigue siendo cierto, y sigue siendo el
    // municipio del comparendo aunque nadie pueda traducirlo.
    const itagui = await celdaMunicipio(page, FILA_ITAGUI.numeroComparendo);
    await expect(itagui).toHaveText('ITAGUI');
    await expect(itagui).not.toContainText('STRIA');
    // La fila sin municipio no depende del catálogo para nada y se pinta igual.
    const sinMunicipio = await celdaMunicipio(page, FILA_SIN_MUNICIPIO.numeroComparendo);
    await expect(sinMunicipio).toHaveText('Medellin');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('AC3 — un organismo de 120 caracteres se lee ENTERO: ni cortado en horizontal ni por el clamp', async ({ page }) => {
    expect(ORGANISMO_PEOR_CASO, '`organismo` es varchar(120): el peor caso son 120 caracteres')
      .toHaveLength(120);
    await abrirVisor(page, [FILA_ORGANISMO_LARGO]);

    const celda = await celdaMunicipio(page, FILA_ORGANISMO_LARGO.numeroComparendo);
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
// AC4 — el panel no puede contradecir a su propia fila, y conserva el organismo aparte
// ═════════════════════════════════════════════════════════════════════════════════════════════════

test.describe('FLITO — Comparendos · AC4 · el detalle dice lo mismo que la fila (HU #11879)', () => {
  test.use({ viewport: { width: 1600, height: 900 } });

  /**
   * Abre el panel de una fila con el detalle mockeado.
   *
   * La ruta del detalle se registra DESPUÉS de la del listado a propósito: `API_REGISTROS` es un
   * glob que también casa con `/registros/:id`, y Playwright prueba los manejadores en orden
   * INVERSO al de registro, así que el último gana. Sin esto, el panel recibiría la página del
   * listado como si fuera un registro.
   */
  async function abrirPanel(page: Page, fila: typeof FILA_SIMIT_MEDELLIN) {
    await abrirVisor(page, [FILA_MUNICIPAL, fila]);
    await page.route(`**/api/flito/comparendos/registros/${fila.id}`, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...fila, eventos: [] }),
    }));
    await page.getByRole('button', { name: `Ver el comparendo ${fila.numeroComparendo}` }).click();
    const panel = page.getByRole('dialog');
    await expect(panel).toBeVisible();
    return panel;
  }

  test('AC4 — la fila de SIMIT resuelta dice «Medellín» en el panel, no «—», y conserva su organismo', async ({ page }) => {
    // Nota 10 de QA y §4 del anexo de UX: si esta HU solo tocara la tabla, esta fila diría
    // «Medellín» en el listado y «Municipio: —» en su propio detalle, abierto ENCIMA de la fila que
    // afirma lo contrario. El panel leía `municipioFuente`, que aquí es `null`.
    const panel = await abrirPanel(page, FILA_SIMIT_MEDELLIN);
    const dl = panel.locator('dl').first();

    // El `<dt>` «Municipio» y su valor, como PAR: afirmar «Medellín» suelto pasaría con el texto en
    // cualquier otro campo del panel.
    const municipio = dl.locator('dt').filter({ hasText: /^Municipio$/ });
    await expect(municipio).toHaveCount(1);
    await expect(municipio.locator('xpath=following-sibling::dd[1]')).toHaveText('Medellín');

    // Y el organismo sigue siendo un campo APARTE, con su rótulo y su valor tal cual: es lo que el
    // operador cita cuando reclama, y por eso no se funde con el municipio en ninguna superficie.
    const organismo = dl.locator('dt').filter({ hasText: /^Organismo$/ });
    await expect(organismo).toHaveCount(1);
    await expect(organismo.locator('xpath=following-sibling::dd[1]')).toHaveText('Medellin');

    // La línea de resumen de arriba —la del chip y el origen— dice lo mismo que el `<dl>`: son la
    // misma verdad dicha dos veces y es donde una de las dos se queda atrás.
    await expect(panel).toContainText('Municipio: Medellín');
    await expect(panel).not.toContainText('Municipio: —');
  });

  test('AC4 — sin municipio resuelto el panel dice MÁS que la tabla: «—» y el organismo entero', async ({ page }) => {
    // Aquí la tabla enseña el organismo en el lugar del municipio, sin decirlo. El panel es donde
    // esa ambigüedad se deshace, y por eso la celda no necesita rótulo.
    const panel = await abrirPanel(page, FILA_SIN_MUNICIPIO);
    const dl = panel.locator('dl').first();

    const municipio = dl.locator('dt').filter({ hasText: /^Municipio$/ });
    await expect(municipio.locator('xpath=following-sibling::dd[1]')).toContainText('—');
    const organismo = dl.locator('dt').filter({ hasText: /^Organismo$/ });
    await expect(organismo.locator('xpath=following-sibling::dd[1]')).toHaveText('Medellin');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// AC5 — lo que se ve concuerda con lo que filtra (y el copy deja de mentir)
// ═════════════════════════════════════════════════════════════════════════════════════════════════

test.describe('FLITO — Comparendos · AC5 · el filtro compara `municipioComparendo` (HU #11879)', () => {
  test.use({ viewport: { width: 1600, height: 900 } });

  // El `select` de la barra, no la cabecera de la tabla: los dos se llaman «Municipio» desde esta
  // HU, y `getByLabel` solo mira etiquetas de formulario, que es lo que los separa.
  const selMunicipio = (page: Page) => page.getByLabel('Municipio', { exact: true });

  test('AC5 — la fila que dice «Medellín» SÍ sale al filtrar por Medellín, aunque solo la reportara SIMIT', async ({ page }) => {
    // Nota 9 de QA, y la vuelta entera de la consecuencia contraintuitiva de la #11795: entonces
    // esta fila NO salía. Las dos del fixture enseñan «Medellín» y solo una tuvo consulta municipal.
    const traza = await abrirVisor(page, [FILA_MUNICIPAL, FILA_SIMIT_MEDELLIN, FILA_SIN_MUNICIPIO]);
    await expect(await celdaMunicipio(page, FILA_SIMIT_MEDELLIN.numeroComparendo)).toHaveText('Medellín');

    await selMunicipio(page).selectOption('MEDELLIN');
    await expect(page.getByText(FILA_MUNICIPAL.numeroComparendo)).toBeVisible();
    // LA aserción de esta HU: la fila de SIMIT está en el resultado.
    await expect(page.getByText(FILA_SIMIT_MEDELLIN.numeroComparendo)).toBeVisible();
    // Y el residuo sigue fuera, que es lo que la ayuda del filtro dice y lo que impide leer esto
    // como «el filtro ahora busca por texto»: esa fila enseña «Medellin» y su municipio es `null`.
    await expect(page.getByText(FILA_SIN_MUNICIPIO.numeroComparendo)).toHaveCount(0);

    // Y la petición NO manda nada nuevo: el esquema del backend es `.strict()`, así que un parámetro
    // de más no es un filtro más ancho, es un 400. Se afirma sobre el conjunto EXACTO de claves.
    const ultima = traza.peticiones[traza.peticiones.length - 1];
    expect(ultima).toBe('GET /api/flito/comparendos/registros?municipio=MEDELLIN');
    const claves = [...new URL(`http://x${ultima.split(' ')[1]}`).searchParams.keys()];
    expect(claves.sort(), 'la petición ganó un parámetro que el backend no acepta').toEqual(['municipio']);

    // Las dos filas que salieron dicen lo mismo en la celda, sin marca de cuál se preguntó: eso es
    // trazabilidad de la corrida y ya no se pinta en el SPA.
    await expect(await celdaMunicipio(page, FILA_MUNICIPAL.numeroComparendo)).toHaveText('Medellín');
    await expect(await celdaMunicipio(page, FILA_SIMIT_MEDELLIN.numeroComparendo)).toHaveText('Medellín');
  });

  test('AC5 — el texto de ayuda del filtro está SIEMPRE visible y ya no dice lo contrario', async ({ page }) => {
    await abrirVisor(page, [FILA_MUNICIPAL, FILA_SIMIT_MEDELLIN]);

    // Con resultados en pantalla y sin haber tocado nada: la ayuda es permanente, no una reacción.
    const ayuda = page.getByText(/Busca por el municipio donde se impuso el comparendo, lo haya reportado SIMIT o el municipio/);
    await expect(ayuda).toBeVisible();
    // Y enlazado al control, que es lo que hace que un lector lo anuncie al llegar al `select`.
    const descrito = await selMunicipio(page).getAttribute('aria-describedby');
    expect(descrito, 'la ayuda no está enlazada con `aria-describedby`').toBeTruthy();
    // Selector por atributo y no `#id`: los `id` de `useId` llevan dos puntos («:r3:») y en un
    // selector CSS eso no es un identificador.
    const texto = page.locator(`[id="${descrito}"]`);
    // El residuo, atado a algo VISIBLE: sin el paréntesis, quien lea «no se pudo determinar» se
    // queda sin saber qué filas son.
    await expect(texto).toContainText('cuyo municipio no se pudo determinar');
    await expect(texto).toContainText('en la tabla se les ve el organismo');
    // Y la frase de la #11795, que hoy le enseñaría al operador a no usar un filtro que funciona.
    // Se afirma por su fragmento distintivo y no entero: la cadena completa no debe existir en
    // `apps/web` ni siquiera dentro de una aserción negativa (es la comprobación del §5 del anexo).
    await expect(texto).not.toContainText('al que se le consultó');
    await expect(texto).not.toContainText('solo reportó SIMIT');
  });

  test('AC5 — el Vacío B habla del municipio SIN DETERMINAR, y solo con ese filtro puesto', async ({ page }) => {
    // Sin ninguna fila de Medellín resuelta: filtrar por MEDELLIN deja el listado en cero.
    await abrirVisor(page, [FILA_SIN_MUNICIPIO]);
    const frase = page.getByText(/puede que no se haya podido determinar de dónde son/);

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
// AC6 — densidad y esqueleto: CERO columnas nuevas, cero selector, cero preferencia
// ═════════════════════════════════════════════════════════════════════════════════════════════════

test.describe('FLITO — Comparendos · AC6 · la densidad no cambia (HU #11795, #11879)', () => {
  /**
   * Las catorce cabeceras, EN ORDEN y con su texto exacto.
   *
   * Se afirma la lista entera y no solo la cuenta, que es la diferencia entre este test y uno que
   * pasaría después de cambiar una columna por otra. La cuenta sola tampoco vería un renombre.
   */
  const CABECERAS = [
    'N.º comparendo', 'Tipo', 'Placa', 'NIT monitoreado', TH_FECHAS, 'Infracción', TH_MUNICIPIO,
    'Monto', 'Monitoreo', 'Gestión',
    'Estado en la fuente', 'Origen', 'Registrado', 'Inactivado',
  ];

  test('AC6 — 14 cabeceras con «Inactivado» y 10 por debajo de 1280 px: ni las fechas ni el organismo añadieron columna', async ({ page }) => {
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
    await expect(tabla.getByRole('columnheader', { name: TH_MUNICIPIO, exact: true })).toBeVisible();
  });

  test('AC6 — el ancho de la celda «Municipio» no se estrechó: sigue en 11 rem medidos', async ({ page }) => {
    // La HU #11879 quita un rótulo, no un ancho. Estrechar la columna «porque ahora casi siempre
    // cabe Medellín» optimizaría el caso común rompiendo el caso que la celda existe para no
    // esconder: el organismo de respaldo, que sigue admitiendo 120 caracteres.
    await page.setViewportSize({ width: 1600, height: 900 });
    await abrirVisor(page, [FILA_MUNICIPAL]);
    const valor = (await celdaMunicipio(page, FILA_MUNICIPAL.numeroComparendo)).locator('span').first();

    const caja = await valor.evaluate((el) => {
      const s = getComputedStyle(el);
      return { min: s.minWidth, max: s.maxWidth, ancho: el.clientWidth };
    });
    // Los DOS, no solo el techo: en una tabla de layout automático que ya desborda, el `max-w` solo
    // aprieta la columna contra su mínimo —que con `wrap-anywhere` es UN carácter— y el organismo
    // vuelve a cortarse en horizontal. Está medido en el documento madre.
    expect(caja.min, 'la celda perdió su `min-w`: el ancho pasa a ser un deseo').toBe('176px');
    expect(caja.max, 'la celda perdió su `max-w`').toBe('176px');
    expect(caja.ancho).toBe(176);
  });

  test('AC6 — no hay selector de columnas ni preferencia persistida', async ({ page }) => {
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

  test('AC6 — el esqueleto: DOS barras en «Fechas», UNA en «Municipio», y la fila no salta de alto', async ({ page }) => {
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
    // «Fechas» sigue con DOS barras —rótulo y valor, dos líneas—: con una sola, la fila CRECE de
    // alto al llegar los datos, que es el defecto que el esqueleto existe para evitar.
    const iFechas = await indice(TH_FECHAS);
    expect(iFechas, `el esqueleto no tiene la columna «${TH_FECHAS}»`).toBeGreaterThanOrEqual(0);
    await expect(primeraFila.locator('td').nth(iFechas).locator('div'),
      '«Fechas» tiene que llevar dos barras').toHaveCount(2);

    // Y «Municipio» pasa a UNA (HU #11879, nota 8 de QA). Es el olvido que la HU deja si nadie toca
    // `COLUMNAS_A_DE_DOS_LINEAS`: la celda ya no tiene rótulo, así que con dos barras la fila
    // fantasma queda MÁS ALTA que la fila con datos y la tabla ENCOGE al cargar — el mismo defecto
    // con el signo cambiado, y por eso no basta con mirar el alto al final.
    const iMunicipio = await indice(TH_MUNICIPIO);
    expect(iMunicipio, `el esqueleto no tiene la columna «${TH_MUNICIPIO}»`).toBeGreaterThanOrEqual(0);
    await expect(primeraFila.locator('td').nth(iMunicipio).locator('div'),
      '«Municipio» mide una línea: una sola barra').toHaveCount(1);
    // Y una columna que siempre midió una línea sigue con UNA: sin esto, «una barra en todas» —que
    // rompería «Fechas»— no se distinguiría de lo correcto.
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
