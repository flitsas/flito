// HU #13363 — SOAT FLITO: documentos adicionales en el alta del Cliente y en el detalle.
//
// Spec UX: docs/ux/flito-soat-documentos-adicionales.md. Contrato: HU #13362.
//
// Todo con `page.route`: nunca el RUNT real ni el backend real. Los mocks del servidor mandan un
// `motivo` DELIBERADAMENTE TÉCNICO en los descartes: la pantalla traduce por `codigo`, y la única
// forma de probarlo es que el texto crudo no aparezca nunca.
//
// Datos SINTÉTICOS (VIN, documento y archivos ficticios).
import { promises as fs } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import {
  loginAs, CLIENTE_CON_CANAL, CLIENTE_USER, FUNCIONES_POR_ROL, OPERACIONES_USER, PROVEEDOR_USER,
} from '../helpers/auth';
import { correrAxe, esperarSinViolacionesGraves } from '../helpers/axe';

/** axe solo con su fuente configurada (`QA_AXE_CDN=1` o `QA_AXE_PATH`): sin ella es fallo de entorno. */
const CON_AXE = Boolean(process.env.QA_AXE_CDN || process.env.QA_AXE_PATH);

const VIN = '9BWZZZ377VT004251';
const PLACA = 'ABC123';
const UUID_SOLICITUD = '11111111-2222-4333-8444-555555555555';
const MB = 1024 * 1024;

const RE_ALTA = /\/api\/flito\/soat\/cliente$/;
const RE_COLA = /\/api\/flito\/soat\?/;
const RE_PRECONSULTA = /\/api\/flito\/soat\/cliente\/preconsulta$/;
const RE_LECTURA = /\/api\/flito\/soat\/cliente\/factura\/lectura$/;
const RE_ADIC = /\/api\/flito\/soat\/[^/]+\/documentos-adicionales$/;
const RE_FILES = /\/api\/files\?/;

const RUNT_OK = {
  vehiculo: {
    placa: PLACA, vin: VIN, marca: 'RENAULT', linea: 'LOGAN', modelo: '2026', clase: 'AUTOMOVIL',
    cilindraje: '1600', tipoServicio: 'Particular', carroceria: 'SEDAN', pasajerosSentados: '5', puertas: '4',
  },
  organismo: { codigo: '05001', nombre: 'STRIA TTEyTTO MEDELLIN' },
  propietario: null,
  vigenciaProxima: null,
};

const CRUDO = 'ERR_MULTER_MIME application/vnd.ms-excel rechazado por sniff';

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

// ── Archivos sintéticos ─────────────────────────────────────────────────────────────────────────
type Archivo = { name: string; mimeType: string; buffer: Buffer };
const pdf = (name: string, bytes = 1200): Archivo => ({ name, mimeType: 'application/pdf', buffer: Buffer.alloc(Math.round(bytes), 'P') });
const png = (name: string, bytes = 600): Archivo => ({ name, mimeType: 'image/png', buffer: Buffer.alloc(Math.round(bytes), 'G') });
const heic = (name: string, bytes = 900): Archivo => ({ name, mimeType: 'image/heic', buffer: Buffer.alloc(Math.round(bytes), 'H') });
const txt = (name: string): Archivo => ({ name, mimeType: 'text/plain', buffer: Buffer.from('hola') });

// ── Alta ────────────────────────────────────────────────────────────────────────────────────────
const bloque4 = (page: Page) => page.getByRole('region', { name: '4 · Documentos adicionales (opcional)' });
const inputAdicionales = (page: Page) => bloque4(page).locator('input[type="file"]');
const btnEnviar = (page: Page) => page.getByRole('button', { name: 'Enviar al gestor' });

type Alta = { status: number; cuerpo: unknown } | 'abort';

async function mockAlta(page: Page, inicial: Alta = { status: 201, cuerpo: { desenlace: 'creada', id: UUID_SOLICITUD, estado: 'solicitado' } }) {
  const estado = { respuesta: inicial, cuerpos: [] as string[] };
  await page.route(RE_COLA, (route) => json(route, 200, { items: [], total: 0, page: 1, pageSize: 50 }));
  await page.route(/\/api\/flito\/soat\/facetas/, (route) => json(route, 200, { companias: [], organismos: [], proveedores: [] }));
  await page.route(RE_PRECONSULTA, (route) => json(route, 200, RUNT_OK));
  await page.route(RE_LECTURA, (route) => json(route, 200, { extraccion: {} }));
  await page.route(RE_ALTA, (route) => {
    estado.cuerpos.push(route.request().postDataBuffer()?.toString('latin1') ?? '');
    const r = estado.respuesta;
    return r === 'abort' ? route.abort('connectionfailed') : json(route, r.status, r.cuerpo);
  });
  return estado;
}

