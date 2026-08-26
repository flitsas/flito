// HU #11899 — tema oscuro completo del kit FLIT (app + login).
//
// POR QUÉ EXISTE
// Hasta esta HU, `[data-theme='dark']` invertía tokens Aura (`--color-*`) y el dock / ⌘K, pero las
// superficies FLIT (`--flit-bg-app`, modal, tabla, `.flit-auth`) seguían en el par claro. Un
// FlitModal colgado de <body> heredaba tinta Aura clara sobre `--flit-bg-modal` celeste. Y con
// `aura-theme=system` el ThemeProvider QUITABA `data-theme`, así que las reglas `[data-theme='dark']`
// del kit no aplicaban aunque el OS estuviera en oscuro.
//
// Este spec es el contrapeso de `command-palette-oscuro.spec.ts`: no basta con que el dock o ⌘K
// cambien. Mide `data-theme`, los pares `--flit-*` y el píxel pintado en topbar, main, tabla,
// modal, login y dock. El gate estático `npm run check:contraste` (AC7) corre en Mode B; no vive
// aquí porque no necesita navegador.
//
// Patrón de tema: fijar `aura-theme` en localStorage ANTES del goto que se mide (igual que
// command-palette-oscuro / command-palette-claro). `light`/`dark` explícitos, no `system`, salvo
// el escenario AC2 que es precisamente `system` + OS oscuro.
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';
import {
  aHex, contraste, decodificarPng, fondoPintado, luminancia, tintaEfectiva, type RGB,
} from '../helpers/pixeles';

const MINIMO_AA = 4.5;
/** Elementos gráficos e indicadores de foco (SC 1.4.11). */
const MINIMO_GRAFICO = 3;
/** Superficie FLIT oscura: por debajo de esto no es el celeste #EAF2FF (luma ~0,89). */
const LUMA_MAX_OSCURO = 0.35;
/** Superficie FLIT clara o lienzo de documento: el par light y el PDF rasterizado viven aquí. */
const LUMA_MIN_CLARO = 0.7;

const CLARO = {
  bgApp: '#eaf2ff',
  bgModal: '#eef5ff',
  textPrimary: '#162744',
  bgTableHeader: '#f4f6fa',
} as const;

const TABLERO_VACIO = {
  soat: {}, impuestos: {}, revisionesPendientes: { soat: 0, impuestos: 0 },
  organismosSinClasificar: 0, tramitesRetenidos: 0, estancados: { soat: 0, impuestos: 0 },
  diferenciasDeValor: 0, compuertaHabilitados: 0,
};

const SOAT = {
  id: 's-tema-1', vin: 'VIN0000000000099', placa: 'TST099', marca: 'Prueba', linea: 'Tema',
  estado: 'pendiente', esMultiplePropietario: false, companiaNombre: 'Concesionario de pruebas',
  organismoNombre: 'STT Pruebas', proveedorSoatId: null, proveedorSoatNombre: null,
  compradores: [{ nombreCompleto: 'Persona Sintetica', numeroDocumento: '10000001', orden: 0, porcentajeParticipacion: null }],
  tramitesFlit: ['FLIT-9099'], tipoTramite: 'Matricula',
  fechaAprobacion: null, fechaCreacion: '2026-03-28T10:00:00Z',
  enviadoPorNombre: null, enviadoEn: null,
  pagadoEn: null, valorPagado: null, estancado: false, motivoRechazo: null, creadoEn: '2026-04-01T12:00:00Z',
  gestionOperaciones: false,
};

const FIXTURE_PDF = fileURLToPath(new URL('../fixtures/soporte-dos-paginas.pdf', import.meta.url));
const URL_SOPORTE = '/api/files?key=e2e-tema-pdf';

async function tokenRgb(page: Page, nombre: string): Promise<RGB> {
  return page.evaluate((n) => {
    const valor = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const lienzo = document.createElement('canvas');
    lienzo.width = 1;
    lienzo.height = 1;
    const ctx = lienzo.getContext('2d');
    if (!ctx) throw new Error('Sin contexto 2d');
    const CENTINELA = '#010203';
    ctx.fillStyle = CENTINELA;
    ctx.fillStyle = valor;
    if (ctx.fillStyle === CENTINELA) {
      throw new Error(`token ${n} no parseable: "${valor}"`);
    }
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]] as [number, number, number];
  }, nombre);
}

