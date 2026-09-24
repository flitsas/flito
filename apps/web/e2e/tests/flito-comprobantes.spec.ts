// HU #12612 — Finanzas · Comprobantes: cola, carga en lotes y detalle con lo leído (Feature #12605).
// HU #12634 — Panel de asociación: trámite, concepto, campos con confianza, Aplicar / Adjuntar /
// Descartar (Feature #12606). Backend mockeado. Un test (o grupo) por AC; el mutante que cada
// aserto mata va en su comentario.
//
// Reglas que se certifican aquí y no en otro sitio: la palabra «tanda» no existe en la UI; hay UNA
// sola región `status` viva en cada modal; ni `extraccion`, ni uuid, ni VIN completo llegan al DOM
// de la cola; un aplicado o descartado se VE sin botones (ausentes, no apagados); y la primaria del
// panel nunca se apaga por validación.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from '@playwright/test';
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
    subidoPorNombre: 'Ana Pérez', aplicadoPorNombre: null, descartadoPorNombre: null,
    aplicadoMotivo: null, descartadoMotivo: null, soporteAplicadoId: null, ...extra,
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
    // HU #12634: la ficha ya explica Asociar y aplicar y deja de decir «no asocia ni aplica todavía».
    await expect(articulo.getByRole('heading', { name: 'Asociar y aplicar', exact: true })).toBeVisible();
    await expect(articulo.getByText(/No asocia ni aplica todavía/)).toHaveCount(0);
    await expect(articulo.getByText(/No abre archivos ZIP/)).toBeVisible();
    await expect(articulo.getByText(/No carga SOAT del canal Cliente/)).toBeVisible();
    await expect(articulo.getByText(/No muestra ni guarda datos de personas/)).toBeVisible();
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
    await expect(page.getByRole('button', { name: /^(Ver|Asociar) / }).first()).toBeVisible();
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
    await expect(consolidado.getByRole('button', { name: 'Asociar consolidado.pdf p. 3-4' })).toBeVisible();
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
  test('«Ver» (aplicado) abre el visor en la página del documento, la cabecera de 3 líneas y los chips por nivel; sin Asociar/Aplicar/Descartar', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    const APLICADO = { estado: 'aplicado', motivoPendiente: null, aplicadoEn: '2026-09-16T16:00:00.000Z', aplicadoAutomaticamente: true, paginas: [2], archivo: { nombre: 'dos.pdf', contentType: 'application/pdf' } };
    await mockCola(page, { items: [fila(APLICADO)], total: 1, page: 1, pageSize: 50 });
    await mockDetalle(page, detalle(APLICADO));
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
    // HU #12635 (slim §1.4): el chip dice «Aplicado automático» y el segundo texto ya no repite la palabra.
    await expect(lectura).toContainText('Aplicado automático');
    await expect(lectura).toContainText('16 sep 2026');
    await expect(lectura).not.toContainText('automático · 16 sep 2026');
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
    await page.getByRole('button', { name: 'Asociar transf.png' }).click();
    await expect(page.getByRole('dialog').getByRole('img', { name: 'transf.png' })).toBeVisible();

    await loginAs(page, FINANCIERA_USER, { funciones: SIN_ARCHIVO });
    await page.goto(RUTA);
    await page.getByRole('button', { name: 'Asociar transf.png' }).click();
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
    await page.getByRole('button', { name: 'Asociar recibo.pdf' }).click();
    let dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('alert')).toHaveText('Este comprobante ya no existe.');
    const antes = gets.length;
    await dialog.getByRole('button', { name: 'Actualizar la cola' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => gets.length).toBeGreaterThan(antes);

    modo = 500;
    await page.getByRole('button', { name: 'Asociar recibo.pdf' }).click();
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
    await page.getByRole('button', { name: 'Asociar recibo.pdf' }).click();
    const dialog = page.getByRole('dialog');
    const lectura = dialog.getByRole('region', { name: 'Lectura' });
    await expect(lectura).toContainText('FLITO no pudo leer este documento.');
    await expect(lectura).toContainText('Leído: sin identificar');
    // HU #12634: el panel lista 7 campos (placa, vin, idFlit, valor, fecha, número, emisor) + chip del tipo + chips de (1) y (3).
    await expect(lectura.getByText('Sin lectura', { exact: true })).toHaveCount(10);
    const releer = dialog.getByRole('button', { name: 'Releer' });
    await releer.click();
    await expect(dialog.getByRole('alert')).toHaveText('El lector sigue sin estar disponible. Inténtalo más tarde.');
    await expect(lectura.getByText('Sin lectura', { exact: true })).toHaveCount(10);
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
    await page.getByRole('button', { name: 'Asociar recibo.pdf' }).click();
    await expect(page.getByRole('dialog').getByRole('region', { name: 'Lectura' })).toContainText('Leído: Recibo de impuesto');
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Releer' })).toHaveCount(0);
    await expect(page.getByRole('dialog').getByText('FLITO no pudo leer este documento.')).toHaveCount(0);

    await loginAs(page, FINANCIERA_USER, { funciones: SIN_RELEER });
    await mockDetalle(page, SIN_LECTURA());
    await page.goto(RUTA);
    await page.getByRole('button', { name: 'Asociar recibo.pdf' }).click();
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

// ═══════════════════════════════ HU #12634 — Panel de asociación ═══════════════════════════════

const TRAMITE_1 = '44444444-4444-4444-8444-444444444444';
const TRAMITE_2 = '55555555-5555-4555-8555-555555555555';
const TRAMITE_3 = '66666666-6666-4666-8666-666666666666';
const ANTERIOR = '77777777-7777-4777-8777-777777777777';
const ADMITE_TODO = { derecho: 'admite', soat: 'admite', impuesto: 'admite', tramite_digital: 'admite', logistica: 'admite', servicios_adicionales: 'admite' };
const candidato = (extra: Record<string, unknown> = {}) => ({
  tramiteId: TRAMITE_1, idFlit: 'FLIT-10250', placa: 'XYZ789', vin: null, tipoTramite: 'Traspaso', empresa: 'Renting Andino',
  flitEstado: 'solicitado', liquidado: false, admite: ADMITE_TODO, ...extra,
});
const SEGUNDO = candidato({ tramiteId: TRAMITE_2, idFlit: 'FLIT-10198', tipoTramite: 'Matrícula', admite: { ...ADMITE_TODO, impuesto: 'ya_pagado' } });
const FIJADO = { tramite: { id: TRAMITE_1, idFlit: 'FLIT-10250', placa: 'XYZ789' }, cruce: 'placa', placaLeida: 'XYZ789' };
const CAMPOS_BASE = [
  campo('tipoDocumento', 'recibo_impuesto', 'alta'), campo('esComprobantePago', 'true', 'alta'), campo('concepto', 'impuesto', 'alta'),
  campo('placa', 'XYZ789', 'alta'), campo('vin', null, null), campo('idFlit', null, null), campo('valorTotal', '312000', 'alta'),
  campo('fechaPago', null, null), campo('numeroDocumento', '2026-00123', 'baja', false), campo('emisor', 'Gobernación', 'media', true),
];
/** Un pendiente con el cruce fijado a un candidato único (D-1) y lecturas confiables de (1) y (3). */
const detalleFijado = (extra: Record<string, unknown> = {}, campos = CAMPOS_BASE, candidatos: unknown[] = [candidato()]) =>
  ({ ...detalle({ ...FIJADO, ...extra }, campos), candidatos });

type Interceptado = { bodies: Record<string, unknown>[] };
type Respuesta = { status: number; body: unknown };
async function mockPost(page: Page, ruta: RegExp, responder: (body: Record<string, unknown>, n: number) => Respuesta | Promise<Respuesta>): Promise<Interceptado> {
  const bodies: Record<string, unknown>[] = [];
  await page.route(ruta, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    bodies.push(body);
    const r = await responder(body, bodies.length);
    return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body) });
  });
  return { bodies };
}
const RUTA_BUSCAR = /\/api\/flito\/comprobantes\/tramites\/buscar$/;
const RUTA_APLICAR = new RegExp(`/api/flito/comprobantes/${UUID_A}/aplicar$`);
const RUTA_DESCARTAR = /\/api\/flito\/comprobantes\/[0-9a-f-]+\/descartar$/;
const aplicado200 = (body: Record<string, unknown>) => ({ status: 200, body: { resultado: 'aplicado', comprobante: detalleFijado({ estado: 'aplicado', esPago: body.esPago, concepto: body.concepto }) } });

async function abrirPanel(page: Page, nombre = 'Asociar recibo.pdf') {
  await page.goto(RUTA);
  await page.getByRole('button', { name: nombre }).click();
  const dialog = page.getByRole('dialog', { name: /^Comprobante · / });
  await expect(dialog).toBeVisible();
  return dialog;
}
const combobox = (dialog: Locator) => dialog.getByRole('combobox', { name: 'Trámite' });
/** La única región `status` de la página (comparte elemento con el anuncio sr-only); el esqueleto de carga tiene la suya mientras refresca. */
const toast = (page: Page) => page.locator('p[role="status"]');
const SIN_BUSCAR = FUNCIONES_POR_ROL.financiera.filter((f) => f !== 'comprobantes.tramites.buscar');
const SIN_APLICAR = FUNCIONES_POR_ROL.financiera.filter((f) => f !== 'comprobantes.comprobante.aplicar');
const SIN_DESCARTAR = FUNCIONES_POR_ROL.financiera.filter((f) => f !== 'comprobantes.comprobante.descartar');