async function llenarAlta(page: Page) {
  await page.getByLabel('VIN').fill(VIN);
  await page.getByLabel('Tipo de documento').selectOption('CC');
  await page.getByLabel('Número de documento').fill('1020304050');
  await page.getByLabel('Nombre/s').fill('MARÍA FERNANDA');
  await page.getByLabel('Apellido/s').fill('GÓMEZ RUIZ');
  await page.getByLabel('Correo electrónico').fill('contacto@ejemplo.co');
  await page.getByLabel('Celular').fill('3001234567');
  await page.getByLabel('Dirección').fill('Calle 1 # 2-3');
  await page.getByLabel('Municipio').fill('Medellín');
  await page.getByLabel('Departamento').fill('Antioquia');
  await page.getByRole('region', { name: '2 · Factura de venta' }).locator('input[type="file"]').setInputFiles({
    name: 'factura.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 e2e'),
  });
  await page.getByRole('button', { name: 'Consultar el RUNT' }).click();
  await expect(page.getByRole('region', { name: 'Datos del RUNT' })).toBeVisible();
}

async function abrirAlta(page: Page, alta?: Alta) {
  await loginAs(page, CLIENTE_CON_CANAL);
  const cap = await mockAlta(page, alta);
  await page.goto('/flito/soat/solicitud');
  return cap;
}

/** Nombres de archivo de `documentosAdicionales` en el multipart, en orden. */
function archivosEnviados(cuerpo: string): string[] {
  return [...cuerpo.matchAll(/name="documentosAdicionales"; filename="([^"]*)"/g)].map((m) => m[1]);
}
/** Valores de `etiquetasDocumentosAdicionales`, en orden. */
function etiquetasEnviadas(cuerpo: string): string[] {
  return [...cuerpo.matchAll(/name="etiquetasDocumentosAdicionales"\r\n\r\n([\s\S]*?)\r\n--/g)].map((m) => m[1]);
}

test.describe('HU #13363 · alta — AC1/AC2: elegir, etiquetar, quitar', () => {
  test('TC-01a/b: el bloque 4 va al final y sin adicionales el alta es la de siempre', async ({ page }) => {
    const cap = await abrirAlta(page);
    await expect(bloque4(page)).toBeVisible();
    await expect(bloque4(page).getByText('Si tiene otros documentos que ayuden con la solicitud')).toBeVisible();
    const yFactura = (await page.getByRole('region', { name: '2 · Factura de venta' }).boundingBox())!.y;
    const yPropietario = (await page.getByRole('region', { name: '3 · Propietario' }).boundingBox())!.y;
    const y4 = (await bloque4(page).boundingBox())!.y;
    expect(y4).toBeGreaterThan(yFactura);
    expect(y4).toBeGreaterThan(yPropietario);

    await llenarAlta(page);
    await expect(page.locator('#sol-falta')).toHaveCount(0);
    await btnEnviar(page).click();
    await expect(page.getByText('Solicitud enviada. Ya está en gestión.')).toBeVisible();
    expect(cap.cuerpos).toHaveLength(1);
    expect(cap.cuerpos[0]).not.toContain('name="documentosAdicionales"');
    expect(cap.cuerpos[0]).not.toContain('name="etiquetasDocumentosAdicionales"');
  });

  test('TC-02a/b: tres archivos con tipo y tamaño legibles; quitar el del medio realinea las etiquetas', async ({ page }) => {
    const cap = await abrirAlta(page);
    await llenarAlta(page);
    await inputAdicionales(page).setInputFiles([pdf('poder-notaria.pdf', 1.2 * MB), png('rut.png', 85 * 1024), heic('IMG_2041.HEIC', 3.1 * MB)]);

    await expect(bloque4(page).getByText('3 para adjuntar')).toBeVisible();
    await expect(bloque4(page).getByText('PDF · 1,2 MB')).toBeVisible();
    await expect(bloque4(page).getByText('Imagen PNG · 85 KB')).toBeVisible();
    await expect(bloque4(page).getByText('HEIC · 3,1 MB')).toBeVisible();
    await expect(bloque4(page).getByText('3 archivos · 4,4 MB de 250 MB')).toBeVisible();

    const etiquetas = bloque4(page).getByLabel('Etiqueta (opcional)');
    await expect(etiquetas).toHaveCount(3);
    await etiquetas.nth(0).fill('Poder autenticado');
    await etiquetas.nth(1).fill('RUT');
    // La tercera queda vacía.

    await bloque4(page).getByRole('button', { name: 'Quitar rut.png' }).click();
    // El foco pasa al ✕ de la fila siguiente.
    await expect(bloque4(page).getByRole('button', { name: 'Quitar IMG_2041.HEIC' })).toBeFocused();
    await expect(etiquetas).toHaveCount(2);
    await expect(bloque4(page).getByText('2 para adjuntar')).toBeVisible();

    await btnEnviar(page).click();
    await expect(page.getByText('Solicitud enviada. Ya está en gestión.')).toBeVisible();
    expect(archivosEnviados(cap.cuerpos[0])).toEqual(['poder-notaria.pdf', 'IMG_2041.HEIC']);
    expect(etiquetasEnviadas(cap.cuerpos[0])).toEqual(['Poder autenticado', '']);
    expect(page.url()).not.toMatch(/poder|rut|IMG_2041/i);
  });
});