async function tokenTexto(page: Page, nombre: string): Promise<string> {
  return page.locator('html').evaluate(
    (el, n) => getComputedStyle(el).getPropertyValue(n).trim().toLowerCase().replace(/\s+/g, ' '),
    nombre,
  );
}

function esOscuro(c: RGB): boolean {
  return luminancia(c) < LUMA_MAX_OSCURO;
}

function esClaro(c: RGB): boolean {
  return luminancia(c) > LUMA_MIN_CLARO;
}

async function fijarTema(page: Page, tema: 'light' | 'dark' | 'system'): Promise<void> {
  await page.evaluate((t) => localStorage.setItem('aura-theme', t), tema);
}

async function mockSoat(page: Page): Promise<void> {
  await page.route('**/api/flito/tablero', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TABLERO_VACIO) }));
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));
  await page.route(/\/api\/flito\/soat\/facetas/, (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ companias: [], organismos: [], proveedores: [] }),
    }));
  await page.route(/\/api\/flito\/soat\?/, (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: [SOAT], total: 1, page: 1, pageSize: 50 }),
    }));
}

async function irALoginConTema(page: Page, tema: 'light' | 'dark' | 'system'): Promise<void> {
  await page.goto('/login');
  await page.evaluate((t) => {
    localStorage.removeItem('token');
    localStorage.setItem('aura-theme', t);
  }, tema);
  await page.goto('/login');
  await expect(page.locator('#login-username')).toBeVisible();
}

async function irASoatConTema(page: Page, tema: 'light' | 'dark' | 'system'): Promise<void> {
  await loginAs(page, OPERACIONES_USER);
  await mockSoat(page);
  await fijarTema(page, tema);
  await page.goto('/flito/soat');
  await expect(page.getByRole('heading', { name: 'SOAT', exact: true })).toBeVisible();
}

async function abrirModalSoat(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Ver' }).first().click();
  const modal = page.getByRole('dialog', { name: /SOAT · TST099/ });
  await expect(modal).toBeVisible();
  return modal;
}

const dock = (page: Page) => page.getByRole('navigation', { name: 'Navegación principal' });
const topbar = (page: Page) => page.getByRole('banner');
const tabla = (page: Page) => page.getByRole('region', { name: 'Pólizas SOAT' });

async function exigirParOscuroEnTokens(page: Page): Promise<void> {
  const bgApp = await tokenRgb(page, '--flit-bg-app');
  const bgModal = await tokenRgb(page, '--flit-bg-modal');
  const texto = await tokenRgb(page, '--flit-text-primary');
  const header = await tokenRgb(page, '--flit-bg-table-header');
  expect(aHex(bgApp), '--flit-bg-app no debe seguir siendo el celeste de :root').not.toBe(CLARO.bgApp);
  expect(aHex(bgModal), '--flit-bg-modal no debe seguir siendo el celeste de :root').not.toBe(CLARO.bgModal);
  expect(aHex(texto), '--flit-text-primary no debe seguir siendo el navy de :root').not.toBe(CLARO.textPrimary);
  expect(aHex(header), '--flit-bg-table-header no debe seguir siendo el claro de :root').not.toBe(CLARO.bgTableHeader);
  expect(esOscuro(bgApp), `--flit-bg-app ${aHex(bgApp)} luma ${luminancia(bgApp).toFixed(2)}`).toBe(true);
  expect(esOscuro(bgModal), `--flit-bg-modal ${aHex(bgModal)}`).toBe(true);
  expect(esClaro(texto) || luminancia(texto) > 0.55, `--flit-text-primary ${aHex(texto)} debe ser tinta clara en oscuro`).toBe(true);

  // HUECO QUE ESTE HELPER TENÍA (QA, modo B de la #11899). Todo lo de arriba es LUMA: comprueba
  // que cada token esté en el lado oscuro (o claro) de la escala, NO que se vean uno contra otro.
  // Un par oscuro coherente y a la vez ilegible pasaba entero por aquí —es el mutante TC-15:
  // `--flit-bg-app: #0B1220` con `--flit-text-primary: #101827`, los dos bien oscuros, 1,05:1— y
  // con él pasaría cualquier regresión que oscureciera la tinta sin tocar el fondo. El shell viejo,
  // con sus 1,52:1, también pasaba. Se mide el RATIO, que es lo que pide el AC7 (texto ≥ 4,5:1), y
  // contra las cuatro superficies, porque la tinta cae sobre las cuatro y no solo sobre la app
  // (lección del Bug #11604, repetida en el otro tema).
  const superficies = [
    ['--flit-bg-app', bgApp],
    ['--flit-bg-modal', bgModal],
    ['--flit-bg-card', await tokenRgb(page, '--flit-bg-card')],
    ['--flit-bg-table-header', header],
  ] as const;
  for (const [nombre, fondo] of superficies) {
    const r = contraste(texto, fondo);
    expect(
      r,
      `--flit-text-primary ${aHex(texto)} sobre ${nombre} ${aHex(fondo)} → ${r.toFixed(2)}`,
    ).toBeGreaterThanOrEqual(MINIMO_AA);
  }
}

