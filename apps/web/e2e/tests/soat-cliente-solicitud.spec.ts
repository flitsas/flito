// HU #11967 — SOAT FLITO: consultar el RUNT como compuerta y propietario completo (canal Cliente).
//
// Continúa `soat-cliente-solicitud` de la #11914/#11936. Lo que cambia respecto de la #11936, que es
// lo que esta HU revierte por decisión del PO (ADR-0010): vuelve «Consultar el RUNT», vuelve el
// modal de SOAT vigente y el primario de envío queda cerrado hasta que la consulta resuelva.
//
// ── Cómo se prueban los desenlaces, y por qué así ───────────────────────────────────────────────
//
// Se interceptan los DOS endpoints del canal con `page.route` y **nunca el RUNT real** (tarda hasta
// un minuto y no se llama desde CI). Los mocks devuelven el `codigo` correcto con un `mensaje`
// DELIBERADAMENTE ENGAÑOSO —un 503 cuyo texto hable de datos, un 422 que diga «no está disponible»—
// porque es la única forma de comprobar que la pantalla ramifica por el código y no por la prosa:
// un `if (/revise/i.test(mensaje))` pasa con mocks realistas y muere aquí.
//
// Revisión admin: `soat-revision-rechazo.spec.ts`. La pantalla legada `/soat` y su «Verificar RUNT»
// son otra cosa y viven en `rol-cliente-identidad.spec.ts`.
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, CLIENTE_USER, CLIENTE_CON_CANAL, OPERACIONES_USER } from '../helpers/auth';

const PLACA = 'ABC123';
const VIN = '9BWZZZ377VT004251';
const TIPO_DOC = 'CC';
const NUMERO_DOC = '1020304050';
const CORREO = 'contacto@ejemplo.co';
const UUID_RECHAZADA = '11111111-2222-4333-8444-555555555555';

const RE_ALTA = /\/api\/flito\/soat\/cliente$/;
const RE_COLA = /\/api\/flito\/soat\?/;
const RE_PRECONSULTA = /\/api\/flito\/soat\/cliente\/preconsulta$/;
const RE_DETALLE = /\/api\/flito\/soat\/[0-9a-f-]{36}$/;
const RE_SUBSANAR = /\/api\/flito\/soat\/[0-9a-f-]{36}\/solicitud$/;

/** Lo que devuelve la preconsulta cuando el RUNT dice que sí (contrato §2.1 de la #11966). */
const RUNT_OK = {
  vehiculo: {
    placa: PLACA, vin: VIN, marca: 'RENAULT', linea: 'LOGAN', modelo: '2026', clase: 'AUTOMOVIL',
    cilindraje: '1600', tipoServicio: 'Particular', carroceria: 'SEDAN',
    pasajerosSentados: '5', puertas: '4',
  },
  organismo: { codigo: '05001', nombre: 'STRIA TTEyTTO MEDELLIN' },
  propietario: null as { nombreCompleto: string } | null,
};

/** Una fila de la cola con la forma que `FlitoSoat` espera, ya recortada como al Cliente. */
function fila(over: Record<string, unknown> = {}) {
  return {
    id: UUID_RECHAZADA, vin: VIN, placa: PLACA, marca: 'RENAULT', linea: 'LOGAN',
    cilindraje: '1600', carroceria: 'SEDAN', tipoServicio: 'Particular',
    estado: 'pendiente_revision', esMultiplePropietario: false, companiaNombre: 'Transportes Sur',
    organismoNombre: 'STRIA TTEyTTO MEDELLIN',
    compradores: [{ nombreCompleto: 'María Gómez', numeroDocumento: NUMERO_DOC, orden: 0, porcentajeParticipacion: null }],
    tramitesFlit: [], tipoTramite: null, fechaAprobacion: null, fechaCreacion: '2026-08-01T10:00:00Z',
    enviadoEn: null, pagadoEn: null, estancado: false, motivoRechazo: null,
    creadoEn: '2026-08-01T10:00:00Z',
    ...over,
  };
}

/** El detalle de una solicitud del canal: trae además el titular GUARDADO y partido (HU #11966). */
function detalle(over: Record<string, unknown> = {}) {
  return fila({
    estado: 'rechazada',
    propietarioCanal: {
      tipoDocumento: TIPO_DOC, nombres: 'MARÍA FERNANDA', apellidos: 'GÓMEZ RUIZ', razonSocial: null,
      numeroDocumento: NUMERO_DOC, correo: CORREO, celular: '3001234567',
      direccion: 'Calle 1 # 2-3', municipio: 'Medellín', departamento: 'Antioquia',
    },
    ...over,
  });
}

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mockCola(page: Page, items: unknown[] = []) {
  const estado = { items };
  await page.route(RE_COLA, (route) => json(route, 200, {
    items: estado.items, total: estado.items.length, page: 1, pageSize: 50,
  }));
  await page.route(/\/api\/flito\/soat\/facetas/, (route) =>
    json(route, 200, { companias: [], organismos: [], proveedores: [] }));
  return estado;
}

/**
 * El fallo del canal. **El `codigo` es su verdadero discriminador y el `error` es texto para una
 * persona**, así que los tests lo usan para mentir a propósito.
 */
const fallo = (status: number, codigo: string, error: string, extra: Record<string, unknown> = {}) =>
  ({ status, cuerpo: { error, codigo, ...extra } });

type Respuesta = { status: number; cuerpo: unknown };

/**
 * Intercepta los dos endpoints del canal y CUENTA las peticiones.
 *
 * Contar es la mitad del valor: «no se envió nada» es lo único que mata al mutante que quita la
 * compuerta y se confía en el 4xx del servidor.
 */
