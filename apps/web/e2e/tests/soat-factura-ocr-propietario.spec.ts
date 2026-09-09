// HU #12094 — SOAT canal Cliente: la factura se lee sola y el propietario llega prellenado.
//
// Diseño: docs/ux/flito-soat-factura-leida-y-propietario-prellenado.md. Continúa la #12091, que dejó
// el bloque 2 delante del propietario y VACÍO a propósito; aquí se llena.
//
// ── Qué se intercepta, y por qué el CONTADOR es la mitad del valor ──────────────────────────────
//
// `POST /flito/soat/cliente/factura/lectura` nunca sale de aquí: el OCR real es un encargado externo
// de pago. Y cada caso mira **cuántas veces** se llamó, no solo qué se pintó: «se lee dos veces al
// adjuntar» y «no se lee» son los dos mutantes que ningún aserto sobre el DOM distingue.
//
// La respuesta va **envuelta en `{ extraccion }`** —no plana— y cada campo es
// `{ valor, confianza, confiable }`. Los mocks lo respetan literalmente: un mock plano dejaría verde
// una pantalla que no sabe leer lo que el backend devuelve.
//
// Lo que NO vive aquí: los cuatro estados ante axe, que están en
// `soat-vin-unico-ficha-runt-a11y.spec.ts` (sin `QA_AXE_CDN=1` ese archivo sale rojo por ENTORNO y
// contaminaría este gate funcional), y los ~30 casos del formulario que ya cubren
// `soat-cliente-solicitud.spec.ts` y `soat-vin-unico-ficha-runt.spec.ts`.
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, CLIENTE_CON_CANAL, OPERACIONES_USER } from '../helpers/auth';

const PLACA = 'ABC123';
const VIN = '9BWZZZ377VT004251';
const CORREO = 'contacto@ejemplo.co';
const UUID_SOLICITUD = '11111111-2222-4333-8444-555555555555';

const RE_ALTA = /\/api\/flito\/soat\/cliente$/;
const RE_COLA = /\/api\/flito\/soat\?/;
const RE_PRECONSULTA = /\/api\/flito\/soat\/cliente\/preconsulta$/;
const RE_LECTURA = /\/api\/flito\/soat\/cliente\/factura\/lectura$/;

const RUNT_OK = {
  vehiculo: {
    placa: PLACA, vin: VIN, marca: 'RENAULT', linea: 'LOGAN', modelo: '2026', clase: 'AUTOMOVIL',
    cilindraje: '1600', tipoServicio: 'Particular', carroceria: 'SEDAN',
    pasajerosSentados: '5', puertas: '4',
  },
  organismo: { codigo: '05001', nombre: 'STRIA TTEyTTO MEDELLIN' },
  propietario: null as { nombreCompleto: string } | null,
};

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

type Respuesta = { status: number; cuerpo: unknown };

const fallo = (status: number, error: string, codigo?: string) =>
  ({ status, cuerpo: codigo ? { error, codigo } : { error } });

// ───────────────────────────── La extracción, con la forma EXACTA del contrato ───────────────────

/** Un campo extraído. `confiable` es lo que decide la marca, y `confianza` no se pinta en ningún sitio. */
const campo = (valor: string | null, confiable = true) =>
  ({ valor, confianza: confiable ? 0.95 : 0.42, confiable });

/** Los nueve del comprador, todos confiables. Los cinco documentales van aparte, y se descartan. */
const EXTRACCION_COMPLETA = {
  // Los cinco DOCUMENTALES: la pantalla no tiene campo para ninguno y tiene que tirarlos. El VIN
  // leído, en particular, no puede prellenar el bloque 1 ni compararse con el tecleado.
  placa: campo('XYZ987'), vin: campo('9FKRG2222T2042405'), numeroFactura: campo('FV-1234'),
  fechaFactura: campo('2026-08-01'), valorVehiculo: campo('85000000'),
  // Los NUEVE del comprador.
  nombres: campo('MARÍA FERNANDA'), apellidos: campo('GÓMEZ RUIZ'), razonSocial: campo(null),
  tipoDocumento: campo('CC'), numeroDocumento: campo('1020304050'),
  direccion: campo('CL 30 # 5-10'), municipio: campo('MEDELLÍN'), departamento: campo('ANTIOQUIA'),
  celular: campo('3009999999'),
};

/** Lo que devuelve el lector cuando la factura es ilegible: las nueve claves SIN valor. */
const EXTRACCION_VACIA = Object.fromEntries(
  ['nombres', 'apellidos', 'razonSocial', 'tipoDocumento', 'numeroDocumento', 'direccion',
    'municipio', 'departamento', 'celular'].map((c) => [c, campo(null, false)]),
);

const leida = (extraccion: Record<string, unknown>): Respuesta =>
  ({ status: 200, cuerpo: { extraccion } });

// ───────────────────────────── Mocks del canal ───────────────────────────────────────────────────

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
 * Los TRES endpoints del canal, contados uno a uno.
 *
 * `porLlamada` sirve para la carrera y para el reintento: la primera lectura devuelve una cosa y la
 * segunda otra, que es la única forma de comprobar cuál de las dos ganó.
 */
