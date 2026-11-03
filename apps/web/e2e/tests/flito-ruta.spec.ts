import { test, expect } from '../helpers/fixtures';
import { loginAs, MENSAJERO_USER } from '../helpers/auth';

// FLITO — Mi ruta (mensajero). La recogida de LT (escaneo, ingreso a mano, firma del funcionario, Mis recogidas)
// vive en flito-ruta-recogida.spec.ts (HU #14111). Aquí queda la ENTREGA: firma del receptor (RN-03 / HU #14116).

const RUTA = {
  entregas: [
    {
      actaId: 'acta-1', companiaNombre: 'Concesionario Norte', direccionEntrega: 'Calle 10 #20-30', contactoNombre: 'Juan',
      documentos: [{ id: 'doc-3', placa: 'DEF456', idFlit: 'FLIT-3', numeroLt: 'LT-9' }],
    },
  ],
};

test.describe('FLITO — Mi ruta (mensajero)', () => {
  test('registrar entrega exige la firma del receptor (RN-03) y la envía', async ({ page }) => {
    await loginAs(page, MENSAJERO_USER);
    await page.route(/\/api\/flito\/logistica\/mi-ruta/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RUTA) }));
    let body: Record<string, unknown> | null = null;
    await page.route(/\/api\/flito\/logistica\/actas\/acta-1\/entregar$/, async (route) => {
      body = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ documentos: 1 }) });
    });

    await page.goto('/flito/ruta');
    await page.getByRole('button', { name: 'Entregar', exact: true }).click();
    await page.getByLabel('Nombre de quien recibe').fill('María Ruiz');
    await page.getByLabel('Cédula de quien recibe').fill('30303030');

    const confirmar = page.getByRole('button', { name: 'Confirmar entrega' });
    await expect(confirmar).toBeEnabled();

    await page.getByLabel(/Firma de quien recibe/).evaluate((el: HTMLCanvasElement) => {
      const r = el.getBoundingClientRect();
      const pe = (type: string, x: number, y: number) =>
        el.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerId: 1 }));
      pe('pointerdown', 20, 20); pe('pointermove', 90, 60); pe('pointermove', 140, 30); pe('pointerup', 140, 30);
    });

    await confirmar.click();
    await expect.poll(() => body).not.toBeNull();
    expect(body).toMatchObject({ receptorNombre: 'María Ruiz', receptorDocumento: '30303030' });
    expect(typeof body!.firma).toBe('string');
    expect(page.url()).not.toMatch(/30303030/);
  });
});
