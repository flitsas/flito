import { test, expect } from '../helpers/fixtures';
import { loginAs, MENSAJERO_USER } from '../helpers/auth';

// FLITO — Mi ruta (mensajero, v2). Recogida = escanear/pegar el PDF417 de CADA LT → el backend empareja
// por placa+VIN y cada LT se va agregando a una tabla (emparejadas y no emparejadas). En headless no hay
// BarcodeDetector, así que se ejercita el respaldo de pegado. Entrega = firma del receptor (RN-03).

const RAW = '10038156339 C.C. 1053786950 MUÑOZ GOMEZ EMMANUEL DAVID CLL 112 N 47A 08 MANIZALES 7 /9j/4AAQSkZJRgABAQEA QOX858 LRWYGCFJ0TC496126 LRWYGCFJ0TC496126 352026000097934 ELECTRICO';

const RUTA = {
  entregas: [
    {
      actaId: 'acta-1', companiaNombre: 'Concesionario Norte', direccionEntrega: 'Calle 10 #20-30', contactoNombre: 'Juan',
      documentos: [{ id: 'doc-3', placa: 'DEF456', idFlit: 'FLIT-3', numeroLt: 'LT-9' }],
    },
  ],
};

async function abrirPegado(page: import('@playwright/test').Page) {
  await page.goto('/flito/ruta');
  await expect(page.getByRole('heading', { name: 'Mi ruta' })).toBeVisible();
  await page.getByText('Pega el contenido del código').click(); // abre el <details> de respaldo
}

test.describe('FLITO — Mi ruta (mensajero)', () => {
  test('cargar una LT emparejada la registra y la muestra en una tarjeta', async ({ page }) => {
    await loginAs(page, MENSAJERO_USER);
    await page.route(/\/api\/flito\/logistica\/mi-ruta/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RUTA) }));
    let body: Record<string, unknown> | null = null;
    await page.route(/\/api\/flito\/logistica\/escanear$/, async (route) => {
      body = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ resultado: 'recogido', placa: 'QOX858' }) });
    });

    await abrirPegado(page);
    await page.getByPlaceholder(/10038156339/).fill(RAW);
    await page.getByPlaceholder(/N.º de LT/).fill('LT10000848803');
    await page.getByRole('button', { name: 'Agregar' }).click();

    await expect.poll(() => body).not.toBeNull();
    expect(body).toMatchObject({ rawValue: RAW, numeroLt: 'LT10000848803' });
    // Tarjeta de la LT con los datos del código + estado.
    await expect(page.getByText('QOX858')).toBeVisible();
    await expect(page.getByText('MUÑOZ GOMEZ EMMANUEL DAVID')).toBeVisible();
    await expect(page.getByText('✓ Registrada')).toBeVisible();
    await expect(page.getByPlaceholder('—')).toHaveValue('LT10000848803'); // N.º de LT editable prellenado
  });

  test('una LT sin trámite aprobado se muestra extraída pero con el aviso', async ({ page }) => {
    await loginAs(page, MENSAJERO_USER);
    await page.route(/\/api\/flito\/logistica\/mi-ruta/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RUTA) }));
    await page.route(/\/api\/flito\/logistica\/escanear$/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ resultado: 'sin_match', placa: 'QOX858', motivo: 'No hay ningún trámite aprobado con esta placa.' }) }));

    await abrirPegado(page);
    await page.getByPlaceholder(/10038156339/).fill(RAW);
    await page.getByRole('button', { name: 'Agregar' }).click();

    // La tarjeta muestra la placa extraída, el chip "Sin trámite" y el motivo del backend.
    await expect(page.getByText('QOX858')).toBeVisible();
    await expect(page.getByText('Sin trámite')).toBeVisible();
    await expect(page.getByText(/no hay ningún trámite aprobado/i)).toBeVisible();
  });

  test('offline: encola el escaneo y lo sincroniza (idempotente) al reconectar', async ({ page, context }) => {
    await loginAs(page, MENSAJERO_USER);
    await page.route(/\/api\/flito\/logistica\/mi-ruta/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RUTA) }));
    let sent: Record<string, unknown> | null = null;
    let idemKey: string | undefined;
    await page.route(/\/api\/flito\/logistica\/escanear$/, async (route) => {
      sent = route.request().postDataJSON() as Record<string, unknown>;
      idemKey = route.request().headers()['idempotency-key'];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ resultado: 'recogido', placa: 'QOX858' }) });
    });

    await abrirPegado(page);
    await page.getByPlaceholder(/10038156339/).fill(RAW);

    await context.setOffline(true);
    await page.getByRole('button', { name: 'Agregar' }).click();
    await expect(page.getByText(/sin sincronizar/)).toBeVisible(); // cola visible (CA-15)
    expect(sent).toBeNull();

    await context.setOffline(false);
    await expect.poll(() => sent).not.toBeNull();
    expect(sent).toMatchObject({ rawValue: RAW });
    expect(idemKey).toBeTruthy();
  });

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
    await page.getByPlaceholder('Nombre del receptor').fill('María Ruiz');
    await page.getByPlaceholder('Documento del receptor').fill('30303030');

    const confirmar = page.getByRole('button', { name: 'Confirmar entrega' });
    await expect(confirmar).toBeDisabled();

    await page.getByLabel('Firma del receptor').evaluate((el: HTMLCanvasElement) => {
      const r = el.getBoundingClientRect();
      const pe = (type: string, x: number, y: number) =>
        el.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerId: 1 }));
      pe('pointerdown', 20, 20); pe('pointermove', 90, 60); pe('pointermove', 140, 30); pe('pointerup', 140, 30);
    });

    await expect(confirmar).toBeEnabled();
    await confirmar.click();
    await expect.poll(() => body).not.toBeNull();
    expect(body).toMatchObject({ receptorNombre: 'María Ruiz', receptorDocumento: '30303030' });
    expect(typeof body!.firma).toBe('string');
  });
});
