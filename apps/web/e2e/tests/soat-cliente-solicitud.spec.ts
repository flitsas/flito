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
// **HU #12079.** El circuito de revisión se retiró: ya no hay `pendiente_revision` ni `rechazada`
// que radicar, ni subsanación, ni `soat-revision-rechazo.spec.ts`. Lo que esta HU cambia aquí es de
// tres clases y se marca caso por caso: el RÓTULO del primario («Enviar al gestor»), el TOAST, y la
// frase de bloqueo, que pasa de «Consulte el RUNT antes de enviar.» a la enumeración de lo que
// falta. Lo NUEVO —la enumeración, el foco al primer campo pendiente, el modal de la ficha de la
// compañía y la inalcanzabilidad de lo retirado— vive en `soat-envio-directo-gestor.spec.ts`.
// La pantalla legada `/soat` y su «Verificar RUNT» viven en `rol-cliente-identidad.spec.ts`.
//
// **HU #12091.** El bloque 1 pasó a pedir un solo dato —el VIN— y la pantalla se reordenó
// (vehículo → factura → propietario). Lo que este archivo tenía sobre la PLACA como dato tecleado
// está INVERTIDO caso por caso, no borrado: los helpers, el orden de entrada, el «VIN opcional», la
// invalidación por documento y la frase de faltantes. Lo NUEVO —la ficha de once datos, los cuatro
// desenlaces con su copy y los bordes de longitud del VIN— vive en `soat-vin-unico-ficha-runt.spec.ts`.
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, CLIENTE_USER, CLIENTE_CON_CANAL, OPERACIONES_USER } from '../helpers/auth';

const PLACA = 'ABC123';
const VIN = '9BWZZZ377VT004251';
const TIPO_DOC = 'CC';
const NUMERO_DOC = '1020304050';
const CORREO = 'contacto@ejemplo.co';
/** El uuid de una fila cualquiera. Opaco: es lo único de la solicitud que la URL llega a tocar. */
const UUID_SOLICITUD = '11111111-2222-4333-8444-555555555555';

const RE_ALTA = /\/api\/flito\/soat\/cliente$/;
const RE_COLA = /\/api\/flito\/soat\?/;
const RE_PRECONSULTA = /\/api\/flito\/soat\/cliente\/preconsulta$/;
/**
 * **HU #12094.** El tercer endpoint del canal, y hace falta aquí aunque esta HU no sea la suya: desde
 * que adjuntar dispara la lectura sola, los ~30 casos de este archivo que llaman a `adjuntarFactura`
 * emitirían un `POST` que ningún `page.route` captura — es decir, contra el backend de verdad. Los
 * dos patrones vecinos van anclados con `$` y no lo cogen.
 */
const RE_LECTURA = /\/api\/flito\/soat\/cliente\/factura\/lectura$/;
const RE_DETALLE = /\/api\/flito\/soat\/[0-9a-f-]{36}$/;

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
    id: UUID_SOLICITUD, vin: VIN, placa: PLACA, marca: 'RENAULT', linea: 'LOGAN',
    cilindraje: '1600', carroceria: 'SEDAN', tipoServicio: 'Particular',
    // `solicitado` desde la HU #12079: una solicitud del canal nace ya en gestión.
    estado: 'solicitado', esMultiplePropietario: false, companiaNombre: 'Transportes Sur',
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

/**
 * El valor de un campo de TEXTO del multipart, leído del cuerpo crudo que Playwright captura
 * (HU #12094). Se mira lo que VIAJÓ, no lo que la pantalla creía estar mandando.
 */
