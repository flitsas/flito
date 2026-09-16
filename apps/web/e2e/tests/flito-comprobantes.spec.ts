// HU #12612 — Finanzas · Comprobantes: cola, carga en lotes y detalle con lo leído (Feature #12605).
// Backend mockeado. Un test (o grupo) por AC; el mutante que cada aserto mata va en su comentario.
//
// Reglas que se certifican aquí y no en otro sitio: la palabra «tanda» no existe en la UI; hay UNA
// sola región `status` en el modal de carga; ni `extraccion`, ni uuid, ni VIN completo llegan al DOM
// de la cola; y en este Feature no existen Asociar / Aplicar / Descartar (ni apagados).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { CARGA_MASIVA_MAX_ARCHIVOS } from '@operaciones/shared-types';
import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER, AUDITOR_USER, FINANCIERA_USER, FUNCIONES_POR_ROL } from '../helpers/auth';
import { correrAxe, esperarSinViolacionesGraves } from '../helpers/axe';

const RUTA = '/flito/comprobantes';
const PDF_DOS_PAGINAS = fileURLToPath(new URL('../fixtures/soporte-dos-paginas.pdf', import.meta.url));
const CONSOLIDADO_REAL = { name: 'soporte-dos-paginas.pdf', mimeType: 'application/pdf' as const, buffer: readFileSync(PDF_DOS_PAGINAS) };
const PDF_MIN = { mimeType: 'application/pdf' as const, buffer: Buffer.from('%PDF-1.4 t') };
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';
const LOTE_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOTE_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VIN_COMPLETO = '9BWZZZ377VT004251';

const COPY_504 = 'El servidor no terminó a tiempo. Esta carga no se alcanzó a procesar. Espera un momento y vuelve a intentar, o súbela más liviana.';

const archivos = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `f${i + 1}.pdf`, ...PDF_MIN }));
const contarArchivos = (postData: string | null) => (postData ?? '').match(/name="archivos"/g)?.length ?? 0;
const loteIdDe = (postData: string | null) => (postData ?? '').match(/name="loteId"[\s\S]*?\r?\n\r?\n([^\r\n]+)/)?.[1]?.trim() ?? '';

function fila(extra: Record<string, unknown>) {
  return {
    id: UUID_A, loteId: LOTE_1, estado: 'pendiente', motivoPendiente: 'leido', detallePendiente: null,
    tipoDocumento: 'recibo_impuesto', esPago: true, concepto: 'impuesto', tramite: null, cruce: null,
    placaLeida: null, vinLeido: null, idFlitLeido: null, valor: 312000, fechaDocumento: null,
    numeroDocumento: null, emisor: null, marcadoPorDiferencia: false, diferenciaTarifa: null,
    diferenciaAceptada: false, paginas: null, archivo: { nombre: 'recibo.pdf', contentType: 'application/pdf' },
    createdAt: '2026-09-16T15:42:00.000Z', aplicadoEn: null, aplicadoAutomaticamente: false, descartadoEn: null,
    subidoPorNombre: 'Ana Pérez', aplicadoPorNombre: null, descartadoPorNombre: null, ...extra,
  };
}

const CONSOLIDADO = fila({ id: UUID_B, archivo: { nombre: 'consolidado.pdf', contentType: 'application/pdf' }, paginas: [3, 4], tipoDocumento: null, esPago: null, concepto: null, valor: null, vinLeido: VIN_COMPLETO, motivoPendiente: 'cruce_ambiguo' });
const OTRO_LOTE = fila({ id: UUID_C, loteId: LOTE_2, archivo: { nombre: 'transf.png', contentType: 'image/png' }, createdAt: '2026-09-15T13:10:00.000Z', subidoPorNombre: 'Luis Gómez', placaLeida: 'JKL456', motivoPendiente: 'concepto_desconocido', concepto: null });
const LISTA_2_LOTES = { items: [fila({}), CONSOLIDADO, OTRO_LOTE], total: 3, page: 1, pageSize: 50 };
const LISTA_VACIA = { items: [], total: 0, page: 1, pageSize: 50 };

const campo = (campo: string, valor: string | null, nivel: 'alta' | 'media' | 'baja' | null, confiable = nivel === 'alta') =>
  ({ campo, valor, confianza: valor === null ? 0 : 0.9, confiable, nivel, confirmadoPor: null });

