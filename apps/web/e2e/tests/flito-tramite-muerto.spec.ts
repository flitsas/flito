import { test, expect, type Page } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, CLIENTE_CON_CANAL } from '../helpers/auth';

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

  async function montarCola(page: Page, avisos: 'ok' | 'error', visto: 'ok' | 'error' = 'ok', lista: unknown[] = AVISOS) {
    const vistos: unknown[] = [];
    await page.route(/\/api\/flito\/soat\/facetas/, (route) => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ companias: [], organismos: [], proveedores: [] }) }));
    await page.route(/\/api\/flito\/soat\?/, (route) => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: [], total: 0, page: 1, pageSize: 50 }) }));
    await page.route(/\/api\/flito\/avisos$/, (route) => (avisos === 'ok'
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ avisos: lista, noVistos: lista.length }) })
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

  test('más de 5: se ven 5 y «Ver los N»; «Entendido» marca vistos TODOS, también los plegados', async ({ page }) => {
    const muchos = Array.from({ length: 7 }, (_, i) => ({
      id: `bbbbbbbb-2222-0000-0000-00000000000${i + 1}`, tipo: 'solicitud_retirada', concepto: 'soat', motivo: 'anulado',
      idFlit: `2026-00090${i + 1}`, placa: `PLA10${i + 1}`, creadoEn: `2026-11-2${i}T15:00:00Z`, vistoEn: null,
    }));
    const { vistos } = await montarCola(page, 'ok', 'ok', muchos);
    const aviso = page.getByTestId('avisos-soat');
    await expect(aviso.getByText('Se retiraron 7 SOAT que solicitaste')).toBeVisible();
    await expect(aviso.getByRole('listitem')).toHaveCount(5);
    await expect(aviso.getByText('2026-000906')).toHaveCount(0);
    const verTodos = aviso.getByRole('button', { name: 'Ver los 7' });
    await expect(verTodos).toHaveAttribute('aria-expanded', 'false');
    // Sin desplegar: el visto lleva los 7 ids, no solo los 5 pintados.
    await aviso.getByRole('button', { name: 'Entendido, ocultar el aviso de SOAT retirados' }).click();
    await expect.poll(() => vistos.length).toBe(1);
    expect(vistos[0]).toEqual({ ids: muchos.map((a) => a.id) });
  });

  test('«Ver los N» despliega el resto y «Ver menos» lo vuelve a plegar', async ({ page }) => {
    const muchos = Array.from({ length: 6 }, (_, i) => ({
      id: `cccccccc-3333-0000-0000-00000000000${i + 1}`, tipo: 'solicitud_retirada', concepto: 'soat', motivo: 'revocado',
      idFlit: `2026-00070${i + 1}`, placa: `REV20${i + 1}`, creadoEn: `2026-11-2${i}T15:00:00Z`, vistoEn: null,
    }));
    await montarCola(page, 'ok', 'ok', muchos);
    const aviso = page.getByTestId('avisos-soat');
    await aviso.getByRole('button', { name: 'Ver los 6' }).click();
    await expect(aviso.getByRole('listitem')).toHaveCount(6);
    await expect(aviso.getByText('2026-000706')).toBeVisible();
    await expect(aviso.getByRole('button', { name: 'Ver menos' })).toHaveAttribute('aria-expanded', 'true');
    await aviso.getByRole('button', { name: 'Ver menos' }).click();
    await expect(aviso.getByRole('listitem')).toHaveCount(5);
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

// ── Retrabajo PR B (QA B): 409 en las colas, lote parcial/total, aviso de Impuestos y del Cliente, Logística ──

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
/** El 409 que devuelve el API cuando un trámite murió en FLIT: lo lee `errorDeRespuesta` por `code`. */
const NO_VIGENTE_409 = json({ error: 'El trámite 2026-000812 fue anulado en FLIT: en FLITO ya no admite acciones.', code: 'TRAMITE_NO_VIGENTE', vigencia: 'anulado' }, 409);
const AVISOS_MIXTOS = [
  { id: 'aaaaaaaa-1111-0000-0000-000000000001', tipo: 'solicitud_retirada', concepto: 'soat', motivo: 'anulado', idFlit: '2026-000815', placa: 'RTX019', creadoEn: '2026-11-24T15:00:00Z', vistoEn: null },
  { id: 'aaaaaaaa-1111-0000-0000-000000000002', tipo: 'solicitud_retirada', concepto: 'soat', motivo: 'revocado', idFlit: '2026-000790', placa: 'JHU773', creadoEn: '2026-11-24T14:00:00Z', vistoEn: null },
  { id: 'aaaaaaaa-1111-0000-0000-000000000003', tipo: 'solicitud_retirada', concepto: 'impuesto', motivo: 'abortado', idFlit: '2026-000801', placa: 'PQA310', creadoEn: '2026-11-23T14:00:00Z', vistoEn: null },
];

const SOAT_PENDIENTE = {
  id: 's1', vin: 'VIN0000000000001', placa: 'ABC123', marca: 'Chevrolet', linea: 'Onix', cilindraje: '1598', carroceria: 'SEDAN',
  tipoServicio: 'Particular', estado: 'pendiente', esMultiplePropietario: false, companiaNombre: 'Concesionario Norte',
  organismoNombre: 'STT Manizales', proveedorSoatId: null, proveedorSoatNombre: null,
  compradores: [{ nombreCompleto: 'Ana Pérez', numeroDocumento: '10101010', tipoDocumento: 'CC', orden: 0, porcentajeParticipacion: null }],
  tramitesFlit: ['2026-000812'], tipoTramite: 'Matricula', fechaAprobacion: null, fechaCreacion: '2026-03-28T10:00:00Z',
  enviadoPorNombre: null, enviadoEn: null, pagadoEn: null, valorPagado: null, estancado: false, motivoRechazo: null,
  creadoEn: '2026-04-01T12:00:00Z', gestionOperaciones: false, vigenciaTramite: 'vigente',
};
const IMPUESTO_PENDIENTE = {
  id: 'i1', tramiteId: 't1', idFlit: '2026-000812', placa: 'ABC123', vin: 'VIN0000000000001',
  estado: 'pendiente', compradorNombre: 'Ana Pérez', compradorDocumento: '10101010', compradorTipoDocumento: 'CC',
  companiaNombre: 'Concesionario Norte', organismoCodigo: 'STT-MZL', organismoNombre: 'STT Manizales',
  valorLiquidado: 120000, valorPagado: null, marcadoPorDiferencia: false, tieneFacturaVenta: true,
  enviadoPorNombre: null, enviadoEn: null, estancado: false, motivoRechazo: null, creadoEn: '2026-04-01T12:00:00Z',
  gestionOperaciones: false, liquidadoEn: null, documentos: null, vigenciaTramite: 'vigente',
};

async function montarColaSoat(page: Page, opts: { avisos?: unknown[]; enviar409?: boolean } = {}) {
  const gets: string[] = [];
  const vistos: unknown[] = [];
  await page.route(/\/api\/flito\/parametrizacion\/proveedores\/selector\?servicio=soat$/, (r) => r.fulfill(json([])));
  await page.route(/\/api\/flito\/soat\/facetas/, (r) => r.fulfill(json({ companias: [], organismos: [], proveedores: [] })));
  await page.route(/\/api\/flito\/soat\?/, (r) => { gets.push(r.request().url()); return r.fulfill(json({ items: [SOAT_PENDIENTE], total: 1, page: 1, pageSize: 50 })); });
  await page.route(/\/api\/flito\/avisos$/, (r) => r.fulfill(json({ avisos: opts.avisos ?? [], noVistos: (opts.avisos ?? []).length })));
  await page.route(/\/api\/flito\/avisos\/visto$/, (r) => { vistos.push(r.request().postDataJSON()); return r.fulfill(json({ marcados: 1 })); });
  if (opts.enviar409) await page.route(/\/api\/flito\/soat\/enviar$/, (r) => r.fulfill(NO_VIGENTE_409));
  return { gets, vistos };
}

async function montarColaImpuestos(page: Page, opts: { avisos?: unknown[]; enviar409?: boolean } = {}) {
  const gets: string[] = [];
  const vistos: unknown[] = [];
  await page.route(/\/api\/flito\/impuestos\/facetas/, (r) => r.fulfill(json({ companias: [], organismos: [] })));
  await page.route(/\/api\/flito\/impuestos\?/, (r) => { gets.push(r.request().url()); return r.fulfill(json({ items: [IMPUESTO_PENDIENTE], total: 1, page: 1, pageSize: 50 })); });
  await page.route(/\/api\/flito\/avisos$/, (r) => r.fulfill(json({ avisos: opts.avisos ?? [], noVistos: (opts.avisos ?? []).length })));
  await page.route(/\/api\/flito\/avisos\/visto$/, (r) => { vistos.push(r.request().postDataJSON()); return r.fulfill(json({ marcados: 1 })); });
  if (opts.enviar409) await page.route(/\/api\/flito\/impuestos\/enviar$/, (r) => r.fulfill(NO_VIGENTE_409));
  return { gets, vistos };
}

test.describe('Épica #14707 — 409 TRAMITE_NO_VIGENTE en las colas SOAT e Impuestos (§6)', () => {
  test('cola SOAT: enviar una fila retirada → toast cerrable con el copy de la cola, sin el crudo, y la cola se vuelve a pedir', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { gets } = await montarColaSoat(page, { enviar409: true });
    await page.goto('/flito/soat');
    await page.getByLabel('Seleccionar ABC123').check();
    await page.getByLabel('Enviar a').selectOption({ label: 'Gestionado por Operaciones' });
    const antes = gets.length;
    await page.getByRole('button', { name: 'Enviar a Operaciones (1)' }).click();
    await expect(page.getByText('Este SOAT ya no está en la cola: su trámite se anuló o se revocó en FLIT. La lista ya se actualizó.')).toBeVisible();
    await expect(page.getByText(/ya no admite acciones/)).toHaveCount(0);
    await expect(page.getByText('TRAMITE_NO_VIGENTE')).toHaveCount(0);
    await expect.poll(() => gets.length).toBeGreaterThan(antes);
    // La selección se vacía: no queda una barra de envío sobre una fila que ya no está.
    await expect(page.getByLabel('Seleccionar ABC123')).not.toBeChecked();
    await page.getByRole('button', { name: 'Cerrar aviso' }).click();
    await expect(page.getByText(/La lista ya se actualizó/)).toHaveCount(0);
  });

  test('cola Impuestos: enviar al gestor una fila retirada → toast con el copy de la cola, sin el crudo ni la tarjeta de error, y refresco', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { gets } = await montarColaImpuestos(page, { enviar409: true });
    await page.goto('/flito/impuestos');
    await page.getByLabel('Seleccionar ABC123').check();
    const antes = gets.length;
    await page.getByRole('button', { name: /Enviar al gestor/ }).click();
    await expect(page.getByText('Este impuesto ya no está en la cola: su trámite se anuló o se revocó en FLIT. La lista ya se actualizó.')).toBeVisible();
    await expect(page.getByText(/ya no admite acciones/)).toHaveCount(0);
    await expect(page.getByText('TRAMITE_NO_VIGENTE')).toHaveCount(0);
    await expect.poll(() => gets.length).toBeGreaterThan(antes);
    await page.getByRole('button', { name: 'Cerrar aviso' }).click();
    await expect(page.getByText(/La lista ya se actualizó/)).toHaveCount(0);
  });
});

