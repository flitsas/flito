import { test, expect, type Page, type Route } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, funcionesDe, type UsuarioFixture } from '../helpers/auth';

// FLITO — Gestión Trámites: detalle del trámite en modal (ADR-0046, Épica #14560). API mockeado:
// lista paginada (2 filas en la página 1 y 1 en la 2), detalle por id, historial, soportes y ZIP.

const ID = (n: number) => `cccccccc-0000-0000-0000-00000000000${n}`;
const filaDe = (n: number, vigencia: 'vigente' | 'anulado' | 'revocado' = 'vigente') => ({
  tramiteId: ID(n), idFlit: `FLIT-40${n}`, estado: 'Asignado', asignado: true,
  fuente: n === 2 ? 'flit2' : 'flit', tipoTramite: 'Matricula', ciudad: 'Manizales', fechaCreacion: null, fechaAprobacion: null,
  derechoTramiteValor: null, empresaExiste: true, empresaNit: '900111', secretariaEmparejada: true,
  transitoNombre: 'STT Manizales', facturaVentaFlitId: null, companiaNombre: 'Concesionario Norte',
  organismoNombre: 'STT Manizales', vehiculo: { vin: `VIN00000000000${n}`, placa: `PLC00${n}`, marca: 'Mazda', linea: '2', tipoVehiculo: null, tipoServicio: n === 2 ? 'Público' : 'Particular' },
  compradorPrincipal: null, compradores: [], soat: null, soatAutogestionado: false, impuesto: null,
  impuestosAutogestionado: false, excepcionesAutogestion: [], vigenciaTramite: vigencia, listoParaEntregar: false, sincronizadoEn: '2026-11-18T10:00:00.000Z',
});

const detalleDe = (n: number, vigencia: 'vigente' | 'anulado' | 'revocado' = 'vigente') => ({
  id: ID(n), idFlit: `FLIT-40${n}`, vigenciaTramite: vigencia,
  resumen: {
    estado: 'Asignado', asignado: true, tipoTramite: 'Matricula', fuente: n === 2 ? 'flit2' : 'flit',
    creado: '2026-11-01T10:00:00.000Z', aprobado: null, ciudad: 'Manizales', pendientes: ['soat'],
    listoParaEntregar: false, semaforo: 'amarillo', logisticaEstado: null, sincronizadoEn: '2026-11-18T10:00:00.000Z',
  },
  vehiculo: { placa: `PLC00${n}`, vin: `VIN00000000000${n}`, marca: 'Mazda', linea: null, clase: 'Automóvil' },
  propietarios: [{
    nombreCompleto: `Propietaria Uno ${n}`, tipoDocumento: 'CC', numeroDocumento: '1010', correo: 'p@ejemplo.co',
    celular: '3000000000', direccion: 'Calle 1', orden: 1, porcentajeParticipacion: null,
  }],
  gestora: { nombre: 'Concesionario Norte', nit: '900111', existe: true, nombrePersona: 'Laura Gestora', correoPersona: 'laura.gestora@demo.test' },
  costos: {
    conceptos: [
      { concepto: 'soat', quienCobra: 'Aseguradora Sur', autogestionado: false, estado: 'pagado', valor: 500000, valorLiquidado: null },
      { concepto: 'impuesto', quienCobra: 'STT Manizales', autogestionado: false, estado: null, valor: null, valorLiquidado: null },
      { concepto: 'derecho_transito', quienCobra: null, autogestionado: true, estado: null, valor: null, valorLiquidado: null },
    ],
    tieneFacturaVenta: true, total: 500000,
  },
});

const json = (route: Route, status: number, body?: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: body === undefined ? '' : JSON.stringify(body) });

const conFunciones = (extra: string[], quitar: string[] = []): UsuarioFixture => ({
  ...OPERACIONES_USER,
  funciones: [...new Set([...funcionesDe(OPERACIONES_USER), ...extra])].filter((f) => !quitar.includes(f)),
});
const BASE = ['tramites.solicitud.pedir_soat', 'tramites.tramite.ver_historial', 'tramites.tramite.ver_soportes'];

