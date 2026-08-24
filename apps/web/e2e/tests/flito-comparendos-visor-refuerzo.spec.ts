// FLITO — Comparendos · visor: refuerzo de QA (HU #11560, modo B).
//
// Este archivo NO repite lo que `flito-comparendos-visor.spec.ts` ya prueba. Existe porque una
// campaña de mutación sobre esa suite dejó **cuatro mutantes vivos**, y un mutante vivo es una
// afirmación que nadie está haciendo:
//
//   · M6  — quitar la guardia de vuelo del hook (`turno !== vuelo.current`): la respuesta tardía de
//           un filtro que ya se cambió se pinta encima del filtro nuevo. 14/14 seguían verdes.
//   · M7  — `if (!n) return '—'` en `pesos`: un comparendo de CERO pesos se presenta como un dato
//           AUSENTE. `Number('0.00') === 0` es falsy y no hay ni un monto en cero en los fixtures.
//   · M8  — `Math.floor` en vez del redondeo de `maximumFractionDigits: 0`: `232100.99` sale
//           «$ 232.100». Todos los montos del fixture terminan en `.00`, así que nadie lo ve.
//   · M10 — quitar `timeZone: 'America/Bogota'` del formateador de instantes. **Este es el
//           importante**: la máquina de desarrollo está en `-05` y `playwright.config.ts` no fija
//           `timezoneId`, así que el spec hereda el huso que el AC1 quiere demostrar. Un test que
//           corre en Bogotá no puede distinguir «formatea en Colombia» de «formatea en la máquina de
//           quien mira», y en CI —que corre en UTC— la pantalla mentiría con el test en verde.
//
//           **Ojo: la HU #11562 partió esa función en dos** (`formato.ts`). La de siempre se llama
//           ahora `fechaColombia` —solo el día, la que usa la tabla— y nació una `fechaHoraColombia`
//           nueva CON hora para el panel de detalle. M10 se puede plantar en cualquiera de las dos,
//           así que aquí se cubren las dos: el bloque de Tokio de abajo tiene un caso por función. Y
//           en la mitad con hora el mutante es más grave, no menos: sin `timeZone`, un desfase que
//           en la tabla solo se nota en los instantes de madrugada desplaza TODAS las horas del
//           panel.
//
// Y cubre los TC del modo A que los tres choques resueltos por el Líder Técnico dejaron sin escribir:
// el AC6 recorrido **criterio por criterio** (el fallo real nunca es «no se reinicia», es «no se
// reinicia en UNO de los manejadores») y el cursor verbatim con la forma base64url que devuelve el
// API de verdad.
//
// Datos SINTÉTICOS (Ley 1581): «900123456» y «ABC123» son de ejemplo.
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';

const API_REGISTROS = '**/api/flito/comparendos/registros**';
const CATALOGOS = [
  '**/api/flito/comparendos/municipios',
  '**/api/flito/comparendos/causales',
  '**/api/flito/comparendos/nits',
];

/** Base de fila. Cada test cambia lo que le importa; lo demás no debe influir. */
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
  primeraVistoEn: '2026-08-17T03:12:00Z',
  ultimoVistoEn: '2026-08-18T08:07:00Z',
  inactivadoEn: null,
  ultimoSyncRunId: null,
  causalId: null,
  observacion: null,
  gestionActualizadaEn: null,
  gestionActualizadaPor: null,
  creadoEn: '2026-08-17T03:12:00Z',
  actualizadoEn: '2026-08-18T08:07:00Z',
};

interface Traza {
  peticiones: string[];
  /** El valor de `cursor` **ya decodificado una vez** por `URLSearchParams`. */
  cursores: (string | null)[];
  cuerpos: string[];
  respuesta: { status: number; body: unknown };
  porCursor: Record<string, { status: number; body: unknown }>;
  /** Si está puesta, la ruta espera a que se resuelva antes de responder. */
  retener: Promise<void> | null;
}