test.describe('Épica #14707 — aviso de retiros en Impuestos y en el canal Cliente (§5, §13.10)', () => {
  test('cola Impuestos: solo los retiros de impuesto, en tuteo; «Entendido» marca solo su id', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { vistos } = await montarColaImpuestos(page, { avisos: AVISOS_MIXTOS });
    await page.goto('/flito/impuestos');
    const aviso = page.getByTestId('avisos-impuesto');
    await expect(aviso.getByText('Se retiró 1 impuesto que solicitaste')).toBeVisible();
    await expect(aviso.getByText('Su trámite se anuló en FLIT: ya no se tramita y salió de la cola. No tienes que hacer nada más.')).toBeVisible();
    await expect(aviso.getByText('2026-000801')).toBeVisible();
    // Los SOAT retirados no salen en la cola de Impuestos.
    await expect(aviso.getByText('2026-000815')).toHaveCount(0);
    await expect(aviso.getByText('2026-000790')).toHaveCount(0);
    await expect(page.getByTestId('avisos-soat')).toHaveCount(0);
    await aviso.getByRole('button', { name: 'Entendido, ocultar el aviso de impuestos retirados' }).click();
    await expect.poll(() => vistos.length).toBe(1);
    expect(vistos[0]).toEqual({ ids: [AVISOS_MIXTOS[2].id] });
    await expect(page.getByTestId('avisos-impuesto')).toHaveCount(0);
  });

  test('cola SOAT del Cliente: el aviso va en usted (título, texto y botón)', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await montarColaSoat(page, { avisos: AVISOS_MIXTOS });
    await page.goto('/flito/soat');
    const aviso = page.getByTestId('avisos-soat');
    await expect(aviso.getByText('Se retiraron 2 SOAT que usted solicitó')).toBeVisible();
    await expect(aviso.getByText('Sus trámites se anularon o se revocaron en FLIT: ya no se tramitan y salieron de esta lista. No tiene que hacer nada más.')).toBeVisible();
    await expect(aviso.getByText(/solicitaste|No tienes/)).toHaveCount(0);
    await expect(aviso.getByRole('button', { name: 'Entendido', exact: true })).toBeVisible();
  });
});

