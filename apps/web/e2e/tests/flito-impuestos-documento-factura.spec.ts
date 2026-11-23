import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { funcionesDe, loginAs, OPERACIONES_USER } from '../helpers/auth';

// FLITO — Impuestos · HU #14664 (Feature #14662): número, fecha y avalúo de la factura en el detalle.
// Sección propia entre «Validación factura ↔ RUNT» y «Dirección del comprador», con «Corregir» y
// «Reintentar lectura» — nunca se niega con el impuesto certificado (a diferencia de «Reintentar
// validación»). Backend mockeado, mismo patrón que `flito-impuestos-direccion.spec.ts`.

const BASE = {
  tramiteId: 't', vin: 'VIN0000000000000', marca: 'Renault', linea: 'Duster', tipoTramite: 'Traspaso',
  fechaAprobacion: null, fechaCreacion: '2026-09-01T12:00:00Z',
  compradorNombre: 'Ana Pérez', compradorDocumento: '10101010', compradorTipoDocumento: 'CC',
  companiaNombre: 'Concesionario Norte', organismoCodigo: 'STT-MZL', organismoNombre: 'STT Manizales',
  valorLiquidado: 120000, valorPagado: null, marcadoPorDiferencia: false, tieneFacturaVenta: true,
  enviadoPorNombre: 'Operaciones E2E', enviadoEn: '2026-09-02T12:00:00Z', pagadoEn: null, estancado: false,
  motivoRechazo: null, creadoEn: '2026-09-01T12:00:00Z', gestionOperaciones: false,
  liquidadoEn: null, documentos: null, semaforo: 'verde', motivoSemaforo: null, analisisEstado: 'completado',
};

type Fila = Record<string, unknown> & { id: string };
const fila = (id: string, placa: string, extra: Partial<Fila> = {}): Fila => ({
  ...BASE, id, idFlit: `FLIT-${id}`, placa, estado: 'solicitado', certificacion: null, ...extra,
});

const CERT = { id: 'cert1', certificadoEn: '2026-09-02T12:10:00Z', certificadoPorNombre: 'Sistema', automatica: true };

const FILAS: Fila[] = [
  fila('f1', 'FAC001'),
  fila('f2', 'FAC002'),
  fila('f3', 'FAC003', { certificacion: CERT }),
];

const campo = (valor: string, confianza: number, confiable: boolean) => ({ valor, confianza, confiable });

const DOCUMENTO_FACTURA: Record<string, unknown> = {
  // Lleno, con una mezcla confiable/no confiable (AC1, nota 2 de QA).
  f1: {
    numeroFactura: campo('FE-2024-00912', 1, true),
    fechaFactura: campo('2024-05-03', 1, true),
    avaluoComercial: campo('85000000', 0.62, false),
    ultimoCambio: null,
  },
  // Vacío: nunca se leyó (certificado anterior a la HU, o análisis aún no corrido).
  f2: { numeroFactura: null, fechaFactura: null, avaluoComercial: null, ultimoCambio: null },
  // Certificado (AC3): la sección funciona igual, sin negarse por `YA_CERTIFICADO`.
  f3: {
    numeroFactura: campo('FE-2024-01000', 1, true),
    fechaFactura: campo('2024-06-01', 1, true),
    avaluoComercial: campo('90000000', 1, true),
    ultimoCambio: null,
  },
};

const comparacion = { version: 1, motivo: null, campos: [], resumen: { coinciden: 0, difieren: 0, noVerificables: 0 }, calculadoEn: '2026-09-02T12:05:00Z' };

interface Peticion { cuerpo: Record<string, unknown>; url: string }
const traza = { patches: [] as Peticion[], reintentos: [] as Peticion[], reintentarRespuesta: null as { status: number; body: unknown } | null };