function campoMultipart(cuerpo: string, nombre: string): string | null {
  const m = new RegExp(`name="${nombre}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`).exec(cuerpo);
  return m ? m[1] : null;
}

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
  opciones: {
    alta?: Respuesta; preconsulta?: Respuesta; retenerPreconsulta?: boolean;
    /** Por defecto, una lectura que no saca nada: los casos de este archivo teclean a mano. */
    lectura?: Respuesta;
  } = {},
) {
  const altas: { url: string; method: string; post: string | null }[] = [];
  const preconsultas: { post: string | null }[] = [];
  /** Se cuenta igual que las altas y las preconsultas: el contador es lo que mata «se lee dos veces». */
  const lecturas: { url: string; post: string | null }[] = [];
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
      : json(route, 201, { id: UUID_SOLICITUD, estado: 'solicitado' });
  });
  await page.route(RE_LECTURA, (route) => {
    lecturas.push({ url: route.request().url(), post: route.request().postData() });
    return opciones.lectura
      ? json(route, opciones.lectura.status, opciones.lectura.cuerpo)
      // Envuelta en `{ extraccion }` y VACÍA: sin datos leídos no hay prellenado, ningún caso de
      // este archivo cambia de comportamiento y el AC5 queda ejercitado de paso en los ~30.
      : json(route, 200, { extraccion: {} });
  });
  await page.route(RE_PRECONSULTA, async (route) => {
    preconsultas.push({ post: route.request().postData() });
    if (opciones.retenerPreconsulta) await enVuelo;
    return opciones.preconsulta
      ? json(route, opciones.preconsulta.status, opciones.preconsulta.cuerpo)
      : json(route, 200, RUNT_OK);
  });
  return { altas, preconsultas, lecturas, liberarPreconsulta: () => abrir() };
}

const btnConsultar = (page: Page) => page.getByRole('button', { name: 'Consultar el RUNT' });
const btnReconsultar = (page: Page) => page.getByRole('button', { name: 'Volver a consultar' });
/** HU #12079: el rótulo pasó de «Enviar al gestor» a «Enviar al gestor». */
const btnEnviar = (page: Page) => page.getByRole('button', { name: 'Enviar al gestor' });
const fichaRunt = (page: Page) => page.getByRole('region', { name: 'Datos del RUNT' });

/**
 * El bloque 1 entero, que desde la HU #12091 es **un solo campo**: el VIN.
 *
 * El helper se queda con su nombre y su forma —lo llaman doce tests— pero ya no teclea placa, tipo
 * ni número: esos tres salieron del bloque del vehículo (AC1) y el documento se llena ahora con el
 * propietario. El VIN dejó de ser opcional, así que se rellena SIEMPRE y su valor por defecto es un
 * VIN válido en vez de la cadena vacía.
 */
async function llenarVehiculo(page: Page, { vin = VIN } = {}) {
  await page.getByLabel('VIN').fill(vin);
}

/**
 * El propietario del bloque 3, en su forma de persona natural — **con su documento** (HU #12091).
 *
 * `documento: false` es para el único test que lo conmuta a mano (el de NIT), que tiene que elegir
 * el tipo antes de que se monte el campo de razón social.
 */
