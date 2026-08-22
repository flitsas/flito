// FLITO — Conciliación de boletas SOAT (Feature #11623, HU #11680). Backend mockeado.
//
// Cubre los ocho AC de la pantalla. Cuatro decisiones de montaje que hacen que los asertos midan algo:
//
//   · **El gate que se mide es el de la PÁGINA, así que el rol entra con el slug concedido.** Los
//     roles del fixture base llevan `allowedPages: []`: con ellos `ProtectedRoute` corta antes de
//     montar nada y el gate interno no llega a correr, de modo que el caso del enlace profundo
//     certificaría «no se ve» en lugar de «no se pide». Por eso usa `AUDITOR_CON_SLUG`.
//   · **El AC1 se comprueba sobre la PETICIÓN, no sobre la pantalla.** El fixture base responde
//     `200 []` a todo `/api/**` no mockeado, así que una llamada fugada con el rol equivocado no
//     deja ninguna huella visible: solo el espía la ve. Y el gemelo positivo vive en este mismo
//     archivo, con el mismo glob, para que un glob mal escrito ponga rojo el positivo en vez de dar
//     por bueno un negativo vacío.
//   · **El AC4 mide `aria-disabled` y el foco**, no la opacidad. Un `<button disabled>` no recibe
//     foco y su nombre accesible no lo oye nadie: el test enfoca el botón, lee su nombre y comprueba
//     que pulsarlo no dispara ninguna petición.
//   · **El AC5 recarga la página de verdad.** «Sobrevive a una recarga» no se puede afirmar mirando
//     el estado de React.

import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import {
  loginAs, FINANCIERA_USER, OPERACIONES_USER, AUDITOR_USER, PROVEEDOR_USER,
  GESTOR_IMPUESTOS_USER, CONDUCTOR_USER,
} from '../helpers/auth';

const BOLETA_ID = 'bbbb0000-0000-0000-0000-000000000001';
const API_MODULO = '**/api/flito/conciliacion/**';
const CANARIO = '/api/__qa_canary';

const RE_LISTA = /\/api\/flito\/conciliacion\/boletas\?/;
const RE_DETALLE = /\/api\/flito\/conciliacion\/boletas\/[0-9a-f-]{36}$/;
const RE_CARGA = /\/api\/flito\/conciliacion\/boletas$/;
const RE_RECRUZAR = /\/api\/flito\/conciliacion\/boletas\/[0-9a-f-]{36}\/recruzar$/;
const RE_CONCILIAR = /\/api\/flito\/conciliacion\/boletas\/[0-9a-f-]{36}\/conciliar$/;
const RE_COMPROBANTE = /\/api\/flito\/conciliacion\/boletas\/[0-9a-f-]{36}\/comprobante$/;

// La póliza y la placa de la primera línea: los dos datos que el AC7 persigue por la URL y por la
// consola. Se declaran aquí para que el test los busque por el mismo literal que pinta la tabla.
const POLIZA_1 = '3903400012345671';
const PLACA_1 = 'ABC121';

/**
 * La fecha del pago que se escribe en el modal de carga. Es la de `RESUMEN`, y **no** la de hoy: el
 * campo arranca relleno con `hoyColombia`, así que un valor distinto es lo único que permite afirmar
 * que lo que viajó en el cuerpo es lo que se puso.
 */
const FECHA_PAGO = '2026-07-30';

type Linea = Record<string, unknown>;

function linea(n: number, over: Linea = {}): Linea {
  return {
    id: `linea-${n}`,
    filaNumero: n,
    numeroPolizaNorm: `390340001234567${n}`,
    valorDeclarado: 561900,
    resultado: 'ok',
    detalle: null,
    soatId: `soat-${n}`,
    placa: `ABC12${n}`,
    valorSoat: 561900,
    soatEstado: 'pagado',
    companiaSoatNombre: 'Transportes Andinos S.A.S.',
    candidatos: null,
    boletaAnteriorRef: null,
    boletaAnteriorFecha: null,
    yaDescontadoEnLiquidacion: false,
    conciliadaEn: null,
    ...over,
  };
}

/** Una línea de cada uno de los SIETE desenlaces: es lo que el AC3 pide comprobar de una vez. */
const LINEAS = [
  linea(1),
  linea(2, { resultado: 'no_encontrada', soatId: null, placa: null, valorSoat: null, soatEstado: null, companiaSoatNombre: null }),
  linea(3, { resultado: 'no_pagado', soatEstado: 'solicitado' }),
  linea(4, { resultado: 'valor_distinto', valorDeclarado: 587400, valorSoat: 561900 }),
  linea(5, { resultado: 'poliza_duplicada', soatId: null, placa: null, valorSoat: null, candidatos: 2 }),
  linea(6, { resultado: 'otra_compania', companiaSoatNombre: 'Logística del Café S.A.S.' }),
  linea(7, { resultado: 'ya_conciliada', boletaAnteriorRef: 'BOL-000099', boletaAnteriorFecha: '2026-06-15' }),
];

const CONTEO_TODOS = {
  ok: 1, no_encontrada: 1, no_pagado: 1, valor_distinto: 1, poliza_duplicada: 1,
  otra_compania: 1, ya_conciliada: 1,
};

const RESUMEN = {
  id: BOLETA_ID,
  referencia: 'BOL-000123',
  companiaId: 5,
  companiaNombre: 'Transportes Andinos S.A.S.',
  concepto: 'soat',
  estado: 'cargada',
  archivoNombre: 'reporte-soat.xlsx',
  filas: 7,
  totalDeclarado: 3958800,
  totalCruzado: 2247600,
  fechaPago: '2026-07-30',
  cargadaPorNombre: 'Laura Restrepo',
  conciliadaEn: null,
  conciliadaPorNombre: null,
  createdAt: '2026-08-20T15:00:00.000Z',
  conteo: CONTEO_TODOS,
  sinCuadrar: 6,
};

const DETALLE = { ...RESUMEN, lineas: LINEAS, comprobante: null, filasOmitidas: 0 };

/** La misma boleta ya cuadrada: las siete líneas en `ok`. Es el punto de partida del AC5. */
const LINEAS_OK = [1, 2, 3, 4, 5, 6, 7].map((n) => linea(n, n === 3 ? { yaDescontadoEnLiquidacion: true } : {}));
const DETALLE_CUADRADO = {
  ...DETALLE,
  lineas: LINEAS_OK,
  sinCuadrar: 0,
  totalCruzado: 3933300,
  conteo: { ...CONTEO_TODOS, ok: 7, no_encontrada: 0, no_pagado: 0, valor_distinto: 0, poliza_duplicada: 0, otra_compania: 0, ya_conciliada: 0 },
};

const DETALLE_CONCILIADO = {
  ...DETALLE_CUADRADO,
  estado: 'conciliada',
  conciliadaEn: '2026-08-20T20:42:00.000Z',
  conciliadaPorNombre: 'Laura Restrepo',
  lineas: LINEAS_OK.map((l) => ({ ...l, conciliadaEn: '2026-08-20T20:42:00.000Z' })),
};