async function mock(page: Page) {
  traza.patches = [];
  traza.reintentos = [];
  traza.reintentarRespuesta = null;
  await page.route(/\/api\/flito\/impuestos\/facetas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ companias: [], organismos: [] }) }));
  await page.route(/\/api\/flito\/impuestos\?/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ items: FILAS, total: FILAS.length, page: 1, pageSize: 50 }),
  }));
  await page.route(/\/api\/flito\/impuestos\/[a-z0-9]+\/documento-factura$/, (route) => {
    const req = route.request();
    const cuerpo = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>;
    traza.patches.push({ cuerpo, url: req.url() });
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        numeroFactura: cuerpo.numeroFactura ? campo(cuerpo.numeroFactura as string, 1, true) : null,
        fechaFactura: cuerpo.fechaFactura ? campo(cuerpo.fechaFactura as string, 1, true) : null,
        avaluoComercial: cuerpo.avaluoComercial ? campo(cuerpo.avaluoComercial as string, 1, true) : null,
        ultimoCambio: { tipo: 'correccion', usuarioId: 'u1', usuarioNombre: 'Operaciones E2E', en: '2026-11-23T10:00:00Z', motivo: cuerpo.motivo },
      }),
    });
  });
  await page.route(/\/api\/flito\/impuestos\/[a-z0-9]+\/documento-factura\/reintentar$/, (route) => {
    const req = route.request();
    const cuerpo = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>;
    traza.reintentos.push({ cuerpo, url: req.url() });
    if (traza.reintentarRespuesta) {
      return route.fulfill({
        status: traza.reintentarRespuesta.status, contentType: 'application/json',
        body: JSON.stringify(traza.reintentarRespuesta.body),
      });
    }
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        numeroFactura: campo('FE-2024-01000', 1, true), fechaFactura: campo('2024-06-01', 1, true),
        avaluoComercial: campo('90000000', 1, true),
        ultimoCambio: { tipo: 'reintento', usuarioId: 'u1', usuarioNombre: 'Operaciones E2E', en: '2026-11-23T10:05:00Z', motivo: cuerpo.motivo },
      }),
    });
  });
  await page.route(/\/api\/flito\/impuestos\/[a-z0-9]+$/, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const id = new URL(route.request().url()).pathname.split('/').pop()!;
    const f = FILAS.find((x) => x.id === id);
    if (!f) return route.fallback();
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        ...f, comparacion, direccionComprador: null, soportes: [], datosDocumentoFactura: DOCUMENTO_FACTURA[id],
      }),
    });
  });
}

const filaDe = (page: Page, placa: string) => page.getByRole('row').filter({ hasText: placa });

async function abrirDetalle(page: Page, placa: string) {
  await filaDe(page, placa).getByRole('button', { name: 'Ver', exact: true }).click();
  const detalle = page.getByRole('dialog', { name: `Impuesto · ${placa}` });
  await expect(detalle).toBeVisible();
  return detalle;
}

const seccionDe = (detalle: ReturnType<Page['getByRole']>) =>
  detalle.getByRole('region', { name: 'Número, fecha y avalúo de la factura' });