async function mockCanal(
  page: Page,
  opciones: { alta?: Respuesta; preconsulta?: Respuesta; retenerPreconsulta?: boolean } = {},
) {
  const altas: { url: string; method: string; post: string | null }[] = [];
  const preconsultas: { post: string | null }[] = [];
  /**
   * Compuerta para dejar la preconsulta **en vuelo** el tiempo que haga falta. Es una promesa que el
   * test libera a mano —y no un `waitForTimeout` a ciegas—: la carrera se provoca en el instante
   * exacto en que el test quiere, no se espera a que el reloj la conceda.
   */
  let abrir: () => void = () => {};
  const enVuelo = new Promise<void>((resolver) => { abrir = () => resolver(); });
  await page.route(RE_ALTA, (route) => {
    altas.push({ url: route.request().url(), method: route.request().method(), post: route.request().postData() });
    return opciones.alta
      ? json(route, opciones.alta.status, opciones.alta.cuerpo)
      : json(route, 201, { id: UUID_RECHAZADA, estado: 'pendiente_revision' });
  });
  await page.route(RE_PRECONSULTA, async (route) => {
    preconsultas.push({ post: route.request().postData() });
    if (opciones.retenerPreconsulta) await enVuelo;
    return opciones.preconsulta
      ? json(route, opciones.preconsulta.status, opciones.preconsulta.cuerpo)
      : json(route, 200, RUNT_OK);
  });
  return { altas, preconsultas, liberarPreconsulta: () => abrir() };
}

const btnConsultar = (page: Page) => page.getByRole('button', { name: 'Consultar el RUNT' });
const btnReconsultar = (page: Page) => page.getByRole('button', { name: 'Volver a consultar' });
const btnEnviar = (page: Page) => page.getByRole('button', { name: 'Enviar la solicitud' });
const fichaRunt = (page: Page) => page.getByRole('region', { name: 'Datos del RUNT' });

/** Los cuatro identificadores del bloque 1. El VIN es opcional y por eso se pide explícitamente. */
async function llenarVehiculo(page: Page, { vin = '' } = {}) {
  await page.getByLabel('Placa').fill(PLACA);
  await page.getByLabel('Tipo de documento').selectOption(TIPO_DOC);
  await page.getByLabel('Número de documento').fill(NUMERO_DOC);
  if (vin) await page.getByLabel('VIN').fill(vin);
}

/** El propietario del bloque 2, en su forma de persona natural. */
async function llenarPropietario(page: Page, { nombres = 'MARÍA FERNANDA', apellidos = 'GÓMEZ RUIZ', municipio = 'Medellín' } = {}) {
  if (nombres) await page.getByLabel('Nombre/s').fill(nombres);
  if (apellidos) await page.getByLabel('Apellido/s').fill(apellidos);
  await page.getByLabel('Correo electrónico').fill(CORREO);
  await page.getByLabel('Celular').fill('3001234567');
  await page.getByLabel('Dirección').fill('Calle 1 # 2-3');
  if (municipio) await page.getByLabel('Municipio').fill(municipio);
  await page.getByLabel('Departamento').fill('Antioquia');
}

async function adjuntarFactura(page: Page) {
  await page.locator('input[type="file"]').setInputFiles({
    name: 'factura.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 e2e'),
  });
}

/** Alta completa y consultada: el estado desde el que se puede enviar. */
async function llenarTodoYConsultar(page: Page, opciones: { vin?: string } = {}) {
  await llenarVehiculo(page, opciones);
  await llenarPropietario(page);
  await adjuntarFactura(page);
  await btnConsultar(page).click();
  await expect(fichaRunt(page)).toBeVisible();
}

// ═════════════════════════ AC1 · la compuerta y el orden de entrada ══════════════════════════════

