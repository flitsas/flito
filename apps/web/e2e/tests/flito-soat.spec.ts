import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, AUDITOR_USER, PROVEEDOR_USER } from '../helpers/auth';

// FLITO — Portal SOAT (Fase 6). Cola de adquisición: envío atómico al gestor,
// detalle por VIN y solo-lectura para Auditoría. Backend mockeado.

const PROVEEDORES = [{ id: 'p1', nombre: 'Seguros Alfa', activo: true }];

const SOAT = [
  {
    id: 's1', vin: 'VIN0000000000001', placa: 'ABC123', marca: 'Chevrolet', linea: 'Onix',
    estado: 'pendiente', esMultiplePropietario: false, companiaNombre: 'Concesionario Norte',
    organismoNombre: 'STT Manizales', proveedorSoatId: null, proveedorSoatNombre: null,
    compradores: [{ nombreCompleto: 'Ana Pérez', numeroDocumento: '10101010', orden: 0, porcentajeParticipacion: null }],
    tramitesFlit: ['FLIT-1001'], tipoTramite: 'Matricula',
    fechaAprobacion: null, fechaCreacion: '2026-03-28T10:00:00Z',
    enviadoPorNombre: null, enviadoEn: null,
    pagadoEn: null, valorPagado: null, estancado: false, motivoRechazo: null, creadoEn: '2026-04-01T12:00:00Z',
    gestionOperaciones: false,
  },
  {
    id: 's2', vin: 'VIN0000000000002', placa: 'XYZ789', marca: 'Renault', linea: 'Kwid',
    estado: 'solicitado', esMultiplePropietario: false, companiaNombre: 'Concesionario Sur',
    organismoNombre: 'STT Pereira', proveedorSoatId: 'p1', proveedorSoatNombre: 'Seguros Alfa',
    compradores: [{ nombreCompleto: 'Luis Gómez', numeroDocumento: '20202020', orden: 0, porcentajeParticipacion: null }],
    tramitesFlit: ['FLIT-1002'], tipoTramite: 'Traspaso',
    fechaAprobacion: '2026-04-03T12:00:00Z', fechaCreacion: '2026-04-01T10:00:00Z',
    enviadoPorNombre: 'Operaciones E2E', enviadoEn: '2026-04-02T12:00:00Z',
    pagadoEn: null, valorPagado: null, estancado: false, motivoRechazo: null, creadoEn: '2026-04-02T12:00:00Z',
    gestionOperaciones: false,
  },
  {
    id: 's3', vin: 'VIN0000000000003', placa: 'PAG777', marca: 'Mazda', linea: 'CX-30',
    estado: 'pagado', esMultiplePropietario: false, companiaNombre: 'Concesionario Sur',
    organismoNombre: 'STT Pereira', proveedorSoatId: 'p1', proveedorSoatNombre: 'Seguros Alfa',
    compradores: [{ nombreCompleto: 'Sara Ríos', numeroDocumento: '30303030', orden: 0, porcentajeParticipacion: null }],
    tramitesFlit: ['FLIT-1003'], enviadoPorNombre: 'Operaciones E2E', enviadoEn: '2026-04-02T12:00:00Z',
    pagadoEn: '2026-04-05T12:00:00Z', valorPagado: 740800, estancado: false, motivoRechazo: null,
    gestionOperaciones: false,
    creadoEn: '2026-04-02T12:00:00Z',
  },
];

const FACETAS = {
  companias: [{ id: 1, nombre: 'Concesionario Norte' }, { id: 2, nombre: 'Concesionario Sur' }],
  organismos: [{ codigo: '17001', nombre: 'STT Manizales' }, { codigo: '66001', nombre: 'STT Pereira' }],
  proveedores: [{ id: 'p1', nombre: 'Seguros Alfa' }],
};

/** Guarda las URLs que pidió la página, para poder comprobar QUÉ filtros viajaron. */
const urlsPedidas: string[] = [];

async function mock(page: import('@playwright/test').Page) {
  urlsPedidas.length = 0;
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROVEEDORES) }));
  await page.route(/\/api\/flito\/soat\/facetas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FACETAS) }));
  await page.route(/\/api\/flito\/soat\?/, (route) => {
    const url = new URL(route.request().url());
    urlsPedidas.push(url.search);
    const estado = url.searchParams.get('estado');
    const items = estado ? SOAT.filter((s) => s.estado === estado) : SOAT;
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ items, total: items.length, page: 1, pageSize: 50 }),
    });
  });
}

