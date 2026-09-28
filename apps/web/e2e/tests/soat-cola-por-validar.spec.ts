// HU #12997 — la cola SOAT muestra las solicitudes «Por validar» y «Descartadas» (Feature #12841).
//
// Spec UX que manda: `docs/ux/flito-soat-solicitud-incompleta-runt.md` §3 (tabla), §4 (4 estados y
// vacíos literales), §5 (detalle). La API se intercepta con `page.route` y se CUENTAN las
// peticiones a `buscar`: «el gestor no pide nada» y «el texto va en el cuerpo» no se ven en el DOM.
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, PROVEEDOR_USER, CLIENTE_CON_CANAL } from '../helpers/auth';

const VIN_INC = '9FKRG2222T2042405';
const VIN_DESC = '9BWZZZ377VT004251';
const ID_INC = 'aaaaaaaa-1111-4222-8333-444444444444';
const ID_DESC = 'bbbbbbbb-1111-4222-8333-444444444444';

const INCOMPLETA = {
  id: ID_INC, estado: 'incompleta', vin: VIN_INC, companiaId: 1, companiaNombre: 'Concesionario Norte',
  placa: null, marca: null, linea: null, titular: 'Ana Pérez', solicitadoPorNombre: 'Cliente E2E',
  solicitadoEn: '2026-09-28T14:00:00Z', intentos: 1, ultimoIntentoRuntEn: '2026-09-28T14:14:00Z',
  descarte: null, soatId: null,
};
const DESCARTADA = {
  ...INCOMPLETA, id: ID_DESC, vin: VIN_DESC, estado: 'descartada',
  descarte: { motivo: 'runt_sin_registro', en: '2026-09-28T14:20:00Z', porNombre: 'FLITO' },
};
const SOAT_HOY = {
  id: 's1', vin: 'VIN0000000000001', placa: 'ABC123', marca: 'Chevrolet', linea: 'Spark',
  cilindraje: '1200', carroceria: 'HATCHBACK', tipoServicio: 'Particular',
  estado: 'pendiente', esMultiplePropietario: false, companiaNombre: 'Concesionario Norte',
  organismoNombre: 'STT Manizales', proveedorSoatId: null, proveedorSoatNombre: null, compradores: [],
  tramitesFlit: ['FLIT-1'], tipoTramite: 'Traspaso', fechaAprobacion: null, fechaCreacion: '2026-09-01T10:00:00Z',
  enviadoPorNombre: null, enviadoEn: null, pagadoEn: null, valorPagado: null, estancado: false,
  motivoRechazo: null, creadoEn: '2026-09-01T12:00:00Z', gestionOperaciones: false,
};

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

type Buscar = { estados: string[]; texto?: string; pagina?: number; porPagina?: number };

async function mockCola(page: Page, opciones: {
  incompletas?: typeof INCOMPLETA[]; descartadas?: typeof DESCARTADA[]; falloBuscar?: boolean; soat?: unknown[];
} = {}) {
  const buscadas: Buscar[] = [];
  const detalles: string[] = [];
  const soatPorId: string[] = [];
  const colas: string[] = [];
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat/, (r) => json(r, 200, []));
  await page.route(/\/api\/flito\/soat\/facetas/, (r) => json(r, 200, { companias: [], organismos: [], proveedores: [] }));
  await page.route(/\/api\/flito\/soat\?/, (r) => {
    colas.push(new URL(r.request().url()).search);
    const items = opciones.soat ?? [SOAT_HOY];
    return json(r, 200, { items, total: items.length, page: 1, pageSize: 50 });
  });
  await page.route(/\/api\/flito\/soat\/cliente\/incompletas\/buscar$/, (r) => {
    const cuerpo = r.request().postDataJSON() as Buscar;
    buscadas.push(cuerpo);
    if (opciones.falloBuscar) return json(r, 500, { error: 'boom interno' });
    const inc = opciones.incompletas ?? [INCOMPLETA];
    const desc = opciones.descartadas ?? [DESCARTADA];
    const items = [...(cuerpo.estados.includes('incompleta') ? inc : []), ...(cuerpo.estados.includes('descartada') ? desc : [])];
    return json(r, 200, { items, total: items.length, conteos: { incompleta: inc.length, descartada: desc.length } });
  });
  await page.route(/\/api\/flito\/soat\/cliente\/incompletas\/[0-9a-f-]{36}$/, (r) => {
    const id = new URL(r.request().url()).pathname.split('/').pop()!;
    detalles.push(id);
    const fila = id === ID_DESC ? DESCARTADA : INCOMPLETA;
    return json(r, 200, {
      ...fila,
      propietario: {
        tipoDocumento: 'CC', nombres: 'Ana', apellidos: 'Pérez', razonSocial: null, numeroDocumento: '1020304050',
        correo: null, celular: null, direccion: null, municipio: null, departamento: null,
      },
      factura: { nombreArchivo: 'factura-venta.pdf', contentType: 'application/pdf', tamanoBytes: 204800 },
    });
  });
  // El id de una incompleta NO es un SOAT: cualquier GET /flito/soat/<id> se registra para asertarlo.
  await page.route(/\/api\/flito\/soat\/(aaaaaaaa|bbbbbbbb)[^?]*$/, (r) => { soatPorId.push(r.request().url()); return json(r, 404, {}); });
  return { buscadas, detalles, soatPorId, colas };
}