function detalle(extra: Record<string, unknown> = {}, campos = [
  campo('tipoDocumento', 'recibo_impuesto', 'alta'), campo('esComprobantePago', 'true', 'alta'),
  campo('concepto', 'impuesto', 'media', false), campo('placa', 'XYZ789', 'alta'), campo('vin', VIN_COMPLETO, 'alta'),
  campo('idFlit', null, null), campo('valorTotal', '312000', 'alta'), campo('fechaPago', null, null),
  campo('numeroDocumento', '2026-00123', 'baja', false), campo('emisor', 'Gobernación', 'media', true),
  campo('destino.numeroRecibo', '2026-00123', 'alta'),
]) {
  return { ...fila(extra), campos, candidatos: [] };
}

/** La cola y sus derivados; el espía devuelve las URL de cada GET a la cola. */
async function mockCola(page: Page, lista: unknown = LISTA_2_LOTES) {
  const gets: string[] = [];
  await page.route(/\/api\/flito\/comprobantes(\?|$)/, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    gets.push(new URL(route.request().url()).search);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(lista) });
  });
  return gets;
}

async function mockDetalle(page: Page, cuerpo: unknown, status = 200) {
  await page.route(new RegExp(`/api/flito/comprobantes/${UUID_A}$`), (route) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(cuerpo) }));
}