test.describe('HU #12634 · AC1 — tres decisiones pre-llenadas con confianza', () => {
  /** Mutantes: preseleccionar el radio con esComprobantePago no confiable (segundo test); lista flotante o `li > button`; no parar la propagación de Esc. */
  test('candidato único fijado: radio, trámite y concepto preseleccionados; campos con chip y Valor editable; ✕, ↓/Enter y Esc en cascada', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockCola(page, { items: [fila(FIJADO)], total: 1, page: 1, pageSize: 50 });
    await mockDetalle(page, detalleFijado());
    await mockArchivoPdf(page);
    const buscar = await mockPost(page, RUTA_BUSCAR, () => ({ status: 200, body: { candidatos: [] } }));
    const dialog = await abrirPanel(page);
    const lectura = dialog.getByRole('region', { name: 'Lectura' });

    await expect(dialog.getByRole('radio', { name: 'Comprobante de pago' })).toBeChecked();
    await expect(dialog.getByRole('radio', { name: 'Documentación del trámite' })).not.toBeChecked();
    const cb = combobox(dialog);
    await expect(cb).toHaveValue('FLIT-10250 · XYZ789');
    await expect(cb).toBeFocused();
    await expect(cb).toHaveAttribute('aria-expanded', 'false');
    await expect(dialog.getByRole('combobox', { name: 'Concepto' })).toHaveValue('impuesto');
    // Chips por nivel del servidor junto a cada decisión y campo; Tipo de documento solo en la cabecera.
    await expect(lectura.locator('legend')).toContainText('Alta');
    await expect(lectura.getByText('Leído: Recibo de impuesto')).toBeVisible();
    await expect(lectura.locator('label', { hasText: 'Tipo de documento' })).toHaveCount(0);
    const valor = dialog.getByLabel('Valor', { exact: true });
    await expect(valor).toHaveValue('312000');
    await expect(valor).toHaveAccessibleDescription('Pesos, sin puntos ni signo');
    await expect(dialog.getByLabel('Número de documento')).toHaveValue('2026-00123');
    await expect(lectura.getByText('Baja', { exact: true })).toHaveCount(1);
    await expect(lectura.getByText('Sin lectura', { exact: true })).toHaveCount(3);
    // Placa: chip y valor, sin input (solo lectura, explica el «Sugerido»).
    await expect(lectura.getByText('XYZ789', { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('Placa')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Aplicar' })).toBeEnabled();

    // ✕ «Quitar trámite»: campo vacío, lista abierta en flujo con el chip derivado de la placa leída.
    await dialog.getByRole('button', { name: 'Quitar trámite' }).click();
    await expect(cb).toHaveValue('');
    await expect(cb).toBeFocused();
    await expect(cb).toHaveAttribute('aria-expanded', 'true');
    const lista = dialog.getByRole('listbox', { name: 'Trámites' });
    await expect(lista).toBeVisible();
    const opcion = lista.getByRole('option');
    await expect(opcion).toHaveCount(1);
    await expect(opcion).toContainText('Sugerido · por placa');
    await expect(opcion).toContainText('FLIT-10250 · XYZ789');
    await expect(opcion).toContainText('Impuesto: admite');
    await expect(opcion.locator('button')).toHaveCount(0);
    await expect(cb).toHaveAttribute('aria-controls', (await lista.getAttribute('id')) ?? '');
    await expect(cb).toHaveAttribute('aria-activedescendant', (await opcion.getAttribute('id')) ?? '');
    await expect(lista).not.toHaveClass(/absolute/);

    // Esc cierra la lista y NO el panel; con la lista cerrada, ↓ la reabre y Enter elige.
    await page.keyboard.press('Escape');
    await expect(lista).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect(dialog.getByRole('listbox')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(cb).toHaveValue('FLIT-10250 · XYZ789');
    expect(buscar.bodies).toHaveLength(0);
    // Con la lista cerrada, Esc llega al modal y lo cierra.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  /** Mutante M1: preseleccionar el radio con `esPago` null → «ninguno marcado» cae. Mutante: preseleccionar con un candidato entre varios. */
  test('lecturas no confiables: nada preseleccionado; varios candidatos → campo vacío con la lista abierta; Documentación oculta Valor', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockCola(page, { items: [fila({ placaLeida: 'XYZ789' })], total: 1, page: 1, pageSize: 50 });
    await mockDetalle(page, detalleFijado(
      { tramite: null, cruce: null, esPago: null, concepto: null },
      [campo('tipoDocumento', 'recibo_impuesto', 'alta'), campo('esComprobantePago', 'true', 'baja', false), campo('concepto', 'impuesto', 'media', false), campo('placa', 'XYZ789', 'alta'), campo('valorTotal', null, null)],
      [candidato(), SEGUNDO],
    ));
    await mockArchivoPdf(page);
    const dialog = await abrirPanel(page);
    await expect(dialog.getByRole('radio', { name: 'Comprobante de pago' })).not.toBeChecked();
    await expect(dialog.getByRole('radio', { name: 'Documentación del trámite' })).not.toBeChecked();
    await expect(dialog.getByRole('combobox', { name: 'Concepto' })).toHaveValue('');
    const cb = combobox(dialog);
    await expect(cb).toHaveValue('');
    await expect(cb).toHaveAttribute('aria-expanded', 'true');
    const opciones = dialog.getByRole('listbox', { name: 'Trámites' }).getByRole('option');
    await expect(opciones).toHaveCount(2);
    await expect(opciones.nth(0)).toContainText('Sugerido · por placa');
    await expect(opciones.nth(1)).toContainText('FLIT-10198');
    // Sin concepto elegido, la 2.ª línea no dice admisión.
    await expect(opciones.nth(1)).not.toContainText('ya pagado');
    await dialog.getByRole('combobox', { name: 'Concepto' }).selectOption('impuesto');
    await cb.focus();
    await expect(opciones.nth(1)).toContainText('Impuesto: ya pagado');
    // El select marca la admisión del trámite elegido sin apagar opciones (D6).
    await opciones.nth(1).click();
    await expect(cb).toHaveValue('FLIT-10198 · XYZ789');
    const select = dialog.getByRole('combobox', { name: 'Concepto' });
    await expect(select.locator('option[value="impuesto"]')).toHaveText('Impuesto · ya pagado');
    await expect(select.locator('option[disabled]')).toHaveCount(0);
    // Valor: existe editable (vacío, «Sin lectura») con pago y desaparece con documentación (D3).
    await expect(dialog.getByLabel('Valor', { exact: true })).toHaveCount(1);
    await dialog.getByRole('radio', { name: 'Documentación del trámite' }).check();
    await expect(dialog.getByLabel('Valor', { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Adjuntar' })).toBeVisible();
    await dialog.getByRole('radio', { name: 'Comprobante de pago' }).check();
    await expect(dialog.getByLabel('Valor', { exact: true })).toHaveValue('');
  });

  /** Mutantes: GET con query o sin debounce (más de un POST); resultados delante de los sugeridos; tratar la respuesta vieja. */
  test('escribir ≥ 3 caracteres → UN POST {buscar} tras 300 ms, «Buscando…», resultados debajo de los sugeridos, sin resultados, error y maxlength', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockCola(page, { items: [fila({ placaLeida: 'XYZ789' })], total: 1, page: 1, pageSize: 50 });
    await mockDetalle(page, detalleFijado({ tramite: null, cruce: null }, CAMPOS_BASE, [candidato()]));
    await mockArchivoPdf(page);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const buscar = await mockPost(page, RUTA_BUSCAR, async (body, n) => {
      if (n === 1) { await held; return { status: 200, body: { candidatos: [candidato({ tramiteId: TRAMITE_3, idFlit: 'FLIT-09877', empresa: 'Andina Leasing', admite: { ...ADMITE_TODO, impuesto: 'no_gestionado' } }), candidato()] } }; }
      if (body.buscar === 'ZZZ999') return { status: 200, body: { candidatos: [] } };
      return { status: 500, body: { error: 'Se cayó' } };
    });
    const dialog = await abrirPanel(page);
    const cb = combobox(dialog);
    await expect(cb).toHaveAttribute('maxlength', '60');
    await cb.pressSequentially('XYZ7', { delay: 30 });
    await expect(dialog.getByRole('status')).toHaveText('Buscando…');
    await expect(dialog.getByRole('status')).toHaveCount(1);
    await expect.poll(() => buscar.bodies.length).toBe(1);
    expect(buscar.bodies[0]).toEqual({ buscar: 'XYZ7' });
    release();
    const opciones = dialog.getByRole('listbox', { name: 'Trámites' }).getByRole('option');
    // El sugerido que también volvió del buscador no se repite; el resultado va DEBAJO y sin chip.
    await expect(opciones).toHaveCount(2);
    await expect(opciones.nth(0)).toContainText('Sugerido · por placa');
    await expect(opciones.nth(1)).toContainText('FLIT-09877');
    await expect(opciones.nth(1)).not.toContainText('Sugerido');
    await expect(opciones.nth(1)).toContainText('Impuesto: no gestionado');
    await expect(dialog.getByRole('status')).toHaveCount(0);

    await cb.fill('ZZZ999');
    await expect(dialog.getByRole('status')).toHaveText('Ningún trámite coincide con «ZZZ999».');
    await expect(dialog.getByRole('listbox')).toHaveCount(0);
    await cb.fill('QQQ111');
    await expect(dialog.getByRole('alert')).toHaveText('No se pudo buscar. Vuelve a intentarlo.');
    expect(buscar.bodies).toHaveLength(3);
  });
});

test.describe('HU #12634 · AC2 — motivo solo cuando hay algo que justificar', () => {
  /** Mutantes: mandar `motivo` vacío o `campos` completos siempre (el body exacto cae); no montar el motivo al cambiar concepto o marca. */
  test('sugerido sin cambios → body sin motivo ni campos; editar Valor monta el motivo y viaja solo el delta; concepto y marca también lo montan', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    const gets = await mockCola(page, { items: [fila(FIJADO)], total: 1, page: 1, pageSize: 50 });
    await mockDetalle(page, detalleFijado());
    await mockArchivoPdf(page);
    const aplicar = await mockPost(page, RUTA_APLICAR, aplicado200);
    let dialog = await abrirPanel(page);
    await expect(dialog.getByLabel('Por qué cambias lo leído')).toHaveCount(0);
    const antes = gets.length;
    await dialog.getByRole('button', { name: 'Aplicar' }).click();
    await expect.poll(() => aplicar.bodies.length).toBe(1);
    expect(aplicar.bodies[0]).toEqual({ tramiteId: TRAMITE_1, concepto: 'impuesto', esPago: true });
    await expect(dialog).toHaveCount(0);
    await expect(toast(page)).toHaveText('Comprobante aplicado a FLIT-10250 · Impuesto.');
    await expect.poll(() => gets.length).toBeGreaterThan(antes);
    await expect(page.getByRole('heading', { level: 1, name: 'Finanzas — Comprobantes' })).toBeFocused();

    dialog = await abrirPanel(page);
    await dialog.getByLabel('Valor', { exact: true }).fill('350000');
    const motivo = dialog.getByLabel('Por qué cambias lo leído');
    await expect(motivo).toBeVisible();
    await expect(motivo).toHaveAttribute('maxlength', '500');
    await expect(motivo).toHaveAccessibleDescription(/Queda en la auditoría del comprobante\. No escribas datos personales/);
    await dialog.getByRole('button', { name: 'Aplicar' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Escribe por qué cambias lo leído (mínimo 5 caracteres).');
    await expect(motivo).toBeFocused();
    await expect(motivo).toHaveAttribute('aria-invalid', 'true');
    expect(aplicar.bodies).toHaveLength(1);
    await motivo.fill('Valor corregido');
    await dialog.getByRole('button', { name: 'Aplicar' }).click();
    await expect.poll(() => aplicar.bodies.length).toBe(2);
    expect(aplicar.bodies[1]).toEqual({ tramiteId: TRAMITE_1, concepto: 'impuesto', esPago: true, campos: { valorTotal: '350000' }, motivo: 'Valor corregido' });

    dialog = await abrirPanel(page);
    await dialog.getByRole('combobox', { name: 'Concepto' }).selectOption('soat');
    await expect(dialog.getByLabel('Por qué cambias lo leído')).toBeVisible();
    await dialog.getByRole('combobox', { name: 'Concepto' }).selectOption('impuesto');
    await expect(dialog.getByLabel('Por qué cambias lo leído')).toHaveCount(0);
    await dialog.getByRole('radio', { name: 'Documentación del trámite' }).check();
    await expect(dialog.getByLabel('Por qué cambias lo leído')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Adjuntar' })).toBeVisible();
  });
});

test.describe('HU #12634 · AC3 — validación al pulsar, no botón muerto', () => {
  /** Mutante M2: apagar la primaria con el formulario incompleto → `toBeEnabled` cae. Mutante: validar sin foco al primero. */
  test('todo por decidir: Aplicar encendido; al pulsar, alerts con el copy exacto y foco al primero, 0 POST; en vuelo «Aplicando…» apagado', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockCola(page, { items: [fila({ placaLeida: 'XYZ789' })], total: 1, page: 1, pageSize: 50 });
    await mockDetalle(page, detalleFijado(
      { tramite: null, cruce: null, esPago: null, concepto: null },
      [campo('tipoDocumento', null, null), campo('esComprobantePago', null, null), campo('concepto', null, null), campo('placa', 'XYZ789', 'alta'), campo('valorTotal', null, null)],
      [candidato()],
    ));
    await mockArchivoPdf(page);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const aplicar = await mockPost(page, RUTA_APLICAR, async (body) => { await held; return aplicado200(body); });
    const dialog = await abrirPanel(page);
    const primaria = dialog.getByRole('button', { name: 'Aplicar' });
    await expect(primaria).toBeEnabled();
    await primaria.click();
    const alerts = dialog.getByRole('alert');
    await expect(alerts).toHaveText(['Di si es un comprobante de pago o documentación.', 'Elige el trámite al que pertenece.', 'Elige el concepto.']);
    await expect(dialog.getByRole('radio', { name: 'Comprobante de pago' })).toBeFocused();
    await expect(dialog.getByRole('radio', { name: 'Comprobante de pago' })).toHaveAttribute('aria-invalid', 'true');
    await expect(combobox(dialog)).toHaveAttribute('aria-invalid', 'true');
    await expect(dialog.getByRole('combobox', { name: 'Concepto' })).toHaveAttribute('aria-invalid', 'true');
    expect(aplicar.bodies).toHaveLength(0);
    await expect(primaria).toBeEnabled();

    await dialog.getByRole('radio', { name: 'Comprobante de pago' }).check();
    await combobox(dialog).focus();
    await dialog.getByRole('listbox').getByRole('option').first().click();
    await dialog.getByRole('combobox', { name: 'Concepto' }).selectOption('impuesto');
    await primaria.click();
    await expect(alerts).toHaveText(['Escribe el valor pagado: sin valor no se puede aplicar un pago.', 'Escribe por qué cambias lo leído (mínimo 5 caracteres).']);
    await expect(dialog.getByLabel('Valor', { exact: true })).toBeFocused();
    expect(aplicar.bodies).toHaveLength(0);
    await dialog.getByLabel('Valor', { exact: true }).fill('312000');
    await dialog.getByLabel('Por qué cambias lo leído').fill('Elegido a mano');
    await primaria.click();
    await expect(dialog.getByRole('button', { name: 'Aplicando…' })).toBeDisabled();
    release();
    await expect(dialog).toHaveCount(0);
    expect(aplicar.bodies[0]).toEqual({ tramiteId: TRAMITE_1, concepto: 'impuesto', esPago: true, campos: { valorTotal: '312000' }, motivo: 'Elegido a mano' });
  });
});

test.describe('HU #12634 · AC4 — respuestas por código', () => {
  const dangerInk = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--flit-danger-ink').trim());

  /** Mutante M2 del gate: tratar `ya_pagado` / `destino_no_admite` como alert rojo sin botón → cae. Mutante: reenviar sin `campos`/`motivo`. */
  test('409 destino_no_admite y ya_pagado con puedeAdjuntar → bloque sin rojo + «Adjuntar como documentación» → 2.º POST esPago:false conservando lo escrito; sin puedeAdjuntar → sin botón', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockCola(page, { items: [fila(FIJADO)], total: 1, page: 1, pageSize: 50 });
    await mockDetalle(page, detalleFijado());
    await mockArchivoPdf(page);
    let modo: 'destino' | 'pagado' | 'sin_boton' = 'destino';
    const aplicar = await mockPost(page, RUTA_APLICAR, (body) => {
      if (body.esPago === false) return aplicado200(body);
      if (modo === 'destino') return { status: 409, body: { error: 'El pago de impuesto aún no se aplica desde aquí', codigo: 'destino_no_admite', detalle: 'Los pagos se aplican en la siguiente entrega', puedeAdjuntar: true } };
      if (modo === 'pagado') return { status: 409, body: { error: 'Ya pagado', codigo: 'ya_pagado', detalle: 'Ese impuesto ya está pagado', puedeAdjuntar: true } };
      return { status: 409, body: { error: 'Ya pagado', codigo: 'ya_pagado', detalle: 'Ese impuesto ya está pagado', puedeAdjuntar: false } };
    });
    const rojo = await dangerInk(page);
    let dialog = await abrirPanel(page);
    await dialog.getByLabel('Valor', { exact: true }).fill('350000');
    await dialog.getByLabel('Por qué cambias lo leído').fill('Valor corregido');
    await dialog.getByRole('button', { name: 'Aplicar' }).click();
    let alerta = dialog.getByRole('alert');
    await expect(alerta).toContainText('FLIT-10250 no admite Impuesto como pago: Los pagos se aplican en la siguiente entrega. Puedes adjuntar este documento como documentación del trámite.');
    await expect(alerta).not.toHaveClass(/text-red/);
    expect(await alerta.evaluate((el) => getComputedStyle(el).color)).not.toBe(rojo);
    await expect(dialog.getByRole('button', { name: 'Aplicar' })).toBeEnabled();
    await expect(dialog.getByLabel('Valor', { exact: true })).toHaveValue('350000');
    await alerta.getByRole('button', { name: 'Adjuntar como documentación' }).click();
    await expect.poll(() => aplicar.bodies.length).toBe(2);
    expect(aplicar.bodies[1]).toEqual({ tramiteId: TRAMITE_1, concepto: 'impuesto', esPago: false, campos: { valorTotal: '350000' }, motivo: 'Valor corregido' });
    await expect(toast(page)).toHaveText('Documentación adjuntada a FLIT-10250.');

    modo = 'pagado';
    dialog = await abrirPanel(page);
    await dialog.getByRole('button', { name: 'Aplicar' }).click();
    alerta = dialog.getByRole('alert');
    await expect(alerta).toContainText('FLIT-10250 no admite Impuesto como pago: Ese impuesto ya está pagado.');
    await expect(alerta.getByRole('button', { name: 'Adjuntar como documentación' })).toBeVisible();
    await expect(dialog.getByRole('radio', { name: 'Comprobante de pago' })).toBeChecked();
    await alerta.getByRole('button', { name: 'Adjuntar como documentación' }).click();
    await expect.poll(() => aplicar.bodies.length).toBe(4);
    expect(aplicar.bodies[3]).toMatchObject({ esPago: false });

    modo = 'sin_boton';
    dialog = await abrirPanel(page);
    await dialog.getByRole('button', { name: 'Aplicar' }).click();
    alerta = dialog.getByRole('alert');
    await expect(alerta).toHaveText('FLIT-10250 no admite Impuesto como pago: Ese impuesto ya está pagado.');
    await expect(alerta.getByRole('button')).toHaveCount(0);
  });

  /** Mutante: esperar al 409 para avisar (0 POST aquí); pintar el aviso como alert. */
  test('aviso anticipado D6: pago + trámite + concepto ya pagado → status «Ese impuesto ya está pagado.» + botón, sin POST', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockCola(page, { items: [fila({ placaLeida: 'XYZ789' })], total: 1, page: 1, pageSize: 50 });
    await mockDetalle(page, detalleFijado({ tramite: { id: TRAMITE_2, idFlit: 'FLIT-10198', placa: 'XYZ789' } }, CAMPOS_BASE, [SEGUNDO]));
    await mockArchivoPdf(page);
    const aplicar = await mockPost(page, RUTA_APLICAR, aplicado200);
    const dialog = await abrirPanel(page);
    const aviso = dialog.getByRole('status');
    await expect(aviso).toHaveCount(1);
    await expect(aviso).toContainText('Ese impuesto ya está pagado.');
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    expect(aplicar.bodies).toHaveLength(0);
    await aviso.getByRole('button', { name: 'Adjuntar como documentación' }).click();
    await expect(dialog.getByRole('radio', { name: 'Documentación del trámite' })).toBeChecked();
    await expect(dialog.getByRole('status')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Adjuntar' })).toBeVisible();
    expect(aplicar.bodies).toHaveLength(0);
  });

  /** Mutantes: decidir por texto (los cuerpos traen textos distintos a los de la ficha); apagar la primaria tras un 500. */
  test('tramite_liquidado (enlace), valor_ya_documentado (Reemplazar → descartar anterior + reintento), ya_resuelto/404 (Actualizar la cola), 403, datos_invalidos, valor_requerido y 500', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    const gets = await mockCola(page, { items: [fila(FIJADO)], total: 1, page: 1, pageSize: 50 });
    await mockDetalle(page, detalleFijado());
    await mockArchivoPdf(page);
    const cola: Respuesta[] = [
      { status: 409, body: { error: 'Liquidación sellada', codigo: 'tramite_liquidado' } },
      { status: 409, body: { error: 'Otro comprobante ocupa (trámite, concepto)', codigo: 'valor_ya_documentado', comprobanteAnteriorId: ANTERIOR } },
      { status: 200, body: aplicado200({ esPago: true, concepto: 'impuesto' }).body },
      { status: 409, body: { error: 'Ya no está pendiente', codigo: 'ya_resuelto' } },
      { status: 404, body: { error: 'El trámite no existe', codigo: 'no_encontrado' } },
      { status: 403, body: { error: 'Sin función', funcion: 'comprobantes.comprobante.aplicar' } },
      { status: 400, body: { error: 'Confirmar campos exige motivo', codigo: 'datos_invalidos' } },
      { status: 400, body: { error: 'Un pago exige valor', codigo: 'valor_requerido' } },
      { status: 500, body: { error: 'Se cayó' } },
    ];
    const aplicar = await mockPost(page, RUTA_APLICAR, () => cola.shift()!);
    const descartar = await mockPost(page, RUTA_DESCARTAR, () => ({ status: 200, body: { ok: true } }));
    let dialog = await abrirPanel(page);
    const primaria = dialog.getByRole('button', { name: 'Aplicar' });

    await primaria.click();
    let alerta = dialog.getByRole('alert');
    await expect(alerta).toContainText('La liquidación de FLIT-10250 está sellada. Reversa la liquidación en el reporte de costos y vuelve a aplicar.');
    await expect(alerta.getByRole('link', { name: 'Ir al reporte de costos' })).toHaveAttribute('href', '/finanzas/reporte-costos');

    await primaria.click();
    await expect(alerta).toContainText('FLIT-10250 ya tiene un valor de Impuesto documentado con otro comprobante. Para usar este, descarta el anterior.');
    await alerta.getByRole('button', { name: 'Reemplazar' }).click();
    const motivoAnterior = dialog.getByLabel('Motivo para descartar el anterior');
    await expect(motivoAnterior).toHaveAccessibleDescription(/No escribas datos personales/);
    await dialog.getByRole('button', { name: 'Descartar el anterior y aplicar' }).click();
    await expect(dialog.getByRole('alert').last()).toHaveText('Escribe el motivo del descarte (mínimo 5 caracteres).');
    expect(descartar.bodies).toHaveLength(0);
    await motivoAnterior.fill('Duplicado del anterior');
    await dialog.getByRole('button', { name: 'Descartar el anterior y aplicar' }).click();
    await expect(dialog).toHaveCount(0);
    expect(descartar.bodies).toEqual([{ motivo: 'Duplicado del anterior' }]);
    expect(aplicar.bodies).toHaveLength(3);
    await expect(toast(page)).toHaveText('Comprobante aplicado a FLIT-10250 · Impuesto.');

    dialog = await abrirPanel(page);
    await dialog.getByRole('button', { name: 'Aplicar' }).click();
    alerta = dialog.getByRole('alert');
    await expect(alerta).toContainText('Alguien resolvió este comprobante mientras lo tenías abierto.');
    let antes = gets.length;
    await alerta.getByRole('button', { name: 'Actualizar la cola' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => gets.length).toBeGreaterThan(antes);

    dialog = await abrirPanel(page);
    await dialog.getByRole('button', { name: 'Aplicar' }).click();
    alerta = dialog.getByRole('alert');
    await expect(alerta).toContainText('El trámite no existe');
    antes = gets.length;
    await alerta.getByRole('button', { name: 'Actualizar la cola' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => gets.length).toBeGreaterThan(antes);

    dialog = await abrirPanel(page);
    await dialog.getByRole('button', { name: 'Aplicar' }).click();
    alerta = dialog.getByRole('alert');
    await expect(alerta).toHaveText('Tu usuario no puede aplicar comprobantes. Vuelve a entrar para actualizar tus permisos.');
    await expect(alerta.getByRole('button')).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Aplicar' }).click();
    await expect(alerta).toHaveText('Revisa los datos marcados. Confirmar campos exige motivo');

    await dialog.getByRole('button', { name: 'Aplicar' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Escribe el valor pagado: sin valor no se puede aplicar un pago.');
    await expect(dialog.getByLabel('Valor', { exact: true })).toHaveAttribute('aria-invalid', 'true');
    await expect(dialog.getByLabel('Valor', { exact: true })).toBeFocused();

    await dialog.getByRole('button', { name: 'Aplicar' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('No se pudo aplicar. Vuelve a intentarlo. Se cayó');
    await expect(dialog.getByRole('button', { name: 'Aplicar' })).toBeEnabled();
    expect(aplicar.bodies).toHaveLength(9);
  });
});

test.describe('HU #12634 · AC5 — Descartar en línea', () => {
  /** Mutantes: descartar sin motivo (0 POST con < 5); cerrar el panel con Esc dentro del bloque; no devolver el foco a «Descartar». */
  test('bloque con motivo y nota; Esc/Cancelar cierran solo el bloque y devuelven el foco; 200 → toast y cierre; ya_resuelto → Actualizar la cola', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    const gets = await mockCola(page, { items: [fila(FIJADO)], total: 1, page: 1, pageSize: 50 });
    await mockDetalle(page, detalleFijado());
    await mockArchivoPdf(page);
    let modo: 200 | 409 = 200;
    const descartar = await mockPost(page, RUTA_DESCARTAR, () => (modo === 200
      ? { status: 200, body: { ok: true } }
      : { status: 409, body: { error: 'Ya resuelto', codigo: 'ya_resuelto' } }));
    let dialog = await abrirPanel(page);
    const botonDescartar = dialog.getByRole('button', { name: 'Descartar' });
    await botonDescartar.click();
    const motivo = dialog.getByLabel('Motivo del descarte (mínimo 5 caracteres)');
    await expect(motivo).toBeFocused();
    await expect(motivo).toHaveAttribute('maxlength', '500');
    await expect(motivo).toHaveAccessibleDescription(/No escribas datos personales/);
    await expect(dialog.getByText('El documento queda como descartado y su archivo deja de contar como duplicado: se podrá volver a cargar.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Aplicar' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(motivo).toHaveCount(0);
    await expect(botonDescartar).toBeFocused();

    await botonDescartar.click();
    await dialog.getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialog.getByLabel('Motivo del descarte (mínimo 5 caracteres)')).toHaveCount(0);
    await expect(botonDescartar).toBeFocused();

    await botonDescartar.click();
    await dialog.getByLabel('Motivo del descarte (mínimo 5 caracteres)').fill('mal');
    await dialog.getByRole('button', { name: 'Descartar', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Escribe el motivo del descarte (mínimo 5 caracteres).');
    expect(descartar.bodies).toHaveLength(0);
    await dialog.getByLabel('Motivo del descarte (mínimo 5 caracteres)').fill('No pertenece a ningún trámite');
    const antes = gets.length;
    await dialog.getByRole('button', { name: 'Descartar', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(descartar.bodies).toEqual([{ motivo: 'No pertenece a ningún trámite' }]);
    await expect(toast(page)).toHaveText('Comprobante descartado.');
    await expect.poll(() => gets.length).toBeGreaterThan(antes);

    modo = 409;
    dialog = await abrirPanel(page);
    await dialog.getByRole('button', { name: 'Descartar' }).click();
    await dialog.getByLabel('Motivo del descarte (mínimo 5 caracteres)').fill('No pertenece a ningún trámite');
    await dialog.getByRole('button', { name: 'Descartar', exact: true }).click();
    const alerta = dialog.getByRole('alert');
    await expect(alerta).toContainText('Alguien resolvió este comprobante mientras lo tenías abierto.');
    await alerta.getByRole('button', { name: 'Actualizar la cola' }).click();
    await expect(dialog).toHaveCount(0);
  });
});

test.describe('HU #12634 · AC6 — solo lectura de aplicados y descartados', () => {
  const APLICADO = { ...FIJADO, estado: 'aplicado', motivoPendiente: null, aplicadoEn: '2026-09-16T16:00:00.000Z', aplicadoAutomaticamente: false, aplicadoPorNombre: 'Luis Gómez', valor: 312000, aplicadoMotivo: 'Placa corregida a mano', soporteAplicadoId: ANTERIOR };
  const DESCARTADO = { id: UUID_C, estado: 'descartado', motivoPendiente: null, descartadoEn: '2026-09-15T13:10:00.000Z', descartadoPorNombre: 'Ana Pérez', descartadoMotivo: 'No pertenece a ningún trámite', archivo: { nombre: 'transf.png', contentType: 'image/png' } };
  const CAMPOS_APLICADO = [campo('valorTotal', '312000', 'alta'), { ...campo('numeroDocumento', '2026-00123', 'alta'), confirmadoPor: 'Luis Gómez' }];

  /** Mutantes: pintar el panel (inputs o botones) sobre un aplicado; decir «Valor» en vez de «Valor al aplicar»; pedir el archivo sin `?aplicado=1`; pintar el enlace sin `soporteAplicadoId` o sin la función. */
  test('«Ver» sobre un aplicado: ficha con estado, línea de asociación, «Valor al aplicar», motivo, «Ver el soporte aplicado» (?aplicado=1), chips y sin botones; descartado: por quién, cuándo y motivo; ✕ y Esc cierran', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockCola(page, { items: [fila(APLICADO), fila(DESCARTADO)], total: 2, page: 1, pageSize: 50 });
    await mockDetalle(page, { ...detalleFijado(APLICADO, CAMPOS_APLICADO), candidatos: [] });
    await page.route(new RegExp(`/api/flito/comprobantes/${UUID_C}$`), (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...detalle(DESCARTADO), candidatos: [] }) }));
    await mockArchivoPdf(page);
    const soportes: string[] = [];
    await page.route(/\/api\/flito\/comprobantes\/[0-9a-f-]+\/archivo\?aplicado=1$/, (route) => {
      soportes.push(new URL(route.request().url()).search);
      return route.fulfill({ status: 200, contentType: 'application/pdf', path: PDF_DOS_PAGINAS });
    });
    await page.goto(RUTA);
    await expect(page.getByRole('button', { name: 'Asociar recibo.pdf' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Ver recibo.pdf' }).click();
    let dialog = page.getByRole('dialog', { name: /^Comprobante · recibo\.pdf/ });
    const lectura = dialog.getByRole('region', { name: 'Lectura' });
    await expect(lectura).toContainText('Aplicado manual');
    await expect(lectura).toContainText('por Luis Gómez · 16 sep 2026');
    await expect(lectura).not.toContainText('manual · por');
    await expect(lectura).toContainText('Comprobante de pago · Impuesto · FLIT-10250 · XYZ789 · cruce por placa');
    await expect(lectura).toContainText('Valor al aplicar');
    await expect(lectura).toContainText('$ 312.000');
    await expect(lectura.getByText('Valor', { exact: true })).toHaveCount(0);
    await expect(lectura).toContainText('Motivo: «Placa corregida a mano»');
    await expect(lectura).toContainText('Confirmado');
    await expect(lectura.locator('input, textarea, select')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: /Asociar|Aplicar|Adjuntar|Descartar|Releer|Reemplazar/ })).toHaveCount(0);
    await expect(dialog.locator('button[disabled]')).toHaveCount(0);
    const popup = page.waitForEvent('popup');
    await dialog.getByRole('button', { name: 'Ver el soporte aplicado ↗' }).click();
    await popup;
    await expect.poll(() => soportes).toEqual(['?aplicado=1']);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    await page.getByRole('button', { name: 'Ver transf.png' }).click();
    dialog = page.getByRole('dialog', { name: /^Comprobante · transf\.png/ });
    const lecturaDescartado = dialog.getByRole('region', { name: 'Lectura' });
    await expect(lecturaDescartado).toContainText('Descartado por Ana Pérez · 15 sep 2026');
    await expect(lecturaDescartado).toContainText('Motivo: «No pertenece a ningún trámite»');
    await expect(dialog.getByRole('button', { name: /Asociar|Aplicar|Adjuntar|Descartar|Releer|soporte/ })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Cerrar' }).click();
    await expect(dialog).toHaveCount(0);
  });

  /** Mutantes: enlace sin `soporteAplicadoId`; enlace sin `comprobantes.archivo.descargar`; «Motivo:» con motivo null. */
  test('sin soporteAplicadoId o sin archivo.descargar no hay «Ver el soporte aplicado»; automático sin motivo no pinta «Motivo:»', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockCola(page, { items: [fila(APLICADO)], total: 1, page: 1, pageSize: 50 });
    await mockDetalle(page, { ...detalleFijado({ ...APLICADO, aplicadoAutomaticamente: true, aplicadoPorNombre: null, aplicadoMotivo: null, soporteAplicadoId: null }, CAMPOS_APLICADO), candidatos: [] });
    await mockArchivoPdf(page);
    await page.goto(RUTA);
    await page.getByRole('button', { name: 'Ver recibo.pdf' }).click();
    let dialog = page.getByRole('dialog', { name: /^Comprobante · recibo\.pdf/ });
    await expect(dialog.getByRole('region', { name: 'Lectura' })).toContainText('Aplicado automático');
    await expect(dialog.getByRole('region', { name: 'Lectura' })).toContainText('16 sep 2026');

    await expect(dialog.getByRole('button', { name: /soporte aplicado/ })).toHaveCount(0);
    await expect(dialog.getByText(/^Motivo:/)).toHaveCount(0);
    await page.keyboard.press('Escape');

    await loginAs(page, FINANCIERA_USER, { funciones: SIN_ARCHIVO });
    await mockDetalle(page, { ...detalleFijado(APLICADO, CAMPOS_APLICADO), candidatos: [] });
    await page.goto(RUTA);
    await page.getByRole('button', { name: 'Ver recibo.pdf' }).click();
    dialog = page.getByRole('dialog', { name: /^Comprobante · recibo\.pdf/ });
    await expect(dialog.getByRole('region', { name: 'Lectura' })).toContainText('Motivo: «Placa corregida a mano»');
    await expect(dialog.getByRole('button', { name: /soporte aplicado/ })).toHaveCount(0);
  });
});

test.describe('HU #12634 · AC7 — permisos por función y accesibilidad', () => {
  /** Mutantes: llamar al buscador sin la función (POST > 0); pintar la primaria sin `aplicar`; pintar «Descartar» sin `descartar`. */
  test('sin tramites.buscar: los candidatos se listan, escribir muestra el 403 con 0 POST; sin candidatos → línea (g) sin primaria; sin aplicar → línea; sin descartar → sin botón', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: SIN_BUSCAR });
    await mockCola(page, { items: [fila({ placaLeida: 'XYZ789' })], total: 1, page: 1, pageSize: 50 });
    await mockDetalle(page, detalleFijado({ tramite: null, cruce: null }, CAMPOS_BASE, [candidato()]));
    await mockArchivoPdf(page);
    const buscar = await mockPost(page, RUTA_BUSCAR, () => ({ status: 200, body: { candidatos: [] } }));
    let dialog = await abrirPanel(page);
    const cb = combobox(dialog);
    await expect(cb).not.toHaveAttribute('readonly');
    await expect(dialog.getByRole('listbox').getByRole('option')).toHaveCount(1);
    await cb.pressSequentially('XYZ7', { delay: 30 });
    await expect(dialog.getByRole('alert')).toContainText('Tu usuario no puede buscar trámites');
    await expect(dialog.getByRole('alert')).toContainText('“Buscar trámites para un comprobante”');
    await page.waitForTimeout(500);
    expect(buscar.bodies).toHaveLength(0);
    await expect(dialog.getByRole('button', { name: 'Aplicar' })).toBeVisible();
    await page.keyboard.press('Escape');

    await mockDetalle(page, detalleFijado({ tramite: null, cruce: null }, CAMPOS_BASE, []));
    dialog = await abrirPanel(page);
    await expect(dialog.getByRole('combobox', { name: 'Trámite' })).toHaveCount(0);
    await expect(dialog.getByText(/No hay trámites sugeridos para este documento y tu usuario no puede buscar trámites/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Aplicar|Adjuntar/ })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Descartar' })).toBeVisible();
    await page.keyboard.press('Escape');

    await loginAs(page, FINANCIERA_USER, { funciones: SIN_APLICAR });
    await mockDetalle(page, detalleFijado());
    dialog = await abrirPanel(page);
    await expect(dialog.getByRole('button', { name: /Aplicar|Adjuntar/ })).toHaveCount(0);
    await expect(dialog.getByText('Tu usuario puede ver este comprobante pero no aplicarlo.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Descartar' })).toBeVisible();
    await page.keyboard.press('Escape');

    await loginAs(page, FINANCIERA_USER, { funciones: SIN_DESCARTAR });
    dialog = await abrirPanel(page);
    await expect(dialog.getByRole('button', { name: 'Aplicar' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Descartar' })).toHaveCount(0);
  });

  test('a11y (axe) en el panel lleno con la lista abierta y con el bloque de descarte; un único status vivo; sin uuid ni VIN en atributos', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockCola(page, { items: [fila({ placaLeida: 'XYZ789', vinLeido: VIN_COMPLETO })], total: 1, page: 1, pageSize: 50 });
    await mockDetalle(page, detalleFijado({ tramite: null, cruce: null, vinLeido: VIN_COMPLETO }, [...CAMPOS_BASE.filter((c) => c.campo !== 'vin'), campo('vin', VIN_COMPLETO, 'alta')], [candidato({ vin: VIN_COMPLETO }), SEGUNDO]));
    await mockArchivoPdf(page);
    const dialog = await abrirPanel(page);
    await expect(dialog.getByRole('listbox').getByRole('option')).toHaveCount(2);
    await expect(dialog.getByRole('status')).toHaveCount(0);
    esperarSinViolacionesGraves(await correrAxe(page), 'panel de asociación con la lista abierta');
    await dialog.getByRole('listbox').getByRole('option').first().click();
    await dialog.getByRole('button', { name: 'Aplicar' }).click();
    await expect(dialog.getByRole('alert').first()).toBeVisible();
    esperarSinViolacionesGraves(await correrAxe(page), 'panel de asociación con errores de validación');
    await dialog.getByRole('button', { name: 'Descartar' }).click();
    await expect(dialog.getByLabel('Motivo del descarte (mínimo 5 caracteres)')).toBeVisible();
    esperarSinViolacionesGraves(await correrAxe(page), 'panel de asociación con el bloque de descarte');
    expect(await dialog.getByRole('status').count()).toBeLessThanOrEqual(1);
    // Las object URL (`blob:…/<uuid>`) del visor no son ids de negocio: se excluyen.
    const atributos = await dialog.evaluate((el) => Array.from(el.querySelectorAll('*')).flatMap((n) => Array.from(n.attributes).map((a) => a.value)).filter((v) => !v.startsWith('blob:')).join('\n'));
    expect(atributos).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
    expect(atributos).not.toContain(VIN_COMPLETO);
  });
});

test.describe('HU #12634 · AC8 — esPdf sale del DTO o de la cabecera, no de blob.type', () => {
  /** Mutante M3: volver a `blob.type.includes('pdf')` → el PDF que llega como octet-stream se pintaría como <img> y el test cae. */
  test('blob sin tipo útil (octet-stream) sobre un PDF → visor de páginas y 0 <img> del archivo; PNG igual → <img alt="{archivo}">', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockCola(page, { items: [fila(FIJADO), OTRO_LOTE], total: 2, page: 1, pageSize: 50 });
    await mockDetalle(page, detalleFijado());
    await page.route(new RegExp(`/api/flito/comprobantes/${UUID_C}$`), (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detalle({ id: UUID_C, archivo: { nombre: 'transf.png', contentType: 'image/png' } })) }));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    // Lo que devuelve S3 para un objeto subido sin Content-Type: `binary/octet-stream`. `blob.type` no dice «pdf» ni «png».
    const tipos: string[] = [];
    await page.route(/\/api\/flito\/comprobantes\/[0-9a-f-]+\/archivo$/, (route) => {
      const esPng = route.request().url().includes(UUID_C);
      return route.fulfill({ status: 200, contentType: 'binary/octet-stream', body: esPng ? png : readFileSync(PDF_DOS_PAGINAS) });
    });
    page.on('response', (r) => { if (/\/archivo$/.test(r.url())) tipos.push(r.headers()['content-type'] ?? ''); });
    let dialog = await abrirPanel(page);
    await expect(dialog.locator('img[alt*=" — página "]')).toHaveCount(2);
    await expect(dialog.getByRole('img', { name: 'recibo.pdf', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    dialog = await abrirPanel(page, 'Asociar transf.png');
    await expect(dialog.getByRole('img', { name: 'transf.png' })).toBeVisible();
    await expect(dialog.locator('img[alt*=" — página "]')).toHaveCount(0);
    expect(tipos.every((t) => !t.includes('pdf') && !t.includes('png'))).toBe(true);
  });
});

// ═══════════ HU #12635 — Estado de asociación, chip «Aplicados», enlace al trámite, ficha ═══════════
// Matriz del QA (comentario 29463012): TC-01…TC-14. Backend mockeado; `gets` captura la query de la cola.

const UUID_D = '88888888-8888-4888-8888-888888888888';
const UUID_E = '99999999-9999-4999-8999-999999999999';
const UUID_F = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const UUID_T = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const TRAMITE_ABC = { id: UUID_T, idFlit: 'FLIT-ARHZZ1', placa: 'ABC123' };
const APLICADO_AUTO = { estado: 'aplicado', motivoPendiente: null, aplicadoEn: '2026-09-16T16:00:00.000Z', aplicadoAutomaticamente: true, esPago: true, tramite: TRAMITE_ABC, cruce: 'placa' };
const SEIS_FILAS = {
  items: [
    fila({ id: UUID_A, archivo: { nombre: 'f1-pendiente.pdf', contentType: 'application/pdf' }, motivoPendiente: 'leido' }),
    fila({ id: UUID_B, archivo: { nombre: 'f2-auto.pdf', contentType: 'application/pdf' }, ...APLICADO_AUTO }),
    fila({ id: UUID_C, archivo: { nombre: 'f3-manual.pdf', contentType: 'application/pdf' }, ...APLICADO_AUTO, aplicadoAutomaticamente: false, aplicadoPorNombre: 'Luis Gómez' }),
    // (4) el caso del mutante AC1: documentación aplicada automáticamente es «Adjuntado», no «Aplicado automático».
    fila({ id: UUID_D, archivo: { nombre: 'f4-adjuntado.pdf', contentType: 'application/pdf' }, ...APLICADO_AUTO, esPago: false }),
    fila({ id: UUID_E, archivo: { nombre: 'f5-rechazado.pdf', contentType: 'application/pdf' }, motivoPendiente: 'destino_no_admite', detallePendiente: 'Ese SOAT ya está pagado', tramite: TRAMITE_ABC, cruce: 'placa' }),
    fila({ id: UUID_F, archivo: { nombre: 'f6-descartado.pdf', contentType: 'application/pdf' }, estado: 'descartado', motivoPendiente: null, descartadoEn: '2026-09-15T13:10:00.000Z', descartadoPorNombre: 'Ana Pérez' }),
  ],
  total: 6, page: 1, pageSize: 50,
};
const TONO_POR_TINTA: Record<string, string> = {
  'var(--flit-success-ink)': 'success', 'var(--flit-blue-ink)': 'active', 'var(--flit-warning-ink)': 'warning',
  // HU #12819: la tinta de `neutral` pasó a su token de chip, con par oscuro legible.
  'var(--flit-chip-neutral-ink)': 'neutral', 'var(--flit-danger-ink)': 'danger',
};
const tonoDe = (chip: Locator) => chip.evaluate((el) => (el as HTMLElement).style.color).then((c) => TONO_POR_TINTA[c] ?? c);
const selectorAsociacion = (page: Page) => page.getByRole('combobox', { name: 'Estado de asociación' });
const enlaceTramite = (ambito: Locator | Page) => ambito.getByRole('link', { name: /^Ver trámite FLIT-ARHZZ1/ });
const CON_VER_SOPORTES = { ...FINANCIERA_USER, funciones: [...FUNCIONES_POR_ROL.financiera, 'tramites.tramite.ver_soportes'] };
const SOPORTES = [
  { id: 'sp1', origen: 'comprobante', tipo: 'comprobante_pago', nombreArchivo: 'f2-auto.pdf', url: '/api/files?key=a', subidoEn: '2026-09-16T16:00:00.000Z' },
  { id: 'sp2', origen: 'soat', tipo: 'factura_soat', nombreArchivo: 'soat.pdf', url: '/api/files?key=b', subidoEn: '2026-09-01T00:00:00.000Z' },
];

test.describe('HU #12635 · AC1 — seis estados de asociación: chip y filtro', () => {
  /** Mutante M-AC1: derivar «Adjuntado» (o «Aplicado automático») sin mirar `esPago` → la fila (4) cae. */
  test('TC-01 seis filas → seis chips con su tono; aplicado + esPago=false + automático dice «Adjuntado»; sin uuid ni VIN en el DOM', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockCola(page, SEIS_FILAS);
    await page.goto(RUTA);
    await page.getByRole('button', { name: 'Todos', exact: true }).click();
    const tabla = page.getByRole('region', { name: 'Cola de comprobantes' });
    const esperado: [string, string, string][] = [
      ['f1-pendiente.pdf', 'Pendiente de asociar', 'warning'], ['f2-auto.pdf', 'Aplicado automático', 'success'],
      ['f3-manual.pdf', 'Aplicado manual', 'success'], ['f4-adjuntado.pdf', 'Adjuntado', 'active'],
      ['f5-rechazado.pdf', 'Rechazado como pago', 'warning'], ['f6-descartado.pdf', 'Descartado', 'neutral'],
    ];
    for (const [archivo, rotulo, tono] of esperado) {
      const chip = tabla.getByRole('row', { name: new RegExp(archivo.replace('.', '\\.')) }).getByText(rotulo, { exact: true });
      await expect(chip, archivo).toHaveCount(1);
      expect(await tonoDe(chip), `${archivo} → ${rotulo}`).toBe(tono);
    }
    // Segundo renglón: «automático»/«manual» se fueron al chip; el manual conserva «por quién».
    const filaAuto = tabla.getByRole('row', { name: /f2-auto\.pdf/ });
    await expect(filaAuto).toContainText('16 sep 2026');
    await expect(filaAuto).not.toContainText('automático · ');
    await expect(tabla.getByRole('row', { name: /f3-manual\.pdf/ })).toContainText('por Luis Gómez · 16 sep 2026');
    await expect(tabla.getByRole('row', { name: /f5-rechazado\.pdf/ })).toContainText('Ese SOAT ya está pagado');
    await expect(tabla.getByText(/^(Pendiente|Aplicado)$/)).toHaveCount(0);
    const html = await tabla.evaluate((el) => el.outerHTML);
    for (const uuid of [UUID_A, UUID_B, UUID_C, UUID_D, UUID_E, UUID_F, UUID_T, LOTE_1]) expect(html).not.toContain(uuid);
    // Las cuatro pills siguen existiendo.
    for (const p of ['Pendientes', 'Aplicados', 'Descartados', 'Todos']) await expect(page.getByRole('button', { name: new RegExp(`^${p}`) })).toHaveCount(1);
  });

  /** Mutantes (notas QA 1-4): copiar `?asociacion=` a un `useState`; mandar el valor desconocido al API; conservar una asociación de otra pill; limpiar sin tocar la URL. */
  test('TC-02/TC-03 selector → API y URL; pill implicada; reload conserva; pill ajena lo vacía; Limpiar lo quita; ?asociacion=zzz se ignora', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    const gets = await mockCola(page, SEIS_FILAS);
    await page.goto(RUTA);
    const selector = selectorAsociacion(page);
    await expect(selector).toHaveValue('');
    await expect(selector.locator('option')).toHaveText([
      'Todos los estados de asociación', 'Pendiente de asociar', 'Rechazado como pago', 'Aplicado automático', 'Aplicado manual', 'Adjuntado', 'Descartado',
    ]);
    expect(gets[0]).not.toContain('asociacion=');

    await selector.selectOption('aplicado_automatico');
    await expect.poll(() => gets.at(-1)).toContain('asociacion=aplicado_automatico');
    expect(gets.at(-1)).toContain('estado=aplicado');
    expect(gets.at(-1)).toContain('page=1');
    await expect(page).toHaveURL(/\?asociacion=aplicado_automatico$/);
    await expect(page.getByRole('button', { name: 'Aplicados' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('combobox', { name: 'Motivo' })).toHaveCount(0);

    const antes = gets.length;
    await page.reload();
    await expect(selectorAsociacion(page)).toHaveValue('aplicado_automatico');
    await expect.poll(() => gets.length).toBeGreaterThan(antes);
    expect(gets[antes]).toContain('asociacion=aplicado_automatico');
    expect(gets[antes]).toContain('estado=aplicado');
    await expect(page.getByRole('button', { name: 'Aplicados' })).toHaveAttribute('aria-pressed', 'true');

    // TC-03: pill Aplicados + «Adjuntado» → viajan los dos, coherentes.
    await selectorAsociacion(page).selectOption('adjuntado');
    await expect.poll(() => gets.at(-1)).toContain('estado=aplicado&asociacion=adjuntado');
    // Una pill que deja fuera la opción la vacía (nota QA 3).
    await page.getByRole('button', { name: /^Pendientes/ }).click();
    await expect(selectorAsociacion(page)).toHaveValue('');
    await expect(page).toHaveURL(/\/flito\/comprobantes$/);
    await expect.poll(() => gets.at(-1)).toContain('estado=pendiente');
    expect(gets.at(-1)).not.toContain('asociacion=');
    // En Pendientes, «Rechazado como pago» se queda en Pendientes y Motivo sigue.
    await selectorAsociacion(page).selectOption('rechazado_pago');
    await expect.poll(() => gets.at(-1)).toContain('estado=pendiente&asociacion=rechazado_pago');
    await expect(page).toHaveURL(/\?asociacion=rechazado_pago$/);
    await expect(page.getByRole('combobox', { name: 'Motivo' })).toBeVisible();
    // Todos conserva la opción (la pill Todos no la contradice).
    await page.getByRole('button', { name: 'Todos', exact: true }).click();
    await expect(selectorAsociacion(page)).toHaveValue('rechazado_pago');
    await expect.poll(() => gets.at(-1)).toContain('asociacion=rechazado_pago');
    expect(gets.at(-1)).not.toContain('estado=');
    // Limpiar filtros: URL sin asociacion, selector vacío, pill Pendientes (nota QA 4).
    await page.getByRole('button', { name: 'Limpiar filtros' }).click();
    await expect(page).toHaveURL(/\/flito\/comprobantes$/);
    await expect(selectorAsociacion(page)).toHaveValue('');
    await expect(page.getByRole('button', { name: /^Pendientes/ })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => gets.at(-1)).not.toContain('asociacion=');

    // Borde: valor desconocido → se ignora, no viaja al API y la URL no se reescribe al entrar (nota QA 2).
    const n = gets.length;
    await page.goto(`${RUTA}?asociacion=zzz`);
    await expect.poll(() => gets.length).toBeGreaterThan(n);
    expect(gets[n]).not.toContain('asociacion=');
    expect(gets[n]).toContain('estado=pendiente');
    await expect(selectorAsociacion(page)).toHaveValue('');
    await expect(page).toHaveURL(/\?asociacion=zzz$/);
    await page.getByRole('combobox', { name: 'Concepto' }).selectOption('soat');
    await expect(page).toHaveURL(/\/flito\/comprobantes$/);
  });

  /** Mutante (nota QA 6): duplicar «Limpiar filtros» dentro del vacío. */
  test('vacío con el selector puesto: dos líneas con el siguiente paso y UN solo «Limpiar filtros»', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockCola(page, LISTA_VACIA);
    await page.goto(`${RUTA}?asociacion=descartado`);
    await expect(page.getByRole('button', { name: 'Descartados' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Ningún comprobante coincide con los filtros.')).toBeVisible();
    await expect(page.getByText('Cambia el estado de asociación, el concepto o el motivo, o pulsa Limpiar filtros.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Limpiar filtros' })).toHaveCount(1);
  });
});

test.describe('HU #12635 · AC2 — «Aplicados» en el resultado de la carga', () => {
  const APLICADO_ITEM = { archivo: 'f1.pdf', comprobanteId: UUID_A, paginas: null, tipoDocumento: 'poliza_soat', concepto: 'soat', idFlit: 'FLIT-ARHZZ1', placa: 'ABC123', motivo: null, detalle: 'SOAT · FLIT-ARHZZ1 · $ 1.234.567' };

  /** Mutantes: recomponer el detalle en el front; chip Aplicados al final o sin contador. */
  test('TC-04 chip «Aplicados 1» primero, fila «Aplicado» primera con el detalle del servidor tal cual', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockCola(page, LISTA_VACIA);
    const lotes: string[] = [];
    await page.route(/\/api\/flito\/comprobantes$/, (route) => {
      lotes.push(loteIdDe(route.request().postData()));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...RESULTADO_OK, aplicados: [APLICADO_ITEM], pendientes: [RESULTADO_OK.pendientes[1]], documentos: 2 }) });
    });
    const modal = await abrirCarga(page);
    await modal.getByLabel('Comprobantes de la carga').setInputFiles(archivos(2));
    await modal.getByRole('button', { name: 'Subir y procesar' }).click();
    await expect(modal.getByRole('button', { name: 'Listo' })).toBeVisible();
    await expect(modal.getByRole('status')).toHaveText('2 documentos leídos en 2 archivos');
    const chips = modal.getByText(/^(Aplicados|Pendientes|Duplicados|Fallidos) \d+$/);
    await expect(chips).toHaveText(['Aplicados 1', 'Pendientes 1', 'Duplicados 0', 'Fallidos 0']);
    expect(await tonoDe(chips.first())).toBe('success');
    const filas = modal.getByRole('row');
    await expect(filas.nth(1)).toContainText('f1.pdf');
    await expect(filas.nth(1).getByText('Aplicado', { exact: true })).toHaveCount(1);
    await expect(filas.nth(1).getByRole('cell').nth(2)).toHaveText('SOAT · FLIT-ARHZZ1 · $ 1.234.567');
    await expect(filas.nth(2)).toContainText('Pendiente');
    expect(new Set(lotes).size).toBe(1);
  });

  /** Mutante M-AC2: pintar el chip con `[]` (quitar la guarda `aplicados.length > 0`). */
  test('TC-05 con aplicados: [] no hay chip «Aplicados»', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockCola(page, LISTA_VACIA);
    await page.route(/\/api\/flito\/comprobantes$/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RESULTADO_OK) }));
    const modal = await abrirCarga(page);
    await modal.getByLabel('Comprobantes de la carga').setInputFiles(archivos(2));
    await modal.getByRole('button', { name: 'Subir y procesar' }).click();
    await expect(modal.getByRole('button', { name: 'Listo' })).toBeVisible();
    await expect(modal.getByText(/Aplicados/)).toHaveCount(0);
    await expect(modal.getByText(/^(Pendientes|Duplicados|Fallidos) \d+$/)).toHaveText(['Pendientes 2', 'Duplicados 0', 'Fallidos 0']);
    await expect(modal.getByText('Aplicado', { exact: true })).toHaveCount(0);
  });

  test('TC-06 dos tandas: los aplicados se acumulan y el orden de los chips es estable', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockCola(page, LISTA_VACIA);
    let n = 0;
    await page.route(/\/api\/flito\/comprobantes$/, (route) => {
      n += 1;
      const cuerpo = n === 1
        ? { aplicados: [APLICADO_ITEM], pendientes: Array.from({ length: 4 }, (_, i) => ({ ...RESULTADO_OK.pendientes[0], archivo: `f${i + 2}.pdf` })), duplicados: [], fallidos: [], documentos: 5 }
        : { aplicados: [], pendientes: [], duplicados: [{ ...RESULTADO_OK.pendientes[0], archivo: 'f6.pdf', motivo: null, detalle: 'Ya cargado el 15 sep 2026' }], fallidos: [], documentos: 1 };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(cuerpo) });
    });
    const modal = await abrirCarga(page);
    await modal.getByLabel('Comprobantes de la carga').setInputFiles(archivos(6));
    await modal.getByRole('button', { name: 'Subir y procesar' }).click();
    await expect(modal.getByRole('button', { name: 'Listo' })).toBeVisible();
    expect(n).toBe(2);
    await expect(modal.getByRole('status')).toHaveText('6 documentos leídos en 6 archivos');
    await expect(modal.getByText(/^(Aplicados|Pendientes|Duplicados|Fallidos) \d+$/)).toHaveText(['Aplicados 1', 'Pendientes 4', 'Duplicados 1', 'Fallidos 0']);
  });
});

