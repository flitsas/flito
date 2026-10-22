// HU #13365 — SOAT FLITO: cargar y eliminar documentos adicionales desde el detalle.
//
// Spec UX: docs/ux/flito-soat-documentos-adicionales-detalle-cargar-eliminar.md. Contrato: HU #13364.
// Matriz AC→TC del qa-agent modo A (20 TCs). Spec aparte del de #13363: aquel atiende todos los
// métodos de la ruta con un solo contador, y aquí GET / POST / DELETE se cuentan por separado.
//
// Todo con `page.route`. Los mocks mandan un `motivo` y un `error` DELIBERADAMENTE TÉCNICOS: la
// pantalla traduce por `codigo` / estado HTTP, y la única forma de probarlo es que el crudo no salga.
// Datos SINTÉTICOS.
import type { Page, Route } from '@playwright/test';
import {
  MotivoDescarteDocumentoAdicional as M,
  type DocumentoAdicionalSoat, type ResultadoDocumentosAdicionales,
} from '@operaciones/shared-types';
import { test, expect } from '../helpers/fixtures';
import { loginAs, FUNCIONES_POR_ROL, OPERACIONES_USER } from '../helpers/auth';
import { correrAxe, esperarSinViolacionesGraves } from '../helpers/axe';

const CON_AXE = Boolean(process.env.QA_AXE_CDN || process.env.QA_AXE_PATH);
const MB = 1024 * 1024;
const CRUDO = 'ERR_MULTER_MIME application/vnd.ms-excel rechazado por sniff';

const RE_COLA = /\/api\/flito\/soat\?/;
const RE_ADIC = /\/api\/flito\/soat\/[^/]+\/documentos-adicionales$/;
const RE_ADIC_DEL = /\/api\/flito\/soat\/[^/]+\/documentos-adicionales\/[^/]+$/;

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

type Archivo = { name: string; mimeType: string; buffer: Buffer };
const pdf = (name: string, bytes = 1200): Archivo => ({ name, mimeType: 'application/pdf', buffer: Buffer.alloc(Math.round(bytes), 'P') });
const png = (name: string, bytes = 600): Archivo => ({ name, mimeType: 'image/png', buffer: Buffer.alloc(Math.round(bytes), 'G') });
const txt = (name: string): Archivo => ({ name, mimeType: 'text/plain', buffer: Buffer.from('hola') });

const fila = (id: string, placa: string) => ({
  id, vin: `VIN00000000000000${id.slice(-1)}`, placa, marca: 'Chevrolet', linea: 'Onix',
  cilindraje: '1598', carroceria: 'SEDAN', tipoServicio: 'Particular',
  estado: 'pagado', esMultiplePropietario: false, companiaNombre: 'Concesionario Norte',
  organismoNombre: 'STT Manizales', proveedorSoatId: null, proveedorSoatNombre: null,
  compradores: [], tramitesFlit: [], tipoTramite: 'Matricula',
  fechaAprobacion: null, fechaCreacion: '2026-03-28T10:00:00Z',
  enviadoPorNombre: null, enviadoEn: null, pagadoEn: null, valorPagado: null,
  estancado: false, motivoRechazo: null, gestionOperaciones: false,
  creadoEn: '2026-03-28T10:00:00Z',
});

const DOC_LARGO = `${'documento-sin-espacios-'.repeat(4)}12345678.pdf`;
const doc = (id: string, etiqueta: string, tipoContenido = 'application/pdf', tamanoBytes = 1.2 * MB): DocumentoAdicionalSoat => ({
  id, etiqueta, tipoContenido, tamanoBytes, subidoEn: '2026-10-07T19:32:00Z', subidoPorNombre: 'Ana Pérez',
  url: `/api/files?key=${id}&exp=1&sig=e2e`,
} as DocumentoAdicionalSoat);
const DOCS = () => [doc('d1', 'Poder autenticado'), doc('d2', 'RUT', 'image/png', 0.5 * MB), doc('d3', DOC_LARGO, 'image/png', 500)];