const pastilla = (page: Page, nombre: string) => page.getByRole('button', { name: nombre, exact: true });
const tabla = (page: Page) => page.getByRole('region', { name: 'Pólizas SOAT' });

test.describe('HU #12997 · AC5 — pastillas y «Todos»', () => {
  test('Cliente: el orden de las pastillas y «Todos» antepone las incompletas abiertas, sin descartadas', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    const cap = await mockCola(page);
    await page.goto('/flito/soat');

    const nombres = ['Todos', 'Por validar', 'Pendiente', 'Solicitado', 'Con novedad', 'Pagado', 'Descartadas'];
    for (const n of nombres) await expect(pastilla(page, n)).toBeVisible();
    const orden = await pastilla(page, 'Todos').locator('xpath=..').getByRole('button').allTextContents();
    expect(orden.map((t) => t.trim())).toEqual(nombres);

    const filas = tabla(page).locator('tbody tr');
    await expect(filas).toHaveCount(2);
    await expect(filas.nth(0)).toContainText(VIN_INC);
    await expect(filas.nth(0)).toContainText('Por validar');
    await expect(filas.nth(1)).toContainText('ABC123');
    await expect(tabla(page)).not.toContainText(VIN_DESC);
    expect(cap.buscadas[cap.buscadas.length - 1]).toMatchObject({ estados: ['incompleta'], pagina: 1 });
  });

  test('el texto de búsqueda viaja en el CUERPO de buscar, nunca en la URL', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    const cap = await mockCola(page);
    await page.goto('/flito/soat');
    await pastilla(page, 'Por validar').click();
    await page.getByLabel('Buscar SOAT').fill('1020304050');
    await expect.poll(() => cap.buscadas.some((b) => b.texto === '1020304050')).toBe(true);
    expect(page.url()).not.toContain('1020304050');
  });

  test('las pastillas envuelven a 375 px sin desbordar la pantalla', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await page.goto('/flito/soat');
    await expect(pastilla(page, 'Descartadas')).toBeVisible();
    // Las pastillas ocupan más de un renglón (envuelven) y ninguna se sale del viewport.
    const cajas = await page.getByRole('button', { name: /^(Todos|Por validar|Pendiente|Solicitado|Con novedad|Pagado|Descartadas)$/ })
      .evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ top: r.top, right: r.right })));
    expect(new Set(cajas.map((c) => Math.round(c.top))).size).toBeGreaterThan(1);
    for (const c of cajas) expect(c.right).toBeLessThanOrEqual(375);
  });

  test('proveedor (gestor): sin pastillas nuevas y sin una sola petición a buscar', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    const cap = await mockCola(page, { soat: [{ ...SOAT_HOY, estado: 'solicitado' }] });
    await page.goto('/flito/soat');
    await expect(tabla(page)).toBeVisible();
    await expect(pastilla(page, 'Por validar')).toHaveCount(0);
    await expect(pastilla(page, 'Descartadas')).toHaveCount(0);
    expect(cap.buscadas).toHaveLength(0);
  });

  test('sin la función soat.incompletas.buscar: ni pastillas ni petición', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL, {
      funciones: ['soat.cola.ver', 'soat.cola.filtrar', 'soat.solicitud.ver', 'soat.solicitud.crear'],
    });
    const cap = await mockCola(page);
    await page.goto('/flito/soat');
    await expect(tabla(page)).toBeVisible();
    await expect(pastilla(page, 'Por validar')).toHaveCount(0);
    expect(cap.buscadas).toHaveLength(0);
  });
});

