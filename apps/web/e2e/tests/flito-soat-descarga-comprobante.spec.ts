// FLITO — descarga INDIVIDUAL del comprobante de un SOAT (HU #12816, Feature #12814).
//
// Pareja de `flito-soportes-zip.spec.ts` (la masiva). Aquí se protege:
//  · que el botón exista SOLO con `soat.soportes.descargar` (ausente, no apagado);
//  · que en no pagado esté apagado pero ENFOCABLE, con el motivo legible;
//  · que el archivo guardado se llame `<placa>.pdf` aunque el servidor lo sirva `inline` sin nombre;
//  · que el doble clic haga UNA descarga, y que el error sea un toast cerrable con copy por caso.
//
// Los datos son SINTÉTICOS.
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, CLIENTE_USER, FUNCIONES_POR_ROL, OPERACIONES_USER, PROVEEDOR_USER } from '../helpers/auth';

const fila = (id: string, placa: string | null, estado: string) => ({
  id, vin: `VIN000000000000${id.slice(-1)}`, placa, marca: 'Chevrolet', linea: 'Onix',
  cilindraje: '1598', carroceria: 'SEDAN', tipoServicio: 'Particular',
  estado, esMultiplePropietario: false, companiaNombre: 'Concesionario Norte',
  organismoNombre: 'STT Manizales', proveedorSoatId: null, proveedorSoatNombre: null,
  compradores: [], tramitesFlit: [], tipoTramite: 'Matricula',
  fechaAprobacion: null, fechaCreacion: '2026-03-28T10:00:00Z',
  enviadoPorNombre: null, enviadoEn: null, pagadoEn: null, valorPagado: null,
  estancado: false, motivoRechazo: null, gestionOperaciones: false,
  creadoEn: '2026-03-28T10:00:00Z',
});

const SOAT = [
  fila('s1', 'ABC123', 'pendiente'),
  fila('s2', 'XYZ789', 'pagado'),
  fila('s3', null, 'pagado'),
];

const PDF = '%PDF-1.4 FLITO-E2E';

const json = (route: Route, body: unknown, status = 200) => route.fulfill({
  status, contentType: 'application/json', body: JSON.stringify(body),
});

async function montar(page: Page) {
  await page.route(/\/api\/flito\/soat\/facetas/, (r) => json(r, { companias: [], organismos: [], proveedores: [] }));
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat/, (r) =>
    json(r, [{ id: 'p1', nombre: 'Seguros Alfa', activo: true }]));
  await page.route(/\/api\/flito\/soat\?/, (r) => json(r, { items: SOAT, total: SOAT.length, page: 1, pageSize: 50 }));
}

/**
 * Soportes + archivo. El archivo se sirve como lo sirve `/api/files`: `inline` y SIN nombre, así que
 * el nombre del guardado solo puede venir del cliente. `fallo` hace fallar la lista de soportes.
 */
async function mockDescarga(page: Page, opciones: { fallo?: number; retardoMs?: number } = {}) {
  const peticiones = { soportes: 0, archivo: 0 };
  await page.route(/\/api\/flito\/soat\/s\d\/soportes$/, async (route) => {
    peticiones.soportes += 1;
    if (opciones.retardoMs) await new Promise((r) => setTimeout(r, opciones.retardoMs));
    if (opciones.fallo) return json(route, { error: 'detalle interno que NO debe verse' }, opciones.fallo);
    return json(route, [{
      id: 'd1', origen: 'soat', tipo: 'factura_soat', nombreArchivo: 'factura-aseguradora.pdf',
      url: '/api/files?k=soat%2Fd1.pdf&sig=e2e', subidoEn: '2026-03-29T10:00:00Z',
    }]);
  });
  await page.route(/\/api\/files\?/, (route) => {
    peticiones.archivo += 1;
    return route.fulfill({
      status: 200, contentType: 'application/pdf', body: PDF, headers: { 'content-disposition': 'inline' },
    });
  });
  return peticiones;
}

const botonFila = (page: Page, rotulo: string) => page.getByRole('button', { name: `Descargar comprobante ${rotulo}` });
const MOTIVO = 'Disponible cuando el SOAT esté pagado.';

async function abrirDetalle(page: Page, placa: string) {
  await page.getByRole('row').filter({ hasText: placa }).getByRole('button', { name: 'Ver', exact: true }).click();
  return page.getByRole('dialog');
}