const CONCILIACION_HECHA = {
  boleta: DETALLE_CONCILIADO,
  soatConciliados: 7,
  totalConciliado: 3933300,
  cliente: { companiaId: 5, nombre: 'Transportes Andinos S.A.S.', descontado: 3371400, saldoResultante: 12450300 },
  transito: [{ bolsaId: 'bolsa-1', nombre: 'Medellín', descontado: 4180000, saldoResultante: 9310500 }],
  adoptados: [{ lineaId: 'linea-3', filaNumero: 3, soatId: 'soat-3', valor: 561900, movimientoBolsaId: 'mov-1', adoptado: true }],
};

const json = (cuerpo: unknown, status = 200) => ({
  status, contentType: 'application/json', body: JSON.stringify(cuerpo),
});

async function mockLista(page: Page, items: unknown[], siguienteCursor: string | null = null) {
  await page.route(RE_LISTA, (route) => route.fulfill(json({ items, siguienteCursor })));
}

async function mockDetalle(page: Page, boleta: unknown) {
  await page.route(RE_DETALLE, (route) => route.fulfill(json(boleta)));
}

/** Punto de reposo: cuando el canario ha salido, lo que fuera a salir en el montaje ya salió. */
async function reposo(page: Page): Promise<void> {
  const salida = page.waitForRequest((r) => r.url().includes('__qa_canary'), { timeout: 10_000 });
  await page.evaluate((ruta) => { void fetch(ruta).catch(() => {}); }, CANARIO);
  await salida;
}

function espiarModulo(page: Page): string[] {
  const vistas: string[] = [];
  page.on('request', (req) => {
    const { pathname } = new URL(req.url());
    // Solo el método y el path: la query es justo el sitio por donde se filtraría una placa a un
    // artefacto de CI (AGENTS.md §14).
    if (pathname.startsWith('/api/flito/conciliacion')) vistas.push(`${req.method()} ${pathname}`);
  });
  return vistas;
}

/**
 * Las claves del aviso que hay AHORA en la pestaña. Se leen por el literal del prefijo, no por una
 * constante importada del código de producción: si alguien renombra el prefijo y se olvida del
 * barrido, este test tiene que enterarse — no seguirle la corriente.
 */
function avisosGuardados(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Object.keys(sessionStorage).filter((k) => k.startsWith('flito:conciliacion:aviso:')));
}

/**
 * Auditoría **con el slug de la página concedido a mano**.
 *
 * Es el único montaje en el que el gate de rol de la página decide algo: los roles del fixture base
 * llevan `allowedPages: []` y `ProtectedRoute` los detiene antes de montar nada, así que un test que
 * los use está midiendo el gate de la RUTA aunque el aserto hable del de la página.
 */
const AUDITOR_CON_SLUG = { ...AUDITOR_USER, allowedPages: ['flito_conciliacion'] };

/** Cerrar sesión como se cierra de verdad: por el menú de usuario del topbar. */
async function cerrarSesion(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Menú de usuario/ }).click();
  await page.getByRole('menuitem', { name: 'Cerrar sesión' }).click();
  await expect(page).toHaveURL(/\/login$/);
}

test.describe('FLITO — Conciliación · acceso y menú (AC1)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('financiera entra, la pantalla consulta el API y el menú la ofrece en Finanzas', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    const vistas = espiarModulo(page);
    await mockLista(page, [RESUMEN]);

    await page.goto('/flito/conciliacion');
    await expect(page.getByRole('heading', { name: 'Conciliación', level: 1 })).toBeVisible();
    await reposo(page);

    expect(vistas.some((l) => l === 'GET /api/flito/conciliacion/boletas')).toBe(true);

    const nav = page.getByRole('navigation', { name: 'Navegación principal' });
    await nav.getByRole('button', { name: 'Finanzas', exact: true }).click();
    const enlace = page.getByRole('link', { name: 'Conciliación', exact: true });
    await expect(enlace).toBeVisible();
    await expect(enlace).toHaveAttribute('href', '/flito/conciliacion');
  });

  for (const usuario of [AUDITOR_USER, PROVEEDOR_USER, GESTOR_IMPUESTOS_USER, CONDUCTOR_USER]) {
    test(`${usuario.role} ve la pantalla de sin acceso y no dispara ninguna petición`, async ({ page }) => {
      await loginAs(page, usuario);
      const vistas = espiarModulo(page);
      // Abortado a propósito: si algo se escapa, cae el contador Y cae el `NoAccess`, que pasaría a
      // ser la banda de error. Dos señales independientes de la misma fuga.
      await page.route(API_MODULO, (route) => route.abort('failed'));

      await page.goto('/flito/conciliacion');
      await expect(page.getByRole('heading', { name: /no tienes acceso a flito — conciliación/i })).toBeVisible();
      await reposo(page);

      expect(vistas).toEqual([]);
    });
  }

  test('el enlace profundo al detalle tampoco dispara el GET de la boleta', async ({ page }) => {
    // Es el caso que se olvida: sin el gate DENTRO de la página, entrar por la URL del detalle
    // dispararía `GET /boletas/:id` y devolvería un 403 antes de que la ruta pintara `NoAccess`.
    //
    // Y por eso el fixture es AUDITOR_CON_SLUG y no AUDITOR_USER: con `allowedPages: []`,
    // `ProtectedRoute` corta ANTES de montar la página y el gate interno no llega a correr nunca —el
    // caso lo resolvería el router y el test certificaría «no se ve» en vez de «no se pide»—. Con el
    // slug concedido a mano, la página SÍ se monta y el gate de rol es lo único que decide.
    await loginAs(page, AUDITOR_CON_SLUG);
    const vistas = espiarModulo(page);
    await page.route(API_MODULO, (route) => route.abort('failed'));

    await page.goto(`/flito/conciliacion/${BOLETA_ID}`);
    await expect(page.getByRole('heading', { name: /no tienes acceso a flito — conciliación/i })).toBeVisible();

    // Control de que el montaje es el que se quiere: el menú ofrece la página, que es la misma
    // decisión (`hasPage`) que toma `ProtectedRoute`. Si alguien vaciara `allowedPages` de este
    // fixture, esto se pondría rojo en vez de dejar el caso midiendo el gate equivocado en silencio.
    const nav = page.getByRole('navigation', { name: 'Navegación principal' });
    await nav.getByRole('button', { name: 'Finanzas', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Conciliación', exact: true })).toBeVisible();

    await reposo(page);

    expect(vistas).toEqual([]);
  });
});