const TRAMITES_LOTE = [
  TRAMITES[0],
  { ...TRAMITES[0], tramiteId: 'dddddddd-0000-0000-0000-000000000004', idFlit: '2026-000820',
    vehiculo: { ...TRAMITES[0].vehiculo, vin: 'VIN000000000000820', placa: 'NOP120' }, soat: concepto('s4', 'pendiente'), impuesto: concepto('i4', 'pendiente') },
  TRAMITES[1],
];

async function montarLote(page: Page) {
  const gets: string[] = [];
  await page.route(/\/api\/flito\/tramites\/facetas/, (r) => r.fulfill(json({ estados: ['Asignado', 'Anulado'], tramites: ['Traspaso'], ciudades: ['Pereira'], transitos: ['STT Pereira'] })));
  await page.route(/\/api\/flito\/tramites\?/, (r) => { gets.push(r.request().url()); return r.fulfill(json({ items: TRAMITES_LOTE, total: TRAMITES_LOTE.length, page: 1, pageSize: 50, marca: 'm1' })); });
  await loginAs(page, OPERACIONES_USER);
  await page.goto('/flito/tramites');
  await expect(page.getByText('2026-000820')).toBeVisible();
  await page.getByLabel('Seleccionar las filas de esta página').check();
  await expect(page.getByText('2 seleccionados', { exact: true })).toBeVisible();
  return { gets };
}

