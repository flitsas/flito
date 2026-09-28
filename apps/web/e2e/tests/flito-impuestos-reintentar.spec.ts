import { test, expect } from '../helpers/fixtures';
import { funcionesDe, loginAs, OPERACIONES_USER } from '../helpers/auth';

// FLITO — Impuestos · HU #12832: «Reintentar validación» (modal del semáforo rojo y sección del
// detalle, nunca la fila) y chip «Certificado» de la certificación automática. Backend mockeado,
// mismo patrón que `flito-impuestos-comparativa.spec.ts`.

const BASE = {
  tramiteId: 't', vin: 'VIN0000000000000', marca: 'Renault', linea: 'Duster', tipoTramite: 'Traspaso',
  fechaAprobacion: null, fechaCreacion: '2026-09-01T12:00:00Z',
  compradorNombre: 'Ana Pérez', compradorDocumento: '10101010', compradorTipoDocumento: 'CC',
  companiaNombre: 'Concesionario Norte', organismoCodigo: 'STT-MZL', organismoNombre: 'STT Manizales',
  valorLiquidado: 120000, valorPagado: null, marcadoPorDiferencia: false, tieneFacturaVenta: true,
  enviadoPorNombre: 'Operaciones E2E', enviadoEn: '2026-09-02T12:00:00Z', pagadoEn: null, estancado: false,
  motivoRechazo: null, creadoEn: '2026-09-01T12:00:00Z', gestionOperaciones: false,
  certificacion: null, liquidadoEn: null, documentos: null,
};

type Fila = Record<string, unknown> & { id: string };
const fila = (id: string, placa: string, extra: Partial<Fila>): Fila => ({
  ...BASE, id, idFlit: `FLIT-${id}`, placa, estado: 'solicitado',
  analisisEstado: 'completado', semaforo: null, motivoSemaforo: null, ...extra,
});

const CERT_AUTO = {
  id: 'c1', certificadoEn: '2026-09-02T12:10:00Z', certificadoPorNombre: 'Sistema', automatica: true,
};

const filasIniciales = (): Fila[] => [
  fila('a1', 'AUT001', { semaforo: 'verde', certificacion: CERT_AUTO }),
  fila('r1', 'ROJ001', { semaforo: 'rojo', motivoSemaforo: 'runt_sin_respuesta' }),
  fila('e1', 'ERR001', { analisisEstado: 'error_analisis', semaforo: null }),
  fila('c1', 'CER001', { semaforo: 'rojo', motivoSemaforo: 'runt_sin_respuesta', certificacion: { ...CERT_AUTO, automatica: false, certificadoPorNombre: 'Gestor' } }),
  fila('v1', 'VER001', { semaforo: 'verde' }),
];

const comparacion = (motivo: string | null) => ({
  version: 1, motivo, campos: [], resumen: { coinciden: 0, difieren: 0, noVerificables: 0 }, calculadoEn: '2026-09-02T12:05:00Z',
});

/** Estado del backend simulado: filas de la cola y cómo responde el próximo reintento. */
const estado = {
  filas: filasIniciales(),
  reanalizar: { status: 202, body: {} as unknown },
  /** Mientras sea `false`, el POST queda colgado (para ver el botón ocupado). */
  soltar: true,
  reintentos: 0,
  descargas: 0,
};

async function mock(page: import('@playwright/test').Page) {
  estado.filas = filasIniciales();
  estado.reanalizar = { status: 202, body: { id: 'x', analisisEstado: 'en_curso' } };
  estado.soltar = true;
  estado.reintentos = 0;
  estado.descargas = 0;
  await page.route(/\/api\/flito\/impuestos\/facetas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ companias: [], organismos: [] }) }));
  await page.route(/\/api\/flito\/impuestos\?/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ items: estado.filas, total: estado.filas.length, page: 1, pageSize: 50 }),
  }));
  await page.route(/\/api\/flito\/impuestos\/[a-z0-9]+\/certificado$/, (route) => {
    estado.descargas += 1;
    return route.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-1.4\n%%EOF' });
  });
  await page.route(/\/api\/flito\/impuestos\/[a-z0-9]+\/reanalizar$/, async (route) => {
    estado.reintentos += 1;
    while (!estado.soltar) await new Promise((r) => setTimeout(r, 50));
    await route.fulfill({
      status: estado.reanalizar.status, contentType: 'application/json', body: JSON.stringify(estado.reanalizar.body),
    });
  });
  await page.route(/\/api\/flito\/impuestos\/[a-z0-9]+$/, (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop()!;
    const f = estado.filas.find((x) => x.id === id);
    if (!f) return route.fallback();
    const motivo = f.analisisEstado === 'error_analisis' ? null : (f.motivoSemaforo as string | null);
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ...f, comparacion: comparacion(motivo), direccionComprador: null, soportes: [] }),
    });
  });
}