async function mockCanal(page: Page, opciones: {
  alta?: Respuesta;
  preconsulta?: Respuesta;
  lectura?: Respuesta;
  porLlamada?: Respuesta[];
  /** Deja la PRIMERA lectura en vuelo hasta que el test la libere. */
  retenerPrimera?: boolean;
} = {}) {
  const altas: { url: string; post: string | null }[] = [];
  const preconsultas: { post: string | null }[] = [];
  const lecturas: { url: string; post: string | null }[] = [];
  let abrir: () => void = () => {};
  const enVuelo = new Promise<void>((resolver) => { abrir = () => resolver(); });

  await page.route(RE_ALTA, (route) => {
    altas.push({ url: route.request().url(), post: route.request().postData() });
    return opciones.alta
      ? json(route, opciones.alta.status, opciones.alta.cuerpo)
      : json(route, 201, { id: UUID_SOLICITUD, estado: 'solicitado' });
  });
  await page.route(RE_PRECONSULTA, (route) => {
    preconsultas.push({ post: route.request().postData() });
    return opciones.preconsulta
      ? json(route, opciones.preconsulta.status, opciones.preconsulta.cuerpo)
      : json(route, 200, RUNT_OK);
  });
  await page.route(RE_LECTURA, async (route) => {
    const turno = lecturas.length;
    lecturas.push({ url: route.request().url(), post: route.request().postData() });
    if (opciones.retenerPrimera && turno === 0) await enVuelo;
    const r = opciones.porLlamada?.[turno] ?? opciones.lectura ?? leida({});
    return json(route, r.status, r.cuerpo);
  });

  return { altas, preconsultas, lecturas, liberarPrimeraLectura: () => abrir() };
}

// ───────────────────────────── Localizadores y pasos ─────────────────────────────────────────────

const btnConsultar = (page: Page) => page.getByRole('button', { name: 'Consultar el RUNT' });
const btnEnviar = (page: Page) => page.getByRole('button', { name: 'Enviar al gestor' });
const fichaRunt = (page: Page) => page.getByRole('region', { name: 'Datos del RUNT' });
const falta = (page: Page) => page.locator('#sol-falta');
const chipRevisar = (page: Page) => page.getByText('⚠ Revise este dato');

/**
 * Los controles del propietario, **por su id estable y no por `getByLabel`**.
 *
 * No es comodidad: `getByLabel` casa por SUBCADENA, así que «Municipio» resuelve además el botón
 * «Confirmar municipio» y la casilla «Municipio» de la banda de sobrescritura — los dos nombres
 * accesibles que esta HU añade a propósito—, y el localizador se vuelve ambiguo justo en los casos
 * que hay que medir. La asociación `<label for>` la comprueba el spec de accesibilidad, que es su
 * sitio. `tipoDocumento` va por rol porque `FlitSelect` genera su id con `useId()`.
 */
const ID_CONTROL: Record<string, string> = {
  numeroDocumento: '#sol-numero-documento', nombres: '#sol-nombres', apellidos: '#sol-apellidos',
  razonSocial: '#sol-razon-social', correo: '#sol-correo', celular: '#sol-celular',
  direccion: '#sol-direccion', municipio: '#sol-municipio', departamento: '#sol-departamento',
};

const control = (page: Page, clave: string) => (clave === 'tipoDocumento'
  ? page.getByRole('combobox', { name: 'Tipo de documento' })
  : page.locator(ID_CONTROL[clave]));

/** Los que se montan con persona natural, que es la forma por defecto del formulario. */
const CLAVES_NATURAL = [
  'tipoDocumento', 'numeroDocumento', 'nombres', 'apellidos', 'celular', 'direccion', 'municipio',
  'departamento',
];

async function adjuntar(page: Page, nombre = 'factura.pdf') {
  await page.locator('input[type="file"]').setInputFiles({
    name: nombre, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 e2e'),
  });
}

/**
 * El valor de un campo de TEXTO del multipart, leído del cuerpo crudo que Playwright captura.
 *
 * Se lee del cuerpo y no de una API del navegador porque lo que importa es lo que VIAJÓ.
 */
function campoMultipart(cuerpo: string, nombre: string): string | null {
  const m = new RegExp(`name="${nombre}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`).exec(cuerpo);
  return m ? m[1] : null;
}

/** El mapa de procedencia del alta, ya parseado. */
function procedenciaDe(cuerpo: string): Record<string, string> {
  const crudo = campoMultipart(cuerpo, 'procedencia');
  expect(crudo, 'el alta no llevaba el campo `procedencia`').not.toBeNull();
  return JSON.parse(crudo!) as Record<string, string>;
}

/** Alta lista para enviar: VIN consultado, factura leída y el correo tecleado (nunca se lee). */
async function prepararConLectura(page: Page) {
  await page.getByLabel('VIN').fill(VIN);
  await adjuntar(page);
  await expect(page.getByText('✓ Factura leída')).toBeVisible();
  await control(page, 'correo').fill(CORREO);
  await btnConsultar(page).click();
  await expect(fichaRunt(page)).toBeVisible();
}

// ═════════════════════════ AC1 · la lectura arranca sola y avisa ═════════════════════════════════

