import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER } from '../helpers/auth';

// Manifiestos electrónicos RNDC — documento legal MinTransporte.
// Cubre lista, filtro por estado, detalle con acciones según ciclo de vida y validación pre-radicar.

const LISTA_FIXTURE = [
  {
    id: 1, numero: 'MAN-202605-001', consecutivoRndc: 'CR-9001', estado: 'listo',
    fechaExpedicion: '2026-05-07', valorFleteTotal: '5000000',
    placaPrincipal: 'EEE001', conductorNombre: 'Conductor E2E',
    origenDane: '11001', destinoDane: '76001',
    radicadoAt: null, cumplidoAt: null,
  },
  {
    id: 2, numero: 'MAN-202605-002', consecutivoRndc: null, estado: 'borrador',
    fechaExpedicion: '2026-05-08', valorFleteTotal: '3500000',
    placaPrincipal: 'EEE002', conductorNombre: null,
    origenDane: '05001', destinoDane: '08001',
    radicadoAt: null, cumplidoAt: null,
  },
  {
    id: 3, numero: 'MAN-202605-003', consecutivoRndc: 'CR-9003', estado: 'cumplido',
    fechaExpedicion: '2026-05-05', valorFleteTotal: '4200000',
    placaPrincipal: 'EEE003', conductorNombre: 'Conductor E2E B',
    origenDane: '11001', destinoDane: '13001',
    radicadoAt: '2026-05-05T10:00:00Z', cumplidoAt: '2026-05-06T18:00:00Z',
  },
];

const DETALLE_FIXTURE_BORRADOR = {
  data: {
    id: 2, numero: 'MAN-202605-002', consecutivoRndc: null, estado: 'borrador',
    estadoEnvio: 'no_aplica', intentosEnvio: 0, ultimoError: null, proximoIntentoAt: null,
    fechaExpedicion: '2026-05-08', valorFleteTotal: '3500000',
    vehiculoPrincipalId: 11, vehiculoRemolqueId: null,
    conductorId: 5, conductorNombre: 'Conductor E2E',
    origenDane: '05001', destinoDane: '08001',
    horaCargue: '08:00', horaDescargue: '18:00',
    observacionesMd: null, radicadoAt: null, cumplidoAt: null,
  },
  remesas: [],
};

const DETALLE_FIXTURE_CUMPLIDO = {
  data: { ...DETALLE_FIXTURE_BORRADOR.data, id: 3, numero: 'MAN-202605-003', estado: 'cumplido',
    consecutivoRndc: 'CR-9003', estadoEnvio: 'aceptado',
    radicadoAt: '2026-05-05T10:00:00Z', cumplidoAt: '2026-05-06T18:00:00Z' },
  remesas: [],
};

test.describe('RNDC Manifiestos — listado', () => {
  test.beforeEach(async ({ page }) => { await loginAs(page, ADMIN_USER); });

  test('admin lista manifiestos con varios estados', async ({ page }) => {
    await page.route('**/api/rndc/manifiestos**', (route) => {
      const url = route.request().url();
      if (/\/manifiestos\/\d+/.test(url)) return route.continue();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: LISTA_FIXTURE }) });
    });

    await page.goto('/rndc/manifiestos');
    await expect(page.getByRole('heading', { name: /Manifiestos electr[óo]nicos/i })).toBeVisible();
    // Tres manifiestos con consecutivo o número visible
    await expect(page.getByText('MAN-202605-001')).toBeVisible();
    await expect(page.getByText('MAN-202605-002')).toBeVisible();
    await expect(page.getByText('MAN-202605-003')).toBeVisible();
    // Pills de estado distintos
    await expect(page.getByText(/^listo$/i).first()).toBeVisible();
    await expect(page.getByText(/^borrador$/i).first()).toBeVisible();
    await expect(page.getByText(/^cumplido$/i).first()).toBeVisible();
    // Consecutivo RNDC visible solo en los radicados
    await expect(page.getByText(/RNDC CR-9001/i)).toBeVisible();
  });

  test('filtro estado=listo dispara request con query', async ({ page }) => {
    let lastUrl = '';
    await page.route('**/api/rndc/manifiestos**', (route) => {
      lastUrl = route.request().url();
      if (/\/manifiestos\/\d+/.test(lastUrl)) return route.continue();
      const estado = new URL(lastUrl).searchParams.get('estado');
      const data = estado ? LISTA_FIXTURE.filter((m) => m.estado === estado) : LISTA_FIXTURE;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
    });

    await page.goto('/rndc/manifiestos');
    await page.getByRole('button', { name: /^listo$/ }).click();
    await expect.poll(() => lastUrl, { timeout: 10_000 }).toContain('estado=listo');
    await expect(page.getByText('MAN-202605-001')).toBeVisible();
    await expect(page.getByText('MAN-202605-002')).not.toBeVisible();
  });

  test('empty state se muestra sin manifiestos', async ({ page }) => {
    await page.route('**/api/rndc/manifiestos**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) })
    );

    await page.goto('/rndc/manifiestos');
    await expect(page.getByText(/Sin manifiestos/i)).toBeVisible();
    await expect(page.getByRole('link', { name: /Nuevo manifiesto/i })).toBeVisible();
  });
});