test.describe('Épica #14707 — lote de la bandeja con trámites muertos (§6, §13.5)', () => {
  test('impuestos en lote parcial: el resultado dice cuántos no se enviaron porque su trámite murió', async ({ page }) => {
    await page.route(/\/api\/flito\/tramites\/solicitar-impuestos$/, (r) => r.fulfill(json({ enviados: 1, yaEnviados: 0, noEnviables: 0, noVigentes: 1 })));
    await montarLote(page);
    await page.getByRole('button', { name: 'Solicitar Impuestos (2)', exact: true }).click();
    const dialogo = page.getByRole('dialog');
    await expect(dialogo).toBeVisible();
    await expect(dialogo.getByText('1 no se enviaron porque su trámite se anuló o se revocó en FLIT.')).toBeVisible();
  });

  test('entrega en lote parcial: «no se entregaron» con el conteo de los no vigentes', async ({ page }) => {
    await page.route(/\/api\/flito\/tramites\/entregar$/, (r) => r.fulfill(json({ entregados: 1, noVigentes: 1, noHabilitados: [] })));
    await montarLote(page);
    await page.getByRole('button', { name: 'Entregar (2)', exact: true }).click();
    const dialogo = page.getByRole('dialog');
    await expect(dialogo.getByRole('heading', { name: /Resultado de la entrega/i })).toBeVisible();
    await expect(dialogo.getByText(/1 trámite\(s\) entregado/)).toBeVisible();
    await expect(dialogo.getByText('1 no se entregaron porque su trámite se anuló o se revocó en FLIT.')).toBeVisible();
  });

  test('lote sin no vigentes: el resultado no menciona FLIT', async ({ page }) => {
    await page.route(/\/api\/flito\/tramites\/entregar$/, (r) => r.fulfill(json({ entregados: 2, noVigentes: 0, noHabilitados: [] })));
    await montarLote(page);
    await page.getByRole('button', { name: 'Entregar (2)', exact: true }).click();
    const dialogo = page.getByRole('dialog');
    await expect(dialogo.getByText(/2 trámite\(s\) entregado/)).toBeVisible();
    await expect(dialogo.getByText(/se anuló o se revocó en FLIT/)).toHaveCount(0);
  });

  test('rechazo total del lote (409): «No se envió nada: …», sin el crudo, y la tabla se refresca', async ({ page }) => {
    await page.route(/\/api\/flito\/tramites\/entregar$/, (r) => r.fulfill(NO_VIGENTE_409));
    const { gets } = await montarLote(page);
    const antes = gets.length;
    await page.getByRole('button', { name: 'Entregar (2)', exact: true }).click();
    await expect(page.getByText('No se envió nada: los trámites seleccionados se anularon o se revocaron en FLIT. La tabla ya se actualizó.')).toBeVisible();
    await expect(page.getByText(/ya no admite acciones/)).toHaveCount(0);
    await expect(page.getByText('TRAMITE_NO_VIGENTE')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => gets.length).toBeGreaterThan(antes);
  });
});