test.describe('HU #12997 · AC6 — la fila de una incompleta y de una descartada', () => {
  test('incompleta: chip, último intento, VIN en mono, «—» en Solicitado/Pagado, sin casilla ni antigüedad', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const cap = await mockCola(page);
    await page.goto('/flito/soat');
    await pastilla(page, 'Por validar').click();
    await expect(pastilla(page, 'Por validar')).toHaveAttribute('aria-pressed', 'true');

    const fila = tabla(page).locator('tbody tr').first();
    await expect(fila.locator('.font-mono')).toHaveText(VIN_INC);
    await expect(fila).toContainText('Datos del RUNT pendientes');
    await expect(fila).toContainText('Por validar');
    await expect(fila).toContainText(/Último intento: /);
    await expect(fila.getByRole('checkbox')).toHaveCount(0);
    // HU #12998: admin tiene `soat.solicitud.reintentar_runt` de partida, así que la incompleta
    // ofrece además «Reintentar consulta».
    await expect(fila.getByRole('button')).toHaveText(['Reintentar consulta', 'Ver']);
    // Solicitado y Pagado «—» (con Gestiona y Valor, en Operaciones son cuatro).
    await expect(fila.locator('td', { hasText: /^—$/ })).toHaveCount(4);
    // En la pastilla la cola de SOAT no se pide; la de «Todos» ya se había pedido al entrar.
    const colasAlEntrar = cap.colas.length;
    await pastilla(page, 'Descartadas').click();
    await expect(tabla(page).locator('tbody tr').first()).toContainText('Descartada');
    expect(cap.colas.length).toBe(colasAlEntrar);
  });

  test('descartada: chip «Descartada» y solo «Ver»', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await page.goto('/flito/soat');
    await pastilla(page, 'Descartadas').click();
    const fila = tabla(page).locator('tbody tr').first();
    await expect(fila).toContainText(VIN_DESC);
    await expect(fila).toContainText('Descartada');
    await expect(fila).not.toContainText('Último intento');
    await expect(fila.getByRole('button')).toHaveText(['Ver']);
  });
});

test.describe('HU #12997 · AC7 — el detalle', () => {
  test('incompleta: bloque «Pendiente de validar con el RUNT», VIN, compañía, propietario y factura; sin GET /soat/:id', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    const cap = await mockCola(page);
    await page.goto('/flito/soat');
    await tabla(page).locator('tbody tr').first().getByRole('button', { name: 'Ver' }).click();

    const modal = page.getByRole('dialog');
    await expect(modal.getByRole('heading', { name: 'Pendiente de validar con el RUNT' })).toBeVisible();
    await expect(modal).toContainText('La placa, la marca, la línea y la ficha técnica las trae el RUNT. Aparecerán aquí cuando la consulta responda.');
    await expect(modal).toContainText(/Último intento: 28 de septiembre de 2026/);
    await expect(modal).toContainText('FLITO volverá a consultar el RUNT.');
    await expect(modal).toContainText('Concesionario Norte');
    await expect(modal).toContainText('Ana Pérez');
    await expect(modal).toContainText('factura-venta.pdf');
    // Sin acciones de reintento en esta HU (llegan con la #12998).
    await expect(modal.getByRole('button', { name: /Reintentar consulta/ })).toHaveCount(0);
    // (En dev, StrictMode monta el efecto dos veces: lo que importa es que solo se pidió ESTE id.)
    expect(cap.detalles.length).toBeGreaterThan(0);
    expect(new Set(cap.detalles)).toEqual(new Set([ID_INC]));
    expect(cap.soatPorId).toHaveLength(0);
  });

  test('descartada: motivo, cuándo, quién («FLITO») y la constancia', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    const cap = await mockCola(page);
    await page.goto('/flito/soat');
    await pastilla(page, 'Descartadas').click();
    await tabla(page).locator('tbody tr').first().getByRole('button', { name: 'Ver' }).click();

    const modal = page.getByRole('dialog');
    await expect(modal.getByRole('heading', { name: 'Solicitud descartada' })).toBeVisible();
    await expect(modal).toContainText('El RUNT no tiene registrado ese VIN.');
    await expect(modal).toContainText(/28 de septiembre de 2026/);
    await expect(modal.locator('dd', { hasText: /^FLITO$/ })).toBeVisible();
    await expect(modal).toContainText('La solicitud no se borra: queda aquí como constancia.');
    await expect(modal.getByRole('heading', { name: 'Pendiente de validar con el RUNT' })).toHaveCount(0);
    expect(cap.soatPorId).toHaveLength(0);
  });

  test('sin soat.incompleta.ver la fila no ofrece «Ver»', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL, {
      funciones: ['soat.cola.ver', 'soat.cola.filtrar', 'soat.solicitud.ver', 'soat.solicitud.crear', 'soat.incompletas.buscar'],
    });
    await mockCola(page);
    await page.goto('/flito/soat');
    await pastilla(page, 'Por validar').click();
    await expect(tabla(page).locator('tbody tr').first().getByRole('button', { name: 'Ver' })).toHaveCount(0);
  });
});