// ── Funciones por TC (explícitas: no dependen del reparto por defecto) ──────────────────────────
const VER_ADIC = 'soat.documentos_adicionales.ver';
const CARGAR_ADIC = 'soat.documentos_adicionales.cargar';
const ELIMINAR_ADIC = 'soat.documentos_adicionales.eliminar';
const BASE = FUNCIONES_POR_ROL.admin.filter((f) => f !== VER_ADIC && f !== CARGAR_ADIC && f !== ELIMINAR_ADIC);
const FN = {
  VER: [...BASE, VER_ADIC],
  CARGAR: [...BASE, VER_ADIC, CARGAR_ADIC],
  ELIMINAR: [...BASE, VER_ADIC, ELIMINAR_ADIC],
  TODO: [...BASE, VER_ADIC, CARGAR_ADIC, ELIMINAR_ADIC],
};

type Resp = { status: number; cuerpo?: unknown; texto?: string } | 'retener';

const aceptado = (id: string, nombreArchivo: string, etiqueta = nombreArchivo) =>
  ({ id, etiqueta, nombreArchivo, tipoContenido: 'application/pdf', tamanoBytes: 1200 });
const r201 = (aceptados: ResultadoDocumentosAdicionales['aceptados'], descartados: ResultadoDocumentosAdicionales['descartados'] = []): Resp =>
  ({ status: 201, cuerpo: { aceptados, descartados } satisfies ResultadoDocumentosAdicionales });

/**
 * Estado MUTABLE (StrictMode pide la lista dos veces). Un 201 suma sus aceptados a la lista y un 204
 * saca la fila: así el re-GET de la pantalla ve lo que vería contra el servidor real.
 */
async function montar(page: Page, funciones: string[], opciones: { lista?: DocumentoAdicionalSoat[]; post?: Resp; del?: Resp } = {}) {
  await loginAs(page, { ...OPERACIONES_USER, funciones });
  const st = {
    lista: opciones.lista ?? DOCS(), get: { status: 200 } as { status: number },
    post: opciones.post ?? r201([]), del: opciones.del ?? ({ status: 204 } as Resp),
    gets: 0, posts: 0, deletes: 0, cuerpos: [] as string[], urlsDelete: [] as string[],
    soltarPost: () => {}, soltarDelete: () => {},
  };
  const postRetenido = new Promise<void>((r) => { st.soltarPost = r; });
  const deleteRetenido = new Promise<void>((r) => { st.soltarDelete = r; });
  await page.route(/\/api\/flito\/soat\/facetas/, (r) => json(r, 200, { companias: [], organismos: [], proveedores: [] }));
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat/, (r) => json(r, 200, []));
  await page.route(RE_COLA, (r) => json(r, 200, { items: [fila('s1', 'XYZ789')], total: 1, page: 1, pageSize: 50 }));
  await page.route(RE_ADIC, async (route) => {
    if (route.request().method() !== 'POST') {
      st.gets += 1;
      return st.get.status === 200 ? json(route, 200, { documentos: st.lista }) : json(route, st.get.status, { error: CRUDO });
    }
    st.posts += 1;
    st.cuerpos.push(route.request().postDataBuffer()?.toString('latin1') ?? '');
    let r = st.post;
    if (r === 'retener') { await postRetenido; r = r201([aceptado('n1', 'poder.pdf')]); }
    if (r.texto !== undefined) return route.fulfill({ status: r.status, contentType: 'text/plain', body: r.texto });
    if (r.status === 201) {
      const c = r.cuerpo as ResultadoDocumentosAdicionales;
      st.lista = [...st.lista, ...c.aceptados.map((a) => doc(a.id, a.etiqueta, a.tipoContenido, a.tamanoBytes))];
    }
    return json(route, r.status, r.cuerpo);
  });
  await page.route(RE_ADIC_DEL, async (route) => {
    st.deletes += 1;
    st.urlsDelete.push(route.request().url());
    let r = st.del;
    if (r === 'retener') { await deleteRetenido; r = { status: 204 }; }
    const id = route.request().url().split('/').pop();
    if (r.status === 204) { st.lista = st.lista.filter((d) => d.id !== id); return route.fulfill({ status: 204 }); }
    return json(route, r.status, { error: CRUDO });
  });
  await page.goto('/flito/soat');
  await page.getByRole('row').filter({ hasText: 'XYZ789' }).getByRole('button', { name: 'Ver', exact: true }).click();
  await expect(seccion(page).getByText('Poder autenticado', { exact: true }).or(seccion(page).getByText('Sin documentos adicionales.'))).toBeVisible();
  return st;
}