test.describe('FLITO — Impuestos · número, fecha y avalúo de la factura (HU #14664)', () => {
  test('AC1 · lleno: los 3 datos con su chip de confiabilidad y el copy de alcance', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/impuestos');
    const detalle = await abrirDetalle(page, 'FAC001');
    const seccion = seccionDe(detalle);

    await expect(seccion).toContainText('Estos datos no afectan el semáforo ni la certificación.');
    await expect(seccion).toContainText('FE-2024-00912');
    await expect(seccion).toContainText('2024-05-03');
    await expect(seccion).toContainText('85000000');
    await expect(seccion.getByText('100% · confiable')).toHaveCount(2);
    await expect(seccion.getByText('62% · no confiable')).toBeVisible();
    await expect(seccion.getByRole('button', { name: 'Corregir' })).toBeVisible();
    await expect(seccion.getByRole('button', { name: 'Reintentar lectura' })).toBeVisible();
    // Nunca el vocabulario de semáforo RUNT en esta sección.
    await expect(seccion.getByText(/Validación|Verde|Naranja/)).toHaveCount(0);
  });

  test('AC1 · vacío: sin filas de valor, «Reintentar lectura» es el único CTA', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/impuestos');
    const detalle = await abrirDetalle(page, 'FAC002');
    const seccion = seccionDe(detalle);

    await expect(seccion).toContainText('Esta factura no se ha leído para el número, la fecha y el avalúo.');
    await expect(seccion.getByRole('button', { name: 'Reintentar lectura' })).toBeVisible();
    await expect(seccion.getByRole('button', { name: 'Corregir' })).toHaveCount(0);
  });

  test('AC2 · corregir: motivo corto se rechaza; con motivo y valores, se guarda y queda visible', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/impuestos');
    const detalle = await abrirDetalle(page, 'FAC001');
    const seccion = seccionDe(detalle);

    await seccion.getByRole('button', { name: 'Corregir' }).click();
    const form = detalle.getByTestId('form-corregir-documento-factura');
    await expect(form).toBeVisible();

    // Motivo corto (< 5 caracteres): el botón de guardar queda deshabilitado, sin petición.
    await form.getByLabel('Motivo de la corrección (mín. 5 caracteres)').fill('ok');
    await expect(form.getByRole('button', { name: 'Guardar corrección' })).toBeDisabled();
    expect(traza.patches).toHaveLength(0);

    await form.getByLabel('Número de factura', { exact: true }).fill('FE-2024-01000');
    await form.getByLabel('Motivo de la corrección (mín. 5 caracteres)').fill('El número venía mal transcrito');
    await form.getByRole('button', { name: 'Guardar corrección' }).click();

    await expect(page.getByText('Corrección guardada.')).toBeVisible();
    await expect(form).toHaveCount(0);
    expect(traza.patches).toHaveLength(1);
    expect(traza.patches[0].cuerpo).toEqual({
      numeroFactura: 'FE-2024-01000', fechaFactura: '2024-05-03', avaluoComercial: '85000000',
      motivo: 'El número venía mal transcrito',
    });
    expect(new URL(traza.patches[0].url).pathname).toBe('/api/flito/impuestos/f1/documento-factura');
    await expect(seccion).toContainText('FE-2024-01000');
    await expect(seccion).toContainText('Último cambio: corregido por Operaciones E2E');
    await expect(seccion).toContainText('El número venía mal transcrito');
  });

  test('AC3 · reintentar lectura funciona con el impuesto certificado', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/impuestos');
    const detalle = await abrirDetalle(page, 'FAC003');
    const seccion = seccionDe(detalle);

    await seccion.getByRole('button', { name: 'Reintentar lectura' }).click();
    const form = detalle.getByTestId('form-reintentar-documento-factura');
    await expect(form).toBeVisible();
    await expect(form.getByRole('button', { name: 'Reintentar lectura' })).toBeDisabled();

    await form.getByLabel('Motivo del reintento (mín. 5 caracteres)').fill('Confirmar el avalúo con la factura');
    await form.getByRole('button', { name: 'Reintentar lectura' }).click();

    await expect(page.getByText('Lectura actualizada.')).toBeVisible();
    expect(traza.reintentos).toHaveLength(1);
    expect(new URL(traza.reintentos[0].url).pathname).toBe('/api/flito/impuestos/f3/documento-factura/reintentar');
    await expect(seccion).toContainText('Último cambio: reintentado por Operaciones E2E');
  });

  test('AC3 · 409 FACTURA_NO_DISPONIBLE: se muestra el texto del API, nunca otro', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    traza.reintentarRespuesta = {
      status: 409,
      body: { code: 'FACTURA_NO_DISPONIBLE', error: 'No se pudo descargar la factura para releerla.' },
    };
    await page.goto('/flito/impuestos');
    const detalle = await abrirDetalle(page, 'FAC003');
    const seccion = seccionDe(detalle);

    await seccion.getByRole('button', { name: 'Reintentar lectura' }).click();
    const form = detalle.getByTestId('form-reintentar-documento-factura');
    await form.getByLabel('Motivo del reintento (mín. 5 caracteres)').fill('Reintentar la lectura ahora');
    await form.getByRole('button', { name: 'Reintentar lectura' }).click();

    const alerta = form.getByTestId('factura-reintentar-error');
    await expect(alerta).toHaveAttribute('role', 'alert');
    await expect(alerta).toHaveText('No se pudo descargar la factura para releerla.');
    await expect(page.getByText('Lectura actualizada.')).toHaveCount(0);
  });

  test('AC6 · sin el permiso de certificar: se ven los datos, sin «Corregir» ni «Reintentar lectura»', async ({ page }) => {
    const sinCertificar = { ...OPERACIONES_USER, funciones: funcionesDe(OPERACIONES_USER).filter((f) => f !== 'impuestos.tramite.certificar') };
    await loginAs(page, sinCertificar);
    await mock(page);
    await page.goto('/flito/impuestos');
    const detalle = await abrirDetalle(page, 'FAC001');
    const seccion = seccionDe(detalle);

    await expect(seccion).toContainText('FE-2024-00912');
    await expect(seccion.getByRole('button', { name: 'Corregir' })).toHaveCount(0);
    await expect(seccion.getByRole('button', { name: 'Reintentar lectura' })).toHaveCount(0);
  });
});
