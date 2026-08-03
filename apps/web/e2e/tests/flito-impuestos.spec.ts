import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, AUDITOR_USER } from '../helpers/auth';

// FLITO — Impuestos (Fase 6). Cola por organismo: factura de venta como
// precondición, envío atómico y solo-lectura para Auditoría. Backend mockeado.
// Contingencia (HU #11158): quién gestiona cada impuesto, su filtro y el traspaso a Operaciones.

/**
 * El gestor de impuestos se declara aquí y no en `helpers/auth`: ese helper lo añade la HU #11151,
 * que va por su propia rama y entra a develop antes que esta. Duplicarlo en el helper desde aquí
 * chocaría en el merge; declararlo local no le cuesta nada al spec.
 */
const GESTOR_IMPUESTOS_USER = {
  id: 11,
  username: 'e2e_gestor_impuestos',
  name: 'Gestor Impuestos E2E',
  role: 'gestor_impuestos' as const,
  allowedPages: [] as string[],
};

const IMPUESTOS = [
  {
    id: 'i1', tramiteId: 't1', idFlit: 'FLIT-1001', placa: 'ABC123', vin: 'VIN0000000000001',
    estado: 'pendiente', compradorNombre: 'Ana Pérez', compradorDocumento: '10101010',
    companiaNombre: 'Concesionario Norte', organismoCodigo: 'STT-MZL', organismoNombre: 'STT Manizales',
    valorLiquidado: 120000, valorPagado: null, marcadoPorDiferencia: false, tieneFacturaVenta: true,
    enviadoPorNombre: null, enviadoEn: null, estancado: false, motivoRechazo: null, creadoEn: '2026-04-01T12:00:00Z',
    gestionOperaciones: false,
  },
  {
    id: 'i2', tramiteId: 't2', idFlit: 'FLIT-1002', placa: 'XYZ789', vin: 'VIN0000000000002',
    estado: 'solicitado', compradorNombre: 'Luis Gómez', compradorDocumento: '20202020',
    companiaNombre: 'Concesionario Sur', organismoCodigo: 'STT-PER', organismoNombre: 'STT Pereira',
    valorLiquidado: 200000, valorPagado: null, marcadoPorDiferencia: false, tieneFacturaVenta: true,
    enviadoPorNombre: 'Operaciones E2E', enviadoEn: '2026-04-02T12:00:00Z', estancado: false, motivoRechazo: null, creadoEn: '2026-04-02T12:00:00Z',
    gestionOperaciones: false,
  },
  {
    id: 'i3', tramiteId: 't3', idFlit: 'FLIT-1003', placa: 'OPS001', vin: 'VIN0000000000003',
    estado: 'solicitado', compradorNombre: 'Marta Ruiz', compradorDocumento: '30303030',
    companiaNombre: 'Concesionario Sur', organismoCodigo: 'STT-PER', organismoNombre: 'STT Pereira',
    valorLiquidado: 150000, valorPagado: null, marcadoPorDiferencia: false, tieneFacturaVenta: true,
    enviadoPorNombre: 'Operaciones E2E', enviadoEn: '2026-04-03T12:00:00Z', estancado: false, motivoRechazo: null, creadoEn: '2026-04-03T12:00:00Z',
    gestionOperaciones: true,
  },
];

const FACETAS = {
  companias: [{ id: 1, nombre: 'Concesionario Norte' }, { id: 2, nombre: 'Concesionario Sur' }],
  organismos: [{ codigo: '05001', nombre: 'STT Medellín' }, { codigo: '05266', nombre: 'STT Envigado' }],
};

/** Guarda las URLs que pidió la página, para poder comprobar QUÉ filtros viajaron. */
const urlsPedidas: string[] = [];

async function mock(page: import('@playwright/test').Page) {
  urlsPedidas.length = 0;
  await page.route(/\/api\/flito\/impuestos\/facetas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FACETAS) }));
  await page.route(/\/api\/flito\/impuestos\?/, (route) => {
    const url = new URL(route.request().url());
    urlsPedidas.push(url.search);
    const estado = url.searchParams.get('estado');
    const gestion = url.searchParams.get('gestion');
    let items = estado ? IMPUESTOS.filter((i) => i.estado === estado) : IMPUESTOS;
    // El servidor es quien filtra de verdad; el mock lo imita para que el total y las filas cuadren.
    if (gestion) items = items.filter((i) => i.gestionOperaciones === (gestion === 'operaciones'));
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ items, total: items.length, page: 1, pageSize: 50 }),
    });
  });
}

