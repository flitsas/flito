// HU #12998 — «Reintentar consulta» de una solicitud «Por validar» (Feature #12841).
//
// Spec UX que manda: `docs/ux/flito-soat-solicitud-incompleta-runt.md` §3.3 (botón, en vuelo y
// toasts literales) y §5 (detalle). La API se intercepta con `page.route`; el reintento se puede
// RETENER para ver el estado en vuelo, y `buscar` es con estado para que la completada salga de
// «Por validar» tras la relectura.
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, CLIENTE_CON_CANAL, FUNCIONES_POR_ROL } from '../helpers/auth';

const VIN_A = '9FKRG2222T2042405';
const VIN_B = '9BWZZZ377VT004251';
const ID_A = 'aaaaaaaa-1111-4222-8333-444444444444';
const ID_B = 'cccccccc-1111-4222-8333-444444444444';

const fila = (id: string, vin: string) => ({
  id, estado: 'incompleta', vin, companiaId: 1, companiaNombre: 'Concesionario Norte',
  placa: null, marca: null, linea: null, titular: 'Ana Pérez', solicitadoPorNombre: 'Cliente E2E',
  solicitadoEn: '2026-09-28T14:00:00Z', intentos: 1, ultimoIntentoRuntEn: '2026-09-28T14:14:00Z',
  descarte: null, soatId: null,
});

const SOAT_ACTIVO = {
  poliza: 'AT-1234567', fechaExpedicion: '2025-10-10', inicioVigencia: '2025-10-15',
  vencimiento: '2026-10-14', aseguradora: 'Aseguradora E2E', estado: 'VIGENTE',
};

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

type Respuesta = { status: number; body: unknown } | 'sin-red';

/** Cola con dos incompletas; `quitarTrasReintento` saca de «buscar» la que se resolvió. */
async function mockCola(page: Page, respuesta: Respuesta, opciones: { quitarTrasReintento?: boolean; retener?: boolean } = {}) {
  let quedan = [fila(ID_A, VIN_A), fila(ID_B, VIN_B)];
  const cap = { buscadas: 0, reintentos: [] as { id: string; cuerpo: string | null }[] };
  let soltar: () => void = () => {};
  const retenida = new Promise<void>((r) => { soltar = () => r(); });
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat/, (r) => json(r, 200, []));
  await page.route(/\/api\/flito\/soat\/facetas/, (r) => json(r, 200, { companias: [], organismos: [], proveedores: [] }));
  await page.route(/\/api\/flito\/soat\?/, (r) => json(r, 200, { items: [], total: 0, page: 1, pageSize: 50 }));
  await page.route(/\/api\/flito\/soat\/cliente\/incompletas\/buscar$/, (r) => {
    cap.buscadas += 1;
    const estados = (r.request().postDataJSON() as { estados: string[] }).estados;
    const items = estados.includes('incompleta') ? quedan : [];
    return json(r, 200, { items, total: items.length, conteos: { incompleta: quedan.length, descartada: 0 } });
  });
  await page.route(/\/api\/flito\/soat\/cliente\/incompletas\/[0-9a-f-]{36}$/, (r) => {
    const id = new URL(r.request().url()).pathname.split('/').pop()!;
    return json(r, 200, {
      ...(id === ID_B ? fila(ID_B, VIN_B) : fila(ID_A, VIN_A)),
      propietario: {
        tipoDocumento: 'CC', nombres: 'Ana', apellidos: 'Pérez', razonSocial: null, numeroDocumento: '1020304050',
        correo: null, celular: null, direccion: null, municipio: null, departamento: null,
      },
      factura: { nombreArchivo: 'factura-venta.pdf', contentType: 'application/pdf', tamanoBytes: 204800 },
    });
  });
  await page.route(/\/api\/flito\/soat\/cliente\/incompletas\/[0-9a-f-]{36}\/reintentar$/, async (r) => {
    const id = new URL(r.request().url()).pathname.split('/').slice(-2)[0];
    cap.reintentos.push({ id, cuerpo: r.request().postData() });
    if (opciones.retener) await retenida;
    if (respuesta === 'sin-red') return r.abort('failed');
    if (opciones.quitarTrasReintento) quedan = quedan.filter((f) => f.id !== id);
    return json(r, respuesta.status, respuesta.body);
  });
  return { cap, soltar };
}

const tabla = (page: Page) => page.getByRole('region', { name: 'Pólizas SOAT' });
const filaDe = (page: Page, vin: string) => tabla(page).locator('tbody tr', { hasText: vin });
const btnReintentar = (page: Page, vin: string) => filaDe(page, vin).getByRole('button', { name: 'Reintentar consulta' });
const toast = (page: Page, texto: string) => page.getByText(texto, { exact: true });