async function llenarPropietario(page: Page, { nombres = 'MARÍA FERNANDA', apellidos = 'GÓMEZ RUIZ', municipio = 'Medellín', documento = true } = {}) {
  if (documento) {
    await page.getByLabel('Tipo de documento').selectOption(TIPO_DOC);
    await page.getByLabel('Número de documento').fill(NUMERO_DOC);
  }
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
  test('al abrir: hay «Consultar el RUNT» y «Enviar al gestor» está aria-disabled y NO disabled', async ({ page }) => {
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
    // HU #12079: la frase deja de ser genérica y enumera lo que falta, empezando por el RUNT.
    // HU #12091: el segundo ítem ya no es «Placa» sino «VIN». El CONTEO se mantiene en 10 y eso no es
    // casualidad: el bloque 1 pierde tres campos (placa, tipo y número) y el VIN pasa a obligatorio,
    // mientras tipo y número reaparecen en el bloque del propietario. Doce pendientes antes y ahora.
    await expect(page.getByText('Para enviar falta: consultar el RUNT, VIN y 10 datos más.')).toBeVisible();

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

  test('el orden de entrada empieza por el VIN, y ni la placa ni nada del RUNT se teclea', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await mockCanal(page);
    await page.goto('/flito/soat/solicitud');

    await expect(page.getByRole('heading', { name: 'Solicitud de SOAT' })).toBeFocused();
    // HU #12091: el orden viejo era placa → tipo → número → VIN, los cuatro en el bloque 1. Ahora el
    // primer control de la pantalla es el VIN y el siguiente ya es el botón que consulta: entre los
    // dos no queda nada porque el bloque 1 no tiene nada más.
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('VIN')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(btnConsultar(page)).toBeFocused();
    // Y la placa no se teclea en NINGÚN sitio: no cambió de bloque, se fue.
    await expect(page.getByLabel('Placa')).toHaveCount(0);

    // Marca, línea, modelo y organismo no se teclean. Los DOS asertos hacen falta: un
    // `<input disabled>` conserva el rol `textbox` en varios motores, así que el primero solo no
    // mata al mutante que «resuelve» los datos del RUNT con campos deshabilitados.
    await expect(page.getByRole('textbox', { name: /Marca|Línea|Modelo|Organismo/ })).toHaveCount(0);
    await expect(page.locator('input[disabled]')).toHaveCount(0);
  });

  test('una consulta 200 abre la compuerta y trae la ficha con la placa y el VIN del RUNT', async ({ page }) => {
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
    // HU #12091, AC3: placa y VIN SÍ entran a la ficha, y la placa la encabeza. Ya no es un eco de
    // lo tecleado —el Cliente no escribe placa— sino lo que devuelve el registro: la única prueba
    // visible de que el RUNT habla de su vehículo. El detalle de los once datos y sus grupos se
    // afirma en `soat-vin-unico-ficha-runt.spec.ts`; aquí basta con que los dos que ANTES se
    // ocultaban a propósito ahora estén.
    await expect(ficha.getByText(PLACA)).toBeVisible();
    await expect(ficha.getByText(VIN)).toBeVisible();
    await expect(ficha.getByText('Capacidad (pasajeros)')).toBeVisible();
    await expect(ficha.getByText('Puertas')).toBeVisible();
    // HU #12079: la compuerta abierta ya NO basta para activar el primario —faltan el propietario y
    // la factura—, así que lo que prueba que la consulta surtió efecto es que el RUNT SALE de la
    // enumeración de lo que falta. El aserto negativo es el que importa: sin él, un `ITEM_RUNT` que
    // devolviera siempre una cadena pasaría desapercibido.
    await expect(page.locator('#sol-falta')).not.toContainText('RUNT');
    // HU #12091: con el VIN consultado y nada más, lo que falta empieza por la factura —que ahora es
    // el bloque 2— y sigue por el documento, que bajó al bloque del propietario.
    await expect(page.locator('#sol-falta')).toHaveText('Para enviar falta: Factura de venta, Tipo de documento y 8 datos más.');
    await expect(page.getByRole('button', { name: 'Consultar de nuevo' })).toBeVisible();
    expect(cap.preconsultas).toHaveLength(1);
  });

  test('el VIN es OBLIGATORIO: sin él no se consulta, y con él viaja en los dos endpoints', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    const cola = await mockCola(page);
    const cap = await mockCanal(page);
    await page.goto('/flito/soat/solicitud');

    // La inversión exacta del contrato viejo («sin escribirlo se envía»): desde la HU #12090 el VIN
    // es LA clave de la consulta, así que sin él no hay nada que preguntar y no sale ni una petición.
    await btnConsultar(page).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Escriba el VIN del vehículo.' })).toBeVisible();
    expect(cap.preconsultas).toHaveLength(0);

    await llenarTodoYConsultar(page);
    cola.items = [fila()];
    await btnEnviar(page).click();

    await expect(page).toHaveURL(/\/flito\/soat$/);
    await expect(page.getByText('Solicitud enviada. Ya está en gestión.')).toBeVisible();
    expect(cap.altas).toHaveLength(1);
    // Y la placa deja de viajar en el alta: la que se persiste es la que devuelve el RUNT.
    expect(cap.preconsultas[0].post ?? '').toContain('"vin"');
    expect(cap.altas[0].post ?? '').toContain('name="vin"');
    expect(cap.altas[0].post ?? '').not.toContain('name="placa"');
  });

  test('la transición: cambiar UN carácter del VIN retira la ficha y cierra la compuerta', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await mockCanal(page);
    await page.goto('/flito/soat/solicitud');
    await llenarTodoYConsultar(page);

    await page.getByLabel('VIN').fill('9BWZZZ377VT004252');

    await expect(fichaRunt(page)).toHaveCount(0);
    await expect(page.getByText('✓ Consultado')).toHaveCount(0);
    await expect(btnEnviar(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByText('Cambió el VIN: vuelva a consultar el RUNT antes de enviar.')).toBeVisible();
    await expect(btnReconsultar(page)).toBeVisible();
    // Y lo que escribió el Cliente NO se toca: castigar al que corrige una letra es el otro mutante.
    await expect(page.getByLabel('Correo electrónico')).toHaveValue(CORREO);
    await expect(page.getByLabel('Municipio')).toHaveValue('Medellín');
    await expect(page.getByText('factura.pdf', { exact: false })).toBeVisible();
  });

  test('el TIPO de documento ya NO dispara la transición: dejó de ser entrada del RUNT', async ({ page }) => {
    // La inversión de la #11967, y la decisión está escrita: desde la #12090 la consulta va solo por
    // VIN, así que tumbar la ficha porque el Cliente corrige una tilde del documento le haría repetir
    // una consulta que no depende de él. El aserto POSITIVO es el que importa —la ficha sigue— y el
    // negativo mata al mutante de dejar `cambiarIdentificador` atado al documento.
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await mockCanal(page);
    await page.goto('/flito/soat/solicitud');
    await llenarTodoYConsultar(page);

    await page.getByLabel('Tipo de documento').selectOption('CE');

    await expect(fichaRunt(page)).toBeVisible();
    await expect(page.getByText('✓ Consultado')).toBeVisible();
    await expect(page.getByText(/vuelva a consultar el RUNT antes de enviar/)).toHaveCount(0);
    await expect(page.getByLabel('Correo electrónico')).toHaveValue(CORREO);
  });

  test('cambiar el tipo con la consulta EN VUELO ya no es una carrera: la respuesta SÍ aterriza', async ({ page }) => {
    // La inversión del caso viejo. Con la consulta por placa + documento, tocar el `<select>` del
    // tipo mientras Kyverum pensaba era el único camino conocido para radicar una solicitud cuyo
    // RUNT no correspondía a lo enviado, y `turno` estaba para eso. Desde la #12091 el tipo no
    // alimenta la consulta: la respuesta que llega es la de la pregunta que se hizo, y descartarla
    // sería tirar una consulta buena por un cambio que no la afecta.
    //
    // La carrera de VERDAD —cambiar el VIN en vuelo— se prueba en `soat-vin-unico-ficha-runt.spec.ts`,
    // que es donde vive el campo que sí la provoca. Aquí sobrevive el aserto que importa: que ese
    // `<select>` sigue siendo alcanzable durante la consulta (no se deshabilita nada, que es la
    // decisión de foco de la #11967).
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

    const tipo = page.getByLabel('Tipo de documento');
    await expect(tipo).toBeEnabled();
    await tipo.selectOption('CE');
    await expect(page.getByText(/vuelva a consultar el RUNT antes de enviar/)).toHaveCount(0);

    const respuesta = page.waitForResponse((r) => RE_PRECONSULTA.test(r.url()));
    cap.liberarPreconsulta();
    await respuesta;

    await expect(fichaRunt(page)).toBeVisible();
    await expect(page.getByText('✓ Consultado')).toBeVisible();
    expect(cap.preconsultas).toHaveLength(1);

    // Y con la compuerta abierta y todo lleno, el primario envía: es el desenlace opuesto al viejo.
    await expect(btnEnviar(page)).not.toHaveAttribute('aria-disabled', 'true');
    await btnEnviar(page).click();
    expect(cap.altas).toHaveLength(1);
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

  test('«Consultar otro vehículo» limpia SOLO el VIN y conserva el propietario entero', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await mockCanal(page, { preconsulta: fallo(409, 'soat_vigente', 'Ya tiene SOAT vigente.') });
    await page.goto('/flito/soat/solicitud');
    await llenarVehiculo(page, { vin: VIN });
    await llenarPropietario(page);
    await adjuntarFactura(page);
    await btnConsultar(page).click();

    await page.getByRole('dialog').getByRole('button', { name: 'Consultar otro vehículo' }).click();

    // HU #12091: eran CUATRO identificadores y ahora es uno. El documento ya NO se borra —no es del
    // vehículo sino del titular, y quien pide el SOAT de otro carro de su flota suele ser el mismo—:
    // los dos asertos siguientes son la inversión del contrato viejo, no un olvido.
    await expect(page.getByLabel('VIN')).toHaveValue('');
    await expect(page.getByLabel('Tipo de documento')).toHaveValue(TIPO_DOC);
    await expect(page.getByLabel('Número de documento')).toHaveValue(NUMERO_DOC);
    await expect(page.getByLabel('Correo electrónico')).toHaveValue(CORREO);
    await expect(page.getByLabel('Nombre/s')).toHaveValue('MARÍA FERNANDA');
    await expect(page.getByText('factura.pdf', { exact: false })).toBeVisible();
    // El foco no se cae a `<body>` al desaparecer el botón que abrió el modal.
    await expect(page.getByLabel('VIN')).toBeFocused();
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

    // HU #12091: el copy dejó de mandar a comprobar «la placa y el documento», que el Cliente ya no
    // teclea, y nombra el único dato que hay en el bloque 1.
    await expect(banda).toContainText('Revise el VIN: no coincide con el que el RUNT tiene registrado.');
    await expect(page.getByText(/no está disponible/)).toHaveCount(0);
    await expect(banda).not.toContainText(/placa/i);
  });

  test('los tres de la familia «revise los datos» dicen cosas DISTINTAS entre sí', async ({ page }) => {
    const banda = await consultarCon(page, fallo(422, 'runt_sin_registro', 'Revisa los datos.'));
    await expect(banda).toContainText('El RUNT no tiene registrado ningún vehículo con ese VIN.');

    // `runt_sin_vin` no es «revise los datos»: no hay nada que el Cliente pueda corregir, y por eso
    // su copy no le empuja a reintentar.
    await page.unroute(RE_PRECONSULTA);
    await mockCanal(page, { preconsulta: fallo(422, 'runt_sin_vin', 'Revisa los datos.') });
    await btnReconsultar(page).click();
    await expect(page.getByRole('alert')).toContainText('El RUNT respondió sin el número de chasis');
    await expect(page.getByText(/Revise el VIN/)).toHaveCount(0);
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
    // HU #12091: el copy se reescribió entero. Ya no dice «el que el RUNT tiene para esa placa»
    // —no hay placa tecleada— ni ofrece «déjelo vacío», que era la salida del VIN opcional y ahora
    // sería un consejo imposible.
    await expect(banda).toContainText('Revise el VIN: no coincide con el que el RUNT tiene registrado.');
    await expect(banda).not.toContainText('déjelo vacío');
    // La fuga que nadie debe «mejorar»: el VIN del registro no se enseña en ninguna parte.
    await expect(banda).not.toContainText(VIN);
  });

  test('un código DESCONOCIDO o retirado no deja la pantalla muda: banda genérica y reintento', async ({ page }) => {
    // `organismo_no_catalogado` se retiró de los dos endpoints en la #11966; una API desfasada en
    // DEV lo sigue sirviendo, y en DEV el merge ES el deploy.
    const banda = await consultarCon(page, fallo(422, 'organismo_no_catalogado', 'El organismo de tránsito no está en el catálogo de FLITO.'));

    // HU #12091, decisión 6 del UX: la banda deja de interpolar el `mensaje` del servidor —que tutea
    // y que en una API desfasada nombra campos que esta pantalla ya no tiene— y usa copy propio.
    await expect(banda).toContainText('No pudimos consultar el RUNT en este momento.');
    await expect(page.getByText('El organismo de tránsito no está en el catálogo de FLITO.')).toHaveCount(0);
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

    await llenarVehiculo(page);
    await page.getByLabel('Tipo de documento').selectOption(TIPO_DOC);
    await page.getByLabel('Nombre/s').fill('MARÍA FERNANDA');
    await page.getByLabel('Tipo de documento').selectOption('NIT');
    await page.getByLabel('Número de documento').fill('9001234561');
    await page.getByLabel('Razón social').fill('TRANSPORTES X SAS');
    await llenarPropietario(page, { nombres: '', apellidos: '', documento: false });
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

    // HU #12094 · AC7 — el mapa de procedencia obedece a la MISMA excluyencia. Declarar `nombres`
    // con un NIT sería afirmar el origen de un dato que no se envía, y el esquema del borde es
    // `.strict()`: una clave de más es un 400.
    const procedencia = JSON.parse(campoMultipart(cuerpo, 'procedencia') ?? '{}') as Record<string, string>;
    expect(Object.keys(procedencia).sort()).toEqual([
      'celular', 'departamento', 'direccion', 'municipio', 'numeroDocumento', 'razonSocial',
      'tipoDocumento',
    ]);
    // Todo tecleado a mano y la lectura sin datos: los siete son `manual` y ninguno es `runt`.
    expect(Object.values(procedencia).every((v) => v === 'manual')).toBe(true);
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

    // Con el teclado, no con `.click()`: desde la HU #12079 el primario lleva `aria-disabled` en
    // cuanto falta un campo, y la actionability de Playwright lo trata como deshabilitado. `Enter`
    // sobre el botón enfocado dispara el mismo `click` — y es el camino que la decisión de
    // accesibilidad existe para preservar.
    await page.getByRole('button', { name: 'Cancelar' }).focus();
    await page.keyboard.press('Tab');
    await expect(btnEnviar(page)).toBeFocused();
    await page.keyboard.press('Enter');

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
    // HU #12094: y no aparece en NINGÚN control del formulario. Es lo que fija que `'runt'` no sea
    // una procedencia emitible — no hay campo del propietario que el registro prellene.
    const valores = await page.locator('input, select').evaluateAll(
      (els) => els.map((el) => (el as HTMLInputElement | HTMLSelectElement).value),
    );
    expect(valores.some((v) => v.includes('MARÍA FERNANDA'))).toBe(false);
  });
});

