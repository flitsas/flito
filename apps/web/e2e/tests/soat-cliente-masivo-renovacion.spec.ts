// HU #14134 — FLITO SOAT · Cargar renovaciones en masa desde la solicitud (Feature #14013).
//
// Diseño: docs/ux/flito-soat-carga-masiva-renovaciones.md. Se interceptan los endpoints del canal con
// `page.route` (nunca el RUNT real) y se afirma lo que VIAJÓ (cuerpo del POST, peticiones del polling)
// además de lo que se ve. Placas ficticias.
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, CLIENTE_CON_CANAL } from '../helpers/auth';

const LOTE = '11111111-2222-4333-8444-555555555555';
const RE_ALTA = /\/api\/flito\/soat\/cliente\/masivo$/;
const RE_AVANCE = new RegExp(`/api/flito/soat/cliente/masivo/${LOTE}$`);
const RE_RECHAZADAS = new RegExp(`/api/flito/soat/cliente/masivo/${LOTE}/rechazadas$`);
const RE_PLANTILLA = /\/api\/flito\/soat\/cliente\/masivo\/plantilla\?tipo=renovacion$/;

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

type Fila = {
  nFila: number; placa: string | null; vin: string | null; estado: string;
  marca: string | null; linea: string | null; modelo: number | null; motivo: { codigo: string; mensaje: string } | null;
};
const fila = (nFila: number, estado: string, o: Partial<Fila> = {}): Fila => ({
  nFila, placa: null, vin: null, estado, marca: null, linea: null, modelo: null, motivo: null, ...o,
});

const avance = (o: Record<string, unknown> = {}) => ({
  loteId: LOTE, estado: 'procesando', tipo: 'renovacion', total: 4, pendientes: 2, procesando: 1, aceptadas: 1,
  porValidar: 0, rechazadas: 0, motivosRechazo: [], creadoEn: '2026-10-28T10:00:00.000Z', resumen: null,
  descargaRechazadas: false, filas: [], ...o,
});

const EN_CURSO = avance({
  filas: [
    fila(1, 'creada', { placa: 'ABC123', marca: 'RENAULT', linea: 'LOGAN', modelo: 2019 }),
    fila(2, 'consultando', { placa: 'DEF456' }),
    fila(3, 'en_cola', { placa: 'GHI789' }),
    fila(4, 'en_cola', { placa: 'JKL012' }),
  ],
});
// Lote terminado: el servidor ya borró placa y vehículo de creadas y por validar (ADR-0032).
const TERMINADO = avance({
  estado: 'terminado', pendientes: 0, procesando: 0, aceptadas: 2, porValidar: 1, rechazadas: 1,
  resumen: { total: 4, creadas: 2, porValidar: 1, rechazadas: 1, porValidarFactura: 1, porValidarPropietario: 0 },
  descargaRechazadas: true,
  filas: [
    fila(1, 'creada'), fila(2, 'creada'), fila(3, 'por_validar'),
    fila(4, 'rechazada', { placa: 'JKL012', motivo: { codigo: 'soat_vigente', mensaje: 'El vehículo ya tiene SOAT vigente' } }),
  ],
});

async function montar(page: Page, o: { alta?: (n: number) => { status: number; cuerpo: unknown }; avances?: Array<{ status: number; cuerpo: unknown }> } = {}) {
  const altas: string[] = [];
  const lecturas = { n: 0 };
  await page.route(/\/api\/flito\/soat\?/, (r) => json(r, 200, { items: [], total: 0, page: 1, pageSize: 50 }));
  await page.route(/\/api\/flito\/soat\/facetas/, (r) => json(r, 200, { companias: [], organismos: [], proveedores: [] }));
  await page.route(/\/api\/flito\/soat\/cliente\/incompletas\/buscar$/, (r) =>
    json(r, 200, { items: [], total: 0, conteos: { incompleta: 0, descartada: 0 } }));
  await page.route(/\/api\/flito\/soat\/cliente\/companias$/, (r) =>
    json(r, 200, { fija: true, companias: [{ id: 7, nombre: 'Transportes Andinos S.A.S.' }] }));
  await page.route(RE_ALTA, (r) => {
    altas.push(r.request().postData() ?? '');
    const res = o.alta ? o.alta(altas.length) : { status: 201, cuerpo: { loteId: LOTE } };
    return json(r, res.status, res.cuerpo);
  });
  await page.route(RE_AVANCE, (r) => {
    const lista = o.avances ?? [{ status: 200, cuerpo: EN_CURSO }, { status: 200, cuerpo: TERMINADO }];
    const res = lista[Math.min(lecturas.n, lista.length - 1)];
    lecturas.n += 1;
    return json(r, res.status, res.cuerpo);
  });
  return { altas, lecturas };
}

