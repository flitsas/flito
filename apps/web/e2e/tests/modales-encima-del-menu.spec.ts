import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';

// Los modales tienen que quedar POR ENCIMA de la barra de navegación.
//
// El fallo que esto vigila: el shell es un `display:flex` con la barra (`sticky`, z-20) y `<main>`
// como hijos. Los modales se renderizaban dentro de `<main>`, que por tanto es un ITEM FLEX — y la
// especificación de Flexbox dice que los items se pintan «igual que un inline-block», es decir de
// forma ATÓMICA. Nada de su interior puede subir por encima de un hermano flex con z-index
// positivo, ni siquiera un `position: fixed`, ni con el z-index que sea.
//
// Se comprobó en el navegador: con el overlay a z-index 9999 la barra seguía tapándolo. El síntoma
// era que, en cuanto un modal crecía, su cabecera quedaba debajo de la barra y el botón de cerrar
// se volvía invisible e inalcanzable — no había forma de cerrar la ventana con el ratón.
//
// La comprobación NO es «¿se ve el botón?» —`toBeVisible()` daba verde con el bug, porque el botón
// estaba pintado y con tamaño, solo que debajo de otra cosa— sino «¿qué elemento hay REALMENTE en
// ese punto de la pantalla?». Esa es la única pregunta que distingue tapado de no tapado.

/** ¿El elemento que hay en el centro del botón de cerrar es el propio botón? */
async function cerrarEstaAlcanzable(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"][aria-modal="true"]');
    if (!dlg) return { error: 'no hay modal abierto' };
    const cerrar = dlg.querySelector('[aria-label="Cerrar"]');
    if (!cerrar) return { error: 'el modal no tiene botón de cerrar' };
    const b = cerrar.getBoundingClientRect();
    const encima = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return {
      alcanzable: cerrar.contains(encima) || encima === cerrar,
      // Para que, si vuelve a fallar, el informe diga QUÉ lo tapa y no solo que falló.
      loQueHayEncima: encima ? encima.tagName.toLowerCase() + '.' + String(encima.className).split(' ')[0] : null,
      solapaConLaBarra: b.top < 112,
      colgadoDeBody: dlg.parentElement?.parentElement?.tagName === 'BODY',
    };
  });
}

test.describe('Modales por encima de la barra de navegación', () => {
  test('un modal que crece deja su botón de cerrar accesible, no debajo del menú', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await page.route(/\/api\/flito\/soat\/facetas/, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ companias: [], organismos: [], proveedores: [] }),
    }));
    await page.route(/\/api\/flito\/soat\?/, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        items: [{
          id: 's1', vin: 'VIN0000000000001', placa: 'ABC123', marca: 'Chevrolet', linea: 'Onix',
          estado: 'pagado', esMultiplePropietario: false, companiaNombre: 'Concesionario Norte',
          organismoNombre: 'STT Manizales', proveedorSoatId: 'p1', proveedorSoatNombre: 'Seguros Alfa',
          // Muchos copropietarios: es lo que hace crecer el modal hasta invadir la franja de la
          // barra. Se usa esto y no una función concreta de otra rama, para que la comprobación de
          // apilamiento no dependa de ninguna feature.
          compradores: Array.from({ length: 14 }, (_, i) => ({
            nombreCompleto: `Copropietario Número ${i + 1} De Prueba`,
            numeroDocumento: String(10101010 + i), orden: i, porcentajeParticipacion: null,
          })),
          tramitesFlit: ['FLIT-1001'],
          enviadoPorNombre: 'Operaciones E2E', enviadoEn: '2026-04-02T12:00:00Z',
          pagadoEn: '2026-04-05T12:00:00Z', valorPagado: 740800, estancado: false,
          motivoRechazo: null, creadoEn: '2026-04-01T12:00:00Z',
        }],
        total: 1, page: 1, pageSize: 50,
      }),
    }));
    await page.goto('/flito/soat');
    await page.getByRole('row').filter({ hasText: 'ABC123' }).getByRole('button', { name: 'Ver' }).click();
    await expect(page.getByText('Copropietario Número 14 De Prueba')).toBeVisible();

    const grande = await cerrarEstaAlcanzable(page);
    expect(grande).toMatchObject({ solapaConLaBarra: true }); // el modal SÍ invade la franja…
    expect(grande).toMatchObject({ alcanzable: true });        // …y aun así se puede cerrar.

    // Y se cierra de verdad con el ratón, que es lo que el usuario no podía hacer.
    await page.getByRole('button', { name: 'Cerrar' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('el visor de documentos a pantalla completa también se puede cerrar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await page.route(/\/api\/finanzas\/reporte-costos\/facetas/, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ estados: ['Aprobado'], empresas: [], tipos: [] }),
    }));
    await page.route(/\/api\/finanzas\/reporte-costos\?/, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        items: [{
          tramiteId: 'aaaa0000-0000-0000-0000-000000000001', idFlit: 'FLIT-2001', placa: 'ABC123',
          estado: 'Aprobado', empresa: 'ACME SAS', tipoTramite: 'Traspaso',
          vin: 'LRWYGCEK2TC771456', marca: null, linea: null,
          fechaAprobacion: '2026-07-14T15:30:00.000Z', fechaCreacion: '2026-07-02T10:00:00.000Z',
          soat: 450000, impuesto: 120000, derechoTramite: 80000, logistica: 15000,
          tramiteDigital: 200000, gmf: 3460, total: 868460,
          sellada: false, estadoLiquidacion: null, noConfigurados: [], sinRecibo: [],
        }],
        total: 1, page: 1, pageSize: 50,
        totales: { soat: 0, impuesto: 0, derechoTramite: 0, logistica: 0, tramiteDigital: 0, gmf: 0, total: 0, filasIncompletas: 0 },
      }),
    }));
    await page.route(/\/api\/finanzas\/tramites\/.*\/soportes/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/finanzas/reporte-costos');
    await page.getByRole('row').filter({ hasText: 'FLIT-2001' }).getByRole('button', { name: 'Soporte' }).click();
    await expect(page.getByText('Documentos de FLIT-2001')).toBeVisible();

    // `full` ocupa casi toda la pantalla: su cabecera cae justo en la franja de la barra.
    expect(await cerrarEstaAlcanzable(page)).toMatchObject({ alcanzable: true, colgadoDeBody: true });
    await page.getByRole('button', { name: 'Cerrar' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});
