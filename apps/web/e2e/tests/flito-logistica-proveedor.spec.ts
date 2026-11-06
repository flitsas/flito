import { test, expect, type Page, type Route } from '@playwright/test';
import { loginAs, OPERACIONES_USER, funcionesDe } from '../helpers/auth';

// HU #14353 — consola de Logística operada por el proveedor (ADR-0039 §6.5, §7.2). Spec:
// docs/ux/logistica-proveedor-14353-slim.md. El backend está mockeado: lo que se prueba es qué pinta y qué pide la
// web. El alcance real de los datos (AC2, AC7 y AC8 contra base) lo prueba el backend.

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json' as const, body: JSON.stringify(body) });

const FUN_COORDINADOR = [
  'logistica.consola.ver', 'logistica.consola.filtrar', 'logistica.actas.listar', 'logistica.actas.ver', 'logistica.actas.descargar',
  'logistica.actas.despachar', 'logistica.actas.devolver', 'logistica.documento.ver', 'logistica.documento.reportar_novedad',
  'logistica.traslado.registrar', 'logistica.traslado.anular',
];
/** Lo que un administrador le podría asignar a mano a un rol de proveedor. La doble cerradura lo calla igual. */
const FUN_CERRADAS = [
  'logistica.viajes.ver', 'logistica.viajes.registrar', 'logistica.documento.resolver_tramite', 'logistica.motivos.gestionar',
  'logistica.lote.cerrar', 'logistica.actas.firmar_flit', 'logistica.documento.reversar',
];
const BASE = funcionesDe(OPERACIONES_USER).filter((f) => !f.startsWith('logistica.'));

const COORDINADOR = {
  id: 40, username: 'e2e_coord', name: 'Coordinador Demo', role: 'proveedor' as const, tipoEnlace: 'proveedor',
  allowedPages: ['flito_logistica', 'flito_logistica_ruta'],
};

const fila = (o: Record<string, unknown>) => ({
  tramiteId: 'tr-1', idFlit: 'FLIT-DEMO-1', placa: 'ZZA101', vin: 'VINDEMO0000000001', companiaId: 5,
  companiaNombre: 'Concesionario Demo Norte', companiaNit: '900111', organismoCodigo: '17001', organismoNombre: 'Secretaría de Movilidad de Manizales',
  docId: 'doc-1', estado: 'recogido', estadoLabel: 'Registrada', estadoSimple: 'registrada', estadoSimpleLabel: 'Registrada',
  numeroLicencia: '100381', numeroLt: 'LT90000000101', actaId: null, motivo: null, actualizadoEn: null, ...o,
});
const TRAMITES = [fila({}), fila({ tramiteId: 'tr-2', idFlit: 'FLIT-DEMO-2', placa: 'ZZB202', docId: null, estadoSimple: 'pendiente', estadoSimpleLabel: 'Pendiente', numeroLt: null })];

const acta = (o: Record<string, unknown>) => ({
  id: 'acta-1', companiaId: 5, companiaNombre: 'Concesionario Demo Norte', estado: 'generada', estadoLabel: 'Generada', mensajeroId: null, mensajeroNombre: null,
  documentos: 2, receptorNombre: null, entregadoEn: null, creadoEn: '2026-11-01T10:00:00Z', punto: 'cliente', trasladoId: 'tv-1', ...o,
});
const ACTAS = [
  acta({}),
  acta({ id: 'acta-2', companiaNombre: 'Concesionario Demo Sur', estado: 'despachada', estadoLabel: 'Despachada', mensajeroId: 8, mensajeroNombre: 'Andrés Demo', punto: 'flit', documentos: 3 }),
];

const COMPANIA = {
  companiaId: 5, nombre: 'Concesionario Demo Norte', disponibles: 2, destinos: { cliente: true, flit: true },
  lts: [
    { documentoId: 'doc-1', origen: 'organismo', placa: 'ZZA101', numeroLt: '90000000101', idFlit: 'FLIT-DEMO-1' },
    { documentoId: 'doc-2', origen: 'organismo', placa: 'ZZB202', numeroLt: '90000000202', idFlit: 'FLIT-DEMO-2' },
  ],
};
const FACETAS = { estados: [], empresas: [{ nit: '900111', nombre: 'Concesionario Demo Norte' }, { nit: '900222', nombre: 'Concesionario Demo Sur' }], organismos: [], companiasCerrables: [COMPANIA] };