async function montar(page: Page, opts: { usuario?: UsuarioFixture; fallaHistorial?: boolean; vigencia?: 'anulado' | 'revocado' } = {}) {
  const zips: unknown[] = [];
  await page.route(/\/api\/flito\/tramites\/facetas/, (route) => json(route, 200,
    { estados: ['Asignado'], tramites: ['Matricula'], ciudades: ['Manizales'], transitos: ['STT Manizales'] }));
  await page.route(/\/api\/flito\/vistas-columnas\//, (route) => json(route, 500, { error: 'sin vistas' }));
  await page.route(/\/api\/flito\/tramites\?/, (route) => {
    const p = Number(new URL(route.request().url()).searchParams.get('page') ?? '1');
    return json(route, 200, p === 2
      ? { items: [filaDe(3)], total: 51, page: 2, pageSize: 50, marca: 'm' }
      : { items: [filaDe(1, opts.vigencia), filaDe(2)], total: 51, page: 1, pageSize: 50, marca: 'm' });
  });
  await page.route(/\/api\/flito\/tramites\/[^/]+\/detalle/, (route) => {
    const n = Number(route.request().url().match(/0000000(\d)\/detalle/)?.[1]);
    return json(route, 200, detalleDe(n, n === 1 ? opts.vigencia : undefined));
  });
  await page.route(/\/api\/flito\/tramites\/[^/]+\/historial/, (route) => (opts.fallaHistorial
    ? json(route, 500, { error: 'detalle interno' })
    : json(route, 200, [{ id: 'h1', campo: 'estado', valorAnterior: 'Aprobado', valorNuevo: 'Asignado', origen: 'api', usuarioNombre: null, creadoEn: '2026-11-02T10:00:00.000Z' }])));
  await page.route(/\/api\/flito\/tramites\/[^/]+\/soportes$/, (route) => json(route, 200, [
    { id: 's1', origen: 'soat', tipo: 'factura_soat', nombreArchivo: 'poliza.pdf', url: '/x', subidoEn: '2026-11-03T10:00:00.000Z' },
  ]));
  await page.route(/\/api\/flito\/tramites\/soportes\/zip/, (route) => {
    zips.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: 'application/zip', body: 'PK',
      headers: { 'content-disposition': 'attachment; filename="FLIT-401-DOCS.zip"' } });
  });
  await loginAs(page, opts.usuario ?? conFunciones(BASE, ['tramites.soportes.descargar']));
  await page.goto('/flito/tramites');
  await expect(page.getByText('FLIT-401').first()).toBeVisible({ timeout: 20_000 });
  return { zips };
}

const modal = (page: Page) => page.getByRole('dialog', { name: /FLIT-40/ });
const abrir = async (page: Page, n: number) => {
  await page.getByRole('button', { name: `Ver el detalle del trámite FLIT-40${n}` }).click();
  await expect(modal(page)).toBeVisible();
};