test.describe('HU #12635 · AC3 — desde el comprobante se llega al trámite', () => {
  /** Mutantes: `?buscar=`/`?placa=` con el idFlit; enlace en la misma pestaña; enlace sin la página `flito_tramites`. */
  test('TC-07 «Ver trámite FLIT-…» en la fila (pendiente y aplicada) y en el detalle → /flito/tramites?placa=ABC123 en otra pestaña', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockCola(page, { items: [fila({ ...FIJADO, tramite: TRAMITE_ABC }), fila({ id: UUID_B, archivo: { nombre: 'f2-auto.pdf', contentType: 'application/pdf' }, ...APLICADO_AUTO })], total: 2, page: 1, pageSize: 50 });
    await mockDetalle(page, detalleFijado({ tramite: TRAMITE_ABC }));
    await mockArchivoPdf(page);
    await page.goto(RUTA);
    const tabla = page.getByRole('region', { name: 'Cola de comprobantes' });
    await expect(enlaceTramite(tabla)).toHaveCount(2);
    for (const archivo of [/recibo\.pdf/, /f2-auto\.pdf/]) {
      const enlace = enlaceTramite(tabla.getByRole('row', { name: archivo }));
      await expect(enlace).toHaveAttribute('aria-label', 'Ver trámite FLIT-ARHZZ1');
      await expect(enlace).toHaveText('Ver trámite ↗');
      await expect(enlace).toHaveAttribute('href', '/flito/tramites?placa=ABC123');
      await expect(enlace).toHaveAttribute('target', '_blank');
      await expect(enlace).toHaveAttribute('rel', 'noopener');
    }
    const dialog = await abrirPanel(page);
    const enDetalle = enlaceTramite(dialog);
    await expect(enDetalle).toHaveText('Ver trámite FLIT-ARHZZ1 ↗');
    await expect(enDetalle).toHaveAttribute('href', '/flito/tramites?placa=ABC123');
    await expect(enDetalle).toHaveAttribute('target', '_blank');
    // Ningún uuid del trámite en href, aria-label ni data-* del SPA.
    expect(await dialog.evaluate((el) => el.outerHTML)).not.toContain(UUID_T);
  });

  /** Mutante M-AC3: pintar «Ver trámite» con placa null (href `?placa=`); pintar sin la página. */
  test('TC-08 sin placa, sin trámite o sin la página flito_tramites no hay enlace; sin trámite tampoco «Ver soportes»', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockCola(page, { items: [fila({ ...FIJADO, tramite: { ...TRAMITE_ABC, placa: null } }), fila({ id: UUID_B, tramite: null, archivo: { nombre: 'sin.pdf', contentType: 'application/pdf' } })], total: 2, page: 1, pageSize: 50 });
    await mockDetalle(page, detalleFijado({ tramite: { ...TRAMITE_ABC, placa: null } }));
    await mockArchivoPdf(page);
    await page.goto(RUTA);
    const tabla = page.getByRole('region', { name: 'Cola de comprobantes' });
    await expect(tabla).toContainText('FLIT-ARHZZ1');
    await expect(tabla.locator('a[href*="/flito/tramites"]')).toHaveCount(0);
    let dialog = await abrirPanel(page);
    await expect(dialog.locator('a[href*="/flito/tramites"]')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Ver soportes' })).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    await page.unroute(new RegExp(`/api/flito/comprobantes/${UUID_A}$`));
    await page.route(new RegExp(`/api/flito/comprobantes/${UUID_B}$`), (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detalle({ id: UUID_B, tramite: null, archivo: { nombre: 'sin.pdf', contentType: 'application/pdf' } })) }));
    dialog = await abrirPanel(page, 'Asociar sin.pdf');
    await expect(dialog.locator('a[href*="/flito/tramites"]')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Ver soportes' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Con placa pero sin la página: financiera no tiene `flito_tramites` por defecto.
    await loginAs(page, FINANCIERA_USER);
    await page.unroute(/\/api\/flito\/comprobantes(\?|$)/);
    await mockCola(page, { items: [fila({ ...FIJADO, tramite: TRAMITE_ABC })], total: 1, page: 1, pageSize: 50 });
    await page.goto(RUTA);
    await expect(page.getByRole('region', { name: 'Cola de comprobantes' })).toContainText('ABC123');
    await expect(page.locator('a[href*="/flito/tramites"]')).toHaveCount(0);
  });

  /** Mutantes (notas QA 9-10): botón apagado en vez de ausente; pedir soportes por idFlit; clave `comprobante` sin rótulo. */
  test('TC-09 «Ver soportes» con la función → GET /flito/tramites/{id}/soportes, visor encima con «Comprobante» y «SOAT», Esc cierra solo el de arriba; sin la función no existe', async ({ page }) => {
    await loginAs(page, CON_VER_SOPORTES);
    await mockCola(page, { items: [fila({ ...APLICADO_AUTO, archivo: { nombre: 'f2-auto.pdf', contentType: 'application/pdf' } })], total: 1, page: 1, pageSize: 50 });
    await mockDetalle(page, { ...detalleFijado({ ...APLICADO_AUTO, archivo: { nombre: 'f2-auto.pdf', contentType: 'application/pdf' } }), candidatos: [] });
    await mockArchivoPdf(page);
    const pedidos: string[] = [];
    await page.route(/\/api\/flito\/tramites\/[^/]+\/soportes$/, (route) => {
      pedidos.push(new URL(route.request().url()).pathname);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SOPORTES) });
    });
    await page.route(/\/api\/files\?key=/, (route) => route.fulfill({ status: 200, contentType: 'application/pdf', path: PDF_DOS_PAGINAS }));
    await page.goto(RUTA);
    await page.getByRole('button', { name: 'Ver f2-auto.pdf' }).click();
    const detalleDialog = page.getByRole('dialog', { name: /^Comprobante · f2-auto\.pdf/ });
    await expect(detalleDialog).toBeVisible();
    // Sin la página flito_tramites (financiera) no hay «Ver trámite», pero sí «Ver soportes» (guardas distintas).
    await expect(detalleDialog.locator('a[href*="/flito/tramites"]')).toHaveCount(0);
    const boton = detalleDialog.getByRole('button', { name: 'Ver soportes' });
    await expect(boton).toBeEnabled();
    await boton.click();
    const visor = page.getByRole('dialog', { name: 'Documentos de FLIT-ARHZZ1' });
    await expect(visor).toBeVisible();
    await expect(page.locator('[data-flit-modal]')).toHaveCount(2);
    // Por el uuid del trámite en la ruta del API (nunca por idFlit). StrictMode en dev dispara el efecto dos veces: se cuenta ≥ 1.
    await expect.poll(() => pedidos.length).toBeGreaterThanOrEqual(1);
    expect(new Set(pedidos)).toEqual(new Set([`/api/flito/tramites/${UUID_T}/soportes`]));
    await expect(visor.getByRole('button').filter({ hasText: 'Comprobante' }).filter({ hasText: 'f2-auto.pdf' })).toBeVisible();
    await expect(visor.getByRole('button').filter({ hasText: 'SOAT' }).filter({ hasText: 'soat.pdf' })).toBeVisible();
    await expect(visor.getByText('comprobante', { exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(visor).toHaveCount(0);
    await expect(detalleDialog).toBeVisible();
    await expect(boton).toBeFocused();

    // Rama negativa: financiera por defecto (la 0179 no le siembra la función) → cero botones y cero GET.
    await page.keyboard.press('Escape');
    await loginAs(page, FINANCIERA_USER);
    await page.goto(RUTA);
    await page.getByRole('button', { name: 'Ver f2-auto.pdf' }).click();
    await expect(page.getByRole('dialog', { name: /^Comprobante · f2-auto\.pdf/ }).getByRole('region', { name: 'Lectura' })).toContainText('Aplicado automático');
    await expect(page.getByRole('button', { name: 'Ver soportes' })).toHaveCount(0);
    expect(new Set(pedidos)).toEqual(new Set([`/api/flito/tramites/${UUID_T}/soportes`]));
  });
});

