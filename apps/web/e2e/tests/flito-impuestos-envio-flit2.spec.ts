import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { funcionesDe, loginAs, OPERACIONES_USER } from '../helpers/auth';
import { correrAxe, esperarSinViolacionesGraves } from '../helpers/axe';

// FLITO — Impuestos · HU #13270: indicador «Comprobante en FLIT 2» (solo lectura) y «Reemplazar
// comprobante» desde el detalle del impuesto. Spec UX: docs/ux/flito-impuestos-envio-flit2-y-reemplazo.md.
// Backend mockeado (`GET /api/flito/impuestos/:id` con `envioFlit2` y `soportes`;
// `POST …/recibos/reemplazar-pago`, HU #13269), mismo patrón que `flito-impuestos-carga-comprobante`.
//
// `impuestos.recibos.reemplazar` (0220) NO la trae ningún rol, ni admin: por eso no va a
// `FUNCIONES_POR_ROL` (que replica lo que siembra el servidor) y el spec la añade por usuario.

const BASE = {
  tramiteId: 't', vin: 'VIN0000000000000', marca: 'Renault', linea: 'Duster', tipoTramite: 'Traspaso',
  fechaAprobacion: null, fechaCreacion: '2026-09-01T12:00:00Z',
  compradorNombre: 'Ana Pérez', compradorDocumento: '10101010', compradorTipoDocumento: 'CC',
  companiaNombre: 'Concesionario Norte', organismoCodigo: 'STT-MZL', organismoNombre: 'STT Manizales',
  valorLiquidado: 120000, valorPagado: 120000, marcadoPorDiferencia: false, tieneFacturaVenta: true,
  enviadoPorNombre: 'Operaciones E2E', enviadoEn: '2026-09-02T12:00:00Z', pagadoEn: '2026-09-04T12:00:00Z', estancado: false,
  motivoRechazo: null, creadoEn: '2026-09-01T12:00:00Z', gestionOperaciones: false,
  certificacion: null, liquidadoEn: '2026-09-03T12:00:00Z', documentos: 'ambos', analisisEstado: 'completado',
  semaforo: 'verde', motivoSemaforo: null, estado: 'pagado',
};

type Envio = { estado: string; intentos: number; ultimoIntentoEn: string | null } | null;
type Fila = Record<string, unknown> & { id: string; placa: string };
type Soporte = { id: string; tipo: string; nombreArchivo: string; subidoEn: string };

const PAGO: Soporte = { id: 'sp', tipo: 'recibo_impuesto', nombreArchivo: 'pago.pdf', subidoEn: '2026-09-04T12:00:00Z' };
const CAJA: Soporte = { id: 'sc', tipo: 'recibo_caja_impuesto', nombreArchivo: 'caja.pdf', subidoEn: '2026-09-04T12:00:00Z' };
const LIQ: Soporte = { id: 'sl', tipo: 'recibo_impuesto_sin_marca_agua', nombreArchivo: 'liq.pdf', subidoEn: '2026-09-03T12:00:00Z' };
const INTENTO = '2026-10-05T15:32:00Z';

const fila = (id: string, placa: string, extra: Partial<Fila> = {}): Fila => ({ ...BASE, id, idFlit: `FLIT-${id}`, placa, ...extra });

/** Por impuesto: lo que el detalle añade a la fila (envío y soportes). */
const iniciales = (): Record<string, { envio: Envio; soportes: Soporte[] }> => ({
  pe: { envio: { estado: 'pendiente', intentos: 0, ultimoIntentoEn: null }, soportes: [LIQ, PAGO] },
  ee: { envio: { estado: 'en_espera', intentos: 0, ultimoIntentoEn: INTENTO }, soportes: [LIQ, PAGO] },
  en: { envio: { estado: 'enviado', intentos: 1, ultimoIntentoEn: INTENTO }, soportes: [LIQ, PAGO] },
  yg: { envio: { estado: 'ya_cargado_gestor', intentos: 1, ultimoIntentoEn: INTENTO }, soportes: [LIQ, PAGO] },
  er: { envio: { estado: 'error', intentos: 3, ultimoIntentoEn: INTENTO }, soportes: [LIQ, PAGO] },
  sc: { envio: { estado: 'sin_comprobante', intentos: 0, ultimoIntentoEn: null }, soportes: [LIQ] },
  nf: { envio: null, soportes: [LIQ, PAGO] },
  cj: { envio: null, soportes: [LIQ, CAJA] },
  so: { envio: null, soportes: [LIQ] },
});