/** Color REAL de una franja de pantalla: el más repetido dentro del recorte. */
async function colorDeFranja(
  page: Page,
  clip: { x: number; y: number; width: number; height: number },
): Promise<RGB> {
  const png = await page.screenshot({ clip, animations: 'disabled' });
  const { ancho, alto, datos } = decodificarPng(png);
  const cuenta = new Map<number, number>();
  for (let i = 0; i < ancho * alto; i++) {
    const clave = (datos[i * 4] << 16) | (datos[i * 4 + 1] << 8) | datos[i * 4 + 2];
    cuenta.set(clave, (cuenta.get(clave) ?? 0) + 1);
  }
  let mejor = 0;
  let veces = 0;
  for (const [clave, n] of cuenta) {
    if (n > veces) {
      veces = n;
      mejor = clave;
    }
  }
  return [(mejor >> 16) & 0xff, (mejor >> 8) & 0xff, mejor & 0xff];
}

async function exigirParClaroEnTokens(page: Page): Promise<void> {
  expect(aHex(await tokenRgb(page, '--flit-bg-app'))).toBe(CLARO.bgApp);
  expect(aHex(await tokenRgb(page, '--flit-bg-modal'))).toBe(CLARO.bgModal);
  expect(aHex(await tokenRgb(page, '--flit-text-primary'))).toBe(CLARO.textPrimary);
  expect(aHex(await tokenRgb(page, '--flit-bg-table-header'))).toBe(CLARO.bgTableHeader);
}

async function lumaPintada(page: Page, loc: Locator): Promise<number> {
  const { color } = await fondoPintado(page, loc);
  return luminancia(color);
}

