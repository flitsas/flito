import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { funcionesDe, loginAs, OPERACIONES_USER } from '../helpers/auth';

// FLITO — Impuestos · HU #13209: «Cargar comprobante» (liquidación o pago por fase) desde el detalle
// del impuesto. Spec UX: docs/ux/flito-impuestos-carga-comprobante-por-fase.md. Backend mockeado
// (`POST /api/flito/impuestos/:id/recibos`, HU #13208), mismo patrón que `flito-impuestos-reintentar`.

const BASE = {
  tramiteId: 't', vin: 'VIN0000000000000', marca: 'Renault', linea: 'Duster', tipoTramite: 'Traspaso',
  fechaAprobacion: null, fechaCreacion: '2026-09-01T12:00:00Z',
  compradorNombre: 'Ana Pérez', compradorDocumento: '10101010', compradorTipoDocumento: 'CC',
  companiaNombre: 'Concesionario Norte', organismoCodigo: 'STT-MZL', organismoNombre: 'STT Manizales',
  valorLiquidado: null, valorPagado: null, marcadoPorDiferencia: false, tieneFacturaVenta: true,
  enviadoPorNombre: 'Operaciones E2E', enviadoEn: '2026-09-02T12:00:00Z', pagadoEn: null, estancado: false,
  motivoRechazo: null, creadoEn: '2026-09-01T12:00:00Z', gestionOperaciones: false,
  certificacion: null, liquidadoEn: null, documentos: null, analisisEstado: 'completado',
  semaforo: 'verde', motivoSemaforo: null,
};

type Fila = Record<string, unknown> & { id: string };
const fila = (id: string, placa: string, extra: Partial<Fila> = {}): Fila => ({
  ...BASE, id, idFlit: `FLIT-${id}`, placa, estado: 'solicitado', ...extra,
});

const filasIniciales = (): Fila[] => [
  fila('s1', 'SOL001'),
  fila('l1', 'LIQ001', { documentos: 'liquidacion', liquidadoEn: '2026-09-03T12:00:00Z', valorLiquidado: 120000 }),
  fila('p1', 'PAG001', { estado: 'pagado', documentos: 'pago', valorPagado: 120000 }),
  fila('a1', 'AMB001', { estado: 'pagado', documentos: 'ambos' }),
  fila('n1', 'PEN001', { estado: 'pendiente' }),
];

type Respuesta = { status: number; body?: unknown; abortar?: boolean };
const estado = {
  filas: filasIniciales(),
  respuesta: { status: 200, body: {} } as Respuesta,
  /** Fila que queda tras una carga con escritura (refresco del AC4). */
  trasEscritura: null as null | ((f: Fila) => Fila),
  soltar: true,
  listados: 0,
  soportes: 0,
  cuerpos: [] as string[],
};

async function mock(page: Page) {
  estado.filas = filasIniciales();
  estado.respuesta = { status: 200, body: {} };
  estado.trasEscritura = null;
  estado.soltar = true;
  estado.listados = 0; estado.soportes = 0; estado.cuerpos = [];
  await page.route(/\/api\/flito\/impuestos\/facetas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ companias: [], organismos: [] }) }));
  await page.route(/\/api\/flito\/impuestos\?/, (route) => {
    estado.listados += 1;
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: estado.filas, total: estado.filas.length, page: 1, pageSize: 50 }),
    });
  });
  await page.route(/\/api\/flito\/impuestos\/[a-z0-9]+\/soportes$/, (route) => {
    estado.soportes += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.route(/\/api\/flito\/impuestos\/[a-z0-9]+\/recibos$/, async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
    estado.cuerpos.push(route.request().postDataBuffer()?.toString('latin1') ?? '');
    while (!estado.soltar) await new Promise((r) => setTimeout(r, 50));
    const r = estado.respuesta;
    if (r.abortar) return route.abort('failed');
    if (r.status === 200 && estado.trasEscritura) {
      estado.filas = estado.filas.map((f) => (f.id === id ? estado.trasEscritura!(f) : f));
    }
    return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body ?? {}) });
  });
  await page.route(/\/api\/flito\/impuestos\/[a-z0-9]+$/, (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop()!;
    const f = estado.filas.find((x) => x.id === id);
    if (!f) return route.fallback();
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        ...f, direccionComprador: null, soportes: [],
        comparacion: { version: 1, motivo: null, campos: [], resumen: { coinciden: 0, difieren: 0, noVerificables: 0 }, calculadoEn: '2026-09-02T12:05:00Z' },
      }),
    });
  });
}