async function abrirPorValidar(page: Page) {
  await page.goto('/flito/soat');
  await page.getByRole('button', { name: 'Por validar', exact: true }).click();
  await expect(filaDe(page, VIN_A)).toBeVisible();
}

test.describe('HU #12998 · AC2/AC3/AC5 — un toast por desenlace, copy literal', () => {
  test('completada sin vigenciaProxima: toast con los 4 últimos del VIN y la fila sale de «Por validar»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { cap } = await mockCola(page, {
      status: 200, body: { resultado: 'completada', soatId: 'dddddddd-1111-4222-8333-444444444444', estado: 'solicitado', vigenciaProxima: null },
    }, { quitarTrasReintento: true });
    await abrirPorValidar(page);
    const antes = cap.buscadas;

    await btnReintentar(page, VIN_A).click();

    await expect(toast(page, 'El RUNT respondió: la solicitud del VIN …2405 pasó a Solicitado.')).toBeVisible();
    await expect(filaDe(page, VIN_A)).toHaveCount(0);
    expect(cap.buscadas).toBeGreaterThan(antes);
    expect(cap.reintentos).toEqual([{ id: ID_A, cuerpo: '{}' }]);
    // Nunca el VIN completo en el toast.
    await expect(page.locator('[data-sonner-toast], [role="status"]').filter({ hasText: VIN_A })).toHaveCount(0);
  });

  test('descartada por soat_vigente: toast con la fecha del SOAT activo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page, {
      status: 200, body: { resultado: 'descartada', motivo: 'soat_vigente', soatActivo: { ...SOAT_ACTIVO, vencimiento: '2027-03-14' } },
    }, { quitarTrasReintento: true });
    await abrirPorValidar(page);
    await btnReintentar(page, VIN_A).click();
    await expect(toast(page, 'La solicitud quedó descartada: el vehículo ya tiene SOAT activo hasta el 14 de marzo de 2027. Puede verla en «Descartadas».')).toBeVisible();
    await expect(page.getByText('AT-1234567')).toHaveCount(0);
  });

  test('descartada por VIN inexistente: toast literal', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page, { status: 200, body: { resultado: 'descartada', motivo: 'runt_sin_registro', soatActivo: null } }, { quitarTrasReintento: true });
    await abrirPorValidar(page);
    await btnReintentar(page, VIN_A).click();
    await expect(toast(page, 'La solicitud quedó descartada: el RUNT no tiene registrado ese VIN. Puede verla en «Descartadas».')).toBeVisible();
    await expect(page.getByText('runt_sin_registro')).toHaveCount(0);
  });

  test('sigue incompleta: toast literal y el foco vuelve a «Ver» de esa fila', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page, { status: 200, body: { resultado: 'sigue_incompleta', intentos: 2, ultimoIntentoRuntEn: '2026-09-28T15:00:00Z' } });
    await abrirPorValidar(page);
    await btnReintentar(page, VIN_A).click();
    await expect(toast(page, 'El RUNT sigue sin responder. La solicitud se conserva por validar; intente más tarde.')).toBeVisible();
    await expect(filaDe(page, VIN_A).getByRole('button', { name: 'Ver' })).toBeFocused();
  });
});