test.describe('HU #12816 — AC1/AC3: botón por fila', () => {
  test('pagado: activo y con la placa en el nombre accesible; no pagado: apagado pero enfocable', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await montar(page);
    const pet = await mockDescarga(page);
    await page.goto('/flito/soat');

    const activo = botonFila(page, 'XYZ789');
    await expect(activo).toBeVisible();
    await expect(activo).not.toHaveAttribute('aria-disabled', 'true');

    const gris = botonFila(page, 'ABC123');
    await expect(gris).toHaveAttribute('aria-disabled', 'true');
    await expect(gris).not.toHaveAttribute('disabled'); // enfocable: `aria-disabled`, no `disabled`
    await expect(gris).toHaveAttribute('title', MOTIVO);
    await expect(gris).toHaveAccessibleDescription(MOTIVO);
    await gris.focus();
    await expect(gris).toBeFocused();
    await gris.click({ force: true }); // Playwright lee `aria-disabled` como no habilitado
    await page.waitForTimeout(300);
    expect(pet.soportes).toBe(0);
  });
});

test.describe('HU #12816 — AC5: el archivo se guarda con la placa', () => {
  test('fila pagada → `XYZ789.pdf` con el contenido servido', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await montar(page);
    await mockDescarga(page);
    await page.goto('/flito/soat');
    const [descarga] = await Promise.all([page.waitForEvent('download'), botonFila(page, 'XYZ789').click()]);
    expect(descarga.suggestedFilename()).toBe('XYZ789.pdf');
    const ruta = await descarga.path();
    const fs = await import('node:fs');
    expect(fs.readFileSync(ruta!, 'utf8')).toBe(PDF);
    // Sin toast de éxito: la descarga del navegador es el resultado.
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('placa nula → `SIN-PLACA.pdf`', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await montar(page);
    await mockDescarga(page);
    await page.goto('/flito/soat');
    const [descarga] = await Promise.all([page.waitForEvent('download'), botonFila(page, 'VIN0000000000003').click()]);
    expect(descarga.suggestedFilename()).toBe('SIN-PLACA.pdf');
  });
});

test.describe('HU #12816 — AC6: el candado', () => {
  test('dos clics síncronos = UNA lista y UN archivo', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await montar(page);
    const pet = await mockDescarga(page, { retardoMs: 400 });
    await page.goto('/flito/soat');
    const boton = botonFila(page, 'XYZ789');
    await expect(boton).toBeVisible();
    const descarga = page.waitForEvent('download');
    await boton.evaluate((b: HTMLButtonElement) => { b.click(); b.click(); });
    await expect(boton).toHaveAttribute('aria-busy', 'true');
    await descarga;
    await expect(boton).not.toHaveAttribute('aria-busy', 'true');
    expect(pet).toEqual({ soportes: 1, archivo: 1 });
  });
});

test.describe('HU #12816 — AC7: el error es un toast cerrable con copy por caso', () => {
  const casos = [
    { status: 500, texto: 'No se pudo descargar el comprobante de XYZ789. Intente de nuevo.', reintentar: true },
    { status: 429, texto: 'Se hicieron demasiadas descargas seguidas. Espere un momento e intente de nuevo.', reintentar: true },
    { status: 404, texto: 'El comprobante de XYZ789 no está disponible. Si el SOAT figura como pagado, avise a FLITO.', reintentar: false },
    { status: 403, texto: 'Su usuario no tiene permiso para descargar comprobantes.', reintentar: false },
  ];
  for (const c of casos) {
    test(`${c.status}: «${c.texto.slice(0, 32)}…»${c.reintentar ? ' + Reintentar' : ''}`, async ({ page }) => {
      await loginAs(page, PROVEEDOR_USER);
      await montar(page);
      const pet = await mockDescarga(page, { fallo: c.status });
      await page.goto('/flito/soat');
      await botonFila(page, 'XYZ789').click();
      const toast = page.getByRole('alert').filter({ hasText: c.texto });
      await expect(toast).toBeVisible();
      await expect(page.getByText('detalle interno que NO debe verse')).toHaveCount(0);
      await expect(toast.getByRole('button', { name: 'Reintentar' })).toHaveCount(c.reintentar ? 1 : 0);
      if (c.reintentar) {
        await toast.getByRole('button', { name: 'Reintentar' }).click();
        await expect.poll(() => pet.soportes).toBe(2);
        // Un toast por clic: el reintento reemplaza al anterior, no apila otro.
        await expect(page.getByRole('alert').filter({ hasText: c.texto })).toHaveCount(1);
      }
      await page.getByRole('button', { name: 'Cerrar aviso' }).click();
      await expect(page.getByRole('alert').filter({ hasText: c.texto })).toHaveCount(0);
      // El botón vuelve a estar operable.
      await expect(botonFila(page, 'XYZ789')).not.toHaveAttribute('aria-busy', 'true');
    });
  }
});