test.describe('HU #12635 · AC4 — contarPaginasPdf con timeout', () => {
  /** Mutante M-AC4: quitar el `Promise.race` → este test no termina y cae por timeout. */
  test('TC-11 worker de pdf.js colgado: a los 10 s el PDF cuenta 1, se registra el fallo y el envío sale', async ({ page }) => {
    test.setTimeout(45_000);
    await loginAs(page, FINANCIERA_USER);
    await mockCola(page, LISTA_VACIA);
    // El script del worker nunca llega: `getDocument().promise` no resuelve jamás. En dev, Vite sirve
    // ADEMÁS el módulo `…pdf.worker.min.mjs?url` que exporta la cadena (lo pide `lib/pdfWorker.ts` al cargar la página): ese sigue.
    await page.route(/pdf\.worker/, (route) => (/\?(url|import)\b/.test(route.request().url()) ? route.continue() : new Promise<void>(() => {})));


    const avisos: string[] = [];
    page.on('console', (m) => { if (m.type() === 'warning') avisos.push(m.text()); });
    const porEnvio: number[] = [];
    await page.route(/\/api\/flito\/comprobantes$/, (route) => {
      porEnvio.push(contarArchivos(route.request().postData()));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RESULTADO_OK) });
    });
    const modal = await abrirCarga(page);
    await modal.getByLabel('Comprobantes de la carga').setInputFiles([CONSOLIDADO_REAL, { name: 'f1.pdf', ...PDF_MIN }]);
    await expect(modal.getByRole('status')).toContainText('2 archivos');
    const inicio = Date.now();
    await modal.getByRole('button', { name: 'Subir y procesar' }).click();
    await expect(modal.getByRole('button', { name: 'Listo' })).toBeVisible({ timeout: 30_000 });
    // Sin conteo, el consolidado real (2 páginas) NO viaja solo: los dos van en la misma tanda de sueltos.
    expect(porEnvio).toEqual([2]);
    expect(Date.now() - inicio).toBeGreaterThanOrEqual(10_000);
    expect(avisos.some((a) => a.includes('[comprobantes] pdf.js no abrió un PDF en 10 s'))).toBe(true);
    expect(avisos.join('\n')).not.toContain('soporte-dos-paginas');
  });
});