const DETALLE = { ...fila({}), propietario: 'ANA DEMO PRUEBA', combustible: null, eventos: [] };
const ACTA_DETALLE = {
  acta: ACTAS[1], tienePdf: true, firmaEntrega: true, firmaRecibe: false, entregaNombre: null,
  documentos: [{ id: 'doc-1', placa: 'ZZA101', secretaria: 'Manizales', numeroLicencia: '100381', numeroLt: 'LT90000000101', estado: 'despachado', estadoLabel: 'Despachada', idFlit: 'FLIT-DEMO-1' }],
  bitacora: [{ id: 'ev-1', documentoId: 'doc-1', placa: 'ZZA101', tipo: null, estadoAnterior: null, estadoNuevo: 'despachado', actorNombre: null, motivo: null, origen: 'api', creadoEn: '2026-11-01T10:00:00Z' }],
};

interface Espias { buscar: unknown[]; urls: string[] }

async function mockConsola(page: Page, o: { tramites?: unknown[]; actas?: unknown[]; facetas?: unknown } = {}): Promise<Espias> {
  const espias: Espias = { buscar: [], urls: [] };
  page.on('request', (r) => { if (r.url().includes('/api/flito/')) espias.urls.push(`${r.method()} ${r.url()}`); });
  const tramites = o.tramites ?? TRAMITES;
  await page.route(/\/api\/flito\/logistica\/buscar$/, (r) => {
    espias.buscar.push(r.request().postDataJSON());
    return r.fulfill(json({ items: tramites, total: tramites.length, page: 1, pageSize: 50 }));
  });
  await page.route(/\/api\/flito\/logistica\/facetas/, (r) => r.fulfill(json(o.facetas ?? FACETAS)));
  await page.route(/\/api\/flito\/logistica\/actas$/, (r) => r.fulfill(json(o.actas ?? ACTAS)));
  await page.route(/\/api\/flito\/logistica\/traslados\/buscar/, (r) => r.fulfill(json({ viajes: [], companias: [] })));
  await page.route(/\/api\/flito\/logistica\/motivos-llegada/, (r) => r.fulfill(json([{ id: 'm1', nombre: 'Falta documento' }])));
  await page.route(/\/api\/flito\/logistica\/tramites\/[^/]+\/linea-tiempo/, (r) => r.fulfill(json({ hitos: [] })));
  return espias;
}

const entrarProveedor = async (page: Page, funciones: string[] = FUN_COORDINADOR) => {
  await loginAs(page, COORDINADOR, { funciones: [...BASE, ...funciones] });
};
const firmar = (modal: import('@playwright/test').Locator) => modal.getByLabel('Firma de quien entrega').evaluate((el: HTMLCanvasElement) => {
  const r = el.getBoundingClientRect();
  const pe = (type: string, x: number, y: number) => el.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerId: 1 }));
  pe('pointerdown', 20, 20); pe('pointermove', 90, 60); pe('pointermove', 140, 30); pe('pointerup', 140, 30);
});
const SIN_PRECIOS = /\$|precio|tarifa|costo/i;

