import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, AUDITOR_USER, GESTOR_IMPUESTOS_USER, FUNCIONES_POR_ROL } from '../helpers/auth';

// FLITO — Impuestos (Fase 6). Cola por organismo: factura de venta como
// precondición, envío atómico y solo-lectura para Auditoría. Backend mockeado.
// Contingencia (HU #11158): quién gestiona cada impuesto, su filtro y el traspaso a Operaciones.
// Fases del recibo, chip/filtro de liquidados y recibo de caja (HU #12592): bloque propio al final.

/** Base común de las filas: lo que la HU #12592 añade (`liquidadoEn`, `documentos`) va explícito en cada una. */
const SIN_DOCUMENTOS = { liquidadoEn: null as string | null, documentos: null as 'liquidacion' | 'pago' | 'ambos' | null };

const IMPUESTOS = [
  {
    id: 'i1', tramiteId: 't1', idFlit: 'FLIT-1001', placa: 'ABC123', vin: 'VIN0000000000001',
    estado: 'pendiente', compradorNombre: 'Ana Pérez', compradorDocumento: '10101010', compradorTipoDocumento: 'CC',
    companiaNombre: 'Concesionario Norte', organismoCodigo: 'STT-MZL', organismoNombre: 'STT Manizales',
    valorLiquidado: 120000, valorPagado: null, marcadoPorDiferencia: false, tieneFacturaVenta: true,
    enviadoPorNombre: null, enviadoEn: null, estancado: false, motivoRechazo: null, creadoEn: '2026-04-01T12:00:00Z',
    gestionOperaciones: false, ...SIN_DOCUMENTOS,
  },
  {
    id: 'i2', tramiteId: 't2', idFlit: 'FLIT-1002', placa: 'XYZ789', vin: 'VIN0000000000002',
    estado: 'solicitado', compradorNombre: 'Luis Gómez', compradorDocumento: '20202020', compradorTipoDocumento: 'PP',
    companiaNombre: 'Concesionario Sur', organismoCodigo: 'STT-PER', organismoNombre: 'STT Pereira',
    valorLiquidado: 200000, valorPagado: null, marcadoPorDiferencia: false, tieneFacturaVenta: true,
    enviadoPorNombre: 'Operaciones E2E', enviadoEn: '2026-04-02T12:00:00Z', estancado: false, motivoRechazo: null, creadoEn: '2026-04-02T12:00:00Z',
    gestionOperaciones: false,
    // HU #12592: liquidación cargada y sin pagar → chip «Liquidación» y botón de recibo de caja.
    liquidadoEn: '2026-04-05T10:00:00Z' as string | null, documentos: 'liquidacion' as 'liquidacion' | 'pago' | 'ambos' | null,
  },
  {
    id: 'i3', tramiteId: 't3', idFlit: 'FLIT-1003', placa: 'OPS001', vin: 'VIN0000000000003',
    // HU #11947 (AC7): tipo desconocido en FLIT, el API lo resuelve a `null` y la ficha enseña
    // solo el número, sin prefijo ni espacio de relleno delante.
    estado: 'solicitado', compradorNombre: 'Marta Ruiz', compradorDocumento: '30303030', compradorTipoDocumento: null,
    companiaNombre: 'Concesionario Sur', organismoCodigo: 'STT-PER', organismoNombre: 'STT Pereira',
    valorLiquidado: 150000, valorPagado: null, marcadoPorDiferencia: false, tieneFacturaVenta: true,
    enviadoPorNombre: 'Operaciones E2E', enviadoEn: '2026-04-03T12:00:00Z', estancado: false, motivoRechazo: null, creadoEn: '2026-04-03T12:00:00Z',
    gestionOperaciones: true,
    // HU #12592: pago sin liquidación (cargado directo en fase Pago y en revisión) → botón deshabilitado.
    liquidadoEn: null as string | null, documentos: 'pago' as 'liquidacion' | 'pago' | 'ambos' | null,
  },
  // HU #12592: las tres filas que faltan para el chip «Ambos» y para que el botón NO exista en
  // Pagado ni en Con novedad aunque haya liquidación.
  {
    id: 'i4', tramiteId: 't4', idFlit: 'FLIT-1004', placa: 'AMB004', vin: 'VIN0000000000004',
    estado: 'solicitado', compradorNombre: 'Nora Díaz', compradorDocumento: '40404040', compradorTipoDocumento: 'CC',
    companiaNombre: 'Concesionario Sur', organismoCodigo: 'STT-PER', organismoNombre: 'STT Pereira',
    valorLiquidado: 180000, valorPagado: null, marcadoPorDiferencia: false, tieneFacturaVenta: true,
    enviadoPorNombre: 'Operaciones E2E', enviadoEn: '2026-04-04T12:00:00Z', estancado: false, motivoRechazo: null, creadoEn: '2026-04-04T12:00:00Z',
    gestionOperaciones: false, liquidadoEn: '2026-04-06T10:00:00Z' as string | null, documentos: 'ambos' as 'liquidacion' | 'pago' | 'ambos' | null,
  },
  {
    id: 'i5', tramiteId: 't5', idFlit: 'FLIT-1005', placa: 'PAG005', vin: 'VIN0000000000005',
    estado: 'pagado', compradorNombre: 'Pedro Sanz', compradorDocumento: '50505050', compradorTipoDocumento: 'CC',
    companiaNombre: 'Concesionario Norte', organismoCodigo: 'STT-MZL', organismoNombre: 'STT Manizales',
    valorLiquidado: 90000, valorPagado: 90000, marcadoPorDiferencia: false, tieneFacturaVenta: true,
    enviadoPorNombre: 'Operaciones E2E', enviadoEn: '2026-04-01T12:00:00Z', pagadoEn: '2026-04-08T12:00:00Z', estancado: false, motivoRechazo: null, creadoEn: '2026-04-01T12:00:00Z',
    gestionOperaciones: false, liquidadoEn: '2026-04-05T10:00:00Z' as string | null, documentos: 'ambos' as 'liquidacion' | 'pago' | 'ambos' | null,
  },
  {
    id: 'i6', tramiteId: 't6', idFlit: 'FLIT-1006', placa: 'NOV006', vin: 'VIN0000000000006',
    estado: 'con_novedad', compradorNombre: 'Rosa Mora', compradorDocumento: '60606060', compradorTipoDocumento: 'CC',
    companiaNombre: 'Concesionario Norte', organismoCodigo: 'STT-MZL', organismoNombre: 'STT Manizales',
    valorLiquidado: 70000, valorPagado: null, marcadoPorDiferencia: false, tieneFacturaVenta: true,
    enviadoPorNombre: 'Operaciones E2E', enviadoEn: '2026-04-02T12:00:00Z', estancado: false, motivoRechazo: 'Placa ilegible', creadoEn: '2026-04-02T12:00:00Z',
    gestionOperaciones: false, liquidadoEn: '2026-04-05T10:00:00Z' as string | null, documentos: 'liquidacion' as 'liquidacion' | 'pago' | 'ambos' | null,
  },
];
type Impuesto = (typeof IMPUESTOS)[number];

