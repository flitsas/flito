// Selector de rango de fechas en un solo calendario (HU #11026).
//
// Se prueba sobre el reporte de costos, que es donde conviven dos rangos independientes: el error
// que más importa evitar es que marcar en uno mueva el otro.

import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';

/** El disparador del rango. Es un <summary>, que no expone su aria-label como etiqueta. */
const rango = (page: import('@playwright/test').Page, etiqueta: string) =>
  page.locator('summary').filter({ hasText: etiqueta });

async function mock(page: import('@playwright/test').Page, capturado: { url?: string }) {
  await page.route(/\/api\/finanzas\/reporte-costos\/facetas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      estados: ['Aprobado'], empresas: [], tipos: [],
    }) }));
  await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) => {
    capturado.url = route.request().url();
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        items: [], total: 0, page: 1, pageSize: 50,
        totales: { soat: 0, impuesto: 0, derechoTramite: 0, logistica: 0, tramiteDigital: 0, gmf: 0, total: 0, filasIncompletas: 0 },
      }),
    });
  });
}

test.describe('Rango de fechas — un solo calendario', () => {
  test('marcar inicio y fin en el mismo calendario filtra el listado', async ({ page }) => {
    const capturado: { url?: string } = {};
    await loginAs(page, OPERACIONES_USER);
    await mock(page, capturado);
    await page.goto('/finanzas/reporte-costos');

    // Cerrado: resume el rango elegido en el propio botón, sin abrir nada.
    const creado = rango(page, 'Creado');
    await expect(creado).toContainText('Cualquier fecha');

    await creado.click();
    // El atajo deja el rango puesto de una vez, que es el caso más frecuente.
    await page.getByRole('button', { name: '7 días' }).click();
    await expect(creado).toContainText('→');

    await expect.poll(() => capturado.url ?? '').toContain('desde=');
    await expect.poll(() => capturado.url ?? '').toContain('hasta=');
  });

  test('elegir al revés no se rechaza: se invierte', async ({ page }) => {
    const capturado: { url?: string } = {};
    await loginAs(page, OPERACIONES_USER);
    await mock(page, capturado);
    await page.goto('/finanzas/reporte-costos');

    await rango(page, 'Creado').click();
    // Dos días del mes visible, el segundo anterior al primero. Quien marca al revés está
    // señalando el mismo tramo, no cometiendo un error que haya que devolverle.
    const dias = page.getByRole('button', { name: /^\d{4}-\d{2}-\d{2}$/ });
    await dias.nth(14).click();
    await dias.nth(4).click();

    const resumen = await rango(page, 'Creado').innerText();
    expect(resumen).toContain('→');
    expect(resumen).not.toContain('…');
  });

  test('los dos rangos son independientes', async ({ page }) => {
    const capturado: { url?: string } = {};
    await loginAs(page, OPERACIONES_USER);
    await mock(page, capturado);
    await page.goto('/finanzas/reporte-costos');

    await rango(page, 'Aprobado').click();
    await page.getByRole('button', { name: 'Hoy' }).click();

    await expect(rango(page, 'Aprobado')).toContainText('→');
    // Tocar uno no puede mover el otro: son dos preguntas distintas sobre el mismo trámite.
    await expect(rango(page, 'Creado')).toContainText('Cualquier fecha');
  });

  test('se puede quitar el rango y volver a «cualquier fecha»', async ({ page }) => {
    const capturado: { url?: string } = {};
    await loginAs(page, OPERACIONES_USER);
    await mock(page, capturado);
    await page.goto('/finanzas/reporte-costos');

    const creado = rango(page, 'Creado');
    await creado.click();
    await page.getByRole('button', { name: 'Hoy' }).click();
    await expect(creado).toContainText('→');

    await page.getByRole('button', { name: 'Quitar el rango' }).click();
    await expect(creado).toContainText('Cualquier fecha');
  });
});