const seccion = (page: Page) => page.getByRole('dialog').getByRole('region', { name: 'Documentos adicionales', exact: true });
const panel = (page: Page) => page.getByRole('dialog').getByRole('region', { name: 'Cargar documentos adicionales', exact: true });
const btnAbrir = (page: Page) => seccion(page).getByRole('button', { name: 'Cargar documentos', exact: true });
const btnCargar = (page: Page) => panel(page).getByRole('button', { name: /^Cargar \d+ documentos?$/ });
const filas = (page: Page) => seccion(page).getByRole('button', { name: /^Descargar / });
const confirmacion = (page: Page, etiqueta: string) => seccion(page).getByRole('group', { name: `¿Eliminar «${etiqueta}»?` });

async function elegir(page: Page, archivos: Archivo[]) {
  await btnAbrir(page).click();
  await panel(page).locator('input[type="file"]').setInputFiles(archivos);
}

function archivosEnviados(cuerpo: string): string[] {
  return [...cuerpo.matchAll(/name="documentosAdicionales"; filename="([^"]*)"/g)].map((m) => m[1]);
}
function etiquetasEnviadas(cuerpo: string): string[] {
  return [...cuerpo.matchAll(/name="etiquetasDocumentosAdicionales"\r\n\r\n([\s\S]*?)\r\n--/g)].map((m) => m[1]);
}

test.describe('HU #13365 · AC1/AC2: cargar desde el detalle', () => {
  test('TC-01a: dos archivos, uno etiquetado; la lista se actualiza sin recargar y hay toast', async ({ page }) => {
    const st = await montar(page, FN.CARGAR, { post: r201([aceptado('n1', 'poder.pdf', 'Poder notarial'), aceptado('n2', 'foto.png')]) });
    const url = page.url();
    let cargasDePagina = 0;
    page.on('load', () => { cargasDePagina += 1; });

    await btnAbrir(page).click();
    await expect(panel(page).locator('input[type="file"]')).toBeFocused();
    await expect(btnAbrir(page)).toHaveCount(0);
    await panel(page).locator('input[type="file"]').setInputFiles([pdf('poder.pdf'), png('foto.png')]);
    await panel(page).getByLabel('Etiqueta (opcional)').first().fill('Poder notarial');
    await expect(btnCargar(page)).toHaveText('Cargar 2');
    await btnCargar(page).click();

    await expect(page.getByText('Se cargaron 2 documentos.')).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    await expect(btnAbrir(page)).toBeFocused();
    await expect(seccion(page).getByText('Poder notarial', { exact: true })).toBeVisible();
    await expect(filas(page)).toHaveCount(5);
    expect(st.posts).toBe(1);
    expect(archivosEnviados(st.cuerpos[0])).toEqual(['poder.pdf', 'foto.png']);
    expect(etiquetasEnviadas(st.cuerpos[0])).toEqual(['Poder notarial', '']);
    expect(page.url()).toBe(url);
    expect(cargasDePagina).toBe(0);
  });

  test('TC-01b: sin etiqueta el envío sale y la lista muestra el nombre del archivo', async ({ page }) => {
    const st = await montar(page, FN.CARGAR, { post: r201([aceptado('n1', 'cedula.pdf')]) });
    await elegir(page, [pdf('cedula.pdf')]);
    await btnCargar(page).click();
    await expect(page.getByText('Se cargó 1 documento.')).toBeVisible();
    await expect(seccion(page).getByText('cedula.pdf', { exact: true })).toBeVisible();
    expect(etiquetasEnviadas(st.cuerpos[0])).toEqual(['']);
  });

  test('TC-02a: con .ver sola no hay acción de cargar ni de eliminar', async ({ page }) => {
    const st = await montar(page, FN.VER);
    await expect(filas(page)).toHaveCount(3);
    await expect(seccion(page).getByRole('button', { name: /^(cargar|agregar)/i })).toHaveCount(0);
    await expect(seccion(page).locator('input[type="file"]')).toHaveCount(0);
    await expect(seccion(page).getByRole('button', { name: /^Eliminar / })).toHaveCount(0);
    expect(st.posts).toBe(0);
  });

  test('TC-02b: eliminar sin cargar — los permisos son independientes', async ({ page }) => {
    await montar(page, FN.ELIMINAR);
    await expect(seccion(page).getByRole('button', { name: 'Eliminar Poder autenticado' })).toBeVisible();
    await expect(btnAbrir(page)).toHaveCount(0);
  });

  test('TC-02c: vacío con .cargar invita a cargar', async ({ page }) => {
    await montar(page, FN.CARGAR, { lista: [] });
    await expect(seccion(page).getByText('Sin documentos adicionales.', { exact: true })).toBeVisible();
    await expect(seccion(page).getByText('Para agregar soportes del caso, use «Cargar documentos».')).toBeVisible();
  });
});

