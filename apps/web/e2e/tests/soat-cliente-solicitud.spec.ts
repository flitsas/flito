// HU #11914 — Alta de la solicitud de SOAT del canal Cliente, con RUNT y bloqueo RN-01.
//
// Eslabón 2 de 4 del Feature #11912. Continúa `rol-cliente-identidad.spec.ts` (#11913), que dio
// identidad, menú y aterrizaje; aquí empieza lo que el Cliente puede HACER.
//
// ── Método, porque sin esto varios asertos pasarían por vacío ───────────────────────────────────
//
//  1. **Los asertos negativos hacen la mitad del trabajo.** Tres de los cinco desenlaces del AC2 se
//     ven distintos entre sí y solo entre sí: afirmar que sale el texto correcto no mata al mutante
//     que además deja avanzar, y afirmar que sale «no se pudo consultar» no distingue el 503 del
//     «el RUNT no lo conoce». Cada caso lleva su negativo.
//  2. **El RUNT se intercepta SIEMPRE.** Nunca contra el servicio real: tarda hasta un minuto y no
//     se puede llamar desde CI. `page.route` sobre `**/flito/soat/cliente/preconsulta`.
//  3. **`/cliente` y `/cliente/preconsulta` son dos rutas y el orden importa.** Playwright evalúa
//     las rutas en orden INVERSO de registro, así que la del alta se registra primero y la de la
//     preconsulta después; además la del alta va anclada con `$` para que no se coma a la otra.
//  4. **Dos sesiones de Cliente**, con el canal encendido y apagado. Ver `CLIENTE_CON_CANAL`.
//
// El backend va mockeado, como en el resto de la carpeta.
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, CLIENTE_USER, CLIENTE_CON_CANAL, OPERACIONES_USER } from '../helpers/auth';

const PLACA = 'ABC123';
const VIN = '9BWZZZ377VT004251';
const UUID_RECHAZADA = '11111111-2222-4333-8444-555555555555';

const RE_PRECONSULTA = /\/api\/flito\/soat\/cliente\/preconsulta$/;
const RE_ALTA = /\/api\/flito\/soat\/cliente$/;
const RE_COLA = /\/api\/flito\/soat\?/;

/** Lo que devuelve la preconsulta buena. Los SIETE datos del AC1 y ni uno más. */
const RUNT_OK = {
  vehiculo: {
    placa: PLACA, vin: VIN, marca: 'RENAULT', linea: 'LOGAN', modelo: '2019',
    clase: 'AUTOMOVIL', cilindraje: '1600', tipoServicio: 'Particular',
  },
  organismo: { codigo: '05001', nombre: 'STRIA TTEyTTO MEDELLIN' },
  // `null` es el caso NORMAL: el RUNT casi nunca trae propietario y eso no es un fallo.
  propietario: null,
};

/** Una fila de la cola con la forma que `FlitoSoat` espera, ya recortada como al Cliente. */
function fila(over: Record<string, unknown> = {}) {
  return {
    id: UUID_RECHAZADA, vin: VIN, placa: PLACA, marca: 'RENAULT', linea: 'LOGAN',
    cilindraje: '1600', carroceria: 'SEDAN', tipoServicio: 'Particular',
    estado: 'pendiente_revision', esMultiplePropietario: false, companiaNombre: 'Transportes Sur',
    organismoNombre: 'STRIA TTEyTTO MEDELLIN',
    compradores: [{ nombreCompleto: 'María Gómez', numeroDocumento: '1020304050', orden: 0, porcentajeParticipacion: null }],
    tramitesFlit: [], tipoTramite: null, fechaAprobacion: null, fechaCreacion: '2026-08-01T10:00:00Z',
    enviadoEn: null, pagadoEn: null, estancado: false, motivoRechazo: null,
    creadoEn: '2026-08-01T10:00:00Z',
    ...over,
  };
}

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** La cola y sus facetas. `items` se lee en cada petición, así que el test puede cambiarlo. */
async function mockCola(page: Page, items: unknown[] = []) {
  const estado = { items };
  await page.route(RE_COLA, (route) => json(route, 200, {
    items: estado.items, total: estado.items.length, page: 1, pageSize: 50,
  }));
  await page.route(/\/api\/flito\/soat\/facetas/, (route) =>
    json(route, 200, { companias: [], organismos: [], proveedores: [] }));
  return estado;
}

/** El fallo del canal, con el `codigo` que es su verdadero discriminador. */
const falloCanal = (status: number, codigo: string, error: string, extra: Record<string, unknown> = {}) =>
  ({ status, cuerpo: { error, codigo, ...extra } });