test.describe('AC1 y AC4 · pestañas y acciones por función y por enlace', () => {
  test('el coordinador ve cuatro pestañas; lo cerrado no aparece aunque le asignen la función', async ({ page }) => {
    await entrarProveedor(page, [...FUN_COORDINADOR, ...FUN_CERRADAS]);
    const espias = await mockConsola(page);
    await page.goto('/flito/logistica');
    const tabs = page.locator('div.flex.flex-wrap.gap-1.border-b button');
    await expect(tabs).toHaveCount(4);
    for (const nombre of ['Viajes adicionales', 'LT pendientes', 'Motivos de llegada']) {
      await expect(page.getByRole('button', { name: nombre })).toHaveCount(0);
    }
    // La doble cerradura alcanza también a la petición: sin pestaña no hay bandeja.
    expect(espias.urls.some((u) => u.includes('pendientes-tramite'))).toBe(false);
    await page.getByRole('button', { name: /^Actas/ }).click();
    await expect(page.getByRole('button', { name: /Firmar llegada/ })).toHaveCount(0);
    await expect(page.getByText('A FLIT. Operaciones de FLITO firma la llegada.')).toBeVisible();
    await expect(page.getByRole('button', { name: /Devolver acta de Concesionario Demo Sur/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Firmar y despachar acta de Concesionario Demo Norte/ })).toBeVisible();
  });

  test('el gate ya no es lote.cerrar: sin esa función despacha, devuelve y reporta novedad', async ({ page }) => {
    await entrarProveedor(page);
    await mockConsola(page);
    await page.goto('/flito/logistica');
    await expect(page.getByRole('button', { name: 'Novedad de ZZA101' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Novedad de ZZB202' })).toHaveCount(0);
  });

  test('cada acción de Actas pide su función', async ({ page }) => {
    await entrarProveedor(page, ['logistica.actas.listar']);
    await mockConsola(page);
    await page.goto('/flito/logistica');
    await expect(page.getByRole('heading', { name: 'Actas' })).toBeVisible();
    for (const nombre of [/^Ver acta/, /Firmar y despachar/, /Devolver acta/]) {
      await expect(page.getByRole('button', { name: nombre })).toHaveCount(0);
    }
  });

  test('D7: el enlace compañía no ve Firmar y despachar aunque tenga la función', async ({ page }) => {
    await loginAs(page, { ...COORDINADOR, tipoEnlace: 'compania' }, { funciones: [...BASE, ...FUN_COORDINADOR] });
    await mockConsola(page);
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /^Actas/ }).click();
    await expect(page.getByRole('button', { name: /^Ver acta de Concesionario Demo Norte/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Firmar y despachar/ })).toHaveCount(0);
  });

  test('H3: Viajes depende del permiso, sin exigir consola.filtrar y sin regla por rol', async ({ page }) => {
    await entrarProveedor(page, ['logistica.traslado.registrar', 'logistica.actas.listar']);
    await mockConsola(page);
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /^Viajes/ }).click();
    await expect(page.getByText('Concesionario Demo Norte · 2 LT')).toBeVisible();
  });

  test('Operaciones no pierde nada: columnas, precios, pestañas y Firmar llegada', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page, {
      tramites: [fila({ propietario: 'ANA DEMO PRUEBA' })],
      actas: [acta({ id: 'acta-2', estado: 'despachada', estadoLabel: 'Despachada', punto: 'flit' })],
      facetas: { ...FACETAS, companiasCerrables: [{ ...COMPANIA, destinos: undefined, precioEntregaCliente: 25000, precioEntregaFlit: 18000 }] },
    });
    await page.goto('/flito/logistica');
    await expect(page.getByRole('columnheader', { name: 'Propietario' })).toBeVisible();
    await expect(page.getByText('ANA DEMO PRUEBA')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Viajes adicionales' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Motivos de llegada' })).toBeVisible();
    await page.getByRole('button', { name: /^Viajes(?! adicionales)/ }).click();
    await expect(page.getByText(/Cliente \$25\.000 por LT/)).toBeVisible();
    await page.getByRole('button', { name: /^Actas/ }).click();
    await expect(page.getByRole('columnheader', { name: 'Receptor' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Firmar llegada/ })).toBeVisible();
    await expect(page.getByText('Operaciones de FLITO firma la llegada')).toHaveCount(0);
  });
});