test.describe('HU #13363 · alta — AC3: inválidos marcados, no viajan, no bloquean', () => {
  test('TC-03a/b/c/f: formato, más de 15 MB (15 MB exactos sí), repetido y repetido de la factura', async ({ page }) => {
    const cap = await abrirAlta(page);
    await llenarAlta(page);
    await inputAdicionales(page).setInputFiles([
      txt('planilla.txt'),
      pdf('grande.pdf', 15 * MB + 1),
      pdf('justo.pdf', 15 * MB),
      pdf('poder.pdf'),
      { name: 'factura.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 e2e') },
    ]);
    await inputAdicionales(page).setInputFiles([pdf('poder.pdf')]);

    const fuera = bloque4(page).getByRole('status');
    await expect(fuera.getByText('No se van a adjuntar (4)')).toBeVisible();
    await expect(fuera.getByText('Formato no permitido. Use PDF, JPG, PNG, WEBP o HEIC.')).toBeVisible();
    await expect(fuera.getByText('Pesa más de 15 MB.')).toBeVisible();
    await expect(fuera.getByText('grande.pdf · 15,0 MB')).toBeVisible();
    await expect(fuera.getByText('Ya lo eligió.')).toHaveCount(2);
    await expect(fuera.getByText('Puede enviar la solicitud igual: estos archivos no viajan.')).toBeVisible();
    await expect(bloque4(page).getByText('2 para adjuntar')).toBeVisible();
    // Sin etiqueta para los que no viajan, y sin `aria-invalid`.
    await expect(bloque4(page).getByLabel('Etiqueta (opcional)')).toHaveCount(2);
    await expect(bloque4(page).locator('[aria-invalid="true"]')).toHaveCount(0);

    await expect(btnEnviar(page)).not.toHaveAttribute('aria-disabled', 'true');
    await btnEnviar(page).click();
    await expect(page.getByText('Solicitud enviada. Ya está en gestión.')).toBeVisible();
    expect(archivosEnviados(cap.cuerpos[0])).toEqual(['justo.pdf', 'poder.pdf']);
  });

  test('TC-03d: el archivo 21 queda fuera por cantidad', async ({ page }) => {
    const cap = await abrirAlta(page);
    await llenarAlta(page);
    await inputAdicionales(page).setInputFiles(Array.from({ length: 21 }, (_, i) => pdf(`doc-${i + 1}.pdf`, 500)));
    await expect(bloque4(page).getByText('20 para adjuntar')).toBeVisible();
    await expect(bloque4(page).getByText('Ya hay 20 archivos, que es el máximo.')).toHaveCount(1);
    await btnEnviar(page).click();
    await expect(page.getByText('Solicitud enviada. Ya está en gestión.')).toBeVisible();
    expect(archivosEnviados(cap.cuerpos[0])).toHaveLength(20);
    expect(archivosEnviados(cap.cuerpos[0])).not.toContain('doc-21.pdf');
  });

  test('TC-03e: el que cruza los 250 MB queda fuera por total', async ({ page }, info) => {
    test.slow();
    // 17 × 15 MB = 255 MB en disco (archivos dispersos): por buffer, Playwright no los transporta.
    const rutas: string[] = [];
    for (let i = 1; i <= 17; i++) {
      const ruta = info.outputPath(`pesado-${i}.pdf`);
      await fs.writeFile(ruta, '');
      await fs.truncate(ruta, 15 * MB);
      rutas.push(ruta);
    }
    await abrirAlta(page);
    await inputAdicionales(page).setInputFiles(rutas);
    await expect(bloque4(page).getByText('16 para adjuntar')).toBeVisible();
    await expect(bloque4(page).getByText('Con este archivo se superarían los 250 MB en total.')).toHaveCount(1);
    await expect(bloque4(page).getByText('16 archivos · 240,0 MB de 250 MB')).toBeVisible();
  });
});