const FACETAS = {
  companias: [{ id: 1, nombre: 'Concesionario Norte' }, { id: 2, nombre: 'Concesionario Sur' }],
  organismos: [{ codigo: '05001', nombre: 'STT Medellín' }, { codigo: '05266', nombre: 'STT Envigado' }],
};

/** Guarda las URLs que pidió la página, para poder comprobar QUÉ filtros viajaron. */
const urlsPedidas: string[] = [];

/**
 * `fuente` se lee EN CADA petición: los casos que necesitan que una fila cambie a mitad de la
 * prueba (el recibo de caja, HU #12592) pasan una función sobre su propio estado.
 */
async function mock(page: import('@playwright/test').Page, fuente: () => readonly Impuesto[] = () => IMPUESTOS) {
  urlsPedidas.length = 0;
  await page.route(/\/api\/flito\/impuestos\/facetas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FACETAS) }));
  await page.route(/\/api\/flito\/impuestos\?/, (route) => {
    const url = new URL(route.request().url());
    urlsPedidas.push(url.search);
    const estado = url.searchParams.get('estado');
    const gestion = url.searchParams.get('gestion');
    const todos = fuente();
    let items = estado ? todos.filter((i) => i.estado === estado) : [...todos];
    // El servidor es quien filtra de verdad; el mock lo imita para que el total y las filas cuadren.
    if (gestion) items = items.filter((i) => i.gestionOperaciones === (gestion === 'operaciones'));
    // HU #12592: `solicitado AND liquidado_en IS NOT NULL`, como el servicio.
    if (url.searchParams.get('liquidadoPendientePago') === 'true') {
      items = items.filter((i) => i.estado === 'solicitado' && i.liquidadoEn !== null);
    }
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

  // HU #11947 (AC7). El código lo resuelve el API ('CC' | 'NIT' | 'PP' | 'CE' | null); aquí solo se
  // antepone al número. Dos códigos distintos para que un prefijo constante no pase, y el caso sin
  // código comparado con `textContent` —no con `toHaveText`, que normaliza espacios— porque lo que
  // hay que matar es el `${tipo} ${numero}` interpolado a pelo, que ahí deja un espacio sobrante.
  for (const caso of [
    { placa: 'ABC123', esperado: 'CC 10101010' },
    { placa: 'XYZ789', esperado: 'PP 20202020' },
    { placa: 'OPS001', esperado: '30303030' },
  ]) {
    test(`AC7 — el documento del comprador de ${caso.placa} sale como lo resolvió el API`, async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      await mock(page);
      await page.goto('/flito/impuestos');
      await page.getByRole('row').filter({ hasText: caso.placa }).getByRole('button', { name: 'Ver' }).click();

      const dd = page.getByRole('dialog').locator('dt', { hasText: /^Documento$/ })
        .locator('xpath=following-sibling::dd');
      await expect(dd).toBeVisible();
      expect(await dd.textContent()).toBe(caso.esperado);
    });
  }

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

// ── HU #12592 · fases del recibo, chip/filtro de liquidados y recibo de caja ─────────────────

const PDF_CAJA = { name: 'recibo-caja-xyz789.pdf', mimeType: 'application/pdf' as const, buffer: Buffer.from('%PDF-1.4 caja') };
const OCR_VACIO = { liquidados: [], conciliados: [], enRevision: [], complementos: [], duplicados: [], noAsociados: [] };

async function abrirDetalle(page: import('@playwright/test').Page, placa: string) {
  await page.goto('/flito/impuestos');
  await page.getByRole('row').filter({ hasText: placa }).getByRole('button', { name: 'Ver' }).click();
  return page.getByRole('dialog', { name: `Impuesto · ${placa}` });
}

/**
 * Cola STATEFUL para el recibo de caja: el detalle se pinta desde la fila de la cola (no hay GET
 * /:id), así que el refresco tras el POST solo se puede probar si la cola cambia de respuesta.
 */
function colaMutable() {
  let filas: Impuesto[] = IMPUESTOS.map((i) => ({ ...i }));
  return {
    fuente: () => filas,
    mutar: (id: string, cambios: Partial<Impuesto>) => {
      filas = filas.map((f) => f.id === id ? { ...f, ...cambios } as Impuesto : f);
    },
  };
}

test.describe('FLITO — Impuestos · fases del recibo (HU #12592)', () => {
  test('TC-01/02 · el selector «Fase del recibo» sale con Pago por defecto, se opera con teclado y la casilla de marca de agua ya no existe', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/impuestos');
    await page.getByRole('button', { name: 'Cargar recibos (masivo)' }).click();
    const modal = page.getByRole('dialog', { name: 'Carga masiva de recibos de impuesto' });

    const grupo = modal.getByRole('group', { name: 'Fase del recibo' });
    await expect(grupo).toBeVisible();
    await expect(grupo.getByRole('radio', { name: 'Pago' })).toBeChecked();
    await expect(grupo.getByRole('radio', { name: 'Liquidación' })).not.toBeChecked();
    await expect(modal.getByRole('checkbox', { name: /sin marca de agua/i })).toHaveCount(0);
    await expect(modal.getByText(/detect/i)).toHaveCount(0);
    await expect(modal.getByText(/los que cuadran pasan a Pagado, el resto va a revisión/)).toHaveCount(0);
    // La ayuda del ZIP va SIEMPRE bajo el selector, antes de elegir nada (ux slim). Desde la HU
    // #12615 nombra las carpetas reales del organismo.
    await expect(modal.getByText(/En un ZIP manda la carpeta de cada recibo/)).toBeVisible();
    await expect(modal.getByText(/carpetas que no digan ninguna de las dos/)).toBeVisible();

    // Teclado: con el foco en el radio marcado, la flecha cambia de valor en un solo gesto.
    await grupo.getByRole('radio', { name: 'Pago' }).focus();
    await page.keyboard.press('ArrowLeft');
    await expect(grupo.getByRole('radio', { name: 'Liquidación' })).toBeChecked();
  });

  test('TC-06/07/08 · el resumen muestra «Liquidados» y lo acumula entre tandas', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    let tanda = 0;
    await page.route(/\/api\/flito\/impuestos\/recibos$/, (route) => {
      tanda += 1;
      const liquidados = tanda === 1
        ? [{ archivo: 'a.pdf', detalle: 'XYZ789 · liquidación' }]
        : [{ archivo: 'b.pdf', detalle: 'AMB004 · liquidación' }];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...OCR_VACIO, liquidados }) });
    });
    await page.goto('/flito/impuestos');
    await page.getByRole('button', { name: 'Cargar recibos (masivo)' }).click();
    const modal = page.getByRole('dialog', { name: 'Carga masiva de recibos de impuesto' });
    await modal.getByRole('radio', { name: 'Liquidación' }).check();
    await modal.locator('input[type="file"]').setInputFiles(
      Array.from({ length: 6 }, (_, i) => ({ name: `f${i + 1}.pdf`, mimeType: 'application/pdf' as const, buffer: Buffer.from('%PDF-1.4 x') })),
    );
    await modal.getByRole('button', { name: 'Subir y procesar' }).click();
    await expect(modal.getByRole('button', { name: 'Listo' })).toBeVisible();
    expect(tanda).toBe(2);
    await expect(modal.getByText('Liquidados 2', { exact: true })).toBeVisible();
    await expect(modal.getByText('Conciliados 0', { exact: true })).toBeVisible();
    const filasLiquidado = modal.getByRole('row').filter({ hasText: 'Liquidado' }).filter({ hasText: /\.pdf/ });
    await expect(filasLiquidado).toHaveCount(2);
    await expect(modal.getByRole('row').filter({ hasText: 'a.pdf' })).toContainText('Liquidado');
    await expect(modal.getByRole('row').filter({ hasText: 'b.pdf' })).toContainText('Liquidado');
  });

  test('TC-07 · «Liquidados 0» se pinta como las demás categorías vacías', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.route(/\/api\/flito\/impuestos\/recibos$/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OCR_VACIO) }));
    await page.goto('/flito/impuestos');
    await page.getByRole('button', { name: 'Cargar recibos (masivo)' }).click();
    const modal = page.getByRole('dialog', { name: 'Carga masiva de recibos de impuesto' });
    await modal.locator('input[type="file"]').setInputFiles([{ name: 'uno.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 x') }]);
    await modal.getByRole('button', { name: 'Subir y procesar' }).click();
    await expect(modal.getByText('Liquidados 0', { exact: true })).toBeVisible();
    await expect(modal.getByText('No se procesó ningún archivo.')).toBeVisible();
  });

  test('TC-09/10 · cada fila dice qué documento tiene, con la fecha en el título, y el detalle lo repite', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/impuestos');
    const fila = (placa: string) => page.getByRole('row').filter({ hasText: placa });

    const liq = fila('XYZ789').getByText('Liquidación', { exact: true });
    await expect(liq).toBeVisible();
    // `es-CO` corto pinta el año con dos cifras: se aserta la forma d/mm/aa, no el 2026.
    await expect(fila('XYZ789').getByTitle(/^Liquidado el \d{1,2}\/\d{2}\/\d{2}/)).toBeVisible();
    await expect(fila('OPS001').getByText('Pago', { exact: true })).toBeVisible();
    // Sin `liquidadoEn` no hay título: no se promete una fecha que no existe.
    await expect(fila('OPS001').getByTitle(/Liquidado el/)).toHaveCount(0);
    await expect(fila('AMB004').getByText('Ambos', { exact: true })).toBeVisible();
    for (const t of ['Liquidación', 'Pago', 'Ambos']) await expect(fila('ABC123').getByText(t, { exact: true })).toHaveCount(0);

    await fila('XYZ789').getByRole('button', { name: 'Ver' }).click();
    const detalle = page.getByRole('dialog', { name: 'Impuesto · XYZ789' });
    await expect(detalle.getByText('Liquidación', { exact: true })).toBeVisible();
    await expect(detalle.getByText('Liquidado el', { exact: true })).toBeVisible();
    const liquidadoEl = detalle.locator('dt', { hasText: 'Liquidado el' }).locator('xpath=following-sibling::dd[1]');
    await expect(liquidadoEl).toHaveText(/\d{1,2}\/\d{2}\/\d{2}/);
    await page.keyboard.press('Escape');

    await fila('OPS001').getByRole('button', { name: 'Ver' }).click();
    const detalle3 = page.getByRole('dialog', { name: 'Impuesto · OPS001' });
    await expect(detalle3.getByText('Pago', { exact: true })).toBeVisible();
    await expect(detalle3.locator('dt', { hasText: 'Liquidado el' }).locator('xpath=following-sibling::dd[1]')).toHaveText('—');
  });

  test('TC-11/12/13 · el filtro «Liquidado, pendiente de pago» viaja al servidor, se combina, se limpia y tiene vacío propio', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/impuestos');
    await expect(page.getByText('ABC123')).toBeVisible();
    await expect(page.getByText(/^6 impuestos/).first()).toBeVisible();

    const casilla = page.getByRole('checkbox', { name: 'Liquidado, pendiente de pago' });
    await casilla.check();
    await expect(page.getByText('ABC123')).toHaveCount(0);
    await expect(page.getByText('XYZ789')).toBeVisible();
    await expect(page.getByText('AMB004')).toBeVisible();
    await expect(page.getByText('OPS001')).toHaveCount(0);
    expect(urlsPedidas.at(-1)).toContain('liquidadoPendientePago=true');
    // No existe un contador de filtros activos en esta pantalla: el total de la paginación es lo
    // que refleja el filtro (6 → 2).
    await expect(page.getByText(/^2 impuestos/).first()).toBeVisible();

    // Combinable: los dos parámetros viajan juntos.
    await page.getByLabel('Gestiona').selectOption('operaciones');
    // Vacío específico del filtro (OPS001 es de Operaciones pero no tiene liquidación).
    await expect(page.getByText(/No hay impuestos liquidados pendientes de pago/)).toBeVisible();
    await expect(page.getByText(/Ningún impuesto coincide con los filtros/)).toHaveCount(0);
    expect(urlsPedidas.at(-1)).toContain('liquidadoPendientePago=true');
    expect(urlsPedidas.at(-1)).toContain('gestion=operaciones');

    await page.getByRole('button', { name: 'Limpiar filtros' }).click();
    await expect(casilla).not.toBeChecked();
    await expect(page.getByText('ABC123')).toBeVisible();
    expect(urlsPedidas.at(-1)).not.toContain('liquidadoPendientePago');
  });
});