test.describe('Kit FLIT · tema oscuro completo (HU #11899)', () => {
  test.use({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });

  test('TC-01 AC1 · dark explícito pinta login, topbar, main, tabla, modal y dock — no solo el dock', async ({ page }) => {
    await irALoginConTema(page, 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await exigirParOscuroEnTokens(page);
    const auth = page.locator('.flit-auth');
    await expect(auth).toBeVisible();
    expect(esOscuro(await tokenRgb(page, '--flit-bg-app')), '.flit-auth debe resolver el par oscuro de --flit-bg-app').toBe(true);
    const lumaAuth = await lumaPintada(page, page.locator('.flit-auth main'));
    expect(lumaAuth, `login main luma ${lumaAuth.toFixed(2)}: el formulario no puede seguir en celeste`).toBeLessThan(LUMA_MAX_OSCURO);

    await irASoatConTema(page, 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await exigirParOscuroEnTokens(page);

    const lumaTopbar = await lumaPintada(page, topbar(page));
    const lumaMain = await lumaPintada(page, page.locator('.flit-app main').first());
    const lumaTabla = await lumaPintada(page, tabla(page));
    const lumaDock = await lumaPintada(page, dock(page));
    expect(lumaTopbar, `topbar luma ${lumaTopbar.toFixed(2)}`).toBeLessThan(LUMA_MAX_OSCURO);
    expect(lumaMain, `main luma ${lumaMain.toFixed(2)}`).toBeLessThan(LUMA_MAX_OSCURO);
    expect(lumaTabla, `tabla luma ${lumaTabla.toFixed(2)}`).toBeLessThan(LUMA_MAX_OSCURO);
    expect(lumaDock, `dock luma ${lumaDock.toFixed(2)}`).toBeLessThan(LUMA_MAX_OSCURO);

    const modal = await abrirModalSoat(page);
    const lumaModal = await lumaPintada(page, modal);
    expect(lumaModal, `modal luma ${lumaModal.toFixed(2)}`).toBeLessThan(LUMA_MAX_OSCURO);
  });

  test('TC-02 AC3 · light explícito deja data-theme=light y ninguna superficie FLIT ensucia con el par oscuro', async ({ page }) => {
    await irALoginConTema(page, 'light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await exigirParClaroEnTokens(page);
    const lumaAuth = await lumaPintada(page, page.locator('.flit-auth main'));
    expect(lumaAuth, `login main en light luma ${lumaAuth.toFixed(2)}`).toBeGreaterThan(LUMA_MIN_CLARO);

    await irASoatConTema(page, 'light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await exigirParClaroEnTokens(page);
    expect(await lumaPintada(page, topbar(page))).toBeGreaterThan(LUMA_MIN_CLARO);
    expect(await lumaPintada(page, page.locator('.flit-app main').first())).toBeGreaterThan(LUMA_MIN_CLARO);
    expect(await lumaPintada(page, tabla(page))).toBeGreaterThan(LUMA_MIN_CLARO);

    const modal = await abrirModalSoat(page);
    expect(await lumaPintada(page, modal)).toBeGreaterThan(LUMA_MIN_CLARO);
    expect(aHex(await tokenRgb(page, '--flit-bg-modal'))).toBe(CLARO.bgModal);
  });

  test('TC-03 AC4 · FlitModal en portal usa --flit-text-primary sobre --flit-bg-modal oscuro, no tinta Aura sobre celeste', async ({ page }) => {
    await irASoatConTema(page, 'dark');
    const modal = await abrirModalSoat(page);
    // El diálogo cuelga de <body> (ModalPortal): si el scope `.flit-modal` no resuelve el par
    // oscuro, el texto hereda `--color-text-primary` Aura (#f0eee9) sobre #EEF5FF.
    const { color: fondo } = await fondoPintado(page, modal);
    const titulo = modal.locator('h2');
    const tinta = await tintaEfectiva(titulo, fondo);
    const ratio = contraste(tinta, fondo);
    expect(esOscuro(fondo), `fondo modal ${aHex(fondo)} sigue siendo celeste Aura/FLIT claro`).toBe(true);
    expect(aHex(fondo), 'el modal no puede quedarse en --flit-bg-modal :root').not.toBe(CLARO.bgModal);
    expect(ratio, `${aHex(tinta)} sobre ${aHex(fondo)} → ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(MINIMO_AA);

    const colorModal = await modal.evaluate((el) => getComputedStyle(el).color);
    const colorAura = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-text-primary').trim());
    const bgModalToken = aHex(await tokenRgb(page, '--flit-bg-modal'));
    expect(bgModalToken).not.toBe(CLARO.bgModal);
    // Si el fondo se quedó celeste, cualquier tinta Aura clara es el bug del AC4.
    if (!esOscuro(fondo)) {
      throw new Error(`AC4: modal celeste ${aHex(fondo)} con color computado "${colorModal}" (Aura --color-text-primary=${colorAura})`);
    }
  });

  test('TC-04 AC5 · login en dark sigue storage y no ofrece toggle de tema', async ({ page }) => {
    await irALoginConTema(page, 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('.flit-auth')).toBeVisible();
    await exigirParOscuroEnTokens(page);
    await expect(page.getByRole('button', { name: /Cambiar a tema/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Tema (claro|oscuro|del sistema)$/i })).toHaveCount(0);
  });

  test('TC-05 AC5 borde · login en light tampoco muestra toggle y respeta storage', async ({ page }) => {
    await irALoginConTema(page, 'light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await exigirParClaroEnTokens(page);
    await expect(page.getByRole('button', { name: /Cambiar a tema/i })).toHaveCount(0);
  });

  test('TC-06 AC6 · drawer sigue el gradiente de marca; overlay de captura y lienzo PDF no adoptan el par oscuro de app', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockSoat(page);
    await fijarTema(page, 'dark');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/flito/soat');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    const gradienteDark = await tokenTexto(page, '--flit-gradient-sidebar');
    expect(gradienteDark, 'el drawer es isla de marca: el token no se apaga a un sólido oscuro').toMatch(/flit-cyan-ink|1e7b75/i);
    expect(gradienteDark).toMatch(/flit-blue-ink|4264b7/i);

    await page.getByRole('button', { name: 'Abrir menú de navegación' }).click();
    const drawer = page.getByRole('dialog', { name: 'Menú de navegación' });
    await expect(drawer).toBeVisible();
    // Primer `div` hijo: el panel con `background: var(--flit-gradient-sidebar)` (FlitSidebar).
    const panel = drawer.locator(':scope > div').first();
    const bgImage = await panel.evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(bgImage, 'FlitSidebar debe pintar --flit-gradient-sidebar, no el par --flit-bg-app').toMatch(/linear-gradient/i);
    expect(bgImage.toLowerCase()).not.toContain(CLARO.bgApp);

    const overlayBg = await tokenTexto(page, '--color-capture-overlay-bg');
    const overlayFg = await tokenTexto(page, '--color-capture-on-dark');
    expect(overlayBg.replace(/\s+/g, '')).toMatch(/rgba?\(0,\s*0,\s*0,\s*0\.92\)/);
    expect(overlayFg.length, '--color-capture-on-dark no debe vaciarse en dark').toBeGreaterThan(0);

    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route(/\/api\/flito\/derechos\/facetas/, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ organismos: ['05001'], origenes: ['manual'] }),
    }));
    await page.route(/\/api\/flito\/derechos\?/, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        items: [{
          id: 'd-tema-1', tramiteId: 't-tema-1', idFlit: 'FLIT-9099', placa: 'TST099', organismoCodigo: '05001',
          empresa: 'Concesionario de pruebas', valor: '236700.00', fechaPago: '2026-05-23',
          numeroRadicado: '9000000099', tipoTramiteRecibo: 'MATRICULA INICIAL', origen: 'manual',
          advertencias: null, soporteId: 'sop-tema-1', createdAt: '2026-05-23T10:00:00Z',
          archivoOrigen: 'soporte-dos-paginas.pdf', paginas: null, procesamientoId: null, procesamientoArchivo: null,
        }],
        total: 1, page: 1, pageSize: 50,
      }),
    }));
    await page.route(/\/api\/finanzas\/tramites\/.*\/soportes/, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify([{
        id: 'sop-tema-1', origen: 'derecho', tipo: 'derecho_tramite',
        nombreArchivo: 'soporte-dos-paginas.pdf', url: URL_SOPORTE, subidoEn: '2026-05-23T10:00:00Z',
      }]),
    }));
    await page.route(URL_SOPORTE, (route) =>
      route.fulfill({ status: 200, contentType: 'application/pdf', path: FIXTURE_PDF }));

    await page.goto('/flito/derechos');
    await page.getByRole('row', { name: /FLIT-9099/ }).getByRole('button', { name: 'Ver todos' }).click();
    const paginaPdf = page.locator('img[alt*=" — página "]').first();
    await expect(paginaPdf).toBeVisible({ timeout: 20_000 });
    const lumaLienzo = await lumaPintada(page, paginaPdf);
    expect(
      lumaLienzo,
      `lienzo PDF luma ${lumaLienzo.toFixed(2)}: la hoja rasterizada no puede adoptar --flit-bg-app oscuro`,
    ).toBeGreaterThan(LUMA_MIN_CLARO);
  });

  // TC-08 y TC-09 son el oráculo de PÍXEL del AC7. El gate `npm run check:contraste` mide los
  // TOKENS leyendo el CSS con un parser propio: sabe lo que el archivo DICE, no lo que el
  // navegador PINTA. Es el mismo hueco que produjo el Bug #11720 (un modelo de capas que se saltó
  // una barra) con el signo cambiado: aquí la cascada real puede no llegar —selector que no
  // dispara, `!important` de otro sitio, una clase de Tailwind que gana— y el gate seguiría verde
  // porque el archivo está bien escrito. Estos dos casos leen el resultado compuesto.

  test('TC-08 AC7 · el texto del producto en oscuro cumple 4,5:1 sobre el píxel realmente pintado', async ({ page }) => {
    await irASoatConTema(page, 'dark');

    const puntos: Array<[string, Locator]> = [
      ['título de página', page.getByRole('heading', { name: 'SOAT', exact: true })],
      ['subtítulo de la tarjeta de cabecera', page.getByText('Cola de adquisición del SOAT', { exact: false })],
      ['trigger ⌘K de la topbar', topbar(page).getByRole('button', { name: /Buscar o ir a sección/ })],
      ['cabecera de tabla', tabla(page).locator('th').filter({ hasText: /\S/ }).first()],
      ['celda de tabla', tabla(page).getByRole('cell').filter({ hasText: 'TST099' }).first()],
    ];

    const medidas: string[] = [];
    for (const [nombre, loc] of puntos) {
      await expect(loc, `${nombre}: no está en pantalla, el caso no mide nada`).toBeVisible();
      const { color: fondo, cobertura } = await fondoPintado(page, loc);
      const tinta = await tintaEfectiva(loc, fondo);
      const ratio = contraste(tinta, fondo);
      medidas.push(`${nombre}: ${aHex(tinta)} sobre ${aHex(fondo)} → ${ratio.toFixed(2)}`);
      // Una cobertura baja significa que la moda NO es un fondo plano (gradiente, imagen, mucho
      // glifo): el número saldría de un píxel que no representa la superficie. Se dice en voz alta
      // en vez de aprobar o suspender con una medición que no vale.
      expect(cobertura, `${nombre}: el fondo dominante solo cubre ${(cobertura * 100).toFixed(0)} %`)
        .toBeGreaterThan(0.5);
      expect(
        esOscuro(fondo),
        `${nombre}: fondo pintado ${aHex(fondo)} (luma ${luminancia(fondo).toFixed(2)}) sigue siendo superficie clara`,
      ).toBe(true);
      expect(ratio, `${nombre}: ${aHex(tinta)} sobre ${aHex(fondo)} → ${ratio.toFixed(2)}`)
        .toBeGreaterThanOrEqual(MINIMO_AA);
    }
    console.log(`TC-08 · píxel medido en oscuro\n  ${medidas.join('\n  ')}`);
  });

  test('TC-09 AC7 · el anillo de foco pintado cumple 3:1 contra su superficie en los dos temas', async ({ page }) => {
    // El anillo es el ÚNICO borde con umbral duro (SC 1.4.11, indicador de foco): los separadores
    // `--flit-border-soft` / `--flit-border-input` quedaron eximidos por decisión de producto
    // (26 ago 2026) y el gate los mide como separadores. Éste no se relaja, y se comprueba donde
    // importa: en el píxel, no en el archivo CSS.
    for (const tema of ['light', 'dark'] as const) {
      await irASoatConTema(page, tema);
      const buscador = page.getByPlaceholder('Buscar placa, VIN, comprador…');
      await expect(buscador).toBeVisible();
      const tarjeta = page.locator('div.bg-flit-card').filter({ has: buscador }).first();
      const { color: superficie } = await fondoPintado(page, tarjeta);
      const caja = await buscador.boundingBox();
      if (!caja) throw new Error(`tema ${tema}: el buscador no tiene caja.`);

      // `box-shadow: 0 0 0 3px` sin desenfoque ⇒ los 3 px pegados al borde izquierdo son anillo
      // puro. A media altura el radio de esquina no llega, así que el píxel es plano.
      const y = caja.y + caja.height / 2 - 4;
      const franjaAnillo = { x: caja.x - 3, y, width: 3, height: 8 };
      const franjaFuera = { x: caja.x - 9, y, width: 3, height: 8 };

      const sinFoco = await colorDeFranja(page, franjaAnillo);
      await buscador.click();
      await expect(buscador).toBeFocused();
      expect(
        await buscador.evaluate((el) => el.matches(':focus-visible')),
        `tema ${tema}: el input no entra en :focus-visible, así que la regla del anillo ni siquiera aplica`,
      ).toBe(true);

      const anillo = await colorDeFranja(page, franjaAnillo);
      const fuera = await colorDeFranja(page, franjaFuera);
      const token = await tokenRgb(page, '--flit-border-focus');

      // Adyacencia: si la muestra de «fuera» no es la tarjeta, se está midiendo contra otra cosa
      // (una pill, un hueco). Mejor romper aquí que dar un ratio que no significa nada.
      expect(
        aHex(fuera),
        `tema ${tema}: la muestra contigua ${aHex(fuera)} no es la superficie de tarjeta ${aHex(superficie)}`,
      ).toBe(aHex(superficie));
      expect(
        aHex(anillo),
        `tema ${tema}: enfocar no cambió el píxel contiguo (${aHex(sinFoco)}): no hay anillo pintado`,
      ).not.toBe(aHex(sinFoco));
      // El anillo tiene que SALIR del token. Con un rgba() suelto —como el que había antes de esta
      // HU— el píxel y lo que mide `check:contraste` dejan de ser la misma cosa, y el gate pasa a
      // certificar un color que nadie ve.
      expect(
        aHex(anillo),
        `tema ${tema}: el anillo pinta ${aHex(anillo)} pero --flit-border-focus vale ${aHex(token)}; `
        + 'el gate estático estaría midiendo un color distinto del que se ve',
      ).toBe(aHex(token));

      const ratio = contraste(anillo, fuera);
      console.log(`TC-09 · tema ${tema}: anillo ${aHex(anillo)} sobre ${aHex(fuera)} → ${ratio.toFixed(2)}`);
      expect(
        ratio,
        `tema ${tema}: anillo ${aHex(anillo)} sobre ${aHex(fuera)} → ${ratio.toFixed(2)} (SC 1.4.11 pide 3)`,
      ).toBeGreaterThanOrEqual(MINIMO_GRAFICO);
    }
  });
});

test.describe('Kit FLIT · system + OS oscuro (HU #11899 AC2)', () => {
  test.use({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });

  test('TC-07 AC2 · system no quita data-theme: html queda dark y el visual iguala al dark explícito', async ({ page }) => {
    await irALoginConTema(page, 'system');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await exigirParOscuroEnTokens(page);
    expect(await lumaPintada(page, page.locator('.flit-auth main'))).toBeLessThan(LUMA_MAX_OSCURO);

    await irASoatConTema(page, 'system');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await exigirParOscuroEnTokens(page);
    expect(await lumaPintada(page, topbar(page))).toBeLessThan(LUMA_MAX_OSCURO);
    expect(await lumaPintada(page, page.locator('.flit-app main').first())).toBeLessThan(LUMA_MAX_OSCURO);
    expect(await lumaPintada(page, tabla(page))).toBeLessThan(LUMA_MAX_OSCURO);
    expect(await lumaPintada(page, dock(page))).toBeLessThan(LUMA_MAX_OSCURO);
    const modal = await abrirModalSoat(page);
    expect(await lumaPintada(page, modal)).toBeLessThan(LUMA_MAX_OSCURO);
  });
});