const abrirDetalle = async (page: Page, placa: string) => {
  await page.getByRole('row').filter({ hasText: placa }).getByRole('button', { name: 'Ver', exact: true }).click();
  const detalle = page.getByRole('dialog', { name: `Impuesto · ${placa}` });
  await expect(detalle).toBeVisible();
  return detalle;
};

const abrirCarga = async (page: Page, placa: string) => {
  const detalle = await abrirDetalle(page, placa);
  await detalle.getByRole('button', { name: 'Cargar comprobante' }).click();
  const modal = page.getByRole('dialog', { name: `Cargar comprobante · ${placa}` });
  await expect(modal).toBeVisible();
  return { detalle, modal };
};

const PDF = { name: 'recibo-hacienda.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF') };
const elegirArchivo = (modal: Locator, archivo = PDF) => modal.locator('input[type="file"]').setInputFiles(archivo);
const radio = (modal: Locator, nombre: 'Liquidación' | 'Pago') => modal.getByRole('radio', { name: new RegExp(`^${nombre}`) });

async function cargarCon(modal: Locator, fase: 'Liquidación' | 'Pago') {
  await radio(modal, fase).check();
  await elegirArchivo(modal);
  await modal.getByRole('button', { name: 'Cargar', exact: true }).click();
}

const iniciar = async (page: Page, user = OPERACIONES_USER) => {
  await loginAs(page, user);
  await mock(page);
  await page.goto('/flito/impuestos');
};