test.describe('FLITO — Impuestos · recibo de caja (HU #12592)', () => {
  test('TC-14/15 · con la función: botón junto a «Ver soporte»; sin liquidación, deshabilitado con el motivo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    const detalle = await abrirDetalle(page, 'XYZ789');
    await expect(detalle.getByRole('button', { name: 'Ver soporte' })).toBeVisible();
    const boton = detalle.getByRole('button', { name: 'Cargar recibo de caja' });
    await expect(boton).toBeVisible();
    await expect(boton).toBeEnabled();
    await expect(detalle.getByText(/no tiene liquidación cargada/)).toHaveCount(0);
    await page.keyboard.press('Escape');

    const sinLiq = await abrirDetalle(page, 'OPS001');
    const botonOff = sinLiq.getByRole('button', { name: 'Cargar recibo de caja' });
    await expect(botonOff).toBeVisible();
    await expect(botonOff).toBeDisabled();
    await expect(botonOff).toHaveAttribute('aria-disabled', 'true');
    const motivo = sinLiq.getByText('Este impuesto no tiene liquidación cargada; el recibo de caja se carga sobre una liquidación');
    await expect(motivo).toBeVisible();
    const idMotivo = await motivo.getAttribute('id');
    await expect(botonOff).toHaveAttribute('aria-describedby', idMotivo!);
    // Sigue en el orden de tabulación: `aria-disabled`, no `disabled`.
    await botonOff.focus();
    await expect(botonOff).toBeFocused();
    await botonOff.click({ force: true });
    await expect(page.getByRole('dialog', { name: /Recibo de caja/ })).toHaveCount(0);
  });

  test('TC-16 · en Pendiente, Pagado y Con novedad el botón no existe aunque haya liquidación', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    for (const placa of ['ABC123', 'PAG005', 'NOV006']) {
      const detalle = await abrirDetalle(page, placa);
      await expect(detalle.getByRole('button', { name: 'Ver soporte' })).toBeVisible();
      await expect(detalle.getByRole('button', { name: 'Cargar recibo de caja' })).toHaveCount(0);
      await expect(detalle.getByText(/no tiene liquidación cargada/)).toHaveCount(0);
    }
  });

  test('TC-17 · el gestor de impuestos no ve el botón aunque el impuesto tenga liquidación', async ({ page }) => {
    await loginAs(page, GESTOR_IMPUESTOS_USER);
    await mock(page);
    const detalle = await abrirDetalle(page, 'XYZ789');
    await expect(detalle.getByRole('button', { name: 'Ver soporte' })).toBeVisible();
    await expect(detalle.getByRole('button', { name: 'Cargar recibo de caja' })).toHaveCount(0);
  });

  test('TC-17b · es la función, no el rol: admin sin «impuestos.recibos.cargar_caja» tampoco lo ve', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER, {
      funciones: FUNCIONES_POR_ROL.admin.filter((f) => f !== 'impuestos.recibos.cargar_caja'),
    });
    await mock(page);
    const detalle = await abrirDetalle(page, 'XYZ789');
    await expect(detalle.getByRole('button', { name: 'Ver soporte' })).toBeVisible();
    await expect(detalle.getByRole('button', { name: 'Cargar recibo de caja' })).toHaveCount(0);
  });

  test('TC-18/19/24 · el modal identifica el impuesto, valida el archivo en local y se cierra con Escape/Cancelar devolviendo el foco', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    let posts = 0;
    await page.route(/\/api\/flito\/impuestos\/i2\/recibo-caja$/, (route) => {
      posts += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ resultado: 'en_revision', soporteId: 's1', revisionId: 'r1' }) });
    });
    const detalle = await abrirDetalle(page, 'XYZ789');
    const boton = detalle.getByRole('button', { name: 'Cargar recibo de caja' });
    await boton.click();
    const modal = page.getByRole('dialog', { name: 'Recibo de caja · XYZ789' });
    await expect(modal).toBeVisible();
    await expect(modal.getByText(/Placa XYZ789 · Organismo STT Pereira · Valor liquidado \$\s?200\.000/)).toBeVisible();
    const input = modal.locator('input[type="file"]');
    await expect(input).not.toHaveAttribute('multiple', /.*/);
    const accept = (await input.getAttribute('accept')) ?? '';
    for (const ext of ['.pdf', '.png', '.jpg', '.jpeg']) expect(accept).toContain(ext);
    expect(accept).not.toContain('.zip');
    await expect(modal.getByRole('button', { name: 'Cargar', exact: true })).toBeDisabled();
    await expect(modal.getByRole('button', { name: 'Cancelar' })).toBeEnabled();

    // Validación local: 15 MB + 1 y un .docx no llegan al API.
    await input.setInputFiles({ name: 'grande.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(15 * 1024 * 1024 + 1) });
    await expect(modal.getByRole('alert')).toHaveText('El archivo debe ser PDF, JPG o PNG de máximo 15 MB. Elige otro archivo.');
    await modal.getByRole('button', { name: 'Elegir otro' }).click();
    await modal.locator('input[type="file"]').setInputFiles({ name: 'doc.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('x') });
    await expect(modal.getByRole('alert')).toHaveText(/PDF, JPG o PNG/);
    expect(posts).toBe(0);
    await modal.getByRole('button', { name: 'Elegir otro' }).click();

    // Escape cierra SOLO el modal del recibo y devuelve el foco al botón; el detalle sigue.
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await expect(detalle).toBeVisible();
    await expect(boton).toBeFocused();

    await boton.click();
    await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: 'Cancelar' }).click();
    await expect(modal).toHaveCount(0);
    await expect(detalle).toBeVisible();
    await expect(boton).toBeFocused();
  });

  test('TC-20/21/30 · pagado: POST con `archivo`, progreso que no se puede cerrar, resultado y refresco a Pagado sin cerrar el detalle', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const cola = colaMutable();
    await mock(page, cola.fuente);
    let cuerpo = '';
    let soltar: () => void = () => {};
    const retenido = new Promise<void>((r) => { soltar = r; });
    await page.route(/\/api\/flito\/impuestos\/i2\/recibo-caja$/, async (route) => {
      cuerpo = route.request().postData() ?? '';
      await retenido;
      cola.mutar('i2', { estado: 'pagado', valorPagado: 200000, marcadoPorDiferencia: true, documentos: 'ambos' });
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ resultado: 'pagado', valorPagado: '200000', pagadoEn: '2026-04-10T15:00:00Z', marcadoPorDiferencia: true, soporteId: 's1' }),
      });
    });

    const detalle = await abrirDetalle(page, 'XYZ789');
    const pedidasAntes = urlsPedidas.length;
    await detalle.getByRole('button', { name: 'Cargar recibo de caja' }).click();
    const modal = page.getByRole('dialog', { name: 'Recibo de caja · XYZ789' });
    await modal.locator('input[type="file"]').setInputFiles(PDF_CAJA);
    await expect(modal.getByText(/recibo-caja-xyz789\.pdf · /)).toBeVisible();
    await modal.getByRole('button', { name: 'Cargar', exact: true }).click();

    // Cargando: progreso visible, sin salida hasta el desenlace.
    await expect(modal.getByRole('button', { name: 'Cargando…' })).toBeDisabled();
    await expect(modal.getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    await expect(modal.locator('[aria-busy="true"]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await modal.getByRole('button', { name: 'Cerrar' }).click();
    await expect(modal).toBeVisible();

    soltar();
    await expect(modal.getByText('Pagado', { exact: true })).toBeVisible();
    await expect(modal.getByText(/Valor pagado \$\s?200\.000 · Fecha de pago \d{1,2}\/\d{2}\/\d{2}/)).toBeVisible();
    await expect(modal.getByText('Diferencia de valor', { exact: true })).toBeVisible();
    await expect(modal.getByText(/difiere del liquidado por encima de la tolerancia/)).toBeVisible();
    expect(cuerpo.match(/name="archivo"/g)?.length).toBe(1);
    expect(cuerpo).not.toMatch(/name="archivos"/);
    expect(cuerpo).toContain('filename="recibo-caja-xyz789.pdf"');

    // «Listo»: la cola se vuelve a pedir, el detalle SIGUE abierto y ya dice Pagado; el botón se va
    // y el foco cae en «Ver soporte».
    await modal.getByRole('button', { name: 'Listo' }).click();
    await expect(modal).toHaveCount(0);
    await expect.poll(() => urlsPedidas.length).toBeGreaterThan(pedidasAntes);
    await expect(detalle).toBeVisible();
    await expect(detalle.getByText('Pagado', { exact: true })).toBeVisible();
    await expect(detalle.getByRole('button', { name: 'Cargar recibo de caja' })).toHaveCount(0);
    await expect(detalle.getByRole('button', { name: 'Ver soporte' })).toBeFocused();
    await expect(page.getByRole('row').filter({ hasText: 'XYZ789' }).getByText('Pagado', { exact: true })).toBeVisible();
  });

  test('TC-22 · en_revision: el recibo queda guardado, el estado no cambia y el chip pasa a «Ambos»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const cola = colaMutable();
    await mock(page, cola.fuente);
    await page.route(/\/api\/flito\/impuestos\/i2\/recibo-caja$/, (route) => {
      cola.mutar('i2', { documentos: 'ambos' });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ resultado: 'en_revision', soporteId: 's1', revisionId: 'r1' }) });
    });
    const detalle = await abrirDetalle(page, 'XYZ789');
    const boton = detalle.getByRole('button', { name: 'Cargar recibo de caja' });
    await boton.click();
    const modal = page.getByRole('dialog', { name: 'Recibo de caja · XYZ789' });
    await modal.locator('input[type="file"]').setInputFiles(PDF_CAJA);
    await modal.getByRole('button', { name: 'Cargar', exact: true }).click();
    await expect(modal.getByText('En revisión', { exact: true })).toBeVisible();
    await expect(modal.getByText(/no fue concluyente/)).toBeVisible();
    await expect(modal.getByText(/cola de revisión/)).toBeVisible();
    await expect(modal.getByText(/sigue Solicitado/)).toBeVisible();
    await modal.getByRole('button', { name: 'Listo' }).click();
    await expect(modal).toHaveCount(0);
    await expect(detalle).toBeVisible();
    await expect(detalle.getByText('Solicitado', { exact: true })).toBeVisible();
    await expect(detalle.getByText('Ambos', { exact: true })).toBeVisible();
    await expect(boton).toBeVisible();
    await expect(boton).toBeFocused();
    await expect(page.getByRole('row').filter({ hasText: 'XYZ789' }).getByText('Ambos', { exact: true })).toBeVisible();
  });

  test('TC-23 · cada fallo tiene su mensaje y su salida: cerrar, elegir otro o reintentar con el mismo archivo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const cola = colaMutable();
    await mock(page, cola.fuente);
    const secuencia: Array<{ status: number; body?: unknown; abortar?: boolean }> = [
      { status: 503, body: { error: 'OCR caído' } },
      { status: 0, abortar: true },
      { status: 500, body: { error: 'boom' } },
      { status: 409, body: { error: 'dup', codigo: 'duplicado' } },
      { status: 400, body: { error: 'inv', codigo: 'archivo_invalido' } },
      { status: 403, body: { error: 'sin función', funcion: 'impuestos.recibos.cargar_caja', motivo: 'x' } },
      { status: 404, body: { error: 'no', codigo: 'no_encontrado' } },
      { status: 409, body: { error: 'sin liq', codigo: 'sin_liquidacion' } },
      { status: 409, body: { error: 'estado', codigo: 'estado_no_permitido' } },
    ];
    const nombres: string[] = [];
    await page.route(/\/api\/flito\/impuestos\/i2\/recibo-caja$/, (route) => {
      nombres.push(/filename="([^"]+)"/.exec(route.request().postData() ?? '')?.[1] ?? '');
      const paso = secuencia.shift()!;
      if (paso.abortar) return route.abort('failed');
      return route.fulfill({ status: paso.status, contentType: 'application/json', body: JSON.stringify(paso.body) });
    });

    const detalle = await abrirDetalle(page, 'XYZ789');
    const boton = detalle.getByRole('button', { name: 'Cargar recibo de caja' });
    const modal = page.getByRole('dialog', { name: 'Recibo de caja · XYZ789' });
    const abrirYCargar = async () => {
      if (await modal.count() === 0) await boton.click();
      await modal.locator('input[type="file"]').setInputFiles(PDF_CAJA);
      await modal.getByRole('button', { name: 'Cargar', exact: true }).click();
    };

    // 503, red y 500 sin `codigo`: «Reintentar» reenvía el MISMO archivo sin volver a elegirlo.
    await abrirYCargar();
    await expect(modal.getByRole('alert')).toHaveText('El lector de recibos no respondió. No se guardó nada; reintenta en unos minutos.');
    await modal.getByRole('button', { name: 'Reintentar' }).click();
    await expect(modal.getByText(/recibo-caja-xyz789\.pdf · /)).toBeVisible();
    await modal.getByRole('button', { name: 'Cargar', exact: true }).click();
    await expect(modal.getByRole('alert')).toHaveText('No se pudo completar la carga. Revisa tu conexión y reintenta.');
    await modal.getByRole('button', { name: 'Reintentar' }).click();
    await modal.getByRole('button', { name: 'Cargar', exact: true }).click();
    await expect(modal.getByRole('alert')).toHaveText('No se pudo completar la carga. Revisa tu conexión y reintenta.');
    await modal.getByRole('button', { name: 'Reintentar' }).click();
    await modal.getByRole('button', { name: 'Cargar', exact: true }).click();
    expect(nombres).toEqual(['recibo-caja-xyz789.pdf', 'recibo-caja-xyz789.pdf', 'recibo-caja-xyz789.pdf', 'recibo-caja-xyz789.pdf']);

    // 409 duplicado y 400: «Elegir otro» vuelve a inicial SIN archivo.
    await expect(modal.getByRole('alert')).toHaveText('Ese archivo ya está registrado como recibo. Elige otro archivo.');
    await modal.getByRole('button', { name: 'Elegir otro' }).click();
    await expect(modal.getByRole('button', { name: 'Cargar', exact: true })).toBeDisabled();
    await expect(modal.getByText(/recibo-caja-xyz789\.pdf · /)).toHaveCount(0);
    await abrirYCargar();
    await expect(modal.getByRole('alert')).toHaveText('El archivo debe ser PDF, JPG o PNG de máximo 15 MB. Elige otro archivo.');
    await modal.getByRole('button', { name: 'Elegir otro' }).click();

    // 403, 404, 409 sin_liquidacion: «Cerrar» cierra el modal (y solo el modal).
    for (const texto of [
      'Tu usuario no tiene la función para cargar recibos de caja. Pídela al administrador.',
      'Este impuesto no está disponible para tu usuario.',
      'Este impuesto no tiene liquidación cargada. Súbela primero desde «Cargar recibos (masivo)» con la fase Liquidación.',
    ]) {
      await abrirYCargar();
      await expect(modal.getByRole('alert')).toHaveText(texto);
      // El botón de la acción, no la X del encabezado (que también se llama «Cerrar»).
      await modal.getByRole('alert').locator('xpath=following-sibling::button[1]').click();
      await expect(modal).toHaveCount(0);
      await expect(detalle).toBeVisible();
      await expect(boton).toBeFocused();
    }

    // 409 estado_no_permitido: cierra Y refresca la cola.
    const pedidasAntes = urlsPedidas.length;
    await abrirYCargar();
    await expect(modal.getByRole('alert')).toHaveText('El impuesto ya no está en gestión. Cierra y revisa su estado en la cola.');
    await modal.getByRole('alert').locator('xpath=following-sibling::button[1]').click();
    await expect(modal).toHaveCount(0);
    await expect.poll(() => urlsPedidas.length).toBeGreaterThan(pedidasAntes);
  });
});

