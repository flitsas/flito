import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Request, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, funcionesDe, OPERACIONES_USER } from '../helpers/auth';

// BUG #14569 — PDF de SOAT protegido con contraseña. Backend mockeado:
//   · detalle: la primera subida no prueba el nombre; el 422 `PDF_CIFRADO` abre el aviso con la
//     casilla del nombre marcada y, al desmarcarla, el campo de clave que viaja en `contrasena`;
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
  /** Detalle con `/factura` mockeado: `responder(clave, flag)` decide; se guardan clave y flag de cada envío. */
  async function detalleConFactura(page: Page, responder: (clave: string | null, flag: string | null, route: Route) => Promise<void>) {
    await loginAs(page, USUARIO);
    await montar(page);
    const envios: { clave: string | null; flag: string | null }[] = [];
    await page.route(/\/api\/flito\/soat\/s2\/factura$/, (route) => {
      const clave = campo(route.request(), 'contrasena');
      const flag = campo(route.request(), 'usarNombreComoClave');
      envios.push({ clave, flag });
      return responder(clave, flag, route);
    });
    await page.goto('/flito/soat');
    const dialogo = await abrirDetalle(page);
    return { dialogo, envios };
  }
  const CIFRADO = { error: 'Este PDF está protegido con contraseña. Escríbela para cargarlo.', codigo: 'PDF_CIFRADO' };
  const INCORRECTA = { error: 'La contraseña no abre este PDF.', codigo: 'PDF_CONTRASENA_INCORRECTA' };

  test('detalle: antes de cargar no hay casilla del nombre y un PDF sin contraseña entra directo', async ({ page }) => {
    const { dialogo, envios } = await detalleConFactura(page, (_c, _f, route) => json(route, { ok: true }));
    await expect(dialogo.getByText('Cargar factura')).toBeVisible();
    await expect(dialogo.getByLabel('Usar el nombre del archivo como contraseña')).toHaveCount(0);
    await dialogo.locator('input[type="file"]').setInputFiles({ name: 'factura.pdf', mimeType: 'application/pdf', buffer: PDF_PLANO });
    await expect(page.getByText('Factura cargada para XYZ789.')).toBeVisible();
    expect(envios).toEqual([{ clave: null, flag: 'false' }]);
  });

  test('detalle: el PDF cifrado ofrece la casilla marcada sin campo y el reintento prueba el nombre', async ({ page }) => {
    const { dialogo, envios } = await detalleConFactura(page, (_c, flag, route) =>
      flag === 'true' ? json(route, { ok: true }) : json(route, CIFRADO, 422));
    await dialogo.locator('input[type="file"]').setInputFiles({ name: 'factura.pdf', mimeType: 'application/pdf', buffer: PDF_PLANO });
    await expect(dialogo.getByText('Este PDF está protegido con contraseña.')).toBeVisible();
    await expect(dialogo.getByLabel('Usar el nombre del archivo como contraseña')).toBeChecked();
    await expect(dialogo.getByLabel('Contraseña de factura.pdf')).toHaveCount(0);
    await dialogo.getByRole('button', { name: 'Cargar con contraseña' }).click();
    await expect(page.getByText('Factura cargada para XYZ789.')).toBeVisible();
    expect(envios).toEqual([{ clave: null, flag: 'false' }, { clave: null, flag: 'true' }]);
  });

  test('detalle: desmarcar la casilla muestra el campo, reenvía la clave y avisa si no lo abre', async ({ page }) => {
    const { dialogo, envios } = await detalleConFactura(page, (clave, _f, route) => {
      if (clave === null) return json(route, CIFRADO, 422);
      if (clave !== 'clave-buena') return json(route, INCORRECTA, 422);
      return json(route, { ok: true });
    });
    await dialogo.locator('input[type="file"]').setInputFiles({ name: 'factura.pdf', mimeType: 'application/pdf', buffer: PDF_PLANO });
    await dialogo.getByLabel('Usar el nombre del archivo como contraseña').uncheck();
    const clave = dialogo.getByLabel('Contraseña de factura.pdf');
    await expect(clave).toBeVisible();
    await expect(clave).toHaveAttribute('type', 'password');
    await expect(clave).toHaveAttribute('autocomplete', 'off');

    await clave.fill('clave-mala');
    await dialogo.getByRole('button', { name: 'Cargar con contraseña' }).click();
    await expect(dialogo.getByText('La contraseña no abre este PDF.')).toBeVisible();
    await expect(dialogo.getByLabel('Usar el nombre del archivo como contraseña')).not.toBeChecked();
    await expect(clave).toHaveValue('');

    await clave.fill('clave-buena');
    await dialogo.getByRole('button', { name: 'Cargar con contraseña' }).click();
    await expect(page.getByText('Factura cargada para XYZ789.')).toBeVisible();
    expect(envios).toEqual([
      { clave: null, flag: 'false' }, { clave: 'clave-mala', flag: 'false' }, { clave: 'clave-buena', flag: 'false' },
    ]);
    // La clave no viaja nunca en la URL ni queda en el almacenamiento local.
    expect(page.url()).not.toContain('clave');
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('clave-buena');
  });

  test('detalle: si el nombre no abre el PDF, la casilla vuelve desmarcada con la ayuda y el campo', async ({ page }) => {
    // El API contesta `PDF_CIFRADO` otra vez cuando ninguna variante del nombre abre el PDF.
    const { dialogo, envios } = await detalleConFactura(page, (clave, _f, route) =>
      clave === 'clave-buena' ? json(route, { ok: true }) : json(route, CIFRADO, 422));
    await dialogo.locator('input[type="file"]').setInputFiles({ name: 'factura.pdf', mimeType: 'application/pdf', buffer: PDF_PLANO });
    await dialogo.getByRole('button', { name: 'Cargar con contraseña' }).click();
    await expect(dialogo.getByText('El nombre del archivo no abre este PDF. Escribe la contraseña.')).toBeVisible();
    await expect(dialogo.getByLabel('Usar el nombre del archivo como contraseña')).not.toBeChecked();
    const clave = dialogo.getByLabel('Contraseña de factura.pdf');
    await expect(clave).toBeVisible();
    await clave.fill('clave-buena');
    await dialogo.getByRole('button', { name: 'Cargar con contraseña' }).click();
    await expect(page.getByText('Factura cargada para XYZ789.')).toBeVisible();
    expect(envios).toEqual([{ clave: null, flag: 'false' }, { clave: null, flag: 'true' }, { clave: 'clave-buena', flag: 'false' }]);
  });

  test('detalle: cancelar cierra el campo y vuelve la acción primaria', async ({ page }) => {
    await loginAs(page, USUARIO);
    await montar(page);
    await page.route(/\/api\/flito\/soat\/s2\/factura$/, (route) =>
      json(route, { error: 'Este PDF está protegido con contraseña. Escríbela para cargarlo.', codigo: 'PDF_CIFRADO' }, 422));
    await page.goto('/flito/soat');
    const dialogo = await abrirDetalle(page);
    await dialogo.locator('input[type="file"]').setInputFiles({ name: 'factura.pdf', mimeType: 'application/pdf', buffer: PDF_PLANO });
    await dialogo.getByLabel('Usar el nombre del archivo como contraseña').uncheck();
    await dialogo.getByLabel('Contraseña de factura.pdf').fill('algo');
    await dialogo.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await expect(dialogo.getByLabel('Usar el nombre del archivo como contraseña')).toHaveCount(0);
    await expect(dialogo.getByLabel('Contraseña de factura.pdf')).toHaveCount(0);
    await expect(dialogo.getByText('Cargar factura')).toBeVisible();
  });

  test('masiva: una clave por protegido y el reintento manda solo esos, con `contrasenas` alineado', async ({ page }) => {
    await loginAs(page, USUARIO);
    await montar(page);
    const peticiones: { contrasenas: string | null; nombres: string | null; archivos: number }[] = [];
    await page.route(/\/api\/flito\/soat\/facturas$/, (route) => {
      const req = route.request();
      const cuerpo = req.postDataBuffer()?.toString('latin1') ?? '';
      const contrasenas = campo(req, 'contrasenas');
      peticiones.push({ contrasenas, nombres: campo(req, 'nombresComoClave'), archivos: (cuerpo.match(/name="archivos"/g) ?? []).length });
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
    await page.getByRole('button', { name: 'Cargar facturas (masivo)' }).click();
    const dialogo = page.getByRole('dialog');
    await dialogo.getByLabel('Facturas o ZIP de la carga masiva').setInputFiles([
      { name: 'a.pdf', mimeType: 'application/pdf', buffer: PDF_PLANO },
      { name: 'b.pdf', mimeType: 'application/pdf', buffer: PDF_PLANO },
      { name: 'c.pdf', mimeType: 'application/pdf', buffer: PDF_PLANO },
    ]);
    await dialogo.getByRole('button', { name: 'Subir y procesar' }).click();

    await expect(dialogo.getByText('Protegidos con contraseña 2')).toBeVisible();
    // Sin el nombre: se desmarca «en todos» y aparecen los campos de clave.
    await dialogo.getByLabel('Usar el nombre como contraseña', { exact: true }).uncheck();
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
      { contrasenas: null, nombres: null, archivos: 3 },
      { contrasenas: JSON.stringify(['buena', 'mala']), nombres: null, archivos: 2 },
    ]);
  });

  const PROTEGIDO = (archivo: string, detalle = 'Protegido con contraseña.') => ({ archivo, placa: null, soatId: null, detalle });
  const VACIO = { pagados: [], enRevision: [], duplicados: [], noAsociados: [], protegidos: [] };

  /** Abre la masiva, sube `nombres` y deja la primera respuesta con todos protegidos. */
  async function masivaConProtegidos(page: Page, nombres: string[]) {
    await loginAs(page, USUARIO);
    await montar(page);
    const peticiones: { contrasenas: string | null; nombres: string | null; archivos: number }[] = [];
    let respuestaSegunda: (route: Route) => Promise<void> = (route) => json(route, VACIO);
    await page.route(/\/api\/flito\/soat\/facturas$/, async (route) => {
      const req = route.request();
      const cuerpo = req.postDataBuffer()?.toString('latin1') ?? '';
      peticiones.push({
        contrasenas: campo(req, 'contrasenas'), nombres: campo(req, 'nombresComoClave'),
        archivos: (cuerpo.match(/name="archivos"/g) ?? []).length,
      });
      if (peticiones.length === 1) return json(route, { ...VACIO, protegidos: nombres.map((n) => PROTEGIDO(n)) });
      return respuestaSegunda(route);
    });
    await page.goto('/flito/soat');
    await page.getByRole('button', { name: 'Cargar facturas (masivo)' }).click();
    const dialogo = page.getByRole('dialog');
    await dialogo.getByLabel('Facturas o ZIP de la carga masiva').setInputFiles(
      nombres.map((name) => ({ name, mimeType: 'application/pdf', buffer: PDF_PLANO })));
    await dialogo.getByRole('button', { name: 'Subir y procesar' }).click();
    await expect(dialogo.getByText(`Protegidos con contraseña ${nombres.length}`)).toBeVisible();
    return { dialogo, peticiones, responder: (fn: (route: Route) => Promise<void>) => { respuestaSegunda = fn; } };
  }

  test('masiva: casillas marcadas por defecto, «Usar el nombre como contraseña» marca y desmarca, y la tanda alinea nombres y claves', async ({ page }) => {
    const { dialogo, peticiones, responder } = await masivaConProtegidos(page, ['a.pdf', 'b.pdf', 'c.pdf']);
    responder((route) => json(route, {
      ...VACIO, pagados: [{ archivo: 'a.pdf', detalle: 'Pagado.' }, { archivo: 'c.pdf', detalle: 'Pagado.' }],
      protegidos: [PROTEGIDO('b.pdf')],
    }));
    const todos = dialogo.getByLabel('Usar el nombre como contraseña', { exact: true });
    for (const n of ['a.pdf', 'b.pdf', 'c.pdf']) await expect(dialogo.getByLabel(`Usar el nombre de ${n}`)).toBeChecked();
    await expect(todos).toBeChecked();
    // Marcada = sin campo de clave.
    await expect(dialogo.getByLabel('Contraseña de a.pdf')).toHaveCount(0);

    await todos.uncheck();
    for (const n of ['a.pdf', 'b.pdf', 'c.pdf']) await expect(dialogo.getByLabel(`Usar el nombre de ${n}`)).not.toBeChecked();
    await expect(dialogo.getByRole('button', { name: 'Reintentar con contraseña' })).toBeDisabled();
    await todos.check();
    for (const n of ['a.pdf', 'b.pdf', 'c.pdf']) await expect(dialogo.getByLabel(`Usar el nombre de ${n}`)).toBeChecked();

    await dialogo.getByLabel('Usar el nombre de c.pdf').uncheck();
    expect(await todos.evaluate((el) => (el as HTMLInputElement).indeterminate)).toBe(true);
    await dialogo.getByLabel('Contraseña de c.pdf').fill('x');
    await dialogo.getByRole('button', { name: 'Reintentar con contraseña' }).click();

    await expect(dialogo.getByText('Protegidos con contraseña 1')).toBeVisible();
    // b.pdf no abrió con su nombre: vuelve desmarcada, con el campo y la ayuda.
    await expect(dialogo.getByLabel('Usar el nombre de b.pdf')).not.toBeChecked();
    await expect(dialogo.getByLabel('Contraseña de b.pdf')).toBeVisible();
    await expect(dialogo.getByText('El nombre del archivo no abre este PDF. Escribe la contraseña.')).toBeVisible();
    await expect(dialogo.getByRole('button', { name: 'Reintentar con contraseña' })).toBeDisabled();

    expect(peticiones).toEqual([
      { contrasenas: null, nombres: null, archivos: 3 },
      { contrasenas: JSON.stringify(['', '', 'x']), nombres: JSON.stringify([true, true, false]), archivos: 3 },
    ]);
  });

  test('masiva: el reintento solo por nombre no manda `contrasenas` y el 429 se muestra en el aviso', async ({ page }) => {
    const { dialogo, peticiones, responder } = await masivaConProtegidos(page, ['a.pdf', 'b.pdf']);
    responder((route) => json(route, {
      error: 'Demasiados intentos de abrir PDFs protegidos con el nombre del archivo. Espera unos minutos e intenta de nuevo.',
    }, 429));
    await dialogo.getByRole('button', { name: 'Reintentar con contraseña' }).click();
    await expect(dialogo.getByRole('alert').filter({
      hasText: 'Demasiados intentos de abrir PDFs protegidos con el nombre del archivo. Espera unos minutos e intenta de nuevo.',
    })).toBeVisible();
    expect(peticiones[1]).toEqual({ contrasenas: null, nombres: JSON.stringify([true, true]), archivos: 2 });
  });

  test('masiva a 375 px: la sección de protegidos con filas mezcladas no desborda', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const largo = 'factura-soat-aseguradora-alfa-placa-XYZ789-2026-11-17.pdf';
    const { dialogo } = await masivaConProtegidos(page, ['a.pdf', largo]);
    await dialogo.getByLabel(`Usar el nombre de ${largo}`).uncheck();
    await expect(dialogo.getByLabel(`Contraseña de ${largo}`)).toBeVisible();
    const casilla = dialogo.getByText('Usar el nombre como contraseña', { exact: true });
    const caja = await casilla.boundingBox();
    expect(caja!.x + caja!.width).toBeLessThanOrEqual(375);
    const desborde = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(desborde).toBeLessThanOrEqual(0);
  });

  async function abrirVisorProtegido(page: Page) {
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
  }

  test('visor: el PDF cifrado dice que está protegido, no «No password given»', async ({ page }) => {
    await abrirVisorProtegido(page);

    await expect(page.getByText('Este documento está protegido con contraseña y no se puede previsualizar.')).toBeVisible();
    await expect(page.getByText(/No password given/i)).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Abrir en una pestaña nueva' })).toBeVisible();
  });

  test('visor a 375 px: la lista va arriba y el aviso de protegido y su enlace caben en la pantalla', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await abrirVisorProtegido(page);
    const aviso = page.getByText('Este documento está protegido con contraseña y no se puede previsualizar.');
    const enlace = page.getByRole('link', { name: 'Abrir en una pestaña nueva' });
    await expect(aviso).toBeVisible();
    await expect(enlace).toBeVisible();
    for (const el of [aviso, enlace]) {
      const caja = await el.boundingBox();
      expect(caja).not.toBeNull();
      expect(caja!.x).toBeGreaterThanOrEqual(0);
      expect(caja!.x + caja!.width).toBeLessThanOrEqual(375);
      // Ancho útil: un panel aplastado a ~40 px parte la frase palabra por palabra.
      expect(caja!.width).toBeGreaterThan(120);
    }
    const desborde = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(desborde).toBeLessThanOrEqual(0);
  });
});
