// TRAM-07 — E2E del flujo de matrícula inicial (lado tránsito) · G1.
//
// El wizard del admin produce un trámite en estado `enviado_transito`; este spec
// cubre el tramo crítico y sin cobertura que la auditoría TRAM-04 marcó (G1): la
// bandeja de tránsito que mueve el trámite tomar → asignar-placa → confirmar-placa
// → `solicitud_soat` (que en el backend crea vehículo + solicitud SOAT). También
// valida la migración a `api` client de TRAM-09 (manejo de errores/sesión).
//
// API mockeada con page.route (estado mutable), patrón de los specs PESV.

import { test, expect } from '../helpers/fixtures';
import { loginAs } from '../helpers/auth';
import { jsonRoute } from '../helpers/pesv-fixtures';

const TRANSITO_USER = {
  id: 7,
  username: 'e2e_transito',
  name: 'Tránsito E2E',
  role: 'transito' as const,
  allowedPages: ['dashboard', 'transito'],
  transitoCodigo: '05001',
};

function tramiteBase(id: number) {
  return {
    id,
    vin: 'MMBJYKL10NH000123',
    estado: 'enviado_transito',
    placa: null as string | null,
    created_at: '2026-06-01T10:00:00.000Z',
    vehiculo: { marca: 'Mazda', linea: 'CX-30', modelo: '2024' },
    comprador: { nombre: 'Ana Pérez', documento: '1020304050' },
  };
}

test.describe('Tránsito · Bandeja branding (#128)', () => {
  test('muestra alias y logo del organismo en el header', async ({ page }) => {
    await page.route('**/api/transito/pendientes', (route) => jsonRoute(200, [])(route));
    await page.route('**/api/transito/mis-tramites', (route) => jsonRoute(200, [])(route));
    await page.route('**/api/transito/organismos-config/05001', (route) =>
      jsonRoute(200, {
        codigo: '05001',
        alias: 'STT Medellín',
        logoUrl: 'https://example.com/medellin.png',
      })(route));

    await loginAs(page, TRANSITO_USER);
    await page.goto('/transito');

    await expect(page.getByRole('heading', { name: /bandeja de tránsito — stt medellín/i })).toBeVisible();
    await expect(page.locator('img[src="https://example.com/medellin.png"]')).toBeVisible();
  });
});