test.describe('HU #12094 · AC1 — la lectura arranca al adjuntar', () => {
  test('adjuntar dispara UNA lectura con `facturaVenta`, avisa en role=status y no deshabilita nada', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    const cap = await mockCanal(page, { retenerPrimera: true, porLlamada: [leida(EXTRACCION_COMPLETA)] });
    await page.goto('/flito/soat/solicitud');

    await adjuntar(page);

    const aviso = page.getByRole('status').filter({ hasText: 'Leyendo la factura…' });
    await expect(aviso).toBeVisible();
    await expect(page.getByText('Leyendo la factura…').first()).toBeVisible();
    // **Nada se deshabilita mientras se lee**: la lectura es una ayuda, no un peaje (AC5). El
    // bloque 3 sigue tecleable y el aserto lo ejercita de verdad, escribiendo en él.
    await expect(page.locator('input[disabled], select[disabled]')).toHaveCount(0);
    await control(page, 'correo').fill(CORREO);
    await expect(control(page, 'correo')).toHaveValue(CORREO);

    cap.liberarPrimeraLectura();
    await expect(page.getByText('✓ Factura leída')).toBeVisible();
    // UNA sola petición por adjunto, y con el PDF en el campo que el borde espera.
    expect(cap.lecturas).toHaveLength(1);
    expect(cap.lecturas[0].post ?? '').toContain('name="facturaVenta"');
    // Y lo que el usuario escribió durante la lectura no se pisa: el correo no se extrae.
    await expect(control(page, 'correo')).toHaveValue(CORREO);
  });

  test('503: el lector no respondió, hay «Volver a leer la factura» y el envío NO se bloquea por eso', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    const cap = await mockCanal(page, {
      // El texto del servidor MIENTE a propósito: si la pantalla ramificara por la prosa, este 503
      // saldría como un problema del archivo.
      porLlamada: [fallo(503, 'Revisa los datos del archivo'), leida(EXTRACCION_COMPLETA)],
    });
    await page.goto('/flito/soat/solicitud');

    await page.getByLabel('VIN').fill(VIN);
    await adjuntar(page);

    const banda = page.getByRole('alert').filter({ hasText: 'No pudimos leer la factura.' });
    await expect(banda).toBeVisible();
    await expect(banda).toContainText('el lector no respondió');
    // El fallo de la lectura no añade NI UN pendiente: lo que bloquea el envío es lo de siempre.
    await expect(falta(page)).not.toContainText('revisar');

    await page.getByRole('button', { name: 'Volver a leer la factura' }).click();
    await expect(page.getByText('✓ Factura leída')).toBeVisible();
    expect(cap.lecturas).toHaveLength(2);
    await expect(control(page, 'municipio')).toHaveValue('MEDELLÍN');
  });

  test('429: mensaje propio de esperar, DISTINTO del 503 y sin reintento automático', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    const cap = await mockCanal(page, { lectura: fallo(429, 'Demasiadas peticiones') });
    await page.goto('/flito/soat/solicitud');

    await adjuntar(page);

    await expect(page.getByRole('alert')
      .filter({ hasText: 'Ha hecho varias lecturas seguidas y toca esperar unos minutos.' })).toBeVisible();
    // Desde la HU #12214 el limitador de la lectura NO es el del alta: tiene contador propio, así que
    // el mensaje ya no advierte de un presupuesto compartido que no existe. Sigue sin reintento
    // automático porque la ventana es de quince minutos, no porque releer cueste el envío.
    await expect(page.getByText('No pudimos leer la factura.')).toHaveCount(0);
    await expect(page.getByText('Puede escribir los datos del propietario a mano y enviar la solicitud ahora: el envío no se ve afectado por este límite.')).toBeVisible();
    expect(cap.lecturas).toHaveLength(1);
  });

  test('400 archivo_no_pdf: el error es del bloque 2, cero campos prellenados y cero altas', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    const cap = await mockCanal(page, {
      lectura: fallo(400, 'La factura de venta debe ser un PDF.', 'archivo_no_pdf'),
    });
    await page.goto('/flito/soat/solicitud');

    await adjuntar(page, 'no-es-pdf.pdf');

    await expect(page.getByRole('alert')
      .filter({ hasText: 'Ese archivo no es un PDF válido, aunque se llame así.' })).toBeVisible();
    await expect(page.getByText('Rechazado — cargar otro')).toBeVisible();
    // No es un fallo de la LECTURA: no hay banda del lector ni nada que reintentar.
    await expect(page.getByRole('button', { name: 'Volver a leer la factura' })).toHaveCount(0);
    for (const clave of CLAVES_NATURAL) {
      await expect(control(page, clave)).toHaveValue('');
    }
    expect(cap.altas).toHaveLength(0);
  });

  test('la CARRERA: la respuesta tardía de la factura anterior no pisa el formulario', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    const cap = await mockCanal(page, {
      retenerPrimera: true,
      porLlamada: [
        leida({ ...EXTRACCION_COMPLETA, municipio: campo('BOGOTÁ'), nombres: campo('PEDRO') }),
        leida(EXTRACCION_COMPLETA),
      ],
    });
    await page.goto('/flito/soat/solicitud');

    await adjuntar(page, 'factura-A.pdf');
    await expect(page.getByRole('status').filter({ hasText: 'Leyendo la factura…' })).toBeVisible();
    // Se cambia de archivo con la lectura de A en vuelo.
    await adjuntar(page, 'factura-B.pdf');
    await expect(page.getByText('✓ Factura leída')).toBeVisible();
    await expect(control(page, 'municipio')).toHaveValue('MEDELLÍN');

    cap.liberarPrimeraLectura();
    await expect.poll(async () => cap.lecturas.length).toBe(2);
    // Mismo criterio de `turno` que la consulta al RUNT: la respuesta tardía se descarta entera.
    await expect(control(page, 'municipio')).toHaveValue('MEDELLÍN');
    await expect(control(page, 'nombres')).toHaveValue('MARÍA FERNANDA');
    await expect(page.getByText('BOGOTÁ')).toHaveCount(0);
  });
});

// ═════════════════════════ AC2 · prellenado y TODO editable ══════════════════════════════════════