test.describe('FLITO — Gestión Trámites: detalle en modal (ADR-0046)', () => {
  test('«Ver» abre la modal con sus secciones; Escape cierra y devuelve el foco al «Ver»', async ({ page }) => {
    await montar(page);
    await abrir(page, 1);
    const m = modal(page);
    await expect(m.getByRole('heading', { name: 'FLIT-401', level: 2 })).toBeVisible();
    await expect(m.getByText('Gestión Trámites · 1 de 51')).toBeVisible();
    // Fuente con número (decisión del humano), SOLO en la cabecera (rediseño 14707: Resumen ya no la repite).
    await expect(m.getByText('FLIT 1', { exact: true })).toHaveCount(1);
    const cabeza = m.locator('.kit-modal__cabeza');
    await expect(cabeza.getByText('FLIT 1', { exact: true })).toBeVisible();
    // (El chip «FLIT» del historial es el ORIGEN del cambio, no la fuente: se mira solo cabecera y Resumen.)
    await expect(cabeza.getByText('FLIT', { exact: true })).toHaveCount(0);
    await expect(m.getByRole('region', { name: 'Resumen', exact: true }).getByText('FLIT', { exact: true })).toHaveCount(0);
    // La placa no va en la cabecera: vive en el bloque Vehículo, que abre el contenido (UX rediseño §9).
    await expect(cabeza.getByText('PLC 001')).toHaveCount(0);
    await expect(m.getByRole('region', { name: 'Vehículo', exact: true }).getByText('PLC 001')).toBeVisible();
    // Lateral «Estado de la gestión», sin botones; el semáforo llega del detalle.
    const lateral = m.getByRole('region', { name: 'Estado de la gestión' });
    await expect(lateral.getByText('Amarillo')).toBeVisible();
    await expect(lateral.getByRole('button')).toHaveCount(0);
    // El índice marca la sección visible: al abrir, Vehículo (y no otra).
    const indice = m.getByRole('navigation', { name: 'Secciones del trámite' });
    await expect(indice.getByRole('button', { name: 'Vehículo' })).toHaveAttribute('aria-current', 'true');
    await expect(indice.locator('[aria-current]')).toHaveCount(1);
    await indice.getByRole('button', { name: 'Historial' }).click();
    await expect(indice.getByRole('button', { name: 'Historial' })).toHaveAttribute('aria-current', 'true');
    await expect(indice.getByRole('button', { name: 'Vehículo' })).not.toHaveAttribute('aria-current', 'true');
    // Desplazar el contenido de vuelta arriba devuelve el resaltado a Vehículo.
    await m.getByRole('region', { name: 'Detalle del trámite FLIT-401' }).evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
    await expect(indice.getByRole('button', { name: 'Vehículo' })).toHaveAttribute('aria-current', 'true');
    for (const s of ['Resumen', 'Vehículo', 'Propietario y gestora', 'Costos y facturación', 'Historial']) {
      await expect(m.getByRole('region', { name: s, exact: true })).toBeVisible();
    }
    await expect(m.getByText('Propietaria Uno 1')).toBeVisible();
    await expect(m.getByText('Laura Gestora')).toBeVisible();
    await expect(m.getByText('laura.gestora@demo.test')).toBeVisible();
    await expect(m.getByText('VIN000000000001')).toBeVisible();
    await expect(m.getByText('Aseguradora Sur')).toBeVisible();
    await expect(m.getByRole('region', { name: 'Soportes (1)' })).toBeVisible();
    await expect(m.getByRole('button', { name: 'Soportes (1)' })).toBeVisible();
    // Solo lo que viene: `linea` nula no se pinta.
    await expect(m.getByRole('region', { name: 'Vehículo', exact: true }).getByText('Línea')).toHaveCount(0);
    // Acciones en el encabezado del bloque Vehículo: trámite accionable y usuario con las funciones.
    const vehiculo = m.getByRole('region', { name: 'Vehículo', exact: true });
    await expect(vehiculo.getByRole('button', { name: 'Solicitar SOAT', exact: true })).toBeVisible();
    await expect(vehiculo.getByRole('button', { name: 'Entregar', exact: true })).toBeVisible();
    await expect(m.getByRole('alert')).toHaveCount(0);
    // El trámite abierto no viaja en la URL.
    expect(page.url()).not.toContain(ID(1));

    await page.keyboard.press('Escape');
    await expect(modal(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Ver el detalle del trámite FLIT-401' })).toBeFocused();
  });

  test('trámite anulado (14707): chip y aviso primero, sin acciones; el lateral dice por qué ya no aplica', async ({ page }) => {
    await montar(page, { vigencia: 'anulado' });
    await abrir(page, 1);
    const m = modal(page);
    await expect(m.locator('.kit-modal__cabeza').getByText('Anulado', { exact: true })).toBeVisible();
    const aviso = m.getByRole('alert').filter({ hasText: 'Trámite anulado en FLIT' });
    await expect(aviso).toContainText('ya no tiene acciones: no se puede solicitar SOAT ni impuestos, ni entregar');
    for (const b of ['Solicitar SOAT', 'Solicitar Impuestos', 'Solicitar ambos', 'Entregar']) {
      await expect(m.getByRole('button', { name: b, exact: true })).toHaveCount(0);
    }
    const lateral = m.getByRole('region', { name: 'Estado de la gestión' });
    await expect(lateral.getByText('No aplica')).toBeVisible();
    await expect(lateral.getByText('Descartado')).toHaveCount(2);
    // El siguiente trámite está vigente: el aviso se va y vuelven las acciones.
    await m.getByRole('button', { name: 'Siguiente ›' }).click();
    await expect(m.getByRole('heading', { name: 'FLIT-402', level: 2 })).toBeVisible();
    await expect(m.getByText('Trámite anulado en FLIT')).toHaveCount(0);
    await expect(m.getByRole('button', { name: 'Solicitar SOAT', exact: true })).toBeVisible();
  });

  test('trámite revocado (14707): su cobro y su factura se ven como histórico, marcados «Revocado»', async ({ page }) => {
    await montar(page, { vigencia: 'revocado' });
    await abrir(page, 1);
    const m = modal(page);
    await expect(m.getByRole('alert').filter({ hasText: 'Trámite revocado en FLIT' })).toContainText('se conservan como histórico');
    const costos = m.getByRole('region', { name: 'Costos y facturación', exact: true });
    await expect(costos.getByText('Revocado', { exact: true }).first()).toBeVisible();
    await expect(costos.getByText(/500\.000/).first()).toBeVisible();
  });

  test('placa por tipo: servicio público blanca, dicho también en texto', async ({ page }) => {
    await montar(page);
    await abrir(page, 2);
    const vehiculo = modal(page).getByRole('region', { name: 'Vehículo', exact: true });
    await expect(vehiculo.locator('[data-kit="placa"]')).toHaveAttribute('data-variante', 'publico');
    await expect(vehiculo.getByText(/Servicio público · VIN/)).toBeVisible();
  });

  test('Siguiente cambia de trámite y en el borde carga la página siguiente', async ({ page }) => {
    await montar(page);
    await abrir(page, 1);
    await expect(modal(page).getByRole('button', { name: '‹ Anterior' })).toBeDisabled();
    await modal(page).getByRole('button', { name: 'Siguiente ›' }).click();
    await expect(modal(page).getByRole('heading', { name: 'FLIT-402', level: 2 })).toBeVisible();
    await expect(modal(page).getByText('Gestión Trámites · 2 de 51')).toBeVisible();
    await expect(modal(page).getByText('Propietaria Uno 2')).toBeVisible();
    await expect(modal(page).getByText('FLIT 2', { exact: true })).toHaveCount(1);

    await modal(page).getByRole('button', { name: 'Siguiente ›' }).click();
    await expect(modal(page).getByRole('heading', { name: 'FLIT-403', level: 2 })).toBeVisible();
    await expect(modal(page).getByText('Gestión Trámites · 51 de 51')).toBeVisible();
    await expect(modal(page).getByRole('button', { name: 'Siguiente ›' })).toBeDisabled();

    // Escape devuelve el foco al «Ver» del trámite que se estaba mirando (ya en la página 2).
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Ver el detalle del trámite FLIT-403' })).toBeFocused();
  });

  test('un error del historial no tumba el resto de la modal y ofrece reintento', async ({ page }) => {
    await montar(page, { fallaHistorial: true });
    await abrir(page, 1);
    const m = modal(page);
    const hist = m.getByRole('region', { name: 'Historial', exact: true });
    await expect(hist.getByRole('alert')).toContainText('No se pudo cargar el historial');
    await expect(hist.getByRole('button', { name: 'Reintentar el historial' })).toBeVisible();
    await expect(m.getByText('Propietaria Uno 1')).toBeVisible();
    await expect(m.getByText('poliza.pdf')).toBeVisible();
  });

  test('ZIP del trámite: oculto sin la función de descarga', async ({ page }) => {
    await montar(page);
    await abrir(page, 1);
    await expect(modal(page).getByText('poliza.pdf')).toBeVisible();
    await expect(modal(page).getByRole('button', { name: 'Descargar seleccionados (.zip)' })).toHaveCount(0);
  });

  test('ZIP del trámite: con la función descarga solo ese trámite y los tipos marcados', async ({ page }) => {
    const { zips } = await montar(page, { usuario: conFunciones([...BASE, 'tramites.soportes.descargar']) });
    await abrir(page, 1);
    const m = modal(page);
    await expect(m.getByText('FLIT-401-DOCS.zip')).toBeVisible();
    // Pendientes deshabilitados (sin documento de ese tipo).
    await expect(m.getByRole('checkbox', { name: /Liquidación/ })).toBeDisabled();
    const boton = m.getByRole('button', { name: 'Descargar seleccionados (.zip)' });
    await expect(boton).toBeDisabled();
    await m.getByRole('checkbox', { name: 'Seleccionar todos' }).check();
    await expect(boton).toBeEnabled();
    const descarga = page.waitForEvent('download');
    await boton.click();
    expect((await descarga).suggestedFilename()).toBe('FLIT-401-DOCS.zip');
    expect(zips).toHaveLength(1);
    expect(zips[0]).toEqual({ ids: [ID(1)], tipos: ['factura_venta', 'factura_soat'] });
    await expect(m.getByText(/ZIP descargado: FLIT-401-DOCS\.zip/)).toBeVisible();
  });
});
