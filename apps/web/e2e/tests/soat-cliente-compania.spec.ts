// HU #12874 — Solicitar SOAT sin trámite con la compañía FIJA por enlace o ESCOGIDA en el formulario.
//
// Contrato: docs/arquitectura/hu-12874-soat-sin-tramite-compania.md.
//   · Enlace compañía → `GET /cliente/companias` = `{ fija: true, companias: [suya] }`: campo de solo
//     lectura y el `companiaId` NO viaja (AC1).
//   · Sin enlace → `{ fija: false, companias: [...] }`: selector obligatorio, y el `companiaId`
//     escogido viaja en la preconsulta, en la lectura de la factura y en el alta (AC2, AC3).
//   · El selector tiene sus cuatro estados (AC6).
//
// Se aserta lo que VIAJÓ (cuerpo capturado por `page.route`), no lo que la pantalla creía mandar.

import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER, CLIENTE_CON_CANAL } from '../helpers/auth';

const VIN = '9BWZZZ377VT004251';
const UUID_SOLICITUD = '11111111-2222-4333-8444-555555555555';

const RE_COMPANIAS = /\/api\/flito\/soat\/cliente\/companias$/;
const RE_ALTA = /\/api\/flito\/soat\/cliente$/;
const RE_PRECONSULTA = /\/api\/flito\/soat\/cliente\/preconsulta$/;
const RE_LECTURA = /\/api\/flito\/soat\/cliente\/factura\/lectura$/;
const RE_COLA = /\/api\/flito\/soat\?/;

const RUNT_OK = {
  vehiculo: {
    placa: 'ABC123', vin: VIN, marca: 'RENAULT', linea: 'LOGAN', modelo: '2026', clase: 'AUTOMOVIL',
    cilindraje: '1600', tipoServicio: 'Particular', carroceria: 'SEDAN',
    pasajerosSentados: '5', puertas: '4',
  },
  organismo: { codigo: '05001', nombre: 'STRIA TTEyTTO MEDELLIN' },
  propietario: null,
  vigenciaProxima: null,
};

const SUYA = { id: 7, nombre: 'Transportes Andinos S.A.S.' };
const OTRA = { id: 12, nombre: 'Logística del Caribe S.A.S.' };

/** Un usuario SIN enlace (rol `admin` → `tipoEnlace: 'ninguno'`) con la función de radicar. */
const SIN_ENLACE = { ...ADMIN_USER, puedeSolicitarSoat: true };
const FUNCIONES_SIN_ENLACE = [
  'soat.cola.ver', 'soat.solicitud.ver',
  'soat.solicitud.crear', 'soat.runt.preconsultar', 'soat.factura.leer',
];

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** El valor de un campo de TEXTO del multipart. `null` = el campo no viajó. */
function campoMultipart(cuerpo: string | null, nombre: string): string | null {
  const m = new RegExp(`name="${nombre}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`).exec(cuerpo ?? '');
  return m ? m[1] : null;
}

type Respuesta = { status: number; cuerpo: unknown };

/**
 * Intercepta el listado de compañías y los tres endpoints del canal, y CUENTA las peticiones.
 *
 * El listado responde lo que diga `ctl.lista` EN ESE MOMENTO, y no una cola por orden de llegada:
 * en `npm run dev` React monta dos veces (StrictMode) y pide la lista dos veces al abrir. `ctl.retener`
 * deja la siguiente petición en vuelo hasta `liberarLista()`, para ver el estado «cargando».
 */
async function mockCanal(page: Page, opciones: { companias: Respuesta; alta?: Respuesta }) {
  const cap = {
    listas: 0,
    altas: [] as (string | null)[],
    preconsultas: [] as (string | null)[],
    lecturas: [] as (string | null)[],
  };
  const ctl = { lista: opciones.companias, retener: false };
  let abrir: () => void = () => {};
  const enVuelo = new Promise<void>((r) => { abrir = () => r(); });
  await page.route(RE_COLA, (route) => json(route, 200, { items: [], total: 0, page: 1, pageSize: 50 }));
  await page.route(/\/api\/flito\/soat\/facetas/, (route) =>
    json(route, 200, { companias: [], organismos: [], proveedores: [] }));
  await page.route(RE_COMPANIAS, async (route) => {
    cap.listas += 1;
    const r = ctl.lista;
    if (ctl.retener) await enVuelo;
    return json(route, r.status, r.cuerpo);
  });
  await page.route(RE_ALTA, (route) => {
    cap.altas.push(route.request().postData());
    return opciones.alta
      ? json(route, opciones.alta.status, opciones.alta.cuerpo)
      : json(route, 201, { id: UUID_SOLICITUD, estado: 'solicitado' });
  });
  await page.route(RE_LECTURA, (route) => {
    cap.lecturas.push(route.request().postData());
    return json(route, 200, { extraccion: {} });
  });
  await page.route(RE_PRECONSULTA, (route) => {
    cap.preconsultas.push(route.request().postData());
    return json(route, 200, RUNT_OK);
  });
  return { cap, ctl, liberarLista: () => abrir() };
}