test.describe('HU #12094 · AC2 — el propietario llega escrito y editable', () => {
  test('los ocho visibles traen valor, tipo y número son editables y el correo queda vacío', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await mockCanal(page, { lectura: leida(EXTRACCION_COMPLETA) });
    await page.goto('/flito/soat/solicitud');

    await adjuntar(page);
    await expect(page.getByText('✓ Factura leída')).toBeVisible();

    await expect(control(page, 'tipoDocumento')).toHaveValue('CC');
    await expect(control(page, 'numeroDocumento')).toHaveValue('1020304050');
    await expect(control(page, 'nombres')).toHaveValue('MARÍA FERNANDA');
    await expect(control(page, 'apellidos')).toHaveValue('GÓMEZ RUIZ');
    await expect(control(page, 'direccion')).toHaveValue('CL 30 # 5-10');
    await expect(control(page, 'municipio')).toHaveValue('MEDELLÍN');
    await expect(control(page, 'departamento')).toHaveValue('ANTIOQUIA');
    await expect(control(page, 'celular')).toHaveValue('3009999999');
    await expect(page.getByText('Tomamos 8 datos del propietario de esta factura')).toBeVisible();

    // **Todos editables, tipo y número incluidos** (AC2, literal): ni `disabled` ni `readonly`.
    await expect(page.locator('input[disabled], select[disabled], input[readonly]')).toHaveCount(0);
    await control(page, 'tipoDocumento').selectOption('CE');
    await expect(control(page, 'tipoDocumento')).toHaveValue('CE');
    await control(page, 'numeroDocumento').fill('AB99');
    await expect(control(page, 'numeroDocumento')).toHaveValue('AB99');

    // El correo NO se extrae de una factura: sigue vacío, obligatorio y con su explicación al lado.
    await expect(control(page, 'correo')).toHaveValue('');
    await expect(falta(page)).toContainText('Correo electrónico');
    await expect(page.getByText('El correo electrónico sí lo tiene que escribir usted.')).toBeVisible();
  });

  test('un campo confiable SIN valor queda vacío: nunca «null» ni «—»', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await mockCanal(page, {
      lectura: leida({ ...EXTRACCION_COMPLETA, municipio: campo(null), celular: { valor: null, confianza: 0.99, confiable: true } }),
    });
    await page.goto('/flito/soat/solicitud');

    await page.getByLabel('VIN').fill(VIN);
    await control(page, 'correo').fill(CORREO);
    await adjuntar(page);
    await expect(page.getByText('✓ Factura leída')).toBeVisible();

    await expect(control(page, 'municipio')).toHaveValue('');
    await expect(control(page, 'celular')).toHaveValue('');
    // Un campo que no se leyó es un campo VACÍO normal, no una marca ni un relleno de cortesía: se
    // enumera entre lo que falta, como cualquier campo en blanco.
    await expect(chipRevisar(page)).toHaveCount(0);
    await expect(falta(page)).toHaveText('Para enviar falta: consultar el RUNT, Celular y Municipio.');
    await expect(page.getByText('Tomamos 6 datos del propietario de esta factura')).toBeVisible();
  });
});

// ═════════════════════════ AC3 · baja confianza, marca y contador ════════════════════════════════