test.describe('RNDC Manifiestos — detalle y acciones', () => {
  test.beforeEach(async ({ page }) => { await loginAs(page, ADMIN_USER); });

  test('manifiesto borrador muestra acciones marcar-listo, anular, eliminar', async ({ page }) => {
    await page.route('**/api/rndc/manifiestos/2', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DETALLE_FIXTURE_BORRADOR) })
    );

    await page.goto('/rndc/manifiestos/2');
    await expect(page.getByRole('heading', { name: /MAN-202605-002/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Marcar listo$/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Anular$/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Eliminar$/i })).toBeVisible();
    // Tarjeta pre-validación visible solo en estado editable (borrador/listo)
    await expect(page.getByText(/Pre-validaci[óo]n antes de radicar/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Ejecutar validaci[óo]n/i })).toBeVisible();
  });

  test('manifiesto cumplido NO muestra acciones de cambio de estado', async ({ page }) => {
    await page.route('**/api/rndc/manifiestos/3', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DETALLE_FIXTURE_CUMPLIDO) })
    );

    await page.goto('/rndc/manifiestos/3');
    await expect(page.getByRole('heading', { name: /MAN-202605-003/i })).toBeVisible();
    // Cumplido: ningún botón de cambio de estado, solo PDF
    await expect(page.getByRole('button', { name: /^Marcar listo$/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Cumplir$/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Anular$/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Eliminar$/i })).toHaveCount(0);
    // PDF siempre disponible
    await expect(page.getByRole('button', { name: /^PDF$/i })).toBeVisible();
    // Tarjeta envío RNDC con estado aceptado
    await expect(page.getByText(/Estado env[íi]o RNDC/i)).toBeVisible();
    await expect(page.getByText(/^aceptado$/i).first()).toBeVisible();
  });

  test('validación pre-radicar muestra checks ok/fail bloqueantes', async ({ page }) => {
    await page.route('**/api/rndc/manifiestos/2', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DETALLE_FIXTURE_BORRADOR) })
    );
    await page.route('**/api/rndc/manifiestos/2/validar', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          checks: [
            { regla: 'SOAT vigente', ok: true, detalle: 'Vence 2027-03-01' },
            { regla: 'RTM vigente', ok: false, detalle: 'Venció 2026-04-15' },
            { regla: 'Conductor apto', ok: true, detalle: null },
            { regla: 'Vinculación cabezote-remolque', ok: false, detalle: 'Falta remolque vinculado al cabezote' },
          ],
        }),
      })
    );

    await page.goto('/rndc/manifiestos/2');
    await page.getByRole('button', { name: /Ejecutar validaci[óo]n/i }).click();
    await expect(page.getByText(/SOAT vigente/i)).toBeVisible();
    await expect(page.getByText(/Venci[óo] 2026-04-15/i)).toBeVisible();
    await expect(page.getByText(/Falta remolque vinculado/i)).toBeVisible();
    // Footer rojo bloqueante
    await expect(page.getByText(/Resuelva los puntos en rojo antes de radicar/i)).toBeVisible();
  });
});