const filasIniciales = (): Fila[] => [
  fila('pe', 'PEN001'), fila('ee', 'ESP001'), fila('en', 'ENV001'), fila('yg', 'GES001'), fila('er', 'ERR001'),
  fila('sc', 'SIN001', { documentos: 'liquidacion' }),
  fila('nf', 'NOF001'),
  // Pago solo por recibo de caja: `documentos` dice «ambos», pero no hay `recibo_impuesto` que reemplazar.
  fila('cj', 'CAJ001'),
  fila('so', 'SOL001', { estado: 'solicitado', documentos: 'liquidacion', valorPagado: null, pagadoEn: null }),
];

type Respuesta = { status: number; body?: unknown; abortar?: boolean };
const estado = {
  filas: filasIniciales(),
  extra: iniciales(),
  respuesta: { status: 200, body: {} } as Respuesta,
  /** Envío que el detalle devuelve tras un reemplazo con escritura. */
  envioTrasReemplazo: null as Envio | undefined | null,
  /** Mientras sea true el detalle responde 500 (el cliente puede reintentar solo un GET). */
  detalleRoto: false,
  detalles: 0,
  listados: 0,
  posts: 0,
};

async function mock(page: Page) {
  estado.filas = filasIniciales(); estado.extra = iniciales();
  estado.respuesta = { status: 200, body: {} };
  estado.envioTrasReemplazo = undefined;
  estado.detalleRoto = false; estado.detalles = 0; estado.listados = 0; estado.posts = 0;
  await page.route(/\/api\/flito\/impuestos\/facetas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ companias: [], organismos: [] }) }));
  await page.route(/\/api\/flito\/impuestos\?/, (route) => {
    estado.listados += 1;
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: estado.filas, total: estado.filas.length, page: 1, pageSize: 50 }),
    });
  });
  await page.route(/\/api\/flito\/impuestos\/[a-z0-9]+\/soportes$/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route(/\/api\/flito\/impuestos\/[a-z0-9]+\/recibos\/reemplazar-pago$/, (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-3)!;
    estado.posts += 1;
    const r = estado.respuesta;
    if (r.abortar) return route.abort('failed');
    if (r.status === 200 && (r.body as { resultado?: string }).resultado === 'reemplazado' && estado.envioTrasReemplazo !== undefined) {
      estado.extra[id] = { ...estado.extra[id], envio: estado.envioTrasReemplazo };
    }
    return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body ?? {}) });
  });
  await page.route(/\/api\/flito\/impuestos\/[a-z0-9]+$/, (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop()!;
    const f = estado.filas.find((x) => x.id === id);
    if (!f) return route.fallback();
    estado.detalles += 1;
    if (estado.detalleRoto) {
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom interno' }) });
    }
    const x = estado.extra[id];
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        ...f, direccionComprador: null, soportes: x.soportes, envioFlit2: x.envio,
        comparacion: { version: 1, motivo: null, campos: [], resumen: { coinciden: 0, difieren: 0, noVerificables: 0 }, calculadoEn: '2026-09-02T12:05:00Z' },
      }),
    });
  });
}

const CON_REEMPLAZO = { ...OPERACIONES_USER, funciones: [...funcionesDe(OPERACIONES_USER), 'impuestos.recibos.reemplazar'] };

const iniciar = async (page: Page, user = CON_REEMPLAZO) => {
  await loginAs(page, user);
  await mock(page);
  await page.goto('/flito/impuestos');
};

const abrirDetalle = async (page: Page, placa: string) => {
  await page.getByRole('row').filter({ hasText: placa }).getByRole('button', { name: 'Ver', exact: true }).click();
  const detalle = page.getByRole('dialog', { name: `Impuesto · ${placa}` });
  await expect(detalle).toBeVisible();
  // El detalle ya llegó cuando la validación deja de cargar (misma petición).
  await expect(detalle.getByText('Ver soporte')).toBeVisible();
  return detalle;
};