test.describe('HU #12094 · AC3 — los campos dudosos se confirman uno a uno', () => {
  const TRES_DUDOSOS = {
    ...EXTRACCION_COMPLETA,
    municipio: campo('MEDELLÍN', false),
    direccion: campo('CL 30 # 5-10', false),
    celular: campo('3009999999', false),
  };

  test('tres marcados: el envío dice 3, y confirmar uno a uno baja 3 → 2 → 1 → enviable', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    const cola = await mockCola(page);
    const cap = await mockCanal(page, { lectura: leida(TRES_DUDOSOS) });
    await page.goto('/flito/soat/solicitud');
    await prepararConLectura(page);

    await expect(chipRevisar(page)).toHaveCount(3);
    await expect(falta(page)).toHaveText('Para enviar falta: revisar 3 datos leídos.');
    await expect(btnEnviar(page)).toHaveAttribute('aria-disabled', 'true');

    await page.getByRole('button', { name: 'Confirmar dirección' }).click();
    await expect(falta(page)).toHaveText('Para enviar falta: revisar 2 datos leídos.');

    // **Confirmar y editar son los dos gestos que cuentan**: corregir ES revisar.
    await control(page, 'municipio').fill('MEDELLIN');
    await expect(falta(page)).toHaveText('Para enviar falta: revisar 1 dato leído.');
    await expect(chipRevisar(page)).toHaveCount(1);

    await page.getByRole('button', { name: 'Confirmar celular' }).click();
    await expect(falta(page)).toHaveCount(0);
    await expect(btnEnviar(page)).not.toHaveAttribute('aria-disabled', 'true');

    cola.items = [{ id: UUID_SOLICITUD }];
    await btnEnviar(page).click();
    await expect(page).toHaveURL(/\/flito\/soat$/);
    expect(cap.altas).toHaveLength(1);
  });

  test('confirmar 2 de 3 deja el envío bloqueado, la frase dice 1 y NO se envía nada', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    const cap = await mockCanal(page, { lectura: leida(TRES_DUDOSOS) });
    await page.goto('/flito/soat/solicitud');
    await prepararConLectura(page);

    await page.getByRole('button', { name: 'Confirmar dirección' }).click();
    await page.getByRole('button', { name: 'Confirmar celular' }).click();

    // El conteo sale de la MISMA fuente que la compuerta del envío: un contador paralelo diría «1»
    // con el botón ya activo, o al revés.
    await expect(falta(page)).toHaveText('Para enviar falta: revisar 1 dato leído.');
    await expect(btnEnviar(page)).toHaveAttribute('aria-disabled', 'true');

    // Con el teclado, que es el camino que `aria-disabled` existe para preservar.
    await page.getByRole('button', { name: 'Cancelar' }).focus();
    await page.keyboard.press('Tab');
    await expect(btnEnviar(page)).toBeFocused();
    await page.keyboard.press('Enter');

    expect(cap.altas).toHaveLength(0);
    // El botón bloqueado lleva a la acción que sí toca: el primer pendiente en el orden visual.
    await expect(control(page, 'municipio')).toBeFocused();
    await expect(falta(page)).toHaveText('Para enviar falta: revisar 1 dato leído.');
  });

  test('la marca NO pone aria-invalid y su explicación llega por aria-describedby', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await mockCanal(page, { lectura: leida(TRES_DUDOSOS) });
    await page.goto('/flito/soat/solicitud');
    await adjuntar(page);
    await expect(page.getByText('✓ Factura leída')).toBeVisible();

    const municipio = control(page, 'municipio');
    // No es un error: es un dato correcto que quizá no lo sea. Marcarlo inválido sería mentir.
    await expect(municipio).not.toHaveAttribute('aria-invalid', 'true');
    const descrito = (await municipio.getAttribute('aria-describedby')) ?? '';
    expect(descrito).toContain('sol-municipio-revision');
    await expect(page.locator('#sol-municipio-revision'))
      .toHaveText('Lo leímos de la factura y no quedamos seguros. Compruébelo y confírmelo.');
    // El nombre accesible del botón lleva la ETIQUETA, jamás el valor leído.
    const confirmar = page.getByRole('button', { name: 'Confirmar municipio' });
    await expect(confirmar).toBeVisible();
    expect(await confirmar.getAttribute('aria-label')).not.toContain('MEDELLÍN');
  });

  test('lectura VACÍA: cero marcas, la frase no habla de revisar y se puede enviar a mano (AC5)', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    const cola = await mockCola(page);
    const cap = await mockCanal(page, { lectura: leida(EXTRACCION_VACIA) });
    await page.goto('/flito/soat/solicitud');

    await page.getByLabel('VIN').fill(VIN);
    await adjuntar(page);
    await expect(page.getByRole('status')
      .filter({ hasText: 'No pudimos sacar los datos del propietario de esta factura.' })).toBeVisible();

    // Las nueve claves llegaron `{valor: null, confiable: false}`: marcarlas por `confiable` a secas
    // pondría nueve avisos ámbar y el envío bloqueado sin nada que confirmar (AC3 tumbando al AC5).
    await expect(chipRevisar(page)).toHaveCount(0);
    await expect(page.getByText('✓ Factura leída')).toHaveCount(0);
    await expect(falta(page)).not.toContainText('revisar');
    await expect(falta(page)).toContainText('Tipo de documento');

    await control(page, 'tipoDocumento').selectOption('CC');
    await control(page, 'numeroDocumento').fill('1020304050');
    await control(page, 'nombres').fill('MARÍA FERNANDA');
    await control(page, 'apellidos').fill('GÓMEZ RUIZ');
    await control(page, 'correo').fill(CORREO);
    await control(page, 'celular').fill('3001234567');
    await control(page, 'direccion').fill('Calle 1 # 2-3');
    await control(page, 'municipio').fill('Medellín');
    await control(page, 'departamento').fill('Antioquia');
    await btnConsultar(page).click();
    await expect(fichaRunt(page)).toBeVisible();

    cola.items = [{ id: UUID_SOLICITUD }];
    await btnEnviar(page).click();
    await expect(page).toHaveURL(/\/flito\/soat$/);
    expect(cap.altas).toHaveLength(1);
    // Todo tecleado ⇒ todo `manual`, y ninguno `factura`.
    const mapa = procedenciaDe(cap.altas[0].post ?? '');
    expect(Object.values(mapa).every((v) => v === 'manual')).toBe(true);
  });

  test('con la lectura CAÍDA se envía igual: el 503 no añade pendientes (AC5)', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    const cola = await mockCola(page);
    const cap = await mockCanal(page, { lectura: fallo(503, 'El lector no está disponible') });
    await page.goto('/flito/soat/solicitud');

    await page.getByLabel('VIN').fill(VIN);
    await adjuntar(page);
    await expect(page.getByRole('alert').filter({ hasText: 'No pudimos leer la factura.' })).toBeVisible();

    await control(page, 'tipoDocumento').selectOption('CC');
    await control(page, 'numeroDocumento').fill('1020304050');
    await control(page, 'nombres').fill('MARÍA FERNANDA');
    await control(page, 'apellidos').fill('GÓMEZ RUIZ');
    await control(page, 'correo').fill(CORREO);
    await control(page, 'celular').fill('3001234567');
    await control(page, 'direccion').fill('Calle 1 # 2-3');
    await control(page, 'municipio').fill('Medellín');
    await control(page, 'departamento').fill('Antioquia');
    await btnConsultar(page).click();
    await expect(fichaRunt(page)).toBeVisible();

    await expect(falta(page)).toHaveCount(0);
    cola.items = [{ id: UUID_SOLICITUD }];
    await btnEnviar(page).click();
    await expect(page).toHaveURL(/\/flito\/soat$/);
    expect(cap.altas).toHaveLength(1);
  });
});

// ═════════════════════════ AC4 · natural o jurídica, según lo leído ══════════════════════════════

