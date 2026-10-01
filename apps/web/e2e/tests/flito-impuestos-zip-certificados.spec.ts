// FLITO — «Descargar certificados» en ZIP desde la cola de Impuestos (HU #13206, Feature #12954).
//
// Red mockeada con `page.route`: el endpoint es el de la HU #13205
// (`POST /api/flito/impuestos/certificados/zip`). Cada caso afirma sobre la PETICIÓN interceptada
// (cuántas salieron y con qué cuerpo) además de sobre lo que se ve: un aviso correcto con una
// segunda petición escondida, o con los ids en la URL, sería un verde mentiroso.
//
// Los datos son SINTÉTICOS. Ni un dato real entra en un spec.
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, AUDITOR_USER, FUNCIONES_POR_ROL, OPERACIONES_USER } from '../helpers/auth';
import { ZIP_SOPORTES_MAX_REGISTROS } from '@operaciones/shared-types';

const CT_ZIP = 'application/zip';
const CUERPO_ZIP = 'PKFLITO-E2E';
/** Fecha que el reloj del cliente no puede producir: prueba que el nombre es el del servidor. */
const NOMBRE_ZIP = 'certificados-runt_20991231-2359.zip';
const RUTA_ZIP = /\/api\/flito\/impuestos\/certificados\/zip$/;
/** Un uuid que NO está en la cola: el 409 lo trae como `no_disponible` y no debe pintarse. */
const UUID_AJENO = '0b8f6d2e-1c3a-4e5f-9a7b-2d4c6e8f0a1b';

const CERT_VIGENTE = {
  id: 'cert-1', certificadoEn: '2026-08-01T15:00:00Z', certificadoPorNombre: 'gestor@flitsas.io',
};

const fila = (id: string, placa: string, estado: string, certificacion: unknown = null) => ({
  id, tramiteId: `t${id}`, idFlit: `FLIT-${id}`, placa, vin: 'VIN0000000000001',
  marca: 'Chevrolet', linea: 'Onix', tipoTramite: 'Matricula', fechaAprobacion: null,
  fechaCreacion: '2026-03-28T10:00:00Z', estado, compradorNombre: null, compradorDocumento: null,
  companiaNombre: 'Concesionario Norte', organismoCodigo: 'STT-MZL', organismoNombre: 'STT Manizales',
  valorLiquidado: 120000, valorPagado: null, marcadoPorDiferencia: false, tieneFacturaVenta: true,
  enviadoPorNombre: null, enviadoEn: null, pagadoEn: null, estancado: false, motivoRechazo: null,
  gestionOperaciones: false, certificacion, creadoEn: '2026-03-28T10:00:00Z',
});

/** Un solicitado sin certificar (certificable), uno certificado y uno pagado. */
const COLA = [
  fila('i1', 'ABC123', 'solicitado'),
  fila('i2', 'XYZ789', 'solicitado', CERT_VIGENTE),
  fila('i3', 'DEF456', 'pagado', CERT_VIGENTE),
];

const json = (route: Route, body: unknown) => route.fulfill({
  status: 200, contentType: 'application/json', body: JSON.stringify(body),
});

async function montar(page: Page, items: unknown[] = COLA) {
  await page.route(/\/api\/flito\/impuestos\/facetas/, (r) => json(r, { companias: [], organismos: [] }));
  await page.route(/\/api\/flito\/impuestos\?/, (r) =>
    json(r, { items, total: items.length, page: 1, pageSize: 500 }));
}

interface Respuesta { status: number; contentType?: string; headers?: Record<string, string>; body?: string }
interface Traza {
  peticiones: Array<{ url: string; cuerpo: unknown }>;
  respuesta: Respuesta;
  /** Si se pone, la respuesta espera a que se resuelva (AC5). */
  retener?: Promise<void>;
}

const ZIP_OK = (omitidos: string | null): Respuesta => ({
  status: 200,
  headers: {
    'content-disposition': `attachment; filename="${NOMBRE_ZIP}"`,
    ...(omitidos === null ? {} : { 'x-certificados-omitidos': omitidos }),
    'access-control-expose-headers': 'X-Certificados-Omitidos, Content-Disposition',
  },
});

const ERROR = (status: number, cuerpo: unknown): Respuesta => ({
  status, contentType: 'application/json', body: JSON.stringify(cuerpo),
});

async function mockZip(page: Page, inicial: Respuesta) {
  const traza: Traza = { peticiones: [], respuesta: inicial };
  await page.route(RUTA_ZIP, async (route: Route) => {
    const req = route.request();
    traza.peticiones.push({ url: req.url(), cuerpo: req.postDataJSON() });
    if (traza.retener) await traza.retener;
    const r = traza.respuesta;
    return route.fulfill({
      status: r.status,
      contentType: r.contentType ?? CT_ZIP,
      headers: r.headers ?? {},
      body: r.body ?? CUERPO_ZIP,
    });
  });
  return traza;
}