test.describe('HU #12635 · AC5 — ficha de ayuda y accesibilidad', () => {
  test('TC-13 la ficha describe los seis estados, el filtro, «Aplicados» y el salto al trámite; no dice «no asocia ni aplica»; renderiza', async ({ page }) => {
    const ficha = readFileSync(fileURLToPath(new URL('../../src/content/ayuda/flito_comprobantes.md', import.meta.url)), 'utf8');
    for (const rotulo of ['Pendiente de asociar', 'Rechazado como pago', 'Aplicado automático', 'Aplicado manual', 'Adjuntado', 'Descartado',
      'Estado de asociación', 'Aplicados', 'Ver trámite', 'Ver soportes']) {
      expect(ficha, rotulo).toContain(rotulo);
    }
    expect(ficha.toLowerCase()).not.toContain('no asocia ni aplica');
    expect(ficha).not.toMatch(/\/api\/|https?:\/\//);
    await loginAs(page, FINANCIERA_USER);
    await page.goto('/flito/ayuda/flito_comprobantes');
    const articulo = page.getByRole('article', { name: 'Comprobantes' });
    await expect(articulo).toBeVisible();
    await expect(articulo.getByText(/Estado de asociación/).first()).toBeVisible();
    await expect(articulo.getByText(/Ver trámite/).first()).toBeVisible();
    await expect(articulo.getByText(/Rechazado como pago/).first()).toBeVisible();
  });

  test('TC-14 a11y (axe) en la cola con el selector enfocado y puesto, y en el resultado con el chip «Aplicados»; un único status vivo', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockCola(page, SEIS_FILAS);
    await page.route(/\/api\/flito\/comprobantes$/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...RESULTADO_OK, aplicados: [{ ...RESULTADO_OK.pendientes[0], motivo: null, detalle: 'Impuesto · FLIT-ARHZZ1 · $ 312.000' }] }) }));
    await page.goto(`${RUTA}?asociacion=aplicado_manual`);
    await expect(page.getByRole('button', { name: 'Aplicados' })).toHaveAttribute('aria-pressed', 'true');
    await selectorAsociacion(page).focus();
    await expect(page.locator('p[role="status"]')).toHaveCount(1);
    esperarSinViolacionesGraves(await correrAxe(page), 'cola con el selector de asociación');
    const modal = await abrirCarga(page);
    await modal.getByLabel('Comprobantes de la carga').setInputFiles(archivos(2));
    await modal.getByRole('button', { name: 'Subir y procesar' }).click();
    await expect(modal.getByText('Aplicados 1')).toBeVisible();
    await expect(modal.getByRole('status')).toHaveCount(1);
    esperarSinViolacionesGraves(await correrAxe(page), 'resultado de carga con Aplicados');
  });
});

