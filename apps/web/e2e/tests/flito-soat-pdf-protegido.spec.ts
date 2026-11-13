import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Request, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, funcionesDe, OPERACIONES_USER } from '../helpers/auth';

// BUG #14569 — PDF de SOAT protegido con contraseña. Backend mockeado:
//   · detalle: el 422 `PDF_CIFRADO` abre el campo de clave y el reenvío lleva `contrasena`;
//   · masiva: `protegidos` pinta una clave por archivo y el reintento manda `contrasenas` alineado;
//   · visor: un PDF cifrado de verdad (fixture, clave «clave-prueba») enseña el copy de protegido,
//     nunca el «No password given» de pdf.js.

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PDF_PROTEGIDO = fs.readFileSync(path.join(DIR, '..', 'fixtures', 'pdf-protegido.pdf'));
const PDF_PLANO = Buffer.from('%PDF-1.4 FLITO-E2E');

const USUARIO = {
  ...OPERACIONES_USER,
  funciones: [...funcionesDe(OPERACIONES_USER), 'soat.comprobante.cargar', 'soat.masiva.cargar', 'soat.soportes.descargar'],
};

const SOAT = [{
  id: 's2', vin: 'VIN0000000000002', placa: 'XYZ789', marca: 'Renault', linea: 'Kwid',
  cilindraje: '220', carroceria: 'SEDAN', tipoServicio: 'Particular',
  estado: 'solicitado', esMultiplePropietario: false, companiaNombre: 'Concesionario Sur',
  organismoNombre: 'STT Pereira', proveedorSoatId: 'p1', proveedorSoatNombre: 'Seguros Alfa',
  compradores: [], tramitesFlit: ['FLIT-1002'], tipoTramite: 'Traspaso',
  fechaAprobacion: '2026-04-03T12:00:00Z', fechaCreacion: '2026-04-01T10:00:00Z',
  enviadoPorNombre: 'Operaciones E2E', enviadoEn: '2026-04-02T12:00:00Z',
  pagadoEn: null, valorPagado: null, estancado: false, motivoRechazo: null, creadoEn: '2026-04-02T12:00:00Z',
  gestionOperaciones: false,
}];

const json = (route: Route, body: unknown, status = 200) => route.fulfill({
  status, contentType: 'application/json', body: JSON.stringify(body),
});

async function montar(page: Page) {
  await page.route(/\/api\/flito\/soat\/facetas/, (r) => json(r, { companias: [], organismos: [], proveedores: [] }));
  await page.route(/\/api\/flito\/parametrizacion\/proveedores\/selector\?servicio=soat/, (r) =>
    json(r, [{ id: 'p1', nombre: 'Seguros Alfa', activo: true }]));
  await page.route(/\/api\/flito\/soat\?/, (r) => json(r, { items: SOAT, total: SOAT.length, page: 1, pageSize: 50 }));
  await page.route(/\/api\/flito\/soat\/s2\/historial/, (r) => json(r, []));
}

/** Valor de un campo de texto del multipart (no de un archivo). `null` si no viaja. */
function campo(req: Request, nombre: string): string | null {
  const cuerpo = req.postDataBuffer()?.toString('latin1') ?? '';
  const m = cuerpo.match(new RegExp(`name="${nombre}"\\r\\n\\r\\n([^\\r]*)\\r\\n`));
  return m ? m[1] : null;
}

async function abrirDetalle(page: Page) {
  await page.getByRole('row').filter({ hasText: 'XYZ789' }).getByRole('button', { name: 'Ver', exact: true }).click();
  return page.getByRole('dialog');
}