test.describe('AC2 · sin precios y sin propietario en listas', () => {
  test('Trámites sin columna ni dato de propietario, aunque la fila lo traiga', async ({ page }) => {
    await entrarProveedor(page);
    await mockConsola(page, { tramites: [fila({ propietario: 'NO DEBE VERSE' })] });
    await page.goto('/flito/logistica');
    await expect(page.getByRole('row', { name: /ZZA101/ })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Propietario' })).toHaveCount(0);
    await expect(page.getByText('NO DEBE VERSE')).toHaveCount(0);
  });

  test('Detalle: el nombre sí; el documento y Viajes adicionales, no', async ({ page }) => {
    await entrarProveedor(page, [...FUN_COORDINADOR, 'logistica.viajes.ver']);
    await mockConsola(page);
    await page.route(/\/api\/flito\/logistica\/tr-1$/, (r) => r.fulfill(json({ ...DETALLE, propietarioDocumento: '10203040' })));
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: 'Detalle de ZZA101' }).click();
    const modal = page.getByRole('dialog', { name: /Licencia · ZZA101/ });
    await expect(modal.getByText('ANA DEMO PRUEBA')).toBeVisible();
    await expect(modal.getByText('10203040')).toHaveCount(0);
    await expect(modal.getByText(/Viajes adicionales/)).toHaveCount(0);
  });

  test('acta: licencias sin Propietario y actor ajeno en «—»', async ({ page }) => {
    await entrarProveedor(page);
    await mockConsola(page);
    await page.route(/\/api\/flito\/logistica\/actas\/acta-2$/, (r) => r.fulfill(json(ACTA_DETALLE)));
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /^Actas/ }).click();
    await page.getByRole('button', { name: /Ver acta de Concesionario Demo Sur/ }).click();
    const modal = page.getByRole('dialog', { name: /Acta · / });
    await expect(modal.getByRole('columnheader', { name: 'Placa' })).toBeVisible();
    await expect(modal.getByRole('columnheader', { name: 'Propietario' })).toHaveCount(0);
    await expect(modal.getByText('sistema')).toHaveCount(0);
  });

  test('Viajes: ningún precio en la tarjeta ni en el modal; el botón no depende del precio', async ({ page }) => {
    await entrarProveedor(page);
    await mockConsola(page);
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /^Viajes/ }).click();
    const tarjeta = page.getByRole('article');
    await expect(tarjeta.getByRole('heading', { name: 'Concesionario Demo Norte · 2 LT' })).toBeVisible();
    await expect(page.getByText('Elija el destino de cada compañía y registre el viaje.')).toBeVisible();
    await expect(tarjeta).not.toContainText(SIN_PRECIOS);
    await tarjeta.getByRole('button', { name: 'Registrar viaje' }).click();
    const modal = page.getByRole('dialog', { name: /Registrar viaje a/ });
    await expect(modal.getByText('Se registrará un viaje a cliente con 2 LT.')).toBeVisible();
    await expect(modal).not.toContainText(SIN_PRECIOS);

    await modal.getByRole('group', { name: 'Destino del viaje' }).getByRole('button', { name: 'FLIT' }).click();
    await expect(modal.getByText('Se registrará un viaje a FLIT con 2 LT.')).toBeVisible();
    await modal.getByRole('group', { name: 'Destino de ZZB202' }).getByRole('button', { name: 'Cliente' }).click();
    await expect(modal.getByText('Se registrarán dos viajes: 1 LT a FLIT y 1 a cliente.')).toBeVisible();
  });

  test('sin destinos disponibles: aviso sin la palabra precio ni enlace a Tarifas', async ({ page }) => {
    await entrarProveedor(page);
    await mockConsola(page, { facetas: { ...FACETAS, companiasCerrables: [{ ...COMPANIA, destinos: { cliente: false, flit: false } }] } });
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /^Viajes/ }).click();
    await expect(page.getByText('Este viaje aún no se puede registrar. Avísele a Operaciones de FLITO para que complete la configuración de la compañía.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Registrar viaje' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Ir a Tarifas' })).toHaveCount(0);
  });

  test('si destinos no llega el botón se ofrece y el 422 pinta el aviso genérico', async ({ page }) => {
    await entrarProveedor(page);
    await mockConsola(page, { facetas: { ...FACETAS, companiasCerrables: [{ ...COMPANIA, destinos: undefined }] } });
    await page.route(/\/api\/flito\/logistica\/traslados$/, (r) => r.fulfill(json({ error: 'crudo interno', codigo: 'PRECIO_TRASLADO_NO_CONFIGURADO' }, 422)));
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /^Viajes/ }).click();
    await page.getByRole('button', { name: 'Registrar viaje' }).click();
    const modal = page.getByRole('dialog', { name: /Registrar viaje a/ });
    await modal.getByRole('button', { name: 'Confirmar viaje' }).click();
    await expect(modal.getByRole('alert')).toHaveText('Este viaje aún no se puede registrar. Avísele a Operaciones de FLITO para que complete la configuración de la compañía.');
  });

  test('Enviar a cliente sin «Este tramo no tiene costo»', async ({ page }) => {
    await entrarProveedor(page);
    await mockConsola(page, { facetas: { ...FACETAS, companiasCerrables: [{ ...COMPANIA, lts: [{ ...COMPANIA.lts[0], origen: 'flit' }] }] } });
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /^Viajes/ }).click();
    await page.getByRole('button', { name: 'Enviar a cliente' }).click();
    await expect(page.getByRole('dialog', { name: /Enviar a cliente/ })).not.toContainText(SIN_PRECIOS);
  });
});

