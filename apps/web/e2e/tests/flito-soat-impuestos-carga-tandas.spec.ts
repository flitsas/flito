import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';

// HU #12051 — tandas de la carga masiva SOAT / Impuestos. Backend mockeado:
// 12 archivos → 3 POST secuenciales; 504 en la tanda 2 deja visible la tanda 1.

const FACETAS_SOAT = {
  companias: [{ id: 1, nombre: 'Concesionario Norte' }],
  organismos: [{ codigo: '17001', nombre: 'STT Manizales' }],
  proveedores: [{ id: 'p1', nombre: 'Seguros Alfa' }],
};

const FACETAS_IMP = {
  companias: [{ id: 1, nombre: 'Concesionario Norte' }],
  organismos: [{ codigo: '17001', nombre: 'STT Manizales' }],
};

const VACIO_SOAT = { items: [], total: 0, page: 1, pageSize: 50 };
const VACIO_IMP = { items: [], total: 0, page: 1, pageSize: 50 };

const PDF_MIN = { mimeType: 'application/pdf' as const, buffer: Buffer.from('%PDF-1.4 t') };

function archivos(n: number) {
  return Array.from({ length: n }, (_, i) => ({ name: `f${i + 1}.pdf`, ...PDF_MIN }));
}

function contarArchivos(postData: string | null): number {
  return (postData ?? '').match(/name="archivos"/g)?.length ?? 0;
}

async function mockSoat(page: import('@playwright/test').Page) {
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));
  await page.route(/\/api\/flito\/soat\/facetas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FACETAS_SOAT) }));
  await page.route(/\/api\/flito\/soat\?/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(VACIO_SOAT) }));
}

async function mockImpuestos(page: import('@playwright/test').Page) {
  await page.route(/\/api\/flito\/impuestos\/facetas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FACETAS_IMP) }));
  await page.route(/\/api\/flito\/impuestos\?/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(VACIO_IMP) }));
}

const OK_SOAT = {
  pagados: [{ archivo: 'a.pdf', detalle: 'ok' }],
  enRevision: [],
  duplicados: [],
  noAsociados: [],
};

const OK_SOAT_2 = {
  pagados: [{ archivo: 'b.pdf', detalle: 'ok' }],
  enRevision: [{ archivo: 'c.pdf', detalle: 'duda' }],
  duplicados: [],
  noAsociados: [],
};

test.describe('HU #12051 — tandas de carga masiva', () => {
  test('SOAT: 12 archivos → 3 POST secuenciales y tanda k de n', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockSoat(page);

    const eventos: string[] = [];
    let inflight = 0;
    let maxInflight = 0;
    const porTanda: number[] = [];
    let release1!: () => void;
    const held1 = new Promise<void>((r) => { release1 = r; });

    await page.route(/\/api\/flito\/soat\/facturas$/, async (route) => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      const n = porTanda.length + 1;
      eventos.push(`start-${n}`);
      porTanda.push(contarArchivos(route.request().postData()));
      if (n === 1) await held1;
      await new Promise((r) => setTimeout(r, 40));
      eventos.push(`end-${n}`);
      inflight -= 1;
      const body = n === 1 ? OK_SOAT : n === 2 ? OK_SOAT_2 : { pagados: [], enRevision: [], duplicados: [], noAsociados: [] };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });

    await page.goto('/flito/soat');
    await page.getByRole('button', { name: 'Cargar facturas (masivo)' }).click();
    const modal = page.getByRole('dialog');
    await modal.locator('input[type="file"]').setInputFiles(archivos(12));
    await modal.getByRole('button', { name: 'Subir y procesar' }).click();

    await expect(modal.getByRole('status')).toHaveText('tanda 1 de 3');
    await expect(modal.getByRole('button', { name: 'Procesando…' })).toBeDisabled();
    await expect(modal.getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    release1();

    await expect(modal.getByRole('button', { name: 'Listo' })).toBeVisible();
    await expect(modal.getByText('Pagados 2')).toBeVisible();
    await expect(modal.getByText('En revisión 1')).toBeVisible();
    expect(porTanda).toEqual([5, 5, 2]);
    expect(maxInflight).toBe(1);
    expect(eventos).toEqual(['start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3']);
  });

  test('SOAT: 5 archivos no pintan tanda k de n', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockSoat(page);
    let posts = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    await page.route(/\/api\/flito\/soat\/facturas$/, async (route) => {
      posts += 1;
      await held;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OK_SOAT) });
    });

    await page.goto('/flito/soat');
    await page.getByRole('button', { name: 'Cargar facturas (masivo)' }).click();
    const modal = page.getByRole('dialog');
    await modal.locator('input[type="file"]').setInputFiles(archivos(5));
    await modal.getByRole('button', { name: 'Subir y procesar' }).click();
    await expect(modal.getByRole('button', { name: 'Procesando…' })).toBeVisible();
    await expect(modal.getByRole('status')).toHaveCount(0);
    release();
    await expect(modal.getByRole('button', { name: 'Listo' })).toBeVisible();
    expect(posts).toBe(1);
  });

  test('SOAT: 504 en tanda 2 muestra copy y chips de la tanda 1; no hay tercer POST', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockSoat(page);
    let posts = 0;
    await page.route(/\/api\/flito\/soat\/facturas$/, async (route) => {
      posts += 1;
      if (posts === 1) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OK_SOAT) });
      }
      if (posts === 2) {
        return route.fulfill({
          status: 504,
          contentType: 'text/html',
          body: '<html><center>504 Gateway Time-out</center></html>',
        });
      }
      throw new Error('no debía salir un tercer POST');
    });

    await page.goto('/flito/soat');
    await page.getByRole('button', { name: 'Cargar facturas (masivo)' }).click();
    const modal = page.getByRole('dialog');
    await modal.locator('input[type="file"]').setInputFiles(archivos(12));
    await modal.getByRole('button', { name: 'Subir y procesar' }).click();

    await expect(modal.getByRole('alert')).toHaveText(
      'El servidor no terminó a tiempo. Esta carga no se alcanzó a procesar. Espera un momento y vuelve a intentar, o súbela más liviana.',
    );
    await expect(modal.getByText('Pagados 1')).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Listo' })).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Reintentar el resto' })).toHaveCount(0);
    expect(posts).toBe(2);
  });

  test('Impuestos: sinMarcaDeAgua viaja en cada tanda', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockImpuestos(page);
    const marcas: string[] = [];
    await page.route(/\/api\/flito\/impuestos\/recibos$/, async (route) => {
      const data = route.request().postData() ?? '';
      const m = data.match(/name="sinMarcaDeAgua"[\s\S]*?\r?\n\r?\n([^\r\n-]+)/);
      marcas.push((m?.[1] ?? '').trim());
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          conciliados: [], enRevision: [], complementos: [], duplicados: [], noAsociados: [],
        }),
      });
    });

    await page.goto('/flito/impuestos');
    await page.getByRole('button', { name: 'Cargar recibos (masivo)' }).click();
    const modal = page.getByRole('dialog');
    await modal.getByRole('checkbox', { name: /sin marca de agua/i }).check();
    await modal.locator('input[type="file"]').setInputFiles(archivos(6));
    await modal.getByRole('button', { name: 'Subir y procesar' }).click();
    await expect(modal.getByRole('button', { name: 'Listo' })).toBeVisible();
    expect(marcas).toEqual(['true', 'true']);
  });
});
