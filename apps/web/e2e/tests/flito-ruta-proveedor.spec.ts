import { test, expect, type Page } from '@playwright/test';
import { MENSAJE_LT_NO_ENCONTRADA } from '@operaciones/shared-types';
import { loginAs, MENSAJERO_USER, funcionesDe } from '../helpers/auth';

// HU #14353 — Mi ruta del mensajero de proveedor. H1 (viaje a FLIT sin firma), H2 (sin propietario en «Ver datos»),
// AC4 (sin «dejar pendiente») y AC6 (mensaje único). Backend mockeado.

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json' as const, body: JSON.stringify(body) });

const FUN = ['logistica.ruta.ver', 'logistica.documento.escanear', 'logistica.recogida.confirmar'];
const MENSAJERO_PROVEEDOR = { ...MENSAJERO_USER, tipoEnlace: 'proveedor' };
const BASE = funcionesDe(MENSAJERO_USER).filter((f) => !f.startsWith('logistica.'));

const VIAJE_CLIENTE = {
  actaId: 'acta-c', companiaNombre: 'Concesionario Demo Norte', direccionEntrega: 'Calle Demo 1 # 2-3', contactoNombre: null, destino: 'cliente', trasladoId: 'tv-1',
  documentos: [{ id: 'd1', placa: 'ZZA101', idFlit: 'FLIT-DEMO-1', numeroLt: 'LT90000000101' }, { id: 'd2', placa: 'ZZB202', idFlit: 'FLIT-DEMO-2', numeroLt: 'LT90000000202' }],
};
const VIAJE_FLIT = {
  actaId: 'acta-f', companiaNombre: 'Concesionario Demo Sur', direccionEntrega: null, contactoNombre: null, destino: 'flit', trasladoId: 'tv-2',
  documentos: [{ id: 'd3', placa: 'ZZC303', idFlit: 'FLIT-DEMO-3', numeroLt: 'LT90000000303' }],
};

const entrar = async (page: Page, funciones: string[] = FUN, user: Record<string, unknown> = MENSAJERO_PROVEEDOR) => {
  await loginAs(page, user as typeof MENSAJERO_USER, { funciones: [...BASE, ...funciones] });
};
const mockRuta = (page: Page, entregas: unknown[]) => page.route(/\/api\/flito\/logistica\/mi-ruta/, (r) => r.fulfill(json({ entregas })));

test.describe('H1 · viaje a FLIT', () => {
  test('tarjeta sin firma ni primaria, con el texto de la spec y Devolver', async ({ page }) => {
    await entrar(page);
    await mockRuta(page, [VIAJE_CLIENTE, VIAJE_FLIT]);
    await page.goto('/flito/ruta');
    await expect(page.getByRole('heading', { name: 'Entregas (2)' })).toBeVisible();
    const tarjeta = page.getByRole('article').filter({ hasText: 'Concesionario Demo Sur' });
    await expect(tarjeta.getByText('A FLIT', { exact: true })).toBeVisible();
    await expect(tarjeta.getByText('Lleva estas LT a FLIT. Allí firman la llegada.')).toBeVisible();
    await expect(tarjeta.getByRole('button')).toHaveCount(1);
    await expect(tarjeta.getByRole('button', { name: 'Devolver el viaje' })).toBeVisible();
    await expect(page.getByRole('article').filter({ hasText: 'Concesionario Demo Norte' }).getByRole('button', { name: 'Entregar' })).toBeVisible();
  });

  test('sigue sin firma aunque le asignen firmar_flit (doble cerradura)', async ({ page }) => {
    await entrar(page, [...FUN, 'logistica.actas.firmar_flit']);
    await mockRuta(page, [VIAJE_FLIT]);
    await page.goto('/flito/ruta');
    await expect(page.getByText('Lleva estas LT a FLIT.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Firmar llegada' })).toHaveCount(0);
  });

  test('un mensajero de FLITO con firmar_flit conserva Firmar llegada', async ({ page }) => {
    await entrar(page, [...FUN, 'logistica.actas.firmar_flit'], MENSAJERO_USER);
    await mockRuta(page, [VIAJE_FLIT]);
    await page.goto('/flito/ruta');
    await expect(page.getByRole('button', { name: 'Firmar llegada' })).toBeVisible();
    await expect(page.getByText('Lleva estas LT a FLIT.')).toHaveCount(0);
  });
});

