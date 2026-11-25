import { test, expect } from '../helpers/fixtures';
import type { Page, Route } from '@playwright/test';
import { loginAs, FINANCIERA_USER } from '../helpers/auth';

// HU #13892 — Bolsas: sección «Documentos» (expediente documental) en el detalle de la bolsa de compañía
// (Feature #13888). Spec UX: docs/ux/flito-bolsas-expediente-documental.md. Contrato: ADR-0028 §5.
// Backend mockeado: catálogo de bolsas (HU #13900) + `/api/flito/bolsas-documentos` (#13889/#13890).

const BOLSA = [
  'bolsas.bolsa.ver', 'bolsas.bolsa.listar', 'bolsas.bolsa.crear', 'bolsas.bolsa.editar',
  'bolsas.bolsa.inactivar', 'bolsas.movimientos.ver', 'bolsas.cierres.ver',
];
const VER = 'bolsas.documentos.ver';
const CARGAR = 'bolsas.documentos.cargar';
const CON_CARGA = [...BOLSA, VER, CARGAR];
const SOLO_VER = [...BOLSA, VER];

const resumen = (o: Record<string, unknown>) => ({
  alcance: 'compania', companiaNombre: o.nombre, conceptos: ['soat'], cobertura: [],
  ultimaEntradaValor: 5000000, ultimaEntradaEn: '2026-10-02T10:00:00.000Z', porcentaje: 62, ...o,
});
const detalle = (r: Record<string, unknown>) => ({
  ...r, inactivadaEn: null, inactivadaPorNombre: null, motivoInactivacion: null, conceptosAutogestionados: [],
});
const ANDINOS = resumen({ id: 'b-1', nombre: 'TRANSPORTES ANDINOS', companiaId: 1, activa: true, saldo: 4250000, nivel: 'normal' });
const RENTACAR = resumen({ id: 'b-3', nombre: 'RENTACAR NORTE', companiaId: 3, activa: false, saldo: -85000, nivel: 'agotada' });

type Tipo = 'camara_comercio' | 'rut' | 'cedula_representante' | 'certificado_bancario' | 'adicional';
const TIPOS: Tipo[] = ['camara_comercio', 'rut', 'cedula_representante', 'certificado_bancario', 'adicional'];

function version(tipo: Tipo, o: Record<string, unknown> = {}) {
  return {
    id: `00000000-0000-4000-8000-00000000000${TIPOS.indexOf(tipo) + 1}`, tipo, version: 1, estado: 'valido',
    fechaExpedicion: null, fechaOrigen: null, venceEl: null, fechaManual: null,
    mime: 'application/pdf', tamanoBytes: 1000, cargadoPor: 'Ana Pérez', cargadoEn: '2026-10-12T19:32:00.000Z', ...o,
  };
}

/** Expediente con los estados dados por tipo; los que no se den quedan en `pendiente`. */
function expediente(
  companiaId: number, estados: Partial<Record<Tipo, Record<string, unknown>>> = {}, conHistorial: Tipo[] = [],
) {
  const documentos = TIPOS.map((tipo) => {
    const v = estados[tipo];
    return {
      tipo, opcional: tipo === 'adicional',
      estado: v ? (v.estado as string) ?? 'valido' : 'pendiente',
      vigente: v ? version(tipo, v) : null,
      // HU #13964: «Historial» depende de esto, no de `vigente`. Con vigente siempre hay historial.
      tieneHistorial: v ? true : conHistorial.includes(tipo),
    };
  });
  const completo = documentos.filter((d) => d.tipo !== 'adicional').every((d) => d.estado === 'valido');
  return { companiaId, completo, documentos };
}

const LLENO = expediente(1, {
  camara_comercio: { estado: 'valido', fechaExpedicion: '2026-10-10', venceEl: '2026-11-09', fechaOrigen: 'ocr' },
  rut: { estado: 'vencido', fechaExpedicion: '2026-09-02', venceEl: '2026-10-02', fechaOrigen: 'ocr', version: 3 },
  cedula_representante: { estado: 'valido' },
  certificado_bancario: { estado: 'no_validado' },
});

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

interface Opts {
  /**
   * Respuesta de E1: fija, o una función que el test cambia (en dev, StrictMode monta dos veces y una
   * secuencia por número de petición sería frágil). Un número = status de error.
   */
  e1?: unknown | (() => unknown);
  e1Retraso?: number;
}

/** Mock del catálogo de bolsas y de E1. Devuelve el contador de peticiones a E1. */
async function mock(page: Page, o: Opts = {}) {
  const peticiones = { e1: 0, detalle: 0 };
  await page.route(/\/api\/flito\/bolsas\/consolidado/, (r) => json(r, { clientes: 2, saldoTotal: 4165000 }));
  await page.route(/\/api\/flito\/bolsas\/alertas/, (r) => json(r, {
    saldo: [], conciliacion: { soportesSinTramite: 0, movimientosSinSoporte: 0, boletasSinComprobante: 0 },
  }));
  await page.route(/\/api\/flito\/bolsas\/transito$/, (r) => json(r, []));
  await page.route(/\/api\/flito\/bolsas\/buscar/, (r) => json(r, [ANDINOS, RENTACAR]));
  await page.route(/\/api\/flito\/bolsas\/bolsa\/([^/]+)$/, (r) => {
    peticiones.detalle += 1;
    const id = r.request().url().split('/').pop();
    return json(r, detalle(id === 'b-3' ? RENTACAR : ANDINOS));
  });
  await page.route(/\/api\/flito\/bolsas\/\d+\/extracto/, (r) => json(r, {
    companiaId: 1, saldoActual: 4250000, totalEntradas: 0, totalSalidas: 0, porOrganismo: [], porConcepto: [],
  }));
  await page.route(/\/api\/flito\/bolsas\/\d+\/movimientos/, (r) => json(r, []));
  await page.route(/\/api\/flito\/bolsas\/\d+\/cierres/, (r) => json(r, []));
  await page.route(/\/api\/clients/, (r) => json(r, [{ id: 1, name: 'TRANSPORTES ANDINOS' }]));
  await page.route(/\/api\/flito\/bolsas-documentos\/companias\/(\d+)$/, async (r) => {
    const actual = typeof o.e1 === 'function' ? (o.e1 as () => unknown)() : (o.e1 ?? expediente(1));
    peticiones.e1 += 1;
    if (o.e1Retraso) await new Promise((res) => setTimeout(res, o.e1Retraso));
    return typeof actual === 'number' ? json(r, { error: 'falla' }, actual) : json(r, actual);
  });
  return peticiones;
}