// ═════════════════════════ AC5 · RN-01, el VIN ya en cola ════════════════════════════════════════
//
// Lo que este bloque tenía y esta HU se lleva: la subsanación (`/flito/soat/solicitud/:id`), la
// pastilla «Rechazada» y el primario «Abrir la solicitud rechazada» del modal de RN-01, que llevaba
// a esa ruta. RN-01 sigue entero: lo que cambia es la SALIDA que se le ofrece al Cliente.

test.describe('HU #11967 · AC5 — el VIN ya está en la cola de FLITO', () => {
  test('propia: modal RN-01, «Ver la solicitud» y URL sin PII ni identificadores', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    const cola = await mockCola(page, [fila()]);
    await page.route(RE_DETALLE, (route) => json(route, 200, detalle()));
    await mockCanal(page, {
      preconsulta: fallo(409, 'vin_ya_tiene_soat', 'Esta solicitud ya existe.', {
        propia: true, id: UUID_SOLICITUD, estado: 'solicitado',
      }),
    });

    await page.goto('/flito/soat/solicitud');
    await llenarVehiculo(page, { vin: VIN });
    await btnConsultar(page).click();

    const modal = page.getByRole('dialog', { name: 'Ese vehículo ya está en la cola de FLITO' });
    await expect(modal).toBeVisible();
    await expect(modal.getByText('Puede seguir su estado desde sus SOAT.')).toBeVisible();
    // El primario ya NO es «Abrir la solicitud rechazada»: esa ruta se retiró con la subsanación
    // (HU #12079) y el botón habría aterrizado en el comodín `*`. El aserto negativo es la mitad que
    // mata al mutante de dejar el enlace apuntando a una ruta que ya no existe.
    await expect(modal.getByRole('link', { name: 'Abrir la solicitud rechazada' })).toHaveCount(0);
    await modal.getByRole('link', { name: 'Ver la solicitud' }).click();

    // El uuid viaja en el ESTADO de navegación, no en la URL.
    await expect(page).toHaveURL(/\/flito\/soat$/);
    expect(page.url()).not.toContain(UUID_SOLICITUD);
    expect(page.url()).not.toContain(PLACA);
    expect(page.url()).not.toContain(VIN);
    expect(cola.items).toHaveLength(1);
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
    await expect(modal.getByRole('link', { name: 'Ver la solicitud' })).toHaveCount(0);
    await expect(modal.getByText(/Rechazada|Pendiente|Solicitado|Pagado|novedad/)).toHaveCount(0);
    await expect(modal.getByText(/\d{1,2}\/\d{1,2}\/\d{2,4}/)).toHaveCount(0);
  });

  test('desde la cola: el detalle del Cliente no filtra la trastienda ni le ofrece el historial', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page, [fila()]);

    await page.goto('/flito/soat');
    await page.getByRole('button', { name: 'Ver' }).first().click();
    const detalleModal = page.getByRole('dialog');
    await expect(detalleModal).toBeVisible();
    await expect(detalleModal.getByText(/Gestiona|Enviado por|Valor pagado/)).toHaveCount(0);
    await expect(detalleModal.getByRole('button', { name: 'Ver el historial de estados' })).toHaveCount(0);
  });

  test('el historial SIGUE estando para Operaciones', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page, [fila()]);

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

  // **HU #12094: el veredicto es el mismo y el MOMENTO cambia.** El rechazo por bytes se conocía al
  // ENVIAR, después de subir el PDF entero una segunda vez; ahora lo caza la lectura, que sube el
  // mismo archivo nada más adjuntarlo y olfatea los mismos bytes. Su superficie sigue siendo la caja
  // del bloque 2 y su copy es el mismo: lo que se invierte es cuándo se ve.
  test('un PDF que no lo es: la caja queda rechazada al ADJUNTAR y dice POR QUÉ', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    const cap = await mockCanal(page, {
      lectura: fallo(400, 'archivo_no_pdf', 'La factura de venta debe ser un PDF.'),
    });
    await page.goto('/flito/soat/solicitud');
    await llenarVehiculo(page);
    await llenarPropietario(page);
    await adjuntarFactura(page);

    await expect(page.getByRole('alert')
      .filter({ hasText: 'Ese archivo no es un PDF válido, aunque se llame así.' })).toBeVisible();
    await expect(page.getByText('Rechazado — cargar otro')).toBeVisible();
    // Sin banda de lectura: si el archivo no vale, no hay nada que volver a leer.
    await expect(page.getByRole('button', { name: 'Volver a leer la factura' })).toHaveCount(0);
    expect(cap.lecturas).toHaveLength(1);
    // Y nunca se llegó al alta: el 400 dejó de costar una subida de 15 MB.
    expect(cap.altas).toHaveLength(0);
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

    // HU #12091: el aviso ya no interpola la placa —que el Cliente no teclea— ni la sustituye por el
    // VIN, que son 17 caracteres dentro de una frase.
    await expect(page.getByText('No sabemos si la solicitud llegó a FLITO. Vuelva a sus SOAT y busque ese VIN antes de volver a enviarla.')).toBeVisible();
    await expect(btnEnviar(page)).toHaveCount(0);
  });

  test('salir con datos escritos pide confirmación: no hay borradores que rescatar', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);

    await page.goto('/flito/soat/solicitud');
    await page.getByLabel('VIN').fill(VIN);
    await page.getByRole('button', { name: '← Volver a mis SOAT' }).click();

    const dialogo = page.getByRole('dialog', { name: '¿Descartar la solicitud?' });
    await expect(dialogo.getByText('Lo que escribió no se guarda: no hay borradores.')).toBeVisible();
    await dialogo.getByRole('button', { name: 'Seguir llenando' }).click();
    await expect(page.getByLabel('VIN')).toHaveValue(VIN);

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
    // HU #12094 · la tercera petición del canal: la lectura sale UNA vez, con el PDF en el cuerpo y
    // sin un solo parámetro en la URL.
    expect(cap.lecturas).toHaveLength(1);
    expect(new URL(cap.lecturas[0].url).search).toBe('');
    expect(cap.lecturas[0].post ?? '').toContain('name="facturaVenta"');
    expect(new URL(cap.altas[0].url).search).toBe('');
    // La placa NO viaja en el alta desde la #12090: la que se persiste la devuelve el RUNT.
    expect(cap.altas[0].post ?? '').not.toContain(PLACA);
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