test.describe('HU #11967 · AC1 — el RUNT es compuerta del envío', () => {
  test('al abrir: hay «Consultar el RUNT» y «Enviar la solicitud» está aria-disabled y NO disabled', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    const cap = await mockCanal(page);
    await page.goto('/flito/soat/solicitud');

    await expect(btnConsultar(page)).toBeVisible();
    const enviar = btnEnviar(page);
    await expect(enviar).toHaveAttribute('aria-disabled', 'true');
    // Y **sin `disabled` nativo**, que es la decisión de accesibilidad de la HU. Los dos asertos
    // hacen falta y ninguno sobra: `toBeEnabled()`/`toBeDisabled()` NO sirven aquí porque para
    // Playwright `aria-disabled="true"` ya cuenta como deshabilitado, así que no distinguen las dos
    // implementaciones. Lo que las distingue es el atributo nativo —ausente— y el recorrido de
    // tabulación de las dos líneas siguientes, que un `disabled` rompería.
    expect(await enviar.getAttribute('disabled')).toBeNull();
    const cancelar = page.getByRole('button', { name: 'Cancelar' });
    await cancelar.focus();
    await page.keyboard.press('Tab');
    await expect(enviar).toBeFocused();
    await expect(page.getByText('Consulte el RUNT antes de enviar.')).toBeVisible();

    await llenarVehiculo(page);
    await llenarPropietario(page);
    await adjuntarFactura(page);
    // Se pulsa con el TECLADO, y no con `enviar.click()`, por lo mismo: la actionability de
    // Playwright espera a que el elemento esté «enabled» y con `aria-disabled` se agotaría el
    // tiempo sin llegar a pulsarlo nunca. El `Enter` sobre un `<button>` enfocado dispara el mismo
    // `click`, y además es el camino que esta decisión de diseño existe para preservar.
    await cancelar.focus();
    await page.keyboard.press('Tab');
    await expect(enviar).toBeFocused();
    await page.keyboard.press('Enter');

    expect(cap.altas).toHaveLength(0);
    // Y lleva a la acción que sí toca, en vez de dejar al usuario sin saber qué falta.
    await expect(btnConsultar(page)).toBeFocused();
  });

  test('el orden de entrada es placa, tipo, número y VIN, y nada del RUNT se teclea', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await mockCanal(page);
    await page.goto('/flito/soat/solicitud');

    await expect(page.getByRole('heading', { name: 'Solicitud de SOAT' })).toBeFocused();
    for (const etiqueta of ['Placa', 'Tipo de documento', 'Número de documento', 'VIN']) {
      await page.keyboard.press('Tab');
      await expect(page.getByLabel(etiqueta)).toBeFocused();
    }
    await page.keyboard.press('Tab');
    await expect(btnConsultar(page)).toBeFocused();

    // Marca, línea, modelo y organismo no se teclean. Los DOS asertos hacen falta: un
    // `<input disabled>` conserva el rol `textbox` en varios motores, así que el primero solo no
    // mata al mutante que «resuelve» los datos del RUNT con campos deshabilitados.
    await expect(page.getByRole('textbox', { name: /Marca|Línea|Modelo|Organismo/ })).toHaveCount(0);
    await expect(page.locator('input[disabled]')).toHaveCount(0);
  });

  test('una consulta 200 abre la compuerta, trae la ficha y NO enseña el VIN del RUNT', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    const cap = await mockCanal(page);
    await page.goto('/flito/soat/solicitud');
    await llenarVehiculo(page);
    await btnConsultar(page).click();

    await expect(page.getByText('✓ Consultado')).toBeVisible();
    const ficha = fichaRunt(page);
    await expect(ficha.getByText('RENAULT')).toBeVisible();
    await expect(ficha.getByText('SEDAN')).toBeVisible();
    await expect(ficha.getByText('STRIA TTEyTTO MEDELLIN')).toBeVisible();
    // Ni el VIN que trajo el RUNT ni la placa entran a la ficha en el alta.
    await expect(ficha.getByText(VIN)).toHaveCount(0);
    // Los datos del archivo de Operaciones no se pintan: no ayudan a reconocer el vehículo.
    await expect(ficha.getByText(/Pasajeros|Puertas/)).toHaveCount(0);
    await expect(btnEnviar(page)).not.toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByRole('button', { name: 'Consultar de nuevo' })).toBeVisible();
    expect(cap.preconsultas).toHaveLength(1);
  });

  test('el VIN es opcional: sin escribirlo se envía, y la clave `vin` no viaja', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    const cola = await mockCola(page);
    const cap = await mockCanal(page);
    await page.goto('/flito/soat/solicitud');
    await llenarTodoYConsultar(page);

    cola.items = [fila()];
    await btnEnviar(page).click();

    await expect(page).toHaveURL(/\/flito\/soat$/);
    await expect(page.getByText('Solicitud enviada. FLITO la va a revisar.')).toBeVisible();
    expect(cap.altas).toHaveLength(1);
    // Ni en la consulta ni en el alta viaja `vin: ''`: la clave se OMITE. Mandarla vacía es un 400
    // del servidor que el Cliente no sabría explicarse.
    expect(cap.preconsultas[0].post ?? '').not.toContain('"vin"');
    expect(cap.altas[0].post ?? '').not.toContain('name="vin"');
    expect(cap.altas[0].post ?? '').toContain('name="placa"');
  });

  test('la transición: cambiar UN carácter de la placa retira la ficha y cierra la compuerta', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await mockCanal(page);
    await page.goto('/flito/soat/solicitud');
    await llenarTodoYConsultar(page);

    await page.getByLabel('Placa').fill('ABC124');

    await expect(fichaRunt(page)).toHaveCount(0);
    await expect(page.getByText('✓ Consultado')).toHaveCount(0);
    await expect(btnEnviar(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByText('Cambió la placa o el documento: vuelva a consultar el RUNT antes de enviar.')).toBeVisible();
    await expect(btnReconsultar(page)).toBeVisible();
    // Y lo que escribió el Cliente NO se toca: castigar al que corrige una letra es el otro mutante.
    await expect(page.getByLabel('Correo electrónico')).toHaveValue(CORREO);
    await expect(page.getByLabel('Municipio')).toHaveValue('Medellín');
    await expect(page.getByText('factura.pdf', { exact: false })).toBeVisible();
  });

  test('la transición también la dispara el TIPO de documento, que es el que se olvida', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await mockCanal(page);
    await page.goto('/flito/soat/solicitud');
    await llenarTodoYConsultar(page);

    await page.getByLabel('Tipo de documento').selectOption('CE');

    await expect(fichaRunt(page)).toHaveCount(0);
    await expect(btnEnviar(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByText('Cambió la placa o el documento: vuelva a consultar el RUNT antes de enviar.')).toBeVisible();
    await expect(page.getByLabel('Correo electrónico')).toHaveValue(CORREO);
  });

  test('la CARRERA: cambiar el tipo con la consulta EN VUELO tira la respuesta que llega tarde', async ({ page }) => {
    // El otro test de transición cambia la placa DESPUÉS de que la respuesta aterrizó: eso prueba la
    // invalidación, no la carrera. Aquí el identificador se cambia con la consulta todavía en el
    // aire, que es el único camino conocido para radicar una solicitud cuyo RUNT no corresponde a lo
    // enviado: la respuesta vieja llega tarde, pinta la ficha de OTRO vehículo y deja la compuerta
    // abierta. Lo que lo impide es `turno`; sin él, este test se pone rojo.
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    const cap = await mockCanal(page, { retenerPreconsulta: true });
    await page.goto('/flito/soat/solicitud');
    await llenarVehiculo(page);
    await llenarPropietario(page);
    await adjuntarFactura(page);

    await btnConsultar(page).click();
    await expect(page.getByRole('button', { name: 'Consultando el RUNT…' })).toBeVisible();
    await expect(page.getByText('La consulta puede tardar hasta un minuto. No cierre esta página.')).toBeVisible();
    expect(cap.preconsultas).toHaveLength(1);

    // La ventana de la carrera EXISTE porque los campos no se deshabilitan mientras se consulta
    // —perderían el foco—, y el `<select>` del tipo de documento ni siquiera puede ser `readOnly`.
    // El aserto no sobra: el día que alguien lo bloquee, este test dejaría de provocar la carrera y
    // seguiría verde sin comprobar nada. Y el tipo es, además, el identificador que más se olvida.
    const tipo = page.getByLabel('Tipo de documento');
    await expect(tipo).toBeEnabled();
    await tipo.selectOption('CE');
    await expect(page.getByText('Cambió la placa o el documento: vuelva a consultar el RUNT antes de enviar.')).toBeVisible();

    // Solo AHORA contesta el RUNT: es la respuesta de la pregunta que se hizo con el documento viejo.
    const respuestaTardia = page.waitForResponse((r) => RE_PRECONSULTA.test(r.url()));
    cap.liberarPreconsulta();
    await respuestaTardia;
    // La respuesta ya está en el navegador. Se le deja terminar el viaje —leer el cuerpo, resolver la
    // promesa de `api.post` y repintar— antes de exigir que no haya cambiado nada: sin esta espera, el
    // aserto negativo pasaría por llegar ANTES que el fallo y no por ausencia de fallo. Medido: con
    // `turno.current += 1` fuera de `invalidarConsulta`, aquí ya está pintada la ficha.
    await page.waitForTimeout(500);

    await expect(fichaRunt(page)).toHaveCount(0);
    await expect(page.getByText('✓ Consultado')).toHaveCount(0);
    await expect(btnEnviar(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(btnReconsultar(page)).toBeVisible();
    expect(cap.preconsultas).toHaveLength(1);

    // Y la compuerta aguanta con el formulario entero lleno: pulsar «Enviar la solicitud» —con el
    // teclado, que es como se puede pulsar un `aria-disabled`— no radica nada.
    const cancelar = page.getByRole('button', { name: 'Cancelar' });
    await cancelar.focus();
    await page.keyboard.press('Tab');
    await expect(btnEnviar(page)).toBeFocused();
    await page.keyboard.press('Enter');
    expect(cap.altas).toHaveLength(0);
  });

  test('un desenlace que llega en el ENVÍO también invalida el «✓ Consultado»', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    // El RUNT dijo que sí en la consulta y se cayó entre medias: el alta vuelve a consultarlo.
    await mockCanal(page, { alta: fallo(503, 'runt_no_disponible', 'No fue posible consultar el RUNT.') });
    await page.goto('/flito/soat/solicitud');
    await llenarTodoYConsultar(page);

    await btnEnviar(page).click();

    await expect(fichaRunt(page)).toHaveCount(0);
    await expect(btnEnviar(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByRole('alert')).toContainText('El RUNT no está disponible, vuelva a consultar');
  });
});

