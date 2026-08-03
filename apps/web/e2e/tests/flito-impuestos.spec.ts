import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, AUDITOR_USER } from '../helpers/auth';

// FLITO — Impuestos (Fase 6). Cola por organismo: factura de venta como
// precondición, envío atómico y solo-lectura para Auditoría. Backend mockeado.

const IMPUESTOS = [
  {
    id: 'i1', tramiteId: 't1', idFlit: 'FLIT-1001', placa: 'ABC123', vin: 'VIN0000000000001',
    estado: 'pendiente', compradorNombre: 'Ana Pérez', compradorDocumento: '10101010',
    companiaNombre: 'Concesionario Norte', organismoCodigo: 'STT-MZL', organismoNombre: 'STT Manizales',
    valorLiquidado: 120000, valorPagado: null, marcadoPorDiferencia: false, tieneFacturaVenta: true,
    enviadoPorNombre: null, enviadoEn: null, estancado: false, motivoRechazo: null, creadoEn: '2026-04-01T12:00:00Z',
  },
  {
    id: 'i2', tramiteId: 't2', idFlit: 'FLIT-1002', placa: 'XYZ789', vin: 'VIN0000000000002',
    estado: 'solicitado', compradorNombre: 'Luis Gómez', compradorDocumento: '20202020',
    companiaNombre: 'Concesionario Sur', organismoCodigo: 'STT-PER', organismoNombre: 'STT Pereira',
    valorLiquidado: 200000, valorPagado: null, marcadoPorDiferencia: false, tieneFacturaVenta: true,
    enviadoPorNombre: 'Operaciones E2E', enviadoEn: '2026-04-02T12:00:00Z', estancado: false, motivoRechazo: null, creadoEn: '2026-04-02T12:00:00Z',
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
    const items = estado ? IMPUESTOS.filter((i) => i.estado === estado) : IMPUESTOS;
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

  test('auditor ve detalle en solo lectura', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mock(page);

    await page.goto('/flito/impuestos');
    await page.getByRole('button', { name: 'Ver' }).first().click();
    await expect(page.getByText(/Solo lectura · Auditoría/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rechazar' })).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Certificación contra el RUNT (HU #11168)
//
// Bloque con su propio fixture y sus propias rutas, registradas DESPUÉS de `mock()` —que en
// Playwright es lo que les da prioridad—. Así los tres casos de arriba siguen contando exactamente
// lo mismo que antes.
//
// El punto de casi todos estos casos es la DISTINCIÓN entre desenlaces: un 409 de discrepancia y un
// 502 de servicio se parecen desde la interfaz (en ambos «no se pudo») pero exigen acciones
// distintas del gestor. Si la interfaz los mezclara, nada más lo detectaría.
// ---------------------------------------------------------------------------

const CERT_VIGENTE = {
  id: 'cert-1', certificadoEn: '2026-08-01T15:00:00Z', certificadoPorNombre: 'gestor@flitsas.io',
};

/** Cola con un solicitado sin certificar (i2) y otro ya certificado (i3). */
const IMPUESTOS_CERT = [
  { ...IMPUESTOS[1], certificacion: null },
  {
    ...IMPUESTOS[1], id: 'i3', tramiteId: 't3', idFlit: 'FLIT-1003', placa: 'QIU744',
    vin: '3KPFF51ABTE156687', certificacion: CERT_VIGENTE,
  },
];

async function mockCert(page: import('@playwright/test').Page) {
  await page.route(/\/api\/flito\/impuestos\/facetas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FACETAS) }));
  await page.route(/\/api\/flito\/impuestos\?/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ items: IMPUESTOS_CERT, total: 2, page: 1, pageSize: 50 }),
  }));
}