// ─────────────────────── HU #12615 — «Fase no coincide», aviso de carpetas y copy ───────────────────────

/** ZIP de verdad, comprimido en el proceso de test: el navegador lo abre con su propio JSZip. */
async function zipCon(entradas: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [ruta, contenido] of Object.entries(entradas)) zip.file(ruta, contenido);
  return zip.generateAsync({ type: 'nodebuffer' });
}

const archivoZip = (nombre: string, buffer: Buffer) => ({ name: nombre, mimeType: 'application/zip', buffer });

const DETALLE_PAGO_SIN_SELLO = 'No se ve el sello PAGADO; súbelo con la fase Liquidación.';
const DETALLE_LIQUIDACION_CON_SELLO = 'Tiene sello PAGADO; súbelo con la fase Pago.';
const AVISO_CARPETA = /no dice si son liquidaciones o pagos/;

async function abrirModalCarga(page: import('@playwright/test').Page) {
  await loginAs(page, OPERACIONES_USER);
  await mock(page);
  await page.goto('/flito/impuestos');
  await page.getByRole('button', { name: 'Cargar recibos (masivo)' }).click();
  return page.getByRole('dialog', { name: 'Carga masiva de recibos de impuesto' });
}

test.describe('FLITO — Impuestos · «Fase no coincide», aviso de carpetas y copy (HU #12615)', () => {
  test('AC2 · TC-06 · el chip «Fase no coincide N» es el séptimo, se acumula entre tandas y cada fila trae el motivo del servidor tal cual', async ({ page }) => {
    const modal = await abrirModalCarga(page);
    let tanda = 0;
    await page.route(/\/api\/flito\/impuestos\/recibos$/, (route) => {
      tanda += 1;
      const faseNoCoincide = tanda === 1
        ? [{ archivo: 'f1.pdf', detalle: DETALLE_PAGO_SIN_SELLO }]
        : [{ archivo: 'f6.pdf', detalle: DETALLE_LIQUIDACION_CON_SELLO }];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...OCR_VACIO, faseNoCoincide }) });
    });
    await modal.locator('input[type="file"]').setInputFiles(
      Array.from({ length: 6 }, (_, i) => ({ name: `f${i + 1}.pdf`, mimeType: 'application/pdf' as const, buffer: Buffer.from('%PDF-1.4 x') })),
    );
    await modal.getByRole('button', { name: 'Subir y procesar' }).click();
    await expect(modal.getByRole('button', { name: 'Listo' })).toBeVisible();
    expect(tanda).toBe(2);

    // Acumulado entre tandas (mutante M-acumula: fusionar sin `faseNoCoincide` → «Fase no coincide 1»).
    await expect(modal.getByText('Fase no coincide 2', { exact: true })).toBeVisible();
    // Séptimo chip, tras «Sin asociar»: el orden de los chips es el de las filas.
    const chips = modal.locator('.flex.flex-wrap > *');
    await expect(chips).toHaveCount(7);
    await expect(chips.nth(5)).toHaveText('Sin asociar 0');
    await expect(chips.nth(6)).toHaveText('Fase no coincide 2');
    // Filas con el `detalle` literal, con su punto final; sin texto propio ni botón.
    const filas = modal.getByRole('row').filter({ hasText: 'Fase no coincide' }).filter({ hasText: /\.pdf/ });
    await expect(filas).toHaveCount(2);
    await expect(modal.getByRole('row').filter({ hasText: 'f1.pdf' })).toContainText(DETALLE_PAGO_SIN_SELLO);
    await expect(modal.getByRole('row').filter({ hasText: 'f6.pdf' })).toContainText(DETALLE_LIQUIDACION_CON_SELLO);
    await expect(modal.getByRole('button', { name: /reintentar|otra fase/i })).toHaveCount(0);
  });

  test('AC2 · TC-07 · «Fase no coincide 0» se pinta como las demás, también si la respuesta no trae la clave', async ({ page }) => {
    const modal = await abrirModalCarga(page);
    // Mock VIEJO: sin `faseNoCoincide` ni `carpetasSinFase` (servidor sin desplegar) → 0 y sin nota, sin crash.
    await page.route(/\/api\/flito\/impuestos\/recibos$/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OCR_VACIO) }));
    await modal.locator('input[type="file"]').setInputFiles([{ name: 'uno.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 x') }]);
    await modal.getByRole('button', { name: 'Subir y procesar' }).click();
    await expect(modal.getByText('Fase no coincide 0', { exact: true })).toBeVisible();
    await expect(modal.getByText('No se procesó ningún archivo.')).toBeVisible();
    await expect(modal.getByText(/no decían? si eran liquidaciones o pagos/)).toHaveCount(0);
  });

  test('AC3 · TC-08 · el aviso por carpeta no reconocida sale antes de enviar, una línea por carpeta raíz, no bloquea y sigue al selector', async ({ page }) => {
    const modal = await abrirModalCarga(page);
    await page.route(/\/api\/flito\/impuestos\/recibos$/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...OCR_VACIO, faseNoCoincide: [], carpetasSinFase: [] }) }));
    const zip = await zipCon({
      'otros/a.pdf': '%PDF-1.4 a', '2026/b.pdf': '%PDF-1.4 b', 'SIN MARCA/c.pdf': '%PDF-1.4 c', 'otros/d.pdf': '%PDF-1.4 d',
      'liquidaciones_pagadas/e.pdf': '%PDF-1.4 e', 'SIN MARCA DE AGUA/f.pdf': '%PDF-1.4 f',
    });
    await modal.locator('input[type="file"]').setInputFiles([archivoZip('agosto.zip', zip)]);
    await expect(modal.getByText(/^6 archivos de «agosto\.zip» · /)).toBeVisible();

    // Una línea por carpeta RAÍZ (otros aparece dos veces → una línea); las reconocidas y la
    // negación («SIN MARCA DE AGUA») no avisan. Con Pago (defecto) el paréntesis dice (Pago).
    const avisos = modal.getByText(AVISO_CARPETA);
    await expect(avisos).toHaveCount(2);
    await expect(avisos.nth(0)).toHaveText('La carpeta «otros» no dice si son liquidaciones o pagos: sus recibos tomarán la fase seleccionada (Pago).');
    await expect(avisos.nth(1)).toHaveText('La carpeta «2026» no dice si son liquidaciones o pagos: sus recibos tomarán la fase seleccionada (Pago).');
    // Región `status`/`polite`, no `alert`: nada falló y la primaria sigue habilitada.
    await expect(modal.getByRole('status').filter({ hasText: AVISO_CARPETA })).toHaveCount(1);
    await expect(modal.getByRole('alert')).toHaveCount(0);
    await expect(modal.getByRole('button', { name: 'Subir y procesar' })).toBeEnabled();

    // Derivado del selector (mutante M-aviso: aviso fijo en «Pago» → cae aquí). El foco no se mueve.
    await modal.getByRole('radio', { name: 'Liquidación' }).check();
    await expect(modal.getByRole('radio', { name: 'Liquidación' })).toBeFocused();
    await expect(avisos.nth(0)).toHaveText(/tomarán la fase seleccionada \(Liquidación\)\.$/);
    await expect(avisos.nth(1)).toHaveText(/tomarán la fase seleccionada \(Liquidación\)\.$/);
    await expect(avisos).toHaveCount(2);

    await modal.getByRole('button', { name: 'Subir y procesar' }).click();
    await expect(modal.getByRole('button', { name: 'Listo' })).toBeVisible();
    await expect(modal.getByText(AVISO_CARPETA)).toHaveCount(0);
  });

  test('AC3 · TC-09 · sin carpetas no reconocidas no hay aviso: carpetas reconocidas, ZIP plano y sueltos', async ({ page }) => {
    const modal = await abrirModalCarga(page);
    const input = modal.locator('input[type="file"]');

    await input.setInputFiles([archivoZip('a.zip', await zipCon({ 'CON MARCA/1.pdf': '%PDF-1.4', 'SIN MARCA/2.pdf': '%PDF-1.4' }))]);
    await expect(modal.getByText(/^2 archivos de «a\.zip» · /)).toBeVisible();
    await expect(modal.getByText(AVISO_CARPETA)).toHaveCount(0);

    await input.setInputFiles([archivoZip('b.zip', await zipCon({ 'recibo-1.pdf': '%PDF-1.4', 'recibo-2.pdf': '%PDF-1.4' }))]);
    await expect(modal.getByText(/^2 archivos de «b\.zip» · /)).toBeVisible();
    await expect(modal.getByText(AVISO_CARPETA)).toHaveCount(0);

    await input.setInputFiles([
      { name: 'uno.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') },
      { name: 'pagado.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') },
    ]);
    await expect(modal.getByText(/^2 archivos · /)).toBeVisible();
    await expect(modal.getByText(AVISO_CARPETA)).toHaveCount(0);
    await expect(modal.getByRole('button', { name: 'Subir y procesar' })).toBeEnabled();
  });

  test('AC3 · TC-10 · la nota del resumen nombra cada carpeta sin fase UNA vez aunque venga en cada tanda', async ({ page }) => {
    const modal = await abrirModalCarga(page);
    let tandas = 0;
    await page.route(/\/api\/flito\/impuestos\/recibos$/, (route) => {
      tandas += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...OCR_VACIO, faseNoCoincide: [], carpetasSinFase: ['otros'] }) });
    });
    const entradas: Record<string, string> = {};
    for (let i = 1; i <= 12; i++) entradas[`otros/recibo-${i}.pdf`] = `%PDF-1.4 ${i}`;
    await modal.locator('input[type="file"]').setInputFiles([archivoZip('agosto.zip', await zipCon(entradas))]);
    await modal.getByRole('radio', { name: 'Liquidación' }).check();
    await modal.getByRole('button', { name: 'Subir y procesar' }).click();
    await expect(modal.getByRole('button', { name: 'Listo' })).toBeVisible();
    expect(tandas).toBe(3);
    // Deduplicado al pintar (mutante M5: pintar `carpetasSinFase` tal cual → «otros», «otros» y 1 más).
    const nota = modal.getByText(/no decía si eran liquidaciones o pagos/);
    await expect(nota).toHaveCount(1);
    await expect(nota).toHaveText('La carpeta «otros» no decía si eran liquidaciones o pagos: sus recibos se cargaron con la fase Liquidación.');
    await expect(modal.getByText(/«otros»/)).toHaveCount(1);
  });

  test('AC4 · TC-11/12 · el intro dice qué se puede subir y qué hace cada fase, sin describir el proceso; la ayuda del ZIP nombra las carpetas reales', async ({ page }) => {
    const modal = await abrirModalCarga(page);
    const intro = modal.getByTestId('intro-carga-recibos');
    await expect(intro).toHaveText('Se admiten PDF, imágenes (JPG, PNG) o un ZIP: hasta 150 archivos sueltos o 300 dentro de un ZIP, de máximo 15 MB cada uno. Con la fase Liquidación el impuesto queda liquidado (valor y fecha) sin pagarlo. Con la fase Pago el recibo con sello PAGADO lo deja en Pagado.');
    await expect(intro).not.toHaveText(/5 en 5|computador|tanda|OCR|placa/i);
    // Énfasis real en los nombres de fase: nombran el valor del selector.
    await expect(intro.locator('strong')).toHaveText(['Liquidación', 'Pago']);
    const ayuda = modal.getByRole('group', { name: 'Fase del recibo' }).locator('p');
    await expect(ayuda).toHaveText('En un ZIP manda la carpeta de cada recibo: «liquidaciones_originales» o «sin marca» → Liquidación; «liquidaciones_pagadas», «pagadas» o «con marca» → Pago. La fase elegida aplica a los archivos sueltos y a las carpetas que no digan ninguna de las dos.');
  });
});