// ═════════════════════════ AC2 · SOAT vigente ════════════════════════════════════════════════════

test.describe('HU #11967 · AC2 — el vehículo ya tiene SOAT vigente', () => {
  test('409 en la consulta: modal, cero altas, y sin fecha no se escribe «hasta el»', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    const cap = await mockCanal(page, {
      preconsulta: fallo(409, 'soat_vigente', 'El RUNT reporta que este vehículo ya tiene un SOAT vigente.'),
    });
    await page.goto('/flito/soat/solicitud');
    await llenarVehiculo(page);
    await btnConsultar(page).click();

    const modal = page.getByRole('dialog', { name: 'Este vehículo ya tiene SOAT vigente' });
    await expect(modal).toBeVisible();
    await expect(modal.getByText('No hace falta comprar otro')).toBeVisible();
    // Sin `fechaVencimiento` el modal CAMBIA de frase; no interpola un hueco.
    await expect(modal.getByText(/hasta el/)).toHaveCount(0);
    await expect(modal.getByText('—')).toHaveCount(0);
    expect(cap.altas).toHaveLength(0);
  });

  test('con fecha, el modal la escribe; y al cerrarlo la compuerta sigue cerrada y lo dice', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await mockCanal(page, {
      preconsulta: fallo(409, 'soat_vigente', 'Ya tiene SOAT vigente.', { fechaVencimiento: '2027-02-01' }),
    });
    await page.goto('/flito/soat/solicitud');
    await llenarVehiculo(page);
    await btnConsultar(page).click();

    const modal = page.getByRole('dialog', { name: 'Este vehículo ya tiene SOAT vigente' });
    await expect(modal.getByText(/vigente hasta el 1 de febrero de 2027/)).toBeVisible();
    await modal.getByRole('button', { name: 'Cerrar' }).click();

    await expect(btnEnviar(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByText('Este vehículo tiene SOAT vigente según el RUNT: no se puede radicar la solicitud.')).toBeVisible();
    await expect(btnReconsultar(page)).toBeVisible();
  });

  test('«Consultar otro vehículo» limpia los CUATRO identificadores y conserva el propietario', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await mockCanal(page, { preconsulta: fallo(409, 'soat_vigente', 'Ya tiene SOAT vigente.') });
    await page.goto('/flito/soat/solicitud');
    await llenarVehiculo(page, { vin: VIN });
    await llenarPropietario(page);
    await adjuntarFactura(page);
    await btnConsultar(page).click();

    await page.getByRole('dialog').getByRole('button', { name: 'Consultar otro vehículo' }).click();

    await expect(page.getByLabel('Placa')).toHaveValue('');
    await expect(page.getByLabel('VIN')).toHaveValue('');
    await expect(page.getByLabel('Tipo de documento')).toHaveValue('');
    await expect(page.getByLabel('Número de documento')).toHaveValue('');
    await expect(page.getByLabel('Correo electrónico')).toHaveValue(CORREO);
    await expect(page.getByLabel('Nombre/s')).toHaveValue('MARÍA FERNANDA');
    await expect(page.getByText('factura.pdf', { exact: false })).toBeVisible();
    // El foco no se cae a `<body>` al desaparecer el botón que abrió el modal.
    await expect(page.getByLabel('Placa')).toBeFocused();
    await expect(btnConsultar(page)).toBeVisible();
  });
});

// ═════════════════════════ AC3 · «revise los datos» ≠ «el RUNT no está disponible» ═══════════════