const lista = (fija: boolean, companias: unknown[]): Respuesta => ({ status: 200, cuerpo: { fija, companias } });

const selector = (page: Page) => page.getByRole('combobox', { name: 'Compañía' });
const btnConsultar = (page: Page) => page.getByRole('button', { name: 'Consultar el RUNT' });
const btnEnviar = (page: Page) => page.getByRole('button', { name: 'Enviar al gestor' });
const fichaRunt = (page: Page) => page.getByRole('region', { name: 'Datos del RUNT' });

async function llenarPropietario(page: Page) {
  await page.getByLabel('Tipo de documento').selectOption('CC');
  await page.getByLabel('Número de documento').fill('1020304050');
  await page.getByLabel('Nombre/s').fill('MARÍA FERNANDA');
  await page.getByLabel('Apellido/s').fill('GÓMEZ RUIZ');
  await page.getByLabel('Correo electrónico').fill('contacto@ejemplo.co');
  await page.getByLabel('Celular').fill('3001234567');
  await page.getByLabel('Dirección').fill('Calle 1 # 2-3');
  await page.getByLabel('Municipio').fill('Medellín');
  await page.getByLabel('Departamento').fill('Antioquia');
}

async function adjuntarFactura(page: Page) {
  await page.getByRole('region', { name: '2 · Factura de venta' }).locator('input[type="file"]').setInputFiles({
    name: 'factura.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 e2e'),
  });
}

/** Pulsa el primario con el teclado: con `aria-disabled` un `click()` esperaría para siempre. */
async function pulsarEnviar(page: Page) {
  await btnEnviar(page).focus();
  await page.keyboard.press('Enter');
}

async function abrirSinEnlace(page: Page, opciones: Parameters<typeof mockCanal>[1]) {
  await loginAs(page, SIN_ENLACE, { funciones: FUNCIONES_SIN_ENLACE });
  const m = await mockCanal(page, opciones);
  await page.goto('/flito/soat/solicitud');
  return m;
}

test.describe('HU #12874 · AC1 — enlace compañía: su compañía fija y no editable', () => {
  test('se ve la suya de solo lectura, sin selector, y el companiaId NO viaja en ningún paso', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    const { cap } = await mockCanal(page, { companias: lista(true, [SUYA]) });
    await page.goto('/flito/soat/solicitud');

    const seccion = page.getByRole('region', { name: 'Compañía' });
    await expect(seccion.getByRole('definition').first()).toHaveText(SUYA.nombre);
    // No editable: ni selector ni campo de texto en la sección.
    await expect(seccion.locator('select, input')).toHaveCount(0);
    // La compañía no es un faltante para quien la tiene fija.
    await expect(page.getByText(/^Para enviar falta: consultar el RUNT/)).toBeVisible();

    await page.getByLabel('VIN').fill(VIN);
    await llenarPropietario(page);
    await adjuntarFactura(page);
    await expect.poll(() => cap.lecturas.length).toBe(1);
    await btnConsultar(page).click();
    await expect(fichaRunt(page)).toBeVisible();
    await pulsarEnviar(page);
    await expect.poll(() => cap.altas.length).toBe(1);

    expect(JSON.parse(cap.preconsultas[0] ?? '{}')).toEqual({ vin: VIN });
    expect(campoMultipart(cap.lecturas[0], 'companiaId')).toBeNull();
    expect(campoMultipart(cap.altas[0], 'companiaId')).toBeNull();
  });
});

test.describe('HU #12874 · AC2 — sin enlace: selector con las compañías con canal', () => {
  test('lista solo las del canal y el companiaId escogido viaja en lectura, preconsulta y alta', async ({ page }) => {
    const { cap } = await abrirSinEnlace(page, { companias: lista(false, [SUYA, OTRA]) });

    await expect(selector(page)).toBeEnabled();
    await expect(selector(page).locator('option')).toHaveText(['Seleccione la compañía…', SUYA.nombre, OTRA.nombre]);
    await selector(page).selectOption({ label: OTRA.nombre });

    await page.getByLabel('VIN').fill(VIN);
    await llenarPropietario(page);
    await adjuntarFactura(page);
    await expect.poll(() => cap.lecturas.length).toBe(1);
    await btnConsultar(page).click();
    await expect(fichaRunt(page)).toBeVisible();
    await pulsarEnviar(page);
    await expect.poll(() => cap.altas.length).toBe(1);

    expect(campoMultipart(cap.lecturas[0], 'companiaId')).toBe(String(OTRA.id));
    expect(JSON.parse(cap.preconsultas[0] ?? '{}')).toEqual({ vin: VIN, companiaId: OTRA.id });
    expect(campoMultipart(cap.altas[0], 'companiaId')).toBe(String(OTRA.id));
  });

  test('cambiar de compañía tras consultar retira lo del RUNT y obliga a consultar de nuevo', async ({ page }) => {
    const { cap } = await abrirSinEnlace(page, { companias: lista(false, [SUYA, OTRA]) });
    await selector(page).selectOption({ label: SUYA.nombre });
    await page.getByLabel('VIN').fill(VIN);
    await btnConsultar(page).click();
    await expect(fichaRunt(page)).toBeVisible();

    await selector(page).selectOption({ label: OTRA.nombre });
    await expect(fichaRunt(page)).toHaveCount(0);
    await expect(btnConsultar(page)).toBeVisible();
    await btnConsultar(page).click();
    await expect(fichaRunt(page)).toBeVisible();
    expect(cap.preconsultas.map((p) => JSON.parse(p ?? '{}').companiaId)).toEqual([SUYA.id, OTRA.id]);
  });
});