const XLSX = { name: 'renovaciones.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('PK-ficticio') };

async function abrirMasiva(page: Page) {
  await loginAs(page, CLIENTE_CON_CANAL);
  await page.goto('/flito/soat/solicitud');
  await page.getByRole('radio', { name: /Renovación/ }).check();
  await page.getByRole('radio', { name: 'Masiva' }).check();
  await expect(page.getByRole('region', { name: 'Renovaciones en masa' })).toBeVisible();
}

const cargar = (page: Page) => page.getByRole('button', { name: 'Cargar renovaciones' });

test.describe('HU #14134 — carga masiva de renovaciones', () => {
  test('AC1: el selector solo existe con Renovación; Masiva no pinta la barra de envío y alternar conserva lo digitado', async ({ page }) => {
    await montar(page);
    await loginAs(page, CLIENTE_CON_CANAL);
    await page.goto('/flito/soat/solicitud');
    await page.getByRole('radio', { name: /SOAT inicial/ }).check();
    await expect(page.getByRole('radiogroup', { name: 'Forma de cargar' })).toHaveCount(0);
    await page.getByRole('radio', { name: /Renovación/ }).check();
    await expect(page.getByRole('radiogroup', { name: 'Forma de cargar' })).toBeVisible();
    await page.getByLabel('Placa').fill('XYZ123');
    await page.getByRole('radio', { name: 'Masiva' }).check();
    await expect(page.getByRole('button', { name: 'Enviar solicitud' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Descargar plantilla' })).toBeVisible();
    await page.getByRole('radio', { name: 'Individual' }).check();
    await expect(page.getByLabel('Placa')).toHaveValue('XYZ123');
  });

  test('AC4: un archivo que no es .xlsx se explica y no se sube', async ({ page }) => {
    const { altas } = await montar(page);
    await abrirMasiva(page);
    await expect(cargar(page)).toHaveAttribute('aria-disabled', 'true');
    await page.locator('input[type=file]').setInputFiles({ name: 'datos.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b') });
    await expect(page.getByRole('alert').filter({ hasText: 'El archivo debe ser un Excel .xlsx' })).toBeVisible();
    await cargar(page).click({ force: true }); // aria-disabled: el clic no hace nada
    expect(altas).toHaveLength(0);
  });

  test('AC4: el servidor rechaza el archivo vacío con el copy del diccionario, no con su mensaje', async ({ page }) => {
    const { altas } = await montar(page, { alta: () => ({ status: 400, cuerpo: { error: 'El archivo no tiene filas de datos.', codigo: 'archivo_vacio' } }) });
    await abrirMasiva(page);
    await page.locator('input[type=file]').setInputFiles(XLSX);
    await cargar(page).click();
    await expect(page.getByRole('alert').filter({ hasText: 'El archivo no tiene renovaciones. Llene al menos una fila de la plantilla.' })).toBeVisible();
    expect(altas).toHaveLength(1);
    await expect(page.getByText('no tiene filas de datos')).toHaveCount(0);
  });

  test('lote_activo: copy propio y sin mostrar el id del lote', async ({ page }) => {
    await montar(page, { alta: () => ({ status: 409, cuerpo: { error: 'x', codigo: 'lote_activo', loteId: LOTE } }) });
    await abrirMasiva(page);
    await page.locator('input[type=file]').setInputFiles(XLSX);
    await cargar(page).click();
    await expect(page.getByText('Su compañía ya tiene una carga en curso. Espere a que termine para subir otro archivo.')).toBeVisible();
    await expect(page.getByText(LOTE)).toHaveCount(0);
  });

  test('AC2/AC3/AC7: avance con filas, resumen, rechazadas y enlace a Por validar; la placa ya vista se conserva', async ({ page }) => {
    const { altas } = await montar(page);
    await abrirMasiva(page);
    const input = page.locator('input[type=file]');
    await input.setInputFiles(XLSX);
    await cargar(page).click();

    expect(altas[0]).toContain('name="tipo"');
    expect(altas[0]).toContain('renovacion');
    const tabla = page.getByRole('region', { name: 'Filas de la carga en masa' });
    await expect(tabla.getByText('RENAULT LOGAN · 2019')).toBeVisible();
    await expect(tabla.getByText('Consultando')).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: /Procesando: 1 de 4 filas/ })).toBeVisible();

    // Segundo sondeo (~2,5 s): terminado. Placa y vehículo llegan en null, pero se conservan en memoria.
    await expect(page.getByRole('heading', { name: 'Resultado de la carga', exact: true })).toBeVisible({ timeout: 8_000 });
    await expect(tabla.getByText('ABC123')).toBeVisible();
    await expect(tabla.getByText('RENAULT LOGAN · 2019')).toBeVisible();
    await expect(page.getByText('2 creadas').first()).toBeVisible();
    await expect(page.getByText('1 por validar').first()).toBeVisible();
    await expect(page.getByText('JKL012 · El vehículo ya tiene SOAT vigente')).toBeVisible();
    // Nada de PII en storage.
    const guardado = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(guardado).not.toContain('ABC123');

    await page.route(RE_RECHAZADAS, (r) => r.fulfill({
      status: 200, body: Buffer.from('PK'), headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': 'attachment; filename="renovaciones-rechazadas.xlsx"',
      },
    }));
    const descarga = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Descargar rechazadas' }).click();
    expect((await descarga).suggestedFilename()).toContain('rechazadas');

    await page.getByRole('button', { name: 'Ver en Por validar' }).click();
    await expect(page).toHaveURL(/\/flito\/soat$/);
  });

  test('AC5: error al subir con Reintentar (conserva el archivo)', async ({ page }) => {
    const { altas } = await montar(page, { alta: (n) => (n === 1 ? { status: 500, cuerpo: { error: 'boom interno' } } : { status: 201, cuerpo: { loteId: LOTE } }) });
    await abrirMasiva(page);
    await page.locator('input[type=file]').setInputFiles(XLSX);
    await cargar(page).click();
    await expect(page.getByRole('alert').filter({ hasText: 'No pudimos cargar el archivo. Revise su conexión e intente de nuevo.' })).toBeVisible();
    await expect(page.getByText('boom interno')).toHaveCount(0);
    await page.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByRole('region', { name: 'Filas de la carga en masa' })).toBeVisible();
    expect(altas).toHaveLength(2);
  });

  test('AC5: error al leer el avance pausa el sondeo y Reintentar lo reanuda con la tabla previa', async ({ page }) => {
    const { lecturas } = await montar(page, {
      avances: [{ status: 200, cuerpo: EN_CURSO }, { status: 500, cuerpo: { error: 'x' } }, { status: 200, cuerpo: TERMINADO }],
    });
    await abrirMasiva(page);
    await page.locator('input[type=file]').setInputFiles(XLSX);
    await cargar(page).click();
    await expect(page.getByRole('alert').filter({ hasText: 'No pudimos actualizar el avance. El proceso continúa en FLITO.' })).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText('ABC123')).toBeVisible();
    const n = lecturas.n;
    await page.waitForTimeout(3_000);
    expect(lecturas.n).toBe(n); // pausado
    await page.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByRole('heading', { name: 'Resultado de la carga', exact: true })).toBeVisible();
  });

  test('AC6: al salir de la vista el sondeo se cancela', async ({ page }) => {
    const { lecturas } = await montar(page, { avances: [{ status: 200, cuerpo: EN_CURSO }] });
    await abrirMasiva(page);
    await page.locator('input[type=file]').setInputFiles(XLSX);
    await cargar(page).click();
    await expect(page.getByText('GHI789')).toBeVisible();
    await page.getByRole('radio', { name: 'Individual' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Salir' }).click();
    const n = lecturas.n;
    await page.waitForTimeout(3_000);
    expect(lecturas.n).toBe(n);
    await page.getByRole('radio', { name: 'Masiva' }).check();
    await expect(page.getByRole('button', { name: 'Descargar plantilla' })).toBeVisible(); // estado vacío, no retoma
  });

  test('la plantilla se descarga por la ruta del tipo elegido', async ({ page }) => {
    await montar(page);
    await page.route(RE_PLANTILLA, (r) => r.fulfill({
      status: 200, body: Buffer.from('PK'), headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': 'attachment; filename="plantilla-renovaciones.xlsx"',
      },
    }));
    await abrirMasiva(page);
    const descarga = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Descargar plantilla' }).click();
    expect((await descarga).suggestedFilename()).toContain('plantilla');
  });
});