test.describe('HU #11967 · AC3 — los desenlaces se distinguen por CÓDIGO', () => {
  /** Consulta con la respuesta pedida y devuelve la banda. */
  async function consultarCon(page: Page, respuesta: Respuesta) {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await mockCanal(page, { preconsulta: respuesta });
    await page.goto('/flito/soat/solicitud');
    await llenarVehiculo(page);
    await btnConsultar(page).click();
    return page.getByRole('alert');
  }

  test('503: «no está disponible», y NO «Revise los datos» — aunque el mensaje del servidor mienta', async ({ page }) => {
    // El texto dice una cosa y el código dice otra. Manda el código.
    const banda = await consultarCon(page, fallo(503, 'runt_no_disponible', 'Los datos no corresponden: revise los datos.'));

    await expect(banda).toContainText('El RUNT no está disponible, vuelva a consultar');
    await expect(page.getByText(/Revise los datos/)).toHaveCount(0);
    await expect(btnReconsultar(page)).toBeVisible();
    await expect(btnEnviar(page)).toHaveAttribute('aria-disabled', 'true');
  });

  test('422 runt_no_cuadra: «Revise los datos», y NO «no está disponible»', async ({ page }) => {
    const banda = await consultarCon(page, fallo(422, 'runt_no_cuadra', 'El RUNT no está disponible en este momento.'));

    await expect(banda).toContainText('Revise los datos: el RUNT no encuentra ese vehículo a nombre de ese documento.');
    await expect(page.getByText(/no está disponible/)).toHaveCount(0);
  });

  test('los tres de la familia «revise los datos» dicen cosas DISTINTAS entre sí', async ({ page }) => {
    const banda = await consultarCon(page, fallo(422, 'runt_sin_registro', 'Revisa los datos.'));
    await expect(banda).toContainText('el RUNT no tiene ningún vehículo registrado con esa placa');

    // `runt_sin_vin` no es «revise los datos»: no hay nada que el Cliente pueda corregir, y por eso
    // su copy no le empuja a reintentar.
    await page.unroute(RE_PRECONSULTA);
    await mockCanal(page, { preconsulta: fallo(422, 'runt_sin_vin', 'Revisa los datos.') });
    await btnReconsultar(page).click();
    await expect(page.getByRole('alert')).toContainText('El RUNT no publica el número de chasis (VIN) de este vehículo');
    await expect(page.getByText(/Revise los datos/)).toHaveCount(0);
  });

  test('422 con campo VIN: el campo queda inválido y ENFOCADO, y la banda no dice cuál era el bueno', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await mockCanal(page, { preconsulta: fallo(422, 'runt_no_cuadra', 'El VIN no corresponde.', { campo: 'vin' }) });
    await page.goto('/flito/soat/solicitud');
    await llenarVehiculo(page, { vin: '9BWZZZ377VT000000' });
    await btnConsultar(page).click();

    const campoVin = page.getByLabel('VIN');
    await expect(campoVin).toHaveAttribute('aria-invalid', 'true');
    await expect(campoVin).toBeFocused();
    const banda = page.getByRole('alert');
    await expect(banda).toContainText('el VIN que escribió no es el que el RUNT tiene para esa placa');
    await expect(banda).toContainText('déjelo vacío');
    // La fuga que nadie debe «mejorar»: el VIN del registro no se enseña en ninguna parte.
    await expect(banda).not.toContainText(VIN);
  });

  test('un código DESCONOCIDO o retirado no deja la pantalla muda: banda genérica y reintento', async ({ page }) => {
    // `organismo_no_catalogado` se retiró de los dos endpoints en la #11966; una API desfasada en
    // DEV lo sigue sirviendo, y en DEV el merge ES el deploy.
    const banda = await consultarCon(page, fallo(422, 'organismo_no_catalogado', 'El organismo de tránsito no está en el catálogo de FLITO.'));

    await expect(banda).toContainText('El organismo de tránsito no está en el catálogo de FLITO.');
    await expect(btnReconsultar(page)).toBeVisible();
    await expect(btnEnviar(page)).toHaveAttribute('aria-disabled', 'true');
  });
});

// ═════════════════════════ AC4 · el propietario, partido y completo ══════════════════════════════

test.describe('HU #11967 · AC4 — nombre partido por tipo de documento', () => {
  test('conmutar CC ⇄ NIT monta y desmonta controles SIN perder lo escrito', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await mockCanal(page);
    await page.goto('/flito/soat/solicitud');

    await page.getByLabel('Tipo de documento').selectOption(TIPO_DOC);
    await page.getByLabel('Nombre/s').fill('MARÍA FERNANDA');
    await page.getByLabel('Apellido/s').fill('GÓMEZ RUIZ');

    await page.getByLabel('Tipo de documento').selectOption('NIT');
    await expect(page.getByLabel('Nombre/s')).toHaveCount(0);
    await expect(page.getByLabel('Apellido/s')).toHaveCount(0);
    await expect(page.getByLabel('Razón social')).toBeVisible();
    await page.getByLabel('Razón social').fill('TRANSPORTES X SAS');

    await page.getByLabel('Tipo de documento').selectOption(TIPO_DOC);
    await expect(page.getByLabel('Razón social')).toHaveCount(0);
    await expect(page.getByLabel('Nombre/s')).toHaveValue('MARÍA FERNANDA');
    await expect(page.getByLabel('Apellido/s')).toHaveValue('GÓMEZ RUIZ');
  });

  test('con NIT viaja la razón social, y no viajan nombres, apellidos ni nombreCompleto', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    const cola = await mockCola(page);
    const cap = await mockCanal(page);
    await page.goto('/flito/soat/solicitud');

    await page.getByLabel('Placa').fill(PLACA);
    await page.getByLabel('Tipo de documento').selectOption(TIPO_DOC);
    await page.getByLabel('Nombre/s').fill('MARÍA FERNANDA');
    await page.getByLabel('Tipo de documento').selectOption('NIT');
    await page.getByLabel('Número de documento').fill('9001234561');
    await page.getByLabel('Razón social').fill('TRANSPORTES X SAS');
    await llenarPropietario(page, { nombres: '', apellidos: '' });
    await adjuntarFactura(page);
    await btnConsultar(page).click();
    await expect(fichaRunt(page)).toBeVisible();

    cola.items = [fila()];
    await btnEnviar(page).click();
    await expect(page).toHaveURL(/\/flito\/soat$/);

    const cuerpo = cap.altas[0].post ?? '';
    expect(cuerpo).toContain('name="razonSocial"');
    expect(cuerpo).toContain('TRANSPORTES X SAS');
    expect(cuerpo).not.toContain('name="nombres"');
    expect(cuerpo).not.toContain('name="apellidos"');
    expect(cuerpo).not.toContain('name="nombreCompleto"');
    expect(cuerpo).toContain('name="municipio"');
    expect(cuerpo).toContain('name="departamento"');
  });

  test('enviar sin municipio lo marca, lo enfoca y no manda nada', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    const cap = await mockCanal(page);
    await page.goto('/flito/soat/solicitud');
    await llenarVehiculo(page);
    await llenarPropietario(page, { municipio: '' });
    await adjuntarFactura(page);
    await btnConsultar(page).click();
    await expect(fichaRunt(page)).toBeVisible();

    await btnEnviar(page).click();

    const municipio = page.getByLabel('Municipio');
    await expect(municipio).toBeFocused();
    await expect(municipio).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('alert').filter({ hasText: 'Escriba el municipio del propietario.' })).toBeVisible();
    expect(cap.altas).toHaveLength(0);
  });

  test('el propietario del RUNT se enseña como REFERENCIA y no prellena ningún campo', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await mockCanal(page, {
      preconsulta: { status: 200, cuerpo: { ...RUNT_OK, propietario: { nombreCompleto: 'MARÍA FERNANDA GÓMEZ RUIZ' } } },
    });
    await page.goto('/flito/soat/solicitud');
    await llenarVehiculo(page);
    await btnConsultar(page).click();
    await expect(fichaRunt(page)).toBeVisible();

    await expect(page.getByText('El RUNT reporta como propietario: MARÍA FERNANDA GÓMEZ RUIZ. Escríbalo como aparece en la factura de venta.')).toBeVisible();
    // Partir el nombre por el espacio es la heurística que el backend rechaza por escrito.
    await expect(page.getByLabel('Nombre/s')).toHaveValue('');
    await expect(page.getByLabel('Apellido/s')).toHaveValue('');
  });
});