/**
 * Deja la pantalla del alta con el bloque 1 ya resuelto.
 *
 * Devuelve la lista de peticiones al ALTA, que varios tests necesitan para afirmar que NO se envió
 * nada — el aserto que separa «se paró antes» de «se paró después».
 */
async function abrirFormularioConRunt(page: Page, respuestaAlta?: { status: number; cuerpo: unknown }) {
  const altas: string[] = [];
  await page.route(RE_ALTA, (route) => {
    altas.push(route.request().url());
    return respuestaAlta
      ? json(route, respuestaAlta.status, respuestaAlta.cuerpo)
      : json(route, 201, { id: UUID_RECHAZADA, estado: 'pendiente_revision' });
  });
  await page.route(RE_PRECONSULTA, (route) => json(route, 200, RUNT_OK));

  await page.goto('/flito/soat/solicitud');
  await page.getByLabel('Placa').fill(PLACA);
  await page.getByLabel('VIN').fill(VIN);
  await page.getByRole('button', { name: 'Consultar el RUNT' }).click();
  await expect(page.getByRole('region', { name: 'Datos del RUNT' })).toBeVisible();
  return altas;
}

/** Rellena el bloque 2 y adjunta un PDF de mentira, que es lo que el servidor rechaza por bytes. */
async function completarSolicitud(page: Page, { nombre = 'MARÍA FERNANDA GÓMEZ RUIZ' } = {}) {
  await page.getByLabel('Tipo de documento').selectOption('CC');
  await page.getByLabel('Número de documento').fill('1020304050');
  if (nombre) await page.getByLabel('Nombre completo o razón social').fill(nombre);
  await page.locator('input[type="file"]').setInputFiles({
    name: 'factura.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 e2e'),
  });
}

// ═════════════════════════ AC1 · el formulario y sus tres bloques ════════════════════════════════

test.describe('HU #11914 · AC1 — la puerta de entrada y los datos que no se teclean', () => {
  test('la cola vacía del Cliente ya no le manda al Tablero, que no tiene', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);

    await page.goto('/flito/soat');
    await expect(page.getByText('Todavía no hay ningún SOAT de su compañía en FLITO.')).toBeVisible();
    // El aserto que mata al mutante «dejar el vacío de Operaciones»: el positivo de arriba pasaría
    // igual si alguien concatenara los dos textos.
    await expect(page.getByText(/Sincroniza desde el Tablero/)).toHaveCount(0);
  });

  test('«Solicitar SOAT» lleva a la sub-ruta y el menú sigue teniendo UN ítem, marcado', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page, [fila()]);

    await page.goto('/flito/soat');
    const enlace = page.getByRole('link', { name: 'Solicitar SOAT' });
    await expect(enlace).toBeVisible();
    await expect(enlace).toHaveAttribute('href', '/flito/soat/solicitud');
    await enlace.click();
    await expect(page).toHaveURL(/\/flito\/soat\/solicitud$/);

    // Sin el aserto de `aria-current` esto pasaría también con `/flito/solicitud`: el conteo seguiría
    // en 1 y el ítem estaría apagado, o sea el Cliente «en ninguna parte» de su propio menú.
    const nav = page.getByRole('navigation', { name: 'Navegación principal' });
    await expect(nav.getByRole('link')).toHaveCount(1);
    await expect(nav.getByRole('link', { name: 'SOAT' })).toHaveAttribute('aria-current', 'page');
  });

  test('los siete datos del RUNT se ven y NINGUNO es un control de formulario', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await abrirFormularioConRunt(page);

    const ficha = page.getByRole('region', { name: 'Datos del RUNT' });
    for (const valor of ['RENAULT', 'LOGAN', '2019', 'AUTOMOVIL', 'Particular', '1600', 'STRIA TTEyTTO MEDELLIN']) {
      await expect(ficha.getByText(valor, { exact: true })).toBeVisible();
    }
    // Los DOS asertos, y hacen falta los dos: un `<input disabled>` sigue teniendo rol `textbox` en
    // varios motores, así que el primero solo no mata al mutante que resuelve la ficha con campos
    // deshabilitados.
    await expect(page.getByRole('textbox', { name: /Marca|Cilindraje|Organismo/ })).toHaveCount(0);
    await expect(page.locator('input[disabled]')).toHaveCount(0);
  });

  test('la ficha NO presenta la placa como confirmada por el RUNT: es el eco de la consulta', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await abrirFormularioConRunt(page);

    await expect(page.getByRole('region', { name: 'Datos del RUNT' }).getByText(PLACA)).toHaveCount(0);
    // Y sigue estando donde el usuario la escribió.
    await expect(page.getByLabel('Placa')).toHaveValue(PLACA);
  });

  test('cambiar el VIN tras consultar invalida el resultado y bloquea el envío', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await abrirFormularioConRunt(page);

    await page.getByLabel('VIN').fill(`${VIN.slice(0, -1)}9`);

    await expect(page.getByText('Cambió la placa o el VIN: vuelva a consultar el RUNT antes de enviar.')).toBeVisible();
    // La ficha vieja no puede quedarse: con ella se enviaría una solicitud con los datos técnicos de
    // un vehículo y la placa de otro.
    await expect(page.getByRole('region', { name: 'Datos del RUNT' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Enviar la solicitud' })).toBeDisabled();
  });
});