test.describe('HU #13363 · alta — AC4: descartes del servidor', () => {
  test('TC-04a: 201 con descartes → UN toast con copy por código, cerrable, y navega a la cola', async ({ page }) => {
    await abrirAlta(page, {
      status: 201,
      cuerpo: {
        desenlace: 'creada', id: UUID_SOLICITUD, estado: 'solicitado',
        documentosAdicionales: {
          aceptados: [{ id: 'a1', etiqueta: 'Poder', nombreArchivo: 'poder.pdf', tipoContenido: 'application/pdf', tamanoBytes: 1200 }],
          descartados: [
            { nombreArchivo: 'planilla.pdf', codigo: 'formato_no_permitido', motivo: CRUDO },
            { nombreArchivo: 'foto.jpg', codigo: 'documento_repetido', motivo: CRUDO },
          ],
        },
      },
    });
    await llenarAlta(page);
    await inputAdicionales(page).setInputFiles([pdf('poder.pdf'), pdf('planilla.pdf'), { name: 'foto.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(700, 'J') }]);
    await btnEnviar(page).click();

    const toast = page.getByRole('status').filter({ hasText: 'Su solicitud se envió.' });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('No se adjuntaron 2 documentos:');
    await expect(toast).toContainText('— planilla.pdf: formato no permitido.');
    await expect(toast).toContainText('— foto.jpg: ya estaba en la solicitud.');
    await expect(toast).toContainText('La solicitud sigue su curso sin ellos.');
    await expect(page.getByText(CRUDO)).toHaveCount(0);
    await expect(page.getByText('formato_no_permitido')).toHaveCount(0);
    // Sustituye al de éxito: no hay dos toasts.
    await expect(page.getByText('Solicitud enviada. Ya está en gestión.')).toHaveCount(0);
    await expect(page).toHaveURL(/\/flito\/soat$/);
    await toast.getByRole('button', { name: 'Cerrar aviso' }).click();
    await expect(toast).toHaveCount(0);
  });

  test('TC-04b/c: 202 por validar → la tarjeta suma los guardados y los cinco motivos pulidos', async ({ page }) => {
    const codigos = ['supera_tamano', 'formato_no_permitido', 'documento_repetido', 'supera_cantidad', 'supera_total'];
    await abrirAlta(page, {
      status: 202,
      cuerpo: {
        desenlace: 'incompleta', id: UUID_SOLICITUD, estado: 'incompleta', mensaje: 'Mensaje técnico que no se pinta',
        documentosAdicionales: {
          aceptados: [
            { id: 'a1', etiqueta: 'Poder', nombreArchivo: 'poder.pdf', tipoContenido: 'application/pdf', tamanoBytes: 1200 },
            { id: 'a2', etiqueta: 'RUT', nombreArchivo: 'rut.png', tipoContenido: 'image/png', tamanoBytes: 600 },
          ],
          descartados: codigos.map((codigo, i) => ({ nombreArchivo: `x${i}.pdf`, codigo, motivo: CRUDO })),
        },
      },
    });
    await llenarAlta(page);
    await inputAdicionales(page).setInputFiles([pdf('poder.pdf'), png('rut.png')]);
    await btnEnviar(page).click();

    const tarjeta = page.getByRole('status').filter({ hasText: 'Su solicitud quedó guardada, pendiente de validar' });
    await expect(tarjeta).toBeVisible();
    await expect(tarjeta).toContainText('Junto con la solicitud guardamos 2 documentos adicionales.');
    await expect(tarjeta).toContainText('No se adjuntaron:');
    for (const [i, frase] of ['pesa más de 15 MB', 'formato no permitido', 'ya estaba en la solicitud',
      'superaba el máximo de 20 archivos', 'superaba los 250 MB en total'].entries()) {
      await expect(tarjeta.getByText(`x${i}.pdf: ${frase}`, { exact: true })).toBeVisible();
    }
    await expect(page.getByText(CRUDO)).toHaveCount(0);
    // Sin toast encima de la tarjeta.
    await expect(page.getByText('Su solicitud se envió.')).toHaveCount(0);
  });
});

test.describe('HU #13363 · alta — AC5: un error del alta conserva lo elegido', () => {
  test('TC-05a: 500 → archivos, etiquetas e inválidos siguen; el reintento manda los mismos', async ({ page }) => {
    const cap = await abrirAlta(page, { status: 500, cuerpo: { error: 'boom interno' } });
    await llenarAlta(page);
    await inputAdicionales(page).setInputFiles([pdf('poder.pdf'), png('rut.png'), txt('nota.txt')]);
    await bloque4(page).getByLabel('Etiqueta (opcional)').nth(0).fill('Poder autenticado');
    await btnEnviar(page).click();
    // El copy del fallo es el de hoy (`encajarFallo`): esta HU no lo cambia.
    await expect(page.getByRole('alert').first()).toBeVisible();

    await expect(bloque4(page).getByText('2 para adjuntar')).toBeVisible();
    await expect(bloque4(page).getByLabel('Etiqueta (opcional)').nth(0)).toHaveValue('Poder autenticado');
    await expect(bloque4(page).getByText('No se van a adjuntar (1)')).toBeVisible();

    cap.respuesta = { status: 201, cuerpo: { desenlace: 'creada', id: UUID_SOLICITUD, estado: 'solicitado' } };
    await btnEnviar(page).click();
    await expect(page.getByText('Solicitud enviada. Ya está en gestión.')).toBeVisible();
    expect(archivosEnviados(cap.cuerpos[1])).toEqual(['poder.pdf', 'rut.png']);
    expect(etiquetasEnviadas(cap.cuerpos[1])).toEqual(['Poder autenticado', '']);
  });

  test('TC-05b: error de red → lo elegido sigue', async ({ page }) => {
    await abrirAlta(page, 'abort');
    await llenarAlta(page);
    await inputAdicionales(page).setInputFiles([pdf('poder.pdf')]);
    await btnEnviar(page).click();
    await expect(page.getByRole('alert').first()).toBeVisible();
    await expect(bloque4(page).getByText('1 para adjuntar')).toBeVisible();
    await expect(bloque4(page).getByText('poder.pdf', { exact: true })).toBeVisible();
  });
});

// ── Detalle ─────────────────────────────────────────────────────────────────────────────────────
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
const DOCS = [
  // 03:30Z del 8 = 22:30 del 7 en Bogotá: un formateo por huso local o UTC lo delata.
  { id: 'd1', etiqueta: 'Poder autenticado', tipoContenido: 'application/pdf', tamanoBytes: 1.2 * MB,
    subidoEn: '2026-10-08T03:30:00Z', subidoPorNombre: 'Ana Pérez', url: '/api/files?key=k1&exp=1&sig=e2e' },
  { id: 'd2', etiqueta: 'IMG_2041.HEIC', tipoContenido: 'image/heic', tamanoBytes: 3.1 * MB,
    subidoEn: '2026-10-07T19:32:00Z', subidoPorNombre: 'Ana Pérez', url: '/api/files?key=k2&exp=1&sig=e2e' },
  { id: 'd3', etiqueta: DOC_LARGO, tipoContenido: 'image/png', tamanoBytes: 500,
    subidoEn: '2026-10-07T19:32:00Z', subidoPorNombre: 'Ana Pérez', url: '/api/files?key=k3&exp=1&sig=e2e' },
];

type RespAdic = { status: number; cuerpo: unknown } | 'retener';

/**
 * `respuesta` es MUTABLE y no una lista por orden de llamada: en desarrollo React monta dos veces
 * (StrictMode) y la sección pide la lista dos veces al abrir.
 */
async function montarDetalle(page: Page, inicial: RespAdic) {
  const estado = { llamadas: 0, archivos: 0, respuesta: inicial, soltar: () => {} };
  const retenida = new Promise<void>((r) => { estado.soltar = r; });
  await page.route(/\/api\/flito\/soat\/facetas/, (r) => json(r, 200, { companias: [], organismos: [], proveedores: [] }));
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat/, (r) => json(r, 200, []));
  await page.route(RE_COLA, (r) => json(r, 200, { items: [fila('s1', 'XYZ789')], total: 1, page: 1, pageSize: 50 }));
  await page.route(RE_ADIC, async (route) => {
    estado.llamadas += 1;
    const r = estado.respuesta;
    if (r === 'retener') { await retenida; return json(route, 200, { documentos: [] }); }
    return json(route, r.status, r.cuerpo);
  });
  await page.route(RE_FILES, (route) => {
    estado.archivos += 1;
    return route.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-1.4 E2E', headers: { 'content-disposition': 'inline' } });
  });
  await page.goto('/flito/soat');
  await page.getByRole('row').filter({ hasText: 'XYZ789' }).getByRole('button', { name: 'Ver', exact: true }).click();
  return { dialogo: page.getByRole('dialog'), estado };
}

const seccion = (page: Page) => page.getByRole('dialog').getByRole('region', { name: 'Documentos adicionales' });

test.describe('HU #13363 · detalle — AC6/AC7: lista con permiso', () => {
  test('TC-06a/b/c: etiqueta, tipo, fecha en hora de Colombia, quién; HEIC sin «Ver»; descarga', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { estado } = await montarDetalle(page, { status: 200, cuerpo: { documentos: DOCS } });
    const s = seccion(page);
    await expect(s.getByText('Poder autenticado', { exact: true })).toBeVisible();
    await expect(s.getByText('PDF · 1,2 MB · 07/10/2026 22:30 · Ana Pérez')).toBeVisible();
    await expect(s.getByText('HEIC · 3,1 MB · 07/10/2026 14:32 · Ana Pérez · Sin vista previa')).toBeVisible();
    await expect(s.getByRole('link', { name: 'Ver Poder autenticado' })).toHaveAttribute('href', DOCS[0].url);
    await expect(s.getByRole('link', { name: 'Ver IMG_2041.HEIC' })).toHaveCount(0);
    await expect(s.locator('img')).toHaveCount(0);

    const [descarga] = await Promise.all([
      page.waitForEvent('download'),
      s.getByRole('button', { name: 'Descargar Poder autenticado' }).click(),
    ]);
    expect(descarga.suggestedFilename()).toBe('Poder autenticado.pdf');
    expect(estado.archivos).toBe(1);
  });

  test('TC-06c: el proveedor también ve la sección', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await montarDetalle(page, { status: 200, cuerpo: { documentos: DOCS } });
    await expect(seccion(page).getByText('Poder autenticado', { exact: true })).toBeVisible();
  });

  test('TC-07a: sin la función la sección no existe y el endpoint no se llama', async ({ page }) => {
    await loginAs(page, {
      ...OPERACIONES_USER,
      funciones: FUNCIONES_POR_ROL.admin.filter((f) => f !== 'soat.documentos_adicionales.ver'),
    });
    const { dialogo, estado } = await montarDetalle(page, { status: 200, cuerpo: { documentos: DOCS } });
    await expect(dialogo.getByText('Comprobante', { exact: true })).toBeVisible();
    await expect(seccion(page)).toHaveCount(0);
    expect(estado.llamadas).toBe(0);
  });

  test('TC-07b: el Cliente no la ve', async ({ page }) => {
    await loginAs(page, CLIENTE_USER);
    const { dialogo, estado } = await montarDetalle(page, { status: 200, cuerpo: { documentos: DOCS } });
    await expect(dialogo).toBeVisible();
    await expect(seccion(page)).toHaveCount(0);
    expect(estado.llamadas).toBe(0);
  });
});