test.describe('FLITO — Portal SOAT', () => {
  test('operaciones lista, filtra y abre detalle', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);

    await page.goto('/flito/soat');
    await expect(page.getByRole('heading', { name: 'SOAT', exact: true })).toBeVisible();
    await expect(page.getByText('ABC123')).toBeVisible();
    await expect(page.getByText('XYZ789')).toBeVisible();

    await page.getByRole('button', { name: 'Solicitado', exact: true }).click();
    await expect(page.getByText('XYZ789')).toBeVisible();
    await expect(page.getByText('ABC123')).toHaveCount(0);

    await page.getByRole('button', { name: 'Ver' }).first().click();
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();
    await expect(modal.getByText('Seguros Alfa')).toBeVisible();
  });

  test('seleccionar pendientes envía al gestor', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    let enviado: unknown = null;
    await page.route(/\/api\/flito\/soat\/enviar$/, (route) => {
      enviado = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enviados: ['s1'], yaEnviados: [] }) });
    });

    await page.goto('/flito/soat');
    await page.getByLabel('Seleccionar ABC123').check();
    await expect(page.getByText('1 seleccionado(s)')).toBeVisible();

    // El proveedor es obligatorio desde que se retiraron las reglas de enrutamiento (HU #10979):
    // sin él el SOAT nacería sin proveedor y quedaría en la cola de nadie.
    const enviar = page.getByRole('button', { name: /Enviar al gestor/i });
    await expect(enviar).toBeDisabled();
    // Dos selectores en la página desde la HU #11157 (filtro «Gestiona» y destino del envío).
    await page.getByLabel('Enviar a').selectOption('p1');

    await enviar.click();
    await expect.poll(() => enviado).not.toBeNull();
    expect(enviado).toMatchObject({ proveedorSoatId: 'p1' });
  });

  test('auditor ve detalle en solo lectura', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mock(page);

    await page.goto('/flito/soat');
    await page.getByRole('button', { name: 'Ver' }).first().click();
    await expect(page.getByText(/Solo lectura · Auditoría/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rechazar' })).toHaveCount(0);
  });
  test('los filtros de la cola viajan al servidor', async ({ page }) => {
    // Se comprueba sobre la petición, no sobre las filas: el filtrado ocurre en SQL, así que lo
    // que importa es que el parámetro llegue.
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/soat');
    await expect(page.getByText('ABC123')).toBeVisible();

    await page.getByRole('checkbox', { name: 'Solo sin gestión' }).check();
    await expect.poll(() => urlsPedidas.at(-1) ?? '').toContain('estancado=si');

    // Cada rango es un calendario propio (HU #11026): el tramo viaja entero, no campo a campo.
    const rango = (etiqueta: string) => page.locator('summary').filter({ hasText: etiqueta });
    await rango('Solicitado').click();
    await page.getByRole('button', { name: '30 días' }).click();
    await expect.poll(() => urlsPedidas.at(-1) ?? '').toContain('solicitadoDesde=');
    expect(urlsPedidas.at(-1)).toContain('solicitadoHasta=');

    await rango('Pagado').click();
    await page.getByRole('button', { name: 'Hoy' }).click();
    await expect.poll(() => urlsPedidas.at(-1) ?? '').toContain('pagadoHasta=');
    // El rango de pago no pisa el de solicitud.
    expect(urlsPedidas.at(-1)).toContain('solicitadoDesde=');
  });

  test('la búsqueda consulta una vez tras la pausa, no en cada tecla', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/soat');
    await expect(page.getByText('ABC123')).toBeVisible();

    const antes = urlsPedidas.length;
    await page.getByPlaceholder('Buscar placa, VIN, comprador…').fill('ABC123');
    await expect.poll(() => urlsPedidas.at(-1) ?? '').toContain('buscar=ABC123');
    // Seis pulsaciones, una sola consulta: sin el retardo serían seis.
    expect(urlsPedidas.length - antes).toBe(1);
  });

  test('limpiar filtros los quita todos de la petición', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/soat');
    await page.getByRole('checkbox', { name: 'Solo sin gestión' }).check();
    await expect.poll(() => urlsPedidas.at(-1) ?? '').toContain('estancado=si');

    await page.getByRole('button', { name: 'Limpiar filtros' }).click();
    await expect.poll(() => urlsPedidas.at(-1) ?? '').not.toContain('estancado');
  });

  test('un SOAT pagado no muestra los días desde la solicitud', async ({ page }) => {
    // Ya pagado, la antigüedad deja de ser una señal de riesgo: el chip de sin gestión tampoco se
    // pinta, y dejar los días sueltos hacía parecer atrasado algo que ya está resuelto.
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/soat');

    const pendienteDeGestion = page.getByRole('row').filter({ hasText: 'XYZ789' });
    await expect(pendienteDeGestion.getByText(/^(Hoy|\d+ días?)$/)).toHaveCount(1);

    const pagado = page.getByRole('row').filter({ hasText: 'PAG777' });
    await expect(pagado.getByText(/^(Hoy|\d+ días?)$/)).toHaveCount(0);
  });

  test('el detalle cuenta por dónde ha pasado el SOAT, y quién lo movió', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    let pedido = 0;
    await page.route(/\/api\/flito\/soat\/[^/]+\/historial/, (route) => {
      pedido += 1;
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify([
          { id: 3, estadoAnterior: 'solicitado', estadoNuevo: 'pagado', motivo: 'Pago confirmado por factura. Valor 740800.', usuario: 'Gestor Alfa', origen: 'usuario', creadoEn: '2026-04-05T15:00:00Z' },
          { id: 2, estadoAnterior: 'pendiente', estadoNuevo: 'solicitado', motivo: 'Envío al gestor', usuario: 'Operaciones E2E', origen: 'usuario', creadoEn: '2026-04-02T12:00:00Z' },
          { id: 1, estadoAnterior: null, estadoNuevo: 'pendiente', motivo: 'Alta desde FLIT (trámite FLIT-1002).', usuario: null, origen: 'sistema', creadoEn: '2026-04-01T09:00:00Z' },
        ]),
      });
    });

    await page.goto('/flito/soat');
    await page.getByRole('row').filter({ hasText: 'XYZ789' }).getByRole('button', { name: 'Ver' }).click();

    // Plegado por defecto: el detalle ya es largo y el historial es la segunda pregunta. Y no se
    // pide hasta abrirlo — precargarlo sería una consulta por fila de la cola.
    expect(pedido).toBe(0);
    await page.getByRole('button', { name: 'Ver el historial de estados' }).click();

    // Acotado a la entrada del historial: «Operaciones E2E» sale también en la fila de la cola y en
    // el «Enviado por» del detalle, y sin acotar la aserción no distinguiría de cuál habla.
    const envio = page.getByRole('listitem').filter({ hasText: 'Envío al gestor' });
    await expect(envio).toContainText('Operaciones E2E');
    await expect(envio).toContainText('Pendiente');
    await expect(envio).toContainText('Solicitado');

    // El alta no tiene estado de partida, y eso se rotula en vez de dejar un hueco.
    const alta = page.getByRole('listitem').filter({ hasText: 'Alta desde FLIT' });
    await expect(alta).toContainText('Alta');
    // Un cambio del sistema no puede parecer obra de una persona sin nombre.
    await expect(alta).toContainText('Sistema');
  });

  test('la cola enseña tipo de trámite y las dos fechas, como las demás tablas', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/soat');

    const fila = page.getByRole('row').filter({ hasText: 'XYZ789' });
    await expect(fila).toContainText('Traspaso');
    await expect(fila).toContainText('FLIT-1002');
    // Un SOAT sin aprobar lo dice, en vez de un guion que se confunde con «no llegó la fecha».
    await expect(page.getByRole('row').filter({ hasText: 'ABC123' })).toContainText('Sin aprobar');
  });

  test('el filtro inteligente «listos para enviar» no se le ofrece al gestor', async ({ page }) => {
    // Los Pendiente quedan fuera de su frontera (CA-09): el preset le devolvería siempre una lista
    // vacía y parecería que no hay trabajo.
    await loginAs(page, PROVEEDOR_USER);
    await mock(page);
    await page.goto('/flito/soat');

    await page.locator('summary').filter({ hasText: 'Vista' }).click();
    await expect(page.getByRole('button', { name: /Listos para enviar/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Sin gestión/ })).toBeVisible();
  });

  test('aplicar un preset pone TODAS sus condiciones, no solo la primera', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const urls: string[] = [];
    await mock(page);
    await page.route(/\/api\/flito\/soat\?/, (route) => {
      urls.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], total: 0, page: 1, pageSize: 50 }) });
    });

    await page.goto('/flito/soat');
    await page.locator('summary').filter({ hasText: 'Vista' }).click();
    await page.getByRole('button', { name: /Sin gestión/ }).click();

    // Las dos condiciones a la vez. Que viaje solo una es justo el error que el preset evita.
    await expect.poll(() => urls.at(-1) ?? '').toContain('estado=solicitado');
    await expect.poll(() => urls.at(-1) ?? '').toContain('estancado=si');
  });

  test('un SOAT sin movimientos lo dice, en vez de quedarse en blanco', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.route(/\/api\/flito\/soat\/[^/]+\/historial/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/flito/soat');
    await page.getByRole('row').filter({ hasText: 'ABC123' }).getByRole('button', { name: 'Ver' }).click();
    await page.getByRole('button', { name: 'Ver el historial de estados' }).click();
    await expect(page.getByText('Sin movimientos registrados.')).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HU #11157 — contingencia en la interfaz: elegir «Gestionado por Operaciones» al enviar, y asumir
// o devolver un SOAT que ya está con un proveedor.
//
// Este bloque monta su propio listado y registra sus rutas DESPUÉS de `mock()`, que en Playwright
// es lo que les da prioridad: así el fixture compartido no cambia y los 12 casos previos siguen
// contando lo mismo.

/** SOAT que Operaciones retomó del proveedor p1. Conserva el proveedor a propósito (HU #11153). */
const SOAT_CONTINGENCIA = {
  id: 'c1', vin: 'VIN0000000000009', placa: 'OPS001', marca: 'Kia', linea: 'Picanto',
  estado: 'solicitado', esMultiplePropietario: false, companiaNombre: 'Concesionario Sur',
  organismoNombre: 'STT Pereira', proveedorSoatId: 'p1', proveedorSoatNombre: 'Seguros Alfa',
  gestionOperaciones: true,
  compradores: [], tramitesFlit: ['FLIT-1009'], tipoTramite: 'Traspaso',
  fechaAprobacion: null, fechaCreacion: '2026-04-01T10:00:00Z',
  enviadoPorNombre: 'Operaciones E2E', enviadoEn: '2026-04-02T12:00:00Z',
  pagadoEn: null, valorPagado: null, estancado: false, motivoRechazo: null, creadoEn: '2026-04-02T12:00:00Z',
};

/** Cuerpos de los POST que hizo la página, para afirmar QUÉ se pidió y no solo que se pidió. */
interface PeticionCapturada { url: string; body: unknown }

async function mockContingencia(page: import('@playwright/test').Page, items: unknown[]) {
  const posts: PeticionCapturada[] = [];
  await page.route(/\/api\/flito\/soat\?/, (route) => {
    const url = new URL(route.request().url());
    urlsPedidas.push(url.search);
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ items, total: items.length, page: 1, pageSize: 50 }),
    });
  });
  await page.route(/\/api\/flito\/soat\/(enviar|.*\/(asumir-operaciones|devolver-gestor))/, (route) => {
    posts.push({ url: route.request().url(), body: route.request().postDataJSON() });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.route(/\/api\/flito\/soat\/[^/?]+\/historial/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  return posts;
}

test.describe('FLITO — Portal SOAT · contingencia (HU #11157)', () => {
  test('AC1 — «Gestionado por Operaciones» es una opción del selector y envía la contingencia', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    const posts = await mockContingencia(page, [SOAT[0]]); // el pendiente
    await page.goto('/flito/soat');

    await page.getByRole('checkbox', { name: 'Seleccionar ABC123' }).check();

    const destino = page.getByLabel('Enviar a');
    await expect(destino).toBeVisible();
    // El botón no se habilita hasta elegir destino: un envío sin dueño no debe poder construirse.
    await expect(page.getByRole('button', { name: /^Enviar/ })).toBeDisabled();

    await destino.selectOption({ label: 'Gestionado por Operaciones' });
    const enviar = page.getByRole('button', { name: 'Enviar a Operaciones' });
    await expect(enviar).toBeEnabled();
    await enviar.click();

    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0].body).toEqual({ ids: ['s1'], gestionOperaciones: true });
  });

  test('AC1 — elegir un proveedor sigue enviando el proveedor, sin marcar contingencia', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    const posts = await mockContingencia(page, [SOAT[0]]);
    await page.goto('/flito/soat');

    await page.getByRole('checkbox', { name: 'Seleccionar ABC123' }).check();
    await page.getByLabel('Enviar a').selectOption({ label: 'Seguros Alfa' });
    await page.getByRole('button', { name: 'Enviar al gestor' }).click();

    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0].body).toEqual({ ids: ['s1'], proveedorSoatId: 'p1' });
  });

  test('AC2 — la tabla dice quién gestiona y de quién se retomó', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await mockContingencia(page, [SOAT_CONTINGENCIA, SOAT[1]]);
    await page.goto('/flito/soat');

    const contingencia = page.getByRole('row', { name: /OPS001/ });
    await expect(contingencia).toContainText('Operaciones');
    await expect(contingencia).toContainText('retomado de Seguros Alfa');

    // El gestionado por un proveedor sigue mostrando su nombre, sin distintivo.
    const normal = page.getByRole('row', { name: /XYZ789/ });
    await expect(normal).toContainText('Seguros Alfa');
    await expect(normal).not.toContainText('retomado de');
  });

  test('AC3 — el filtro por quién gestiona viaja al servidor y se limpia', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await mockContingencia(page, [SOAT_CONTINGENCIA]);
    await page.goto('/flito/soat');

    await page.getByLabel('Gestiona').selectOption('operaciones');
    await expect.poll(() => urlsPedidas.at(-1)).toContain('gestion=operaciones');

    await page.getByRole('button', { name: 'Limpiar filtros' }).click();
    await expect.poll(() => urlsPedidas.at(-1)).not.toContain('gestion=');
  });

  test('AC4 y AC6 — asumir desde el detalle exige un motivo de al menos cinco caracteres', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    const posts = await mockContingencia(page, [SOAT[1]]); // solicitado, con proveedor
    await page.goto('/flito/soat');

    await page.getByRole('button', { name: 'Ver' }).first().click();
    await page.getByRole('button', { name: 'Asumir en Operaciones' }).click();

    const confirmar = page.getByRole('button', { name: 'Confirmar' });
    const campoMotivo = page.getByRole('textbox', { name: /Motivo para asumirlo/ });
    await expect(confirmar).toBeDisabled();
    await campoMotivo.fill('abc');
    await expect(confirmar).toBeDisabled();

    await campoMotivo.fill('el proveedor no responde');
    await expect(confirmar).toBeEnabled();
    await confirmar.click();

    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0].url).toContain('/s2/asumir-operaciones');
    expect(posts[0].body).toEqual({ motivo: 'el proveedor no responde' });
  });

  test('AC5 — devolver preselecciona el proveedor del que se retomó', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    const posts = await mockContingencia(page, [SOAT_CONTINGENCIA]);
    await page.goto('/flito/soat');

    await page.getByRole('button', { name: 'Ver' }).first().click();
    // Un SOAT que gestiona Operaciones no ofrece «asumir», ofrece «devolver».
    await expect(page.getByRole('button', { name: 'Asumir en Operaciones' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Devolver al proveedor' }).click();

    await expect(page.getByLabel('Proveedor que lo retoma')).toHaveValue('p1');

    await page.getByRole('textbox', { name: /Motivo de la devolución/ }).fill('ya puede retomarlo');
    await page.getByRole('button', { name: 'Confirmar' }).click();

    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0].url).toContain('/c1/devolver-gestor');
    expect(posts[0].body).toEqual({ proveedorSoatId: 'p1', motivo: 'ya puede retomarlo' });
  });

  test('AC8 — al proveedor no se le ofrece nada de la contingencia', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await mock(page);
    await mockContingencia(page, [SOAT[1]]);
    await page.goto('/flito/soat');

    await expect(page.getByLabel('Gestiona')).toHaveCount(0);
    await page.getByRole('button', { name: 'Ver' }).first().click();
    await expect(page.getByRole('button', { name: 'Asumir en Operaciones' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Devolver al proveedor' })).toHaveCount(0);
  });

  test('AC8 — auditoría ve quién gestiona, pero ninguna acción', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mock(page);
    await mockContingencia(page, [SOAT_CONTINGENCIA]);
    await page.goto('/flito/soat');

    await expect(page.getByRole('row', { name: /OPS001/ })).toContainText('Operaciones');
    await page.getByRole('button', { name: 'Ver' }).first().click();
    await expect(page.getByText('Solo lectura · Auditoría observa, no ejecuta acciones.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Asumir en Operaciones' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Devolver al proveedor' })).toHaveCount(0);
  });
});