// ═════════════════════════ AC2 · los cinco desenlaces de la consulta ═════════════════════════════

test.describe('HU #11914 · AC2 — el RUNT no responde de una sola manera', () => {
  test('mientras consulta: el botón se apaga y hay un aviso de espera', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);

    let liberar = () => {};
    const puerta = new Promise<void>((r) => { liberar = r; });
    await page.route(RE_PRECONSULTA, async (route) => { await puerta; return json(route, 200, RUNT_OK); });

    await page.goto('/flito/soat/solicitud');
    await page.getByLabel('Placa').fill(PLACA);
    await page.getByLabel('VIN').fill(VIN);
    await page.getByRole('button', { name: 'Consultar el RUNT' }).click();

    const boton = page.getByRole('button', { name: 'Consultando el RUNT…' });
    await expect(boton).toBeVisible();
    // Sin el `disabled` caben dos consultas en vuelo y gana la que llegue última.
    await expect(boton).toBeDisabled();
    await expect(page.getByText('La consulta puede tardar hasta un minuto. No cierre esta página.')).toBeVisible();

    liberar();
    await expect(page.getByRole('region', { name: 'Datos del RUNT' })).toBeVisible();
  });

  test('503 — banda con reintento ENFOCADO y lo tecleado intacto', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    const f = falloCanal(503, 'runt_no_disponible', 'No fue posible consultar el RUNT en este momento.');
    await page.route(RE_PRECONSULTA, (route) => json(route, f.status, f.cuerpo));

    await page.goto('/flito/soat/solicitud');
    await page.getByLabel('Placa').fill(PLACA);
    await page.getByLabel('VIN').fill(VIN);
    await page.getByRole('button', { name: 'Consultar el RUNT' }).click();

    await expect(page.getByText('No pudimos consultar el RUNT.')).toBeVisible();
    const reintento = page.getByRole('button', { name: 'Volver a consultar' });
    await expect(reintento).toBeFocused();
    // El aserto que caza al mutante «limpiar el formulario al fallar».
    await expect(page.getByLabel('VIN')).toHaveValue(VIN);
  });

  test('sin registro — otro texto, y NO el del servicio caído', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    const f = falloCanal(422, 'runt_sin_registro', 'El RUNT no tiene registrado un vehículo con esa placa y ese VIN.');
    await page.route(RE_PRECONSULTA, (route) => json(route, f.status, f.cuerpo));

    await page.goto('/flito/soat/solicitud');
    await page.getByLabel('Placa').fill(PLACA);
    await page.getByLabel('VIN').fill(VIN);
    await page.getByRole('button', { name: 'Consultar el RUNT' }).click();

    await expect(page.getByText('El RUNT no tiene registrado ningún vehículo con esa placa y ese VIN.')).toBeVisible();
    // El fallo más probable de esta HU: colapsar 2a y 2b en un solo mensaje.
    await expect(page.getByText('No pudimos consultar el RUNT.')).toHaveCount(0);
  });

  test('organismo fuera de catálogo — el nombre sale del CAMPO, no de las comillas del mensaje', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    // El corazón de este test: el CAMPO y el TEXTO dicen organismos DISTINTOS.
    //
    // Es la única forma de matar al mutante que vuelve a sacar el nombre de las `«…»` del mensaje —y
    // hubo una versión de esta pantalla que lo hacía—. Con el mismo nombre en los dos sitios, un
    // `/«([^»]+)»/` pasaría este test tan verde como la lectura del campo. Aquí, si alguien vuelve al
    // parseo, la pantalla escribe «SALIDO DEL MENSAJE» y el aserto negativo lo caza.
    await page.route(RE_PRECONSULTA, (route) => json(route, 422, {
      error: 'El organismo de tránsito que reporta el RUNT («SALIDO DEL MENSAJE») no está en el catálogo de FLITO.',
      codigo: 'organismo_no_catalogado',
      organismoNombre: 'STT DE PUEBLO CHICO',
    }));

    await page.goto('/flito/soat/solicitud');
    await page.getByLabel('Placa').fill(PLACA);
    await page.getByLabel('VIN').fill(VIN);
    await page.getByRole('button', { name: 'Consultar el RUNT' }).click();

    await expect(page.getByText('Todavía no atendemos el organismo de tránsito de este vehículo.')).toBeVisible();
    await expect(page.getByText(`El RUNT lo reporta en STT DE PUEBLO CHICO, que aún no está habilitado en FLITO. Escríbale a su contacto en FLIT con la placa ${PLACA}.`)).toBeVisible();
    await expect(page.getByText(/SALIDO DEL MENSAJE/)).toHaveCount(0);

    // Afirmar solo el mensaje deja vivo el mutante que pinta la ficha igual y SÍ deja avanzar.
    await expect(page.getByLabel('Número de documento')).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Enviar la solicitud' })).toHaveCount(0);
  });

  test('organismo `null` — se afirma que el RUNT no lo reporta, que es OTRA cosa', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    // La clave VIAJA valiendo `null`: el servidor está afirmando algo del RUNT, no callándose. Es lo
    // que separa esta redacción de la de arriba, y por eso el contrato manda la clave siempre.
    await page.route(RE_PRECONSULTA, (route) => json(route, 422, {
      error: 'El organismo de tránsito que reporta el RUNT no está en el catálogo de FLITO.',
      codigo: 'organismo_no_catalogado',
      organismoNombre: null,
    }));

    await page.goto('/flito/soat/solicitud');
    await page.getByLabel('Placa').fill(PLACA);
    await page.getByLabel('VIN').fill(VIN);
    await page.getByRole('button', { name: 'Consultar el RUNT' }).click();

    await expect(page.getByText('El RUNT no reporta el organismo de tránsito de este vehículo, y sin ese dato no podemos radicar la solicitud.')).toBeVisible();
    // Mata al mutante que colapsa `null` y «hay nombre» en una sola frase con un hueco.
    await expect(page.getByText(/lo reporta en/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Enviar la solicitud' })).toHaveCount(0);
  });

  test('el reintento CONSULTA otra vez: 503 y luego 200 pinta la ficha', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    let intentos = 0;
    await page.route(RE_PRECONSULTA, (route) => {
      intentos += 1;
      return intentos === 1
        ? json(route, 503, { error: 'caído', codigo: 'runt_no_disponible' })
        : json(route, 200, RUNT_OK);
    });

    await page.goto('/flito/soat/solicitud');
    await page.getByLabel('Placa').fill(PLACA);
    await page.getByLabel('VIN').fill(VIN);
    await page.getByRole('button', { name: 'Consultar el RUNT' }).click();
    await expect(page.getByText('No pudimos consultar el RUNT.')).toBeVisible();

    // Mata al mutante «un botón que solo limpia el error sin volver a llamar».
    await page.getByRole('button', { name: 'Volver a consultar' }).click();
    await expect(page.getByRole('region', { name: 'Datos del RUNT' })).toBeVisible();
    expect(intentos).toBe(2);
  });
});