test.describe('AC3 · selector de mensajero', () => {
  const abrir = async (page: Page) => {
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /^Actas/ }).click();
    await page.getByRole('button', { name: /Firmar y despachar acta de Concesionario Demo Norte/ }).click();
    return page.getByRole('dialog', { name: 'Firmar entrega y despachar' });
  };
  const mensajeros = (page: Page, h: (r: Route) => Promise<void>) => page.route(/\/api\/flito\/logistica\/actas\/acta-1\/mensajeros$/, h);

  test('proveedor: solo los suyos, sin etiqueta, aunque el servidor mandara grupo', async ({ page }) => {
    await entrarProveedor(page);
    await mockConsola(page);
    await mensajeros(page, (r) => r.fulfill(json([{ id: 1, nombre: 'Mensajero Demo' }, { id: 2, nombre: 'Andrés Demo', grupo: 'proveedor', proveedorNombre: 'Proveedor Demo Uno' }])));
    const modal = await abrir(page);
    await expect(modal.getByLabel('Mensajero')).toContainText('Mensajero Demo');
    await expect(modal.locator('optgroup')).toHaveCount(0);
    await expect(modal.locator('option')).toHaveText(['Elija…', 'Mensajero Demo', 'Andrés Demo']);
    await expect(modal.getByText('Proveedor Demo Uno')).toHaveCount(0);
  });

  test('Operaciones: dos grupos con el nombre del proveedor del acta', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    await mensajeros(page, (r) => r.fulfill(json([
      { id: 3, nombre: 'Laura Demo', grupo: 'flito' },
      { id: 1, nombre: 'Mensajero Demo', grupo: 'proveedor', proveedorNombre: 'Proveedor Demo Uno' },
    ])));
    const modal = await abrir(page);
    await expect(modal.locator('optgroup[label="Mensajeros de FLITO"] option')).toHaveText(['Laura Demo']);
    await expect(modal.locator('optgroup[label="Mensajeros de Proveedor Demo Uno"] option')).toHaveText(['Mensajero Demo']);
    await expect(modal.getByLabel('Nombre de quien entrega')).toHaveAttribute('placeholder', 'Opcional: por defecto, su usuario');
  });

  test('cuatro estados: cargando, error con reintento, vacío por rol con botón deshabilitado, lleno', async ({ page }) => {
    await entrarProveedor(page);
    await mockConsola(page);
    let caido = true;
    let soltar: () => void = () => {};
    const espera = new Promise<void>((res) => { soltar = res; });
    await mensajeros(page, async (r) => {
      if (caido) { await espera; return r.fulfill(json({ error: 'caído' }, 503)); }
      return r.fulfill(json([]));
    });
    const modal = await abrir(page);
    const confirmar = modal.getByRole('button', { name: 'Firmar y despachar' });
    await expect(modal.locator('option', { hasText: 'Cargando mensajeros…' })).toBeAttached();
    await expect(confirmar).toBeDisabled();
    soltar();
    await expect(modal.getByRole('alert')).toContainText('No se pudieron cargar los mensajeros.');
    await expect(confirmar).toBeDisabled();
    caido = false;
    await modal.getByRole('button', { name: 'Reintentar' }).click();
    await expect(modal.getByRole('status')).toContainText('Su empresa aún no tiene mensajeros activos.');
    await expect(modal.getByRole('status')).toContainText('Pídale a Operaciones de FLITO que cree el usuario.');
    await expect(confirmar).toBeDisabled();
  });

  test('Operaciones sin mensajeros: su propio copy', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockConsola(page);
    await mensajeros(page, (r) => r.fulfill(json([])));
    const modal = await abrir(page);
    await expect(modal.getByRole('status')).toContainText('No hay mensajeros disponibles para esta acta.');
  });
});

test.describe('AC5 · búsqueda sin datos en la URL', () => {
  for (const quien of ['proveedor', 'operaciones'] as const) {
    test(`${quien}: placa, VIN y NIT viajan en el cuerpo; ninguna URL los lleva`, async ({ page }) => {
      if (quien === 'proveedor') await entrarProveedor(page); else await loginAs(page, OPERACIONES_USER);
      const espias = await mockConsola(page);
      await page.goto('/flito/logistica');
      await expect(page.getByRole('row', { name: /ZZA101/ })).toBeVisible();
      await page.getByRole('textbox', { name: 'Buscar' }).fill('ZZA101');
      await expect.poll(() => espias.buscar.at(-1)).toEqual({ buscar: 'ZZA101' });
      await page.getByRole('textbox', { name: 'Buscar' }).fill('VINDEMO0000000001');
      await expect.poll(() => espias.buscar.at(-1)).toEqual({ buscar: 'VINDEMO0000000001' });
      await page.getByLabel('Empresa').selectOption('900111');
      await expect.poll(() => espias.buscar.at(-1)).toEqual({ buscar: 'VINDEMO0000000001', empresas: ['900111'] });
      await page.getByRole('button', { name: 'Registrada' }).click();
      await expect.poll(() => espias.buscar.at(-1)).toEqual({ buscar: 'VINDEMO0000000001', empresas: ['900111'], estados: ['registrada'] });

      for (const dato of ['ZZA101', 'VINDEMO', '900111']) {
        expect(page.url()).not.toContain(dato);
        expect(espias.urls.filter((u) => u.includes(dato))).toEqual([]);
      }
      expect(espias.urls.some((u) => /\/flito\/logistica\?/.test(u))).toBe(false);
    });
  }

  test('escribir no pierde el foco ni deshace las filas visibles', async ({ page }) => {
    await entrarProveedor(page);
    await mockConsola(page);
    await page.goto('/flito/logistica');
    await expect(page.getByRole('row', { name: /ZZA101/ })).toBeVisible();
    const buscar = page.getByRole('textbox', { name: 'Buscar' });
    await buscar.pressSequentially('ZZA');
    await page.waitForTimeout(500);
    await expect(buscar).toBeFocused();
    await expect(page.getByRole('row', { name: /ZZA101/ })).toBeVisible();
  });

  test('con una sola compañía el proveedor no ve el selector de empresa', async ({ page }) => {
    await entrarProveedor(page);
    await mockConsola(page, { facetas: { ...FACETAS, empresas: [FACETAS.empresas[0]] } });
    await page.goto('/flito/logistica');
    await expect(page.getByRole('row', { name: /ZZA101/ })).toBeVisible();
    await expect(page.getByLabel('Empresa')).toHaveCount(0);
  });
});