const filaDe = (page: import('@playwright/test').Page, placa: string) =>
  page.getByRole('row').filter({ hasText: placa });

const abrirModal = async (page: import('@playwright/test').Page, placa: string) => {
  await filaDe(page, placa).locator('[data-semaforo]').click();
  return page.getByRole('dialog', { name: `Validación factura ↔ RUNT · ${placa}` });
};

test.describe('FLITO — Impuestos · reintentar validación (HU #12832)', () => {
  test('AC1 · certificado automático: chip «Certificado» que descarga el PDF, sin «Certificar»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/impuestos');

    const f = filaDe(page, 'AUT001');
    await expect(f.getByRole('button', { name: 'Certificar' })).toHaveCount(0);
    const chip = f.getByRole('button', { name: 'Descargar certificado en PDF' });
    await expect(chip).toHaveText('Certificado');
    await expect(chip).toHaveAttribute('title', /Certificado automáticamente el .*Descargar el certificado en PDF\./);
    await expect(chip).not.toHaveAttribute('title', /por Sistema/);
    await chip.click();
    await expect.poll(() => estado.descargas).toBe(1);

    // La fila en rojo sin certificar conserva «Certificar» y NO trae «Reintentar» (vive en el modal).
    await expect(filaDe(page, 'ROJ001').getByRole('button', { name: 'Certificar' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reintentar validación' })).toHaveCount(0);
  });

  test('AC2 · rojo y error_analisis con permiso: «Reintentar validación» es la única primaria del modal y está en el detalle', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/impuestos');

    let modal = await abrirModal(page, 'ROJ001');
    const boton = modal.getByRole('button', { name: 'Reintentar validación' });
    await expect(boton).toBeVisible();
    await expect(boton).toBeEnabled();
    // Única primaria: el gradiente del kit solo lo lleva «Reintentar validación».
    await expect(boton).toHaveCSS('background-image', /gradient/);
    for (const otro of ['Ver detalle', 'Cerrar']) {
      await expect(modal.getByRole('button', { name: otro, exact: true }).last()).not.toHaveCSS('background-image', /gradient/);
    }
    await expect(modal.getByTestId('validacion-sin-validar')).toContainText('Reintenta la validación en unos minutos.');
    await page.keyboard.press('Escape');

    modal = await abrirModal(page, 'ERR001');
    await expect(modal.getByRole('button', { name: 'Reintentar validación' })).toBeVisible();
    await page.keyboard.press('Escape');

    // Con certificación vigente o en verde, no hay nada que reintentar.
    modal = await abrirModal(page, 'CER001');
    await expect(modal.getByTestId('validacion-sin-validar')).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Reintentar validación' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    modal = await abrirModal(page, 'VER001');
    await expect(modal.getByRole('button', { name: 'Reintentar validación' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await filaDe(page, 'ROJ001').getByRole('button', { name: 'Ver', exact: true }).click();
    const seccion = page.getByRole('region', { name: 'Validación factura ↔ RUNT' });
    await expect(seccion.getByRole('button', { name: 'Reintentar validación' })).toBeVisible();
    // En el detalle es secundaria.
    await expect(seccion.getByRole('button', { name: 'Reintentar validación' })).not.toHaveCSS('background-image', /gradient/);
  });

  test('AC2 · sin el permiso de certificar no aparece el botón y el copy manda a quien certifica', async ({ page }) => {
    const sinCertificar = { ...OPERACIONES_USER, funciones: funcionesDe(OPERACIONES_USER).filter((f) => f !== 'impuestos.tramite.certificar') };
    await loginAs(page, sinCertificar);
    await mock(page);
    await page.goto('/flito/impuestos');

    const modal = await abrirModal(page, 'ROJ001');
    await expect(modal.getByTestId('validacion-sin-validar'))
      .toContainText('Pide a quien certifica en tu equipo que reintente la validación.');
    await expect(modal.getByTestId('validacion-sin-validar')).not.toContainText('Reintenta la validación en unos minutos.');
    await expect(modal.getByRole('button', { name: 'Reintentar validación' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await filaDe(page, 'ERR001').getByRole('button', { name: 'Ver', exact: true }).click();
    const seccion = page.getByRole('region', { name: 'Validación factura ↔ RUNT' });
    await expect(seccion).toContainText('Pide a quien certifica');
    await expect(seccion.getByRole('button', { name: 'Reintentar validación' })).toHaveCount(0);
  });

  test('AC3 · 202: botón ocupado, fila a «Analizando», toast cerrable y al refrescar el semáforo nuevo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/impuestos');

    const modal = await abrirModal(page, 'ROJ001');
    estado.soltar = false;
    await modal.getByRole('button', { name: 'Reintentar validación' }).click();
    const ocupado = modal.getByRole('button', { name: 'Reintentando…' });
    await expect(ocupado).toBeDisabled();
    await expect(ocupado).toHaveAttribute('aria-busy', 'true');
    estado.soltar = true;

    await expect(modal).toHaveCount(0);
    expect(estado.reintentos).toBe(1);
    await expect(filaDe(page, 'ROJ001').getByTestId('validacion-analizando')).toBeVisible();
    const toast = page.getByRole('status').filter({ hasText: 'Validación en cola. El semáforo nuevo aparece al actualizar la cola.' });
    await expect(toast).toBeVisible();
    await toast.getByRole('button', { name: 'Cerrar aviso' }).click();
    await expect(toast).toHaveCount(0);

    // El job terminó: al refrescar la cola llegan el semáforo y la certificación nuevos.
    estado.filas = estado.filas.map((f) => f.id === 'r1'
      ? { ...f, analisisEstado: 'completado', semaforo: 'verde', motivoSemaforo: null, certificacion: CERT_AUTO }
      : f);
    await page.reload();
    const r1 = filaDe(page, 'ROJ001');
    await expect(r1.locator('[data-semaforo="verde"]')).toBeVisible();
    await expect(r1.getByRole('button', { name: 'Descargar certificado en PDF' })).toBeVisible();
    await expect(r1.getByRole('button', { name: 'Certificar' })).toHaveCount(0);
  });

  test('AC3 · 202 desde el detalle: la sección pasa a «en curso» y el botón se va', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/impuestos');

    await filaDe(page, 'ERR001').getByRole('button', { name: 'Ver', exact: true }).click();
    const seccion = page.getByRole('region', { name: 'Validación factura ↔ RUNT' });
    await seccion.getByRole('button', { name: 'Reintentar validación' }).click();
    await expect(seccion).toContainText('La validación está en curso.');
    await expect(seccion.getByRole('button', { name: 'Reintentar validación' })).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Validación en cola.' })).toBeVisible();
  });

  test('AC3 · 409 SIN_ANALISIS: copy claro dentro del modal, sin toast ni texto crudo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/impuestos');
    estado.reanalizar = {
      status: 409,
      body: { code: 'SIN_ANALISIS', error: 'Este impuesto se envió antes de la validación automática y no tiene análisis que reintentar.' },
    };

    const modal = await abrirModal(page, 'ROJ001');
    await modal.getByRole('button', { name: 'Reintentar validación' }).click();
    await expect(modal.getByRole('alert')).toHaveText('Este impuesto no tiene una validación que reintentar.');
    await expect(modal).not.toContainText('SIN_ANALISIS');
    await expect(modal).not.toContainText('Conflicto');
    await expect(modal.getByRole('button', { name: 'Reintentar validación' })).toBeEnabled();
    await expect(page.getByRole('status').filter({ hasText: 'Validación en cola' })).toHaveCount(0);
    await expect(filaDe(page, 'ROJ001').getByTestId('validacion-analizando')).toHaveCount(0);
  });

  test('AC3 · 409 ANALISIS_EN_CURSO: aviso en el modal, la fila pasa a «Analizando» y ya no se ofrece reintentar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/impuestos');
    estado.reanalizar = { status: 409, body: { code: 'ANALISIS_EN_CURSO', error: 'La validación de la factura ya está en curso.' } };

    const modal = await abrirModal(page, 'ROJ001');
    await modal.getByRole('button', { name: 'Reintentar validación' }).click();
    await expect(modal.getByRole('alert')).toHaveText('Esta validación ya está en curso. Actualiza la cola en unos minutos.');
    await expect(modal.getByRole('button', { name: 'Reintentar validación' })).toHaveCount(0);
    await expect(filaDe(page, 'ROJ001').getByTestId('validacion-analizando')).toBeVisible();
  });

  test('AC3 · fallo del servidor: mensaje genérico y el mismo botón reintenta', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/impuestos');
    estado.reanalizar = { status: 500, body: { error: 'ECONNRESET pg pool' } };

    const modal = await abrirModal(page, 'ROJ001');
    await modal.getByRole('button', { name: 'Reintentar validación' }).click();
    await expect(modal.getByRole('alert')).toHaveText('No se pudo reintentar la validación. Inténtalo de nuevo en unos minutos.');
    await expect(modal).not.toContainText('ECONNRESET');

    estado.reanalizar = { status: 202, body: { id: 'r1', analisisEstado: 'en_curso' } };
    await modal.getByRole('button', { name: 'Reintentar validación' }).click();
    await expect(modal).toHaveCount(0);
    expect(estado.reintentos).toBe(2);
    await expect(filaDe(page, 'ROJ001').getByTestId('validacion-analizando')).toBeVisible();
  });
});
