// HU #14137 — FLITO SOAT · Cargar Inicial en masa y completar pendientes en Por validar (Feature #14014).
//
// Diseño: docs/ux/flito-soat-inicial-masiva-y-pendientes.md. Se interceptan los endpoints del canal con
// `page.route` (nunca el RUNT real) y se afirma lo que VIAJÓ (multipart, cuerpo de /confirmar) además de
// lo que se ve. VIN, placas y documentos ficticios.
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, CLIENTE_CON_CANAL } from '../helpers/auth';

const LOTE = '11111111-2222-4333-8444-555555555555';
const ID_F = 'aaaaaaaa-1111-4222-8333-444444444444'; // Inicial: falta factura
const ID_P = 'bbbbbbbb-1111-4222-8333-444444444444'; // Renovación: faltan datos del propietario
const VIN = '9ZZDEMO0000000001';
const PLACA = 'ZZA123';

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const PDF = { name: 'factura-venta.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 ficticio') };
const XLSX = { name: 'vehiculos.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('PK-ficticio') };

// ── Carga masiva Inicial ────────────────────────────────────────────────────────────────────────

type Fila = {
  nFila: number; placa: string | null; vin: string | null; estado: string;
  marca: string | null; linea: string | null; modelo: number | null; motivo: { codigo: string; mensaje: string } | null;
};
const fila = (nFila: number, estado: string, o: Partial<Fila> = {}): Fila => ({
  nFila, placa: null, vin: null, estado, marca: null, linea: null, modelo: null, motivo: null, ...o,
});
const avance = (o: Record<string, unknown> = {}) => ({
  loteId: LOTE, estado: 'procesando', tipo: 'inicial', total: 3, pendientes: 1, procesando: 1, aceptadas: 1,
  porValidar: 0, rechazadas: 0, motivosRechazo: [], creadoEn: '2026-10-28T10:00:00.000Z', resumen: null,
  descargaRechazadas: false, filas: [], ...o,
});
const EN_CURSO = avance({
  filas: [fila(1, 'por_validar', { vin: VIN, placa: PLACA, marca: 'RENAULT', linea: 'LOGAN', modelo: 2026, motivo: { codigo: 'falta_factura_venta', mensaje: 'Falta factura de venta' } }),
    fila(2, 'consultando', { vin: '9ZZDEMO0000000002' }), fila(3, 'en_cola', { vin: '9ZZDEMO0000000003' })],
});
const terminado = (rechazadas: number) => avance({
  estado: 'terminado', pendientes: 0, procesando: 0, aceptadas: 0, porValidar: 2, rechazadas,
  resumen: { total: 2 + rechazadas, creadas: 0, porValidar: 2, rechazadas, porValidarFactura: 2, porValidarPropietario: 0 },
  descargaRechazadas: rechazadas > 0,
  filas: [fila(1, 'por_validar'), fila(2, 'por_validar'),
    ...(rechazadas ? [fila(3, 'rechazada', { vin: '9ZZDEMO0000000003', motivo: { codigo: 'soat_vigente', mensaje: 'El vehículo ya tiene SOAT vigente' } })] : [])],
});

async function montarMasivo(page: Page, o: { avances: unknown[]; alta?: { status: number; cuerpo: unknown } }) {
  const cap = { altas: [] as string[], plantillas: 0, lecturas: 0, buscar: [] as string[] };
  await page.route(/\/api\/flito\/soat\?/, (r) => json(r, 200, { items: [], total: 0, page: 1, pageSize: 50 }));
  await page.route(/\/api\/flito\/soat\/facetas/, (r) => json(r, 200, { companias: [], organismos: [], proveedores: [] }));
  await page.route(/\/api\/flito\/soat\/cliente\/incompletas\/buscar$/, (r) => {
    cap.buscar.push(r.request().postData() ?? '');
    return json(r, 200, { items: [], total: 0, conteos: { incompleta: 0, descartada: 0 } });
  });
  await page.route(/\/api\/flito\/soat\/cliente\/companias$/, (r) => json(r, 200, { fija: true, companias: [{ id: 7, nombre: 'Transportes Andinos S.A.S.' }] }));
  await page.route(/\/api\/flito\/soat\/cliente\/masivo\/plantilla\?tipo=inicial$/, (r) => {
    cap.plantillas += 1;
    return r.fulfill({ status: 200, contentType: 'application/octet-stream', body: 'x' });
  });
  await page.route(/\/api\/flito\/soat\/cliente\/masivo$/, (r) => {
    cap.altas.push(r.request().postData() ?? '');
    return json(r, o.alta?.status ?? 201, o.alta?.cuerpo ?? { loteId: LOTE });
  });
  await page.route(new RegExp(`/api/flito/soat/cliente/masivo/${LOTE}$`), (r) => {
    const a = o.avances[Math.min(cap.lecturas, o.avances.length - 1)];
    cap.lecturas += 1;
    return json(r, 200, a);
  });
  return cap;
}

async function abrirMasivaInicial(page: Page) {
  await loginAs(page, CLIENTE_CON_CANAL);
  await page.goto('/flito/soat/solicitud');
  await page.getByRole('radio', { name: /SOAT inicial/ }).check();
  await page.getByRole('radio', { name: 'Masiva' }).check();
  await expect(page.getByRole('region', { name: 'SOAT inicial en masa' })).toBeVisible();
}

test.describe('HU #14137 · AC1 — SOAT inicial en masa', () => {
  test('la plantilla la decide el tipo: copy Inicial, plantilla inicial, columna VIN, resumen con motivo e «Ir a Por validar»', async ({ page }) => {
    const cap = await montarMasivo(page, { avances: [EN_CURSO, terminado(0)] });
    await abrirMasivaInicial(page);
    await expect(page.getByText('Descargue la plantilla y escriba el VIN de cada vehículo, una fila por vehículo.')).toBeVisible();
    await expect(page.getByText('La factura de venta se carga después, en Por validar.')).toBeVisible();
    await expect(page.getByText('Hasta 200 vehículos desde un Excel')).toBeVisible();
    await page.getByRole('button', { name: 'Descargar plantilla' }).click();
    await expect.poll(() => cap.plantillas).toBe(1);

    await page.locator('input[type=file]').setInputFiles(XLSX);
    await page.getByRole('button', { name: 'Cargar vehículos' }).click();
    // Lo que viajó: el archivo y el tipo de plantilla, sin más.
    expect(cap.altas[0]).toContain('name="tipo"');
    expect(cap.altas[0]).toContain('inicial');

    const tabla = page.getByRole('region', { name: 'Detalle por VIN' });
    await expect(tabla.getByRole('columnheader', { name: 'VIN' })).toBeVisible();
    await expect(tabla.getByText('RENAULT LOGAN · 2026 · ZZA123')).toBeVisible();
    await expect(page.getByText('Procesando: 1 de 3 filas', { exact: false })).toBeVisible();

    await expect(page.getByText('2 en Por validar').first()).toBeVisible();
    await expect(page.getByText('2 esperan la factura de venta.')).toBeVisible();
    // Sin rechazadas y con pendientes de factura: la primaria es «Ir a Por validar».
    const ir = page.getByRole('button', { name: 'Ir a Por validar' });
    await expect(ir).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cargar otro archivo' })).toBeVisible();
    // Nada de PII en storage ni en la URL.
    const guardado = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href);
    expect(guardado).not.toContain(VIN);
    expect(guardado).not.toContain(PLACA);
    await ir.click();
    await expect(page).toHaveURL(/\/flito\/soat$/);
    await expect(page.getByRole('button', { name: 'Por validar', exact: true })).toBeVisible();
  });

  test('con rechazadas la primaria sigue siendo «Descargar rechazadas»', async ({ page }) => {
    await montarMasivo(page, { avances: [terminado(1)] });
    await abrirMasivaInicial(page);
    await page.locator('input[type=file]').setInputFiles(XLSX);
    await page.getByRole('button', { name: 'Cargar vehículos' }).click();
    await expect(page.getByRole('button', { name: 'Descargar rechazadas' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ir a Por validar' })).toHaveCount(0);
  });

  test('con rechazadas y pendientes pero sin descarga disponible, «Ir a Por validar» no aparece y la primaria es «Cargar otro archivo»', async ({ page }) => {
    await montarMasivo(page, { avances: [{ ...terminado(1), descargaRechazadas: false }] });
    await abrirMasivaInicial(page);
    await page.locator('input[type=file]').setInputFiles(XLSX);
    await page.getByRole('button', { name: 'Cargar vehículos' }).click();
    await expect(page.getByText('2 esperan la factura de venta.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ir a Por validar' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Descargar rechazadas' })).toHaveCount(0);
    const otro = page.getByRole('button', { name: 'Cargar otro archivo' });
    await expect(otro).toBeVisible();
    await expect(otro).toHaveAttribute('style', /flit-gradient-primary/);
  });

  test('plantilla equivocada y archivo vacío se explican con el copy de Inicial, no con el mensaje del API', async ({ page }) => {
    await montarMasivo(page, { avances: [EN_CURSO], alta: { status: 400, cuerpo: { error: 'MENSAJE CRUDO', codigo: 'plantilla_equivocada' } } });
    await abrirMasivaInicial(page);
    await page.locator('input[type=file]').setInputFiles(XLSX);
    await page.getByRole('button', { name: 'Cargar vehículos' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Este archivo es de la plantilla de Renovación. Elija Renovación o descargue la plantilla Inicial.' })).toBeVisible();
    await expect(page.getByText('MENSAJE CRUDO')).toHaveCount(0);
  });

  test('cambiar de tipo con la forma Masiva activa remonta el panel con el copy de Renovación', async ({ page }) => {
    await montarMasivo(page, { avances: [EN_CURSO] });
    await abrirMasivaInicial(page);
    await page.getByRole('radio', { name: /Renovación/ }).check();
    await expect(page.getByRole('region', { name: 'Renovaciones en masa' })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Masiva' })).toBeChecked();
  });
});

// ── Por validar: motivo en la fila y completar ──────────────────────────────────────────────────

const incompleta = (id: string, o: Record<string, unknown>) => ({
  id, estado: 'incompleta', vin: null, companiaId: 7, companiaNombre: 'Transportes Andinos S.A.S.', placa: null,
  tipoSoat: 'INICIAL', modalidadConsulta: 'vin', motivoPendiente: 'falta_factura_venta', marca: null, linea: null,
  titular: null, solicitadoPorNombre: 'Cliente E2E', solicitadoEn: '2026-10-28T14:00:00Z', intentos: 0,
  ultimoIntentoRuntEn: '2026-10-28T14:00:00Z', descarte: null, soatId: null, ...o,
});
const F_INICIAL = incompleta(ID_F, { vin: VIN });
const F_RENOVACION = incompleta(ID_P, { tipoSoat: 'RENOVACION', modalidadConsulta: 'placa', motivoPendiente: 'faltan_datos_propietario', placa: PLACA, vin: null });
const PROPIETARIO_VACIO = {
  tipoDocumento: 'CC', numeroDocumento: '1020304050', nombres: null, apellidos: null, razonSocial: null,
  correo: null, celular: null, direccion: null, municipio: null, departamento: null,
};
const extraccion = (valores: Record<string, string>) =>
  Object.fromEntries(Object.entries(valores).map(([k, v]) => [k, { valor: v, confianza: 0.95, confiable: true }]));
const LEIDA = extraccion({
  tipoDocumento: 'CC', numeroDocumento: '1020304050', nombres: 'Ana María', apellidos: 'Pérez Rojas',
  direccion: 'Calle 1 # 2-3', municipio: 'Bogotá', departamento: 'Cundinamarca', celular: '3001234567',
});

interface OpcionesCola {
  factura?: (n: number) => { status: number; cuerpo: unknown } | 'sin-red';
  confirmar?: (n: number) => { status: number; cuerpo: unknown } | 'sin-red';
}
async function montarCola(page: Page, o: OpcionesCola = {}) {
  let quedan = [F_INICIAL, F_RENOVACION];
  const cap = { facturas: 0, confirmaciones: [] as unknown[], buscadas: 0, bodyFactura: '' };
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat/, (r) => json(r, 200, []));
  await page.route(/\/api\/flito\/soat\/facetas/, (r) => json(r, 200, { companias: [], organismos: [], proveedores: [] }));
  await page.route(/\/api\/flito\/soat\?/, (r) => json(r, 200, { items: [], total: 0, page: 1, pageSize: 50 }));
  await page.route(/\/api\/flito\/soat\/cliente\/incompletas\/buscar$/, (r) => {
    cap.buscadas += 1;
    const estados = (r.request().postDataJSON() as { estados: string[] }).estados;
    const items = estados.includes('incompleta') ? quedan : [];
    return json(r, 200, { items, total: items.length, conteos: { incompleta: quedan.length, descartada: 0 } });
  });
  await page.route(/\/api\/flito\/soat\/cliente\/incompletas\/[0-9a-f-]{36}$/, (r) => {
    const id = new URL(r.request().url()).pathname.split('/').pop()!;
    const base = id === ID_P ? F_RENOVACION : F_INICIAL;
    return json(r, 200, {
      ...base, propietario: id === ID_P ? PROPIETARIO_VACIO : null, factura: null, archivosPurgadosEn: null,
    });
  });
  await page.route(/\/api\/flito\/soat\/cliente\/incompletas\/[0-9a-f-]{36}\/factura$/, async (r) => {
    cap.facturas += 1;
    cap.bodyFactura = r.request().postData() ?? '';
    const res = o.factura ? o.factura(cap.facturas) : { status: 200, cuerpo: { extraccion: LEIDA, lectura: 'ok', vinVerificado: true, documentoDifiere: false, estado: 'incompleta' } };
    if (res === 'sin-red') return r.abort('failed');
    return json(r, res.status, res.cuerpo);
  });
  await page.route(/\/api\/flito\/soat\/cliente\/incompletas\/[0-9a-f-]{36}\/confirmar$/, async (r) => {
    cap.confirmaciones.push(r.request().postDataJSON());
    const res = o.confirmar ? o.confirmar(cap.confirmaciones.length) : { status: 200, cuerpo: { id: 'dddddddd-1111-4222-8333-444444444444', estado: 'solicitado' } };
    if (res === 'sin-red') return r.abort('failed');
    const id = new URL(r.request().url()).pathname.split('/').slice(-2)[0];
    if (res.status === 200) quedan = quedan.filter((f) => f.id !== id);
    return json(r, res.status, res.cuerpo);
  });
  return cap;
}

const tablaCola = (page: Page) => page.getByRole('region', { name: 'Pólizas SOAT' });
const filaDe = (page: Page, texto: string) => tablaCola(page).locator('tbody tr', { hasText: texto });
const modal = (page: Page) => page.getByRole('dialog');

async function abrirPorValidar(page: Page) {
  await loginAs(page, CLIENTE_CON_CANAL);
  await page.goto('/flito/soat');
  await page.getByRole('button', { name: 'Por validar', exact: true }).click();
  await expect(filaDe(page, VIN)).toBeVisible();
}
async function completarCamposVacios(page: Page) {
  await page.getByLabel('Nombre/s').fill('Ana María');
  await page.getByLabel('Apellido/s').fill('Pérez Rojas');
  await page.getByLabel('Correo electrónico').fill('ana@example.com');
  await page.getByLabel('Celular').fill('3001234567');
  await page.getByLabel('Dirección').fill('Calle 1 # 2-3');
  await page.getByLabel('Municipio').fill('Bogotá');
  await page.getByLabel('Departamento').fill('Cundinamarca');
}

test.describe('HU #14137 · AC2 — el motivo en la fila de Por validar', () => {
  test('dice el motivo, retira lo del RUNT y ofrece «Completar»', async ({ page }) => {
    await montarCola(page);
    await abrirPorValidar(page);
    const f = filaDe(page, VIN);
    await expect(f.getByText('Falta factura de venta')).toBeVisible();
    await expect(f.getByText('Datos del RUNT pendientes')).toHaveCount(0);
    await expect(f.getByText(/Último intento/)).toHaveCount(0);
    await expect(f.getByRole('button', { name: 'Reintentar consulta' })).toHaveCount(0);
    await expect(f.getByRole('button', { name: /Completar/ })).toBeVisible();
    const r = filaDe(page, PLACA);
    await expect(r.getByText('Faltan datos del propietario')).toBeVisible();
    await expect(r.getByRole('button', { name: /Completar/ })).toBeVisible();
  });
});

test.describe('HU #14137 · AC3/AC4/AC6 — completar una pendiente Inicial con la factura', () => {
  test('factura con VIN igual: se lee sola, el formulario llega prellenado y «Crear solicitud» (confirmado:true) la saca de la lista', async ({ page }) => {
    const cap = await montarCola(page);
    await abrirPorValidar(page);
    await filaDe(page, VIN).getByRole('button', { name: /Completar/ }).click();
    // El formulario NO existe hasta leer la factura.
    await expect(modal(page).getByRole('form', { name: 'Datos del propietario' })).toHaveCount(0);
    await modal(page).locator('input[type=file]').setInputFiles(PDF);
    await expect(modal(page).getByLabel('Nombre/s')).toHaveValue('Ana María');
    expect(cap.bodyFactura).toContain('name="facturaVenta"');
    await expect(modal(page).getByText('Revise los datos del propietario')).toBeVisible();
    // El correo no sale de la factura: «Crear solicitud» pide completarlo y NO envía nada antes del clic.
    expect(cap.confirmaciones).toHaveLength(0);
    await modal(page).getByLabel('Correo electrónico').fill('ana@example.com');
    await modal(page).getByRole('button', { name: 'Crear solicitud' }).click();

    await expect(page.getByText('Solicitud creada y enviada al gestor.')).toBeVisible();
    await expect(filaDe(page, VIN)).toHaveCount(0);
    expect(cap.confirmaciones).toHaveLength(1);
    expect(cap.confirmaciones[0]).toMatchObject({ confirmado: true, tipoDocumento: 'CC', numeroDocumento: '1020304050', correo: 'ana@example.com' });
    expect(cap.buscadas).toBeGreaterThan(1);
    // Ni el VIN ni el documento en storage o URL.
    const guardado = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href);
    expect(guardado).not.toContain('1020304050');
    expect(guardado).not.toContain(VIN);
  });

  for (const [tipo, crudo, esperado] of [['NIT', '890903938-8', '890903938'], ['CC', '1.020.304.050', '1020304050'], ['CC', '1020304050-1', '10203040501']] as const) {
    test(`el documento leído por OCR (${tipo} «${crudo}») se prellena limpio: «${esperado}»`, async ({ page }) => {
      await montarCola(page, {
        factura: () => ({ status: 200, cuerpo: { extraccion: extraccion({ tipoDocumento: tipo, numeroDocumento: crudo, razonSocial: 'Transportes Andinos', nombres: 'Ana', apellidos: 'Pérez', direccion: 'Calle 1 # 2-3', municipio: 'Bogotá', departamento: 'Cundinamarca', celular: '3001234567' }), lectura: 'ok', vinVerificado: true, documentoDifiere: false, estado: 'incompleta' } }),
      });
      await abrirPorValidar(page);
      await filaDe(page, VIN).getByRole('button', { name: /Completar/ }).click();
      await modal(page).locator('input[type=file]').setInputFiles(PDF);
      await expect(modal(page).getByLabel('Número de documento')).toHaveValue(esperado);
      await modal(page).getByLabel('Correo electrónico').fill('ana@example.com');
      await expect(modal(page).getByText('solo lleva letras y números')).toHaveCount(0);
      await expect(modal(page).getByRole('button', { name: 'Crear solicitud' })).toBeEnabled();
    });
  }

  test('VIN distinto: rechazo con el mensaje exacto, sin formulario y la pendiente no cambia', async ({ page }) => {
    const cap = await montarCola(page, { factura: () => ({ status: 422, cuerpo: { error: 'x', codigo: 'vin_factura_no_coincide' } }) });
    await abrirPorValidar(page);
    await filaDe(page, VIN).getByRole('button', { name: /Completar/ }).click();
    await modal(page).locator('input[type=file]').setInputFiles(PDF);
    await expect(modal(page).getByRole('alert').filter({ hasText: 'El VIN de la factura no coincide con el de la solicitud. Cargue la factura correcta.' })).toBeVisible();
    await expect(modal(page).getByRole('form', { name: 'Datos del propietario' })).toHaveCount(0);
    expect(cap.confirmaciones).toHaveLength(0);
    await modal(page).getByRole('button', { name: 'Cerrar', exact: true }).first().click();
    await expect(filaDe(page, VIN).getByText('Falta factura de venta')).toBeVisible();
  });

  test('VIN dudoso: advertencia sin rechazo; el documento distinto avisa sin sobrescribir', async ({ page }) => {
    await montarCola(page, {
      factura: () => ({ status: 200, cuerpo: { extraccion: extraccion({ ...Object.fromEntries(Object.entries(LEIDA).map(([k, v]) => [k, (v as { valor: string }).valor])), numeroDocumento: '9999999999' }), lectura: 'ok', vinVerificado: false, documentoDifiere: true, estado: 'incompleta' } }),
    });
    await abrirPorValidar(page);
    await filaDe(page, VIN).getByRole('button', { name: /Completar/ }).click();
    await modal(page).locator('input[type=file]').setInputFiles(PDF);
    await expect(modal(page).getByText('No pudimos confirmar el VIN de la factura; compárelo con el de la solicitud.')).toBeVisible();
    await expect(modal(page).getByText(VIN, { exact: false }).first()).toBeVisible();
    await expect(modal(page).getByText('El documento de la factura es distinto al que consultamos en el RUNT. Dejamos el del RUNT; revise que sea correcto.')).toBeVisible();
    // Sigue siendo posible crear: el documento que manda es el consultado.
    await expect(modal(page).getByLabel('Número de documento')).not.toHaveValue('9999999999');
    await expect(modal(page).getByRole('button', { name: 'Crear solicitud' })).toBeVisible();
  });

  test('OCR caído: la factura queda guardada, se sigue a mano y «Crear solicitud» espera los datos', async ({ page }) => {
    const cap = await montarCola(page, { factura: () => ({ status: 200, cuerpo: { extraccion: {}, lectura: 'no_disponible', vinVerificado: false, documentoDifiere: false, estado: 'incompleta' } }) });
    await abrirPorValidar(page);
    await filaDe(page, VIN).getByRole('button', { name: /Completar/ }).click();
    await modal(page).locator('input[type=file]').setInputFiles(PDF);
    await expect(modal(page).getByText('No pudimos leer la factura, pero quedó guardada. Escriba los datos del propietario a mano.').first()).toBeVisible();
    const crear = modal(page).getByRole('button', { name: 'Crear solicitud' });
    await expect(crear).toBeDisabled();
    await modal(page).getByLabel('Tipo de documento').selectOption('CC');
    await modal(page).getByLabel('Número de documento').fill('1020304050');
    await completarCamposVacios(page);
    await modal(page).getByLabel('Correo electrónico').fill('ana@example.com');
    await expect(crear).toBeEnabled();
    await crear.click();
    await expect(page.getByText('Solicitud creada y enviada al gestor.')).toBeVisible();
    expect(cap.confirmaciones).toHaveLength(1);
  });
});

test.describe('HU #14137 · AC5 — Renovación pendiente', () => {
  test('sin factura: el formulario existe desde el inicio y se crea con lo escrito', async ({ page }) => {
    const cap = await montarCola(page);
    await abrirPorValidar(page);
    await filaDe(page, PLACA).getByRole('button', { name: /Completar/ }).click();
    await expect(modal(page).getByRole('form', { name: 'Datos del propietario' })).toBeVisible();
    await expect(modal(page).getByText('Datos del RUNT pendientes')).toHaveCount(0);
    await expect(modal(page).getByText('Pendiente de validar con el RUNT')).toHaveCount(0);
    await completarCamposVacios(page);
    await modal(page).getByRole('button', { name: 'Crear solicitud' }).click();
    await expect(page.getByText('Solicitud creada y enviada al gestor.')).toBeVisible();
    expect(cap.facturas).toBe(0);
    expect(cap.confirmaciones[0]).toMatchObject({ confirmado: true, nombres: 'Ana María', municipio: 'Bogotá' });
    await expect(filaDe(page, PLACA)).toHaveCount(0);
  });

  test('con factura opcional: se prellena y se crea', async ({ page }) => {
    const cap = await montarCola(page);
    await abrirPorValidar(page);
    await filaDe(page, PLACA).getByRole('button', { name: /Completar/ }).click();
    await modal(page).locator('input[type=file]').setInputFiles(PDF);
    await expect(modal(page).getByLabel('Nombre/s')).toHaveValue('Ana María');
    await modal(page).getByLabel('Correo electrónico').fill('ana@example.com');
    await modal(page).getByRole('button', { name: 'Crear solicitud' }).click();
    await expect(page.getByText('Solicitud creada y enviada al gestor.')).toBeVisible();
    expect(cap.facturas).toBe(1);
  });
});

test.describe('HU #14137 · AC7 — errores en línea sin perder lo escrito', () => {
  test('5xx/red al leer la factura: Reintentar reenvía el mismo PDF', async ({ page }) => {
    const cap = await montarCola(page, { factura: (n) => (n === 1 ? 'sin-red' : { status: 200, cuerpo: { extraccion: LEIDA, lectura: 'ok', vinVerificado: true, documentoDifiere: false, estado: 'incompleta' } }) });
    await abrirPorValidar(page);
    await filaDe(page, VIN).getByRole('button', { name: /Completar/ }).click();
    await modal(page).locator('input[type=file]').setInputFiles(PDF);
    await expect(modal(page).getByRole('alert').filter({ hasText: 'No pudimos leer la factura. Revise su conexión e intente de nuevo.' })).toBeVisible();
    await modal(page).getByRole('button', { name: 'Reintentar' }).click();
    await expect(modal(page).getByLabel('Nombre/s')).toHaveValue('Ana María');
    expect(cap.facturas).toBe(2);
  });

  test('5xx al crear: aviso con Reintentar y los campos intactos; luego sale', async ({ page }) => {
    const cap = await montarCola(page, { confirmar: (n) => (n === 1 ? { status: 503, cuerpo: { error: 'MENSAJE CRUDO' } } : { status: 200, cuerpo: { id: 'dddddddd-1111-4222-8333-444444444444', estado: 'solicitado' } }) });
    await abrirPorValidar(page);
    await filaDe(page, PLACA).getByRole('button', { name: /Completar/ }).click();
    await completarCamposVacios(page);
    await modal(page).getByRole('button', { name: 'Crear solicitud' }).click();
    await expect(modal(page).getByRole('alert').filter({ hasText: 'No pudimos crear la solicitud. Lo que escribió sigue aquí; intente de nuevo.' })).toBeVisible();
    await expect(page.getByText('MENSAJE CRUDO')).toHaveCount(0);
    await expect(modal(page).getByLabel('Municipio')).toHaveValue('Bogotá');
    await modal(page).getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByText('Solicitud creada y enviada al gestor.')).toBeVisible();
    expect(cap.confirmaciones).toHaveLength(2);
  });

  test('409: «ya fue completada» y «Actualizar lista» recarga', async ({ page }) => {
    const cap = await montarCola(page, { confirmar: () => ({ status: 409, cuerpo: { error: 'x' } }) });
    await abrirPorValidar(page);
    await filaDe(page, PLACA).getByRole('button', { name: /Completar/ }).click();
    await completarCamposVacios(page);
    await modal(page).getByRole('button', { name: 'Crear solicitud' }).click();
    await expect(modal(page).getByText('Esta solicitud ya fue completada por otra persona. Actualice la lista para verla.')).toBeVisible();
    const antes = cap.buscadas;
    await modal(page).getByRole('button', { name: 'Actualizar lista' }).click();
    await expect(modal(page)).toHaveCount(0);
    await expect.poll(() => cap.buscadas).toBeGreaterThan(antes);
  });
});