// ═════════════════════════ AC5 · RN-01 y la subsanación ══════════════════════════════════════════

test.describe('HU #11967 · AC5 — el VIN ya en cola y la solicitud rechazada', () => {
  test('propia y rechazada: modal RN-01, «Abrir la solicitud rechazada» y URL sin PII', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await page.route(RE_DETALLE, (route) => json(route, 200, detalle()));
    await mockCanal(page, {
      preconsulta: fallo(409, 'vin_ya_tiene_soat', 'Esta solicitud ya existe y fue rechazada.', {
        propia: true, id: UUID_RECHAZADA, estado: 'rechazada',
      }),
    });

    await page.goto('/flito/soat/solicitud');
    await llenarVehiculo(page, { vin: VIN });
    await btnConsultar(page).click();

    const modal = page.getByRole('dialog', { name: 'Ese vehículo ya está en la cola de FLITO' });
    await expect(modal).toBeVisible();
    await modal.getByRole('link', { name: 'Abrir la solicitud rechazada' }).click();

    await expect(page).toHaveURL(new RegExp(`/flito/soat/solicitud/${UUID_RECHAZADA}$`));
    expect(page.url()).not.toContain(PLACA);
    expect(page.url()).not.toContain(VIN);
  });

  test('AJENA: sin botón primario, sin estado y sin fecha', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await mockCanal(page, {
      alta: fallo(409, 'vin_ya_tiene_soat', 'Este vehículo ya está registrado en FLITO con un SOAT.', { propia: false }),
    });

    await page.goto('/flito/soat/solicitud');
    await llenarTodoYConsultar(page, { vin: VIN });
    await btnEnviar(page).click();

    const modal = page.getByRole('dialog', { name: 'Ese vehículo ya está en la cola de FLITO' });
    await expect(modal.getByText('Escríbale a su contacto en FLIT si cree que es un error.')).toBeVisible();
    await expect(modal.getByRole('link', { name: 'Abrir la solicitud rechazada' })).toHaveCount(0);
    await expect(modal.getByRole('link', { name: 'Ver la solicitud' })).toHaveCount(0);
    await expect(modal.getByText(/Rechazada|Pendiente|Solicitado|Pagado|novedad/)).toHaveCount(0);
    await expect(modal.getByText(/\d{1,2}\/\d{1,2}\/\d{2,4}/)).toHaveCount(0);
  });

  test('subsanar: sin «Consultar el RUNT», con lo guardado ya escrito y PATCH con el nombre partido', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await page.route(RE_DETALLE, (route) => (route.request().method() === 'GET'
      ? json(route, 200, detalle())
      : route.fallback()));
    const patches: { post: string | null }[] = [];
    await page.route(RE_SUBSANAR, (route) => {
      patches.push({ post: route.request().postData() });
      return json(route, 200, { id: UUID_RECHAZADA, estado: 'pendiente_revision' });
    });
    const cap = await mockCanal(page);

    await page.goto(`/flito/soat/solicitud/${UUID_RECHAZADA}`);
    await expect(page.getByRole('button', { name: /Consultar el RUNT|Volver a consultar/ })).toHaveCount(0);
    // Lo guardado no se vuelve a teclear a ciegas.
    await expect(page.getByLabel('Nombre/s')).toHaveValue('MARÍA FERNANDA');
    await expect(page.getByLabel('Apellido/s')).toHaveValue('GÓMEZ RUIZ');
    await expect(page.getByLabel('Municipio')).toHaveValue('Medellín');
    await expect(page.getByLabel('Departamento')).toHaveValue('Antioquia');
    // Y aquí la placa y el VIN SÍ están en la ficha: son lo persistido, no el eco de una consulta.
    await expect(fichaRunt(page).getByText(VIN, { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Reenviar la solicitud' }).click();

    await expect.poll(() => patches.length).toBe(1);
    expect(cap.preconsultas).toHaveLength(0);
    const cuerpo = patches[0].post ?? '';
    expect(cuerpo).toContain('name="nombres"');
    expect(cuerpo).toContain('name="departamento"');
    expect(cuerpo).not.toContain('name="nombreCompleto"');
    await expect(page.getByText('Solicitud enviada. FLITO la va a revisar.')).toBeVisible();
  });

  test('sin el titular guardado, la subsanación lo dice en vez de fingir que lo sabe', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await page.route(RE_DETALLE, (route) => json(route, 200, fila({ estado: 'rechazada' })));

    await page.goto(`/flito/soat/solicitud/${UUID_RECHAZADA}`);
    await expect(page.getByText('Complete los datos del propietario para poder reenviar la solicitud.')).toBeVisible();
    // El nombre fundido de `compradores` NO se reparte por el espacio.
    await expect(page.getByLabel('Nombre/s')).toHaveValue('');
    await expect(page.getByLabel('Apellido/s')).toHaveValue('');
    await expect(page.getByLabel('Número de documento')).toHaveValue(NUMERO_DOC);
  });

  test('desde la cola: la pastilla «Rechazada» existe y su detalle no filtra la trastienda', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page, [fila({ estado: 'rechazada' })]);

    await page.goto('/flito/soat');
    await expect(page.getByRole('button', { name: 'Pendiente de revisión' })).toBeVisible();
    await page.getByRole('button', { name: 'Rechazada', exact: true }).click();

    await page.getByRole('button', { name: 'Ver' }).first().click();
    const detalleModal = page.getByRole('dialog');
    await expect(detalleModal).toBeVisible();
    await expect(detalleModal.getByText(/Gestiona|Enviado por|Valor pagado/)).toHaveCount(0);
    await expect(detalleModal.getByRole('button', { name: 'Ver el historial de estados' })).toHaveCount(0);
  });

  test('el historial SIGUE estando para Operaciones', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page, [fila({ estado: 'rechazada' })]);

    await page.goto('/flito/soat');
    await page.getByRole('button', { name: 'Ver' }).first().click();
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Ver el historial de estados' })).toBeVisible();
  });
});

// ═════════════════════════ Canal apagado, PDF, red y salida ══════════════════════════════════════