async function mockListado(page: Page, inicial: { status: number; body: unknown }): Promise<Traza> {
  const traza: Traza = {
    peticiones: [], cursores: [], cuerpos: [], respuesta: inicial, porCursor: {}, retener: null,
  };
  await page.route(API_REGISTROS, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    traza.peticiones.push(`${req.method()} ${url.pathname}${url.search}`);
    traza.cursores.push(url.searchParams.get('cursor'));
    if (req.method() === 'POST') traza.cuerpos.push(req.postData() ?? '');
    const espera = traza.retener;
    if (espera) await espera;
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

/** Catálogos vacíos: aquí no se prueban las etiquetas y no deben añadir ruido. */
async function mockCatalogosVacios(page: Page) {
  for (const ruta of CATALOGOS) {
    await page.route(ruta, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  }
}

const boton = (page: Page, nombre: string) => page.getByRole('button', { name: nombre, exact: true });
const campoNumero = (page: Page) => page.getByLabel('N.º de comparendo');
const campoNit = (page: Page) => page.getByLabel('NIT monitoreado');
const campoPlaca = (page: Page) => page.getByLabel('Placa');

/**
 * `es-CO` separa el símbolo con un espacio **duro** (U+00A0) y la versión de ICU decide si lo pone.
 * Comparar con un espacio normal falla o pasa según el runtime; aflojar a `/604/` haría pasar
 * también a «604100» sin formatear. Se normaliza el espacio y se afirman los invariantes del AC.
 */
const normalizar = (s: string) => s.replace(/\u00A0/g, ' ').trim();

test.describe('FLITO — Comparendos · refuerzo QA (HU #11560)', () => {
  test.use({ viewport: { width: 1600, height: 900 } });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // AC1 · monto — mata M7 (el cero como ausencia) y M8 (truncar en vez de redondear)
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  test('AC1/TC02 — el monto: cero es un dato, el centavo redondea y el nulo es «—»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogosVacios(page);

    // Los cuatro casos que separan un formateador correcto de uno que pasa con los fixtures de
    // siempre. Los tres primeros están sembrados en el entorno real; el nulo también.
    const casos = [
      { numero: 'CERO-0001', monto: '0.00', esperado: '0' },
      { numero: 'CENT-0002', monto: '232100.99', esperado: '232.101' },
      { numero: 'MILL-0003', monto: '1234567.89', esperado: '1.234.568' },
      { numero: 'NULO-0004', monto: null, esperado: null },
    ];
    const items = casos.map((c, i) => ({
      ...FILA, id: `0000000${i}-0000-4000-8000-00000000000${i}`, numeroComparendo: c.numero, monto: c.monto,
    }));
    await mockListado(page, { status: 200, body: { items, nextCursor: null } });

    await page.goto('/flito/comparendos');
    await expect(page.getByText('CERO-0001')).toBeVisible();

    for (const caso of casos) {
      const fila = page.getByRole('row').filter({ hasText: caso.numero });
      // La celda de monto es la única con `tabular-nums`: se localiza por su clase y no por índice,
      // que se rompería el día que se reordene una columna.
      const celda = fila.locator('td.tabular-nums');
      const texto = normalizar(await celda.innerText());

      if (caso.esperado === null) {
        expect(texto, 'un monto nulo es «—»').toBe('—');
        continue;
      }
      // Invariantes del AC, no una cadena dorada calculada con la misma llamada `Intl` que usa el
      // código (eso sería tautológico y pasaría aunque las opciones fueran otras):
      expect(texto, `«${caso.monto}» debe llevar el símbolo de peso`).toContain('$');
      expect(texto, `«${caso.monto}» NO puede pintarse como ausente`).not.toBe('—');
      expect(texto, `«${caso.monto}» no lleva parte decimal`).not.toMatch(/[.,]\d{2}\s*$/);
      // Y la secuencia de dígitos agrupada es exactamente la esperada. Esto es lo que mata a
      // `Math.floor` (232.100) y a la guardia falsy (que ni siquiera llegaría aquí).
      expect(texto.replace(/[^\d.]/g, ''), `«${caso.monto}» → «${caso.esperado}»`).toBe(caso.esperado);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // AC1 · fechas — mata M10. TODO este bloque corre FUERA de Colombia, a propósito.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  test.describe('AC1 · fechas, con el navegador en Tokio (UTC+9)', () => {
    test.use({ timezoneId: 'Asia/Tokyo', locale: 'es-CO' });

    test('AC1/TC05 — los instantes se pintan en hora de Colombia, no en la de la máquina', async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      await mockCatalogosVacios(page);

      // Las DOS direcciones. Un desfase constante no puede satisfacer las dos a la vez:
      //   03:12Z → Bogotá 16 ago 22:12 (día ANTERIOR) · Tokio 17 ago 12:12 · UTC 17 ago
      //   20:00Z → Bogotá 17 ago 15:00 (mismo día)    · Tokio 18 ago 05:00 · UTC 17 ago
      // Son exactamente los dos instantes sembrados en el entorno real.
      const items = [
        {
          ...FILA, id: 'aaaaaaaa-0000-4000-8000-000000000001', numeroComparendo: 'TZ-ANTES-01',
          primeraVistoEn: '2026-08-17T03:12:00Z', fechaComparendo: '2026-07-12',
        },
        {
          ...FILA, id: 'bbbbbbbb-0000-4000-8000-000000000002', numeroComparendo: 'TZ-DESPUES-02',
          primeraVistoEn: '2026-08-17T20:00:00Z', fechaComparendo: '2026-01-01',
        },
      ];
      await mockListado(page, { status: 200, body: { items, nextCursor: null } });

      await page.goto('/flito/comparendos');
      await expect(page.getByText('TZ-ANTES-01')).toBeVisible();
      // El navegador está de verdad en Tokio: si no, este test no demuestra nada.
      expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('Asia/Tokyo');

      const antes = page.getByRole('row').filter({ hasText: 'TZ-ANTES-01' });
      await expect(antes, '03:12Z es el 16 en Bogotá; en Tokio y en UTC sería el 17').toContainText('16 de ago');
      await expect(antes).not.toContainText('17 de ago');

      const despues = page.getByRole('row').filter({ hasText: 'TZ-DESPUES-02' });
      await expect(despues, '20:00Z es el 17 en Bogotá; en Tokio sería el 18').toContainText('17 de ago');
      await expect(despues).not.toContainText('18 de ago');
    });

    test('AC1/TC03 — la fecha del comparendo es de calendario y no se mueve con el huso', async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      await mockCatalogosVacios(page);
      // `fechaComparendo` es `date` (sin hora). Pasarla por `new Date(cadena)` la lee como medianoche
      // UTC y en Bogotá retrocede un día: el comparendo decía 12 y la tabla mostraba 11.
      await mockListado(page, {
        status: 200,
        body: { items: [{ ...FILA, numeroComparendo: 'CAL-0001', fechaComparendo: '2026-07-12' }], nextCursor: null },
      });

      await page.goto('/flito/comparendos');
      const fila = page.getByRole('row').filter({ hasText: 'CAL-0001' });
      await expect(fila).toContainText('12 de jul');
      await expect(fila).not.toContainText('11 de jul');
      await expect(fila).not.toContainText('13 de jul');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // AC6 · TC46 — mata M6: cambiar de criterio con la página en vuelo
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  test('AC6/TC46 — la respuesta tardía del filtro viejo NO aterriza bajo el filtro nuevo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogosVacios(page);
    const VIEJA = { ...FILA, id: 'cccccccc-0000-4000-8000-000000000003', numeroComparendo: 'PAGINA-VIEJA-3' };
    const NUEVA = { ...FILA, id: 'dddddddd-0000-4000-8000-000000000004', numeroComparendo: 'FILTRO-NUEVO-1' };

    const traza = await mockListado(page, { status: 200, body: { items: [FILA], nextCursor: 'CURSOR-1' } });
    traza.porCursor['CURSOR-1'] = { status: 200, body: { items: [VIEJA], nextCursor: 'CURSOR-2' } };

    await page.goto('/flito/comparendos');
    await expect(page.getByText('11001000123456')).toBeVisible();

    // La página 2 se queda en vuelo: es el usuario impaciente que pulsa «Siguiente» y, mientras
    // carga, decide filtrar. La respuesta llegará DESPUÉS del cambio de criterio.
    let soltar: () => void = () => {};
    traza.retener = new Promise<void>((resolve) => { soltar = resolve; });
    await boton(page, 'Siguiente →').click();
    await expect.poll(() => traza.peticiones.length).toBeGreaterThan(1);

    // Cambio de criterio con la anterior todavía sin responder.
    traza.respuesta = { status: 200, body: { items: [NUEVA], nextCursor: null } };
    traza.retener = null;
    await boton(page, 'Activos').click();
    await expect(page.getByText('FILTRO-NUEVO-1')).toBeVisible();

    // Ahora sí: llega la respuesta de la página 2 del listado SIN filtrar.
    soltar();
    // Se le da tiempo real para aterrizar; un `expect` inmediato pasaría por carrera, no por
    // corrección. Si la guardia de vuelo no existe, esta fila aparece y sustituye a la nueva.
    await page.waitForTimeout(600);
    await expect(page.getByText('PAGINA-VIEJA-3'), 'la respuesta tardía se descarta').toHaveCount(0);
    await expect(page.getByText('FILTRO-NUEVO-1')).toBeVisible();
    await expect(page.getByText(/página 1/)).toBeVisible();
    await expect(boton(page, '← Anterior')).toBeDisabled();
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // AC6 · TC43-TC45 tabla-driven — el fallo real es «no se reinicia en UNO de los manejadores»
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  const CRITERIOS: {
    nombre: string;
    aplicar: (page: Page) => Promise<void>;
    verbo: 'GET' | 'POST';
    query: string;
  }[] = [
    {
      nombre: 'la pill de estado',
      aplicar: async (page) => { await boton(page, 'Inactivos').click(); },
      verbo: 'GET',
      query: '?estado=inactivo',
    },
    {
      nombre: 'el número de comparendo (debounce, GET)',
      aplicar: async (page) => { await campoNumero(page).fill('1100'); },
      verbo: 'GET',
      query: '?q=1100',
    },
    {
      nombre: 'el NIT (submit explícito, conmuta a POST)',
      aplicar: async (page) => { await campoNit(page).fill('900123456'); await boton(page, 'Buscar').click(); },
      verbo: 'POST',
      query: '',
    },
    {
      nombre: 'la placa (submit explícito, conmuta a POST)',
      aplicar: async (page) => { await campoPlaca(page).fill('ABC123'); await campoPlaca(page).press('Enter'); },
      verbo: 'POST',
      query: '',
    },
  ];

  for (const criterio of CRITERIOS) {
    test(`AC6/TC43 — cambiar ${criterio.nombre} desde la página 3 reinicia cursor, DOM y pila`, async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      await mockCatalogosVacios(page);
      const traza = await mockListado(page, { status: 200, body: { items: [FILA], nextCursor: 'CURSOR-1' } });
      const P2 = { ...FILA, id: 'eeeeeeee-0000-4000-8000-000000000005', numeroComparendo: 'PAGINA-2' };
      const P3 = { ...FILA, id: 'ffffffff-0000-4000-8000-000000000006', numeroComparendo: 'PAGINA-3' };
      traza.porCursor['CURSOR-1'] = { status: 200, body: { items: [P2], nextCursor: 'CURSOR-2' } };
      traza.porCursor['CURSOR-2'] = { status: 200, body: { items: [P3], nextCursor: 'CURSOR-3' } };

      await page.goto('/flito/comparendos');
      await boton(page, 'Siguiente →').click();
      await expect(page.getByText(/página 2/)).toBeVisible();
      await boton(page, 'Siguiente →').click();
      await expect(page.getByText(/página 3/)).toBeVisible();
      // Aquí hay cursor Y una pila con dos entradas: la precondición que el test ingenuo se salta.
      await expect(boton(page, '← Anterior')).toBeEnabled();

      const NUEVO = { ...FILA, id: '99999999-0000-4000-8000-000000000009', numeroComparendo: 'LISTADO-NUEVO' };
      traza.respuesta = { status: 200, body: { items: [NUEVO], nextCursor: null } };
      await criterio.aplicar(page);
      await expect(page.getByText('LISTADO-NUEVO')).toBeVisible();

      const ultima = traza.peticiones[traza.peticiones.length - 1];
      // 1) La petición no lleva `cursor` en absoluto: ni el viejo, ni vacío, ni «null».
      expect(new URL(`http://x${ultima.split(' ')[1]}`).searchParams.has('cursor'),
        `la consulta tras cambiar ${criterio.nombre} no puede llevar cursor: «${ultima}»`).toBe(false);
      expect(ultima).toBe(`${criterio.verbo} /api/flito/comparendos/registros${
        criterio.verbo === 'POST' ? '/buscar' : ''}${criterio.query}`);
      // 2) El DOM se reinicia: las tres páginas viejas desaparecen, no se concatenan.
      for (const viejo of ['11001000123456', 'PAGINA-2', 'PAGINA-3']) {
        await expect(page.getByText(viejo), `«${viejo}» sobrevivió al cambio de criterio`).toHaveCount(0);
      }
      // 3) La pila se vacía. Sin esto, «Anterior» desde la nueva página 1 salta al listado viejo.
      await expect(page.getByText(/página 1/)).toBeVisible();
      await expect(boton(page, '← Anterior'),
        `la pila sobrevivió al cambio de ${criterio.nombre}`).toBeDisabled();
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // AC5 · el cursor viaja verbatim, y el doble clic no duplica la consulta
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  test('AC5/TC37 — el cursor base64url del API viaja tal cual, sin recortes ni doble codificación', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogosVacios(page);
    // La forma real que devuelve el servicio: base64url SIN relleno, con `-` y `_`. Al no tener
    // `=`, `+` ni `/`, una doble codificación es INVISIBLE a simple vista en la URL — por eso la
    // afirmación se hace sobre el valor ya decodificado una vez por `URLSearchParams`, y no con un
    // `toContain` sobre la cadena de la query.
    const CURSOR = 'MjAyNi0wOC0xN1QwMToxNjowMC4wMDBafDBjZWQ5-abc_XYZ';
    const traza = await mockListado(page, { status: 200, body: { items: [FILA], nextCursor: CURSOR } });
    traza.porCursor[CURSOR] = {
      status: 200,
      body: { items: [{ ...FILA, id: 'abcdef01-0000-4000-8000-00000000000a', numeroComparendo: 'PAGINA-2' }], nextCursor: null },
    };

    await page.goto('/flito/comparendos');
    await expect(page.getByText('11001000123456')).toBeVisible();
    await boton(page, 'Siguiente →').click();
    await expect(page.getByText('PAGINA-2')).toBeVisible();

    // Nota de método: en dev, `React.StrictMode` monta dos veces y la carga inicial sale DUPLICADA
    // (ver el TC de más abajo). Por eso aquí no se indexa por posición sino por contenido: las
    // consultas sin cursor son las de la primera página y hay exactamente UNA con cursor.
    const conCursor = traza.cursores.filter((c) => c !== null);
    expect(traza.cursores[0], 'la primera consulta no manda cursor').toBeNull();
    expect(conCursor, 'una sola consulta lleva cursor, y es idéntico al recibido').toEqual([CURSOR]);
    for (const p of traza.peticiones) expect(p).not.toContain('limit=');
  });

  test('AC5 — diagnóstico: cuántas consultas salen en la carga inicial', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogosVacios(page);
    const traza = await mockListado(page, { status: 200, body: { items: [FILA], nextCursor: null } });

    await page.goto('/flito/comparendos');
    await expect(page.getByText('11001000123456')).toBeVisible();
    await page.waitForTimeout(400);

    // Cada consulta escribe una fila en el registro de acceso PII (Ley 1581 art. 17). Una carga de
    // pantalla debería escribir UNA. Este TC no juzga: deja el número por escrito para que el
    // HANDOFF pueda decir si el duplicado es solo del `StrictMode` de desarrollo o llega al bundle.
    console.log(`[QA] consultas en la carga inicial: ${traza.peticiones.length} → ${traza.peticiones.join(' | ')}`);
    expect(traza.peticiones.length, 'la carga inicial no pide más de dos veces (StrictMode)')
      .toBeLessThanOrEqual(2);
  });

  test('AC5/TC41 — dos clics seguidos en «Siguiente» producen UNA sola consulta', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogosVacios(page);
    const traza = await mockListado(page, { status: 200, body: { items: [FILA], nextCursor: 'CURSOR-1' } });
    traza.porCursor['CURSOR-1'] = {
      status: 200,
      body: { items: [{ ...FILA, id: 'abcdef02-0000-4000-8000-00000000000b', numeroComparendo: 'PAGINA-2' }], nextCursor: 'CURSOR-2' },
    };

    await page.goto('/flito/comparendos');
    await expect(page.getByText('11001000123456')).toBeVisible();
    const antes = traza.peticiones.length;

    // La respuesta se retiene para poder pulsar dos veces «dentro» del mismo vuelo. Con la
    // semántica de REEMPLAZO, saltarse una página por un doble clic es perder datos sin avisar.
    //
    // Cómo lo resuelve la implementación, y no es lo que yo esperaba: mientras la página vuela,
    // `items` vuelve a `null` y la barra de paginación ENTERA se desmonta (solo se pinta con
    // `!error && !!items?.length`). El control no queda inhabilitado: deja de existir. El efecto
    // sobre el AC es el correcto —un segundo gesto no puede salir— y por eso se afirma lo que de
    // verdad protege al usuario (una consulta por gesto) y no el mecanismo. Queda como observación
    // de UX en el HANDOFF: la barra desaparece y reaparece en cada salto, y eso mueve el layout.
    let soltar: () => void = () => {};
    traza.retener = new Promise<void>((resolve) => { soltar = resolve; });
    const siguiente = boton(page, 'Siguiente →');
    await siguiente.click();
    await expect(siguiente, 'en vuelo el control no es pulsable').toHaveCount(0);
    soltar();
    traza.retener = null;

    await expect(page.getByText('PAGINA-2')).toBeVisible();
    expect(traza.peticiones.length - antes, 'un solo salto de página por gesto').toBe(1);
    expect(traza.cursores.filter((c) => c !== null), 'un solo cursor pedido').toEqual(['CURSOR-1']);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // AC3 · el otro lado del choque 1: NIT y placa NO buscan al teclear
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  test('AC3/TC26 — teclear el NIT o la placa no dispara ni una consulta', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogosVacios(page);
    const traza = await mockListado(page, { status: 200, body: { items: [FILA], nextCursor: null } });

    await page.goto('/flito/comparendos');
    await expect(page.getByText('11001000123456')).toBeVisible();
    const antes = traza.peticiones.length;

    await campoNit(page).pressSequentially('900123456', { delay: 30 });
    await campoPlaca(page).pressSequentially('ABC123', { delay: 30 });
    // Muy por encima del debounce de 450 ms de `q`: si NIT o placa lo compartieran, aquí ya
    // habrían salido varias consultas y varias filas al registro de acceso PII (Ley 1581 art. 17).
    await page.waitForTimeout(1200);

    expect(traza.peticiones.length - antes,
      `teclear identidad no consulta; salieron: ${traza.peticiones.slice(antes).join(' | ')}`).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// HU #11562 — la MITAD NUEVA de M10: `fechaHoraColombia`, la que sí pinta hora.
//
// Vive aparte del bloque de arriba porque hace falta abrir el panel de detalle, que es su único
// consumidor, y eso pide un mock más. Se mira el `<dl>` de datos de fuente —«Registrado» y «Visto
// por última vez»—, que es un punto de llamada distinto del que cubre
// `flito-comparendos-detalle.spec.ts` (allí se mira el timeline): el mutante se planta en la
// función, pero un formateador mal cableado en UNA celda no se ve desde la otra.
// ═════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('FLITO — Comparendos · refuerzo QA: el panel con el navegador en Tokio (HU #11562)', () => {
  test.use({ viewport: { width: 1600, height: 900 }, timezoneId: 'Asia/Tokyo', locale: 'es-CO' });

  test('AC1/TC05-bis — el panel pinta la HORA de Colombia, no la de la máquina', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCatalogosVacios(page);
    await mockListado(page, { status: 200, body: { items: [FILA], nextCursor: null } });

    // Las DOS direcciones, como en el bloque de la tabla. Un desfase constante no puede satisfacer
    // las dos a la vez:
    //   03:12Z → Bogotá 16 ago 22:12 (día ANTERIOR) · Tokio 17 ago 12:12 · UTC 17 ago 03:12
    //   20:00Z → Bogotá 17 ago 15:00 (mismo día)    · Tokio 18 ago 05:00 · UTC 17 ago 20:00
    const detalle = {
      ...FILA,
      primeraVistoEn: '2026-08-17T03:12:00Z',
      ultimoVistoEn: '2026-08-17T20:00:00Z',
      eventos: [],
    };
    // Se registra DESPUÉS del listado: en Playwright gana la ruta más reciente, y el glob del
    // listado también cubre `/registros/:id`.
    await page.route(`**/api/flito/comparendos/registros/${FILA.id}`, (r: Route) => r.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(detalle),
    }));

    await page.goto('/flito/comparendos');
    await boton(page, `Ver el comparendo ${FILA.numeroComparendo}`).click();
    const panel = page.getByRole('dialog');
    await expect(panel).toContainText('EN COBRO COACTIVO');

    // El navegador está de verdad en Tokio: si no, este test no demuestra nada.
    expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('Asia/Tokyo');

    const registrado = panel.getByText('Registrado', { exact: true }).locator('xpath=following-sibling::dd[1]');
    await expect(registrado, '03:12Z son las 22:12 del día 16 en Bogotá').toContainText('22:12');
    await expect(registrado).toContainText('16 de ago');
    await expect(registrado, 'en Tokio serían las 12:12 del 17').not.toContainText('12:12');

    const visto = panel.getByText('Visto por última vez', { exact: true }).locator('xpath=following-sibling::dd[1]');
    await expect(visto, '20:00Z son las 15:00 del 17 en Bogotá').toContainText('15:00');
    await expect(visto).toContainText('17 de ago');
    await expect(visto, 'en Tokio serían las 05:00 del 18').not.toContainText('05:00');
  });
});
