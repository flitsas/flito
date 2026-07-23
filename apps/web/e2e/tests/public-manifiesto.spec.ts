import { test, expect } from '../helpers/fixtures';

test.describe('Manifiesto público QR (/m/:token)', () => {
  test('token válido muestra datos del manifiesto sin requerir login', async ({ page }) => {
    await page.route('**/api/rndc/public/manifiestos/qr/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          valido: true,
          numero: 'MAN-202605-0050',
          consecutivoRndc: 'CR-MAN-50',
          estado: 'aceptado',
          fechaExpedicion: '2026-05-07',
          placa: 'ABC123',
          origen: 'BOGOTÁ',
          destino: 'CALI',
          razonSocialEmpresa: 'Kyverum LLC',
        }),
      })
    );

    await page.goto('/m/token-de-prueba-123');
    await expect(page.getByText('MAN-202605-0050')).toBeVisible();
    await expect(page.getByText(/ABC123/)).toBeVisible();
    await expect(page.getByText(/Kyverum LLC/)).toBeVisible();
    // Ruta pública: NO debería redirigir a /login.
    await expect(page).toHaveURL(/\/m\/token-de-prueba-123/);
  });

  test('token desconocido muestra estado inválido', async ({ page }) => {
    await page.route('**/api/rndc/public/manifiestos/qr/**', (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ valido: false }) })
    );

    await page.goto('/m/no-existe');
    await expect(page.getByText(/inválid|no.*válid|no encontrado/i).first()).toBeVisible();
  });
});