test.describe('HU #12997 · AC8 — los cuatro estados de las pastillas nuevas', () => {
  test('vacíos literales por pastilla', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page, { incompletas: [], descartadas: [] });
    await page.goto('/flito/soat');
    await pastilla(page, 'Por validar').click();
    await expect(page.getByText('No hay solicitudes por validar. Cuando el RUNT no responde al pedir un SOAT, la solicitud queda aquí para volver a consultarla.')).toBeVisible();
    await pastilla(page, 'Descartadas').click();
    await expect(page.getByText('No hay solicitudes descartadas. Aquí quedan, sin borrarse, las que el RUNT no dejó continuar.')).toBeVisible();
  });

  test('vacío con búsqueda: «Ningún SOAT coincide con los filtros.»', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page, { incompletas: [], descartadas: [] });
    await page.goto('/flito/soat');
    await pastilla(page, 'Por validar').click();
    await page.getByLabel('Buscar SOAT').fill('ZZZ');
    await expect(page.getByText('Ningún SOAT coincide con los filtros.')).toBeVisible();
  });

  test('cargando: esqueleto; error: tarjeta con «Reintentar» que vuelve a pedir, sin el error crudo', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    const cap = await mockCola(page, { falloBuscar: true });
    let soltar: () => void = () => {};
    const retenida = new Promise<void>((r) => { soltar = r; });
    await page.goto('/flito/soat');
    await expect(page.getByText('No pudimos cargar sus solicitudes.')).toBeVisible();
    await page.route(/\/api\/flito\/soat\/cliente\/incompletas\/buscar$/, async (r) => {
      cap.buscadas.push(r.request().postDataJSON() as Buscar);
      await retenida;
      return json(r, 200, { items: [INCOMPLETA], total: 1, conteos: { incompleta: 1, descartada: 0 } });
    });
    await pastilla(page, 'Por validar').click();
    await expect(page.locator('[aria-busy="true"]').first()).toBeVisible();
    soltar();
    await expect(tabla(page).locator('tbody tr').first()).toContainText(VIN_INC);
    await expect(page.getByText('boom interno')).toHaveCount(0);
  });

  test('error en la pastilla: «Reintentar» vuelve a pedir buscar', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    const cap = await mockCola(page, { falloBuscar: true });
    await page.goto('/flito/soat');
    await pastilla(page, 'Descartadas').click();
    await expect(page.getByText('No pudimos cargar sus solicitudes.')).toBeVisible();
    const antes = cap.buscadas.length;
    await page.getByRole('button', { name: 'Reintentar' }).click();
    await expect.poll(() => cap.buscadas.length).toBeGreaterThan(antes);
  });
});

// AC9 («Ir a mis SOAT» abre «Por validar» por estado del router) se prueba donde nace el clic, con
// la tarjeta de verdad: `soat-vin-unico-ficha-runt.spec.ts`, HU #12996 · AC3/AC8.