test.describe('HU #12094 · AC4 — NIT ⇒ razón social; natural ⇒ nombres y apellidos', () => {
  test('con NIT leído se monta «Razón social» y desaparecen «Nombre/s» y «Apellido/s»', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    const cola = await mockCola(page);
    const cap = await mockCanal(page, {
      lectura: leida({
        ...EXTRACCION_COMPLETA,
        tipoDocumento: campo('NIT'), numeroDocumento: campo('9001234561'),
        // El borde ya garantiza la excluyencia, pero si un día devolviera las dos formas, enviarlas
        // juntas sería un 400 explícito: manda el tipo VIGENTE en el formulario.
        razonSocial: campo('TRANSPORTES X SAS'), nombres: campo(null), apellidos: campo(null),
      }),
    });
    await page.goto('/flito/soat/solicitud');
    await prepararConLectura(page);

    await expect(control(page, 'razonSocial')).toHaveValue('TRANSPORTES X SAS');
    await expect(control(page, 'nombres')).toHaveCount(0);
    await expect(control(page, 'apellidos')).toHaveCount(0);

    // Borrar el campo visible bloquea el envío.
    await control(page, 'razonSocial').fill('');
    await expect(falta(page)).toContainText('Razón social');
    await expect(btnEnviar(page)).toHaveAttribute('aria-disabled', 'true');
    await control(page, 'razonSocial').fill('TRANSPORTES X SAS');

    cola.items = [{ id: UUID_SOLICITUD }];
    await btnEnviar(page).click();
    await expect(page).toHaveURL(/\/flito\/soat$/);

    const cuerpo = cap.altas[0].post ?? '';
    expect(cuerpo).not.toContain('name="nombres"');
    expect(cuerpo).not.toContain('name="apellidos"');
    const mapa = procedenciaDe(cuerpo);
    expect(Object.keys(mapa)).not.toContain('nombres');
    expect(Object.keys(mapa)).not.toContain('apellidos');
    // La razón social se corrigió a mano (se borró y se reescribió): eso es `manual`, no `factura`.
    expect(mapa.razonSocial).toBe('manual');
    expect(mapa.tipoDocumento).toBe('factura');
  });

  test('con CC leído se montan nombres y apellidos y no hay razón social', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await mockCanal(page, { lectura: leida(EXTRACCION_COMPLETA) });
    await page.goto('/flito/soat/solicitud');
    await page.getByLabel('VIN').fill(VIN);
    await control(page, 'correo').fill(CORREO);
    await adjuntar(page);
    await expect(page.getByText('✓ Factura leída')).toBeVisible();

    await expect(control(page, 'nombres')).toHaveValue('MARÍA FERNANDA');
    await expect(control(page, 'razonSocial')).toHaveCount(0);
    await control(page, 'nombres').fill('');
    await expect(falta(page)).toHaveText('Para enviar falta: consultar el RUNT y Nombre/s.');
  });
});

// ═════════════════════════ AC6 · qué se sobrescribe, y qué no ════════════════════════════════════

test.describe('HU #12094 · AC6 — la sobrescritura se avisa y se acepta campo a campo', () => {
  test('la banda NOMBRA los campos, solo reemplaza lo marcado y lo rechazado conserva valor y «manual»', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    const cola = await mockCola(page);
    const cap = await mockCanal(page, {
      porLlamada: [
        leida(EXTRACCION_COMPLETA),
        leida({
          ...EXTRACCION_COMPLETA,
          municipio: campo('BOGOTÁ'), celular: campo('3111111111'),
          // Un valor NULO en la segunda lectura no puede dejar el formulario más vacío que antes.
          departamento: campo(null),
        }),
      ],
    });
    await page.goto('/flito/soat/solicitud');

    await adjuntar(page);
    await expect(page.getByText('✓ Factura leída')).toBeVisible();
    // Se corrigen dos campos a mano: pasan a `manual` y son lo único que el AC6 protege.
    await control(page, 'municipio').fill('ENVIGADO');
    await control(page, 'celular').fill('3005555555');

    await page.getByRole('button', { name: 'Volver a leer' }).click();

    const banda = page.getByRole('status').filter({ hasText: 'Esta factura dice otra cosa en 2 datos' });
    await expect(banda).toBeVisible();
    await expect(banda.getByText('Municipio')).toBeVisible();
    await expect(banda.getByText('Celular')).toBeVisible();
    // Hasta pulsar «Reemplazar», el campo CONSERVA lo tecleado.
    await expect(control(page, 'municipio')).toHaveValue('ENVIGADO');
    await expect(control(page, 'celular')).toHaveValue('3005555555');
    // El departamento vino `null` en la segunda lectura: ni se vacía ni entra a la banda.
    await expect(control(page, 'departamento')).toHaveValue('ANTIOQUIA');
    await expect(banda.getByText('Departamento')).toHaveCount(0);

    // Se desmarca el celular: se queda como está.
    await banda.getByRole('checkbox', { name: 'Celular' }).uncheck();
    await expect(banda.getByRole('button', { name: 'Reemplazar 1 dato' })).toBeVisible();
    await banda.getByRole('button', { name: 'Reemplazar 1 dato' }).click();

    await expect(control(page, 'municipio')).toHaveValue('BOGOTÁ');
    await expect(control(page, 'celular')).toHaveValue('3005555555');
    await expect(page.getByRole('status').filter({ hasText: 'Esta factura dice otra cosa' })).toHaveCount(0);

    await control(page, 'correo').fill(CORREO);
    await page.getByLabel('VIN').fill(VIN);
    await btnConsultar(page).click();
    await expect(fichaRunt(page)).toBeVisible();
    cola.items = [{ id: UUID_SOLICITUD }];
    await btnEnviar(page).click();
    await expect(page).toHaveURL(/\/flito\/soat$/);

    const mapa = procedenciaDe(cap.altas[0].post ?? '');
    // Lo aceptado vuelve a ser de la factura; lo rechazado conserva su procedencia `manual`.
    expect(mapa.municipio).toBe('factura');
    expect(mapa.celular).toBe('manual');
    expect(mapa.nombres).toBe('factura');
  });

  test('«Conservar lo que escribí» no cambia NI UN valor', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await mockCanal(page, {
      porLlamada: [
        leida(EXTRACCION_COMPLETA),
        leida({ ...EXTRACCION_COMPLETA, municipio: campo('BOGOTÁ'), direccion: campo('CRA 7 # 1-2') }),
      ],
    });
    await page.goto('/flito/soat/solicitud');

    await adjuntar(page);
    await expect(page.getByText('✓ Factura leída')).toBeVisible();
    await control(page, 'municipio').fill('ENVIGADO');
    await control(page, 'direccion').fill('CL 1 # 1-1');

    await page.getByRole('button', { name: 'Volver a leer' }).click();
    const banda = page.getByRole('status').filter({ hasText: 'Esta factura dice otra cosa en 2 datos' });
    await expect(banda).toBeVisible();
    await banda.getByRole('button', { name: 'Conservar lo que escribí' }).click();

    await expect(control(page, 'municipio')).toHaveValue('ENVIGADO');
    await expect(control(page, 'direccion')).toHaveValue('CL 1 # 1-1');
    await expect(page.getByRole('status').filter({ hasText: 'Esta factura dice otra cosa' })).toHaveCount(0);
  });

  test('quitar el archivo descarta la lectura pero NO borra lo que ya está escrito', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await mockCanal(page, { lectura: leida(EXTRACCION_COMPLETA) });
    await page.goto('/flito/soat/solicitud');

    await page.getByLabel('VIN').fill(VIN);
    await control(page, 'correo').fill(CORREO);
    await adjuntar(page);
    await expect(page.getByText('✓ Factura leída')).toBeVisible();
    await page.getByRole('button', { name: 'Quitar el archivo' }).click();

    await expect(page.getByText('✓ Factura leída')).toHaveCount(0);
    await expect(control(page, 'municipio')).toHaveValue('MEDELLÍN');
    await expect(falta(page)).toHaveText('Para enviar falta: consultar el RUNT y Factura de venta.');
  });
});