test.describe('FLITO — Impuestos · ficha de ayuda (HU #12592, AC7)', () => {
  // Ningún otro test lee el CONTENIDO de la ficha (flito-ayuda-fichas-gestion vigila plantilla y
  // publicación); este es el que la ata a la HU. *Mutante:* dejar la ficha como estaba → cae por
  // «sin marca de agua» presente y «recibo de caja» ausente.
  test('TC-25 · la ficha explica las dos fases, el selector, «Liquidados», el chip, el filtro y el recibo de caja; ya no menciona la casilla', async () => {
    const raiz = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
    const md = readFileSync(resolve(raiz, 'apps/web/src/content/ayuda/flito_impuestos.md'), 'utf8');
    expect(md).toMatch(/dos fases/i);
    expect(md).toMatch(/La \*\*liquidación\*\* es el documento de la hacienda sin sello/);
    expect(md).toMatch(/El \*\*pago\*\* es el mismo documento con el sello de pagado/);
    expect(md).toMatch(/\*\*Fase del recibo\*\*/);
    expect(md).toMatch(/\(\*\*Pago\*\* viene marcado\)/);
    expect(md).toMatch(/carpeta/i);
    expect(md).toMatch(/\*\*Liquidados\*\*/);
    expect(md).toMatch(/\*\*Liquidado, pendiente de pago\*\*/);
    expect(md).toMatch(/\*\*Cargar recibo de caja\*\*/);
    // Quién puede, cuándo, y qué pasa si el valor no se lee.
    expect(md).toMatch(/Administrador .*recibo(s)? de caja|recibos? de caja.*Administrador/i);
    expect(md).toMatch(/solo en un impuesto \*\*Solicitado\*\*/);
    expect(md).toMatch(/Si el valor no se pudo leer/);
    expect(md).not.toMatch(/sin marca de agua/i);
    // HU #12615 (AC5, TC-13): la ficha dice qué subir, las carpetas reales y la categoría nueva, y
    // ya no describe el proceso. *Mutante:* dejar el paso 6 anterior → cae por «5 en 5» y
    // «computador» presentes y «Fase no coincide» ausente.
    expect(md).not.toMatch(/5 en 5|computador|comprimido|tanda/i);
    expect(md).toMatch(/\*\*150 archivos sueltos\*\*/);
    expect(md).toMatch(/\*\*300 dentro de un ZIP\*\*/);
    expect(md).toMatch(/\*\*liquidaciones_originales\*\* o \*\*sin marca\*\* es Liquidación/);
    expect(md).toMatch(/\*\*liquidaciones_pagadas\*\*, \*\*pagadas\*\* o \*\*con marca\*\* es Pago/);
    expect(md).toMatch(/se lo avisa antes de enviar/);
    expect(md).toMatch(/\*\*Sin asociar\*\* y \*\*Fase no coincide\*\*/);
    expect(md).toMatch(/\*\*Fase no coincide\*\* significa que el sello del documento contradice la fase elegida/);
    expect(md).toMatch(/\*\*no se guardaron\*\*; vuelva a subirlos/);
    // Sigue en plantilla: 6 secciones, forma «usted», sin tabla ni captura ni endpoint.
    for (const h of ['Qué es', 'Para quién', 'Cómo se entra', 'Pasos', 'Estados', 'Qué no hace']) expect(md).toContain(`## ${h}`);
    expect(md).toMatch(/\busted\b/i);
    expect(md).not.toMatch(/\btú\b/);
    expect(md).not.toMatch(/!\[[^\]]*\]\(/);
    expect(md).not.toMatch(/\/api\//);
    expect(md).not.toMatch(/\|[-:]+\|/);
  });
});