async function abrir(page: Page, nombre = 'TRANSPORTES ANDINOS') {
  await page.goto('/flito/bolsas');
  await page.getByRole('region', { name: 'Bolsas de compañías' }).getByText(nombre).waitFor();
  await page.getByRole('button', { name: `Ver el detalle de la bolsa de ${nombre} (compañía)` }).first().click();
  const modal = page.getByRole('dialog', { name: nombre });
  await expect(modal).toBeVisible();
  return modal;
}

const seccion = (modal: ReturnType<Page['getByRole']>) => modal.getByRole('region', { name: 'Documentos', exact: true });

/** `scrollTop` del primer ancestro desplazable de la fila (el cuerpo del detalle o el overlay). */
const scrollDelModal = (fila: ReturnType<Page['getByTestId']>) => fila.evaluate((el) => {
  for (let n = el.parentElement; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n.scrollTop;
  }
  return -1;
});

/** Lleva la fila al centro de su contenedor desplazable, para que un salto al inicio se note. */
const centrar = (fila: ReturnType<Page['getByTestId']>) => fila.evaluate((el) => el.scrollIntoView({ block: 'center' }));

test.describe('FLITO — Bolsas · expediente documental de la compañía (HU #13892)', () => {
  test('AC1 + AC3 vacío: la sección lista los 5 documentos en Pendiente con su siguiente paso', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: CON_CARGA });
    await mock(page);
    const modal = await abrir(page);
    const s = seccion(modal);
    await expect(s.getByRole('heading', { name: 'Documentos', exact: true })).toBeVisible();
    await expect(s.getByRole('listitem')).toHaveCount(5);
    for (const nombre of ['Cámara de Comercio', 'RUT', 'Cédula del representante legal', 'Certificado bancario', 'Documento adicional (opcional)']) {
      await expect(s.getByRole('heading', { name: nombre, exact: true })).toBeVisible();
    }
    await expect(s.getByText('Pendiente', { exact: true })).toHaveCount(5);
    await expect(s.getByText('Docs pendientes')).toBeVisible();
    await expect(s.getByText('0 de 4 principales válidos')).toBeVisible();
    await expect(s.getByText('Todavía no hay documentos. Carga los cuatro principales para dejar el expediente completo.')).toBeVisible();
    await expect(s.getByLabel('Cargar RUT')).toBeAttached();
    // Sin vigente no hay descarga ni historial.
    await expect(s.getByRole('button', { name: /Descargar|Ver el historial/ })).toHaveCount(0);
  });

  test('AC1: el detalle de una bolsa de tránsito no tiene la sección ni pide E1', async ({ page }) => {
    // HU #13908: la bolsa de tránsito vive en el catálogo único (`/buscar` y `/bolsa/:id/*`).
    await loginAs(page, FINANCIERA_USER, { funciones: [
      ...CON_CARGA, 'bolsas.transito.listar', 'bolsas.transito.ver', 'bolsas.transito.ver_movimientos', 'bolsas.transito.cierres.ver',
    ] });
    const peticiones = await mock(page);
    const transito = {
      id: 'ob-1', alcance: 'transito', nombre: 'Bolsa de mi sector', companiaId: null, companiaNombre: null, activa: true,
      conceptos: ['impuesto'], cobertura: [{ organismoCodigo: '05001', concepto: 'impuesto' }], saldo: 0,
      ultimaEntradaValor: null, ultimaEntradaEn: null, nivel: 'sin_recargas', porcentaje: null,
      transito: { nivel: 'sin_cargas', deuda: 0, totalCargado: 0, totalConsumido: 0 },
    };
    await page.route(/\/api\/flito\/bolsas\/buscar/, (r) => json(r, [ANDINOS, RENTACAR, transito]));
    await page.route(/\/api\/flito\/bolsas\/bolsa\/ob-1$/, (r) => json(r, {
      ...transito, inactivadaEn: null, inactivadaPorNombre: null, motivoInactivacion: null,
      conceptosAutogestionados: [], paresAutogestionados: [],
    }));
    await page.route(/\/api\/flito\/bolsas\/bolsa\/ob-1\/(movimientos|cierres)$/, (r) => json(r, []));
    await page.goto('/flito/bolsas');
    await page.getByRole('button', { name: 'Ver el detalle de la bolsa Bolsa de mi sector (tránsito)' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByTestId('expediente-documental')).toHaveCount(0);
    expect(peticiones.e1).toBe(0);
  });

  test('AC2: al crear la bolsa, el detalle que se abre trae el expediente listo y el alta no tiene documentos', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: CON_CARGA });
    await mock(page, { e1: expediente(2) });
    const nueva = detalle(resumen({ id: 'b-2', nombre: 'LOGISTICA DEL VALLE', companiaId: 2, activa: true, saldo: 0, nivel: 'sin_recargas', porcentaje: null, ultimaEntradaValor: null, ultimaEntradaEn: null }));
    await page.route(/\/api\/clients/, (r) => json(r, [{ id: 1, name: 'TRANSPORTES ANDINOS' }, { id: 2, name: 'LOGISTICA DEL VALLE' }]));
    await page.route(/\/api\/flito\/bolsas\/bolsa\/b-2$/, (r) => json(r, nueva));
    await page.route(/\/api\/flito\/bolsas$/, (r) => json(r, nueva, 201));
    await page.goto('/flito/bolsas');
    await page.getByRole('button', { name: 'Crear bolsa' }).click();
    const alta = page.getByRole('dialog', { name: 'Crear bolsa' });
    await expect(alta.getByText(/documento/i)).toHaveCount(0);
    await alta.getByLabel('Compañía *').selectOption('2');
    await alta.getByRole('checkbox', { name: 'SOAT' }).check();
    await alta.getByRole('button', { name: 'Crear bolsa' }).click();
    const s = seccion(page.getByRole('dialog', { name: 'LOGISTICA DEL VALLE' }));
    await expect(s.getByText('Pendiente', { exact: true })).toHaveCount(5);
    await expect(s.getByLabel('Cargar Cámara de Comercio')).toBeAttached();
  });

  test('AC3: esqueleto mientras carga, error con «Reintentar» sin romper el detalle, y lleno', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: CON_CARGA });
    let falla = true;
    await mock(page, { e1: () => (falla ? 500 : LLENO), e1Retraso: 400 });
    const modal = await abrir(page);
    await expect(modal.getByRole('status', { name: 'Cargando el expediente' })).toBeVisible();
    const s = seccion(modal);
    await expect(s.getByRole('alert')).toHaveText('No pudimos cargar los documentos de la compañía. Intenta de nuevo.');
    // El resto del detalle sigue usable.
    await expect(modal.getByRole('button', { name: 'Editar conceptos' })).toBeVisible();
    falla = false;
    await s.getByRole('button', { name: 'Reintentar' }).click();
    await expect(s.getByText('Vigencia vencida')).toBeVisible();
    await expect(s.getByText('No se pudo validar')).toBeVisible();
    await expect(s.getByText('Docs pendientes')).toBeVisible();
    await expect(s.getByText('2 de 4 principales válidos')).toBeVisible();
    await expect(s.getByText(/Expedida el 10\/10\/2026 · vigente hasta el 9\/11\/2026/)).toBeVisible();
    await expect(s.getByText(/Expedido el 2\/9\/2026 · venció el 2\/10\/2026\. Carga uno expedido hace menos de 30 días\./)).toBeVisible();
    await expect(s.getByText(/^Cargada por Ana Pérez el /)).toBeVisible();
    await expect(s.getByLabel('Reemplazar RUT')).toBeAttached();
  });

  test('AC4: tras cargar la Cámara se ve «Validando…» y el sondeo cada 5 s la lleva a su estado', async ({ page }) => {
    await page.clock.install();
    await loginAs(page, FINANCIERA_USER, { funciones: CON_CARGA });
    const validando = expediente(1, { camara_comercio: { estado: 'validando' } });
    const listo = expediente(1, { camara_comercio: { estado: 'valido', fechaExpedicion: '2026-10-20', venceEl: '2026-11-19', fechaOrigen: 'ocr' } });
    let actual: unknown = expediente(1);
    const peticiones = await mock(page, { e1: () => actual });
    let posts = 0;
    await page.route(/\/api\/flito\/bolsas-documentos\/companias\/1\/tipos\/camara_comercio$/, (r) => {
      posts += 1;
      actual = validando;
      return json(r, version('camara_comercio', { estado: 'validando' }), 201);
    });
    const s = seccion(await abrir(page));
    await s.getByLabel('Cargar Cámara de Comercio').setInputFiles({ name: 'camara.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
    await expect(page.getByText('Cámara de Comercio cargada. Estamos leyendo la fecha de expedición.')).toBeVisible();
    await expect(s.getByText('Validando…')).toBeVisible();
    await expect(s.getByText(/leyendo la fecha de expedición\./)).toBeVisible();
    // «Corregir» no se ofrece mientras valida.
    await expect(s.getByRole('button', { name: /fecha de expedición de Cámara/ })).toHaveCount(0);
    expect(posts).toBe(1);
    const antes = peticiones.e1;
    await page.clock.runFor(5_500);
    await expect.poll(() => peticiones.e1).toBeGreaterThan(antes);
    await expect(s.getByText('Validando…')).toBeVisible();
    actual = listo;
    await page.clock.runFor(5_500);
    await expect(s.getByTestId('doc-camara_comercio').getByText('Válido', { exact: true })).toBeVisible();
  });

  test('AC4: a los 2 min sin respuesta del OCR, aviso neutro con «Actualizar» y fin del sondeo', async ({ page }) => {
    await page.clock.install();
    await loginAs(page, FINANCIERA_USER, { funciones: CON_CARGA });
    const peticiones = await mock(page, { e1: expediente(1, { rut: { estado: 'validando' } }) });
    const s = seccion(await abrir(page));
    await expect(s.getByText('Validando…')).toBeVisible();
    for (let i = 0; i < 26; i++) await page.clock.runFor(5_000);
    const aviso = s.getByTestId('aviso-ocr-lento');
    await expect(aviso).toHaveAttribute('role', 'status');
    await expect(aviso).toContainText('La lectura de la fecha está tardando más de lo normal.');
    const tope = peticiones.e1;
    await page.clock.runFor(20_000);
    expect(peticiones.e1).toBe(tope);
    await aviso.getByRole('button', { name: 'Actualizar' }).click();
    await expect.poll(() => peticiones.e1).toBe(tope + 1);
  });

  test('AC5: con carga, digitar la fecha en «No se pudo validar» recalcula el estado; la futura se rechaza sin PUT', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: CON_CARGA });
    await mock(page, { e1: LLENO });
    const cuerpos: unknown[] = [];
    await page.route(/\/api\/flito\/bolsas-documentos\/documentos\/[^/]+\/fecha-expedicion$/, (r) => {
      cuerpos.push(r.request().postDataJSON());
      return json(r, version('certificado_bancario', {
        estado: 'valido', fechaExpedicion: '2026-10-20', venceEl: '2026-11-19', fechaOrigen: 'manual',
        fechaManual: { por: 'Financiera E2E', en: '2026-10-24T15:00:00.000Z' },
      }));
    });
    const modal = await abrir(page);
    const fila = seccion(modal).getByTestId('doc-certificado_bancario');
    await expect(fila.getByText('No pudimos leer la fecha de expedición. Digítala o carga un archivo más legible.')).toBeVisible();
    await fila.getByRole('button', { name: 'Digitar la fecha de expedición de Certificado bancario' }).click();
    const campo = fila.getByLabel('Fecha de expedición', { exact: true });
    await expect(campo).toBeFocused();
    await campo.fill('2099-01-01');
    await fila.getByRole('button', { name: 'Guardar fecha' }).click();
    await expect(fila.getByRole('alert')).toHaveText('La fecha no puede ser posterior a hoy.');
    expect(cuerpos).toHaveLength(0);

    // Esc cierra solo el editor, no el detalle.
    await campo.press('Escape');
    await expect(fila.getByLabel('Fecha de expedición', { exact: true })).toHaveCount(0);
    await expect(modal).toBeVisible();
    await expect(fila.getByRole('button', { name: /Digitar la fecha/ })).toBeFocused();

    await fila.getByRole('button', { name: /Digitar la fecha/ }).click();
    await fila.getByLabel('Fecha de expedición', { exact: true }).fill('2026-10-20');
    await fila.getByRole('button', { name: 'Guardar fecha' }).click();
    await expect(page.getByText('Fecha de expedición guardada.')).toBeVisible();
    expect(cuerpos).toEqual([{ fecha: '2026-10-20' }]);
    await expect(fila.getByText('Válido', { exact: true })).toBeVisible();
    await expect(fila.getByText(/Fecha digitada por Financiera E2E el 24\/10\/2026\./)).toBeVisible();
    // Una fecha leída por OCR también se corrige.
    await expect(seccion(modal).getByRole('button', { name: 'Corregir la fecha de expedición de Cámara de Comercio' })).toBeVisible();
  });

  test('AC6: solo con «ver» se ven estados, descarga e historial, sin controles de carga ni fecha', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: SOLO_VER });
    await mock(page, { e1: LLENO });
    await page.route(/\/api\/flito\/bolsas-documentos\/documentos\/[^/]+\/archivo$/, (r) => r.fulfill({
      status: 200, contentType: 'application/pdf', body: '%PDF-1.4',
      headers: { 'content-disposition': 'attachment; filename="rut-v3.pdf"' },
    }));
    await page.route(/\/api\/flito\/bolsas-documentos\/companias\/1\/tipos\/rut\/historial$/, (r) => json(r, {
      versiones: [
        { ...version('rut', { version: 3, estado: 'vencido', fechaExpedicion: '2026-09-02' }), vigente: true, reemplazadoEn: null, archivoDisponible: true },
        { ...version('rut', { id: '00000000-0000-4000-8000-0000000000aa', version: 1 }), vigente: false, reemplazadoEn: '2026-08-01T15:00:00.000Z', archivoDisponible: false },
      ],
    }));
    const s = seccion(await abrir(page));
    await expect(s.getByText('Vigencia vencida')).toBeVisible();
    await expect(s.getByText(/Carga uno expedido/)).toHaveCount(0);
    await expect(s.getByLabel(/^(Cargar|Reemplazar) /)).toHaveCount(0);
    await expect(s.getByRole('button', { name: /Corregir|Digitar/ })).toHaveCount(0);

    const descarga = page.waitForEvent('download');
    await s.getByRole('button', { name: 'Descargar RUT (versión 3)' }).click();
    expect((await descarga).suggestedFilename()).toBe('rut-v3.pdf');

    await s.getByRole('button', { name: 'Ver el historial de RUT' }).click();
    const historial = s.getByRole('region', { name: 'Historial del RUT' });
    await expect(historial.getByText('Versión 3 · vigente')).toBeVisible();
    await expect(historial.getByText(/archivo eliminado por retención/)).toBeVisible();
    await expect(historial.getByRole('button', { name: /Descargar/ })).toHaveCount(1);
    expect(page.url()).not.toMatch(/companias|documentos/);
  });

  test('AC6: sin «ver» no hay sección ni petición a E1', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: BOLSA });
    const peticiones = await mock(page);
    const modal = await abrir(page);
    await expect(modal.getByText('Editar conceptos')).toBeVisible();
    await expect(modal.getByTestId('expediente-documental')).toHaveCount(0);
    expect(peticiones.e1).toBe(0);
  });

  test('bolsa inactiva: aviso role=status, descarga disponible y sin Cargar/Corregir', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: CON_CARGA });
    await mock(page, { e1: LLENO });
    const s = seccion(await abrir(page, 'RENTACAR NORTE'));
    const aviso = s.getByTestId('aviso-expediente-inactiva');
    await expect(aviso).toHaveAttribute('role', 'status');
    await expect(aviso).toContainText('Reactiva la bolsa para actualizarlos.');
    await expect(s.getByLabel(/^(Cargar|Reemplazar) /)).toHaveCount(0);
    await expect(s.getByRole('button', { name: /Corregir|Digitar/ })).toHaveCount(0);
    await expect(s.getByRole('button', { name: 'Descargar RUT (versión 3)' })).toBeVisible();
  });

  test('AC7: más de 15 MB o tipo no permitido → mensaje en la fila sin petición; el error del API sale pulido', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: CON_CARGA });
    const peticiones = await mock(page, { e1: LLENO });
    const respuestas = [{ status: 400, body: { error: 'MIME real no coincide' } }, { status: 409, body: { error: 'texto cualquiera del API' } }];
    let posts = 0;
    await page.route(/\/api\/flito\/bolsas-documentos\/companias\/1\/tipos\/[a-z_]+$/, (r) => {
      const resp = respuestas[Math.min(posts, respuestas.length - 1)];
      posts += 1;
      return json(r, resp.body, resp.status);
    });
    const s = seccion(await abrir(page));
    const fila = s.getByTestId('doc-adicional');
    await fila.getByLabel('Cargar Documento adicional').setInputFiles({
      name: 'datos.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('x'),
    });
    await expect(fila.getByRole('alert')).toHaveText('Ese formato no se acepta. Usa PDF, JPG o PNG.');
    await fila.getByLabel('Cargar Documento adicional').setInputFiles({
      name: 'grande.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(16 * 1024 * 1024 + 1),
    });
    await expect(fila.getByRole('alert')).toHaveText(/^El archivo pesa 16 MB\. El máximo es 15 MB\.$/);
    expect(posts).toBe(0);
    // Lo ya cargado sigue ahí.
    await expect(s.getByText('Vigencia vencida')).toBeVisible();

    await fila.getByLabel('Cargar Documento adicional').setInputFiles({ name: 'ok.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') });
    await expect(fila.getByRole('alert')).toHaveText('El archivo no es un PDF, JPG o PNG válido, o pesa más de 15 MB.');
    await expect(page.getByText('MIME real no coincide')).toHaveCount(0);

    // 409 = carrera, sea cual sea el texto del API: toast pulido + relee el detalle y E1.
    const antes = { ...peticiones };
    await fila.getByLabel('Cargar Documento adicional').setInputFiles({ name: 'ok.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') });
    await expect(page.getByText('Algo cambió mientras guardabas: la bolsa o el documento se actualizaron. Revisa el expediente e intenta de nuevo.')).toBeVisible();
    await expect(page.getByText('texto cualquiera del API')).toHaveCount(0);
    await expect.poll(() => peticiones.detalle).toBeGreaterThan(antes.detalle);
    await expect.poll(() => peticiones.e1).toBeGreaterThan(antes.e1);
  });

  test('409 en la fecha = carrera: toast pulido, cierra el editor y relee el detalle y E1', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: CON_CARGA });
    const peticiones = await mock(page, { e1: LLENO });
    await page.route(/\/fecha-expedicion$/, (r) => json(r, { error: 'otro texto del API' }, 409));
    const fila = seccion(await abrir(page)).getByTestId('doc-rut');
    await fila.getByRole('button', { name: 'Corregir la fecha de expedición de RUT' }).click();
    await fila.getByLabel('Fecha de expedición', { exact: true }).fill('2026-10-01');
    const antes = { ...peticiones };
    await fila.getByRole('button', { name: 'Guardar fecha' }).click();
    await expect(page.getByText('Algo cambió mientras guardabas: la bolsa o el documento se actualizaron. Revisa el expediente e intenta de nuevo.')).toBeVisible();
    await expect(page.getByText('otro texto del API')).toHaveCount(0);
    await expect(fila.getByLabel('Fecha de expedición', { exact: true })).toHaveCount(0);
    await expect.poll(() => peticiones.detalle).toBeGreaterThan(antes.detalle);
    await expect.poll(() => peticiones.e1).toBeGreaterThan(antes.e1);
  });

  test('AC8: teclado — el historial abre con Enter, Esc lo cierra sin cerrar el detalle y el foco vuelve al toggle', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: CON_CARGA });
    await mock(page, { e1: LLENO });
    await page.route(/\/historial$/, (r) => json(r, {
      versiones: [{ ...version('cedula_representante'), vigente: true, reemplazadoEn: null, archivoDisponible: true }],
    }));
    const modal = await abrir(page);
    const s = seccion(modal);
    const toggle = s.getByRole('button', { name: 'Ver el historial de Cédula del representante legal' });
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const historial = s.getByRole('region', { name: 'Historial de la Cédula del representante legal' });
    await expect(historial.getByText('Versión 1 · vigente')).toBeVisible();
    await historial.getByRole('button', { name: /Descargar/ }).focus();
    await page.keyboard.press('Escape');
    await expect(historial).toHaveCount(0);
    await expect(modal).toBeVisible();
    await expect(toggle).toBeFocused();

    // El input de archivo es alcanzable por teclado (sr-only, no hidden).
    const input = s.getByLabel('Reemplazar RUT');
    await input.focus();
    await expect(input).toBeFocused();
  });

  test('retrabajo DEV: el botón de descargar tiene la altura de «Reemplazar» e «Historial»', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: CON_CARGA });
    await mock(page, { e1: LLENO });
    const fila = seccion(await abrir(page)).getByTestId('doc-rut');
    const descargar = await fila.getByRole('button', { name: 'Descargar RUT (versión 3)' }).boundingBox();
    const reemplazar = await fila.locator('label', { hasText: 'Reemplazar' }).boundingBox();
    const historial = await fila.getByRole('button', { name: 'Ver el historial de RUT' }).boundingBox();
    expect(descargar && reemplazar && historial).toBeTruthy();
    expect(descargar!.height).toBe(reemplazar!.height);
    expect(descargar!.height).toBe(historial!.height);
    expect(descargar!.width).toBe(descargar!.height);
    // Y en la misma línea: el borde superior coincide con el de sus vecinos.
    expect(Math.abs(descargar!.y - reemplazar!.y)).toBeLessThan(1);
  });

  test('retrabajo DEV: en el historial, los botones de descargar son cuadrados y a la altura de «Historial»', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: CON_CARGA });
    await mock(page, { e1: LLENO });
    await page.route(/\/historial$/, (r) => json(r, {
      versiones: [
        { ...version('rut', { version: 3 }), vigente: true, reemplazadoEn: null, archivoDisponible: true },
        { ...version('rut', { version: 2, id: '00000000-0000-4000-8000-000000000009' }), vigente: false, reemplazadoEn: '2026-10-01T10:00:00.000Z', archivoDisponible: true },
      ],
    }));
    const fila = seccion(await abrir(page)).getByTestId('doc-rut');
    const toggle = fila.getByRole('button', { name: 'Ver el historial de RUT' });
    await toggle.click();
    const historial = fila.getByRole('region', { name: 'Historial del RUT' });
    await expect(historial.getByRole('button', { name: /^Descargar RUT \(versión \d\)$/ })).toHaveCount(2);
    const alto = (await toggle.boundingBox())!.height;
    const reemplazar = (await fila.locator('label', { hasText: 'Reemplazar' }).boundingBox())!.height;
    expect(alto).toBe(reemplazar);
    for (const n of [3, 2]) {
      const caja = (await historial.getByRole('button', { name: `Descargar RUT (versión ${n})` }).boundingBox())!;
      expect(caja.height, `versión ${n} · alto`).toBe(alto);
      expect(caja.width, `versión ${n} · cuadrado`).toBe(caja.height);
    }
  });

  test('retrabajo DEV: tras cargar un archivo el foco sigue en la fila y el modal no salta al inicio', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 600 });
    await loginAs(page, FINANCIERA_USER, { funciones: CON_CARGA });
    await mock(page, { e1: LLENO });
    let respuesta = 201;
    await page.route(/\/api\/flito\/bolsas-documentos\/companias\/1\/tipos\/adicional$/, async (r) => {
      await new Promise((res) => setTimeout(res, 300));
      return respuesta === 201 ? json(r, version('adicional'), 201) : json(r, { error: 'falla' }, respuesta);
    });
    const fila = seccion(await abrir(page)).getByTestId('doc-adicional');
    await centrar(fila);
    const antes = await scrollDelModal(fila);
    expect(antes).toBeGreaterThan(0);

    const input = fila.getByLabel('Cargar Documento adicional');
    await input.focus();
    await input.setInputFiles({ name: 'ok.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') });
    await expect(fila.getByText('Cargando…')).toBeVisible();
    await expect(page.getByText('Documento adicional cargado.')).toBeVisible();
    // «Cargar» pasa a «Reemplazar» sin desmontar el control: el foco no cae al diálogo.
    const reemplazar = fila.getByLabel('Reemplazar Documento adicional');
    await expect(reemplazar).toBeFocused();
    expect(await fila.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    expect(await scrollDelModal(fila)).toBeGreaterThan(0);

    // Error de red con «Reintentar»: el botón se desmonta al reintentar y el foco vuelve a la carga.
    respuesta = 500;
    await reemplazar.setInputFiles({ name: 'otra.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') });
    const reintentar = fila.getByRole('button', { name: 'Reintentar la carga de Documento adicional' });
    await reintentar.focus();
    await reintentar.press('Enter');
    await expect(fila.getByRole('alert')).toHaveText('No pudimos cargar el archivo. Intenta de nuevo.');
    await expect.poll(() => fila.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    expect(await scrollDelModal(fila)).toBeGreaterThan(0);
  });

  test('retrabajo DEV: el clic real en «Cargar» no desplaza el overlay del modal (input sr-only dentro del label)', async ({ page }) => {
    // Causa medida en DEV: con el label estático, el input `sr-only` (absolute) tomaba como offsetParent
    // al overlay `.flit-modal`, quedaba fuera del cuerpo desplazado y el clic hacía scroll del overlay.
    await page.setViewportSize({ width: 1366, height: 600 });
    await loginAs(page, FINANCIERA_USER, { funciones: CON_CARGA });
    await mock(page, { e1: expediente(1) });
    await page.route(/\/api\/flito\/bolsas-documentos\/companias\/1\/tipos\/certificado_bancario$/, (r) =>
      json(r, version('certificado_bancario'), 201));
    const fila = seccion(await abrir(page)).getByTestId('doc-certificado_bancario');
    // El cuerpo del detalle se desplaza hasta dejar la fila abajo.
    await fila.evaluate((el) => el.scrollIntoView({ block: 'end' }));
    expect(await scrollDelModal(fila)).toBeGreaterThan(0);

    const input = fila.getByLabel('Cargar Certificado bancario');
    const boton = fila.locator('label:has(input[type="file"])');
    await expect(boton).toHaveText('Cargar');
    const geo = await input.evaluate((el) => {
      const label = el.closest('label')!;
      const r = el.getBoundingClientRect();
      const l = label.getBoundingClientRect();
      const dentro = r.left >= l.left - 1 && r.right <= l.right + 1 && r.top >= l.top - 1 && r.bottom <= l.bottom + 1;
      return { offsetParentEsLabel: (el as HTMLElement).offsetParent === label, dentro };
    });
    expect(geo.offsetParentEsLabel, 'offsetParent del input = su label').toBe(true);
    expect(geo.dentro, 'el input sr-only queda dentro del rect del botón').toBe(true);
    // Ningún sr-only de la sección escapa del cuerpo hacia el overlay (agrandaría su área de scroll).
    const sueltos = await seccion(page.getByRole('dialog', { name: 'TRANSPORTES ANDINOS' })).evaluate((sec) =>
      [...sec.querySelectorAll('.sr-only')].filter((e) => {
        const op = (e as HTMLElement).offsetParent;
        return !op || !sec.contains(op);
      }).length);
    expect(sueltos, 'sr-only anclados dentro de la sección Documentos').toBe(0);

    const overlay = page.locator('.flit-modal');
    const antes = await overlay.evaluate((el) => el.scrollTop);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), boton.click()]);
    expect(await overlay.evaluate((el) => el.scrollTop), 'el overlay no se desplaza al pulsar «Cargar»').toBe(antes);
    await chooser.setFiles({ name: 'banco.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') });
    await expect(page.getByText('Certificado bancario cargado.')).toBeVisible();
    expect(await overlay.evaluate((el) => el.scrollTop)).toBe(antes);
  });

  test('retrabajo DEV: «Digitar fecha» deja el foco en el campo, se escribe con el teclado y el sondeo no lo quita', async ({ page }) => {
    await page.clock.install();
    await page.setViewportSize({ width: 1366, height: 800 });
    await loginAs(page, FINANCIERA_USER, { funciones: CON_CARGA });
    // Otra fila en «Validando…» mantiene vivo el sondeo de 5 s mientras se escribe.
    const conSondeo = expediente(1, {
      camara_comercio: { estado: 'validando' },
      certificado_bancario: { estado: 'no_validado' },
    });
    const peticiones = await mock(page, { e1: conSondeo });
    const fila = seccion(await abrir(page)).getByTestId('doc-certificado_bancario');
    const boton = fila.getByRole('button', { name: 'Digitar la fecha de expedición de Certificado bancario' });
    // El botón queda pegado al borde inferior: el editor nace en parte fuera de la vista.
    await boton.evaluate((el) => el.scrollIntoView({ block: 'end' }));
    const antes = await scrollDelModal(fila);
    expect(antes).toBeGreaterThan(0);

    await boton.click();
    const campo = fila.getByLabel('Fecha de expedición', { exact: true });
    await expect(campo).toBeFocused();
    await expect(campo).toBeInViewport({ ratio: 1 });
    // El modal no vuelve al inicio: como mucho se desplaza lo que asoma el editor.
    const despues = await scrollDelModal(fila);
    expect(despues).toBeGreaterThanOrEqual(antes);

    // El orden de los segmentos del <input type="date"> sigue el locale del navegador.
    const orden = await page.evaluate(() => new Intl.DateTimeFormat(navigator.language)
      .formatToParts(new Date(2026, 9, 20)).filter((x) => x.type !== 'literal').map((x) => x.type));
    const partes: Record<string, string> = { day: '20', month: '10', year: '2026' };
    for (const t of orden) {
      await page.keyboard.type(partes[t]);
      const e1 = peticiones.e1;
      await page.clock.runFor(5_500);
      await expect.poll(() => peticiones.e1).toBeGreaterThan(e1);
    }
    await expect(campo).toBeFocused();
    await expect(campo).toHaveValue('2026-10-20');
    // Ni el sondeo ni el tecleo mueven el scroll.
    expect(await scrollDelModal(fila)).toBe(despues);
  });
});