test.describe('FLITO — Conciliación · bandeja (AC2)', () => {
  test('el error trae un reintento que vuelve a pedir de verdad', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    // El interruptor es una BANDERA y no un contador de llamadas: en desarrollo React monta el
    // efecto dos veces, así que «la primera petición falla» no describiría lo que se quiere probar
    // —que el reintento vuelve a preguntar— sino un detalle del modo estricto.
    let caido = true;
    let peticiones = 0;
    await page.route(RE_LISTA, (route) => {
      peticiones += 1;
      return caido
        ? route.fulfill(json({ error: 'Error del servidor' }, 500))
        : route.fulfill(json({ items: [RESUMEN], siguienteCursor: null }));
    });

    await page.goto('/flito/conciliacion');
    await expect(page.getByText('No se pudo cargar la lista de boletas.')).toBeVisible();

    const antes = peticiones;
    caido = false;
    await page.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByRole('cell', { name: 'BOL-000123', exact: true })).toBeVisible();
    // Reintentar VUELVE A PEDIR, no solo repinta.
    expect(peticiones).toBeGreaterThan(antes);
  });

  test('el vacío por filtros quita los filtros de verdad y vuelve a pedir', async ({ page }) => {
    // Es literalmente el bug #11648: el botón repintaba sin resetear, así que el vacío se quedaba.
    await loginAs(page, OPERACIONES_USER);
    const urls: string[] = [];
    await page.route(RE_LISTA, (route) => {
      const url = route.request().url();
      urls.push(url);
      return route.fulfill(json({
        items: url.includes('estado=descartada') ? [] : [RESUMEN], siguienteCursor: null,
      }));
    });

    await page.goto('/flito/conciliacion');
    await expect(page.getByRole('cell', { name: 'BOL-000123', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Descartadas' }).click();
    await expect(page.getByText('Ninguna boleta con los filtros puestos.')).toBeVisible();

    await page.getByRole('button', { name: 'Limpiar filtros' }).first().click();
    await expect(page.getByRole('cell', { name: 'BOL-000123', exact: true })).toBeVisible();
    expect(urls.at(-1)).not.toContain('estado=');
    // Y el filtro queda de verdad sin poner, no solo la lista repintada.
    await expect(page.getByRole('button', { name: 'Todas' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('sin ninguna boleta, el vacío explica de dónde sale una y ofrece cargarla', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockLista(page, []);

    await page.goto('/flito/conciliacion');
    await expect(page.getByText('Todavía no hay boletas cargadas.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cargar boleta', exact: true })).toBeVisible();
  });
});

async function mockClientes(page: Page) {
  await page.route('**/api/clients', (route) => route.fulfill(json([
    { id: 5, name: 'Transportes Andinos S.A.S.' },
    { id: 6, name: 'Logística del Café S.A.S.' },
  ])));
}

const XLSX = {
  name: 'reporte-soat.xlsx',
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  buffer: Buffer.from('PK fingido'),
};

test.describe('FLITO — Conciliación · cargar la boleta (AC3)', () => {
  test('la carga pide cliente, fecha y archivo, y los tres viajan en el cuerpo del POST', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockClientes(page);
    await mockLista(page, []);
    await mockDetalle(page, DETALLE);
    // El cuerpo se guarda para poder afirmarlo: la fecha es el único de los tres datos que NO deja
    // huella en la pantalla si se cae del cuerpo —el modal se cierra y se aterriza en el cuadre
    // igual—, así que sin mirar el POST nadie se enteraría de que dejó de viajar.
    const cuerpos: string[] = [];
    await page.route(RE_CARGA, (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      cuerpos.push(route.request().postData() ?? '');
      return route.fulfill(json(DETALLE, 201));
    });

    await page.goto('/flito/conciliacion');
    await page.getByRole('button', { name: '+ Cargar boleta' }).click();

    // Hasta que no están los tres, el botón dice QUÉ falta: un «Cargar y cruzar» en gris no lo dice.
    const cargar = page.getByRole('button', { name: /Cargar y cruzar/ });
    await expect(cargar).toHaveAccessibleName('Cargar y cruzar — falta elegir el cliente');

    await page.getByLabel('Cliente *').selectOption('5');
    await expect(cargar).toHaveAccessibleName('Cargar y cruzar — falta elegir el archivo');

    // La fecha se escribe a mano, y un día que NO es el de hoy: arranca rellena con `hoyColombia`,
    // así que con la de por defecto no se podría distinguir «viajó la que puse» de «viajó cualquier
    // cosa con forma de fecha».
    await page.getByLabel('Fecha del pago en el portal *').fill(FECHA_PAGO);
    await page.locator('input[type=file]').setInputFiles(XLSX);
    await expect(cargar).toHaveAttribute('aria-disabled', 'false');

    await cargar.click();
    // El cuadre ya viene resuelto en la respuesta de la carga: se aterriza en su ruta propia.
    await expect(page).toHaveURL(new RegExp(`/flito/conciliacion/${BOLETA_ID}$`));
    await expect(page.getByRole('heading', { level: 1, name: /BOL-000123/ })).toBeVisible();
    // Y el foco va al <h1>, no al <body> del documento nuevo.
    await expect(page.getByRole('heading', { level: 1, name: /BOL-000123/ })).toBeFocused();

    // Los TRES en el cuerpo del multipart, cada uno con su nombre de campo. La fecha, además, con el
    // valor que se puso: es la que decide a qué mes contable pertenece el pago.
    expect(cuerpos).toHaveLength(1);
    expect(cuerpos[0]).toContain('name="companiaId"');
    expect(cuerpos[0]).toContain('name="archivo"');
    expect(cuerpos[0]).toContain('name="fechaPago"');
    expect(cuerpos[0]).toContain(FECHA_PAGO);
  });

  test('sin la fecha del pago no se carga nada, y el botón dice que es eso lo que falta', async ({ page }) => {
    // La rama que no ejercitaba nadie: `fechaPago` arranca con la de hoy, así que a «falta poner la
    // fecha del pago» solo se llega BORRÁNDOLA. Y borrarla es el gesto corriente —se abre el campo
    // para poner la del portal—, no un caso de laboratorio.
    await loginAs(page, OPERACIONES_USER);
    await mockClientes(page);
    await mockLista(page, []);
    let posts = 0;
    await page.route(RE_CARGA, (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      posts += 1;
      return route.fulfill(json(DETALLE, 201));
    });

    await page.goto('/flito/conciliacion');
    await page.getByRole('button', { name: '+ Cargar boleta' }).click();
    await page.getByLabel('Cliente *').selectOption('5');
    await page.locator('input[type=file]').setInputFiles(XLSX);

    const cargar = page.getByRole('button', { name: /Cargar y cruzar/ });
    // Punto de partida: con los tres puestos el botón SÍ está disponible. Sin esto, lo de abajo
    // pasaría también con un botón bloqueado por cualquier otro motivo.
    await expect(cargar).toHaveAttribute('aria-disabled', 'false');

    await page.getByLabel('Fecha del pago en el portal *').fill('');
    await expect(cargar).toHaveAccessibleName('Cargar y cruzar — falta poner la fecha del pago');
    await expect(cargar).toHaveAttribute('aria-disabled', 'true');

    // `force`: para Playwright un `aria-disabled` está inhabilitado y esperaría eternamente, pero el
    // navegador SÍ entrega el clic. Lo que se prueba es que no sale una boleta sin fecha de pago.
    await cargar.click({ force: true });
    await reposo(page);
    expect(posts).toBe(0);
    await expect(page.getByRole('dialog', { name: 'Cargar boleta del portal' })).toBeVisible();
  });

  test('el mismo archivo dos veces lleva a la boleta que ya existe, en vez de dejar adivinando', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockClientes(page);
    await mockLista(page, []);
    await mockDetalle(page, DETALLE);
    await page.route(RE_CARGA, (route) => (route.request().method() === 'POST'
      ? route.fulfill(json({
        error: 'Este mismo archivo ya se cargó como BOL-000122.',
        codigo: 'boleta_duplicada',
        boletaId: BOLETA_ID,
        referencia: 'BOL-000122',
      }, 409))
      : route.fallback()));

    await page.goto('/flito/conciliacion');
    await page.getByRole('button', { name: '+ Cargar boleta' }).click();
    await page.getByLabel('Cliente *').selectOption('5');
    await page.locator('input[type=file]').setInputFiles(XLSX);
    await page.getByRole('button', { name: /Cargar y cruzar/ }).click();

    await expect(page.getByRole('alert')).toContainText('Este mismo archivo ya se cargó como BOL-000122.');
    // El 409 trae el `boletaId` expresamente para esto: si el front no lo usa, el servidor le regaló
    // un dato para nada.
    await page.getByRole('button', { name: 'Ver BOL-000122' }).click();
    await expect(page).toHaveURL(new RegExp(`/flito/conciliacion/${BOLETA_ID}$`));
  });

  test('el rechazo de la carga dice el motivo, no «Rechazado — cargar otro»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockClientes(page);
    await mockLista(page, []);
    await page.route(RE_CARGA, (route) => (route.request().method() === 'POST'
      ? route.fulfill(json({
        error: 'El archivo trae 620 líneas y el máximo son 500.',
        codigo: 'demasiadas_filas',
        filas: 620,
        maximo: 500,
      }, 400))
      : route.fallback()));

    await page.goto('/flito/conciliacion');
    await page.getByRole('button', { name: '+ Cargar boleta' }).click();
    await page.getByLabel('Cliente *').selectOption('5');
    await page.locator('input[type=file]').setInputFiles(XLSX);
    await page.getByRole('button', { name: /Cargar y cruzar/ }).click();

    const alerta = page.getByRole('alert');
    await expect(alerta).toContainText('El archivo trae 620 líneas y el máximo son 500.');
    await expect(alerta).toContainText('Divide la boleta en dos archivos');
    // El modal NO se cierra con un rechazo: cerrarlo perdería el motivo.
    await expect(page.getByRole('dialog', { name: 'Cargar boleta del portal' })).toBeVisible();
  });
});

test.describe('FLITO — Conciliación · el cuadre (AC3)', () => {
  test('la tabla trae las cinco columnas, los siete resultados y el contador', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockDetalle(page, DETALLE);
    await page.goto(`/flito/conciliacion/${BOLETA_ID}`);

    for (const columna of ['Fila', 'Número de póliza', 'Placa', 'Valor boleta', 'Valor SOAT', 'Resultado']) {
      await expect(page.getByRole('columnheader', { name: columna })).toBeVisible();
    }

    // Los siete desenlaces, cada uno con su ETIQUETA de texto: en escala de grises tienen que
    // seguir siendo distinguibles, así que el color no puede cargar solo con la información.
    for (const etiqueta of ['Cuadra', 'Sin SOAT', 'SOAT sin pagar', 'Valor distinto', 'Póliza repetida', 'Otro cliente', 'Ya conciliada']) {
      await expect(page.getByText(etiqueta, { exact: true }).first()).toBeVisible();
    }

    await expect(page.getByText('1 de 7 líneas cuadra. 6 no cuadran.')).toBeVisible();
  });

  test('la línea sin SOAT no enseña ni una celda vacía ni un cero, y el valor distinto dice la diferencia', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockDetalle(page, DETALLE);
    await page.goto(`/flito/conciliacion/${BOLETA_ID}`);

    const sinSoat = page.getByRole('row').filter({ hasText: 'No hay ningún SOAT en FLITO' });
    await expect(sinSoat.getByText('Sin identificar')).toBeVisible();
    await expect(sinSoat.getByRole('cell', { name: 'Sin SOAT', exact: true })).toBeVisible();

    const duplicada = page.getByRole('row').filter({ hasText: 'está en 2 SOAT distintos' });
    await expect(duplicada.getByRole('cell', { name: '2 SOAT posibles', exact: true })).toBeVisible();
    await expect(duplicada.getByRole('cell', { name: 'No se puede saber', exact: true })).toBeVisible();

    // Los dos importes Y la diferencia calculada: restar dos números de seis cifras a ojo, 500
    // veces, es el trabajo que esta pantalla existe para quitar.
    await expect(page.getByText(/La boleta cobra .*587\.400.* y el SOAT registrado en FLITO vale .*561\.900.*: hay .*25\.500.* de diferencia\./)).toBeVisible();

    // El motivo se VE, sin abrir nada: ni tooltip, ni «ver más».
    await expect(page.getByText(/todavía no está marcado como pagado: hoy está en "Solicitado"/)).toBeVisible();
    await expect(page.getByText(/Este SOAT es de Logística del Café S\.A\.S\., y esta boleta se cargó para Transportes Andinos/)).toBeVisible();
    await expect(page.getByText(/ya se concilió en la boleta BOL-000099 el 15\/6\/2026/)).toBeVisible();
  });

  test('el filtro «solo las que no cuadran» deja fuera las que cuadran', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockDetalle(page, DETALLE);
    await page.goto(`/flito/conciliacion/${BOLETA_ID}`);

    const soloMalas = page.getByRole('button', { name: /Solo las que no cuadran/ });
    await soloMalas.click();
    await expect(soloMalas).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Cuadra', { exact: true })).toHaveCount(0);
    // Una vez en la celda de VALOR SOAT y otra en el chip del resultado: las dos de la misma fila.
    await expect(page.getByRole('row').filter({ hasText: 'No hay ningún SOAT en FLITO' })).toHaveCount(1);
  });
});