test.describe('Tránsito · Bandeja (flujo matrícula)', () => {
  // TransitoBandeja pide /organismos-config/<codigo> para el header; sin mock, la API real de la demo
  // responde 401 → SESSION_ENDED → logout → login (el flujo nunca arranca).
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/transito/organismos-config/05001', (route) =>
      jsonRoute(200, { codigo: '05001', alias: 'STT Medellín', logoUrl: null })(route));
  });

  test('happy path: tomar → asignar placa → confirmar → solicitud_soat', async ({ page }) => {
    const TID = 42;
    let pendientes = [tramiteBase(TID)];
    let mis: any[] = [];

    await page.route('**/api/transito/pendientes', (route) => jsonRoute(200, pendientes)(route));
    await page.route('**/api/transito/mis-tramites', (route) => jsonRoute(200, mis)(route));
    await page.route(`**/api/transito/tomar/${TID}`, (route) => {
      pendientes = pendientes.filter((t) => t.id !== TID);
      const t = { ...tramiteBase(TID), estado: 'recibido_transito' };
      mis = [t];
      return jsonRoute(200, t)(route);
    });
    await page.route(`**/api/transito/asignar-placa/${TID}`, (route) => {
      const placa = (route.request().postDataJSON()?.placa || '').toUpperCase();
      mis = [{ ...tramiteBase(TID), estado: 'placa_preasignada', placa }];
      return jsonRoute(200, mis[0])(route);
    });
    await page.route(`**/api/transito/confirmar-placa/${TID}`, (route) => {
      // solicitud_soat ya no está en el filtro de mis-tramites → desaparece de la lista.
      mis = [];
      return jsonRoute(200, { id: TID, estado: 'solicitud_soat', placa: 'ABC123', vehicleId: 99 })(route);
    });

    await loginAs(page, TRANSITO_USER);
    await page.goto('/transito');

    // Pendiente visible.
    await expect(page.getByText(`MI-${String(TID).padStart(4, '0')}`)).toBeVisible();
    await page.getByRole('button', { name: /tomar trámite/i }).click();

    // Pasó a "Mis trámites" como Recibido.
    await expect(page.getByText(/recibido/i)).toBeVisible();
    const placaInput = page.getByPlaceholder('ABC123');
    await placaInput.fill('ABC123');
    await page.getByRole('button', { name: /asignar placa/i }).click();

    // Preasignada + botón confirmar.
    await expect(page.getByText(/placa preasignada/i)).toBeVisible();
    await expect(page.getByText('Placa: ABC123')).toBeVisible();
    await page.getByRole('button', { name: /confirmar y enviar/i }).click();

    // Confirmado → toast éxito y el trámite sale de la bandeja (solicitud_soat).
    await expect(page.locator('[role="status"]', { hasText: /confirmada/i })).toBeVisible();
    // #128: el vacío de «Mis trámites» es organismo-aware. El usuario tránsito
    // tiene transitoCodigo 05001 → organismo Medellín truthy → copy con ciudad
    // (no el literal genérico «No tiene trámites asignados»).
    await expect(page.getByText(/Sin trámites asignados en Medell[íi]n/i)).toBeVisible();
  });

  test('negativo: confirmar-placa de trámite no tomado → 404 muestra error, no rompe', async ({ page }) => {
    const TID = 50;
    await page.route('**/api/transito/pendientes', (route) => jsonRoute(200, [])(route));
    await page.route('**/api/transito/mis-tramites', (route) =>
      jsonRoute(200, [{ ...tramiteBase(TID), estado: 'placa_preasignada', placa: 'XYZ987' }])(route));
    await page.route(`**/api/transito/confirmar-placa/${TID}`, (route) =>
      jsonRoute(404, { error: 'Trámite no encontrado' })(route));

    await loginAs(page, TRANSITO_USER);
    await page.goto('/transito');

    await page.getByRole('button', { name: /confirmar y enviar/i }).click();
    await expect(page.locator('[role="status"]', { hasText: /no encontrado/i })).toBeVisible();
    // Sigue en la bandeja (no se perdió el estado).
    await expect(page.getByText('Placa: XYZ987')).toBeVisible();
  });

  test('negativo: placa inválida (<4) la bloquea el cliente, no llega al servidor', async ({ page }) => {
    const TID = 60;
    let postReached = false;
    await page.route('**/api/transito/pendientes', (route) => jsonRoute(200, [])(route));
    await page.route('**/api/transito/mis-tramites', (route) =>
      jsonRoute(200, [{ ...tramiteBase(TID), estado: 'recibido_transito' }])(route));
    await page.route(`**/api/transito/asignar-placa/${TID}`, (route) => {
      postReached = true;
      return jsonRoute(200, {})(route);
    });

    await loginAs(page, TRANSITO_USER);
    await page.goto('/transito');

    await page.getByPlaceholder('ABC123').fill('AB');
    await page.getByRole('button', { name: /asignar placa/i }).click();
    await expect(page.locator('[role="status"]', { hasText: /placa válida/i })).toBeVisible();
    expect(postReached).toBeFalsy();
  });
});