const celda = (detalle: Locator) => detalle.getByTestId('envio-flit2');
const PDF = { name: 'nuevo-recibo.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF') };

const abrirReemplazo = async (page: Page, placa: string) => {
  const detalle = await abrirDetalle(page, placa);
  await detalle.getByRole('button', { name: 'Reemplazar comprobante' }).click();
  const modal = page.getByRole('dialog', { name: `Reemplazar comprobante de pago · ${placa}` });
  await expect(modal).toBeVisible();
  return { detalle, modal };
};
const reemplazarCon = async (modal: Locator) => {
  await modal.locator('input[type="file"]').setInputFiles(PDF);
  await modal.getByRole('button', { name: 'Reemplazar comprobante' }).click();
};

test.describe('FLITO — Impuestos · envío del comprobante a FLIT 2 y reemplazo (HU #13270)', () => {
  test('AC1 · los seis estados del indicador con chip, fecha y ayuda; sin botón de reintentar envío', async ({ page }) => {
    await iniciar(page);
    const casos: Array<{ placa: string; chip: string; fecha: RegExp | null; ayuda: string | null }> = [
      { placa: 'PEN001', chip: 'Pendiente', fecha: null, ayuda: null },
      { placa: 'ESP001', chip: 'En espera de FLIT 2', fecha: /^Último intento: /, ayuda: 'El trámite aún no admite el comprobante en FLIT 2. FLITO lo enviará solo.' },
      { placa: 'ENV001', chip: 'Enviado a FLIT 2', fecha: /^Enviado el /, ayuda: null },
      { placa: 'GES001', chip: 'Ya lo cargó el gestor', fecha: /^Último intento: /, ayuda: null },
      { placa: 'ERR001', chip: 'Error de envío', fecha: /^Último intento: /, ayuda: 'FLITO no pudo enviarlo tras 3 intentos. El motivo quedó registrado; si el archivo estaba mal, reemplázalo.' },
      { placa: 'SIN001', chip: 'Sin comprobante', fecha: null, ayuda: 'Se enviará cuando cargues el comprobante de pago con «Cargar comprobante».' },
    ];
    for (const c of casos) {
      const detalle = await abrirDetalle(page, c.placa);
      const cel = celda(detalle);
      await expect(cel.locator('dt')).toHaveText('Comprobante en FLIT 2');
      await expect(cel.locator('dd')).toContainText(c.chip);
      const lineas = await cel.locator('dd p').allInnerTexts();
      const conFecha = lineas.filter((l) => /^(Último intento|Enviado el)/.test(l));
      if (c.fecha) { expect(conFecha).toHaveLength(1); expect(conFecha[0]).toMatch(c.fecha); } else expect(conFecha).toHaveLength(0);
      if (c.ayuda) expect(lineas).toContain(c.ayuda); else expect(lineas.length).toBe(conFecha.length);
      // Solo lectura: nada interactivo en la celda (AC2), ni el número de intentos fuera de `error`.
      await expect(cel.getByRole('button')).toHaveCount(0);
      await expect(cel.getByRole('link')).toHaveCount(0);
      // Va justo después de Soporte.
      const rotulos = await detalle.locator('dl > div > dt').allInnerTexts();
      const i = rotulos.findIndex((r) => /soporte/i.test(r));
      expect(rotulos[i + 1]).toMatch(/comprobante en flit 2/i);
      await page.keyboard.press('Escape');
    }
  });

  test('AC2 · con envioFlit2 null la celda no existe y no hay reintentar en ningún lado', async ({ page }) => {
    await iniciar(page);
    const detalle = await abrirDetalle(page, 'NOF001');
    await expect(celda(detalle)).toHaveCount(0);
    await expect(detalle.getByText('Comprobante en FLIT 2')).toHaveCount(0);
    await expect(detalle.getByRole('button', { name: /reintentar env/i })).toHaveCount(0);
  });

  test('AC3 · «Reemplazar comprobante» solo con la función, Pagado y comprobante de pago vigente', async ({ page }) => {
    await iniciar(page);
    let detalle = await abrirDetalle(page, 'ENV001');
    const textos = await detalle.locator('dd').filter({ hasText: 'Ver soporte' }).getByRole('button').allInnerTexts();
    expect(textos.map((t) => t.trim())).toEqual(['Ver soporte', 'Reemplazar comprobante']);
    // Secundario: el detalle sigue sin primaria.
    await expect(detalle.getByRole('button', { name: 'Reemplazar comprobante' })).not.toHaveCSS('background-image', /gradient/);
    await page.keyboard.press('Escape');
    // Pagado con recibo de caja y sin recibo_impuesto (documentos «ambos» miente), sin pago, en gestión: no está.
    for (const placa of ['CAJ001', 'SIN001', 'SOL001']) {
      detalle = await abrirDetalle(page, placa);
      await expect(detalle.getByRole('button', { name: 'Reemplazar comprobante' })).toHaveCount(0);
      await page.keyboard.press('Escape');
    }
  });

  test('AC3 · sin la función el botón no está en el DOM', async ({ page }) => {
    await iniciar(page, OPERACIONES_USER);
    const detalle = await abrirDetalle(page, 'ENV001');
    await expect(celda(detalle)).toBeVisible();
    await expect(detalle.getByRole('button', { name: 'Reemplazar comprobante' })).toHaveCount(0);
  });

  test('AC4 · éxito: toast cerrable, el detalle sigue abierto y se recarga con el nuevo estado del envío', async ({ page }) => {
    await iniciar(page);
    const { detalle, modal } = await abrirReemplazo(page, 'ERR001');
    // Aviso de descarte antes del archivo; primaria deshabilitada sin archivo.
    await expect(modal.getByText('El comprobante de pago actual se descarta y queda el nuevo.', { exact: false })).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Reemplazar comprobante' })).toBeDisabled();
    await expect(modal.getByText('Elige el archivo del nuevo comprobante.')).toBeVisible();
    await expect(modal.getByLabel(/Nuevo comprobante de pago/)).toBeAttached();

    estado.respuesta = { status: 200, body: { resultado: 'reemplazado', soporteId: 'nuevo', soportesDescartados: ['sp'], envioFlit2: { reenviado: true } } };
    estado.envioTrasReemplazo = { estado: 'pendiente', intentos: 0, ultimoIntentoEn: null };
    const antes = { detalles: estado.detalles, listados: estado.listados };
    await reemplazarCon(modal);

    await expect(modal).toHaveCount(0);
    const toast = page.getByRole('status').filter({ hasText: 'Comprobante reemplazado. FLITO enviará el nuevo a FLIT 2.' });
    await expect(toast).toBeVisible();
    await expect(detalle).toBeVisible();
    await expect(celda(detalle).locator('dd')).toContainText('Pendiente');
    expect(estado.detalles).toBeGreaterThan(antes.detalles);
    await expect.poll(() => estado.listados).toBeGreaterThan(antes.listados);
    expect(estado.posts).toBe(1);
    // Cerrable.
    await toast.getByRole('button').first().click();
    await expect(toast).toHaveCount(0);
  });

  test('AC4 · variantes del toast según envioFlit2 (sin reenvío)', async ({ page }) => {
    await iniciar(page);
    const variantes: Array<[string, string]> = [
      ['ya_cargado_gestor', 'Comprobante reemplazado en FLITO. No se envía a FLIT 2: el gestor ya cargó el suyo allá.'],
      ['no_flit2', 'Comprobante reemplazado. Este trámite no es de FLIT 2, así que no hay nada que enviar.'],
      ['sin_envio_previo', 'Comprobante reemplazado en FLITO. No se envía a FLIT 2 porque el impuesto se pagó antes del envío automático.'],
    ];
    for (const [motivo, copy] of variantes) {
      const { modal } = await abrirReemplazo(page, 'NOF001');
      estado.respuesta = { status: 200, body: { resultado: 'reemplazado', soporteId: 'n', soportesDescartados: ['sp'], envioFlit2: { reenviado: false, motivo } } };
      await reemplazarCon(modal);
      await expect(page.getByRole('status').filter({ hasText: copy })).toBeVisible();
      await page.keyboard.press('Escape');
    }
  });

  test('AC5 · rechazo por placa: copy de negocio, sin el detalle crudo, el anterior sigue vigente', async ({ page }) => {
    await iniciar(page);
    const { detalle, modal } = await abrirReemplazo(page, 'ENV001');
    estado.respuesta = { status: 200, body: { resultado: 'placa_no_coincide', detalle: '' } };
    await reemplazarCon(modal);
    await expect(modal.getByRole('status')).toContainText('No se reemplazó');
    await expect(modal.getByRole('status')).toContainText('El comprobante es de otro vehículo');
    await expect(modal.getByRole('status')).toContainText('El comprobante anterior sigue vigente.');
    await expect(modal.getByRole('button', { name: 'Elegir otro archivo' })).toBeFocused();
    await modal.getByText('Cerrar', { exact: true }).click();
    // No hubo escritura: el indicador sigue igual.
    await expect(celda(detalle).locator('dd')).toContainText('Enviado a FLIT 2');
  });

  test('AC5 · errores 409/403/red con copy de negocio, nunca el mensaje crudo del API', async ({ page }) => {
    await iniciar(page);
    const casos: Array<[Respuesta, string, string]> = [
      [{ status: 409, body: { error: 'RAW sin vigente', codigo: 'sin_comprobante_vigente' } },
        'Este impuesto no tiene un comprobante de pago que reemplazar. Cárgalo con «Cargar comprobante».', 'Cerrar'],
      [{ status: 403, body: { error: 'RAW forbidden' } },
        'Tu usuario no tiene la función para reemplazar comprobantes. Pídela al administrador.', 'Cerrar'],
      [{ status: 400, body: { error: 'RAW multer', codigo: 'archivo_invalido' } },
        'El archivo debe ser PDF, JPG o PNG de máximo 15 MB. Elige otro archivo.', 'Elegir otro'],
      [{ status: 0, abortar: true }, 'No se pudo completar el reemplazo. Revisa tu conexión y reintenta.', 'Reintentar'],
    ];
    for (const [r, copy, boton] of casos) {
      const { modal } = await abrirReemplazo(page, 'ENV001');
      estado.respuesta = r;
      await reemplazarCon(modal);
      await expect(modal.getByRole('alert')).toHaveText(copy);
      await expect(modal.getByText('El comprobante anterior sigue vigente.')).toBeVisible();
      await expect(modal.getByText(/RAW/)).toHaveCount(0);
      // La primaria del desenlace recibe el foco (la X del modal también se llama «Cerrar»).
      await expect(page.locator(':focus')).toHaveText(boton);
      if (boton === 'Reintentar') {
        await modal.getByRole('button', { name: 'Reintentar' }).click();
        // Conserva el archivo.
        await expect(modal.getByText('nuevo-recibo.pdf', { exact: false })).toBeVisible();
        await modal.getByRole('button', { name: 'Cancelar' }).click();
      } else if (boton === 'Elegir otro') {
        await modal.getByRole('button', { name: 'Elegir otro' }).click();
        await modal.getByRole('button', { name: 'Cancelar' }).click();
      } else {
        await page.locator(':focus').click();
      }
      await expect(modal).toHaveCount(0);
      await page.keyboard.press('Escape');
    }
  });

  test('AC6 · error al cargar el detalle: la celda ofrece «Reintentar» y se recupera', async ({ page }) => {
    await iniciar(page);
    estado.detalleRoto = true;
    await page.getByRole('row').filter({ hasText: 'ERR001' }).getByRole('button', { name: 'Ver', exact: true }).click();
    const detalle = page.getByRole('dialog', { name: 'Impuesto · ERR001' });
    const cel = celda(detalle);
    await expect(cel).toContainText('No se pudo consultar el envío a FLIT 2.');
    await expect(cel).not.toContainText('boom');
    estado.detalleRoto = false;
    await cel.getByRole('button', { name: 'Reintentar' }).click();
    await expect(cel.locator('dd')).toContainText('Error de envío');
  });

  test('a11y · axe sin violaciones graves en el detalle y el diálogo (requiere QA_AXE_CDN/QA_AXE_PATH)', async ({ page }) => {
    test.skip(!process.env.QA_AXE_CDN && !process.env.QA_AXE_PATH, 'axe no está instalado: correr con QA_AXE_CDN=1');
    await iniciar(page);
    const { modal } = await abrirReemplazo(page, 'ERR001');
    await expect(modal).toBeVisible();
    esperarSinViolacionesGraves(await correrAxe(page), 'reemplazo de comprobante');
  });
});