// ── HU #13964 — Quitar la versión vigente (spec docs/ux/hu-13964-quitar-version-vigente.md; ADR-0028
// adenda, E7 `POST /documentos/:documentoId/retirar`). Red mockeada como el resto del spec.

/** Los 4 principales válidos y el adicional cargado: «Docs completos». */
const COMPLETO = expediente(1, {
  camara_comercio: { estado: 'valido', fechaExpedicion: '2026-10-10', venceEl: '2026-11-09', fechaOrigen: 'ocr' },
  rut: { estado: 'valido', fechaExpedicion: '2026-10-10', venceEl: '2026-11-09', fechaOrigen: 'ocr' },
  cedula_representante: { estado: 'valido' },
  certificado_bancario: { estado: 'valido', version: 2 },
  adicional: { estado: 'valido' },
});

/** Fila que devuelve E7 tras retirar: pendiente, sin vigente y con historial. */
const filaRetirada = (tipo: Tipo) => ({ tipo, estado: 'pendiente', opcional: tipo === 'adicional', vigente: null, tieneHistorial: true });

const RETIRO = { en: '2026-10-25T21:05:00.000Z', por: { nombre: 'Ana Ruiz' }, motivo: 'Era el <b>certificado</b> de otra compañía.' };

/** Mock de E7: responde con `respuesta` y guarda los cuerpos recibidos. */
async function mockRetiro(page: Page, respuesta: (tipo: Tipo) => { status: number; body: unknown }) {
  const cuerpos: unknown[] = [];
  await page.route(/\/api\/flito\/bolsas-documentos\/documentos\/([^/]+)\/retirar$/, (r) => {
    cuerpos.push(r.request().postDataJSON());
    const idDoc = r.request().url().split('/').slice(-2)[0];
    const tipo = TIPOS[Number(idDoc.slice(-1)) - 1];
    const { status, body } = respuesta(tipo);
    return json(r, body, status);
  });
  return cuerpos;
}