test.describe('FLITO — Conciliación · no se concilia con novedades (AC4)', () => {
  test('el botón bloqueado se alcanza con el tabulador, dice por qué y no pide nada', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const vistas = espiarModulo(page);
    await mockDetalle(page, DETALLE);
    await page.goto(`/flito/conciliacion/${BOLETA_ID}`);

    const boton = page.getByRole('button', { name: /Conciliar boleta/ });
    // `aria-disabled` y NO `disabled`: con `disabled` el botón no recibe foco y su nombre accesible
    // —que es lo que el AC4 pide oír— sería inalcanzable.
    await expect(boton).toHaveAttribute('aria-disabled', 'true');
    await expect(boton).not.toHaveAttribute('disabled', '');
    await expect(boton).toHaveAccessibleName('Conciliar boleta — no disponible: 6 de 7 líneas no cuadran');
    await boton.focus();
    await expect(boton).toBeFocused();

    // El texto visible dice el MISMO número.
    await expect(page.getByText(/No se puede conciliar: 6 de 7 líneas no cuadran/)).toBeVisible();

    // `force`: para Playwright un `aria-disabled` está inhabilitado y esperaría eternamente, pero
    // el navegador SÍ entrega el clic —de eso trata la decisión— y lo que se prueba es qué hace.
    await boton.click({ force: true });
    // Pulsarlo no pide nada: lleva el foco al motivo, que es la única acción útil que queda.
    await expect(page.locator('#conciliar-bloqueante')).toBeFocused();
    await reposo(page);
    expect(vistas.filter((l) => l.includes('/conciliar'))).toEqual([]);
  });

  test('volver a cruzar repinta el cuadre y habilita el botón', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockDetalle(page, DETALLE);
    await page.route(RE_RECRUZAR, (route) => route.fulfill(json(DETALLE_CUADRADO)));
    await page.goto(`/flito/conciliacion/${BOLETA_ID}`);

    await expect(page.getByText('1 de 7 líneas cuadra. 6 no cuadran.')).toBeVisible();
    await page.getByRole('button', { name: 'Volver a cruzar' }).click();

    await expect(page.getByText('Las 7 líneas cuadran.')).toBeVisible();
    const boton = page.getByRole('button', { name: 'Conciliar boleta', exact: true });
    await expect(boton).toHaveAttribute('aria-disabled', 'false');
    await expect(page.getByText(/No se puede conciliar/)).toHaveCount(0);
  });

  test('descartar pide confirmación en la propia acción y no existe sobre una boleta conciliada', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockDetalle(page, DETALLE);
    await page.goto(`/flito/conciliacion/${BOLETA_ID}`);

    await page.getByRole('button', { name: 'Descartar' }).click();
    await expect(page.getByText(/¿Descartar\? Se pierde el cruce/)).toBeVisible();
    await page.getByRole('button', { name: 'No', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Descartar' })).toBeVisible();

    // Ya conciliada: ni «Descartar» ni «Volver a cruzar». Es un documento contable.
    await page.route(RE_DETALLE, (route) => route.fulfill(json(DETALLE_CONCILIADO)));
    await page.reload();
    await expect(page.getByRole('button', { name: 'Descartar' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Volver a cruzar' })).toHaveCount(0);
  });
});

test.describe('FLITO — Conciliación · el aviso del dinero (AC5)', () => {
  test('conciliar avisa con las cifras de cada bolsa y el aviso sobrevive a una recarga', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockDetalle(page, DETALLE_CUADRADO);
    await page.route(RE_CONCILIAR, (route) => route.fulfill(json(CONCILIACION_HECHA)));
    await page.goto(`/flito/conciliacion/${BOLETA_ID}`);

    await page.getByRole('button', { name: 'Conciliar boleta', exact: true }).click();
    // El único diálogo de confirmación de la pantalla, y dice el verbo, no «Aceptar».
    await expect(page.getByText(/No se puede deshacer/)).toBeVisible();
    await page.getByRole('button', { name: 'Sí, conciliar' }).click();

    const aviso = page.getByRole('status').filter({ hasText: 'Boleta conciliada' });
    await expect(aviso).toBeVisible();
    await expect(aviso).toContainText('Se conciliaron 7 SOAT');
    await expect(aviso).toContainText('3.933.300');
    await expect(aviso).toContainText('Transportes Andinos S.A.S.');
    await expect(aviso).toContainText('3.371.400');
    await expect(aviso).toContainText('12.450.300');
    // Una línea por BOLSA de tránsito, con su saldo.
    await expect(aviso).toContainText('Bolsa de tránsito de Medellín');
    await expect(aviso).toContainText('9.310.500');
    // El SOAT que ya se había descontado al liquidar: el aviso NO anuncia un cobro que no ocurrió.
    await expect(aviso).toContainText(/1 de esos SOAT ya se había descontado al liquidar/);
    await expect(aviso).toContainText('Este descuento no se revierte');

    // Y sobrevive a una recarga de verdad, con sus cifras.
    await page.route(RE_DETALLE, (route) => route.fulfill(json(DETALLE_CONCILIADO)));
    await page.reload();
    const trasRecargar = page.getByRole('status').filter({ hasText: 'Boleta conciliada' });
    await expect(trasRecargar).toContainText('Se conciliaron 7 SOAT');
    await expect(trasRecargar).toContainText('12.450.300');
    await expect(page.getByText(/Conciliada por Laura Restrepo/)).toBeVisible();
  });

  test('si la boleta dejó de cuadrar, el 409 lo dice, repinta la tabla y jura que no se descontó nada', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockDetalle(page, DETALLE_CUADRADO);
    await page.route(RE_CONCILIAR, (route) => route.fulfill(json({
      error: 'La boleta cambió desde que la cargaste.',
      codigo: 'boleta_incompleta',
      boleta: DETALLE,
      sinCuadrar: 6,
    }, 409)));
    await page.goto(`/flito/conciliacion/${BOLETA_ID}`);

    await page.getByRole('button', { name: 'Conciliar boleta', exact: true }).click();
    await page.getByRole('button', { name: 'Sí, conciliar' }).click();

    const alerta = page.getByRole('alert');
    await expect(alerta).toContainText('ahora hay 6 líneas que no cuadran');
    await expect(alerta).toContainText('No se descontó nada.');
    // La tabla se repinta con las líneas que trae el 409, no con las que había en pantalla.
    await expect(page.getByText('1 de 7 líneas cuadra. 6 no cuadran.')).toBeVisible();
    await expect(page.getByText('Sin identificar')).toBeVisible();
  });
});