test.describe('Épica #14707 — Logística: trámite muerto como histórico (D8)', () => {
  const FILA = {
    tramiteId: 'tr-2', idFlit: 'FLIT-2002', placa: 'XYZ789', vin: 'VIN0000000000002', propietario: 'Ana Ruiz',
    companiaId: 5, companiaNombre: 'Concesionario Norte', companiaNit: '900111', organismoCodigo: '05001', organismoNombre: 'STT Medellín',
    docId: 'doc-2', estado: 'recogido', estadoLabel: 'Recogido', estadoSimple: 'registrada', estadoSimpleLabel: 'Registrada',
    numeroLicencia: '100381', numeroLt: 'LT-77', actaId: null, motivo: null, actualizadoEn: '2026-07-20T11:00:00Z', vigenciaTramite: 'vigente',
  };
  const REVOCADA = { ...FILA, tramiteId: 'tr-3', idFlit: 'FLIT-2003', placa: 'REV333', vin: 'VIN0000000000003', docId: 'doc-3', vigenciaTramite: 'revocado' };

  test('la fila revocada lleva el chip «Revocado» y no ofrece «Novedad»; la vigente sí', async ({ page }) => {
    await page.route(/\/api\/flito\/logistica\/facetas/, (r) => r.fulfill(json({
      estados: ['pendiente', 'registrada'], empresas: [], organismos: [], companiasCerrables: [], mensajeros: [] })));
    await page.route(/\/api\/flito\/logistica\/actas$/, (r) => r.fulfill(json([])));
    await page.route(/\/api\/flito\/logistica\/buscar$/, (r) => r.fulfill(json({ items: [FILA, REVOCADA], total: 2, page: 1, pageSize: 50 })));
    await loginAs(page, OPERACIONES_USER);
    await page.goto('/flito/logistica');
    const viva = page.getByRole('row', { name: /XYZ789/ });
    const muerta = page.getByRole('row', { name: /REV333/ });
    await expect(viva.getByRole('button', { name: 'Novedad de XYZ789' })).toBeVisible();
    await expect(viva.getByText('Revocado', { exact: true })).toHaveCount(0);
    await expect(muerta.getByText('Revocado', { exact: true })).toBeVisible();
    await expect(muerta.getByRole('button', { name: 'Novedad de REV333' })).toHaveCount(0);
    // La consulta sigue: el detalle del histórico se abre.
    await expect(muerta.getByRole('button', { name: 'Detalle de REV333' })).toBeVisible();
  });
});