test('H1: Devolver el viaje a FLIT va por el traslado, no por el acta', async ({ page }) => {
  await entrar(page);
  await mockRuta(page, [VIAJE_FLIT]);
  let cuerpo: unknown = null;
  let porActa = false;
  await page.route(/\/api\/flito\/logistica\/traslados\/tv-2\/devolucion$/, (r) => { cuerpo = r.request().postDataJSON(); return r.fulfill(json({ ok: true })); });
  await page.route(/\/api\/flito\/logistica\/actas\/acta-f\/devolucion$/, (r) => { porActa = true; return r.fulfill(json({ error: 'Sin permisos' }, 403)); });
  await page.goto('/flito/ruta');
  await page.getByRole('button', { name: 'Devolver el viaje' }).click();
  const modal = page.getByRole('dialog', { name: /Devolver el viaje/ });
  await modal.getByLabel('Motivo (obligatorio)').fill('Receptor ausente');
  await modal.getByRole('button', { name: 'Devolver el viaje' }).click();
  await expect.poll(() => cuerpo).toEqual({ motivo: 'Receptor ausente' });
  expect(porActa).toBe(false);
});

test('AC5 de HU #14352: «Sin trámite pendiente» del servidor se pinta tal cual', async ({ page }) => {
  await entrar(page);
  await mockRuta(page, []);
  await page.route(/\/api\/flito\/logistica\/consultar-vehiculo$/, (r) => r.fulfill(json({ encontrado: true, candidatos: [{ tramiteId: 't-1', idFlit: 'FLIT-DEMO-1', companiaNombre: null, organismoCodigo: '17001' }] })));
  await page.route(/\/api\/flito\/logistica\/escanear$/, (r) => r.fulfill(json({ resultado: 'sin_match', motivo: 'Sin trámite pendiente', placa: 'ZZD404', vin: '', numeroLicencia: '1' })));
  await page.goto('/flito/ruta');
  await page.getByRole('button', { name: 'Ingresar a mano' }).click();
  await page.getByLabel('Placa').fill('ZZD404');
  await page.getByLabel('N.º de licencia de tránsito (frente)').fill('100404');
  await page.getByLabel('N.º de sustrato (reverso)').fill('LT90000000404');
  await page.getByRole('button', { name: 'Agregar LT' }).click();
  await expect(page.getByRole('article', { name: 'LT ZZD404' }).getByText('Sin trámite pendiente')).toBeVisible();
});

test.describe('AC9 · cuatro estados de Entregas', () => {
  test('error con reintento, luego vacío con su copy', async ({ page }) => {
    await entrar(page);
    let caido = true;
    await page.route(/\/api\/flito\/logistica\/mi-ruta/, (r) => (caido ? r.fulfill(json({ error: 'interno' }, 500)) : r.fulfill(json({ entregas: [] }))));
    await page.goto('/flito/ruta');
    await expect(page.getByRole('alert')).toContainText('No se pudieron cargar tus entregas.');
    caido = false;
    await page.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByText('No tienes viajes despachados para entregar. Cuando te despachen un viaje, aparece aquí.')).toBeVisible();
  });

  test('403: copy honesto y sin reintento', async ({ page }) => {
    await entrar(page);
    await page.route(/\/api\/flito\/logistica\/mi-ruta/, (r) => r.fulfill(json({ error: 'Sin permisos' }, 403)));
    await page.goto('/flito/ruta');
    await expect(page.getByRole('alert')).toHaveText('Tu usuario ya no tiene acceso a las entregas. Pide a Operaciones de FLITO que lo revise.');
    await expect(page.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
  });

  for (const estado of [403, 404]) {
    test(`devolver con ${estado}: mismo aviso, sin crudo, y recarga la ruta`, async ({ page }) => {
      await entrar(page);
      let cargas = 0;
      await page.route(/\/api\/flito\/logistica\/mi-ruta/, (r) => { cargas += 1; return r.fulfill(json({ entregas: [VIAJE_CLIENTE] })); });
      await page.route(/\/api\/flito\/logistica\/actas\/acta-c\/devolucion$/, (r) => r.fulfill(json({ error: 'crudo interno' }, estado)));
      await page.goto('/flito/ruta');
      await page.getByRole('button', { name: 'Devolver el viaje' }).click();
      const modal = page.getByRole('dialog', { name: /Devolver el viaje/ });
      await modal.getByLabel('Motivo (obligatorio)').fill('Receptor ausente');
      const antes = cargas;
      await modal.getByRole('button', { name: 'Devolver el viaje' }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'Este viaje ya no está en tu ruta. Revisa la lista actualizada.' })).toBeVisible();
      await expect(modal).toHaveCount(0);
      await expect.poll(() => cargas).toBeGreaterThan(antes);
      await expect(page.getByText('crudo interno')).toHaveCount(0);
    });
  }
});