// ═══════════════ Bug #12913 — el pago de servicios adicionales elige su tipo de servicio ═══════════════

const TIPO_SA = (id: string, nombre: string, valor: number, activo = true) => ({
  id, nombre, descripcion: null, valor, activo,
  creadoEn: '2026-09-01T10:00:00.000Z', creadoPorId: null, actualizadoEn: '2026-09-01T10:00:00.000Z', actualizadoPorId: null,
});
const TIPO_GRUA = TIPO_SA('aaaa1111-0000-4000-8000-000000000001', 'Grúa', 85000);
const TIPO_DIAG = TIPO_SA('aaaa1111-0000-4000-8000-000000000002', 'Diagnóstico', 120000);
const CAMPOS_SA = CAMPOS_BASE.map((c) => (c.campo === 'concepto' ? campo('concepto', 'servicios_adicionales', 'alta') : c));

async function mockCatalogoSa(page: Page, tipos: unknown[] = [TIPO_GRUA, TIPO_DIAG]) {
  const gets: string[] = [];
  await page.route(/\/api\/flito\/parametrizacion\/servicios-adicionales/, (route) => {
    gets.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tipos) });
  });
  // El trámite ya lleva «Diagnóstico»: se marca, no se excluye.
  await page.route(/\/api\/finanzas\/tramites\/[^/]+\/servicios-adicionales/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ items: [{ id: 's1', tipoId: TIPO_DIAG.id, nombre: 'Diagnóstico', descripcion: null, valor: 100000, asignadoPorId: 7, asignadoPorNombre: 'Ana', asignadoEn: '2026-09-10T10:00:00.000Z', origen: 'manual' }], total: 100000, liquidado: false }),
  }));
  return gets;
}