// ═════════════════ La ficha de ayuda in-app del módulo SOAT ══════════════════════════════════════
//
// El AC pide que «la ficha de ayuda in-app del módulo SOAT describa la consulta previa, el VIN, el
// modal de vigente, el "revise los datos" y el propietario obligatorio partido». Desde la HU #12091
// el VIN es OBLIGATORIO y el único dato del vehículo: la ficha que decía «el VIN es opcional» y
// «escriba la placa» quedaría mintiendo, y este test es lo que lo impide.
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
  test('la ficha describe la consulta por VIN, el modal, el «Revise el VIN» y el propietario partido', async ({ page }) => {
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
    // HU #12079: el rótulo del primario también se lee del DOM. Es el que la ficha tiene que citar,
    // y es el que el PO puede pedir cambiar («gestor» es vocabulario interno): si cambia aquí y no
    // en la ficha, este test se pone rojo sin que nadie tenga que acordarse.
    const rotuloEnviar = (await btnEnviar(page).innerText()).trim();
    // El VIN es el ÚNICO dato del vehículo, y la pantalla dice dónde encontrarlo…
    await expect(page.getByText('Está en la tarjeta de propiedad y en la factura de venta. Suele tener 17 caracteres.')).toBeVisible();
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
    for (const literal of [rotuloConsulta, rotuloEnviar, tituloModal]) {
      await expect(ficha, literal).toContainText(literal);
    }

    // Y las cinco promesas del AC, cada una con las palabras con las que la ficha las explica.
    const promesas = [
      // La consulta previa es compuerta, y hay que repetirla si se toca un identificador.
      'Pulse Consultar el RUNT',
      'Volver a consultar',
      'No se radica una solicitud del canal SOAT sin trámite sin consultar antes el RUNT',
      // HU #12079 — lo que la ficha tiene que decir AHORA y no decía: qué se enumera cuando el
      // botón está bloqueado, a dónde va la solicitud al enviarla y dónde se configura el gestor.
      // HU #12091: el segundo ítem de esa frase pasó de «Placa» a «VIN».
      'Para enviar falta: consultar el RUNT, VIN y 10 datos más.',
      'la solicitud queda en Solicitado, sale al gestor por defecto de su compañía',
      'No pasa por ninguna revisión de FLITO',
      'se configuran en Clientes y proveedores, en la columna SOAT sin trámite',
      // HU #12091 — el VIN dejó de ser opcional y pasó a ser el ÚNICO dato del vehículo: la ficha no
      // puede seguir mandando a escribir la placa y el documento antes de consultar.
      'Escriba el VIN',
      'es el único dato del vehículo que usted escribe',
      // El desenlace que no es del canal ni del servicio, sino de los datos.
      'Revise el VIN',
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