test.describe('BUG #14569 — PDF de SOAT protegido con contraseña', () => {
  test('detalle: el PDF cifrado pide la clave, la reenvía en el cuerpo y avisa si no lo abre', async ({ page }) => {
    await loginAs(page, USUARIO);
    await montar(page);
    const contrasenas: (string | null)[] = [];
    await page.route(/\/api\/flito\/soat\/s2\/factura$/, (route) => {
      const clave = campo(route.request(), 'contrasena');
      contrasenas.push(clave);
      if (clave === null) return json(route, { error: 'Este PDF está protegido con contraseña. Escríbela para cargarlo.', codigo: 'PDF_CIFRADO' }, 422);
      if (clave !== 'clave-buena') return json(route, { error: 'La contraseña no abre este PDF.', codigo: 'PDF_CONTRASENA_INCORRECTA' }, 422);
      return json(route, { ok: true });
    });
    await page.goto('/flito/soat');
    const dialogo = await abrirDetalle(page);

    await dialogo.locator('input[type="file"]').setInputFiles({ name: 'factura.pdf', mimeType: 'application/pdf', buffer: PDF_PLANO });
    await expect(dialogo.getByText('Este PDF está protegido. Escribe la contraseña para cargarlo.')).toBeVisible();
    const clave = dialogo.getByLabel('Contraseña de factura.pdf');
    await expect(clave).toHaveAttribute('type', 'password');
    await expect(clave).toHaveAttribute('autocomplete', 'off');

    await clave.fill('clave-mala');
    await dialogo.getByRole('button', { name: 'Cargar con contraseña' }).click();
    await expect(dialogo.getByText('La contraseña no abre este PDF.')).toBeVisible();
    await expect(clave).toHaveValue('');

    await clave.fill('clave-buena');
    await dialogo.getByRole('button', { name: 'Cargar con contraseña' }).click();
    await expect(page.getByText('Comprobante de SOAT cargado para XYZ789.')).toBeVisible();
    expect(contrasenas).toEqual([null, 'clave-mala', 'clave-buena']);
    // La clave no viaja nunca en la URL ni queda en el almacenamiento local.
    expect(page.url()).not.toContain('clave');
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('clave-buena');
  });

  test('detalle: cancelar cierra el campo y vuelve la acción primaria', async ({ page }) => {
    await loginAs(page, USUARIO);
    await montar(page);
    await page.route(/\/api\/flito\/soat\/s2\/factura$/, (route) =>
      json(route, { error: 'Este PDF está protegido con contraseña. Escríbela para cargarlo.', codigo: 'PDF_CIFRADO' }, 422));
    await page.goto('/flito/soat');
    const dialogo = await abrirDetalle(page);
    await dialogo.locator('input[type="file"]').setInputFiles({ name: 'factura.pdf', mimeType: 'application/pdf', buffer: PDF_PLANO });
    await dialogo.getByLabel('Contraseña de factura.pdf').fill('algo');
    await dialogo.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await expect(dialogo.getByLabel('Contraseña de factura.pdf')).toHaveCount(0);
    await expect(dialogo.getByText('Cargar comprobante de SOAT')).toBeVisible();
  });

  test('masiva: una clave por protegido y el reintento manda solo esos, con `contrasenas` alineado', async ({ page }) => {
    await loginAs(page, USUARIO);
    await montar(page);
    const peticiones: { contrasenas: string | null; archivos: number }[] = [];
    await page.route(/\/api\/flito\/soat\/facturas$/, (route) => {
      const req = route.request();
      const cuerpo = req.postDataBuffer()?.toString('latin1') ?? '';
      const contrasenas = campo(req, 'contrasenas');
      peticiones.push({ contrasenas, archivos: (cuerpo.match(/name="archivos"/g) ?? []).length });
      const vacio = { pagados: [], enRevision: [], duplicados: [], noAsociados: [], protegidos: [] };
      if (contrasenas === null) {
        return json(route, {
          ...vacio,
          pagados: [{ archivo: 'a.pdf', detalle: 'Pagado.' }],
          protegidos: [
            { archivo: 'b.pdf', placa: null, soatId: null, detalle: 'Protegido con contraseña.' },
            { archivo: 'c.pdf', placa: null, soatId: null, detalle: 'Protegido con contraseña.' },
          ],
        });
      }
      const claves = JSON.parse(contrasenas) as string[];
      return json(route, {
        ...vacio,
        pagados: [{ archivo: 'b.pdf', detalle: 'Pagado.' }],
        protegidos: claves[1] === 'mala' ? [{ archivo: 'c.pdf', placa: null, soatId: null, detalle: 'La contraseña no abre este PDF.' }] : [],
      });
    });
    await page.goto('/flito/soat');
    await page.getByRole('button', { name: 'Cargar comprobantes de SOAT (masivo)' }).click();
    const dialogo = page.getByRole('dialog');
    await dialogo.getByLabel('Facturas o ZIP de la carga masiva').setInputFiles([
      { name: 'a.pdf', mimeType: 'application/pdf', buffer: PDF_PLANO },
      { name: 'b.pdf', mimeType: 'application/pdf', buffer: PDF_PLANO },
      { name: 'c.pdf', mimeType: 'application/pdf', buffer: PDF_PLANO },
    ]);
    await dialogo.getByRole('button', { name: 'Subir y procesar' }).click();

    await expect(dialogo.getByText('Protegidos con contraseña 2')).toBeVisible();
    await expect(dialogo.getByLabel('Contraseña de b.pdf')).toBeVisible();
    await expect(dialogo.getByLabel('Contraseña de c.pdf')).toBeVisible();
    await expect(dialogo.getByLabel('Contraseña de a.pdf')).toHaveCount(0);
    await expect(dialogo.getByRole('button', { name: 'Reintentar con contraseña' })).toBeDisabled();

    await dialogo.getByLabel('Contraseña de b.pdf').fill('buena');
    await dialogo.getByLabel('Contraseña de c.pdf').fill('mala');
    await dialogo.getByRole('button', { name: 'Reintentar con contraseña' }).click();

    await expect(dialogo.getByText('Protegidos con contraseña 1')).toBeVisible();
    await expect(dialogo.getByLabel('Contraseña de b.pdf')).toHaveCount(0);
    await expect(dialogo.getByLabel('Contraseña de c.pdf')).toHaveValue('');
    await expect(dialogo.getByText('La contraseña no abre este PDF.').first()).toBeVisible();
    await expect(dialogo.getByText('Pagados 2')).toBeVisible();

    expect(peticiones).toEqual([
      { contrasenas: null, archivos: 3 },
      { contrasenas: JSON.stringify(['buena', 'mala']), archivos: 2 },
    ]);
  });

  test('visor: el PDF cifrado dice que está protegido, no «No password given»', async ({ page }) => {
    await loginAs(page, USUARIO);
    await montar(page);
    await page.route(/\/api\/flito\/soat\/s2\/soportes$/, (route) => json(route, [{
      id: 'd1', origen: 'soat', tipo: 'factura_soat', nombreArchivo: 'factura-protegida.pdf',
      url: '/api/files?k=soat%2Fd1.pdf&sig=e2e', subidoEn: '2026-03-29T10:00:00Z',
    }]));
    await page.route(/\/api\/files\?/, (route) => route.fulfill({
      status: 200, contentType: 'application/pdf', body: PDF_PROTEGIDO, headers: { 'content-disposition': 'inline' },
    }));
    await page.goto('/flito/soat');
    const dialogo = await abrirDetalle(page);
    await dialogo.getByRole('button', { name: 'Ver soporte' }).click();

    await expect(page.getByText('Este documento está protegido con contraseña y no se puede previsualizar.')).toBeVisible();
    await expect(page.getByText(/No password given/i)).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Abrir en una pestaña nueva' })).toBeVisible();
  });
});