// HU #13426 — usuario con enlace `organismos_transito` a varias secretarías: la bandeja muestra una a
// la vez, con selector, y la consulta lleva `?organismo=`. `GET /transito/organismos` es el
// contrato: con enlace trae `porDefecto`; sin enlace, el catálogo sin `porDefecto`.
test.describe('Tránsito · Bandeja con selector de secretaría (HU #13426)', () => {
  const FUNCIONES_TRANSITO = [
    'transito.tramite.tomar', 'transito.bandeja.ver_pendientes', 'transito.organismos.listar', 'firma.estado.ver',
  ];
  const USUARIO_ENLACE = { ...TRANSITO_USER, funciones: FUNCIONES_TRANSITO };
  const MEDELLIN = { codigo: '05001', nombre: 'STRIA TTEyTTO MEDELLIN', ciudad: 'Medellín' };
  const ENVIGADO = { codigo: '05266', nombre: 'STRIA TTEyTTO ENVIGADO', ciudad: 'Envigado' };

  /** Mocks de las listas (con o sin query) y registro de las URLs pedidas. */
  async function mockListas(page: import('@playwright/test').Page, organismos: unknown[]) {
    const pedidas: string[] = [];
    await page.route(/\/api\/transito\/organismos-config\/\d+$/, (route) =>
      jsonRoute(200, { alias: null, logoUrl: null })(route));
    await page.route(/\/api\/transito\/organismos$/, (route) => jsonRoute(200, organismos)(route));
    await page.route(/\/api\/transito\/(pendientes|mis-tramites|traspasos)(\?.*)?$/, (route) => {
      pedidas.push(route.request().url());
      return jsonRoute(200, [])(route);
    });
    return pedidas;
  }

  test('2 secretarías: selector, la cabecera cambia y la consulta lleva ?organismo=05266', async ({ page }) => {
    await loginAs(page, USUARIO_ENLACE);
    const pedidas = await mockListas(page, [{ ...MEDELLIN, porDefecto: true }, ENVIGADO]);
    await page.evaluate(() => localStorage.removeItem('flit.transito.secretaria'));
    await page.goto('/transito');

    await expect(page.getByRole('heading', { name: 'Bandeja de tránsito — Medellín' })).toBeVisible();
    const selector = page.getByLabel('Secretaría');
    await expect(selector).toHaveValue('05001');
    await expect.poll(() => pedidas.some((u) => /pendientes\?organismo=05001$/.test(u))).toBe(true);

    await selector.selectOption('05266');
    await expect(page.getByRole('heading', { name: 'Bandeja de tránsito — Envigado' })).toBeVisible();
    await expect.poll(() => pedidas.some((u) => /pendientes\?organismo=05266$/.test(u))).toBe(true);
    await expect.poll(() => pedidas.some((u) => /mis-tramites\?organismo=05266$/.test(u))).toBe(true);
    await expect(page.getByText('Sin pendientes en Envigado')).toBeVisible();

    // Traspasos combina la misma secretaría.
    await page.getByRole('tab', { name: /traspasos stt/i }).click();
    await expect.poll(() => pedidas.some((u) => /traspasos\?organismo=05266/.test(u))).toBe(true);
  });

  test('1 secretaría: sin selector y esa secretaría en la cabecera', async ({ page }) => {
    await loginAs(page, USUARIO_ENLACE);
    await mockListas(page, [{ ...ENVIGADO, porDefecto: true }]);
    await page.goto('/transito');

    await expect(page.getByRole('heading', { name: 'Bandeja de tránsito — Envigado' })).toBeVisible();
    await expect(page.getByLabel('Secretaría')).toHaveCount(0);
  });

  test('sin enlace (catálogo sin porDefecto): sin selector, como hoy', async ({ page }) => {
    await loginAs(page, USUARIO_ENLACE);
    const pedidas = await mockListas(page, [MEDELLIN, ENVIGADO]);
    await page.goto('/transito');

    await expect(page.getByRole('heading', { name: 'Bandeja de tránsito — Medellín' })).toBeVisible();
    await expect(page.getByLabel('Secretaría')).toHaveCount(0);
    await expect.poll(() => pedidas.length).toBeGreaterThan(0);
    expect(pedidas.every((u) => !u.includes('organismo='))).toBe(true);
  });

  test('error al cargar secretarías: aviso con reintento', async ({ page }) => {
    await loginAs(page, USUARIO_ENLACE);
    await mockListas(page, []);
    let fallar = true;
    await page.route(/\/api\/transito\/organismos$/, (route) =>
      fallar ? jsonRoute(500, { error: 'x' })(route) : jsonRoute(200, [{ ...MEDELLIN, porDefecto: true }, ENVIGADO])(route));
    await page.goto('/transito');

    await expect(page.getByText(/No pudimos cargar sus secretarías/)).toBeVisible();
    fallar = false;
    await page.getByRole('button', { name: 'Reintentar secretarías' }).click();
    await expect(page.getByLabel('Secretaría')).toBeVisible();
  });
});