test.describe('AC9 · cuatro estados y errores sin crudo', () => {
  test('Trámites: cargando, error con reintento, vacío y filtros sin resultado', async ({ page }) => {
    await entrarProveedor(page);
    await mockConsola(page);
    let caido = true;
    let soltar: () => void = () => {};
    const espera = new Promise<void>((res) => { soltar = res; });
    await page.route(/\/api\/flito\/logistica\/buscar$/, async (r) => {
      if (caido) { await espera; return r.fulfill(json({ error: 'SELECT * interno' }, 500)); }
      return r.fulfill(json({ items: [], total: 0, page: 1, pageSize: 50 }));
    });
    await page.goto('/flito/logistica');
    await expect(page.getByRole('status', { name: 'Cargando trámites…' })).toBeVisible();
    soltar();
    await expect(page.getByRole('alert')).toContainText('No se pudieron cargar los trámites. Inténtelo de nuevo.');
    await expect(page.getByText('SELECT * interno')).toHaveCount(0);
    caido = false;
    await page.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByText('Los trámites en estado «Aprobado» aparecen aquí')).toBeVisible();
    await page.getByRole('textbox', { name: 'Buscar' }).fill('ZZZ999');
    await expect(page.getByText('Ningún trámite coincide con estos filtros. Pruebe otra placa o VIN, o quite un filtro.')).toBeVisible();
    await page.getByRole('button', { name: 'Limpiar filtros' }).click();
    await expect(page.getByRole('textbox', { name: 'Buscar' })).toHaveValue('');
  });

  test('Actas: un 500 no se ve como vacío; vacío del proveedor sin aviso de corte', async ({ page }) => {
    await entrarProveedor(page);
    await mockConsola(page);
    let caido = true;
    await page.route(/\/api\/flito\/logistica\/actas$/, (r) => (caido ? r.fulfill(json({ error: 'interno' }, 500)) : r.fulfill(json([]))));
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /^Actas/ }).click();
    await expect(page.getByRole('alert')).toContainText('No se pudieron cargar las actas. Inténtelo de nuevo.');
    await expect(page.getByText('Aún no hay actas')).toHaveCount(0);
    caido = false;
    await page.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByText('Aún no hay actas. Cuando haya un viaje registrado o una recogida confirmada, su acta aparece aquí.')).toBeVisible();
    await expect(page.locator('body')).not.toContainText(/fecha de corte|anteriores/i);
  });

  test('refresco fallido con datos a la vista: se conservan y se avisa', async ({ page }) => {
    await entrarProveedor(page);
    await mockConsola(page);
    await page.goto('/flito/logistica');
    await expect(page.getByRole('row', { name: /ZZA101/ })).toBeVisible();
    await page.route(/\/api\/flito\/logistica\/buscar$/, (r) => r.fulfill(json({ error: 'x' }, 503)));
    await page.getByRole('button', { name: 'Pendiente' }).click();
    await expect(page.getByText('No se pudo actualizar.')).toBeVisible();
    await expect(page.getByRole('row', { name: /ZZA101/ })).toBeVisible();
  });

  test('Entregas: el vacío depende de traslado.registrar', async ({ page }) => {
    await entrarProveedor(page, ['logistica.consola.ver', 'logistica.actas.listar']);
    await mockConsola(page);
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: 'Entregas', exact: true }).click();
    await expect(page.getByText('Aún no hay viajes registrados. Cuando los registren, aparecen aquí.')).toBeVisible();
  });

  test('404 de dos filas distintas: el mismo toast, carácter por carácter, y recarga la lista', async ({ page }) => {
    await entrarProveedor(page);
    const espias = await mockConsola(page);
    await page.route(/\/api\/flito\/logistica\/tr-\d$/, (r) => r.fulfill(json({ error: 'El documento 123 es del proveedor ACME' }, 404)));
    await page.goto('/flito/logistica');
    const textos: string[] = [];
    for (const placa of ['ZZA101', 'ZZB202']) {
      const antes = espias.buscar.length;
      await page.getByRole('button', { name: `Detalle de ${placa}` }).click();
      const toast = page.getByRole('alert').filter({ hasText: 'No encontramos' });
      await expect(toast).toBeVisible();
      textos.push((await toast.locator('p').textContent()) ?? '');
      await expect(page.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
      await expect.poll(() => espias.buscar.length).toBeGreaterThan(antes);
      await toast.getByRole('button', { name: 'Cerrar aviso' }).click();
    }
    expect(textos[0]).toBe('No encontramos este trámite. Revise la lista actualizada.');
    expect(textos[1]).toBe(textos[0]);
    await expect(page.getByText(/ACME/)).toHaveCount(0);
  });

  test('lectura 403 y 500: su copy, sin crudo; solo el 500 ofrece reintento', async ({ page }) => {
    await entrarProveedor(page);
    await mockConsola(page);
    let estado = 403;
    await page.route(/\/api\/flito\/logistica\/tr-1$/, (r) => r.fulfill(json({ error: 'crudo interno' }, estado)));
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: 'Detalle de ZZA101' }).click();
    const toast = page.getByRole('alert');
    await expect(toast).toContainText('No tiene permiso para ver este detalle.');
    await expect(toast.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
    estado = 500;
    await page.getByRole('button', { name: 'Detalle de ZZA101' }).click();
    await expect(toast).toContainText('No se pudo abrir el detalle. Inténtelo de nuevo.');
    await expect(toast.getByRole('button', { name: 'Reintentar' })).toBeVisible();
    await expect(page.getByText('crudo interno')).toHaveCount(0);
  });

  test('acta y PDF: 404 con su copy', async ({ page }) => {
    await entrarProveedor(page);
    await mockConsola(page);
    await page.route(/\/api\/flito\/logistica\/actas\/acta-1$/, (r) => r.fulfill(json({ error: 'crudo' }, 404)));
    await page.route(/\/api\/flito\/logistica\/actas\/acta-2$/, (r) => r.fulfill(json(ACTA_DETALLE)));
    await page.route(/\/api\/flito\/logistica\/actas\/acta-2\/pdf$/, (r) => r.fulfill(json({ error: 'crudo' }, 500)));
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /^Actas/ }).click();
    await page.getByRole('button', { name: 'Ver acta de Concesionario Demo Norte', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('No encontramos esta acta. Revise la lista actualizada.');
    await page.getByRole('button', { name: 'Ver acta de Concesionario Demo Sur', exact: true }).click();
    await page.getByRole('dialog', { name: /Acta · / }).getByRole('button', { name: 'Descargar PDF' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'No se pudo descargar el PDF. Inténtelo de nuevo.' })).toBeVisible();
  });

  for (const estado of [403, 404]) {
    test(`escritura ${estado}: dentro del modal, mismo texto, y recarga`, async ({ page }) => {
      await entrarProveedor(page);
      const espias = await mockConsola(page);
      await page.route(/\/api\/flito\/logistica\/documentos\/doc-1\/novedad$/, (r) => r.fulfill(json({ error: 'crudo interno' }, estado)));
      await page.goto('/flito/logistica');
      await page.getByRole('button', { name: 'Novedad de ZZA101' }).click();
      const modal = page.getByRole('dialog', { name: 'Reportar novedad' });
      await modal.getByLabel('Motivo (obligatorio)').fill('Dañada');
      const antes = espias.buscar.length;
      await modal.getByRole('button', { name: 'Confirmar' }).click();
      await expect(modal.getByRole('alert')).toHaveText('No se pudo hacer este cambio sobre este registro. Revise la lista actualizada.');
      await expect.poll(() => espias.buscar.length).toBeGreaterThan(antes);
      await expect(page.getByText('crudo interno')).toHaveCount(0);
    });
  }
});