async function mockArchivoPdf(page: Page) {
  await page.route(/\/api\/flito\/comprobantes\/[0-9a-f-]+\/archivo$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/pdf', path: PDF_DOS_PAGINAS }));
}

const RESULTADO_OK = {
  aplicados: [], documentos: 2,
  pendientes: [
    { archivo: 'f1.pdf', comprobanteId: UUID_A, paginas: null, tipoDocumento: 'recibo_impuesto', concepto: 'impuesto', idFlit: null, placa: 'XYZ789', motivo: 'leido', detalle: 'Leído, pendiente de asociar' },
    { archivo: 'f2.pdf', comprobanteId: UUID_B, paginas: [3, 4], tipoDocumento: null, concepto: null, idFlit: null, placa: null, motivo: 'ocr_no_disponible', detalle: 'Sin lectura (OCR no disponible)' },
  ],
  duplicados: [], fallidos: [],
};

const SIN_COLA_VER = FUNCIONES_POR_ROL.financiera.filter((f) => f !== 'comprobantes.cola.ver');
const SIN_CARGAR = FUNCIONES_POR_ROL.financiera.filter((f) => f !== 'comprobantes.lote.cargar');
const SIN_RELEER = FUNCIONES_POR_ROL.financiera.filter((f) => f !== 'comprobantes.comprobante.releer');
const SIN_ARCHIVO = FUNCIONES_POR_ROL.financiera.filter((f) => f !== 'comprobantes.archivo.descargar');

async function abrirCarga(page: Page) {
  await page.goto(RUTA);
  await page.getByRole('button', { name: 'Cargar comprobantes' }).click();
  const modal = page.getByRole('dialog', { name: 'Cargar comprobantes' });
  await expect(modal).toBeVisible();
  return modal;
}

test.describe('HU #12612 · AC1 — página, menú y ayuda', () => {
  test('financiera entra por el menú y por la ruta; la ficha de ayuda existe', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockCola(page, LISTA_VACIA);
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Navegación principal' });
    await nav.getByRole('button', { name: 'Finanzas', exact: true }).click();
    const enlace = nav.getByRole('link', { name: 'Comprobantes', exact: true });
    await expect(enlace).toHaveAttribute('href', RUTA);
    await enlace.click();
    await expect(page).toHaveURL(/\/flito\/comprobantes$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Finanzas — Comprobantes' })).toBeVisible();

    await page.goto('/flito/ayuda/flito_comprobantes');
    const articulo = page.getByRole('article', { name: 'Comprobantes' });
    await expect(articulo).toBeVisible();
    for (const h of ['Qué es', 'Para quién', 'Cómo se entra', 'Pasos', 'Estados', 'Qué no hace']) {
      await expect(articulo.getByRole('heading', { name: h, exact: true })).toBeVisible();
    }
    // Solo lo entregado por este Feature: la ficha no promete Asociar ni Aplicar como acciones.
    await expect(articulo.getByText(/No asocia ni aplica todavía/)).toBeVisible();
    await expect(articulo.getByText(/No abre archivos ZIP/)).toBeVisible();
    await expect(articulo.getByText(/No carga SOAT del canal Cliente/)).toBeVisible();
    await expect(articulo.getByText(/No muestra ni guarda datos de personas/)).toBeVisible();
    await expect(articulo.getByRole('heading', { name: /Aplicar|Asociar/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Ir a la pantalla Comprobantes' })).toHaveAttribute('href', RUTA);
  });

  test('auditor: sin ítem en el menú y la ruta muestra NoAccess', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Navegación principal' });
    await expect(nav).toBeVisible();
    const finanzas = nav.getByRole('button', { name: 'Finanzas', exact: true });
    if (await finanzas.count()) await finanzas.click();
    await expect(nav.getByRole('link', { name: 'Comprobantes', exact: true })).toHaveCount(0);
    await page.goto(RUTA);
    await expect(page.getByRole('heading', { name: /No tienes acceso/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Pendientes/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cargar comprobantes' })).toHaveCount(0);
  });

  /** Mutante UX-1/UX-15: guardar por `role === 'admin'` → esta sesión financiera vería la cola / el botón. */
  test('sin comprobantes.cola.ver: banda sin Reintentar y cero GET; sin lote.cargar: no existe la primaria', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: SIN_COLA_VER });
    const gets = await mockCola(page);
    await page.goto(RUTA);
    await expect(page.getByRole('alert')).toHaveText('Tu usuario no tiene la función “Ver la cola de comprobantes”. Pídesela a un administrador.');
    await expect(page.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
    expect(gets).toEqual([]);

    await loginAs(page, FINANCIERA_USER, { funciones: SIN_CARGAR });
    await page.goto(RUTA);
    await expect(page.getByRole('heading', { level: 1, name: 'Finanzas — Comprobantes' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cargar comprobantes' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Ver / }).first()).toBeVisible();
  });
});

test.describe('HU #12612 · AC2 — elegir hasta el tope, sin ZIP', () => {
  /** Mutante: enviar los primeros 150 y callar el excedente → saldría un POST. */
  test('más archivos que el tope: contador en rojo, primaria apagada, cero POST y sin «tanda»', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockCola(page, LISTA_VACIA);
    let posts = 0;
    await page.route(/\/api\/flito\/comprobantes$/, (route) => { posts += 1; return route.fulfill({ status: 200, body: JSON.stringify(RESULTADO_OK) }); });
    const modal = await abrirCarga(page);
    const input = modal.getByLabel('Comprobantes de la carga');
    await expect(input).toHaveAttribute('accept', '.pdf,.png,.jpg,.jpeg,.webp');
    await input.setInputFiles(archivos(CARGA_MASIVA_MAX_ARCHIVOS + 1));
    await expect(modal.getByRole('alert')).toContainText(`el máximo son ${CARGA_MASIVA_MAX_ARCHIVOS}`);
    await expect(modal.getByRole('status').locator('p').first()).toHaveClass(/text-red-600/);
    await expect(modal.getByRole('button', { name: 'Subir y procesar' })).toBeDisabled();
    await expect(modal.getByText(/tanda/i)).toHaveCount(0);
    expect(posts).toBe(0);
  });
});

test.describe('HU #12612 · AC3 — envío progresivo y resultado por documento', () => {
  /** Mutantes UX-5: `loteId` distinto por petición; segunda región `status`; consolidado dentro de un envío de 5. */
  test('6 archivos → 2 POST con el mismo loteId; un solo status con contador y progreso; Listo filtra la cola', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    const gets = await mockCola(page, LISTA_VACIA);
    const porEnvio: number[] = [];
    const lotes: string[] = [];
    let release1!: () => void;
    const held1 = new Promise<void>((r) => { release1 = r; });
    await page.route(/\/api\/flito\/comprobantes$/, async (route) => {
      porEnvio.push(contarArchivos(route.request().postData()));
      lotes.push(loteIdDe(route.request().postData()));
      if (porEnvio.length === 1) await held1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RESULTADO_OK) });
    });

    const modal = await abrirCarga(page);
    await modal.getByLabel('Comprobantes de la carga').setInputFiles(archivos(6));
    await modal.getByRole('button', { name: 'Subir y procesar' }).click();

    const status = modal.getByRole('status');
    await expect(status).toHaveCount(1);
    await expect(status).toContainText('enviando 1 de 6 archivos');
    const texto = (await status.innerText()).replace(/\s+/g, ' ');
    expect(texto.indexOf('6 archivos ·')).toBeGreaterThanOrEqual(0);
    expect(texto.indexOf('6 archivos ·')).toBeLessThan(texto.indexOf('enviando 1 de 6'));
    await expect(modal.getByText(/tanda/i)).toHaveCount(0);
    release1();

    await expect(modal.getByRole('button', { name: 'Listo' })).toBeVisible();
    expect(porEnvio).toEqual([5, 1]);
    expect(lotes[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(lotes).size).toBe(1);
    await expect(modal.getByRole('status')).toHaveText('4 documentos leídos en 6 archivos');
    await expect(modal.getByText('Pendientes 4')).toBeVisible();
    await expect(modal.getByText('Duplicados 0')).toBeVisible();
    await expect(modal.getByText('Fallidos 0')).toBeVisible();
    await expect(modal.getByText(/Aplicados/)).toHaveCount(0);
    await expect(modal.getByRole('cell', { name: /f2\.pdf/ }).first()).toContainText('p. 3-4');

    await modal.getByRole('button', { name: 'Listo' }).click();
    await expect(modal).toHaveCount(0);
    await expect.poll(() => gets.at(-1)).toContain(`loteId=${lotes[0]}`);
    await expect(page.getByText(/^Carga de hoy \d{2}:\d{2}/)).toBeVisible();
    await expect(page.getByText('Ningún comprobante coincide con los filtros.')).toBeVisible();
    await expect(page.locator('p.sr-only[role="status"]')).toHaveText('Cola actualizada: 0 pendientes');
    await page.getByRole('button', { name: 'Quitar el filtro de carga' }).click();
    await expect.poll(() => gets.at(-1)).not.toContain('loteId=');
  });

  test('un consolidado (PDF de 2 páginas) viaja en su propio envío', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockCola(page, LISTA_VACIA);
    const envios: { n: number; nombres: string[] }[] = [];
    await page.route(/\/api\/flito\/comprobantes$/, (route) => {
      const data = route.request().postData() ?? '';
      envios.push({ n: contarArchivos(data), nombres: [...data.matchAll(/filename="([^"]+)"/g)].map((m) => m[1]) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RESULTADO_OK) });
    });
    const modal = await abrirCarga(page);
    await modal.getByLabel('Comprobantes de la carga').setInputFiles([...archivos(2), CONSOLIDADO_REAL]);
    await modal.getByRole('button', { name: 'Subir y procesar' }).click();
    await expect(modal.getByRole('button', { name: 'Listo' })).toBeVisible();
    expect(envios.map((e) => e.n)).toEqual([2, 1]);
    expect(envios[1].nombres).toEqual(['soporte-dos-paginas.pdf']);
  });

  /** Mutante UX-6: seguir enviando tras el 504 → tercer POST. */
  test('504 en el 2.º envío: alert 504 + tabla del 1.º, Listo, sin tercer POST; otra elección = otro loteId', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockCola(page, LISTA_VACIA);
    const lotes: string[] = [];
    let posts = 0;
    await page.route(/\/api\/flito\/comprobantes$/, (route) => {
      posts += 1;
      lotes.push(loteIdDe(route.request().postData()));
      if (posts === 1) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RESULTADO_OK) });
      if (posts === 2) return route.fulfill({ status: 504, contentType: 'text/html', body: '<html><center>504 Gateway Time-out</center></html>' });
      throw new Error('no debía salir un tercer POST');
    });
    const modal = await abrirCarga(page);
    await modal.getByLabel('Comprobantes de la carga').setInputFiles(archivos(12));
    await modal.getByRole('button', { name: 'Subir y procesar' }).click();
    await expect(modal.getByRole('alert')).toHaveText(COPY_504);
    await expect(modal.getByText('Pendientes 2')).toBeVisible();
    await expect(modal.getByRole('cell', { name: /f1\.pdf/ })).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Listo' })).toBeVisible();
    await expect(modal.getByRole('button', { name: /Reintentar/ })).toHaveCount(0);
    expect(posts).toBe(2);
    expect(lotes[0]).toBe(lotes[1]);
  });

  test('fallo total: el formulario sigue y volver a elegir archivos genera otro loteId', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockCola(page, LISTA_VACIA);
    const lotes: string[] = [];
    await page.route(/\/api\/flito\/comprobantes$/, (route) => {
      lotes.push(loteIdDe(route.request().postData()));
      if (lotes.length === 1) return route.fulfill({ status: 504, contentType: 'text/html', body: '<html><center>504 Gateway Time-out</center></html>' });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RESULTADO_OK) });
    });
    const modal = await abrirCarga(page);
    const input = modal.getByLabel('Comprobantes de la carga');
    await input.setInputFiles(archivos(2));
    await modal.getByRole('button', { name: 'Subir y procesar' }).click();
    await expect(modal.getByRole('alert')).toHaveText(COPY_504);
    await expect(modal.getByRole('button', { name: 'Subir y procesar' })).toBeEnabled();
    await input.setInputFiles(archivos(2));
    await modal.getByRole('button', { name: 'Subir y procesar' }).click();
    await expect(modal.getByRole('button', { name: 'Listo' })).toBeVisible();
    expect(lotes).toHaveLength(2);
    expect(lotes[0]).not.toBe(lotes[1]);
  });

  /** Mutante UX-7: enlace que navega y pierde el resultado; Esc que cierra los dos modales. */
  test('duplicado con comprobanteId: «Ver el original» abre el detalle encima; Esc cierra solo el de arriba', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockCola(page, LISTA_VACIA);
    await mockDetalle(page, detalle());
    await mockArchivoPdf(page);
    await page.route(/\/api\/flito\/comprobantes$/, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        aplicados: [], pendientes: [], fallidos: [], documentos: 2,
        duplicados: [
          { archivo: 'dup.pdf', comprobanteId: UUID_A, paginas: null, tipoDocumento: null, concepto: null, idFlit: null, placa: null, motivo: null, detalle: 'Ya cargado el 12 sep 2026' },
          { archivo: 'soat-viejo.pdf', comprobanteId: null, paginas: null, tipoDocumento: null, concepto: null, idFlit: null, placa: null, motivo: null, detalle: 'Ya cargado el 12 sep 2026 en SOAT' },
        ],
      }),
    }));
    const modal = await abrirCarga(page);
    await modal.getByLabel('Comprobantes de la carga').setInputFiles(archivos(2));
    await modal.getByRole('button', { name: 'Subir y procesar' }).click();
    await expect(modal.getByText('Duplicados 2')).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Ver el original' })).toHaveCount(1);
    await expect(modal.getByRole('cell', { name: /soat-viejo\.pdf/ })).toBeVisible();
    await modal.getByRole('button', { name: 'Ver el original' }).click();
    await expect(page.locator('[data-flit-modal]')).toHaveCount(2);
    await expect(page.getByRole('dialog', { name: /^Comprobante · recibo\.pdf/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-flit-modal]')).toHaveCount(1);
    await expect(modal.getByRole('button', { name: 'Listo' })).toBeVisible();
  });
});