test.describe('HU #12874 · AC3 — sin compañía no se radica', () => {
  test('la compañía es el primer faltante; consultar, leer y enviar no salen y el campo avisa y se enfoca', async ({ page }) => {
    const { cap } = await abrirSinEnlace(page, { companias: lista(false, [SUYA, OTRA]) });
    await expect(selector(page)).toBeEnabled();
    await expect(page.getByText('Para enviar falta: escoger la compañía, consultar el RUNT y 11 datos más.')).toBeVisible();

    await page.getByLabel('VIN').fill(VIN);
    await btnConsultar(page).click();
    await expect(selector(page)).toBeFocused();
    await expect(selector(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('alert').filter({ hasText: 'Escoja la compañía a nombre de la que se radica la solicitud.' })).toBeVisible();

    await llenarPropietario(page);
    await adjuntarFactura(page);
    await pulsarEnviar(page);
    await expect(selector(page)).toBeFocused();
    expect(cap.preconsultas).toHaveLength(0);
    expect(cap.lecturas).toHaveLength(0);
    expect(cap.altas).toHaveLength(0);

    // Escogerla quita el aviso y arranca la lectura que quedó pendiente, ya con su companiaId.
    await selector(page).selectOption({ label: SUYA.nombre });
    await expect(selector(page)).not.toHaveAttribute('aria-invalid', 'true');
    await expect.poll(() => cap.lecturas.length).toBe(1);
    expect(campoMultipart(cap.lecturas[0], 'companiaId')).toBe(String(SUYA.id));
  });

  test('el servidor rechaza la compañía (canal apagado): aviso pulido en el campo y la lista se recarga', async ({ page }) => {
    const { cap } = await abrirSinEnlace(page, {
      companias: lista(false, [SUYA, OTRA]),
      alta: { status: 403, cuerpo: { codigo: 'canal_desactivado', error: 'texto crudo del servidor' } },
    });
    await selector(page).selectOption({ label: OTRA.nombre });
    await page.getByLabel('VIN').fill(VIN);
    await llenarPropietario(page);
    await adjuntarFactura(page);
    await btnConsultar(page).click();
    await expect(fichaRunt(page)).toBeVisible();
    const listasAntes = cap.listas;
    await pulsarEnviar(page);

    await expect(page.getByText('Esa compañía ya no tiene habilitado el SOAT sin trámite. Escoja otra.')).toBeVisible();
    await expect(page.getByText('texto crudo del servidor')).toHaveCount(0);
    await expect.poll(() => cap.listas).toBe(listasAntes + 1);
  });
});

test.describe('HU #12874 · AC6 — el selector tiene sus cuatro estados', () => {
  test('error con reintento → cargando → lleno', async ({ page }) => {
    const { ctl, liberarLista } = await abrirSinEnlace(page, { companias: { status: 500, cuerpo: { error: 'boom' } } });
    await expect(page.getByText('No pudimos cargar las compañías.')).toBeVisible();
    await expect(page.getByText('boom')).toHaveCount(0);
    await expect(selector(page)).toBeDisabled();

    ctl.lista = lista(false, [SUYA]);
    ctl.retener = true;
    await page.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByText('Cargando las compañías…')).toBeVisible();
    await expect(selector(page)).toBeDisabled();

    liberarLista();
    await expect(selector(page)).toBeEnabled();
    await expect(selector(page).locator('option')).toHaveText(['Seleccione la compañía…', SUYA.nombre]);
  });

  test('vacío: ninguna compañía con el canal', async ({ page }) => {
    await abrirSinEnlace(page, { companias: lista(false, []) });
    await expect(page.getByText('Ninguna compañía tiene habilitado el SOAT sin trámite.')).toBeVisible();
    await expect(selector(page)).toBeDisabled();
    await expect(page.getByText(/^Para enviar falta: escoger la compañía/)).toBeVisible();
  });
});