test.describe('FLITO — Impuestos · certificación RUNT', () => {
  test('AC1 — el botón Certificar sale en los solicitados sin certificar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCert(page);

    await page.goto('/flito/impuestos');

    // Uno con botón (i2) y otro ya certificado (i3): el certificado NO vuelve a ofrecer el botón.
    await expect(page.getByRole('button', { name: 'Certificar' })).toHaveCount(1);
    await expect(page.getByText('Certificado', { exact: true })).toHaveCount(1);
  });

  test('AC2 — al certificar, la fila pasa a Certificado sin recargar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCert(page);
    let pedidas = 0;
    await page.route(/\/api\/flito\/impuestos\/i2\/certificar$/, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ code: 'certificado', certificacion: CERT_VIGENTE }),
    }));
    page.on('request', (r) => { if (/\/api\/flito\/impuestos\?/.test(r.url())) pedidas++; });

    await page.goto('/flito/impuestos');
    // El contador se lee con la tabla YA pintada: leerlo justo tras `goto` lo dejaba en cero y luego
    // subía por la propia carga inicial, no por la certificación.
    await expect(page.getByRole('button', { name: 'Certificar' })).toBeVisible();
    const antes = pedidas;
    await page.getByRole('button', { name: 'Certificar' }).click();

    await expect(page.getByText('Certificado', { exact: true })).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Certificar' })).toHaveCount(0);
    // La fila se parchea con lo que devolvió el backend: no se vuelve a pedir la cola entera, que
    // repaginaría la tabla bajo el cursor de quien lleva un minuto esperando.
    expect(pedidas).toBe(antes);
  });

  test('AC3 — la discrepancia se explica campo a campo y deja reintentar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCert(page);
    await page.route(/\/api\/flito\/impuestos\/i2\/certificar$/, (route) => route.fulfill({
      status: 409, contentType: 'application/json',
      body: JSON.stringify({
        code: 'con_diferencias',
        error: 'Los datos del registro no coinciden con lo que reporta el RUNT.',
        campos: [
          { campo: 'placa', resultado: 'coincide', bloqueante: true, valorFlito: 'XYZ789', valorRunt: 'XYZ789' },
          { campo: 'vin', resultado: 'difiere', bloqueante: true, valorFlito: 'VIN0000000000002', valorRunt: '3KPFF51ABTE156687' },
        ],
        diferenciasBloqueantes: [],
      }),
    }));

    await page.goto('/flito/impuestos');
    await page.getByRole('button', { name: 'Certificar' }).click();

    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();
    await expect(modal.getByRole('heading', { name: /no coinciden con el RUNT/i })).toBeVisible();
    await expect(modal.getByText('Corrige el dato y reintenta')).toBeVisible();
    // Los dos valores enfrentados, que es lo que el gestor necesita para saber cuál corregir.
    await expect(modal.getByText('VIN0000000000002')).toBeVisible();
    await expect(modal.getByText('3KPFF51ABTE156687')).toBeVisible();
    await expect(modal.getByText('Impide certificar')).toBeVisible();

    await modal.getByRole('button', { name: /cerrar/i }).click();
    // El estado del registro no cambió y el botón sigue disponible para reintentar.
    await expect(page.getByRole('button', { name: 'Certificar' })).toBeEnabled();
  });

  test('AC4 — el error del RUNT se distingue de la discrepancia', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCert(page);
    await page.route(/\/api\/flito\/impuestos\/i2\/certificar$/, (route) => route.fulfill({
      status: 502, contentType: 'application/json',
      body: JSON.stringify({ code: 'error_servicio', error: 'El servicio RUNT no está disponible.' }),
    }));

    await page.goto('/flito/impuestos');
    await page.getByRole('button', { name: 'Certificar' }).click();

    const modal = page.getByRole('dialog');
    await expect(modal.getByRole('heading', { name: /No se pudo consultar el RUNT/i })).toBeVisible();
    // La salida que se le ofrece al gestor es OTRA que ante una discrepancia. Esa es la distinción
    // que pide el AC: no basta con que el texto cambie, tiene que cambiar lo que se le pide hacer.
    await expect(modal.getByText('Reintenta en unos minutos')).toBeVisible();
    await expect(modal.getByText('Corrige el dato y reintenta')).toHaveCount(0);
    // Sin tabla de campos: aquí no hay nada que corregir, y mostrarla sugeriría lo contrario.
    await expect(modal.getByText('Impide certificar')).toHaveCount(0);
  });

  test('AC5 — pulsar el estado Certificado descarga el PDF', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCert(page);
    let descargado: string | null = null;
    await page.route(/\/api\/flito\/impuestos\/i3\/certificado$/, (route) => {
      descargado = route.request().url();
      return route.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-1.7 e2e' });
    });

    await page.goto('/flito/impuestos');
    await page.getByRole('button', { name: 'Descargar certificado en PDF' }).click();

    await expect.poll(() => descargado).not.toBeNull();
  });

  test('AC6 — el auditor ve el estado pero no el botón', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mockCert(page);

    await page.goto('/flito/impuestos');

    await expect(page.getByText('Certificado', { exact: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Certificar' })).toHaveCount(0);
    // Tampoco el enlace de descarga: el backend le devolvería 403 y un botón que falla es peor que
    // ninguno.
    await expect(page.getByRole('button', { name: 'Descargar certificado en PDF' })).toHaveCount(0);
  });

  test('AC7 — mientras consulta el RUNT, el botón se bloquea y no se puede repetir', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCert(page);
    let intentos = 0;
    await page.route(/\/api\/flito\/impuestos\/i2\/certificar$/, async (route) => {
      intentos++;
      // La consulta real tarda decenas de segundos; se simula lo justo para poder pulsar encima.
      await new Promise((r) => setTimeout(r, 1500));
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ code: 'certificado', certificacion: CERT_VIGENTE }),
      });
    });

    await page.goto('/flito/impuestos');
    const boton = page.getByRole('button', { name: 'Certificar' });
    await boton.click();

    await expect(page.getByRole('button', { name: /Consultando RUNT/ })).toBeDisabled();
    // Un segundo clic sobre el botón deshabilitado no dispara nada.
    await page.getByRole('button', { name: /Consultando RUNT/ }).click({ force: true }).catch(() => { /* deshabilitado */ });
    await expect(page.getByText('Certificado', { exact: true })).toHaveCount(2);
    expect(intentos).toBe(1);
  });

  test('un impuesto ya pagado conserva la descarga de su certificado', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await page.route(/\/api\/flito\/impuestos\/facetas/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FACETAS) }));
    await page.route(/\/api\/flito\/impuestos\?/, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        items: [{ ...IMPUESTOS_CERT[1], estado: 'pagado', valorPagado: 200000, pagadoEn: '2026-08-02T12:00:00Z' }],
        total: 1, page: 1, pageSize: 50,
      }),
    }));

    await page.goto('/flito/impuestos');

    // Pagado ya no se puede certificar —el dinero salió— pero el certificado es justo la evidencia
    // que hay que poder enseñarle al cliente después de pagar. Atar la descarga al estado la
    // escondería precisamente cuando hace falta.
    await expect(page.getByRole('button', { name: 'Descargar certificado en PDF' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Certificar' })).toHaveCount(0);
  });
});