test.describe('HU #12816 — AC2: botón en el detalle', () => {
  test('pagado: «Descargar comprobante» al final de las acciones, fuera del visor', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montar(page);
    await mockDescarga(page);
    await page.goto('/flito/soat');
    const dialogo = await abrirDetalle(page, 'XYZ789');
    const boton = dialogo.getByRole('button', { name: 'Descargar comprobante' });
    await expect(boton).toBeVisible();
    // Última acción de su fila: después de las operativas.
    const ultimo = await boton.evaluate((b) => {
      const fila = b.closest('.flex-wrap');
      const botones = fila ? [...fila.querySelectorAll('button, label')] : [];
      return botones[botones.length - 1] === b;
    });
    expect(ultimo).toBe(true);
    await expect(dialogo.getByRole('button', { name: 'Ver soporte' })).toBeVisible();
    const [descarga] = await Promise.all([page.waitForEvent('download'), boton.click()]);
    expect(descarga.suggestedFilename()).toBe('XYZ789.pdf');
  });

  test('no pagado: apagado, con la línea visible del motivo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montar(page);
    const pet = await mockDescarga(page);
    await page.goto('/flito/soat');
    const dialogo = await abrirDetalle(page, 'ABC123');
    const boton = dialogo.getByRole('button', { name: 'Descargar comprobante' });
    await expect(boton).toHaveAttribute('aria-disabled', 'true');
    await expect(boton).toHaveAccessibleDescription(MOTIVO);
    await expect(dialogo.getByText(MOTIVO)).toBeVisible();
    await boton.click({ force: true });
    await page.waitForTimeout(300);
    expect(pet.soportes).toBe(0);
  });

  test('Cliente con la función: el detalle pagado ofrece solo la descarga', async ({ page }) => {
    await loginAs(page, { ...CLIENTE_USER, funciones: [...FUNCIONES_POR_ROL.cliente, 'soat.soportes.descargar'] });
    await montar(page);
    await mockDescarga(page);
    await page.goto('/flito/soat');
    const dialogo = await abrirDetalle(page, 'XYZ789');
    await expect(dialogo.getByRole('button', { name: 'Descargar comprobante' })).toBeVisible();
  });
});

test.describe('HU #12816 — AC4: sin `soat.soportes.descargar`, ausente (no apagado)', () => {
  test('ni en la fila ni en el detalle; «Ver soporte» sigue', async ({ page }) => {
    const funciones = FUNCIONES_POR_ROL.admin.filter((f) => f !== 'soat.soportes.descargar');
    await loginAs(page, { ...OPERACIONES_USER, funciones });
    await montar(page);
    await page.goto('/flito/soat');
    await expect(page.getByText('XYZ789').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Descargar comprobante/ })).toHaveCount(0);
    const dialogo = await abrirDetalle(page, 'XYZ789');
    await expect(dialogo.getByRole('button', { name: /Descargar comprobante/ })).toHaveCount(0);
    await expect(dialogo.getByRole('button', { name: 'Ver soporte' })).toBeVisible();
  });
});

test.describe('HU #12815 ↔ #12816: el motivo de «1 marcada» ya remite a algo que existe', () => {
  test('1 marcada pagada: el motivo nombra el botón de la fila, y ese botón está en la fila', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await montar(page);
    await page.goto('/flito/soat');
    await page.getByRole('checkbox', { name: 'Seleccionar XYZ789' }).check();
    await expect(page.getByText('Para un solo SOAT, use el botón de descarga de su fila.')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'XYZ789' })
      .getByRole('button', { name: 'Descargar comprobante XYZ789' })).toBeVisible();
  });
});