// ═════════════════════════ AC3 · «Ya tiene SOAT vigente» ═════════════════════════════════════════

test.describe('HU #11914 · AC3 — el modal del SOAT vigente', () => {
  test('se abre con su propio título, no habla de «cola» y no radica nada', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    const altas: string[] = [];
    await page.route(RE_ALTA, (route) => { altas.push(route.request().url()); return json(route, 201, {}); });
    await page.route(RE_PRECONSULTA, (route) => json(route, 409, {
      error: 'El RUNT reporta que este vehículo ya tiene un SOAT vigente.', codigo: 'soat_vigente',
    }));

    await page.goto('/flito/soat/solicitud');
    await page.getByLabel('Placa').fill(PLACA);
    await page.getByLabel('VIN').fill(VIN);
    await page.getByRole('button', { name: 'Consultar el RUNT' }).click();

    const modal = page.getByRole('dialog', { name: 'Este vehículo ya tiene SOAT vigente' });
    await expect(modal).toBeVisible();
    await expect(modal.getByText('No hace falta comprar otro')).toBeVisible();
    // Los dos asertos que lo separan del modal del AC4: aquel habla de la cola de FLITO y este no.
    await expect(modal.getByText(/cola/i)).toHaveCount(0);
    expect(altas).toHaveLength(0);
  });

  test('con fechaVencimiento se rotula en español y NO se corre un día por la zona horaria', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    // `yyyy-mm-dd` ya normalizado por el servidor. El día 1 es el que caza el fallo: pasar la cadena
    // a `new Date()` la lee como medianoche UTC y Colombia va cinco horas por detrás, así que el
    // modal habría escrito «31 de enero» — un día MENOS de vigencia en el dato por el que el usuario
    // decide si tiene que comprar otra póliza.
    await page.route(RE_PRECONSULTA, (route) => json(route, 409, {
      error: 'El RUNT reporta que este vehículo ya tiene un SOAT vigente.',
      codigo: 'soat_vigente',
      fechaVencimiento: '2027-02-01',
    }));

    await page.goto('/flito/soat/solicitud');
    await page.getByLabel('Placa').fill(PLACA);
    await page.getByLabel('VIN').fill(VIN);
    await page.getByRole('button', { name: 'Consultar el RUNT' }).click();

    const modal = page.getByRole('dialog', { name: 'Este vehículo ya tiene SOAT vigente' });
    await expect(modal.getByText(`Según el RUNT, la póliza del vehículo ${PLACA} está vigente hasta el 1 de febrero de 2027.`)).toBeVisible();
    await expect(modal.getByText(/31 de enero/)).toHaveCount(0);
  });

  test('sin fecha de vencimiento no se interpola un hueco vacío', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    // `fechaVencimiento` AUSENTE —no `null`, no cadena vacía—: es como el servidor dice «el RUNT
    // reporta la vigencia por estado». No es un caso degradado: es la otra redacción del modal.
    await page.route(RE_PRECONSULTA, (route) => json(route, 409, { error: 'vigente', codigo: 'soat_vigente' }));

    await page.goto('/flito/soat/solicitud');
    await page.getByLabel('Placa').fill(PLACA);
    await page.getByLabel('VIN').fill(VIN);
    await page.getByRole('button', { name: 'Consultar el RUNT' }).click();

    const modal = page.getByRole('dialog', { name: 'Este vehículo ya tiene SOAT vigente' });
    await expect(modal.getByText(`Según el RUNT, el vehículo ${PLACA} tiene una póliza SOAT vigente.`)).toBeVisible();
    // «vigente hasta el .» es lo que sale de rellenar una frase con una fecha que no llegó, y
    // «hasta el Invalid Date» lo que sale de rotularla igual. Los tres asertos negativos cubren las
    // tres formas de romperlo.
    await expect(modal.getByText(/hasta el/)).toHaveCount(0);
    await expect(modal.getByText('—')).toHaveCount(0);
    await expect(modal.getByText(/Invalid Date|NaN/)).toHaveCount(0);
  });

  test('«Consultar otro vehículo» limpia los campos y devuelve el foco a Placa', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await page.route(RE_PRECONSULTA, (route) => json(route, 409, { error: 'vigente', codigo: 'soat_vigente' }));

    await page.goto('/flito/soat/solicitud');
    await page.getByLabel('Placa').fill(PLACA);
    await page.getByLabel('VIN').fill(VIN);
    await page.getByRole('button', { name: 'Consultar el RUNT' }).click();
    await page.getByRole('button', { name: 'Consultar otro vehículo' }).click();

    await expect(page.getByLabel('Placa')).toHaveValue('');
    await expect(page.getByLabel('VIN')).toHaveValue('');
    await expect(page.getByLabel('Placa')).toBeFocused();
  });
});