test.describe('HU #11967 — el canal, el adjunto y las salidas', () => {
  test('la cola vacía del Cliente ya no le manda al Tablero, que no tiene', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);

    await page.goto('/flito/soat');
    await expect(page.getByText('Todavía no hay ningún SOAT de su compañía en FLITO.')).toBeVisible();
    await expect(page.getByText(/Sincroniza desde el Tablero/)).toHaveCount(0);
  });

  test('«Solicitar SOAT» lleva a la sub-ruta y el menú sigue teniendo UN ítem, marcado', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page, [fila()]);

    await page.goto('/flito/soat');
    const enlace = page.getByRole('link', { name: 'Solicitar SOAT' });
    await expect(enlace).toHaveAttribute('href', '/flito/soat/solicitud');
    await enlace.click();
    await expect(page).toHaveURL(/\/flito\/soat\/solicitud$/);

    const nav = page.getByRole('navigation', { name: 'Navegación principal' });
    await expect(nav.getByRole('link')).toHaveCount(1);
    await expect(nav.getByRole('link', { name: 'SOAT' })).toHaveAttribute('aria-current', 'page');
  });

  test('sin el flag no hay botón, hay tarjeta neutra, y la URL directa no dice «No tienes acceso»', async ({ page }) => {
    await loginAs(page, CLIENTE_USER);
    await mockCola(page, [fila()]);

    await page.goto('/flito/soat');
    await expect(page.getByRole('link', { name: 'Solicitar SOAT' })).toHaveCount(0);
    await expect(page.getByText('Su compañía todavía no tiene habilitado este canal, así que por ahora aquí solo puede consultar sus SOAT.')).toBeVisible();

    await page.goto('/flito/soat/solicitud');
    await expect(page.getByText('Su compañía todavía no tiene habilitado este canal, así que por ahora aquí solo puede consultar sus SOAT.')).toBeVisible();
    await expect(page.getByText(/No tienes acceso/)).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Volver a mis SOAT' })).toBeVisible();
  });

  test('la carrera: /me dice que sí y el POST responde 403 → «no se envió nada»', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await mockCanal(page, {
      alta: fallo(403, 'canal_desactivado', 'Tu compañía no tiene habilitada la solicitud de SOAT sin trámite.'),
    });
    await page.goto('/flito/soat/solicitud');
    await llenarTodoYConsultar(page);
    await btnEnviar(page).click();

    await expect(page.getByText('El canal se deshabilitó mientras llenaba el formulario, así que no se envió nada.')).toBeVisible();
    await expect(btnEnviar(page)).toHaveCount(0);
  });

  test('un PDF que no lo es: la caja queda rechazada y dice POR QUÉ', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await mockCanal(page, { alta: fallo(400, 'archivo_no_pdf', 'La factura de venta debe ser un PDF.') });
    await page.goto('/flito/soat/solicitud');
    await llenarTodoYConsultar(page);
    await btnEnviar(page).click();

    await expect(page.getByRole('alert')
      .filter({ hasText: 'Ese archivo no es un PDF válido, aunque se llame así.' })).toBeVisible();
    await expect(page.getByText('Rechazado — cargar otro')).toBeVisible();
  });

  test('si el envío se corta, se dice que NO se sabe si llegó — y dónde mirar', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await mockCanal(page);
    await page.goto('/flito/soat/solicitud');
    await llenarTodoYConsultar(page);
    // Solo el ALTA se corta: la consulta ya resolvió.
    await page.unroute(RE_ALTA);
    await page.route(RE_ALTA, (route) => route.abort('connectionfailed'));
    await btnEnviar(page).click();

    await expect(page.getByText(`No sabemos si la solicitud llegó a FLITO. Vuelva a sus SOAT y busque la placa ${PLACA} antes de volver a enviarla.`)).toBeVisible();
    await expect(btnEnviar(page)).toHaveCount(0);
  });

  test('salir con datos escritos pide confirmación: no hay borradores que rescatar', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);

    await page.goto('/flito/soat/solicitud');
    await page.getByLabel('Placa').fill(PLACA);
    await page.getByRole('button', { name: '← Volver a mis SOAT' }).click();

    const dialogo = page.getByRole('dialog', { name: '¿Descartar la solicitud?' });
    await expect(dialogo.getByText('Lo que escribió no se guarda: no hay borradores.')).toBeVisible();
    await dialogo.getByRole('button', { name: 'Seguir llenando' }).click();
    await expect(page.getByLabel('Placa')).toHaveValue(PLACA);

    await page.getByRole('button', { name: '← Volver a mis SOAT' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Descartar' }).click();
    await expect(page).toHaveURL(/\/flito\/soat$/);
  });

  test('la PII viaja en el CUERPO y la URL no la toca en ningún punto del recorrido', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    const cola = await mockCola(page);
    const urls: string[] = [];
    page.on('framenavigated', () => urls.push(page.url()));

    const cap = await mockCanal(page);
    await page.goto('/flito/soat/solicitud');
    await llenarTodoYConsultar(page, { vin: VIN });
    cola.items = [fila()];
    await btnEnviar(page).click();
    await expect(page).toHaveURL(/\/flito\/soat$/);

    expect(cap.preconsultas).toHaveLength(1);
    expect(cap.altas).toHaveLength(1);
    expect(new URL(cap.altas[0].url).search).toBe('');
    expect(cap.altas[0].post ?? '').toContain(PLACA);
    expect(cap.altas[0].post ?? '').toContain(VIN);
    expect(cap.altas[0].post ?? '').toContain(NUMERO_DOC);
    expect(cap.altas[0].post ?? '').toContain(CORREO);
    for (const url of [...urls, page.url()]) {
      expect(url).not.toContain(PLACA);
      expect(url).not.toContain(VIN);
      expect(url).not.toContain(NUMERO_DOC);
      expect(url).not.toContain(CORREO);
    }
  });
});

// ═════════════════════════ Subsanación · los cuatro estados de la vista ══════════════════════════