test.describe('HU #13363 · detalle — AC8: los 4 estados', () => {
  test('TC-08a: cargando', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { estado } = await montarDetalle(page, 'retener');
    await expect(seccion(page).getByRole('status', { name: 'Cargando documentos adicionales' })).toHaveAttribute('aria-busy', 'true');
    estado.soltar();
    await expect(seccion(page).getByText('Sin documentos adicionales.')).toBeVisible();
  });

  test('TC-08b: error con reintento que relanza', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { estado } = await montarDetalle(page, { status: 500, cuerpo: { error: 'detalle interno que NO debe verse' } });
    const alerta = seccion(page).getByRole('alert');
    await expect(alerta).toContainText('No se pudieron cargar los documentos adicionales.');
    await expect(page.getByText('detalle interno que NO debe verse')).toHaveCount(0);
    const antes = estado.llamadas;
    estado.respuesta = { status: 200, cuerpo: { documentos: DOCS } };
    await alerta.getByRole('button', { name: 'Reintentar' }).click();
    await expect(seccion(page).getByText('Poder autenticado', { exact: true })).toBeVisible();
    // El reintento RELANZA la petición: una más, no la lista cacheada.
    expect(estado.llamadas).toBe(antes + 1);
  });

  test('TC-08c: vacío', async ({ page }) => {
    // Sin `.cargar` (HU #13365): con ella el vacío invita a cargar y lo prueba el spec de edición.
    await loginAs(page, {
      ...OPERACIONES_USER,
      funciones: FUNCIONES_POR_ROL.admin.filter((f) => f !== 'soat.documentos_adicionales.cargar'),
    });
    await montarDetalle(page, { status: 200, cuerpo: { documentos: [] } });
    await expect(seccion(page).getByText('Sin documentos adicionales.', { exact: true })).toBeVisible();
    await expect(seccion(page).getByText('Aquí aparecen los que se adjunten en la solicitud.')).toBeVisible();
  });
});