test.describe('HU #13365 · AC3: validación y descartes', () => {
  test('TC-03a: inválidos locales con su motivo; solo viajan los válidos', async ({ page }) => {
    const st = await montar(page, FN.CARGAR, { post: r201([aceptado('n1', 'justo.pdf')]) });
    await elegir(page, [txt('planilla.txt'), pdf('pesado.pdf', 15 * MB + 1), pdf('justo.pdf', 15 * MB), pdf('justo.pdf', 15 * MB)]);
    const p = panel(page);
    await expect(p.getByText('No se van a cargar (3)')).toBeVisible();
    await expect(p.getByText('Formato no permitido. Use PDF, JPG, PNG, WEBP o HEIC.')).toBeVisible();
    await expect(p.getByText('Pesa más de 15 MB.')).toBeVisible();
    await expect(p.getByText('Ya lo eligió.')).toBeVisible();
    await expect(p.getByText('Estos archivos no se cargan; los demás sí.')).toBeVisible();
    await expect(btnCargar(page)).toHaveText('Cargar 1');
    await btnCargar(page).click();
    await expect(page.getByText('Se cargó 1 documento.')).toBeVisible();
    expect(archivosEnviados(st.cuerpos[0])).toEqual(['justo.pdf']);
    expect(st.cuerpos[0]).not.toContain('filename="planilla.txt"');
  });

  test('TC-03b: el 21.º queda fuera por cantidad, con el copy del detalle', async ({ page }) => {
    await montar(page, FN.CARGAR);
    await elegir(page, Array.from({ length: 21 }, (_, i) => pdf(`doc-${String(i + 1).padStart(2, '0')}.pdf`)));
    await expect(panel(page).getByText('Se cargan hasta 20 archivos a la vez.')).toBeVisible();
    await expect(btnCargar(page)).toHaveText('Cargar 20');
  });

  test('TC-03c: 201 con descartes → aviso en la sección por código, sin toast de éxito', async ({ page }) => {
    await montar(page, FN.CARGAR, {
      post: r201([aceptado('n1', 'poder.pdf')], [
        { nombreArchivo: 'raro.pdf', codigo: M.FORMATO_NO_PERMITIDO, motivo: CRUDO },
        { nombreArchivo: 'foto.png', codigo: M.DOCUMENTO_REPETIDO, motivo: CRUDO },
      ]),
    });
    await elegir(page, [pdf('poder.pdf'), pdf('raro.pdf'), png('foto.png')]);
    await btnCargar(page).click();
    const aviso = seccion(page).getByRole('status').filter({ hasText: 'Se cargaron 1 de 3 documentos.' });
    await expect(aviso).toBeVisible();
    await expect(aviso).toContainText('No se cargaron:');
    await expect(aviso).toContainText('— raro.pdf: formato no permitido');
    await expect(aviso).toContainText('— foto.png: ya estaba en la solicitud');
    await expect(page.getByText(CRUDO)).toHaveCount(0);
    await expect(page.getByText('formato_no_permitido')).toHaveCount(0);
    await expect(page.getByText(/^Se cargaron \d+ documentos\.$/)).toHaveCount(0);
    await expect(filas(page)).toHaveCount(4);
    await aviso.getByRole('button', { name: 'Cerrar aviso' }).click();
    await expect(aviso).toHaveCount(0);
  });

  test('TC-03d: 201 con todo descartado → «No se cargó ningún documento.» y la lista igual', async ({ page }) => {
    const st = await montar(page, FN.CARGAR, {
      post: r201([], [
        { nombreArchivo: 'a.pdf', codigo: M.SUPERA_TAMANO, motivo: CRUDO },
        { nombreArchivo: 'b.pdf', codigo: M.SUPERA_CANTIDAD, motivo: CRUDO },
        { nombreArchivo: 'c.pdf', codigo: M.SUPERA_TOTAL, motivo: CRUDO },
      ]),
    });
    const getsAntes = st.gets;
    await elegir(page, [pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')]);
    await btnCargar(page).click();
    const aviso = seccion(page).getByRole('status').filter({ hasText: 'No se cargó ningún documento.' });
    await expect(aviso).toContainText('— a.pdf: pesa más de 15 MB');
    await expect(aviso).toContainText('— b.pdf: superaba el máximo de 20 archivos');
    await expect(aviso).toContainText('— c.pdf: superaba los 250 MB en total');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(filas(page)).toHaveCount(3);
    expect(st.gets).toBe(getsAntes);
  });

  test('TC-03e: 201 y la relectura falla → aviso con «Reintentar», la lista no se rompe', async ({ page }) => {
    const st = await montar(page, FN.CARGAR, { post: r201([aceptado('n1', 'poder.pdf')]) });
    await elegir(page, [pdf('poder.pdf')]);
    st.get = { status: 500 };
    await btnCargar(page).click();
    const aviso = seccion(page).getByRole('status').filter({ hasText: 'Los documentos se guardaron, pero la lista no se pudo actualizar.' });
    await expect(aviso).toBeVisible();
    await expect(filas(page)).toHaveCount(3);
    st.get = { status: 200 };
    await aviso.getByRole('button', { name: 'Reintentar' }).click();
    await expect(filas(page)).toHaveCount(4);
    await expect(aviso).toHaveCount(0);
  });
});

test.describe('HU #13365 · AC4/AC5: eliminar', () => {
  test('TC-04a: confirmar elimina, toast y foco a la papelera siguiente', async ({ page }) => {
    const st = await montar(page, FN.TODO);
    await seccion(page).getByRole('button', { name: 'Eliminar Poder autenticado' }).click();
    const c = confirmacion(page, 'Poder autenticado');
    await expect(c).toContainText('Se borra de forma definitiva y no se puede recuperar.');
    await expect(c.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await c.getByRole('button', { name: 'Eliminar', exact: true }).click();
    await expect(page.getByText('Se eliminó «Poder autenticado».')).toBeVisible();
    await expect(filas(page)).toHaveCount(2);
    expect(st.deletes).toBe(1);
    expect(st.urlsDelete[0]).toMatch(/\/documentos-adicionales\/d1$/);
    await expect(seccion(page).getByRole('button', { name: 'Eliminar RUT' })).toBeFocused();
  });

  test('TC-04b: Cancelar y Esc no llaman al DELETE, el modal sigue y el foco vuelve', async ({ page }) => {
    const st = await montar(page, FN.TODO);
    const papelera = seccion(page).getByRole('button', { name: 'Eliminar RUT' });
    await papelera.click();
    await confirmacion(page, 'RUT').getByRole('button', { name: 'Cancelar' }).click();
    await expect(confirmacion(page, 'RUT')).toHaveCount(0);
    await expect(papelera).toBeFocused();
    await papelera.click();
    await expect(confirmacion(page, 'RUT')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(confirmacion(page, 'RUT')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(papelera).toBeFocused();
    await expect(filas(page)).toHaveCount(3);
    expect(st.deletes).toBe(0);
  });

  test('TC-05a: sin .eliminar no hay papelera; descargar sigue', async ({ page }) => {
    await montar(page, FN.CARGAR);
    await expect(seccion(page).getByRole('button', { name: /^Eliminar / })).toHaveCount(0);
    await expect(filas(page)).toHaveCount(3);
  });
});

test.describe('HU #13365 · AC6: errores', () => {
  test('TC-06a: POST 500 → copy pulido, elección intacta, Reintentar reenvía', async ({ page }) => {
    const st = await montar(page, FN.CARGAR, { post: { status: 500, cuerpo: { error: CRUDO } } });
    await elegir(page, [pdf('poder.pdf')]);
    await panel(page).getByLabel('Etiqueta (opcional)').fill('Poder');
    await btnCargar(page).click();
    const alerta = panel(page).getByRole('alert');
    await expect(alerta).toHaveText(/No se pudieron guardar los documentos\. Intente de nuevo\./);
    await expect(page.getByText(CRUDO)).toHaveCount(0);
    await expect(panel(page).getByLabel('Etiqueta (opcional)')).toHaveValue('Poder');
    await expect(filas(page)).toHaveCount(3);
    st.post = r201([aceptado('n1', 'poder.pdf', 'Poder')]);
    await alerta.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByText('Se cargó 1 documento.')).toBeVisible();
    expect(st.posts).toBe(2);
    expect(archivosEnviados(st.cuerpos[1])).toEqual(['poder.pdf']);
    await expect(filas(page)).toHaveCount(4);
  });

  test('TC-06b: POST 429 en texto plano → copy de frecuencia, reintento disponible', async ({ page }) => {
    await montar(page, FN.CARGAR, { post: { status: 429, texto: 'Too many requests, please try again later.' } });
    await elegir(page, [pdf('poder.pdf')]);
    await btnCargar(page).click();
    const alerta = panel(page).getByRole('alert');
    await expect(alerta).toContainText('Se hicieron muchas cargas seguidas. Espere unos minutos e intente de nuevo.');
    await expect(alerta.getByRole('button', { name: 'Reintentar' })).toBeVisible();
    await expect(page.getByText('Too many requests')).toHaveCount(0);
    await expect(filas(page)).toHaveCount(3);
  });

  test('TC-06c: POST 413 → mensaje claro, lista intacta', async ({ page }) => {
    await montar(page, FN.CARGAR, { post: { status: 413, cuerpo: { error: 'Se enviaron demasiados archivos (máximo técnico 100…)' } } });
    await elegir(page, [pdf('poder.pdf')]);
    await btnCargar(page).click();
    await expect(panel(page).getByRole('alert')).toContainText('Son demasiados archivos para una sola carga. Quite algunos e intente de nuevo.');
    await expect(page.getByText(/máximo técnico/)).toHaveCount(0);
    await expect(filas(page)).toHaveCount(3);
  });

  for (const [status, copy] of [
    [403, 'Este usuario ya no tiene permiso para cargar documentos.'],
    [404, 'Esta solicitud ya no está disponible. Cierre el detalle y vuelva a abrirlo.'],
  ] as const) {
    test(`TC-06d: POST ${status} → copy pulido sin «Reintentar»`, async ({ page }) => {
      await montar(page, FN.CARGAR, { post: { status, cuerpo: { error: CRUDO } } });
      await elegir(page, [pdf('poder.pdf')]);
      await btnCargar(page).click();
      const alerta = panel(page).getByRole('alert');
      await expect(alerta).toContainText(copy);
      await expect(alerta.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
      await expect(page.getByText(CRUDO)).toHaveCount(0);
      await expect(filas(page)).toHaveCount(3);
      await panel(page).getByRole('button', { name: 'Cancelar' }).click();
      await expect(btnAbrir(page)).toBeFocused();
    });
  }

  test('TC-06e: DELETE 500 → la fila sigue y «Reintentar» relanza', async ({ page }) => {
    const st = await montar(page, FN.TODO, { del: { status: 500 } });
    await seccion(page).getByRole('button', { name: 'Eliminar Poder autenticado' }).click();
    const c = confirmacion(page, 'Poder autenticado');
    await c.getByRole('button', { name: 'Eliminar', exact: true }).click();
    await expect(c.getByRole('alert')).toHaveText('No se pudo eliminar. Intente de nuevo.');
    await expect(page.getByText(CRUDO)).toHaveCount(0);
    await expect(filas(page)).toHaveCount(2); // la fila en confirmación no muestra «Descargar»
    await expect(c).toBeVisible();
    st.del = { status: 204 };
    await c.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByText('Se eliminó «Poder autenticado».')).toBeVisible();
    expect(st.deletes).toBe(2);
    await expect(filas(page)).toHaveCount(2);
    await expect(seccion(page).getByText('Poder autenticado', { exact: true })).toHaveCount(0);
  });

  test('TC-06f: DELETE 403 sin reintento, 429 con copy, 404 quita la fila', async ({ page }) => {
    const st = await montar(page, FN.TODO, { del: { status: 403 } });
    await seccion(page).getByRole('button', { name: 'Eliminar RUT' }).click();
    const c = confirmacion(page, 'RUT');
    await c.getByRole('button', { name: 'Eliminar', exact: true }).click();
    await expect(c.getByRole('alert')).toHaveText('Este usuario ya no tiene permiso para eliminar documentos.');
    await expect(c.getByRole('button', { name: /Eliminar|Reintentar/ })).toHaveCount(0);
    await c.getByRole('button', { name: 'Cancelar' }).click();

    st.del = { status: 429 };
    await seccion(page).getByRole('button', { name: 'Eliminar RUT' }).click();
    await confirmacion(page, 'RUT').getByRole('button', { name: 'Eliminar', exact: true }).click();
    await expect(confirmacion(page, 'RUT').getByRole('alert'))
      .toHaveText('Se hicieron muchos cambios seguidos. Espere unos minutos e intente de nuevo.');
    await expect(confirmacion(page, 'RUT').getByRole('button', { name: 'Reintentar' })).toBeVisible();

    st.del = { status: 404 };
    await confirmacion(page, 'RUT').getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByText('Ese documento ya no estaba en la solicitud.')).toBeVisible();
    await expect(seccion(page).getByText('RUT', { exact: true })).toHaveCount(0);
    await expect(page.getByText(CRUDO)).toHaveCount(0);
  });
});

test.describe('HU #13365 · AC7: ocupado, accesibilidad y 360 px', () => {
  test('TC-07a: carga ocupada sin doble envío', async ({ page }) => {
    const st = await montar(page, FN.CARGAR, { post: 'retener' });
    await elegir(page, [pdf('poder.pdf')]);
    const btn = btnCargar(page);
    await btn.click();
    const ocupado = panel(page).getByRole('button', { name: 'Cargando…' });
    await expect(ocupado).toHaveAttribute('aria-busy', 'true');
    await expect(ocupado).toHaveAttribute('aria-disabled', 'true');
    await expect(ocupado).toBeFocused();
    await expect(panel(page).getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    await expect(panel(page).getByText('Guardando 1 documento… puede tardar si son pesados.')).toBeVisible();
    await ocupado.click({ force: true });
    await ocupado.dblclick({ force: true });
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeVisible();
    st.soltarPost();
    await expect(page.getByText('Se cargó 1 documento.')).toBeVisible();
    expect(st.posts).toBe(1);
  });

  test('TC-07b: eliminar ocupado sin doble DELETE', async ({ page }) => {
    const st = await montar(page, FN.TODO, { del: 'retener' });
    await seccion(page).getByRole('button', { name: 'Eliminar Poder autenticado' }).click();
    const c = confirmacion(page, 'Poder autenticado');
    await c.getByRole('button', { name: 'Eliminar', exact: true }).click();
    const ocupado = c.getByRole('button', { name: 'Eliminando…' });
    await expect(ocupado).toHaveAttribute('aria-busy', 'true');
    await expect(ocupado).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');
    await expect(c).toBeVisible();
    await ocupado.click({ force: true });
    await ocupado.dblclick({ force: true });
    st.soltarDelete();
    await expect(page.getByText('Se eliminó «Poder autenticado».')).toBeVisible();
    expect(st.deletes).toBe(1);
  });

  test('TC-07c: 360 px sin desborde, iconos con nombre y foco visible', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await montar(page, FN.TODO);
    await expect(seccion(page).getByRole('button', { name: `Eliminar ${DOC_LARGO}` })).toBeVisible();
    expect(await desbordeEn(seccion(page))).toEqual([]);

    await seccion(page).getByRole('button', { name: `Eliminar ${DOC_LARGO}` }).click();
    expect(await desbordeEn(seccion(page))).toEqual([]);
    await page.keyboard.press('Escape');
    const papelera = seccion(page).getByRole('button', { name: `Eliminar ${DOC_LARGO}` });
    await expect(papelera).toBeFocused();
    await expect(papelera).not.toHaveCSS('box-shadow', 'none');

    await elegir(page, [pdf(DOC_LARGO), txt(`${'x'.repeat(80)}.txt`)]);
    await panel(page).getByLabel('Etiqueta (opcional)').fill('e'.repeat(150));
    expect(await desbordeEn(seccion(page))).toEqual([]);
    if (CON_AXE) esperarSinViolacionesGraves(await correrAxe(page), 'detalle · cargar documentos adicionales');
    expect(page.url()).not.toContain('documento-sin-espacios');
  });
});

/** Lo que de ESTE bloque se sale de los 360 px (la barra del shell desborda sola, preexistente). */
function desbordeEn(raiz: ReturnType<Page['locator']>) {
  return raiz.evaluate((el) => [el, ...el.querySelectorAll('*')]
    .filter((e) => e.getBoundingClientRect().right > 360.5 || e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX === 'visible')
    .map((e) => `${e.tagName} ${Math.round(e.getBoundingClientRect().right)}`));
}