test.describe('HU #12612 · AC4 — la cola agrupada por carga con filtros', () => {
  /** Mutante: filtro `estado` no enviado; Motivo pintado fuera de Pendientes. */
  test('arranca en Pendientes con contador y Motivo; Aplicados pide estado=aplicado y devuelve vacío filtrado', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    const gets = await mockCola(page);
    await page.goto(RUTA);
    const pendientes = page.getByRole('button', { name: /^Pendientes/ });
    await expect(pendientes).toHaveAttribute('aria-pressed', 'true');
    await expect(pendientes).toHaveText(/Pendientes\s*3/);
    expect(gets[0]).toContain('estado=pendiente');
    const motivo = page.getByRole('combobox', { name: 'Motivo' });
    await expect(motivo).toBeVisible();
    await expect(motivo.locator('option', { hasText: 'Leído, pendiente de asociar' })).toHaveCount(1);
    await expect(motivo.locator('option', { hasText: 'Sin lectura (OCR no disponible)' })).toHaveCount(1);
    await expect(page.getByRole('combobox', { name: 'Concepto' }).locator('option')).toHaveCount(7);
    await motivo.selectOption('ocr_no_disponible');
    await expect.poll(() => gets.at(-1)).toContain('motivo=ocr_no_disponible');
    await page.getByRole('combobox', { name: 'Concepto' }).selectOption('soat');
    await expect.poll(() => gets.at(-1)).toContain('concepto=soat');

    await page.unroute(/\/api\/flito\/comprobantes(\?|$)/);
    const gets2 = await mockCola(page, LISTA_VACIA);
    await page.getByRole('button', { name: 'Aplicados' }).click();
    await expect(page.getByRole('button', { name: 'Aplicados' })).toHaveAttribute('aria-pressed', 'true');
    await expect(motivo).toHaveCount(0);
    await expect.poll(() => gets2.at(-1)).toContain('estado=aplicado');
    expect(gets2.at(-1)).not.toContain('motivo=');
    await expect(page.getByText('Ningún comprobante coincide con los filtros.')).toBeVisible();
    await page.getByRole('button', { name: 'Limpiar filtros' }).click();
    await expect(pendientes).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => gets2.at(-1)).toContain('estado=pendiente');
    for (const p of ['Descartados', 'Todos']) await expect(page.getByRole('button', { name: p, exact: true })).toBeVisible();
  });

  /** Mutante UX-3: chip sin efecto en la query. */
  test('dos lotes → dos th[scope=rowgroup]; «Solo esta carga» filtra por loteId y la ✕ lo quita', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    const gets = await mockCola(page);
    await page.goto(RUTA);
    const cabeceras = page.locator('th[scope="rowgroup"]');
    await expect(cabeceras).toHaveCount(2);
    await expect(cabeceras.nth(0)).toContainText(/^Carga 16 sep 2026 · \d{2}:\d{2} · Ana Pérez · 2 documentos en 2 archivos/);
    await expect(cabeceras.nth(1)).toContainText(/Luis Gómez · 1 documento en 1 archivo/);
    await cabeceras.nth(1).getByRole('button', { name: 'Solo esta carga' }).click();
    await expect.poll(() => gets.at(-1)).toContain(`loteId=${LOTE_2}`);
    await expect(page.getByText(/^Carga 15 sep 2026 · \d{2}:\d{2} · 3 documentos$/)).toBeVisible();
    await page.getByRole('button', { name: 'Quitar el filtro de carga' }).click();
    await expect.poll(() => gets.at(-1)).not.toContain('loteId=');
  });

  /** Mutante UX-4: pintar `extraccion`, `id` o el VIN entero en la lista. */
  test('celdas con el copy de §5.2; ni extraccion, ni uuid, ni VIN completo en el DOM', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockCola(page);
    await page.goto(RUTA);
    const tabla = page.getByRole('region', { name: 'Cola de comprobantes' });
    const consolidado = tabla.getByRole('row', { name: /consolidado\.pdf/ });
    await expect(consolidado).toContainText('p. 3-4');
    await expect(consolidado).toContainText('Sin identificar');
    await expect(consolidado).toContainText('Sin decidir');
    await expect(consolidado).toContainText(`leído: …${VIN_COMPLETO.slice(-6)}`);
    await expect(consolidado.getByRole('cell').nth(4)).toHaveText('—');
    await expect(consolidado.getByRole('button', { name: 'Ver consolidado.pdf p. 3-4' })).toBeVisible();
    await expect(consolidado).toContainText('El documento cruza con más de un trámite');
    const recibo = tabla.getByRole('row', { name: /recibo\.pdf/ });
    await expect(recibo).toContainText('Recibo de impuesto');
    await expect(recibo).toContainText('Pago');
    await expect(recibo).toContainText('Impuesto');
    await expect(recibo).toContainText('$ 312.000');
    await expect(recibo).toContainText('Leído, pendiente de asociar');
    await expect(tabla.getByRole('row', { name: /transf\.png/ })).toContainText('leído: JKL456');
    await expect(tabla.getByText('$ 0')).toHaveCount(0);
    await expect(tabla.getByText(/extraccion|confianza/)).toHaveCount(0);
    const html = await tabla.evaluate((el) => el.outerHTML);
    expect(html).not.toContain(VIN_COMPLETO);
    for (const uuid of [UUID_A, UUID_B, UUID_C, LOTE_1, LOTE_2]) expect(html).not.toContain(uuid);
    expect(page.url()).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  test('4 estados: cargando (aria-busy), error + Reintentar, vacío sin filtros', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    // Por MODO y no por conteo: en dev `StrictMode` monta el efecto dos veces y salen dos GET.
    let modo: 'colgado' | 'ok' = 'colgado';
    let intentos = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    await page.route(/\/api\/flito\/comprobantes\?/, async (route) => {
      intentos += 1;
      if (modo === 'colgado') { await held; return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Base de datos caída' }) }); }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LISTA_VACIA) });
    });
    await page.goto(RUTA);
    await expect(page.locator('[aria-busy="true"]').first()).toBeVisible();
    release();
    await expect(page.getByRole('alert')).toContainText('No se pudo cargar la cola de comprobantes. Base de datos caída');
    const antes = intentos;
    modo = 'ok';
    await page.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByText('No hay comprobantes por asociar.')).toBeVisible();
    await expect(page.getByText(/Empieza con Cargar comprobantes, arriba/)).toBeVisible();
    expect(intentos).toBeGreaterThan(antes);
  });
});

