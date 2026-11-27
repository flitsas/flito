import { test, expect, type Page } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';

// Épica #14707 (ADR-0049): un trámite anulado, abortado o revocado en FLIT no existe en FLITO para operar.
// Sobre el layout nuevo de Gestión Trámites (bloque 4): chip Anulado/Revocado, casilla deshabilitada con el
// motivo, sin acciones, «Descartado» en tenue, «Seleccionar todos» que lo salta, 409 → toast + refresco y el
// chip que abre el detalle en Historial. Y el aviso de retiros de la cola SOAT (UX 14707 §5). API mockeada.

const base = {
  asignado: true, tipoTramite: 'Traspaso', ciudad: 'Pereira', fechaCreacion: null, fechaAprobacion: null, derechoTramiteValor: null,
  empresaExiste: true, empresaNit: '900111', secretariaEmparejada: true, transitoNombre: 'STT Pereira', facturaVentaFlitId: null,
  companiaNombre: 'Concesionario Norte', organismoNombre: 'STT Pereira', fuente: 'flit', compradorPrincipal: null, compradores: [],
  soatAutogestionado: false, impuestosAutogestionado: false, excepcionesAutogestion: [], listoParaEntregar: false,
  nombreGestor: null, correoGestor: null, logistica: null,
};
const concepto = (id: string, estado: string, valorPagado: number | null = null) => ({
  id, estado, valorPagado, proveedorSoatNombre: null, enviadoEn: null, pagadoEn: null, estancado: false, motivoRechazo: null,
  tieneFacturaVenta: false, coincidenciaFacturaVenta: null, valorLiquidado: null, marcadoPorDiferencia: false,
});
const TRAMITES = [
  { ...base, tramiteId: 'dddddddd-0000-0000-0000-000000000001', idFlit: '2026-000812', estado: 'Asignado', vigenciaTramite: 'vigente',
    vehiculo: { vin: 'VIN000000000000812', placa: 'KLM482', marca: 'Mazda', linea: '3', tipoVehiculo: 'Automóvil', tipoServicio: 'Particular' },
    soat: concepto('s1', 'pendiente'), impuesto: concepto('i1', 'pendiente') },
  { ...base, tramiteId: 'dddddddd-0000-0000-0000-000000000002', idFlit: '2026-000815', estado: 'Anulado', vigenciaTramite: 'abortado',
    vehiculo: { vin: 'VIN000000000000815', placa: 'RTX019', marca: 'Renault', linea: 'Logan', tipoVehiculo: 'Automóvil', tipoServicio: 'Particular' },
    soat: concepto('s2', 'descartado'), impuesto: concepto('i2', 'descartado'), listoParaEntregar: true },
  { ...base, tramiteId: 'dddddddd-0000-0000-0000-000000000003', idFlit: '2026-000790', estado: 'Anulado', vigenciaTramite: 'revocado',
    empresaExiste: false, vehiculo: { vin: 'VIN000000000000790', placa: 'JHU773', marca: 'Kia', linea: 'Picanto', tipoVehiculo: 'Automóvil', tipoServicio: 'Publico' },
    soat: concepto('s3', 'pagado', 512400), impuesto: concepto('i3', 'descartado') },
];

async function montarBandeja(page: Page, opts: { impuesto409?: boolean } = {}) {
  const gets: string[] = [];
  await page.route(/\/api\/flito\/tramites\/facetas/, (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ estados: ['Asignado', 'Anulado'], tramites: ['Traspaso'], ciudades: ['Pereira'], transitos: ['STT Pereira'] }) }));
  await page.route(/\/api\/flito\/tramites\?/, (route) => {
    gets.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: TRAMITES, total: TRAMITES.length, page: 1, pageSize: 50, marca: 'm1' }) });
  });
  await page.route(/\/api\/flito\/tramites\/[^/]+\/historial/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  // El detalle falla a propósito: el aviso del trámite muerto sale de la fila y se ve aunque el detalle no llegue.
  await page.route(/\/api\/flito\/tramites\/[^/]+\/detalle$/, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) }));
  if (opts.impuesto409) {
    await page.route(/\/api\/flito\/tramites\/solicitar-impuestos$/, (route) => route.fulfill({ status: 409, contentType: 'application/json',
      body: JSON.stringify({ error: 'El trámite 2026-000812 fue anulado en FLIT: en FLITO ya no admite acciones.', code: 'TRAMITE_NO_VIGENTE', vigencia: 'anulado' }) }));
  }
  await loginAs(page, OPERACIONES_USER);
  await page.goto('/flito/tramites');
  await expect(page.getByText('2026-000815')).toBeVisible();
  return { gets };
}