// ═════════════════════════ AC7 · el mapa de procedencia ══════════════════════════════════════════

test.describe('HU #12094 · AC7 — la procedencia viaja y no se pinta', () => {
  test('el mapa es JSON, sus claves son las del comprador y confirmar NO cambia la procedencia', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    const cola = await mockCola(page);
    const cap = await mockCanal(page, {
      lectura: leida({ ...EXTRACCION_COMPLETA, municipio: campo('MEDELLÍN', false) }),
    });
    await page.goto('/flito/soat/solicitud');
    await prepararConLectura(page);

    // Confirmar sin editar: sigue siendo lo que puso el concesionario.
    await page.getByRole('button', { name: 'Confirmar municipio' }).click();
    // Corregir: pasa a `manual`.
    await control(page, 'direccion').fill('CRA 7 # 1-2');

    cola.items = [{ id: UUID_SOLICITUD }];
    await btnEnviar(page).click();
    await expect(page).toHaveURL(/\/flito\/soat$/);

    const cuerpo = cap.altas[0].post ?? '';
    const mapa = procedenciaDe(cuerpo);
    expect(mapa.municipio).toBe('factura');
    expect(mapa.direccion).toBe('manual');
    expect(mapa.nombres).toBe('factura');
    // Las nueve claves del `.strict()` y NI UNA más: `correo` no es del comprador, y las cuatro
    // documentales no son campos de esta pantalla. Declarar cualquiera de ellas es un 400.
    const permitidas = [
      'nombres', 'apellidos', 'razonSocial', 'tipoDocumento', 'numeroDocumento', 'direccion',
      'municipio', 'departamento', 'celular',
    ];
    for (const clave of Object.keys(mapa)) expect(permitidas).toContain(clave);
    for (const prohibida of ['correo', 'placa', 'vin', 'nombreCompleto']) {
      expect(Object.keys(mapa)).not.toContain(prohibida);
    }
    // `'runt'` no se emite NUNCA: ningún campo del propietario se prellena desde el registro.
    expect(Object.values(mapa)).not.toContain('runt');
    // Y lo documental de la factura no se cuela en el alta: el VIN que viaja es el TECLEADO.
    expect(campoMultipart(cuerpo, 'vin')).toBe(VIN);
    expect(cuerpo).not.toContain('9FKRG2222T2042405');
    expect(cuerpo).not.toContain('XYZ987');
  });

  test('la procedencia NO se pinta campo a campo: cero etiquetas de origen en el bloque 3', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await mockCanal(page, { lectura: leida(EXTRACCION_COMPLETA) });
    await page.goto('/flito/soat/solicitud');
    await adjuntar(page);
    await expect(page.getByText('✓ Factura leída')).toBeVisible();

    const propietario = page.getByRole('region', { name: '3 · Propietario' });
    await expect(propietario.getByText('de la factura', { exact: false })).toHaveCount(0);
    await expect(propietario.getByText('manual', { exact: false })).toHaveCount(0);
    // Lo que dice de dónde salieron los valores es el CONTEXTO, en una línea y no en nueve.
    await expect(propietario.getByText('Estos datos los tomamos de su factura de venta.')).toBeVisible();
  });
});