test.describe('HU #12612 · AC5 — detalle: visor y datos leídos con confianza', () => {
  /** Mutantes: `paginaInicial` ignorada → scrollTop 0; derivar el nivel en el front → «Baja» con confianza 0.9 se pintaría «Alta». */
  test('«Ver» abre el visor en la página del documento, la cabecera de 3 líneas y los chips por nivel; sin Asociar/Aplicar/Descartar', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockCola(page, { items: [fila({ paginas: [2], archivo: { nombre: 'dos.pdf', contentType: 'application/pdf' } })], total: 1, page: 1, pageSize: 50 });
    await mockDetalle(page, detalle({ paginas: [2], archivo: { nombre: 'dos.pdf', contentType: 'application/pdf' } }));
    await mockArchivoPdf(page);
    await page.goto(RUTA);
    await page.getByRole('button', { name: 'Ver dos.pdf p. 2' }).click();
    const dialog = page.getByRole('dialog', { name: 'Comprobante · dos.pdf · p. 2' });
    await expect(dialog).toBeVisible();
    const paginas = dialog.locator('img[alt*=" — página "]');
    await expect(paginas).toHaveCount(2);
    const visor = dialog.locator('[data-pagina="2"]').locator('xpath=ancestor::div[contains(@class,"overflow-auto")][1]');
    await expect.poll(() => visor.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    const original = dialog.getByRole('link', { name: 'Abrir el archivo original ↗' });
    await expect(original).toHaveAttribute('target', '_blank');
    await expect(original).toHaveAttribute('rel', 'noopener');

    const lectura = dialog.getByRole('region', { name: 'Lectura' });
    await expect(lectura).toContainText('Pendiente');
    await expect(lectura).toContainText('Leído, pendiente de asociar');
    await expect(lectura).toContainText(/Carga 16 sep 2026 · \d{2}:\d{2} · Ana Pérez/);
    await expect(lectura).toContainText('Leído: Recibo de impuesto');
    const filaCampo = (rotulo: string) => lectura.locator('dl > div', { has: page.getByText(rotulo, { exact: true }) });
    await expect(filaCampo('Tipo de documento')).toContainText('Alta');
    await expect(filaCampo('Concepto')).toContainText('Media');
    await expect(filaCampo('Número de documento')).toContainText('Baja');
    await expect(filaCampo('ID FLIT')).toContainText('Sin lectura');
    await expect(filaCampo('ID FLIT').locator('dd').last()).toHaveText('');
    await expect(filaCampo('Número de recibo')).toContainText('2026-00123');
    await expect(filaCampo('VIN')).toContainText(VIN_COMPLETO);
    await expect(filaCampo('Placa')).toContainText('XYZ789');
    await expect(lectura.locator('input, textarea, select')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: /Asociar|Aplicar|Adjuntar|Descartar|Releer/ })).toHaveCount(0);
    await expect(dialog.locator('button[disabled]')).toHaveCount(0);
  });

  test('imagen: <img alt="{archivo}">; sin archivo.descargar el visor no se monta', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockCola(page, { items: [OTRO_LOTE], total: 1, page: 1, pageSize: 50 });
    await page.route(new RegExp(`/api/flito/comprobantes/${UUID_C}$`), (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detalle({ id: UUID_C, archivo: { nombre: 'transf.png', contentType: 'image/png' } })) }));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    await page.route(/\/api\/flito\/comprobantes\/[0-9a-f-]+\/archivo$/, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: png }));
    await page.goto(RUTA);
    await page.getByRole('button', { name: 'Ver transf.png' }).click();
    await expect(page.getByRole('dialog').getByRole('img', { name: 'transf.png' })).toBeVisible();

    await loginAs(page, FINANCIERA_USER, { funciones: SIN_ARCHIVO });
    await page.goto(RUTA);
    await page.getByRole('button', { name: 'Ver transf.png' }).click();
    await expect(page.getByRole('dialog').getByText('Tu usuario no puede abrir el archivo. Pídele a un administrador la función “Abrir el archivo de un comprobante”.')).toBeVisible();
    await expect(page.getByRole('dialog').getByRole('img')).toHaveCount(0);
    await expect(page.getByRole('dialog').getByRole('link', { name: /Abrir el archivo original/ })).toHaveCount(0);
  });

  test('error del detalle: 404 → «ya no existe» + Actualizar la cola; 500 → Reintentar', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    const gets = await mockCola(page, { items: [fila({})], total: 1, page: 1, pageSize: 50 });
    let modo: 404 | 500 | 200 = 404;
    await page.route(new RegExp(`/api/flito/comprobantes/${UUID_A}$`), (route) => {
      if (modo === 404) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'El comprobante no existe', codigo: 'no_encontrado' }) });
      if (modo === 500) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Se cayó' }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detalle()) });
    });
    await mockArchivoPdf(page);
    await page.goto(RUTA);
    await page.getByRole('button', { name: 'Ver recibo.pdf' }).click();
    let dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('alert')).toHaveText('Este comprobante ya no existe.');
    const antes = gets.length;
    await dialog.getByRole('button', { name: 'Actualizar la cola' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => gets.length).toBeGreaterThan(antes);

    modo = 500;
    await page.getByRole('button', { name: 'Ver recibo.pdf' }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('alert')).toContainText('No se pudo abrir el comprobante. Se cayó');
    modo = 200;
    await dialog.getByRole('button', { name: 'Reintentar' }).click();
    await expect(dialog.getByRole('region', { name: 'Lectura' })).toContainText('Leído: Recibo de impuesto');
  });
});