test.describe('FLITO — Conciliación · comprobante PSE (AC6)', () => {
  test('un archivo que no sirve dice por qué y la caja no se queda cargando', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockDetalle(page, DETALLE_CONCILIADO);
    await page.goto(`/flito/conciliacion/${BOLETA_ID}`);

    await page.locator('input[type=file]').setInputFiles({
      name: 'comprobante.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from('no soy un pdf'),
    });

    await expect(page.getByRole('alert')).toContainText('Ese archivo es un .docx');
    await expect(page.getByText('Analizando...')).toHaveCount(0);
  });

  test('el motivo que solo se ve mirando los bytes lo dice el servidor, y tampoco deja la vista cargando', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockDetalle(page, DETALLE_CONCILIADO);
    await page.route(RE_COMPROBANTE, (route) => (route.request().method() === 'POST'
      ? route.fulfill(json({
        error: 'El archivo dice ser un PDF pero no lo es.', codigo: 'archivo_invalido',
      }, 400))
      : route.fallback()));
    await page.goto(`/flito/conciliacion/${BOLETA_ID}`);

    await page.locator('input[type=file]').setInputFiles({
      name: 'falso.pdf', mimeType: 'application/pdf', buffer: Buffer.from('MZ no soy un pdf'),
    });

    await expect(page.getByRole('alert')).toContainText('El archivo dice ser un PDF pero no lo es.');
    await expect(page.getByText('Analizando...')).toHaveCount(0);
  });

  test('el comprobante adjunto sale con su nombre y su enlace de descarga', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockDetalle(page, {
      ...DETALLE_CONCILIADO,
      comprobante: {
        id: 'sop-1', nombreArchivo: 'comprobante-pse-30jul.pdf', contentType: 'application/pdf',
        tamanoBytes: 120345, subidoEn: '2026-08-20T20:45:00.000Z', subidoPorNombre: 'Laura Restrepo',
        url: '/api/files?key=x&exp=1&sig=y',
      },
    });
    await page.route(RE_COMPROBANTE, (route) => route.fulfill(json({
      url: '/api/files?key=x&exp=2&sig=z', nombreArchivo: 'comprobante-pse-30jul.pdf',
      contentType: 'application/pdf',
    })));
    await page.goto(`/flito/conciliacion/${BOLETA_ID}`);

    await expect(page.getByText(/comprobante-pse-30jul\.pdf · PDF · subido el/)).toBeVisible();
    // La URL firmada NO se pinta como href estático: caduca, y un enlace muerto es peor que un
    // botón. El clic pide una firma fresca.
    const firma = page.waitForRequest((r) => r.method() === 'GET' && RE_COMPROBANTE.test(r.url()));
    await page.getByRole('button', { name: 'Descargar' }).click();
    await firma;
    await expect(page.getByText('Al reemplazarlo, el comprobante actual se descarta.')).toBeVisible();
  });

  test('antes de conciliar no hay caja de carga, hay una explicación', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockDetalle(page, DETALLE);
    await page.goto(`/flito/conciliacion/${BOLETA_ID}`);

    await expect(page.getByText('El comprobante se adjunta después de conciliar la boleta.')).toBeVisible();
    await expect(page.locator('input[type=file]')).toHaveCount(0);
  });
});