// ═════════════════════════ AC8 · la URL no toca PII en ningún punto ══════════════════════════════

test.describe('HU #12094 · AC8 — nada personal sale del cuerpo de los POST', () => {
  test('ni la lectura ni el alta ponen un solo dato en la URL', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    const cola = await mockCola(page);
    const urls: string[] = [];
    page.on('framenavigated', () => urls.push(page.url()));
    const cap = await mockCanal(page, { lectura: leida(EXTRACCION_COMPLETA) });
    await page.goto('/flito/soat/solicitud');
    await prepararConLectura(page);

    cola.items = [{ id: UUID_SOLICITUD }];
    await btnEnviar(page).click();
    await expect(page).toHaveURL(/\/flito\/soat$/);

    expect(cap.lecturas).toHaveLength(1);
    expect(new URL(cap.lecturas[0].url).search).toBe('');
    for (const url of [...urls, page.url()]) {
      expect(url).not.toContain('1020304050');
      expect(url).not.toContain('3009999999');
      expect(url).not.toContain('MEDELL');
      expect(url).not.toContain(VIN);
    }
  });
});

// ═════════════════════════ La ficha de ayuda in-app, con lo que esta HU cambió ═══════════════════
//
// El gate de ayuda de AGENTS.md: el diff cambia lo que el Cliente ve y hace en la pantalla que
// `content/ayuda/soat.md` describe, así que la ficha tiene que decirlo. El caso hermano de
// `soat-cliente-solicitud.spec.ts` cubre lo de la #11967/#12079/#12091 y **no se toca**: sus
// literales siguen siendo verdad. Este añade los de la #12094.
//
// Los rótulos NO se teclean aquí: se leen de la pantalla y se le exigen luego a la ficha. Así, el día
// que el chip o la marca cambien de texto, la ficha se pone roja sin que nadie se acuerde de ella.
//
// Se abre con **Operaciones** y no con el Cliente porque `ayudaFlito.puedeVerEntradaAyuda` niega toda
// ficha al rol `cliente`: el Cliente hace este trámite, pero quien lee la ayuda es quien lo atiende.
test.describe('HU #12094 · la ficha de ayuda in-app del módulo SOAT', () => {
  test('la ficha describe la lectura automática, el prellenado, la revisión y la sobrescritura', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await mockCanal(page, {
      porLlamada: [
        leida({
          ...EXTRACCION_COMPLETA,
          municipio: campo('MEDELLÍN', false), celular: campo('3009999999', false),
        }),
        leida({ ...EXTRACCION_COMPLETA, municipio: campo('BOGOTÁ') }),
      ],
    });
    await page.goto('/flito/soat/solicitud');
    await prepararConLectura(page);

    // ── 1 · Lo que la pantalla dice HOY ─────────────────────────────────────────────────────────
    const chipLeida = (await page.getByText('✓ Factura leída').innerText()).trim();
    const marca = (await chipRevisar(page).first().innerText()).trim();
    // Con dos dudosos y el resto completo, la frase del primario es exactamente esta.
    const fraseFaltan = (await falta(page).innerText()).trim();
    expect(fraseFaltan).toBe('Para enviar falta: revisar 2 datos leídos.');

    // La banda de sobrescritura, con sus dos salidas.
    await control(page, 'municipio').fill('ENVIGADO');
    await page.getByRole('button', { name: 'Volver a leer' }).click();
    const banda = page.getByRole('status').filter({ hasText: 'Esta factura dice otra cosa' });
    await expect(banda).toBeVisible();
    const rotuloConservar = (await banda.getByRole('button', { name: 'Conservar lo que escribí' }).innerText()).trim();

    // ── 2 · La ficha PUBLICADA ──────────────────────────────────────────────────────────────────
    await loginAs(page, OPERACIONES_USER);
    await page.goto('/flito/ayuda/soat');
    const ficha = page.getByRole('article', { name: 'SOAT' });
    await expect(ficha).toBeVisible();

    for (const literal of [chipLeida, marca, fraseFaltan, rotuloConservar]) {
      await expect(ficha, literal).toContainText(literal);
    }

    for (const frase of [
      // 1 · la lectura arranca sola y se ve mientras dura, sin prometer que siempre acierte.
      'FLITO la lee sola',
      'Leyendo la factura…',
      'La lectura es una ayuda, no una garantía',
      // 2 · el propietario llega escrito, se corrige entero, y el correo es suyo.
      'ya escritos y se pueden corregir todos',
      'tipo y número de documento incluidos',
      'El correo electrónico lo escribe usted',
      'es el único campo que queda vacío',
      // 3 · los dudosos y cómo se resuelven.
      'compruébelos y pulse Confirmar, o corríjalos',
      // 4 · la sobrescritura se elige, no se sufre.
      'no los pisa sin avisar',
      'pulse Reemplazar',
      'Lo que no acepte conserva su valor',
      // 5 · el límite, en «Qué no hace»: acelera y no bloquea.
      'La lectura de la factura acelera el trabajo, pero no lo bloquea',
      'envíe la solicitud igual',
      'Ningún fallo de la lectura impide crear la solicitud',
      // Y los estados nuevos del bloque 2.
      'No se pudo leer',
      'Volver a leer la factura',
      'No pudimos sacar los datos del propietario de esta factura',
    ]) {
      await expect(ficha, frase).toContainText(frase);
    }
  });
});