// ═════════════════════════ AC4 · RN-01, el VIN ya está en FLITO ══════════════════════════════════

test.describe('HU #11914 · AC4 — el modal de la RN-01 y el camino a la subsanación', () => {
  test('propia y rechazada: lleva a /solicitud/:uuid y la URL no arrastra PII', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await page.route(/\/api\/flito\/soat\/[0-9a-f-]{36}$/, (route) =>
      json(route, 200, fila({ estado: 'rechazada' })));
    await page.route(RE_PRECONSULTA, (route) => json(route, 409, {
      error: 'Esta solicitud ya existe y fue rechazada.', codigo: 'vin_ya_tiene_soat',
      propia: true, id: UUID_RECHAZADA, estado: 'rechazada',
    }));

    await page.goto('/flito/soat/solicitud');
    await page.getByLabel('Placa').fill(PLACA);
    await page.getByLabel('VIN').fill(VIN);
    await page.getByRole('button', { name: 'Consultar el RUNT' }).click();

    const modal = page.getByRole('dialog', { name: 'Ese vehículo ya está en la cola de FLITO' });
    await expect(modal).toBeVisible();
    await expect(modal.getByText('No se puede crear otra solicitud')).toBeVisible();
    await modal.getByRole('link', { name: 'Abrir la solicitud rechazada' }).click();

    await expect(page).toHaveURL(new RegExp(`/flito/soat/solicitud/${UUID_RECHAZADA}$`));
    // El uuid es opaco y AGENTS.md §14 lo permite; la placa y el VIN, no. Mata al mutante «pasar la
    // placa por query para ahorrar una llamada».
    expect(page.url()).not.toContain(PLACA);
    expect(page.url()).not.toContain(VIN);
  });

  test('AJENA: sin botón primario, sin estado y sin fecha — es la frontera entre compañías', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    // El servidor recorta el 409 a `propia: false` justo para esto. Aquí se comprueba que la
    // pantalla NO inventa lo que le falta.
    await page.route(RE_PRECONSULTA, (route) => json(route, 409, {
      error: 'Este vehículo ya está registrado en FLITO con un SOAT.', codigo: 'vin_ya_tiene_soat',
      propia: false,
    }));

    await page.goto('/flito/soat/solicitud');
    await page.getByLabel('Placa').fill(PLACA);
    await page.getByLabel('VIN').fill(VIN);
    await page.getByRole('button', { name: 'Consultar el RUNT' }).click();

    const modal = page.getByRole('dialog', { name: 'Ese vehículo ya está en la cola de FLITO' });
    await expect(modal.getByText('Escríbale a su contacto en FLIT si cree que es un error.')).toBeVisible();
    await expect(modal.getByRole('link', { name: 'Abrir la solicitud rechazada' })).toHaveCount(0);
    await expect(modal.getByRole('link', { name: 'Ver la solicitud' })).toHaveCount(0);
    // Los negativos, que son los que de verdad cierran la fuga: devolver el mismo payload en los dos
    // casos dejaría sondear VINs y deducir la cartera de FLIT.
    await expect(modal.getByText(/Rechazada|Pendiente|Solicitado|Pagado|novedad/)).toHaveCount(0);
    await expect(modal.getByText(/\d{1,2}\/\d{1,2}\/\d{2,4}/)).toHaveCount(0);
  });

  test('desde la cola: la pastilla «Rechazada» existe y su detalle no filtra la trastienda', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page, [fila({ estado: 'rechazada' })]);

    await page.goto('/flito/soat');
    // Sin `ESTADOS_CLIENTE` estas dos pastillas no existen y no hay camino hasta una Rechazada.
    await expect(page.getByRole('button', { name: 'Pendiente de revisión' })).toBeVisible();
    await page.getByRole('button', { name: 'Rechazada', exact: true }).click();

    await page.getByRole('button', { name: 'Ver' }).first().click();
    const detalle = page.getByRole('dialog');
    await expect(detalle).toBeVisible();
    await expect(detalle.getByText(/Gestiona|Enviado por|Valor pagado/)).toHaveCount(0);
    // El historial es el registro INTERNO de la operación y hasta esta HU se le pintaba a todos.
    await expect(detalle.getByRole('button', { name: 'Ver el historial de estados' })).toHaveCount(0);
  });

  test('el historial SIGUE estando para Operaciones: el recorte es del Cliente, no de la pantalla', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockCola(page, [fila({ estado: 'rechazada' })]);

    await page.goto('/flito/soat');
    await page.getByRole('button', { name: 'Ver' }).first().click();
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Ver el historial de estados' })).toBeVisible();
  });
});