test.describe('FLITO — Impuestos · cargar comprobante por fase desde el detalle (HU #13209)', () => {
  test('AC1 · con la función aparece entre «Ver soporte» y «Cargar recibo de caja»; no en Pendiente ni con ambos', async ({ page }) => {
    await iniciar(page);
    let detalle = await abrirDetalle(page, 'SOL001');
    const textos = await detalle.locator('dd').filter({ hasText: 'Ver soporte' }).getByRole('button').allInnerTexts();
    expect(textos.map((t) => t.trim())).toEqual(['Ver soporte', 'Cargar comprobante', 'Cargar recibo de caja']);
    // Secundario como el de caja: el detalle sigue sin primaria.
    await expect(detalle.getByRole('button', { name: 'Cargar comprobante' })).not.toHaveCSS('background-image', /gradient/);
    // Sin liquidación, el motivo del recibo de caja manda a «Cargar comprobante».
    await expect(detalle.locator('#recibo-caja-motivo')).toHaveText('Este impuesto no tiene liquidación cargada. Cárgala primero con «Cargar comprobante».');
    await page.keyboard.press('Escape');

    detalle = await abrirDetalle(page, 'PAG001');
    await expect(detalle.getByRole('button', { name: 'Cargar comprobante' })).toBeVisible();
    await page.keyboard.press('Escape');
    for (const placa of ['AMB001', 'PEN001']) {
      detalle = await abrirDetalle(page, placa);
      await expect(detalle.getByRole('button', { name: 'Cargar comprobante' })).toHaveCount(0);
      await page.keyboard.press('Escape');
    }
  });

  test('AC1 · sin `impuestos.recibos.cargar` no se pinta; el recibo de caja conserva su botón', async ({ page }) => {
    const sinCargar = { ...OPERACIONES_USER, funciones: funcionesDe(OPERACIONES_USER).filter((f) => f !== 'impuestos.recibos.cargar') };
    await iniciar(page, sinCargar);
    const detalle = await abrirDetalle(page, 'LIQ001');
    await expect(detalle.getByRole('button', { name: 'Cargar comprobante' })).toHaveCount(0);
    await expect(detalle.getByRole('button', { name: 'Cargar recibo de caja' })).toBeEnabled();
  });

  test('AC3 + AC5 · vacío: fase obligatoria sin defecto, fase ya cargada deshabilitada, «Cargar» habilita con fase y archivo', async ({ page }) => {
    await iniciar(page);
    const { modal } = await abrirCarga(page, 'LIQ001');
    await expect(modal).toContainText('Organismo STT Manizales · Documentos: Solo liquidación');
    await expect(modal.getByRole('group', { name: 'Fase del comprobante *' })).toBeVisible();
    await expect(radio(modal, 'Liquidación')).toBeDisabled();
    await expect(modal.getByText('Ya cargada')).toBeVisible();
    await expect(radio(modal, 'Pago')).not.toBeChecked();
    await expect(modal.getByLabel(/Archivo/)).toBeAttached();

    const cargar = modal.getByRole('button', { name: 'Cargar', exact: true });
    await expect(cargar).toBeDisabled();
    await expect(cargar).toHaveAccessibleDescription('Elige la fase y el archivo para cargar.');
    await radio(modal, 'Pago').check();
    await expect(cargar).toBeDisabled();
    await elegirArchivo(modal);
    await expect(modal).toContainText('recibo-hacienda.pdf');
    await expect(cargar).toBeEnabled();
    await expect(modal.getByText('Elige la fase y el archivo para cargar.')).toHaveCount(0);
  });

  test('AC3 · archivo primero: sin fase «Cargar» sigue deshabilitado; al elegir la fase se habilita', async ({ page }) => {
    await iniciar(page);
    const { modal } = await abrirCarga(page, 'SOL001');
    const cargar = modal.getByRole('button', { name: 'Cargar', exact: true });
    await elegirArchivo(modal);
    await expect(modal).toContainText('recibo-hacienda.pdf');
    await expect(radio(modal, 'Liquidación')).not.toBeChecked();
    await expect(radio(modal, 'Pago')).not.toBeChecked();
    await expect(cargar).toBeDisabled();
    await expect(cargar).toHaveAccessibleDescription('Elige la fase y el archivo para cargar.');
    await radio(modal, 'Liquidación').check();
    await expect(cargar).toBeEnabled();
    await expect(modal.getByText('Elige la fase y el archivo para cargar.')).toHaveCount(0);
  });

  test('AC2 · copy de cada resultado 200 (nunca la placa leída) y la fase viaja en la petición', async ({ page }) => {
    await iniciar(page);
    const casos: { body: Record<string, unknown>; fase: 'Liquidación' | 'Pago'; ve: string[]; primaria: string }[] = [
      { body: { resultado: 'liquidado', soporteId: 'x', valorLiquidado: '120000' }, fase: 'Liquidación',
        ve: ['Liquidación cargada', 'El impuesto sigue Solicitado; falta el pago.'], primaria: 'Listo' },
      { body: { resultado: 'liquidado', soporteId: 'x', valorLiquidado: null }, fase: 'Liquidación',
        ve: ['el valor no se leyó con claridad y no se registró. Revísalo en «Ver soporte».'], primaria: 'Listo' },
      { body: { resultado: 'pagado', soporteId: 'x', valorPagado: '120000', marcadoPorDiferencia: false }, fase: 'Pago',
        ve: ['Pagado', 'El impuesto pasó a Pagado.'], primaria: 'Listo' },
      { body: { resultado: 'pagado', soporteId: 'x', valorPagado: '130000', marcadoPorDiferencia: true }, fase: 'Pago',
        ve: ['Diferencia de valor', 'Queda marcado para revisión.'], primaria: 'Listo' },
      { body: { resultado: 'en_revision', soporteId: 'x', revisionId: 'r' }, fase: 'Pago',
        ve: ['En revisión', 'el impuesto sigue Solicitado hasta que se apruebe.'], primaria: 'Listo' },
      { body: { resultado: 'complemento', soporteId: 'x' }, fase: 'Pago',
        ve: ['Comprobante agregado', 'El impuesto sigue Pagado.'], primaria: 'Listo' },
      { body: { resultado: 'duplicado', detalle: 'El mismo archivo ya está entre los soportes.' }, fase: 'Pago',
        ve: ['No se guardó', 'Este comprobante ya estaba registrado.', 'El mismo archivo ya está entre los soportes.'], primaria: 'Elegir otro archivo' },
      { body: { resultado: 'fase_no_coincide', detalle: '' }, fase: 'Pago',
        ve: ['El documento no corresponde a la fase que elegiste.'], primaria: 'Cambiar fase' },
      { body: { resultado: 'placa_no_coincide', detalle: 'La placa del documento no corresponde.' }, fase: 'Liquidación',
        ve: ['El comprobante es de otro vehículo'], primaria: 'Elegir otro archivo' },
    ];
    const detalle = await abrirDetalle(page, 'SOL001');
    for (const c of casos) {
      estado.respuesta = { status: 200, body: c.body };
      await detalle.getByRole('button', { name: 'Cargar comprobante' }).click();
      const modal = page.getByRole('dialog', { name: 'Cargar comprobante · SOL001' });
      await cargarCon(modal, c.fase);
      const status = modal.getByRole('status');
      for (const t of c.ve) await expect(status).toContainText(t);
      await expect(modal.getByRole('button', { name: c.primaria })).toBeFocused();
      if (c.primaria === 'Listo') await modal.getByRole('button', { name: 'Listo' }).click();
      else await modal.getByRole('button', { name: 'Cerrar', exact: true }).last().click();
      await expect(modal).toHaveCount(0);
    }
    const fases = estado.cuerpos.map((b) => /name="fase"\r\n\r\n(\w+)/.exec(b)?.[1]);
    expect(fases).toEqual(casos.map((c) => (c.fase === 'Pago' ? 'pago' : 'liquidacion')));
  });

  test('AC2 · «Cambiar fase» conserva el archivo y limpia la fase; «Elegir otro archivo» conserva la fase', async ({ page }) => {
    await iniciar(page);
    const { modal } = await abrirCarga(page, 'SOL001');
    estado.respuesta = { status: 200, body: { resultado: 'fase_no_coincide', detalle: '' } };
    await cargarCon(modal, 'Pago');
    await modal.getByRole('button', { name: 'Cambiar fase' }).click();
    await expect(modal).toContainText('recibo-hacienda.pdf');
    await expect(radio(modal, 'Pago')).not.toBeChecked();
    await expect(radio(modal, 'Liquidación')).toBeFocused();

    estado.respuesta = { status: 200, body: { resultado: 'duplicado', detalle: '' } };
    await radio(modal, 'Liquidación').check();
    await modal.getByRole('button', { name: 'Cargar', exact: true }).click();
    await modal.getByRole('button', { name: 'Elegir otro archivo' }).click();
    await expect(radio(modal, 'Liquidación')).toBeChecked();
    await expect(modal).not.toContainText('recibo-hacienda.pdf');
  });

  test('AC3 · cargando bloquea el cierre; errores con copy propio y «Reintentar» conserva fase y archivo', async ({ page }) => {
    await iniciar(page);
    const { modal } = await abrirCarga(page, 'SOL001');

    estado.soltar = false;
    estado.respuesta = { status: 503, body: { error: 'OCR_UPSTREAM_TIMEOUT stack', codigo: 'otra_cosa' } };
    await cargarCon(modal, 'Liquidación');
    await expect(modal.getByRole('button', { name: 'Leyendo el comprobante…' })).toBeDisabled();
    await expect(radio(modal, 'Liquidación')).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(modal).toBeVisible();
    estado.soltar = true;

    const alerta = modal.getByRole('alert');
    await expect(alerta).toHaveText('El lector de comprobantes no respondió. No se guardó nada; reintenta en unos minutos.');
    await expect(modal).not.toContainText('OCR_UPSTREAM_TIMEOUT');
    await modal.getByRole('button', { name: 'Reintentar' }).click();
    await expect(radio(modal, 'Liquidación')).toBeChecked();
    await expect(modal).toContainText('recibo-hacienda.pdf');

    const errores: { r: Respuesta; texto: string; boton: string }[] = [
      { r: { status: 429, body: { error: 'x' } }, texto: 'Hiciste muchas cargas seguidas. Espera unos minutos y reintenta.', boton: 'Reintentar' },
      { r: { status: 0, abortar: true }, texto: 'No se pudo completar la carga. Revisa tu conexión y reintenta.', boton: 'Reintentar' },
      { r: { status: 400, body: { codigo: 'fase_invalida' } }, texto: 'Falta la fase del comprobante. Elígela y vuelve a cargar.', boton: 'Elegir fase' },
    ];
    for (const e of errores) {
      estado.respuesta = e.r;
      if (!(await radio(modal, 'Liquidación').isChecked())) await radio(modal, 'Liquidación').check();
      await modal.getByRole('button', { name: 'Cargar', exact: true }).click();
      await expect(modal.getByRole('alert')).toHaveText(e.texto);
      await modal.getByRole('button', { name: e.boton }).click();
    }
    // «Elegir fase» conservó el archivo y limpió la fase.
    await expect(modal).toContainText('recibo-hacienda.pdf');
    await expect(radio(modal, 'Liquidación')).not.toBeChecked();

    // Archivo inválido (local): copy fijo y «Elegir otro» conserva la fase.
    await radio(modal, 'Pago').check();
    await elegirArchivo(modal, { name: 'notas.txt', mimeType: 'text/plain', buffer: Buffer.from('hola') });
    await expect(modal.getByRole('alert')).toHaveText('El archivo debe ser PDF, JPG o PNG de máximo 15 MB. Elige otro archivo.');
    await modal.getByRole('button', { name: 'Elegir otro' }).click();
    await expect(radio(modal, 'Pago')).toBeChecked();

    // 409 y 403: «Cerrar»; el 409 refresca la cola.
    estado.respuesta = { status: 409, body: { codigo: 'estado_no_permitido' } };
    await elegirArchivo(modal);
    const antes = estado.listados;
    await modal.getByRole('button', { name: 'Cargar', exact: true }).click();
    await expect(modal.getByRole('alert')).toHaveText('El impuesto ya no está en gestión ni pagado. Cierra y revisa su estado.');
    await modal.getByRole('button', { name: 'Cerrar', exact: true }).last().click();
    await expect(modal).toHaveCount(0);
    await expect.poll(() => estado.listados).toBeGreaterThan(antes);
  });

  test('AC4 + AC5 · «Listo» refresca estado y soportes sin recargar; el foco vuelve al botón o a «Ver soporte»', async ({ page }) => {
    await iniciar(page);
    // Liquidación sobre un impuesto sin documentos: el botón sigue (falta el pago) y recibe el foco.
    let { detalle, modal } = await abrirCarga(page, 'SOL001');
    estado.respuesta = { status: 200, body: { resultado: 'liquidado', soporteId: 'x', valorLiquidado: '150000' } };
    estado.trasEscritura = (f) => ({ ...f, documentos: 'liquidacion', liquidadoEn: '2026-09-30T12:00:00Z', valorLiquidado: 150000 });
    await cargarCon(modal, 'Liquidación');
    const navegaciones: string[] = [];
    page.on('framenavigated', (f) => navegaciones.push(f.url()));
    await modal.getByRole('button', { name: 'Listo' }).click();
    await expect(modal).toHaveCount(0);
    await expect(detalle).toBeVisible();
    await expect(detalle.getByText('Liquidación', { exact: true })).toBeVisible();
    await expect(detalle.getByRole('button', { name: 'Cargar comprobante' })).toBeFocused();
    const soportesAntes = estado.soportes;
    await detalle.getByRole('button', { name: 'Ver soporte' }).click();
    await expect.poll(() => estado.soportes).toBeGreaterThan(soportesAntes);
    await page.keyboard.press('Escape');

    // Pago que completa las dos fases: el detalle pasa a Pagado, los dos botones de carga se van
    // y el foco cae en «Ver soporte».
    modal = page.getByRole('dialog', { name: 'Cargar comprobante · SOL001' });
    await detalle.getByRole('button', { name: 'Cargar comprobante' }).click();
    estado.respuesta = { status: 200, body: { resultado: 'pagado', soporteId: 'y', valorPagado: '150000', marcadoPorDiferencia: false } };
    estado.trasEscritura = (f) => ({ ...f, estado: 'pagado', documentos: 'ambos', valorPagado: 150000, pagadoEn: '2026-09-30T12:00:00Z' });
    await cargarCon(modal, 'Pago');
    await modal.getByRole('button', { name: 'Listo' }).click();
    await expect(detalle.getByText('Pagado', { exact: true }).first()).toBeVisible();
    await expect(detalle.getByText('Ambos', { exact: true })).toBeVisible();
    await expect(detalle.getByRole('button', { name: 'Cargar comprobante' })).toHaveCount(0);
    await expect(detalle.getByRole('button', { name: 'Cargar recibo de caja' })).toHaveCount(0);
    await expect(detalle.getByRole('button', { name: 'Ver soporte' })).toBeFocused();
    expect(navegaciones).toEqual([]);

    // Un resultado sin escritura no refresca nada al cerrar.
    await page.keyboard.press('Escape');
    await expect(detalle).toHaveCount(0);
    ({ detalle, modal } = await abrirCarga(page, 'LIQ001'));
    estado.trasEscritura = null;
    estado.respuesta = { status: 200, body: { resultado: 'duplicado', detalle: '' } };
    await cargarCon(modal, 'Pago');
    const antes = estado.listados;
    await modal.getByRole('button', { name: 'Cerrar', exact: true }).last().click();
    await expect(detalle.getByRole('button', { name: 'Cargar comprobante' })).toBeFocused();
    await page.waitForTimeout(300);
    expect(estado.listados).toBe(antes);
  });

  test('AC6 · a 360 px el detalle y el modal no desbordan en horizontal', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await iniciar(page);
    await expect(page.getByRole('row').filter({ hasText: 'SOL001' })).toBeVisible();
    // La cola de fondo ya trae su propio scroll a 360 px (preexistente): se mide que el detalle y el
    // modal no lo AUMENTEN, y que ninguno de los dos desborde por dentro.
    const anchoDe = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const base = await anchoDe();
    const { detalle, modal } = await abrirCarga(page, 'SOL001');
    await radio(modal, 'Pago').check();
    await elegirArchivo(modal, { ...PDF, name: `comprobante-${'muy-largo-'.repeat(12)}.pdf` });
    for (const caja of [detalle, modal]) {
      const desborde = await caja.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(desborde).toBeLessThanOrEqual(0);
    }
    expect(await anchoDe()).toBeLessThanOrEqual(base);
    const caja = await modal.getByRole('button', { name: 'Cargar', exact: true }).boundingBox();
    expect(caja && caja.x + caja.width).toBeLessThanOrEqual(360);
  });
});