const fila = (page: Page, idFlit: string) => page.getByRole('row').filter({ hasText: idFlit });

test.describe('Épica #14707 — trámite muerto en Gestión Trámites (layout del bloque 4)', () => {
  test('fila anulada (abortado) y revocada: chip, casilla deshabilitada con motivo, sin acciones y «Descartado»', async ({ page }) => {
    await montarBandeja(page);

    const anulada = fila(page, '2026-000815');
    // Abortado se lee «Anulado» (el estado literal queda en el historial).
    await expect(anulada.getByText('Anulado', { exact: true })).toBeVisible();
    const casillaA = anulada.getByRole('checkbox');
    await expect(casillaA).toBeDisabled();
    await expect(casillaA).toHaveAccessibleName('No se puede seleccionar RTX019: el trámite está anulado en FLIT');
    await expect(anulada.getByRole('button', { name: /^Solicitar/ })).toHaveCount(0);
    await expect(anulada.getByText('Listo para entregar')).toHaveCount(0);
    await expect(anulada.getByText('Descartado', { exact: true })).toHaveCount(2);
    // La consulta sigue: soportes y el ID como enlace al detalle.
    await expect(anulada.getByRole('button', { name: 'Ver soportes' })).toBeVisible();
    await expect(anulada.getByRole('button', { name: 'Ver el detalle del trámite 2026-000815' })).toBeVisible();

    const revocada = fila(page, '2026-000790');
    await expect(revocada.getByText('Revocado', { exact: true })).toBeVisible();
    await expect(revocada.getByRole('checkbox')).toHaveAccessibleName('No se puede seleccionar JHU773: el trámite está revocado en FLIT');
    // El SOAT pagado de un revocado queda como histórico (chip de solo lectura); el impuesto, descartado.
    await expect(revocada.getByText('Pagado', { exact: true })).toBeVisible();
    await expect(revocada.getByText('Descartado', { exact: true })).toHaveCount(1);
    // Sin «Crear empresa» aunque la empresa no exista: el trámite no se opera.
    await expect(revocada.getByRole('button', { name: 'Crear empresa' })).toHaveCount(0);
    // Servicio público en texto (la placa no es la única señal).
    await expect(revocada.getByText(/Público/)).toBeVisible();

    const viva = fila(page, '2026-000812');
    await expect(viva.getByRole('checkbox')).toBeEnabled();
    await expect(viva.getByRole('button', { name: 'Solicitar SOAT de KLM482' })).toBeVisible();
    await expect(viva.getByRole('button', { name: 'Solicitar impuesto de KLM482' })).toBeVisible();
  });

  test('«Seleccionar las filas de esta página» salta las muertas y su conteo no las incluye', async ({ page }) => {
    await montarBandeja(page);
    await page.getByLabel('Seleccionar las filas de esta página').check();
    await expect(page.getByText('1 seleccionado', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Entregar (1)', exact: true })).toBeVisible();
    // La barra cambia de modo en el mismo sitio: sin «Columnas» ni «Orden» mientras hay selección.
    await expect(page.getByRole('button', { name: /^Columnas/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Limpiar selección' })).toBeVisible();
  });

  test('409 TRAMITE_NO_VIGENTE desde la fila: toast cerrable con el copy de 14707 (sin el crudo) y la tabla se refresca', async ({ page }) => {
    const { gets } = await montarBandeja(page, { impuesto409: true });
    const antes = gets.length;
    await fila(page, '2026-000812').getByRole('button', { name: 'Solicitar impuesto de KLM482' }).click();
    await expect(page.getByText('No se pudo solicitar el impuesto: el trámite 2026-000812 se anuló o se revocó en FLIT. La tabla ya se actualizó.')).toBeVisible();
    await expect(page.getByText(/ya no admite acciones/)).toHaveCount(0);
    await expect(page.getByText('TRAMITE_NO_VIGENTE')).toHaveCount(0);
    await expect.poll(() => gets.length).toBeGreaterThan(antes);
    await page.getByRole('button', { name: 'Cerrar aviso' }).click();
    await expect(page.getByText(/La tabla ya se actualizó/)).toHaveCount(0);
  });

  test('el chip de estado abre el detalle en la sección Historial (también en un muerto)', async ({ page }) => {
    await montarBandeja(page);
    await fila(page, '2026-000815').getByTitle('Ver historial del trámite').click();
    const dialogo = page.getByRole('dialog');
    await expect(dialogo).toBeVisible();
    await expect(dialogo.getByRole('alert').filter({ hasText: 'Trámite anulado en FLIT' })).toBeVisible();
    await expect(dialogo.getByRole('navigation', { name: 'Secciones del trámite' }).getByRole('button', { name: 'Historial' }))
      .toHaveAttribute('aria-current', 'true');
  });
});

test.describe('Épica #14707 — aviso de retiros en la cola SOAT', () => {
  const AVISOS = [
    { id: 'aaaaaaaa-1111-0000-0000-000000000001', tipo: 'solicitud_retirada', concepto: 'soat', motivo: 'anulado', idFlit: '2026-000815', placa: 'RTX019', creadoEn: '2026-11-24T15:00:00Z', vistoEn: null },
    { id: 'aaaaaaaa-1111-0000-0000-000000000002', tipo: 'solicitud_retirada', concepto: 'soat', motivo: 'revocado', idFlit: '2026-000790', placa: 'JHU773', creadoEn: '2026-11-24T14:00:00Z', vistoEn: null },
    { id: 'aaaaaaaa-1111-0000-0000-000000000003', tipo: 'solicitud_retirada', concepto: 'impuesto', motivo: 'abortado', idFlit: '2026-000801', placa: 'PQA310', creadoEn: '2026-11-23T14:00:00Z', vistoEn: null },
  ];

  async function montarCola(page: Page, avisos: 'ok' | 'error', visto: 'ok' | 'error' = 'ok') {
    const vistos: unknown[] = [];
    await page.route(/\/api\/flito\/soat\/facetas/, (route) => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ companias: [], organismos: [], proveedores: [] }) }));
    await page.route(/\/api\/flito\/soat\?/, (route) => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: [], total: 0, page: 1, pageSize: 50 }) }));
    await page.route(/\/api\/flito\/avisos$/, (route) => (avisos === 'ok'
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ avisos: AVISOS, noVistos: AVISOS.length }) })
      : route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) })));
    await page.route(/\/api\/flito\/avisos\/visto$/, (route) => {
      vistos.push(route.request().postDataJSON());
      return visto === 'ok'
        ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ marcados: 2 }) })
        : route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) });
    });
    await loginAs(page, OPERACIONES_USER);
    await page.goto('/flito/soat');
    return { vistos };
  }

  test('lleno: solo los SOAT del usuario, con placa, ID FLIT, motivo y fecha; «Entendido» marca esos ids y lleva el foco al título', async ({ page }) => {
    const { vistos } = await montarCola(page, 'ok');
    const aviso = page.getByTestId('avisos-soat');
    await expect(aviso.getByText('Se retiraron 2 SOAT que solicitaste')).toBeVisible();
    await expect(aviso.getByText('2026-000815')).toBeVisible();
    await expect(aviso.getByText('Trámite revocado en FLIT')).toBeVisible();
    // El impuesto retirado no sale en la cola SOAT.
    await expect(aviso.getByText('2026-000801')).toHaveCount(0);
    await aviso.getByRole('button', { name: 'Entendido, ocultar el aviso de SOAT retirados' }).click();
    await expect.poll(() => vistos.length).toBe(1);
    expect(vistos[0]).toEqual({ ids: [AVISOS[0].id, AVISOS[1].id] });
    await expect(page.getByTestId('avisos-soat')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'SOAT', exact: true })).toBeFocused();
  });

  test('«Entendido» que falla: toast cerrable y el aviso se queda', async ({ page }) => {
    await montarCola(page, 'ok', 'error');
    await page.getByRole('button', { name: 'Entendido, ocultar el aviso de SOAT retirados' }).click();
    await expect(page.getByText('No se pudo ocultar el aviso. Intenta de nuevo.')).toBeVisible();
    await expect(page.getByTestId('avisos-soat')).toBeVisible();
  });

  test('error al revisar los avisos: una línea discreta con Reintentar y la cola sigue usable', async ({ page }) => {
    await montarCola(page, 'error');
    const linea = page.getByTestId('avisos-soat-error');
    await expect(linea).toHaveText(/No pudimos revisar si se retiró algún SOAT que solicitaste\./);
    await expect(linea.getByRole('button', { name: 'Reintentar' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'SOAT', exact: true })).toBeVisible();
  });
});