// ═════════════════════════ AC5 · el canal apagado y el PDF que no lo es ══════════════════════════

test.describe('HU #11914 · AC5 — la compañía sin canal, la carrera y el adjunto', () => {
  test('sin el flag no hay botón, hay tarjeta neutra, y la URL directa no dice «No tienes acceso»', async ({ page }) => {
    await loginAs(page, CLIENTE_USER);
    await mockCola(page, [fila()]);

    await page.goto('/flito/soat');
    await expect(page.getByRole('link', { name: 'Solicitar SOAT' })).toHaveCount(0);
    await expect(page.getByText('Su compañía todavía no tiene habilitado este canal, así que por ahora aquí solo puede consultar sus SOAT.')).toBeVisible();

    await page.goto('/flito/soat/solicitud');
    await expect(page.getByText('Su compañía todavía no tiene habilitado este canal, así que por ahora aquí solo puede consultar sus SOAT.')).toBeVisible();
    // El aserto que distingue esto de resolverlo con `NoAccess`: el permiso SÍ lo tiene.
    await expect(page.getByText(/No tienes acceso/)).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Volver a mis SOAT' })).toBeVisible();
  });

  test('la carrera: /me dice que sí y el POST responde 403 → «no se envió nada»', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await abrirFormularioConRunt(page, {
      status: 403,
      cuerpo: { error: 'Tu compañía no tiene habilitada la solicitud de SOAT sin trámite.', codigo: 'canal_desactivado' },
    });
    await completarSolicitud(page);
    await page.getByRole('button', { name: 'Enviar la solicitud' }).click();

    // Mata al mutante «un toast.error genérico dejando el formulario», que invita a reintentar en
    // bucle contra un canal cerrado.
    await expect(page.getByText('El canal se deshabilitó mientras llenaba el formulario, así que no se envió nada.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enviar la solicitud' })).toHaveCount(0);
  });

  test('un PDF que no lo es: la caja queda rechazada y dice POR QUÉ', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await abrirFormularioConRunt(page, {
      status: 400,
      cuerpo: { error: 'La factura de venta debe ser un PDF.', codigo: 'archivo_no_pdf' },
    });
    await completarSolicitud(page);
    await page.getByRole('button', { name: 'Enviar la solicitud' }).click();

    // El «Rechazado — cargar otro» del componente no basta: no dice por qué, y quien exportó desde el
    // celular no puede adivinarlo.
    await expect(page.getByRole('alert')
      .filter({ hasText: 'Ese archivo no es un PDF válido, aunque se llame así.' })).toBeVisible();
    await expect(page.getByText('Rechazado — cargar otro')).toBeVisible();
  });
});