test.describe('FLITO — Bolsas · quitar la versión vigente (HU #13964)', () => {
  test('AC1 + AC3: quitar el Certificado bancario deja la fila Pendiente con Cargar, el historial lo muestra retirado con descarga y el expediente deja de estar completo', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: CON_CARGA });
    await mock(page, { e1: COMPLETO });
    const cuerpos = await mockRetiro(page, (tipo) => ({ status: 200, body: filaRetirada(tipo) }));
    await page.route(/\/tipos\/certificado_bancario\/historial$/, (r) => json(r, {
      versiones: [{ ...version('certificado_bancario', { version: 2 }), vigente: false, reemplazadoEn: RETIRO.en, archivoDisponible: true, retiro: RETIRO }],
    }));
    const s = seccion(await abrir(page));
    await expect(s.getByText('Docs completos')).toBeVisible();
    const fila = s.getByTestId('doc-certificado_bancario');
    await fila.getByRole('button', { name: 'Quitar la versión vigente del Certificado bancario' }).click();

    const modal = page.getByRole('dialog', { name: '¿Quitar la versión vigente?' });
    await expect(modal).toContainText('Certificado bancario queda pendiente hasta que cargues una nueva. La versión 2 se conserva en el historial como retirada');
    await expect(modal).toContainText('El expediente de la compañía queda incompleto.');
    await modal.getByRole('button', { name: 'Quitar versión' }).click();

    await expect(modal).toHaveCount(0);
    await expect(page.getByText('Certificado bancario quedó pendiente. La versión 2 queda en el historial como retirada.')).toBeVisible();
    expect(cuerpos).toHaveLength(1);
    await expect(fila.getByText('Pendiente', { exact: true })).toBeVisible();
    await expect(fila.getByText('Sin cargar.')).toBeVisible();
    await expect(fila.getByLabel('Cargar Certificado bancario')).toBeAttached();
    await expect(fila.getByRole('button', { name: /^Quitar/ })).toHaveCount(0);
    // Foco: «Quitar» se desmonta y el foco va a «Cargar» de la fila, nunca a <body>.
    await expect(fila.getByLabel('Cargar Certificado bancario')).toBeFocused();
    // AC3: sin la vigente de un principal, el expediente deja de estar completo.
    await expect(s.getByText('Docs pendientes')).toBeVisible();
    await expect(s.getByText('Docs completos')).toHaveCount(0);

    await fila.getByRole('button', { name: 'Ver el historial de Certificado bancario' }).click();
    const historial = s.getByRole('region', { name: 'Historial del Certificado bancario' });
    await expect(historial.getByText('Versión 2 · retirada el 25/10/2026')).toBeVisible();
    await expect(historial.getByText(/reemplazada/)).toHaveCount(0);
    await expect(historial.getByRole('button', { name: 'Descargar Certificado bancario (versión 2)' })).toBeVisible();
  });

  test('AC2: el historial dice «Retirada por … el …» y el motivo como texto literal', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: SOLO_VER });
    await mock(page, { e1: expediente(1, {}, ['certificado_bancario']) });
    await page.route(/\/tipos\/certificado_bancario\/historial$/, (r) => json(r, {
      versiones: [
        { ...version('certificado_bancario', { version: 2 }), vigente: false, reemplazadoEn: RETIRO.en, archivoDisponible: true, retiro: RETIRO },
        { ...version('certificado_bancario', { id: '00000000-0000-4000-8000-0000000000bb' }), vigente: false, reemplazadoEn: '2026-10-02T14:00:00.000Z', archivoDisponible: true, retiro: null },
      ],
    }));
    const s = seccion(await abrir(page));
    await s.getByRole('button', { name: 'Ver el historial de Certificado bancario' }).click();
    const historial = s.getByRole('region', { name: 'Historial del Certificado bancario' });
    await expect(historial.getByText(/^Retirada por Ana Ruiz el 25\/10\/26, 4:05/)).toBeVisible();
    await expect(historial.getByText('Motivo: «Era el <b>certificado</b> de otra compañía.»')).toBeVisible();
    await expect(historial.locator('b')).toHaveCount(0);
    await expect(historial.getByText('Versión 1 · reemplazada el 2/10/2026')).toBeVisible();
  });

  test('AC3: quitar el documento adicional no cambia «Docs completos»', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: CON_CARGA });
    await mock(page, { e1: COMPLETO });
    await mockRetiro(page, (tipo) => ({ status: 200, body: filaRetirada(tipo) }));
    const s = seccion(await abrir(page));
    const fila = s.getByTestId('doc-adicional');
    await fila.getByRole('button', { name: 'Quitar la versión vigente del Documento adicional' }).click();
    const modal = page.getByRole('dialog', { name: '¿Quitar la versión vigente?' });
    await expect(modal.getByText('El expediente de la compañía queda incompleto.')).toHaveCount(0);
    await modal.getByRole('button', { name: 'Quitar versión' }).click();
    await expect(fila.getByText('Pendiente', { exact: true })).toBeVisible();
    await expect(s.getByText('Docs completos')).toBeVisible();
  });

  test('AC5: con la bolsa inactiva no se ve «Quitar»', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: CON_CARGA });
    await mock(page, { e1: COMPLETO });
    const s = seccion(await abrir(page, 'RENTACAR NORTE'));
    await expect(s.getByRole('button', { name: 'Descargar RUT (versión 1)' })).toBeVisible();
    await expect(s.getByRole('button', { name: /^Quitar/ })).toHaveCount(0);
  });

  test('AC6: con solo ver documentos no se ve «Quitar»', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: SOLO_VER });
    await mock(page, { e1: COMPLETO });
    const s = seccion(await abrir(page));
    await expect(s.getByRole('button', { name: 'Descargar RUT (versión 1)' })).toBeVisible();
    await expect(s.getByRole('button', { name: /^Quitar/ })).toHaveCount(0);
  });

  test('«Quitar» sale también en «Validando…» y nunca en una fila pendiente', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: CON_CARGA });
    await mock(page, { e1: expediente(1, { rut: { estado: 'validando' } }) });
    const s = seccion(await abrir(page));
    await expect(s.getByTestId('doc-rut').getByRole('button', { name: 'Quitar la versión vigente del RUT' })).toBeVisible();
    await expect(s.getByTestId('doc-camara_comercio').getByRole('button', { name: /^Quitar/ })).toHaveCount(0);
  });

  test('AC7: el 409 no_vigente cierra el modal, saca el toast pulido y relee el expediente', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: CON_CARGA });
    const peticiones = await mock(page, { e1: COMPLETO });
    await mockRetiro(page, () => ({ status: 409, body: { error: 'Esta versión ya no es la vigente: texto del API', codigo: 'no_vigente' } }));
    const s = seccion(await abrir(page));
    const quitar = s.getByTestId('doc-rut').getByRole('button', { name: 'Quitar la versión vigente del RUT' });
    await quitar.click();
    const antes = { ...peticiones };
    const modal = page.getByRole('dialog', { name: '¿Quitar la versión vigente?' });
    await modal.getByRole('button', { name: 'Quitar versión' }).click();
    await expect(modal).toHaveCount(0);
    await expect(page.getByText('Algo cambió mientras quitabas la versión: el documento o la bolsa se actualizaron. Ya refrescamos el expediente; revísalo e intenta de nuevo.')).toBeVisible();
    await expect(page.getByText(/texto del API/)).toHaveCount(0);
    await expect.poll(() => peticiones.e1).toBeGreaterThan(antes.e1);
    await expect.poll(() => peticiones.detalle).toBeGreaterThan(antes.detalle);
  });

  test('AC8: sin motivo el POST va sin motivo; contador y tope de 300; cancelar no llama a la API; el 400 sale en línea y conserva el motivo', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: CON_CARGA });
    await mock(page, { e1: COMPLETO });
    let status = 400;
    const cuerpos = await mockRetiro(page, (tipo) => (status === 200
      ? { status: 200, body: filaRetirada(tipo) }
      : { status: 400, body: { error: 'El motivo admite hasta 300 caracteres.', codigo: 'motivo_invalido' } }));
    const s = seccion(await abrir(page));
    const fila = s.getByTestId('doc-rut');
    const quitar = fila.getByRole('button', { name: 'Quitar la versión vigente del RUT' });
    const modal = page.getByRole('dialog', { name: '¿Quitar la versión vigente?' });

    // Cancelar y Esc: sin petición, y el foco vuelve a «Quitar».
    await quitar.click();
    const motivo = modal.getByLabel('Motivo (opcional)');
    await expect(motivo).toBeFocused();
    await modal.getByRole('button', { name: 'Cancelar' }).click();
    await expect(modal).toHaveCount(0);
    await expect(quitar).toBeFocused();
    await quitar.click();
    await expect(motivo).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await expect(quitar).toBeFocused();
    expect(cuerpos).toHaveLength(0);

    // Contador y tope.
    await quitar.click();
    await expect(modal.getByTestId('contador-motivo')).toHaveText('0/300');
    await expect(motivo).toHaveAttribute('aria-describedby', /.+ .+/);
    await motivo.fill('x'.repeat(301));
    await expect(motivo).toHaveValue('x'.repeat(300));
    await expect(modal.getByTestId('contador-motivo')).toHaveText('300/300');

    // 400 en línea, sin el texto del API, y el motivo se conserva.
    await modal.getByRole('button', { name: 'Quitar versión' }).click();
    await expect(modal.getByRole('alert')).toHaveText('No pudimos guardar el motivo. Revisa que no pase de 300 caracteres e intenta de nuevo.');
    await expect(modal.getByText('El motivo admite hasta 300 caracteres.')).toHaveCount(0);
    await expect(motivo).toHaveValue('x'.repeat(300));
    await expect(motivo).toHaveAttribute('aria-invalid', 'true');
    expect(cuerpos[0]).toEqual({ motivo: 'x'.repeat(300) });

    // Sin motivo (solo espacios): el POST va sin motivo.
    status = 200;
    await motivo.fill('   ');
    await modal.getByRole('button', { name: 'Quitar versión' }).click();
    await expect(modal).toHaveCount(0);
    expect(cuerpos[1]).toEqual({});
  });

  test('error de red: aviso pulido en el modal, el motivo se conserva y reintentar funciona', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: CON_CARGA });
    await mock(page, { e1: COMPLETO });
    let caida = true;
    await page.route(/\/retirar$/, (r) => (caida ? r.abort('internetdisconnected') : json(r, filaRetirada('rut'))));
    const s = seccion(await abrir(page));
    await s.getByTestId('doc-rut').getByRole('button', { name: 'Quitar la versión vigente del RUT' }).click();
    const modal = page.getByRole('dialog', { name: '¿Quitar la versión vigente?' });
    await modal.getByLabel('Motivo (opcional)').fill('Ilegible');
    await modal.getByRole('button', { name: 'Quitar versión' }).click();
    await expect(modal.getByRole('alert')).toHaveText('No pudimos quitar la versión. Revisa tu conexión e intenta de nuevo.');
    await expect(modal.getByLabel('Motivo (opcional)')).toHaveValue('Ilegible');
    caida = false;
    await modal.getByRole('button', { name: 'Quitar versión' }).click();
    await expect(modal).toHaveCount(0);
    await expect(s.getByTestId('doc-rut').getByText('Pendiente', { exact: true })).toBeVisible();
  });

  test('el historial se ve con tieneHistorial aunque no haya vigente', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: CON_CARGA });
    await mock(page, { e1: expediente(1, {}, ['rut']) });
    await page.route(/\/tipos\/rut\/historial$/, (r) => json(r, {
      versiones: [{ ...version('rut'), vigente: false, reemplazadoEn: RETIRO.en, archivoDisponible: true, retiro: { ...RETIRO, motivo: null } }],
    }));
    const s = seccion(await abrir(page));
    const fila = s.getByTestId('doc-rut');
    await expect(fila.getByRole('button', { name: /^Quitar/ })).toHaveCount(0);
    await expect(s.getByTestId('doc-camara_comercio').getByRole('button', { name: /Ver el historial/ })).toHaveCount(0);
    await fila.getByRole('button', { name: 'Ver el historial de RUT' }).click();
    const historial = s.getByRole('region', { name: 'Historial del RUT' });
    await expect(historial.getByText('Versión 1 · retirada el 25/10/2026')).toBeVisible();
    await expect(historial.getByText(/^Motivo:/)).toHaveCount(0);
  });
});