test.describe('FLITO — Conciliación · ni póliza ni placa fuera del cuerpo (AC7)', () => {
  test('la URL y la consola quedan limpias en todo el recorrido', async ({ page }) => {
    const consola: string[] = [];
    page.on('console', (m) => consola.push(m.text()));
    page.on('pageerror', (e) => consola.push(e.message));

    await loginAs(page, OPERACIONES_USER);
    await mockLista(page, [RESUMEN]);
    await mockDetalle(page, DETALLE);

    await page.goto('/flito/conciliacion');
    await expect(page.getByRole('cell', { name: 'BOL-000123', exact: true })).toBeVisible();
    expect(page.url()).toMatch(/\/flito\/conciliacion$/);

    await page.getByRole('link', { name: 'Abrir la boleta BOL-000123' }).click();
    await expect(page.getByRole('heading', { level: 1, name: /BOL-000123/ })).toBeVisible();
    // El path lleva el uuid OPACO y nada más; ni la póliza ni la placa entran en la query.
    expect(page.url()).toMatch(new RegExp(`/flito/conciliacion/${BOLETA_ID}$`));
    // Y la póliza sí está en el cuerpo de la respuesta, que es donde puede estar: la tabla la pinta.
    await expect(page.getByRole('cell', { name: POLIZA_1 })).toBeVisible();

    // El título del documento lleva la REFERENCIA, que es lo que queda escrito en el historial.
    expect(await page.title()).toContain('BOL-000123');
    expect(await page.title()).not.toContain(PLACA_1);

    const rastro = consola.join('\n');
    expect(rastro).not.toContain(POLIZA_1);
    expect(rastro).not.toContain(PLACA_1);
  });
});