test.describe('AC6 y AC4 · recogida', () => {
  const agregarManual = async (page: Page, placa: string) => {
    await page.getByRole('button', { name: 'Ingresar a mano' }).click();
    await page.getByLabel('Placa').fill(placa);
  };

  test('AC6 a mano: la consulta sin resultado da el mensaje único y el siguiente paso', async ({ page }) => {
    await entrar(page);
    await mockRuta(page, []);
    await page.route(/\/api\/flito\/logistica\/consultar-vehiculo$/, (r) => r.fulfill(json({ encontrado: false })));
    await page.goto('/flito/ruta');
    await agregarManual(page, 'ZZD404');
    const alerta = page.getByRole('alert');
    await expect(alerta).toContainText(MENSAJE_LT_NO_ENCONTRADA);
    await expect(alerta).toContainText('Revisa la placa e inténtalo de nuevo.');
  });

  test('AC6 en la tarjeta: mensaje único, sin compañía aunque llegue, y sin propietario en Ver datos', async ({ page }) => {
    await entrar(page);
    await mockRuta(page, []);
    await page.route(/\/api\/flito\/logistica\/consultar-vehiculo$/, (r) => r.fulfill(json({
      encontrado: true, candidatos: [{ tramiteId: 't-1', idFlit: 'FLIT-DEMO-1', companiaNombre: 'Compañía Que No Debe Verse', organismoCodigo: '17001' }],
    })));
    await page.route(/\/api\/flito\/logistica\/escanear$/, (r) => r.fulfill(json({
      resultado: 'sin_match', motivo: MENSAJE_LT_NO_ENCONTRADA, placa: 'ZZD404', vin: 'VINDEMO0000000004', numeroLicencia: '100404',
      companiaNombre: 'Compañía Que No Debe Verse', propietarioNombre: 'NO DEBE VERSE',
    })));
    await page.goto('/flito/ruta');
    await agregarManual(page, 'ZZD404');
    await page.getByLabel('N.º de licencia de tránsito (frente)').fill('100404');
    await page.getByLabel('N.º de sustrato (reverso)').fill('LT90000000404');
    await page.getByRole('button', { name: 'Agregar LT' }).click();

    const tarjeta = page.getByRole('article', { name: 'LT ZZD404' });
    await expect(tarjeta.getByText(MENSAJE_LT_NO_ENCONTRADA)).toBeVisible();
    await expect(tarjeta.getByText('Revisa los datos o quita esta LT.')).toBeVisible();
    await expect(tarjeta).not.toContainText('Compañía Que No Debe Verse');
    await tarjeta.getByRole('button', { name: 'Ver datos' }).click();
    await expect(tarjeta.getByText('VINDEMO0000000004')).toBeVisible();
    await expect(tarjeta.getByText('Propietario')).toHaveCount(0);
    await expect(tarjeta).not.toContainText('NO DEBE VERSE');
  });

  test('AC4: la hoja de trámites no ofrece dejar pendiente aunque tenga la función', async ({ page }) => {
    await entrar(page, [...FUN, 'logistica.documento.dejar_pendiente']);
    await mockRuta(page, []);
    const candidatos = ['1', '2'].map((n) => ({ tramiteId: `t-${n}`, idFlit: `FLIT-DEMO-${n}`, companiaNombre: 'Concesionario Demo Norte', organismoCodigo: '17001' }));
    await page.route(/\/api\/flito\/logistica\/consultar-vehiculo$/, (r) => r.fulfill(json({ encontrado: true, candidatos })));
    await page.route(/\/api\/flito\/logistica\/escanear$/, (r) => r.fulfill(json({ resultado: 'elegir_tramite', placa: 'ZZA101', vin: '', candidatos })));
    await page.goto('/flito/ruta');
    await agregarManual(page, 'ZZA101');
    await page.getByLabel('N.º de licencia de tránsito (frente)').fill('100381');
    await page.getByLabel('N.º de sustrato (reverso)').fill('LT90000000101');
    await page.getByRole('button', { name: 'Agregar LT' }).click();
    const hoja = page.getByTestId('hoja-tramite');
    await expect(hoja.getByText('Si no sabes cuál es, quita esta LT y consúltalo antes de seguir.')).toBeVisible();
    await expect(hoja.getByRole('button', { name: /dejar pendiente/ })).toHaveCount(0);
    await expect(hoja.getByRole('button', { name: /FLIT-DEMO-1/ })).toBeVisible();
  });
});