// ═════════════════════════ Envío feliz, foco y PII ═══════════════════════════════════════════════

test.describe('HU #11914 · el envío', () => {
  test('una sola petición, aterrizaje en la cola y la fila nueva en «Pendiente de revisión»', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    const cola = await mockCola(page);
    const altas = await abrirFormularioConRunt(page);
    await completarSolicitud(page);

    cola.items = [fila()];
    await page.getByRole('button', { name: 'Enviar la solicitud' }).click();

    await expect(page).toHaveURL(/\/flito\/soat$/);
    await expect(page.getByText('Solicitud enviada. FLITO la va a revisar.')).toBeVisible();
    await expect(page.getByText('Pendiente de revisión').first()).toBeVisible();
    // Sin `disabled` durante el envío, un doble clic manda dos solicitudes: la segunda la para el
    // UNIQUE del VIN, pero el usuario ve un error que no puede explicarse.
    expect(altas).toHaveLength(1);
  });

  test('enviar con el nombre vacío marca el campo, lo enfoca y no manda nada', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    const altas = await abrirFormularioConRunt(page);
    await completarSolicitud(page, { nombre: '' });

    await page.getByRole('button', { name: 'Enviar la solicitud' }).click();

    const nombre = page.getByLabel('Nombre completo o razón social');
    await expect(nombre).toBeFocused();
    await expect(nombre).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('alert')
      .filter({ hasText: 'Escriba el nombre completo o la razón social del propietario.' })).toBeVisible();
    expect(altas).toHaveLength(0);
  });

  test('si el envío se corta, se dice que NO se sabe si llegó — y dónde mirar', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await page.route(RE_ALTA, (route) => route.abort('connectionfailed'));
    await page.route(RE_PRECONSULTA, (route) => json(route, 200, RUNT_OK));

    await page.goto('/flito/soat/solicitud');
    await page.getByLabel('Placa').fill(PLACA);
    await page.getByLabel('VIN').fill(VIN);
    await page.getByRole('button', { name: 'Consultar el RUNT' }).click();
    await expect(page.getByRole('region', { name: 'Datos del RUNT' })).toBeVisible();
    await completarSolicitud(page);
    await page.getByRole('button', { name: 'Enviar la solicitud' }).click();

    // Con `flito_soat.vin` UNIQUE, un segundo envío a ciegas produce el modal de «ya está en la cola»
    // y el usuario cree que hizo algo mal cuando la primera SÍ entró. Decirle dónde mirar cuesta una
    // frase, y el mutante que hay que matar es el que muestra un error de red genérico.
    await expect(page.getByText(`No sabemos si la solicitud llegó a FLITO. Vuelva a sus SOAT y busque la placa ${PLACA} antes de volver a enviarla.`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enviar la solicitud' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Volver a mis SOAT' })).toBeVisible();
  });

  test('salir con datos escritos pide confirmación: no hay borradores que rescatar', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);

    await page.goto('/flito/soat/solicitud');
    await page.getByLabel('Placa').fill(PLACA);
    await page.getByRole('button', { name: '← Volver a mis SOAT' }).click();

    const dialogo = page.getByRole('dialog', { name: '¿Descartar la solicitud?' });
    await expect(dialogo.getByText('Lo que escribió no se guarda: no hay borradores.')).toBeVisible();
    // «Seguir llenando» devuelve al formulario CON lo escrito: si lo borrara, la confirmación sería
    // peor que no tenerla.
    await dialogo.getByRole('button', { name: 'Seguir llenando' }).click();
    await expect(page.getByLabel('Placa')).toHaveValue(PLACA);

    await page.getByRole('button', { name: '← Volver a mis SOAT' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Descartar' }).click();
    await expect(page).toHaveURL(/\/flito\/soat$/);
  });

  test('la PII viaja en el CUERPO y la URL no la toca en ningún punto del recorrido', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    const urls: string[] = [];
    page.on('framenavigated', () => urls.push(page.url()));

    let cuerpoPreconsulta: unknown = null;
    await page.route(RE_ALTA, (route) => json(route, 201, { id: UUID_RECHAZADA, estado: 'pendiente_revision' }));
    await page.route(RE_PRECONSULTA, (route) => {
      cuerpoPreconsulta = route.request().postDataJSON();
      expect(route.request().method()).toBe('POST');
      // La razón de que la preconsulta sea un POST y no un GET con parámetros: un `?placa=` deja la
      // placa en el log de nginx, en el historial del navegador y en el `Referer`.
      expect(new URL(route.request().url()).search).toBe('');
      return json(route, 200, RUNT_OK);
    });

    await page.goto('/flito/soat/solicitud');
    await page.getByLabel('Placa').fill(PLACA);
    await page.getByLabel('VIN').fill(VIN);
    await page.getByRole('button', { name: 'Consultar el RUNT' }).click();
    await expect(page.getByRole('region', { name: 'Datos del RUNT' })).toBeVisible();
    await completarSolicitud(page);
    await page.getByRole('button', { name: 'Enviar la solicitud' }).click();
    await expect(page).toHaveURL(/\/flito\/soat$/);

    expect(cuerpoPreconsulta).toEqual({ placa: PLACA, vin: VIN });
    for (const url of [...urls, page.url()]) {
      expect(url).not.toContain(PLACA);
      expect(url).not.toContain(VIN);
      expect(url).not.toContain('1020304050');
    }
  });
});