test.describe('HU #12612 · AC6 — Releer', () => {
  const SIN_LECTURA = () => detalle(
    { motivoPendiente: 'ocr_no_disponible', tipoDocumento: null, esPago: null, concepto: null, valor: null },
    ['tipoDocumento', 'esComprobantePago', 'concepto', 'placa', 'vin', 'idFlit', 'valorTotal', 'fechaPago', 'numeroDocumento', 'emisor'].map((c) => campo(c, null, null)),
  );

  /** Mutante: pintar «Releer» para todo pendiente / sin la función. */
  test('con ocr_no_disponible y la función: línea + Releer → POST, «Releyendo…», repinta y anuncia; 503 → alert y campos intactos', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockCola(page, { items: [fila({ motivoPendiente: 'ocr_no_disponible' })], total: 1, page: 1, pageSize: 50 });
    await mockDetalle(page, SIN_LECTURA());
    await mockArchivoPdf(page);
    let releidos = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    await page.route(new RegExp(`/api/flito/comprobantes/${UUID_A}/releer$`), async (route) => {
      releidos += 1;
      if (releidos === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'OCR caído', codigo: 'ocr_no_disponible' }) });
      await held;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detalle()) });
    });
    await page.goto(RUTA);
    await page.getByRole('button', { name: 'Ver recibo.pdf' }).click();
    const dialog = page.getByRole('dialog');
    const lectura = dialog.getByRole('region', { name: 'Lectura' });
    await expect(lectura).toContainText('FLITO no pudo leer este documento.');
    await expect(lectura).toContainText('Leído: sin identificar');
    await expect(lectura.getByText('Sin lectura', { exact: true })).toHaveCount(11);
    const releer = dialog.getByRole('button', { name: 'Releer' });
    await releer.click();
    await expect(dialog.getByRole('alert')).toHaveText('El lector sigue sin estar disponible. Inténtalo más tarde.');
    await expect(lectura.getByText('Sin lectura', { exact: true })).toHaveCount(11);
    await expect(lectura).toContainText('FLITO no pudo leer este documento.');

    await releer.click();
    await expect(dialog.getByRole('status')).toHaveText('Releyendo…');
    await expect(releer).toBeDisabled();
    release();
    await expect(lectura).toContainText('Leído: Recibo de impuesto');
    await expect(lectura).toContainText('Leído, pendiente de asociar');
    await expect(lectura).not.toContainText('FLITO no pudo leer este documento.');
    await expect(dialog.getByRole('button', { name: 'Releer' })).toHaveCount(0);
    await expect(page.locator('p.sr-only[role="status"]')).toHaveText('Cola actualizada: 1 pendientes');
    expect(releidos).toBe(2);
  });

  test('con otro motivo, o sin la función, el botón no existe', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockCola(page, { items: [fila({})], total: 1, page: 1, pageSize: 50 });
    await mockDetalle(page, detalle());
    await mockArchivoPdf(page);
    await page.goto(RUTA);
    await page.getByRole('button', { name: 'Ver recibo.pdf' }).click();
    await expect(page.getByRole('dialog').getByRole('region', { name: 'Lectura' })).toContainText('Leído: Recibo de impuesto');
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Releer' })).toHaveCount(0);
    await expect(page.getByRole('dialog').getByText('FLITO no pudo leer este documento.')).toHaveCount(0);

    await loginAs(page, FINANCIERA_USER, { funciones: SIN_RELEER });
    await mockDetalle(page, SIN_LECTURA());
    await page.goto(RUTA);
    await page.getByRole('button', { name: 'Ver recibo.pdf' }).click();
    await expect(page.getByRole('dialog').getByText('FLITO no pudo leer este documento.')).toBeVisible();
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Releer' })).toHaveCount(0);
  });
});

test.describe('HU #12612 · AC7 — una sola región viva y accesibilidad', () => {
  test('a11y (axe) en la cola llena y en el modal de carga con selección', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockCola(page);
    await page.goto(RUTA);
    await expect(page.locator('th[scope="rowgroup"]')).toHaveCount(2);
    esperarSinViolacionesGraves(await correrAxe(page), 'cola de comprobantes');
    const modal = await abrirCarga(page);
    await modal.getByLabel('Comprobantes de la carga').setInputFiles(archivos(3));
    await expect(modal.getByRole('status')).toHaveCount(1);
    await expect(modal.getByRole('status')).toContainText('3 archivos');
    esperarSinViolacionesGraves(await correrAxe(page), 'modal Cargar comprobantes');
  });
});