test.describe('AC7 · entrega del mensajero con mocks', () => {
  test('recibe el viaje a cliente, entrega con firma y vuelve a la lista', async ({ page }) => {
    await entrar(page);
    let entregado = false;
    await page.route(/\/api\/flito\/logistica\/mi-ruta/, (r) => r.fulfill(json({ entregas: entregado ? [] : [VIAJE_CLIENTE] })));
    await page.route(/\/api\/flito\/logistica\/actas\/acta-c\/entregar$/, (r) => { entregado = true; return r.fulfill(json({ ok: true })); });
    await page.goto('/flito/ruta');
    await page.getByRole('button', { name: 'Entregar' }).click();
    await page.getByLabel('Nombre de quien recibe').fill('Laura Demo');
    await page.getByLabel('Cédula de quien recibe').fill('1020304');
    await page.getByLabel(/Firma de quien recibe/).evaluate((el: HTMLCanvasElement) => {
      const r = el.getBoundingClientRect();
      const pe = (type: string, x: number, y: number) => el.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerId: 1 }));
      pe('pointerdown', 20, 20); pe('pointermove', 90, 60); pe('pointerup', 90, 60);
    });
    await page.getByRole('button', { name: 'Confirmar entrega' }).click();
    await expect(page.getByText('Entrega registrada.')).toBeVisible();
    await expect(page.getByText('No tienes viajes despachados para entregar.')).toBeVisible();
    expect(page.url()).not.toContain('1020304');
  });

  test('entregar con 404: aviso único y vuelve a la lista recargada', async ({ page }) => {
    await entrar(page);
    await mockRuta(page, [VIAJE_CLIENTE]);
    await page.route(/\/api\/flito\/logistica\/actas\/acta-c\/entregar$/, (r) => r.fulfill(json({ error: 'crudo interno' }, 404)));
    await page.goto('/flito/ruta');
    await page.getByRole('button', { name: 'Entregar' }).click();
    await page.getByLabel('Nombre de quien recibe').fill('Laura Demo');
    await page.getByLabel('Cédula de quien recibe').fill('1020304');
    await page.getByLabel(/Firma de quien recibe/).evaluate((el: HTMLCanvasElement) => {
      const r = el.getBoundingClientRect();
      const pe = (type: string, x: number, y: number) => el.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerId: 1 }));
      pe('pointerdown', 20, 20); pe('pointermove', 90, 60); pe('pointerup', 90, 60);
    });
    await page.getByRole('button', { name: 'Confirmar entrega' }).click();
    await expect(page.getByText('Este viaje ya no está en tu ruta. Revisa la lista actualizada.')).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Entregas/ })).toBeVisible();
    await expect(page.getByText('crudo interno')).toHaveCount(0);
  });
});