// ═════════════════════════ Subsanación (la ruta que esta HU entrega) ═════════════════════════════

test.describe('HU #11914 · /flito/soat/solicitud/:id', () => {
  test('una solicitud que ya no está rechazada NO monta el formulario', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    // El caso real que se olvida: entre que el Cliente abre el enlace y lo edita, un admin la revisó.
    await page.route(/\/api\/flito\/soat\/[0-9a-f-]{36}$/, (route) =>
      json(route, 200, fila({ estado: 'pendiente_revision' })));

    await page.goto(`/flito/soat/solicitud/${UUID_RECHAZADA}`);
    await expect(page.getByText('Esta solicitud ya no está rechazada: FLITO la está revisando. No hay nada que corregir por ahora.')).toBeVisible();
    // Mata al mutante «montar el formulario igual y dejar que falle al reenviar», que es lo que hace
    // rellenar la pantalla entera para nada.
    await expect(page.getByRole('button', { name: 'Reenviar la solicitud' })).toHaveCount(0);
  });

  test('404 — no existe o no es de su compañía, y hay salida', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    await page.route(/\/api\/flito\/soat\/[0-9a-f-]{36}$/, (route) =>
      json(route, 404, { error: 'El SOAT no existe' }));

    await page.goto(`/flito/soat/solicitud/${UUID_RECHAZADA}`);
    await expect(page.getByText('Esta solicitud no existe o no es de su compañía.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Volver a mis SOAT' })).toBeVisible();
    // Un 404 es definitivo: reintentar no lo cambia y ofrecerlo sería invitar a probar uuids.
    await expect(page.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
  });

  test('un fallo de carga SÍ trae reintento, y el segundo intento pinta la solicitud', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCola(page);
    // UNA ruta con un INTERRUPTOR, y no un contador de llamadas: `React.StrictMode` monta el efecto
    // dos veces en desarrollo, así que un `intentos === 1` daría el 200 sin que nadie haya pulsado
    // «Reintentar» y el test pasaría por el camino equivocado. Aquí decide el test, y cuándo quiere.
    let carga: 'error' | 'ok' = 'error';
    await page.route(/\/api\/flito\/soat\/[0-9a-f-]{36}$/, (route) => (carga === 'error'
      ? json(route, 500, { error: 'Error del servidor' })
      : json(route, 200, fila({ estado: 'rechazada' }))));

    await page.goto(`/flito/soat/solicitud/${UUID_RECHAZADA}`);
    await expect(page.getByText('No pudimos cargar esta solicitud.')).toBeVisible();
    carga = 'ok';
    await page.getByRole('button', { name: 'Reintentar' }).click();

    await expect(page.getByRole('button', { name: 'Reenviar la solicitud' })).toBeVisible();
    // En la subsanación —y SOLO ahí— la placa y el VIN entran a la ficha: no son el eco de una
    // consulta, son lo que ya está guardado y no se puede cambiar.
    const ficha = page.getByRole('region', { name: 'Datos del RUNT' });
    await expect(ficha.getByText(PLACA, { exact: true })).toBeVisible();
    await expect(ficha.getByText(VIN, { exact: true })).toBeVisible();
    // Y el propietario llega prellenado desde la solicitud guardada, editable.
    await expect(page.getByLabel('Nombre completo o razón social')).toHaveValue('María Gómez');
  });
});