test.describe('HU #12998 · AC6/AC8 — conflicto, sin red y límite', () => {
  test('409 incompleta_ya_resuelta: «Esta solicitud ya había cambiado de estado…» y la lista se relee', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { cap } = await mockCola(page, { status: 409, body: { error: 'incompleta ya resuelta (crudo)', codigo: 'incompleta_ya_resuelta', estado: 'completada' } });
    await abrirPorValidar(page);
    const antes = cap.buscadas;
    await btnReintentar(page, VIN_A).click();
    await expect(toast(page, 'Esta solicitud ya había cambiado de estado. La lista se actualizó.')).toBeVisible();
    await expect.poll(() => cap.buscadas).toBeGreaterThan(antes);
    await expect(page.getByText('(crudo)')).toHaveCount(0);
  });

  test('sin red (Cliente con el permiso): «No pudimos reintentar la consulta. Revise su conexión…»', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL, { funciones: [...FUNCIONES_POR_ROL.cliente, 'soat.solicitud.reintentar_runt'] });
    await mockCola(page, 'sin-red');
    await abrirPorValidar(page);
    await btnReintentar(page, VIN_A).click();
    await expect(toast(page, 'No pudimos reintentar la consulta. Revise su conexión e intente de nuevo.')).toBeVisible();
    // El botón vuelve a reposo: ÉL es el reintento.
    await expect(btnReintentar(page, VIN_A)).toBeEnabled();
  });

  test('429: copy pulido, nunca «Demasiadas solicitudes» crudo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page, { status: 429, body: { error: 'Too many requests' } });
    await abrirPorValidar(page);
    await btnReintentar(page, VIN_A).click();
    await expect(toast(page, 'Hubo demasiadas consultas seguidas. Espera unos minutos e intenta de nuevo.')).toBeVisible();
    await expect(page.getByText('Too many requests')).toHaveCount(0);
  });

  test('en vuelo: solo esa fila ocupada, aria-busy, «Consultando…», un único status y describedby a la celda del vehículo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { soltar } = await mockCola(page, { status: 200, body: { resultado: 'sigue_incompleta', intentos: 2, ultimoIntentoRuntEn: '2026-09-28T15:00:00Z' } }, { retener: true });
    await abrirPorValidar(page);

    const boton = btnReintentar(page, VIN_A);
    // Nombre accesible sin el VIN; la descripción apunta a la celda del vehículo, que sí lo tiene.
    await expect(boton).toHaveAccessibleName('Reintentar consulta');
    const describe = await boton.getAttribute('aria-describedby');
    expect(describe).toBeTruthy();
    await expect(page.locator(`[id="${describe}"]`)).toContainText(VIN_A);

    await boton.click();
    const ocupado = filaDe(page, VIN_A).getByRole('button', { name: 'Consultando…' });
    await expect(ocupado).toBeDisabled();
    await expect(ocupado).toHaveAttribute('aria-busy', 'true');
    await expect(ocupado.locator('svg.motion-reduce\\:animate-none')).toHaveCount(1);
    await expect(btnReintentar(page, VIN_B)).toBeEnabled();
    await expect(page.getByRole('status').filter({ hasText: 'Consultando el RUNT…' })).toHaveCount(1);

    soltar();
    await expect(btnReintentar(page, VIN_A)).toBeEnabled();
    await expect(page.getByRole('status').filter({ hasText: 'Consultando el RUNT…' })).toHaveCount(0);
  });
});

test.describe('HU #12998 · AC7 — el permiso', () => {
  test('sin soat.solicitud.reintentar_runt: ni en la fila ni en el detalle, y el detalle dice «FLITO volverá a consultar el RUNT.»', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    const { cap } = await mockCola(page, { status: 200, body: {} });
    await abrirPorValidar(page);
    await expect(tabla(page).getByRole('button', { name: 'Reintentar consulta' })).toHaveCount(0);
    await filaDe(page, VIN_A).getByRole('button', { name: 'Ver' }).click();
    const modal = page.getByRole('dialog');
    await expect(modal).toContainText('FLITO volverá a consultar el RUNT.');
    await expect(modal.getByRole('button', { name: 'Reintentar consulta' })).toHaveCount(0);
    expect(cap.reintentos).toHaveLength(0);
  });
});

test.describe('HU #12998 · AC2/AC8 — el detalle', () => {
  test('primaria del modal; en vuelo el cierre queda deshabilitado; completada con vigenciaProxima pinta la tarjeta aviso', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { soltar } = await mockCola(page, {
      status: 200,
      body: { resultado: 'completada', soatId: 'dddddddd-1111-4222-8333-444444444444', estado: 'solicitado', vigenciaProxima: { ...SOAT_ACTIVO, venceEl: '2026-10-14' } },
    }, { retener: true, quitarTrasReintento: true });
    await abrirPorValidar(page);
    await filaDe(page, VIN_A).getByRole('button', { name: 'Ver' }).click();
    const modal = page.getByRole('dialog');
    await expect(modal.getByText('FLITO volverá a consultar el RUNT.')).toHaveCount(0);

    await modal.getByRole('button', { name: 'Reintentar consulta' }).click();
    await expect(modal.getByRole('button', { name: 'Consultando…' })).toBeDisabled();
    await expect(modal.getByRole('button', { name: 'Cerrar' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(modal).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Consultando el RUNT…' })).toHaveCount(1);

    soltar();
    await expect(toast(page, 'El RUNT respondió: la solicitud pasó a Solicitado. El SOAT actual vence el 14 de octubre de 2026.')).toBeVisible();
    await expect(modal.getByRole('heading', { name: 'Este vehículo todavía tiene SOAT activo' })).toBeVisible();
    await expect(modal.getByRole('heading', { name: 'Pendiente de validar con el RUNT' })).toHaveCount(0);
    await expect(modal.getByRole('button', { name: 'Cerrar' })).toBeEnabled();
  });
});
