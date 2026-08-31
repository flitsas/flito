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

  // El recibo se carga desde esta pantalla pero para verlo había que irse al reporte de costos, en
  // el que el gestor del organismo no entra. Es la evidencia del pago: se mira donde se gestiona.
  test('desde el detalle de un impuesto se ve su recibo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.route(/\/api\/flito\/impuestos\/[^/]+\/soportes/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
        { id: 'sop-1', origen: 'impuesto', tipo: 'recibo_impuesto', nombreArchivo: 'recibo-impuesto.pdf', url: '/api/files?key=a', subidoEn: '2026-04-05T12:00:00Z' },
      ]) }));

    await page.goto('/flito/impuestos');
    await page.getByRole('row').filter({ hasText: 'ABC123' }).getByRole('button', { name: 'Ver' }).click();
    await page.getByRole('button', { name: 'Ver soporte' }).click();

    await expect(page.getByText('Documentos de Impuesto ABC123')).toBeVisible();
    await expect(page.getByRole('button').filter({ hasText: 'recibo-impuesto.pdf' })).toBeVisible();
  });

  // El fallo que se venía a corregir: la factura se abría en una pestaña con una URL `blob:`, que
  // no lleva nombre, así que el navegador la guardaba sin extensión y no abría con doble clic.
  /**
   * El nombre lo pone el SERVIDOR desde la HU #11910 (AC5): `PLACA-ORGANISMO.<ext>`, el mismo con el
   * que la factura sale dentro del ZIP. Antes lo fabricaba el cliente (`factura-venta-<idFlit>.pdf`)
   * y quien bajaba un ZIP y luego una factura suelta acababa con dos convenciones en la misma
   * carpeta, sin forma de emparejarlas.
   *
   * *Mutante:* volver a `nombreFacturaVenta(imp.idFlit)` — el `download` diría `factura-venta-…`.
   */
  test('la factura de venta de FLIT se descarga con el nombre PLACA-ORGANISMO que manda el servidor', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.route(/\/api\/flito\/impuestos\/[^/]+\/factura-venta/, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/pdf',
        headers: { 'content-disposition': 'inline; filename="ABC123-STTMANIZALES.pdf"' },
        body: '%PDF-1.4 fake',
      }));

    await page.goto('/flito/impuestos');
    await page.getByRole('row').filter({ hasText: 'ABC123' }).getByRole('button', { name: 'Ver' }).click();
    await page.getByRole('button', { name: 'En FLIT · Ver / descargar' }).click();

    const descargar = page.getByRole('link', { name: 'Descargar' });
    await expect(descargar).toBeVisible();
    await expect(descargar).toHaveAttribute('download', 'ABC123-STTMANIZALES.pdf');
  });

  /**
   * Y el guardia: un nombre que NO tiene la forma del AC5 no se propaga.
   *
   * `a3f9c1e0.pdf` es la forma del id de S3 —de donde se venía— y `[A-Z0-9]+` no basta para
   * distinguirlo de una placa: lo que lo distingue es que un nombre de conciliación tiene DOS
   * segmentos. Sin este caso, el predicado podría ser `() => true` y nadie se enteraría.
   */
  test('un nombre servido que no es PLACA-ORGANISMO se cae al respaldo del cliente', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.route(/\/api\/flito\/impuestos\/[^/]+\/factura-venta/, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/pdf',
        headers: { 'content-disposition': 'inline; filename="a3f9c1e0.pdf"' },
        body: '%PDF-1.4 fake',
      }));

    await page.goto('/flito/impuestos');
    await page.getByRole('row').filter({ hasText: 'ABC123' }).getByRole('button', { name: 'Ver' }).click();
    await page.getByRole('button', { name: 'En FLIT · Ver / descargar' }).click();

    await expect(page.getByRole('link', { name: 'Descargar' }))
      .toHaveAttribute('download', 'factura-venta-FLIT-1001.pdf');
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

  test('la acción vive bajo el trámite y ya no hay columna Certificación', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCert(page);

    await page.goto('/flito/impuestos');

    // La columna se quitó: solo tenía algo que enseñar en las filas certificables o certificadas y
    // gastaba ancho en todas las demás para decir «—».
    await expect(page.getByRole('columnheader', { name: 'Certificación' })).toHaveCount(0);

    // Botón y chip pasan a la celda del trámite. Se comprueba por contenido de la celda y no por su
    // posición: el índice de columna baila con la casilla de selección, que solo sale cuando hay
    // filas seleccionables.
    const celdaDelTramite = page.getByRole('cell').filter({ hasText: 'FLIT-1002' });
    await expect(celdaDelTramite.getByRole('button', { name: 'Certificar' })).toBeVisible();
    await expect(page.getByRole('cell').filter({ hasText: 'FLIT-1003' })
      .getByRole('button', { name: 'Descargar certificado en PDF' })).toBeVisible();
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

// ---------------------------------------------------------------------------
// Certificación MASIVA desde la selección (HU #11169)
//
// Una sola mecánica de selección para dos acciones distintas: enviar (Pendientes) y certificar
// (Solicitados). Hasta la HU #11910 estos casos vigilaban que la barra NUNCA ofreciera una acción
// que solo aplica a parte de lo marcado. **Esa regla se invirtió**: con la casilla abierta a
// cualquier fila (AC1 de la #11910), negar la acción convertía el marcado en un candado. Lo que
// vigilan ahora es lo que sustituyó a aquella prohibición: que el rótulo diga «(1 de 2)» y —lo que
// de verdad importa— que **el cuerpo de la petición lleve solo los ids aplicables**.
// ---------------------------------------------------------------------------

/** Tres solicitados sin certificar, para poder marcar varios. */
const IMPUESTOS_LOTE = [0, 1, 2].map((n) => ({
  ...IMPUESTOS[1], id: `s${n}`, tramiteId: `t${n}`, idFlit: `FLIT-200${n}`,
  placa: `SOL00${n}`, certificacion: null,
}));

async function mockLote(page: import('@playwright/test').Page, items: unknown[] = IMPUESTOS_LOTE) {
  await page.route(/\/api\/flito\/impuestos\/facetas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FACETAS) }));
  await page.route(/\/api\/flito\/impuestos\?/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ items, total: items.length, page: 1, pageSize: 50 }),
  }));
}