test.describe('FLITO — Conciliación · el aviso no sobrevive a la sesión', () => {
  test('cerrar sesión borra los importes y saldos que el aviso dejó en la pestaña', async ({ page }) => {
    // El cierre de sesión de FLIT es SPA: navega, NO recarga, así que `sessionStorage` sobrevive
    // salvo que alguien lo barra. Sin el barrido, quien entrara después en la misma pestaña —aunque
    // fuera un conductor— seguiría teniendo a mano los saldos de bolsa de quien salió.
    await loginAs(page, FINANCIERA_USER);
    await mockDetalle(page, DETALLE_CUADRADO);
    await page.route(RE_CONCILIAR, (route) => route.fulfill(json(CONCILIACION_HECHA)));
    await page.goto(`/flito/conciliacion/${BOLETA_ID}`);

    await page.getByRole('button', { name: 'Conciliar boleta', exact: true }).click();
    await page.getByRole('button', { name: 'Sí, conciliar' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Boleta conciliada' })).toBeVisible();

    // Punto de partida: el aviso está guardado, con el usuario en la clave y el saldo dentro. Si
    // esto fallara, lo de abajo pasaría en vacío y no probaría nada.
    const claves = await avisosGuardados(page);
    expect(claves).toEqual([`flito:conciliacion:aviso:${FINANCIERA_USER.id}:${BOLETA_ID}`]);
    const guardado = await page.evaluate((k) => sessionStorage.getItem(k) ?? '', claves[0]);
    expect(guardado).toContain('12450300');

    await cerrarSesion(page);

    expect(await avisosGuardados(page)).toEqual([]);
  });

  test('la sesión que expira sola deja la pestaña igual de limpia que el logout', async ({ page }) => {
    // El otro camino, y el que se olvida: nadie pulsa «Cerrar sesión», el token caduca y api.ts
    // emite SESSION_ENDED. Sin barrido ahí, expirar dejaría exactamente el mismo rastro que no
    // haber cerrado sesión nunca.
    await loginAs(page, FINANCIERA_USER);
    await mockDetalle(page, DETALLE_CUADRADO);
    await page.route(RE_CONCILIAR, (route) => route.fulfill(json(CONCILIACION_HECHA)));
    await page.goto(`/flito/conciliacion/${BOLETA_ID}`);

    await page.getByRole('button', { name: 'Conciliar boleta', exact: true }).click();
    await page.getByRole('button', { name: 'Sí, conciliar' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Boleta conciliada' })).toBeVisible();
    expect(await avisosGuardados(page)).toHaveLength(1);

    // El token caduca: la siguiente petición del módulo responde 401 y arrastra la sesión con ella.
    await page.route(RE_DETALLE, (route) => route.fulfill(json({ error: 'Sesión expirada' }, 401)));
    await page.reload();
    await expect(page).toHaveURL(/\/login$/);

    expect(await avisosGuardados(page)).toEqual([]);
  });

  test('el arranque con el token caducado deja la pestaña igual de limpia', async ({ page }) => {
    // El tercer camino, y el que no cubría nadie: la pestaña se abre —o se recarga— con un token que
    // ya no sirve, y `/auth/me` falla al arrancar con algo que NO es un 401 (la API caída, un 502 del
    // proxy, la red). No hay `SESSION_ENDED` en ese camino: lo único que corre es el `catch` del
    // arranque de `AuthProvider`, así que si ese catch solo tira el token, los saldos de bolsa de la
    // sesión anterior se quedan en la pestaña para quien entre después.
    await loginAs(page, FINANCIERA_USER);
    await page.evaluate(({ id, propio }) => {
      sessionStorage.setItem(`flito:conciliacion:aviso:${propio}:${id}`, JSON.stringify({
        soatConciliados: 7,
        totalConciliado: 3933300,
        cliente: { nombre: 'Transportes Andinos S.A.S.', descontado: 3371400, saldoResultante: 12450300 },
        transito: [],
        adoptados: 0,
      }));
    }, { id: BOLETA_ID, propio: FINANCIERA_USER.id });
    // Punto de partida: si esto fallara, lo de abajo pasaría en vacío.
    expect(await avisosGuardados(page)).toHaveLength(1);

    // 500 y no 401 a propósito: el 401 ya tiene su camino probado arriba, y es justo el que hace que
    // este parezca cubierto sin estarlo.
    await page.route('**/api/auth/me', (route) => route.fulfill(json({ error: 'Base no disponible' }, 500)));
    await page.goto(`/flito/conciliacion/${BOLETA_ID}`);
    await expect(page).toHaveURL(/\/login$/);

    expect(await avisosGuardados(page)).toEqual([]);
  });

  test('si el barrido tropieza con una clave, sigue con las demás, se entera y cierra la sesión igual', async ({ page }) => {
    // «No fallar» y «no enterarse» no son lo mismo. Con los dos bucles bajo un solo `try`, un
    // `removeItem` que lance a mitad deja las claves restantes sin borrar —saldos de bolsa vivos en
    // la pestaña— sin dejar ningún rastro de que el barrido se quedó a medias.
    const consola: string[] = [];
    page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') consola.push(m.text()); });

    await loginAs(page, FINANCIERA_USER);
    await mockDetalle(page, DETALLE_CONCILIADO);

    // OCHO claves, y el número no es decorativo. La otra propiedad que este archivo declara —recoger
    // las claves ANTES de borrar, porque `sessionStorage.key(i)` se reindexa en cada `removeItem` y
    // borrar mientras se itera se salta la mitad— con TRES claves no se distingue: el orden en que
    // Chromium las devuelve puede hacer que el barrido roto las toque todas igual, y entonces
    // reintroducir ese bug pasa desapercibido. Con ocho, el salteo deja fuera a varias y el aserto de
    // `intentadas` lo ve.
    const CLAVES = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `flito:conciliacion:aviso:${FINANCIERA_USER.id}:boleta-${n}`);
    await page.evaluate((claves) => {
      for (const clave of claves) sessionStorage.setItem(clave, '{"soatConciliados":1}');
    }, CLAVES);

    // La avería se instala con `addInitScript` y no con un `evaluate`: el parche vive en
    // `Storage.prototype`, que se reconstruye con cada documento, y entre sembrar las claves y cerrar
    // sesión hay una navegación de verdad. Con un `evaluate` el parche se pierde en ella y el caso
    // pasaría a probar un barrido que no tropieza con nada.
    //
    // Revienta la PRIMERA clave de aviso que se toque, sea cual sea, y no una elegida de antemano:
    // el orden en que `sessionStorage.key(i)` devuelve las claves no es el de inserción ni está
    // garantizado, así que fijar la bomba en una concreta hace que «se paró» y «siguió» coincidan
    // cuando la bomba cae la última. Así el corte es siempre en la primera y el resto siempre queda
    // por intentar. Y se apunta cada intento: es lo que el criterio pide comprobar —que las demás se
    // INTENTAN—, y no se puede deducir de qué claves quedaron.
    await page.addInitScript(() => {
      const intentos: string[] = [];
      (window as unknown as { intentosDeBarrido: string[] }).intentosDeBarrido = intentos;
      const original = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function bloqueado(this: Storage, k: string) {
        if (k.startsWith('flito:conciliacion:aviso:')) {
          intentos.push(k);
          if (intentos.length === 1) throw new DOMException('sessionStorage bloqueado', 'SecurityError');
        }
        return original.call(this, k);
      };
    });

    await page.goto(`/flito/conciliacion/${BOLETA_ID}`);
    await expect(page.getByRole('heading', { level: 1, name: /BOL-000123/ })).toBeVisible();

    await cerrarSesion(page);

    // Las TRES se intentaron: el tropiezo en la primera no se llevó por delante a las que faltaban.
    const intentadas = await page.evaluate(() =>
      (window as unknown as { intentosDeBarrido: string[] }).intentosDeBarrido);
    expect([...intentadas].sort()).toEqual([...CLAVES].sort());
    // Y solo sobrevive la que reventó, que es exactamente la que no se pudo borrar.
    expect(await avisosGuardados(page)).toEqual([intentadas[0]]);
    // El cierre de sesión se completó de todos modos: `cerrarSesion` ya exigió el /login.
    await expect(page).toHaveURL(/\/login$/);
    // Y no pasó inadvertido. Por el mismo canal que el resto del front usa para lo que falla y no
    // tumba la vista (`[pwa]`, `[ErrorBoundary]`): un aviso en la consola, con su etiqueta.
    expect(consola.some((l) => l.includes('[conciliacion]'))).toBe(true);
    // Sin identificadores en el aviso: dice cuántas quedaron, no cuáles. No es §14 —un `userId` y un
    // uuid no son PII para AGENTS.md— sino la higiene que el propio módulo se impone.
    expect(consola.join('\n')).not.toContain(BOLETA_ID);
    expect(consola.join('\n')).not.toContain(intentadas[0]);
  });

  test('si hasta el aviso por consola revienta, el cierre de sesión se completa igual', async ({ page }) => {
    // El barrido declara en su docblock que NO LANZA NUNCA, y la razón está escrita: `logout` llama a
    // `limpiarAvisos()` ANTES de `setUser(null)`, así que una excepción aquí deja la sesión sin
    // cerrar. Con el `console.warn` fuera de todo `try`, esa invariante pasó a depender de que
    // `console` exista y no lance —y el `warn` solo corre cuando algo YA falló, que es el peor
    // momento para descubrir que el aviso del fallo es lo que tumba el cierre—.
    //
    // Lo que se ve si se rompe: `handleLogout` navega a /login y DESPUÉS llama a `logout()`, así que
    // la excepción deja a `user` sin anular y la ruta /login —que es `user ? <Navigate to="/" /> …`—
    // rebota al tablero. Se sale de la sesión y se vuelve a entrar en ella sin token.
    await loginAs(page, FINANCIERA_USER);
    await mockDetalle(page, DETALLE_CONCILIADO);

    const CLAVES = [1, 2].map((n) => `flito:conciliacion:aviso:${FINANCIERA_USER.id}:boleta-${n}`);
    await page.evaluate((claves) => {
      for (const clave of claves) sessionStorage.setItem(clave, '{"soatConciliados":1}');
    }, CLAVES);

    // Dos averías a la vez, y las dos hacen falta: la del `removeItem` es la única forma de llegar al
    // `warn` —solo se emite cuando alguna clave no se pudo borrar—, y la del `console.warn` es la que
    // se está probando. `addInitScript` por lo mismo que en el caso de al lado: los dos parches viven
    // en objetos del documento y hay una navegación de por medio.
    //
    // El `warn` solo revienta para el mensaje de este módulo: reventar TODOS convertiría el caso en
    // «la app sobrevive sin consola», que es otra cosa y con otro alcance.
    await page.addInitScript(() => {
      const original = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function bloqueado(this: Storage, k: string) {
        if (k.startsWith('flito:conciliacion:aviso:')) {
          throw new DOMException('sessionStorage bloqueado', 'SecurityError');
        }
        return original.call(this, k);
      };
      const warn = console.warn.bind(console);
      console.warn = (...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].includes('[conciliacion]')) {
          // Se apunta ANTES de lanzar: sin esta marca el caso pasaría en verde aunque el `warn` no
          // llegara a emitirse nunca —suprimirlo del módulo lo dejaría sin señal propia— y estaría
          // certificando un cierre de sesión que no tropezó con nada.
          (window as unknown as { warnLanzado?: boolean }).warnLanzado = true;
          throw new TypeError('console.warn no disponible');
        }
        warn(...args);
      };
    });

    await page.goto(`/flito/conciliacion/${BOLETA_ID}`);
    await expect(page.getByRole('heading', { level: 1, name: /BOL-000123/ })).toBeVisible();

    // Y el cierre de sesión se completa: es lo único que este caso persigue. Que las claves se queden
    // sin borrar ya está dicho —el almacenamiento está roto a propósito— y no es lo que se prueba.
    await cerrarSesion(page);
    await expect(page.getByRole('heading', { name: 'Iniciar sesión' })).toBeVisible();

    // Y el `warn` SÍ se intentó: es lo que convierte el verde de arriba en una afirmación sobre este
    // camino y no sobre uno en el que no pasó nada. El cierre de sesión es SPA —navega, no recarga—,
    // así que la marca del documento sigue en pie después de salir.
    expect(await page.evaluate(() =>
      (window as unknown as { warnLanzado?: boolean }).warnLanzado === true)).toBe(true);
  });

  test('el aviso tampoco sobrevive en la OTRA pestaña, que arranca ya sin token', async ({ page, context }) => {
    // El cuarto camino del arranque, y el único de los cuatro que no hace ninguna petición.
    //
    // `localStorage` se comparte entre las pestañas del mismo origen; `sessionStorage` NO. Así que al
    // cerrar sesión en la pestaña 1 el token desaparece para las dos —es compartido— pero el barrido
    // solo alcanza al `sessionStorage` de la 1. La 2 no se entera de nada: no hay ni un
    // `addEventListener('storage', …)` en todo `apps/web/src`. Cuando esa pestaña se recarga, arranca
    // sin token y sale por el `return` de «sin token»; si esa rama no barre, quien entre después en
    // ella tiene a mano los saldos de bolsa de quien salió.
    await loginAs(page, FINANCIERA_USER);
    await mockLista(page, [RESUMEN]);
    await page.goto('/flito/conciliacion');
    await expect(page.getByRole('heading', { name: 'Conciliación', level: 1 })).toBeVisible();

    // La pestaña 2 **no inicia sesión**: hereda el token de la 1 sin escribirlo, que es la mitad del
    // mecanismo que hay que dar por probada antes de mirar la otra. Y navega UNA sola vez: pasar por
    // /login primero dejaría un `GET /auth/me` en vuelo que el siguiente `goto` abortaría, y su
    // `catch` —el del camino de arriba— barrería los avisos por la puerta de al lado, dando el caso
    // por bueno sin que la rama que se quiere probar hubiera corrido.
    const otra = await context.newPage();
    await otra.route('**/api/**', (route) => route.fulfill(json([])));
    await otra.route('**/api/auth/me', (route) => route.fulfill(json(FINANCIERA_USER)));
    await mockLista(otra, [RESUMEN]);
    await otra.goto('/flito/conciliacion');
    await expect(otra.getByRole('heading', { name: 'Conciliación', level: 1 })).toBeVisible();

    const CLAVE = `flito:conciliacion:aviso:${FINANCIERA_USER.id}:${BOLETA_ID}`;
    await otra.evaluate((clave) => {
      sessionStorage.setItem(clave, JSON.stringify({
        soatConciliados: 7,
        totalConciliado: 3933300,
        cliente: { nombre: 'Transportes Andinos S.A.S.', descontado: 3371400, saldoResultante: 12450300 },
        transito: [],
        adoptados: 0,
      }));
    }, CLAVE);
    expect(await avisosGuardados(otra)).toEqual([CLAVE]);

    // La sesión se cierra en la pestaña 1, por el menú de usuario, como se cierra de verdad.
    await cerrarSesion(page);

    // Las dos mitades del mecanismo, afirmadas por separado para que un fallo diga cuál se rompió.
    // El token SÍ cruza de pestaña —vive en `localStorage`—…
    expect(await otra.evaluate(() => localStorage.getItem('token'))).toBeNull();
    // …y el aviso NO —vive en `sessionStorage`—: sigue en la pestaña 2 hasta que ella misma lo barra.
    expect(await avisosGuardados(otra)).toEqual([CLAVE]);

    // Y el sitio donde barrerlo es este: al recargar, la pestaña 2 arranca sin token, y sin token no
    // hay ninguna sesión cuyo aviso convenga preservar.
    await otra.reload();
    await expect(otra).toHaveURL(/\/login$/);
    expect(await avisosGuardados(otra)).toEqual([]);

    await otra.close();
  });

  test('el aviso de otra persona no se pinta como si fuera el propio', async ({ page }) => {
    // El hallazgo Baja: el aviso guardado GANA sobre el reconstruido del detalle. Con la clave
    // atada solo a la boleta, la segunda persona que abriera esta boleta en la misma pestaña vería
    // los saldos que dejó la primera, presentados como los de ahora. Cifras de dinero, viejas.
    await loginAs(page, FINANCIERA_USER);
    await mockDetalle(page, DETALLE_CONCILIADO);

    // El aviso se siembra desde /login, que es donde `loginAs` deja la pestaña: hace falta un origin
    // para escribir en `sessionStorage`, y pasar antes por una pantalla de la app abortaría el
    // `GET /auth/me` en vuelo al navegar —su `catch` borra el token y el test acabaría en /login—.
    await page.evaluate(({ id, ajeno }) => {
      sessionStorage.setItem(`flito:conciliacion:aviso:${ajeno}:${id}`, JSON.stringify({
        soatConciliados: 7,
        totalConciliado: 3933300,
        cliente: { nombre: 'Transportes Andinos S.A.S.', descontado: 99999999, saldoResultante: 88888888 },
        transito: [],
        adoptados: 0,
      }));
    }, { id: BOLETA_ID, ajeno: FINANCIERA_USER.id + 1 });

    await page.goto(`/flito/conciliacion/${BOLETA_ID}`);
    const aviso = page.getByRole('status').filter({ hasText: 'Boleta conciliada' });
    await expect(aviso).toBeVisible();
    // Se pinta el reconstruido del detalle —que calla los saldos— y no el snapshot del vecino.
    await expect(aviso).not.toContainText('99.999.999');
    await expect(aviso).not.toContainText('88.888.888');

    // Y el control positivo, sin el cual lo de arriba pasaría también con la clave vieja —la que no
    // distingue usuario— por el simple hecho de no encontrar NADA: el aviso propio, bajo su propia
    // clave, sí se lee y sí pinta sus cifras.
    await page.evaluate(({ id, propio }) => {
      sessionStorage.setItem(`flito:conciliacion:aviso:${propio}:${id}`, JSON.stringify({
        soatConciliados: 7,
        totalConciliado: 3933300,
        cliente: { nombre: 'Transportes Andinos S.A.S.', descontado: 3371400, saldoResultante: 12450300 },
        transito: [],
        adoptados: 0,
      }));
    }, { id: BOLETA_ID, propio: FINANCIERA_USER.id });
    await page.reload();

    const propio = page.getByRole('status').filter({ hasText: 'Boleta conciliada' });
    await expect(propio).toContainText('12.450.300');
    await expect(propio).not.toContainText('88.888.888');
  });
});