test.describe('FLITO — Impuestos', () => {
  test('operaciones lista, filtra y abre detalle', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);

    await page.goto('/flito/impuestos');
    await expect(page.getByRole('heading', { name: 'Impuestos', exact: true })).toBeVisible();
    await expect(page.getByText('ABC123')).toBeVisible();
    await expect(page.getByText('XYZ789')).toBeVisible();

    await page.getByRole('button', { name: 'Solicitado', exact: true }).click();
    await expect(page.getByText('XYZ789')).toBeVisible();
    await expect(page.getByText('ABC123')).toHaveCount(0);

    await page.getByRole('button', { name: 'Ver' }).first().click();
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();
    await expect(modal.getByText('Luis Gómez')).toBeVisible();
  });

  test('seleccionar pendientes envía al gestor', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    let enviado: unknown = null;
    await page.route(/\/api\/flito\/impuestos\/enviar$/, (route) => {
      enviado = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enviados: ['i1'], yaEnviados: [] }) });
    });

    await page.goto('/flito/impuestos');
    await page.getByLabel('Seleccionar ABC123').check();
    await expect(page.getByText('1 seleccionado(s)')).toBeVisible();
    await page.getByRole('button', { name: /Enviar al gestor/i }).click();
    await expect.poll(() => enviado).not.toBeNull();
  });

  // ── Contingencia: gestión por Operaciones (HU #11158) ──────────────────────────────────────

  test('AC1 · «Gestionar en Operaciones» marca el envío, y el otro botón lo deja como estaba', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    const cuerpos: Record<string, unknown>[] = [];
    await page.route(/\/api\/flito\/impuestos\/enviar$/, (route) => {
      cuerpos.push(route.request().postDataJSON());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enviados: ['i1'], yaEnviados: [] }) });
    });

    await page.goto('/flito/impuestos');
    await page.getByLabel('Seleccionar ABC123').check();
    await page.getByRole('button', { name: 'Gestionar en Operaciones' }).click();
    await expect.poll(() => cuerpos.length).toBe(1);
    expect(cuerpos[0]).toEqual({ ids: ['i1'], gestionOperaciones: true });

    // El envío normal no acarrea la marca: sin ella el backend no puede confundir un destino con otro.
    await page.getByLabel('Seleccionar ABC123').check();
    await page.getByRole('button', { name: 'Enviar al gestor' }).click();
    await expect.poll(() => cuerpos.length).toBe(2);
    expect(cuerpos[1]).toEqual({ ids: ['i1'] });
  });

  test('AC2 · la cola dice quién gestiona cada impuesto, sin perder el organismo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);

    await page.goto('/flito/impuestos');
    const fila = page.getByRole('row').filter({ hasText: 'OPS001' });
    await expect(fila.getByText('Operaciones', { exact: true })).toBeVisible();
    await expect(fila.getByText('STT Pereira')).toBeVisible();

    const propia = page.getByRole('row').filter({ hasText: 'XYZ789' });
    await expect(propia.getByText('Gestor del organismo')).toBeVisible();
  });

  test('AC3 · acotar a los que gestiona Operaciones viaja al servidor y cuadra el total', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);

    await page.goto('/flito/impuestos');
    await expect(page.getByText('ABC123')).toBeVisible();

    await page.getByLabel('Gestiona').selectOption('operaciones');
    await expect(page.getByText('OPS001')).toBeVisible();
    await expect(page.getByText('ABC123')).toHaveCount(0);
    await expect(page.getByText('XYZ789')).toHaveCount(0);
    expect(urlsPedidas.at(-1)).toContain('gestion=operaciones');

    await page.getByRole('button', { name: 'Limpiar filtros' }).click();
    await expect(page.getByText('ABC123')).toBeVisible();
    expect(urlsPedidas.at(-1)).not.toContain('gestion=');
  });

  test('AC4 · asumir desde el detalle lo actualiza sin cerrar el modal', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    // Tras asumirlo, la cola devuelve el impuesto ya marcado: es lo que hará el servidor.
    let asumido = false;
    await page.route(/\/api\/flito\/impuestos\/facetas/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FACETAS) }));
    await page.route(/\/api\/flito\/impuestos\?/, (route) => {
      const items = IMPUESTOS.filter((i) => i.id === 'i2').map((i) => ({ ...i, gestionOperaciones: asumido }));
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ items, total: items.length, page: 1, pageSize: 50 }),
      });
    });
    let enviado: unknown = null;
    await page.route(/\/api\/flito\/impuestos\/i2\/asumir-operaciones$/, (route) => {
      enviado = route.request().postDataJSON(); asumido = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/flito/impuestos');
    await page.getByRole('button', { name: 'Ver' }).first().click();
    const modal = page.getByRole('dialog');
    await expect(modal.getByText('Gestor del organismo')).toBeVisible();

    await modal.getByRole('button', { name: 'Asumir en Operaciones' }).click();
    await modal.getByRole('textbox', { name: /Motivo para asumirlo/ }).fill('El gestor del organismo no responde');
    await modal.getByRole('button', { name: 'Confirmar' }).click();

    await expect.poll(() => enviado).toEqual({ motivo: 'El gestor del organismo no responde' });
    // Sigue abierto y ya refleja el traspaso, con la acción inversa disponible.
    await expect(modal).toBeVisible();
    await expect(modal.getByText('Operaciones (contingencia)')).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Devolver al gestor' })).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Asumir en Operaciones' })).toHaveCount(0);
  });

  test('el detalle que sale de la vista filtrada no resucita al limpiar los filtros', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    // Mock propio: el fixture compartido es constante, y este caso necesita que el impuesto cambie
    // de gestor a mitad de la prueba.
    let deOperaciones = true;
    await page.route(/\/api\/flito\/impuestos\/facetas/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FACETAS) }));
    await page.route(/\/api\/flito\/impuestos\?/, (route) => {
      const gestion = new URL(route.request().url()).searchParams.get('gestion');
      const fila = { ...IMPUESTOS[2], gestionOperaciones: deOperaciones };
      const items = gestion ? [fila].filter((i) => i.gestionOperaciones === (gestion === 'operaciones')) : [fila];
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ items, total: items.length, page: 1, pageSize: 50 }),
      });
    });
    await page.route(/\/api\/flito\/impuestos\/i3\/devolver-gestor$/, (route) => {
      deOperaciones = false;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/flito/impuestos');
    await page.getByLabel('Gestiona').selectOption('operaciones');
    await page.getByRole('row').filter({ hasText: 'OPS001' }).getByRole('button', { name: 'Ver' }).click();
    const modal = page.getByRole('dialog');
    await modal.getByRole('button', { name: 'Devolver al gestor' }).click();
    await modal.getByRole('textbox', { name: /Motivo de la devolución/ }).fill('El gestor del organismo ya puede retomarlo');
    await modal.getByRole('button', { name: 'Confirmar' }).click();

    // Al dejar de gestionarlo Operaciones sale de la vista filtrada y el modal se va con la fila.
    await expect(modal).toHaveCount(0);

    await page.getByRole('button', { name: 'Limpiar filtros' }).click();
    await expect(page.getByText('OPS001')).toBeVisible();
    // Aquí es donde antes reaparecía solo, porque el detalle seguía apuntando a ese impuesto.
    await expect(modal).toHaveCount(0);
  });

  test('AC5 · sin motivo no se confirma, y el error del servidor no borra lo escrito', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.route(/\/api\/flito\/impuestos\/i2\/asumir-operaciones$/, (route) =>
      route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Este impuesto ya lo gestiona Operaciones' }) }));

    await page.goto('/flito/impuestos');
    // El Pendiente no se traspasa: aún no se ha enviado a nadie. Se abre el que sí está En gestión.
    await page.getByRole('row').filter({ hasText: 'XYZ789' }).getByRole('button', { name: 'Ver' }).click();
    const modal = page.getByRole('dialog');
    await modal.getByRole('button', { name: 'Asumir en Operaciones' }).click();

    const confirmar = modal.getByRole('button', { name: 'Confirmar' });
    await expect(confirmar).toBeDisabled();
    const campo = modal.getByRole('textbox', { name: /Motivo para asumirlo/ });
    await campo.fill('cuat');
    await expect(confirmar).toBeDisabled();

    await campo.fill('cinco');
    await expect(confirmar).toBeEnabled();
    await confirmar.click();
    await expect(modal.getByText('Este impuesto ya lo gestiona Operaciones')).toBeVisible();
    await expect(campo).toHaveValue('cinco');
  });

  test('AC7 · al gestor del organismo no le aparece nada de la contingencia', async ({ page }) => {
    await loginAs(page, GESTOR_IMPUESTOS_USER);
    await mock(page);

    await page.goto('/flito/impuestos');
    await expect(page.getByRole('button', { name: 'Gestionar en Operaciones' })).toHaveCount(0);
    await expect(page.getByLabel('Gestiona')).toHaveCount(0);

    await page.getByRole('button', { name: 'Ver' }).first().click();
    const modal = page.getByRole('dialog');
    await expect(modal.getByRole('button', { name: 'Asumir en Operaciones' })).toHaveCount(0);
    await expect(modal.getByRole('button', { name: 'Devolver al gestor' })).toHaveCount(0);
  });

  test('AC7 · el auditor ve quién gestiona pero no puede traspasarlo', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mock(page);

    await page.goto('/flito/impuestos');
    const fila = page.getByRole('row').filter({ hasText: 'OPS001' });
    await expect(fila.getByText('Operaciones', { exact: true })).toBeVisible();

    // Abrir el detalle del que ya gestiona Operaciones: es donde aparecería el botón de devolver.
    await fila.getByRole('button', { name: 'Ver' }).click();
    const modal = page.getByRole('dialog');
    await expect(modal.getByText('Operaciones (contingencia)')).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Devolver al gestor' })).toHaveCount(0);
    await expect(modal.getByRole('button', { name: 'Asumir en Operaciones' })).toHaveCount(0);
  });

  test('auditor ve detalle en solo lectura', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mock(page);

    await page.goto('/flito/impuestos');
    await page.getByRole('button', { name: 'Ver' }).first().click();
    await expect(page.getByText(/Solo lectura · Auditoría/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rechazar' })).toHaveCount(0);
  });
});