test.describe('Bug #12913 · Tipo de servicio al aplicar un pago de servicios adicionales', () => {
  /** Mutantes: campo visible con otro concepto o en documentación; Aplicar encendido sin tipo; body sin `servicioTipoId` o con él de más. */
  test('solo en SA + pago; Aplicar espera al tipo con la razón visible; el body lleva servicioTipoId y el toast dice servicio, trámite y valor', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockCola(page, { items: [fila({ ...FIJADO, concepto: 'servicios_adicionales' })], total: 1, page: 1, pageSize: 50 });
    await mockDetalle(page, detalleFijado({ concepto: 'servicios_adicionales' }, CAMPOS_SA));
    await mockArchivoPdf(page);
    await mockCatalogoSa(page);
    const aplicar = await mockPost(page, RUTA_APLICAR, aplicado200);
    const dialog = await abrirPanel(page);

    const tipo = dialog.getByRole('combobox', { name: 'Tipo de servicio' });
    await expect(tipo).toBeVisible();
    await expect(tipo).toHaveAttribute('aria-required', 'true');
    await expect(tipo).toHaveAccessibleDescription(/El servicio queda asignado al trámite con el valor de este comprobante/);
    const botonAplicar = dialog.getByRole('button', { name: 'Aplicar' });
    await expect(botonAplicar).toBeDisabled();
    await expect(dialog.getByText('Elige el tipo de servicio para aplicar.', { exact: true })).toBeVisible();

    // Otro concepto → el campo desaparece; documentación → también.
    await dialog.getByRole('combobox', { name: 'Concepto' }).selectOption('impuesto');
    await expect(dialog.getByRole('combobox', { name: 'Tipo de servicio' })).toHaveCount(0);
    await expect(botonAplicar).toBeEnabled();
    await dialog.getByRole('combobox', { name: 'Concepto' }).selectOption('servicios_adicionales');
    await dialog.getByRole('radio', { name: 'Documentación del trámite' }).check();
    await expect(dialog.getByRole('combobox', { name: 'Tipo de servicio' })).toHaveCount(0);
    await dialog.getByRole('radio', { name: 'Comprobante de pago' }).check();

    await tipo.click();
    const lista = dialog.getByRole('listbox', { name: 'Tipos de servicio adicional' });
    await expect(lista.getByRole('option')).toHaveCount(2);
    await expect(lista.getByRole('option', { name: /Diagnóstico/ })).toContainText('Ya asignado · se actualizará el valor');
    await expect(lista.getByRole('option', { name: /Grúa/ })).not.toContainText('Ya asignado');
    // Esc cierra SOLO la lista, no el modal.
    await tipo.press('Escape');
    await expect(lista).toHaveCount(0);
    await expect(dialog).toBeVisible();

    await tipo.click();
    await dialog.getByRole('option', { name: /Grúa/ }).click();
    await expect(tipo).toHaveValue('Grúa');
    await expect(botonAplicar).toBeEnabled();
    await botonAplicar.click();
    await expect.poll(() => aplicar.bodies.length).toBe(1);
    expect(aplicar.bodies[0]).toMatchObject({ tramiteId: TRAMITE_1, concepto: 'servicios_adicionales', esPago: true, servicioTipoId: TIPO_GRUA.id });
    await expect(toast(page)).toHaveText('Pago aplicado. «Grúa» quedó asignado a FLIT-10250 por $ 312.000.');
  });

  /** Mutantes: cambiar concepto sin limpiar el tipo; no repedir el catálogo tras el 400; copy crudo del 400/409. */
  test('cambiar concepto limpia el tipo; tipo de baja repide el catálogo y limpia; liquidado con copy pulido', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockCola(page, { items: [fila({ ...FIJADO, concepto: 'servicios_adicionales' })], total: 1, page: 1, pageSize: 50 });
    await mockDetalle(page, detalleFijado({ concepto: 'servicios_adicionales' }, CAMPOS_SA));
    await mockArchivoPdf(page);
    const catalogo = await mockCatalogoSa(page);
    const aplicar = await mockPost(page, RUTA_APLICAR, (_b, n) => (n === 1
      ? { status: 400, body: { error: 'El servicio elegido ya no está disponible', codigo: 'datos_invalidos' } }
      : { status: 409, body: { error: 'Trámite liquidado', codigo: 'tramite_liquidado' } }));
    const dialog = await abrirPanel(page);
    const tipo = dialog.getByRole('combobox', { name: 'Tipo de servicio' });
    await tipo.click();
    await dialog.getByRole('option', { name: /Grúa/ }).click();
    await expect(tipo).toHaveValue('Grúa');

    await dialog.getByRole('combobox', { name: 'Concepto' }).selectOption('logistica');
    await dialog.getByRole('combobox', { name: 'Concepto' }).selectOption('servicios_adicionales');
    await expect(dialog.getByRole('combobox', { name: 'Tipo de servicio' })).toHaveValue('');
    await expect(dialog.getByRole('button', { name: 'Aplicar' })).toBeDisabled();

    await tipo.click();
    await dialog.getByRole('option', { name: /Grúa/ }).click();
    const antes = catalogo.length;
    await dialog.getByRole('button', { name: 'Aplicar' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Ese tipo de servicio ya no está activo. Elige otro.');
    await expect.poll(() => catalogo.length).toBeGreaterThan(antes);
    await expect(tipo).toHaveValue('');

    await tipo.click();
    await dialog.getByRole('option', { name: /Grúa/ }).click();
    await dialog.getByRole('button', { name: 'Aplicar' }).click();
    await expect(dialog.getByRole('alert')).toContainText('El trámite ya está liquidado: no se le pueden asignar servicios. Reversa la liquidación y vuelve a aplicar.');
    expect(aplicar.bodies.every((b) => b.servicioTipoId === TIPO_GRUA.id)).toBe(true);
  });
});
