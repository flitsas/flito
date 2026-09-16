import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';
import { correrAxe, esperarSinViolacionesGraves } from '../helpers/axe';

// FLITO — Impuestos · accesibilidad (axe) de lo que añade la HU #12592: el selector de fase en el
// modal de carga, la tabla con los chips de documentos y el filtro, y el modal del recibo de caja.
// Archivo aparte a propósito: sin QA_AXE_CDN=1 (o QA_AXE_PATH) `cargarAxe` lanza y estos rojos NO
// son regresión (memoria e2e-a11y-necesitan-axe-explicito); así no tiñen la suite del módulo.

const FILAS = [
  {
    id: 'i2', tramiteId: 't2', idFlit: 'FLIT-1002', placa: 'XYZ789', vin: 'VIN0000000000002',
    marca: null, linea: null, tipoTramite: null, fechaAprobacion: null, fechaCreacion: null,
    estado: 'solicitado', compradorNombre: 'Luis Gómez', compradorDocumento: '20202020', compradorTipoDocumento: 'PP',
    companiaNombre: 'Concesionario Sur', organismoCodigo: 'STT-PER', organismoNombre: 'STT Pereira',
    valorLiquidado: 200000, valorPagado: null, marcadoPorDiferencia: false, tieneFacturaVenta: true,
    enviadoPorNombre: 'Operaciones E2E', enviadoEn: '2026-04-02T12:00:00Z', pagadoEn: null, estancado: false,
    motivoRechazo: null, creadoEn: '2026-04-02T12:00:00Z', gestionOperaciones: false, certificacion: null,
    liquidadoEn: '2026-04-05T10:00:00Z', documentos: 'liquidacion',
  },
  {
    id: 'i3', tramiteId: 't3', idFlit: 'FLIT-1003', placa: 'OPS001', vin: 'VIN0000000000003',
    marca: null, linea: null, tipoTramite: null, fechaAprobacion: null, fechaCreacion: null,
    estado: 'solicitado', compradorNombre: 'Marta Ruiz', compradorDocumento: '30303030', compradorTipoDocumento: null,
    companiaNombre: 'Concesionario Sur', organismoCodigo: 'STT-PER', organismoNombre: 'STT Pereira',
    valorLiquidado: 150000, valorPagado: null, marcadoPorDiferencia: false, tieneFacturaVenta: true,
    enviadoPorNombre: 'Operaciones E2E', enviadoEn: '2026-04-03T12:00:00Z', pagadoEn: null, estancado: false,
    motivoRechazo: null, creadoEn: '2026-04-03T12:00:00Z', gestionOperaciones: true, certificacion: null,
    liquidadoEn: null, documentos: 'pago',
  },
];

test.describe('FLITO — Impuestos · fases y recibo de caja · accesibilidad (axe)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('TC-26 el modal de carga con selector, la tabla con chips y filtro, y el modal de recibo de caja no tienen violaciones serias', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await page.route(/\/api\/flito\/impuestos\/facetas/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ companias: [], organismos: [] }) }));
    await page.route(/\/api\/flito\/impuestos\?/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: FILAS, total: 2, page: 1, pageSize: 50 }) }));

    await page.goto('/flito/impuestos');
    await expect(page.getByRole('row').filter({ hasText: 'XYZ789' }).getByText('Liquidación', { exact: true })).toBeVisible();
    esperarSinViolacionesGraves(await correrAxe(page), 'impuestos · tabla con chips y filtro');

    await page.getByRole('button', { name: 'Cargar recibos (masivo)' }).click();
    await expect(page.getByRole('group', { name: 'Fase del recibo' })).toBeVisible();
    esperarSinViolacionesGraves(await correrAxe(page), 'impuestos · carga masiva con selector de fase');
    await page.keyboard.press('Escape');

    // Detalle con el botón deshabilitado y su motivo enlazado (OPS001) …
    await page.getByRole('row').filter({ hasText: 'OPS001' }).getByRole('button', { name: 'Ver' }).click();
    await expect(page.getByRole('dialog', { name: 'Impuesto · OPS001' }).getByRole('button', { name: 'Cargar recibo de caja' })).toBeDisabled();
    esperarSinViolacionesGraves(await correrAxe(page), 'impuestos · detalle con botón deshabilitado y motivo');
    await page.keyboard.press('Escape');

    // … y el modal del recibo de caja encima del detalle (XYZ789).
    await page.getByRole('row').filter({ hasText: 'XYZ789' }).getByRole('button', { name: 'Ver' }).click();
    await page.getByRole('dialog', { name: 'Impuesto · XYZ789' }).getByRole('button', { name: 'Cargar recibo de caja' }).click();
    await expect(page.getByRole('dialog', { name: 'Recibo de caja · XYZ789' })).toBeVisible();
    esperarSinViolacionesGraves(await correrAxe(page), 'impuestos · modal de recibo de caja');
  });
});