test.describe('HU #11967 · /flito/soat/solicitud/:id', () => {
  test('una solicitud que ya no está rechazada NO monta el formulario', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await page.route(RE_DETALLE, (route) => json(route, 200, detalle({ estado: 'pendiente_revision' })));

    await page.goto(`/flito/soat/solicitud/${UUID_RECHAZADA}`);
    await expect(page.getByText('Esta solicitud ya no está rechazada: FLITO la está revisando. No hay nada que corregir por ahora.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reenviar la solicitud' })).toHaveCount(0);
  });

  test('404 — no existe o no es de su compañía, y hay salida', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await page.route(RE_DETALLE, (route) => json(route, 404, { error: 'El SOAT no existe' }));

    await page.goto(`/flito/soat/solicitud/${UUID_RECHAZADA}`);
    await expect(page.getByText('Esta solicitud no existe o no es de su compañía.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Volver a mis SOAT' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
  });

  test('un fallo de carga SÍ trae reintento, y el segundo intento pinta la solicitud', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    let carga: 'error' | 'ok' = 'error';
    await page.route(RE_DETALLE, (route) => (carga === 'error'
      ? json(route, 500, { error: 'Error del servidor' })
      : json(route, 200, detalle())));

    await page.goto(`/flito/soat/solicitud/${UUID_RECHAZADA}`);
    await expect(page.getByText('No pudimos cargar esta solicitud.')).toBeVisible();
    carga = 'ok';
    await page.getByRole('button', { name: 'Reintentar' }).click();

    await expect(page.getByRole('button', { name: 'Reenviar la solicitud' })).toBeVisible();
    const ficha = fichaRunt(page);
    await expect(ficha.getByText(PLACA, { exact: true })).toBeVisible();
    await expect(ficha.getByText(VIN, { exact: true })).toBeVisible();
  });
});

// ═════════════════ La ficha de ayuda in-app del módulo SOAT ══════════════════════════════════════
//
// El AC pide que «la ficha de ayuda in-app del módulo SOAT describa la consulta previa, el VIN
// opcional, el modal de vigente, el "revise los datos" y el propietario obligatorio partido».
//
// `flito-ayuda-fichas-gestion.spec.ts` NO lo cubre: comprueba estructura (los seis `h2`, la ruta
// `/flito/soat`, que no diga «Esta ficha está pendiente.»), y con esa vara la ficha podría seguir
// describiendo el comportamiento de la #11936 —sin «Consultar el RUNT» y sin modal— para siempre.
// Este test vive AQUÍ, en el spec de la HU que cambió la pantalla, porque es esta HU la que puede
// dejar la ficha mintiendo: quien vuelva a tocar el formulario corre este archivo.
//
// Se asserta sobre la ficha RENDERIZADA en `/flito/ayuda/soat` —no sobre el `.md` en disco— para
// probar que está publicada y visible, no solo que existe. Se abre con **Operaciones** y no con el
// Cliente porque `ayudaFlito.puedeVerEntradaAyuda` niega TODA ficha al rol `cliente`
// (Feature #11912, `user.role === 'cliente'` → `false`): el Cliente hace este trámite pero no lee la
// ayuda in-app; quien la lee es quien lo atiende.
test.describe('HU #11967 · la ficha de ayuda in-app del módulo SOAT', () => {
  test('la ficha describe la consulta previa, el VIN, el modal, el «Revise los datos» y el propietario partido', async ({ page }) => {
    // ── 1 · Lo que la pantalla dice HOY, leído del DOM ───────────────────────────────────────────
    // Los rótulos no se teclean en el test: se cogen de la pantalla y se le exigen luego a la ficha.
    // Así, el día que el botón cambie de texto, la ficha se pone roja sin que nadie se acuerde de ella.
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await mockCanal(page, {
      preconsulta: fallo(409, 'soat_vigente', 'El RUNT reporta que este vehículo ya tiene un SOAT vigente.'),
    });
    await page.goto('/flito/soat/solicitud');

    const rotuloConsulta = (await btnConsultar(page).innerText()).trim();
    const avisoCompuerta = (await page.getByText('Consulte el RUNT antes de enviar.').innerText()).trim();
    // El VIN se ofrece como opcional en la propia pantalla…
    await expect(page.getByText('Si lo deja vacío, FLITO usa el que traiga el RUNT.')).toBeVisible();
    // …y el propietario se parte por tipo de documento: razón social con NIT, nombre/s y apellido/s
    // en cualquier otro caso. Las dos formas se comprueban aquí para no exigirle a la ficha una
    // conducta que la pantalla no tenga.
    await llenarVehiculo(page);
    await page.getByLabel('Tipo de documento').selectOption('NIT');
    await expect(page.getByLabel('Razón social')).toBeVisible();
    await expect(page.getByLabel('Nombre/s')).toHaveCount(0);
    await page.getByLabel('Tipo de documento').selectOption(TIPO_DOC);
    await expect(page.getByLabel('Nombre/s')).toBeVisible();
    await expect(page.getByLabel('Razón social')).toHaveCount(0);

    await btnConsultar(page).click();
    const modal = page.getByRole('dialog');
    const tituloModal = (await modal.getByRole('heading').first().innerText()).trim();

    // ── 2 · La ficha PUBLICADA ───────────────────────────────────────────────────────────────────
    await loginAs(page, OPERACIONES_USER);
    await page.goto('/flito/ayuda/soat');
    const ficha = page.getByRole('article', { name: 'SOAT' });
    await expect(ficha).toBeVisible();
    await expect(page.getByText('Esta ficha está pendiente.')).toHaveCount(0);

    // Los tres rótulos, con el texto EXACTO que acaba de leerse de la pantalla.
    for (const literal of [rotuloConsulta, avisoCompuerta, tituloModal]) {
      await expect(ficha, literal).toContainText(literal);
    }

    // Y las cinco promesas del AC, cada una con las palabras con las que la ficha las explica.
    const promesas = [
      // La consulta previa es compuerta, y hay que repetirla si se toca un identificador.
      'Pulse Consultar el RUNT',
      'Volver a consultar',
      'No se radica una solicitud del canal SOAT sin trámite sin consultar antes el RUNT',
      // La subsanación es la excepción, y la ficha tiene que decirlo o el Cliente la buscará.
      'Tampoco aquí se pide Consultar el RUNT',
      // El VIN opcional.
      'el VIN es opcional',
      // El desenlace que no es del canal ni del servicio, sino de los datos.
      'Revise los datos',
      // El propietario, obligatorio entero y partido por tipo de documento.
      'complete el propietario, que ahora es obligatorio entero',
      'Si el tipo de documento es NIT, escriba la razón social; en cualquier otro caso, nombre/s y apellido/s por separado',
      'Correo, celular, dirección, municipio y departamento también son obligatorios',
    ];
    for (const frase of promesas) {
      await expect(ficha, frase).toContainText(frase);
    }
  });
});