const botonCert = (page: Page) => page.getByRole('button', { name: /^(Descargar certificados RUNT|Preparando el ZIP de certificados)/ });
const botonSoportes = (page: Page) => page.getByRole('button', { name: /^Descargar soportes \(/ });
const casillaCabecera = (page: Page) =>
  page.getByRole('checkbox', { name: 'Seleccionar las filas de esta página' });
const tarjeta = (page: Page) => page.locator('[data-tono]').filter({ hasText: /ZIP|certificad/ });

async function marcar(page: Page, ...placas: string[]) {
  for (const placa of placas) await page.getByLabel(`Seleccionar ${placa}`).check();
}

async function entrar(page: Page, usuario = OPERACIONES_USER, items: unknown[] = COLA) {
  await loginAs(page, usuario);
  await montar(page, items);
  await page.goto('/flito/impuestos');
  await expect(page.getByText('ABC123').first()).toBeVisible();
}

// ═══════════════════════════════════════════ AC1 ════════════════════════════════════════════════

test.describe('HU #13206 — AC1: descarga masiva con conteo', () => {
  test('completo: ids en el CUERPO, nombre del servidor y «N certificados»', async ({ page }) => {
    const traza = await mockZip(page, ZIP_OK('0'));
    await entrar(page);
    await marcar(page, 'ABC123', 'XYZ789', 'DEF456');

    await expect(botonCert(page)).toHaveText('Descargar certificados (3)');
    await expect(botonCert(page)).toHaveAttribute('aria-label', 'Descargar certificados RUNT de 3 registros marcados');
    // Pegado a su hermano en la barra.
    await expect(botonSoportes(page)).toBeVisible();
    await botonCert(page).click();

    await expect(tarjeta(page)).toHaveText(new RegExp(`ZIP descargado: ${NOMBRE_ZIP} — 3 certificados\\.`));
    await expect(tarjeta(page)).toHaveAttribute('data-tono', 'ok');
    expect(traza.peticiones).toHaveLength(1);
    expect(traza.peticiones[0].cuerpo).toEqual({ ids: ['i1', 'i2', 'i3'] });
    expect(new URL(traza.peticiones[0].url).search).toBe('');
    // La línea de desajuste nombra las dos descargas.
    await expect(page.getByText(/Descargar soportes y certificados usan las 3\./)).toBeVisible();
  });

  test('parcial: la cifra sale de X-Certificados-Omitidos y remite a omitidos.csv', async ({ page }) => {
    await mockZip(page, ZIP_OK('2'));
    await entrar(page);
    await marcar(page, 'ABC123', 'XYZ789', 'DEF456');
    await botonCert(page).click();

    await expect(tarjeta(page).locator('p').first()).toHaveText(
      `ZIP descargado: ${NOMBRE_ZIP} — 1 de las 3 filas marcadas tenía certificado; las otras 2 quedaron `
      + 'fuera. En omitidos.csv, dentro del ZIP, está cuáles y por qué.',
    );
    await expect(tarjeta(page)).toHaveAttribute('data-tono', 'aviso');
    await page.getByRole('button', { name: 'Cerrar el aviso' }).click();
    await expect(tarjeta(page)).toHaveCount(0);
  });

  test('sin cabecera legible: no inventa cifras', async ({ page }) => {
    await mockZip(page, ZIP_OK('x'));
    await entrar(page);
    await marcar(page, 'ABC123', 'XYZ789');
    await botonCert(page).click();
    await expect(tarjeta(page).locator('p').first()).toHaveText(`ZIP descargado: ${NOMBRE_ZIP}.`);
  });
});

// ═══════════════════════════════════════════ AC2 ════════════════════════════════════════════════

test.describe('HU #13206 — AC2: todos omitidos (409)', () => {
  test('lista por causa, placas y no uuids, sin el error crudo ni reintento', async ({ page }) => {
    const traza = await mockZip(page, ERROR(409, {
      error: 'TEXTO CRUDO DEL SERVIDOR', codigo: 'zip_sin_certificados',
      omitidos: [
        { identificador: 'ABC123', causa: 'sin_certificacion_vigente' },
        { identificador: 'i2', causa: 'no_disponible' },
        { identificador: UUID_AJENO, causa: 'no_disponible' },
      ],
    }));
    await entrar(page);
    await marcar(page, 'ABC123', 'XYZ789', 'DEF456');
    await botonCert(page).click();

    const alerta = page.getByRole('alert').filter({ hasText: 'No se descargó nada' });
    await expect(alerta).toContainText('Ninguna de las 3 filas marcadas tiene un certificado para descargar. No se descargó nada.');
    const causas = alerta.getByRole('listitem');
    await expect(causas).toHaveCount(2);
    await expect(causas.nth(0)).toContainText('Sin certificación vigente (1): ABC123');
    await expect(causas.nth(0)).toContainText('Certifícalas con «Certificar»');
    await expect(causas.nth(1)).toContainText('Ya no están en tu cola (2): XYZ789, un registro');
    await expect(causas.nth(1)).toContainText('Actualiza la página');

    await expect(page.getByText(UUID_AJENO)).toHaveCount(0);
    await expect(page.getByText(/TEXTO CRUDO|zip_sin_certificados|sin_certificacion_vigente/)).toHaveCount(0);
    await expect(alerta.getByRole('button', { name: 'Reintentar la descarga' })).toHaveCount(0);
    expect(traza.peticiones).toHaveLength(1);
  });

  test('409 sin lista legible: encabezado + dónde mirar', async ({ page }) => {
    await mockZip(page, ERROR(409, { error: 'x', codigo: 'zip_sin_certificados' }));
    await entrar(page);
    await marcar(page, 'ABC123');
    await botonCert(page).click();
    const alerta = page.getByRole('alert').filter({ hasText: 'No se descargó nada' });
    await expect(alerta).toContainText('La fila marcada no tiene un certificado para descargar.');
    await expect(alerta).toContainText('Revisa en la cola cuáles no tienen el chip «Certificado».');
  });
});

// ═══════════════════════════════════════════ AC3 ════════════════════════════════════════════════

test.describe('HU #13206 — AC3: tope y frecuencia', () => {
  test(`más de ${ZIP_SOPORTES_MAX_REGISTROS}: aviso con el tope y CERO peticiones`, async ({ page }) => {
    const muchas = [...Array(ZIP_SOPORTES_MAX_REGISTROS + 1)].map(
      (_, n) => fila(`m${n}`, `TOP${String(n).padStart(3, '0')}`, 'pagado', CERT_VIGENTE),
    );
    const traza = await mockZip(page, ZIP_OK('0'));
    await loginAs(page, OPERACIONES_USER);
    await montar(page, muchas);
    await page.goto('/flito/impuestos');
    await casillaCabecera(page).check();
    await botonCert(page).click();

    const n = ZIP_SOPORTES_MAX_REGISTROS + 1;
    await expect(page.getByRole('alert')).toContainText(
      `Solo se pueden descargar los certificados de ${ZIP_SOPORTES_MAX_REGISTROS} registros a la vez y marcaste ${n}. Marca menos filas y vuelve a intentarlo.`,
    );
    expect(traza.peticiones).toHaveLength(0);
  });

  test('400 zip_demasiados_registros del servidor: el mismo copy, no el eco', async ({ page }) => {
    await mockZip(page, ERROR(400, { error: 'Solo se pueden descargar los documentos…', codigo: 'zip_demasiados_registros' }));
    await entrar(page);
    await marcar(page, 'ABC123', 'XYZ789');
    await botonCert(page).click();
    await expect(page.getByRole('alert')).toContainText(
      `Solo se pueden descargar los certificados de ${ZIP_SOPORTES_MAX_REGISTROS} registros a la vez y marcaste 2.`,
    );
    await expect(page.getByText('los documentos…')).toHaveCount(0);
  });

  test('429: espera 1 minuto y «Reintentar la descarga» repite los mismos ids', async ({ page }) => {
    const traza = await mockZip(page, ERROR(429, { error: 'Demasiadas descargas seguidas, espera 1 minuto' }));
    await entrar(page);
    await marcar(page, 'ABC123', 'DEF456');
    await botonCert(page).click();

    const alerta = page.getByRole('alert');
    await expect(alerta).toContainText('Hiciste varias descargas de certificados seguidas. Espera 1 minuto y vuelve a intentarlo.');
    traza.respuesta = ZIP_OK('0');
    await alerta.getByRole('button', { name: 'Reintentar la descarga' }).click();
    await expect(tarjeta(page)).toHaveText(new RegExp('— 2 certificados\\.'));
    expect(traza.peticiones.map((p) => p.cuerpo)).toEqual([{ ids: ['i1', 'i3'] }, { ids: ['i1', 'i3'] }]);
  });

  test('403: copy propio, sin reintento', async ({ page }) => {
    await mockZip(page, ERROR(403, { error: 'Forbidden crudo' }));
    await entrar(page);
    await marcar(page, 'ABC123');
    await botonCert(page).click();
    const alerta = page.getByRole('alert');
    await expect(alerta).toContainText('No tienes permiso para descargar certificados RUNT. Pídeselo a un administrador.');
    await expect(alerta.getByRole('button', { name: 'Reintentar la descarga' })).toHaveCount(0);
    await expect(page.getByText('Forbidden crudo')).toHaveCount(0);
  });

  test('500: respaldo genérico con reintento, sin el texto del servidor', async ({ page }) => {
    await mockZip(page, ERROR(500, { error: 'stack ABC123 secreto' }));
    await entrar(page);
    await marcar(page, 'ABC123');
    await botonCert(page).click();
    const alerta = page.getByRole('alert');
    await expect(alerta).toContainText('No se pudo generar el archivo.');
    await expect(alerta.getByRole('button', { name: 'Reintentar la descarga' })).toBeVisible();
    await expect(page.getByText(/secreto/)).toHaveCount(0);
  });
});

// ═══════════════════════════════════════════ AC4 ════════════════════════════════════════════════

test.describe('HU #13206 — AC4: sin impuestos.certificado.descargar', () => {
  const SIN_DESCARGA = FUNCIONES_POR_ROL.admin.filter((f) => f !== 'impuestos.certificado.descargar');

  test('ni botón masivo ni chip clicable; «Certificar» sigue', async ({ page }) => {
    await entrar(page, { ...OPERACIONES_USER, funciones: SIN_DESCARGA } as typeof OPERACIONES_USER);
    // El chip queda como estado, no como botón de descarga.
    await expect(page.getByText('Certificado', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Descargar certificado en PDF' })).toHaveCount(0);
    // Certificar NO cuelga de la descarga.
    await expect(page.getByRole('button', { name: 'Certificar' })).toHaveCount(1);

    await marcar(page, 'ABC123');
    await expect(botonSoportes(page)).toBeVisible();
    await expect(botonCert(page)).toHaveCount(0);
  });

  test('lado positivo: con la función, chip clicable y botón masivo', async ({ page }) => {
    await entrar(page);
    await expect(page.getByRole('button', { name: 'Descargar certificado en PDF' })).toHaveCount(2);
    await marcar(page, 'ABC123');
    await expect(botonCert(page)).toHaveCount(1);
  });

  test('solo la función de certificados (sin soportes): casillas y barra con un solo botón', async ({ page }) => {
    await entrar(page, {
      ...AUDITOR_USER, funciones: [...FUNCIONES_POR_ROL.auditor, 'impuestos.certificado.descargar'],
    } as typeof AUDITOR_USER);
    await marcar(page, 'XYZ789');
    await expect(botonCert(page)).toHaveText('Descargar certificados (1)');
    await expect(botonSoportes(page)).toHaveCount(0);
  });
});

// ═══════════════════════════════════════════ AC5 ════════════════════════════════════════════════

test.describe('HU #13206 — AC5: estado de carga y accesibilidad', () => {
  test('aria-disabled + aria-busy, foco conservado, una sola petición; soportes sigue usable', async ({ page }) => {
    const traza = await mockZip(page, ZIP_OK('0'));
    let soltar!: () => void;
    traza.retener = new Promise<void>((r) => { soltar = r; });
    await entrar(page);
    await marcar(page, 'ABC123', 'XYZ789');

    const boton = botonCert(page);
    await boton.focus();
    await page.keyboard.press('Enter');

    await expect(boton).toHaveText('Preparando certificados…');
    await expect(boton).toHaveAttribute('aria-disabled', 'true');
    await expect(boton).toHaveAttribute('aria-busy', 'true');
    await expect(boton).toHaveAttribute('aria-label', 'Preparando el ZIP de certificados de 2 registros');
    await expect(boton).toBeFocused();
    await expect(page.getByTestId('espera-certificados-zip')).toContainText('Preparando el ZIP de certificados de 2 registros…');
    await expect(page.getByTestId('anuncio-certificados-zip')).toHaveText('Preparando el ZIP de certificados de 2 registros…');

    // Enter y clic repetidos: el candado no deja salir otra petición.
    await page.keyboard.press('Enter');
    // `dispatchEvent` y no un clic de ratón por coordenadas: lo que se prueba es el manejador (el
    // candado), sin que el puntero mueva el foco que se afirma más abajo.
    await boton.dispatchEvent('click');
    await expect(botonSoportes(page)).toBeEnabled();
    expect(traza.peticiones).toHaveLength(1);

    soltar();
    await expect(boton).toHaveText('Descargar certificados (2)');
    await expect(boton).not.toHaveAttribute('aria-disabled', 'true');
    await expect(boton).toBeFocused();
    expect(traza.peticiones).toHaveLength(1);
  });
});