test.describe('FLITO — Impuestos · certificación masiva', () => {
  test('AC1 — la barra ofrece Certificar con el número seleccionado', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockLote(page);

    await page.goto('/flito/impuestos');
    await page.getByLabel('Seleccionar SOL000').check();
    await page.getByLabel('Seleccionar SOL001').check();

    await expect(page.getByText('2 seleccionado(s)')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Certificar (2)' })).toBeEnabled();
    // Solicitados: no se envían al gestor, ya están con él.
    await expect(page.getByRole('button', { name: /Enviar al gestor/ })).toHaveCount(0);
  });

  test('AC2 y AC6 — el resultado sale por registro, con placa y motivo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockLote(page);
    await page.route(/\/api\/flito\/impuestos\/certificar$/, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        total: 2, certificados: 0,
        resultados: [
          { id: 's0', resultado: 'con_diferencias', diferenciasBloqueantes: [{ campo: 'vin', resultado: 'difiere', bloqueante: true, valorFlito: 'A', valorRunt: 'B' }] },
          { id: 's1', resultado: 'error_servicio', mensaje: 'El servicio RUNT no está disponible.' },
        ],
      }),
    }));

    await page.goto('/flito/impuestos');
    await page.getByLabel('Seleccionar SOL000').check();
    await page.getByLabel('Seleccionar SOL001').check();
    await page.getByRole('button', { name: 'Certificar (2)' }).click();

    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();
    // AC6 — ninguno certificó y cada uno dice por qué. La placa es lo que el gestor reconoce.
    await expect(modal.getByText('Certificados 0')).toBeVisible();
    await expect(modal.getByText('SOL000')).toBeVisible();
    await expect(modal.getByText('SOL001')).toBeVisible();
    await expect(modal.getByText('Corrige el dato y reintenta')).toBeVisible();
    await expect(modal.getByText('Reintenta en unos minutos')).toBeVisible();
    // Sin `mensaje` propio, la fila resume qué campo falló: sin eso habría que certificar de uno en
    // uno solo para saber cuál era el dato malo.
    await expect(modal.getByText('No coincide: VIN')).toBeVisible();
  });

  test('AC3 — durante el lote hay progreso y no se puede lanzar dos veces', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockLote(page);
    let intentos = 0;
    await page.route(/\/api\/flito\/impuestos\/certificar$/, async (route) => {
      intentos++;
      await new Promise((r) => setTimeout(r, 1500));
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ total: 1, certificados: 1, resultados: [{ id: 's0', resultado: 'certificado' }] }),
      });
    });

    await page.goto('/flito/impuestos');
    await page.getByLabel('Seleccionar SOL000').check();
    await page.getByRole('button', { name: 'Certificar (1)' }).click();

    const enCurso = page.getByRole('button', { name: /Certificando 1/ });
    await expect(enCurso).toBeDisabled();
    await enCurso.click({ force: true }).catch(() => { /* deshabilitado */ });

    await expect(page.getByRole('dialog')).toBeVisible();
    expect(intentos).toBe(1);
  });

  test('AC4 — pasar del tope se avisa antes de enviar la petición', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const once = [...Array(11)].map((_, n) => ({
      ...IMPUESTOS[1], id: `s${n}`, tramiteId: `t${n}`, idFlit: `FLIT-30${n}`,
      placa: `TOP0${n}`, certificacion: null,
    }));
    await mockLote(page, once);
    let pedido = false;
    await page.route(/\/api\/flito\/impuestos\/certificar$/, (route) => {
      pedido = true;
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'x' }) });
    });

    await page.goto('/flito/impuestos');
    await page.getByLabel('Seleccionar las filas de esta página').check();

    await expect(page.getByText('Máximo 10 por lote. De las 11 marcadas, 11 se certifican.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Certificar (11)' })).toBeDisabled();
    // El aviso llega ANTES de gastar la petición: el backend la rechazaría igual, pero con 11
    // consultas al RUNT de por medio no hace falta llegar hasta ahí.
    expect(pedido).toBe(false);
  });

  test('AC5 — al cerrar el resultado se refresca la tabla y se vacía la selección', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockLote(page);
    let pedidas = 0;
    page.on('request', (r) => { if (/\/api\/flito\/impuestos\?/.test(r.url())) pedidas++; });
    await page.route(/\/api\/flito\/impuestos\/certificar$/, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ total: 1, certificados: 1, resultados: [{ id: 's0', resultado: 'certificado' }] }),
    }));

    await page.goto('/flito/impuestos');
    await page.getByLabel('Seleccionar SOL000').check();
    await page.getByRole('button', { name: 'Certificar (1)' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const antes = pedidas;

    await page.getByRole('button', { name: 'Listo' }).click();

    await expect(page.getByText('1 seleccionado(s)')).toHaveCount(0);
    await expect.poll(() => pedidas).toBeGreaterThan(antes);
  });

  /**
   * **La regresión más cara de la HU #11910, y la que sustituye al viejo «no ofrece ninguna acción».**
   *
   * Hasta esta HU, marcar un Pendiente y un Solicitado a la vez dejaba la barra muda. Con la casilla
   * abierta a cualquier fila (AC1) eso convertía el marcado en un candado: bastaba una Pagada para
   * perder «Enviar al gestor», que es la acción del día.
   *
   * *Mutantes que este caso mata:* (a) volver al `every()` —los dos botones desaparecen y caen los
   * dos primeros asertos—; (b) mandar `[...seleccion]` entero —el rótulo seguiría diciendo «(1 de 2)»
   * y solo el aserto del CUERPO lo caza—.
   *
   * **El (b) se comprueba en las DOS acciones, y esa simetría es el arreglo de un hueco real:** hasta
   * el gate de QA de esta HU solo se pulsaba «Enviar», así que `{ ids: filasSeleccionadas… }` en
   * `certificarLote` sobrevivía en verde. No es un mutante menor: `certificarLote` aplica
   * `TOPE_LOTE_CERTIFICACION` al array que manda, de modo que con 9 certificables entre 11 marcadas
   * el botón diría «Certificar (9 de 11)» y el servidor contestaría «Seleccionaste 11» —y por debajo
   * del tope se gastarían consultas al RUNT, que se pagan por consulta, en filas que no se pueden
   * certificar—. La mitad del tope ya estaba asertada; esta es la otra mitad.
   *
   * Certificar va PRIMERO porque cerrar su modal de resultado llama a `onListo()`, que vacía la
   * selección: hacerlo al revés obligaría a volver a marcar sin que eso comprobara nada.
   */
  test('AC1 #11910 — mezclar estados ofrece las dos acciones, y cada una manda solo sus ids', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    // Un Pendiente (se envía) y un Solicitado (se certifica) a la vez.
    await mockLote(page, [
      { ...IMPUESTOS[0], certificacion: null },
      { ...IMPUESTOS_LOTE[0] },
    ]);
    const enviados: unknown[] = [];
    await page.route(/\/api\/flito\/impuestos\/enviar$/, (route) => {
      enviados.push(route.request().postDataJSON());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enviados: ['i1'], yaEnviados: [] }) });
    });
    // Solo el masivo: el de fila es `/impuestos/<id>/certificar`, que no encaja con este ancla.
    const certificados: unknown[] = [];
    await page.route(/\/api\/flito\/impuestos\/certificar$/, (route) => {
      certificados.push(route.request().postDataJSON());
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ total: 1, certificados: 1, resultados: [{ id: 's0', resultado: 'certificado' }] }),
      });
    });

    await page.goto('/flito/impuestos');
    await page.getByLabel('Seleccionar ABC123').check();
    await page.getByLabel('Seleccionar SOL000').check();

    // Las dos acciones SE OFRECEN, y el desajuste va dentro del nombre accesible.
    await expect(page.getByRole('button', { name: 'Enviar al gestor (1 de 2)' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Certificar (1 de 2)' })).toBeVisible();
    await expect(page.getByText(/De las 2 filas marcadas/)).toBeVisible();
    // Y el mensaje que las negaba ya no existe.
    await expect(page.getByText(/mezcla estados con acciones distintas/)).toHaveCount(0);

    // ── Certificar: un id, el del Solicitado ──────────────────────────────────────────────────
    await page.getByRole('button', { name: 'Certificar (1 de 2)' }).click();
    await expect.poll(() => certificados.length).toBe(1);
    // **Sobre el CUERPO, no sobre el rótulo.** Con `filasSeleccionadas.map(f => f.id)` aquí irían
    // los dos, el rótulo seguiría diciendo «(1 de 2)» y nada más se pondría rojo.
    expect(certificados[0]).toEqual({ ids: ['s0'] });

    // Cerrar el resultado vacía la selección (`onListo`), así que se vuelve a marcar para la otra.
    await page.getByRole('button', { name: 'Listo' }).click();
    await expect(page.getByText('2 seleccionado(s)')).toHaveCount(0);
    await page.getByLabel('Seleccionar ABC123').check();
    await page.getByLabel('Seleccionar SOL000').check();

    // ── Enviar: un id, el del Pendiente ───────────────────────────────────────────────────────
    await page.getByRole('button', { name: 'Enviar al gestor (1 de 2)' }).click();
    await expect.poll(() => enviados.length).toBe(1);
    expect(enviados[0]).toEqual({ ids: ['i1'] });
    // Y certificar no se volvió a pedir de rebote: cada botón manda lo suyo, una sola vez.
    expect(certificados).toHaveLength(1);
  });

  /**
   * El tope de certificación mide los CERTIFICABLES, no la selección entera (HU #11910).
   *
   * *Mutante:* dejar `ids.length > TOPE` — con 11 marcadas y 9 certificables el botón saldría
   * bloqueado por un tope que no aplica a ese caso, y este test lo caza.
   */
  test('AC1 #11910 — 11 marcadas con 9 certificables NO bloquean «Certificar»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const nueveCert = [...Array(9)].map((_, n) => ({
      ...IMPUESTOS[1], id: `c${n}`, tramiteId: `tc${n}`, idFlit: `FLIT-40${n}`,
      placa: `CER0${n}`, certificacion: null,
    }));
    // Dos Pagados: ni se envían ni se certifican, pero SÍ se marcan y SÍ cuentan para el ZIP.
    const dosPagados = [0, 1].map((n) => ({
      ...IMPUESTOS[1], id: `p${n}`, tramiteId: `tp${n}`, idFlit: `FLIT-50${n}`,
      placa: `PAG0${n}`, estado: 'pagado', pagadoEn: '2026-08-02T12:00:00Z', certificacion: null,
    }));
    await mockLote(page, [...nueveCert, ...dosPagados]);

    await page.goto('/flito/impuestos');
    await page.getByLabel('Seleccionar las filas de esta página').check();

    await expect(page.getByText('11 seleccionado(s)')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Certificar (9 de 11)' })).toBeEnabled();
    await expect(page.getByText(/Máximo 10 por lote/)).toHaveCount(0);
  });

  test('el gestor del organismo también certifica en bloque', async ({ page }) => {
    await loginAs(page, GESTOR_IMPUESTOS_USER);
    await mockLote(page);

    await page.goto('/flito/impuestos');
    await page.getByLabel('Seleccionar SOL000').check();

    // La casilla ya no es exclusiva de Operaciones: el backend admite gestor en el masivo.
    await expect(page.getByRole('button', { name: 'Certificar (1)' })).toBeEnabled();
  });
});