/**
 * Lo que de ESTE bloque se sale de los 360 px. Se mide el bloque y no `documentElement`: la barra
 * superior del shell ya desborda a 360 px por sí sola (preexistente, fuera de esta HU) y ese aserto
 * no diría nada del bloque.
 */
function desbordeEn(raiz: ReturnType<Page['locator']>) {
  return raiz.evaluate((el) => [el, ...el.querySelectorAll('*')]
    .filter((e) => e.getBoundingClientRect().right > 360.5 || e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX === 'visible')
    .map((e) => `${e.tagName} ${Math.round(e.getBoundingClientRect().right)}`));
}

test.describe('HU #13363 · AC9: accesibilidad y 360 px', () => {
  test('TC-09a: alta a 360 px sin desborde, etiquetas con label y foco visible en ✕', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await abrirAlta(page);
    await inputAdicionales(page).setInputFiles([pdf(DOC_LARGO), txt(`${'x'.repeat(80)}.txt`)]);
    await expect(bloque4(page).getByLabel('Etiqueta (opcional)')).toHaveCount(1);
    expect(await desbordeEn(bloque4(page))).toEqual([]);
    if (CON_AXE) esperarSinViolacionesGraves(await correrAxe(page), 'alta · documentos adicionales con inválido');

    const etiqueta = bloque4(page).getByLabel('Etiqueta (opcional)');
    await etiqueta.focus();
    await page.keyboard.press('Shift+Tab');
    const quitar = bloque4(page).getByRole('button', { name: `Quitar ${DOC_LARGO}` });
    await expect(quitar).toBeFocused();
    await expect(quitar).not.toHaveCSS('box-shadow', 'none');
    expect(page.url()).not.toContain('documento-sin-espacios');
  });

  test('TC-09b: detalle a 360 px sin desborde y descarga con la etiqueta en el nombre', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await loginAs(page, OPERACIONES_USER);
    await montarDetalle(page, { status: 200, cuerpo: { documentos: DOCS } });
    await expect(seccion(page).getByRole('button', { name: `Descargar ${DOC_LARGO}` })).toBeVisible();
    expect(await desbordeEn(seccion(page))).toEqual([]);
    if (CON_AXE) esperarSinViolacionesGraves(await correrAxe(page), 'detalle · documentos adicionales');
  });
});