test.describe('AC7 y AC8 · flujo de la consola con mocks', () => {
  test('AC7: el proveedor registra, despacha y devuelve sin ver precios', async ({ page }) => {
    await entrarProveedor(page);
    await mockConsola(page);
    const traslados: Array<Record<string, unknown>> = [];
    let despacho: Record<string, unknown> | null = null;
    let devolucion: Record<string, unknown> | null = null;
    await page.route(/\/api\/flito\/logistica\/traslados$/, (r) => { traslados.push(r.request().postDataJSON()); return r.fulfill(json({ id: 'tv-9' }, 201)); });
    await page.route(/\/api\/flito\/logistica\/actas\/acta-1\/mensajeros$/, (r) => r.fulfill(json([{ id: 1, nombre: 'Mensajero Demo' }])));
    await page.route(/\/api\/flito\/logistica\/actas\/acta-1\/despachar$/, (r) => { despacho = r.request().postDataJSON(); return r.fulfill(json({ documentos: 2 })); });
    await page.route(/\/api\/flito\/logistica\/traslados\/tv-1\/devolucion$/, (r) => { devolucion = r.request().postDataJSON(); return r.fulfill(json({ ok: true })); });

    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /^Viajes/ }).click();
    await page.getByRole('button', { name: 'Registrar viaje' }).click();
    await page.getByRole('dialog', { name: /Registrar viaje a/ }).getByRole('button', { name: 'Confirmar viaje' }).click();
    await expect.poll(() => traslados.length).toBe(1);
    expect(traslados[0]).toMatchObject({ companiaId: 5, destino: 'cliente' });
    await expect(page.getByRole('status').filter({ hasText: /Viaje a cliente de Concesionario Demo Norte registrado/ })).not.toContainText(SIN_PRECIOS);

    await page.getByRole('button', { name: /^Actas/ }).click();
    await page.getByRole('button', { name: /Firmar y despachar acta de Concesionario Demo Norte/ }).click();
    const modal = page.getByRole('dialog', { name: 'Firmar entrega y despachar' });
    await modal.getByRole('combobox').selectOption('1');
    await firmar(modal);
    await modal.getByRole('button', { name: 'Firmar y despachar' }).click();
    await expect.poll(() => despacho).not.toBeNull();
    expect(despacho).toMatchObject({ mensajeroId: 1 });
    await expect(page.getByText('Viaje despachado a Mensajero Demo.')).toBeVisible();

    await page.getByRole('button', { name: /Devolver acta de Concesionario Demo Sur/ }).click();
    const dev = page.getByRole('dialog', { name: 'Registrar devolución' });
    await dev.getByLabel('Motivo (obligatorio)').fill('Receptor ausente');
    await dev.getByRole('button', { name: 'Confirmar' }).click();
    await expect.poll(() => devolucion).toEqual({ motivo: 'Receptor ausente' });
    await expect(dev).toHaveCount(0);
  });

  test('devolver un acta a FLIT: el proveedor va por el traslado', async ({ page }) => {
    await entrarProveedor(page);
    await mockConsola(page);
    let cuerpo: unknown = null;
    await page.route(/\/api\/flito\/logistica\/traslados\/tv-1\/devolucion$/, (r) => { cuerpo = r.request().postDataJSON(); return r.fulfill(json({ ok: true })); });
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /^Actas/ }).click();
    await page.getByRole('button', { name: /Devolver acta de Concesionario Demo Sur/ }).click();
    const dev = page.getByRole('dialog', { name: 'Registrar devolución' });
    await dev.getByLabel('Motivo (obligatorio)').fill('Receptor ausente');
    await dev.getByRole('button', { name: 'Confirmar' }).click();
    await expect.poll(() => cuerpo).toEqual({ motivo: 'Receptor ausente' });
  });

  test('AC8: Operaciones hace el mismo flujo y ve actas que el proveedor no recibe', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const anterior = acta({ id: 'acta-vieja', companiaNombre: 'Concesionario Demo Centro', creadoEn: '2025-01-01T10:00:00Z' });
    await mockConsola(page, { actas: [anterior, ...ACTAS] });
    let despacho: Record<string, unknown> | null = null;
    await page.route(/\/api\/flito\/logistica\/actas\/acta-vieja\/mensajeros$/, (r) => r.fulfill(json([{ id: 3, nombre: 'Laura Demo', grupo: 'flito' }])));
    await page.route(/\/api\/flito\/logistica\/actas\/acta-vieja\/despachar$/, (r) => { despacho = r.request().postDataJSON(); return r.fulfill(json({ documentos: 2 })); });
    await page.goto('/flito/logistica');
    await page.getByRole('button', { name: /^Actas/ }).click();
    await page.getByRole('button', { name: /Firmar y despachar acta de Concesionario Demo Centro/ }).click();
    const modal = page.getByRole('dialog', { name: 'Firmar entrega y despachar' });
    await modal.getByRole('combobox').selectOption('3');
    await firmar(modal);
    await modal.getByRole('button', { name: 'Firmar y despachar' }).click();
    await expect.poll(() => despacho).not.toBeNull();
  });
});
