// HU #12091 — SOAT Canal Cliente: el bloque 1 pide un solo dato (VIN), la pantalla se reordena y la
// ficha del RUNT enseña los once datos. Feature #12073.
//
// Diseño que manda: `docs/ux/flito-soat-alta-por-vin-y-ficha-completa.md`.
//
// ── Qué se prueba aquí y qué NO ─────────────────────────────────────────────────────────────────
//
// Aquí vive lo que esta HU CAMBIA de raíz: el bloque 1 reducido a un campo, el orden de los tres
// bloques, la ficha completa y los desenlaces con su copy nuevo. Lo que la HU solo TOCA —el contrato
// viejo invertido: helpers que tecleaban la placa, la frase de faltantes, la invalidación— se
// corrige en `soat-cliente-solicitud.spec.ts` y `soat-envio-directo-gestor.spec.ts`, que es donde
// vivía. Duplicarlo aquí daría dos sitios que contradecirse.
//
// ── Cómo se prueban los desenlaces, y por qué así ───────────────────────────────────────────────
//
// Se interceptan los DOS endpoints del canal con `page.route` y **nunca el RUNT real**. Los mocks
// devuelven el `codigo` correcto con un `mensaje` DELIBERADAMENTE ENGAÑOSO —un 503 cuyo texto hable
// de datos, un 422 que diga «no está disponible»— porque es la única forma de comprobar que la
// pantalla ramifica por el código y no por la prosa: un `if (/revise/i.test(mensaje))` pasa con
// mocks realistas y muere aquí.
//
// Y se CUENTAN las peticiones. El aserto negativo —«no salió ninguna»— es el que mata al mutante que
// quita la validación del front y delega en el 400 del servidor: con la HU #12090 el borde exige un
// VIN de 11 a 17 caracteres normalizados, así que un VIN corto vuelve como «Datos inválidos», que es
// justo lo que el Cliente no sabe leer.
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, CLIENTE_CON_CANAL } from '../helpers/auth';

const VIN = '9BWZZZ377VT004251';
/** El mismo VIN tecleado como viene en la factura: 19 crudos, 17 al normalizar. Se ACEPTA. */
const VIN_CON_SEPARADORES = '9FKRG-2222-T2042405';
const VIN_NORMALIZADO = '9FKRG2222T2042405';
/** Diez caracteres: por debajo del piso del borde (11 normalizados). Lo frena el FRONT. */
const VIN_CORTO = '9BWZZZ377V';
const PLACA_RUNT = 'ABC123';
const NUMERO_DOC = '1020304050';
const CORREO = 'contacto@ejemplo.co';
const UUID_SOLICITUD = '11111111-2222-4333-8444-555555555555';

const RE_ALTA = /\/api\/flito\/soat\/cliente$/;
const RE_COLA = /\/api\/flito\/soat\?/;
const RE_PRECONSULTA = /\/api\/flito\/soat\/cliente\/preconsulta$/;
/**
 * **HU #12094.** Adjuntar la factura dispara la lectura por OCR sola, y varios casos de este archivo
 * adjuntan. Sin esta ruta esas peticiones saldrían contra el backend de verdad: `RE_ALTA` y
 * `RE_PRECONSULTA` van anclados con `$` y no las capturan.
 */
const RE_LECTURA = /\/api\/flito\/soat\/cliente\/factura\/lectura$/;

/** Lo que devuelve la preconsulta cuando el RUNT dice que sí. Los ONCE datos vienen en `vehiculo`. */
const RUNT_OK = {
  vehiculo: {
    placa: PLACA_RUNT, vin: VIN, marca: 'RENAULT', linea: 'LOGAN', modelo: '2019',
    clase: 'AUTOMOVIL', cilindraje: '1600', tipoServicio: 'Particular', carroceria: 'SEDAN',
    pasajerosSentados: '5', puertas: '4',
  },
  organismo: { codigo: '05001', nombre: 'STRIA TTEyTTO MEDELLIN' },
  propietario: null as { nombreCompleto: string } | null,
};

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** El fallo del canal: el `codigo` discrimina y el `error` es texto para una persona — se miente ahí. */
const fallo = (status: number, codigo: string, error: string, extra: Record<string, unknown> = {}) =>
  ({ status, cuerpo: { error, codigo, ...extra } });

type Respuesta = { status: number; cuerpo: unknown };

async function mockCanal(
  page: Page,
  opciones: { alta?: Respuesta; preconsulta?: Respuesta; retenerPreconsulta?: boolean } = {},
) {
  const altas: { post: string | null }[] = [];
  const preconsultas: { post: string | null }[] = [];
  /** Se cuenta como las demás: «se lee dos veces» y «no se lee» no se ven en el DOM. */
  const lecturas: { post: string | null }[] = [];
  let abrir: () => void = () => {};
  const enVuelo = new Promise<void>((resolver) => { abrir = () => resolver(); });
  await page.route(RE_COLA, (route) => json(route, 200, { items: [], total: 0, page: 1, pageSize: 50 }));
  await page.route(/\/api\/flito\/soat\/facetas/, (route) =>
    json(route, 200, { companias: [], organismos: [], proveedores: [] }));
  await page.route(RE_ALTA, (route) => {
    altas.push({ post: route.request().postData() });
    return opciones.alta
      ? json(route, opciones.alta.status, opciones.alta.cuerpo)
      : json(route, 201, { id: UUID_SOLICITUD, estado: 'solicitado' });
  });
  await page.route(RE_LECTURA, (route) => {
    lecturas.push({ post: route.request().postData() });
    // Extracción VACÍA: esta HU no prellena nada y sus casos teclean el propietario a mano.
    return json(route, 200, { extraccion: {} });
  });
  await page.route(RE_PRECONSULTA, async (route) => {
    preconsultas.push({ post: route.request().postData() });
    if (opciones.retenerPreconsulta) await enVuelo;
    return opciones.preconsulta
      ? json(route, opciones.preconsulta.status, opciones.preconsulta.cuerpo)
      : json(route, 200, RUNT_OK);
  });
  await page.goto('/flito/soat/solicitud');
  return { altas, preconsultas, lecturas, liberarPreconsulta: () => abrir() };
}

/**
 * Cambia SOLO la respuesta de la preconsulta, sin volver a montar la pantalla.
 *
 * `page.unrouteAll()` no vale aquí: se llevaría por delante la ruta de `/api/auth/me` que `loginAs`
 * registró, y la sesión se caería a mitad del test.
 */
async function reMockPreconsulta(page: Page, respuesta: Respuesta) {
  await page.unroute(RE_PRECONSULTA);
  await page.route(RE_PRECONSULTA, (route) => json(route, respuesta.status, respuesta.cuerpo));
}

const bloque = (page: Page, titulo: string) => page.getByRole('region', { name: titulo });
const campoVin = (page: Page) => page.getByLabel('VIN (número de chasis)');
const btnConsultar = (page: Page) => page.getByRole('button', { name: 'Consultar el RUNT' });
const btnReconsultar = (page: Page) => page.getByRole('button', { name: 'Volver a consultar' });
const btnEnviar = (page: Page) => page.getByRole('button', { name: 'Enviar al gestor' });
const fichaRunt = (page: Page) => page.getByRole('region', { name: 'Datos del RUNT' });

/** El propietario del bloque 3, con su documento — que desde esta HU se edita AQUÍ. */
async function llenarPropietario(page: Page) {
  await page.getByLabel('Tipo de documento').selectOption('CC');
  await page.getByLabel('Número de documento').fill(NUMERO_DOC);
  await page.getByLabel('Nombre/s').fill('MARÍA FERNANDA');
  await page.getByLabel('Apellido/s').fill('GÓMEZ RUIZ');
  await page.getByLabel('Correo electrónico').fill(CORREO);
  await page.getByLabel('Celular').fill('3001234567');
  await page.getByLabel('Dirección').fill('Calle 1 # 2-3');
  await page.getByLabel('Municipio').fill('Medellín');
  await page.getByLabel('Departamento').fill('Antioquia');
}

async function adjuntarFactura(page: Page) {
  await page.locator('input[type="file"]').setInputFiles({
    name: 'factura.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 e2e'),
  });
}

/** Alta completa y consultada: el estado desde el que se puede enviar. */
async function llenarTodoYConsultar(page: Page, vin = VIN) {
  await campoVin(page).fill(vin);
  await adjuntarFactura(page);
  await llenarPropietario(page);
  await btnConsultar(page).click();
  await expect(fichaRunt(page)).toBeVisible();
}

// ═════════════════════ AC1 · el bloque de vehículo pide UN solo dato ═════════════════════════════

test.describe('HU #12091 · AC1 — un solo campo en el bloque 1', () => {
  test('el bloque 1 tiene UN textbox, es el VIN, es obligatorio y lleva su ayuda asociada', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCanal(page);

    const vehiculo = bloque(page, '1 · Vehículo');
    // Un solo control de texto en el bloque entero. El aserto de conteo es el que mata al mutante de
    // «dejar la placa de solo lectura»: seguiría siendo un `textbox` y seguiría contando.
    await expect(vehiculo.getByRole('textbox')).toHaveCount(1);
    await expect(vehiculo.getByRole('textbox')).toHaveAttribute('id', 'sol-vin');

    // El rótulo, con el `*` de requerido y SIN el «— opcional» de la #11966. Los dos asertos hacen
    // falta: sin el negativo, un rótulo «VIN (número de chasis) — opcional *» pasaría el primero.
    const rotulo = page.locator('label[for="sol-vin"]');
    await expect(rotulo).toHaveText('VIN (número de chasis) *');
    await expect(rotulo).not.toContainText('opcional');

    // La ayuda no está «al lado»: está ENLAZADA, que es lo único que le sirve a un lector.
    const descrito = await campoVin(page).getAttribute('aria-describedby');
    expect(descrito).toBe('sol-vin-ayuda');
    await expect(page.locator('#sol-vin-ayuda'))
      .toHaveText('Está en la tarjeta de propiedad y en la factura de venta. Suele tener 17 caracteres.');

    // Y los tres que se fueron NO están en el bloque 1. Se comprueba DENTRO del bloque —y no en la
    // página— porque tipo y número siguen existiendo: lo que cambió es dónde.
    for (const etiqueta of ['Placa', 'Tipo de documento', 'Número de documento']) {
      await expect(vehiculo.getByLabel(etiqueta), etiqueta).toHaveCount(0);
    }
    // La placa no se teclea en NINGÚN sitio de la pantalla: esa sí se fue entera.
    await expect(page.getByLabel('Placa')).toHaveCount(0);
  });

  test('tipo y número se editan en el bloque 3, y el eco «se cambia en el bloque 1» desapareció', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCanal(page);

    const propietario = bloque(page, '3 · Propietario');
    await expect(propietario.getByLabel('Tipo de documento')).toHaveCount(1);
    await expect(propietario.getByLabel('Número de documento')).toHaveCount(1);
    // Un dato en un sitio: el control de arriba y el eco de abajo eran DOS apariciones del mismo
    // documento. Si el eco sobreviviera, esta frase seguiría en la pantalla.
    await expect(page.getByText(/se cambia en el bloque 1/)).toHaveCount(0);
    await expect(page.getByText(/^Documento: /)).toHaveCount(0);
    // Y sigue habiendo UN control por dato, no dos.
    await expect(page.getByLabel('Número de documento')).toHaveCount(1);
  });

  test('VIN vacío: lo frena el FRONT con su mensaje, enfoca el campo y no sale ni una petición', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    const cap = await mockCanal(page);

    await btnConsultar(page).click();

    await expect(page.getByRole('alert').filter({ hasText: 'Escriba el VIN del vehículo.' })).toBeVisible();
    await expect(campoVin(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(campoVin(page)).toBeFocused();
    // **El aserto que mata al mutante**: sin la validación del front, esto sale a la red y vuelve un
    // `400 Datos inválidos` de esquema que la pantalla no sabe explicar.
    expect(cap.preconsultas, JSON.stringify(cap.preconsultas)).toHaveLength(0);
  });

  test('VIN de 10 caracteres: mensaje propio con el piso, y cero peticiones', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    const cap = await mockCanal(page);

    await campoVin(page).fill(VIN_CORTO);
    await btnConsultar(page).click();

    await expect(page.getByRole('alert')
      .filter({ hasText: 'El VIN tiene 10 caracteres y hacen falta al menos 11.' })).toBeVisible();
    // No es el aviso blando de longitud rara: ese no bloquea y este sí.
    await expect(page.getByText(/El VIN suele tener 17 caracteres/)).toHaveCount(0);
    expect(cap.preconsultas, JSON.stringify(cap.preconsultas)).toHaveLength(0);
  });

  test('VIN con separadores: 19 tecleados, 17 normalizados — se ACEPTA y viaja limpio', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    const cap = await mockCanal(page);

    await campoVin(page).fill(VIN_CON_SEPARADORES);
    // Se normaliza al teclear, con la MISMA función del borde: si el front midiera el crudo, 19
    // caracteres saldrían rechazados por largos donde el servidor los acepta.
    await expect(campoVin(page)).toHaveValue(VIN_NORMALIZADO);
    await btnConsultar(page).click();

    await expect(fichaRunt(page)).toBeVisible();
    expect(cap.preconsultas).toHaveLength(1);
    expect(JSON.parse(cap.preconsultas[0].post ?? '{}')).toEqual({ vin: VIN_NORMALIZADO });
  });

  test('el cuerpo de la preconsulta es EXACTAMENTE { vin }, y en el alta ya no viaja la placa', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    const cap = await mockCanal(page);
    await llenarTodoYConsultar(page);
    await btnEnviar(page).click();
    await expect(page).toHaveURL(/\/flito\/soat$/);

    // `toEqual` y no «contiene»: es lo único que prueba que el documento del propietario dejó de
    // viajar a un endpoint que no lo usa. Un dato personal sin destino no se recoge.
    expect(JSON.parse(cap.preconsultas[0].post ?? '{}')).toEqual({ vin: VIN });

    const cuerpo = cap.altas[0].post ?? '';
    expect(cuerpo).toContain('name="vin"');
    expect(cuerpo).toContain(VIN);
    // La placa del alta es la que devuelve el RUNT: `EntradaSolicitud` la perdió en la #12090.
    expect(cuerpo).not.toContain('name="placa"');
    expect(cuerpo).not.toContain(PLACA_RUNT);
    // HU #12094: adjuntar leyó la factura UNA sola vez. Es lo que hace verdad el comentario del
    // contador en `mockCanal` —«se lee dos veces» y «no se lee» no se ven en el DOM— en ESTE archivo.
    expect(cap.lecturas).toHaveLength(1);
  });
});

// ═════════════════════ AC2 · orden nuevo, una sola pantalla ══════════════════════════════════════

test.describe('HU #12091 · AC2 — el orden de la pantalla', () => {
  test('los tres encabezados salen en orden de DOCUMENTO: vehículo, factura, propietario', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCanal(page);

    // Un array y no tres `toBeVisible()` sueltos: lo que el AC2 pide es el ORDEN, y tres asertos de
    // visibilidad pasan igual con los bloques al revés.
    await expect(page.getByRole('heading', { level: 2 }))
      .toHaveText(['1 · Vehículo', '2 · Factura de venta', '3 · Propietario']);

    // Y no hay asistente por pasos ni borrador: crear sigue siendo enviar.
    await expect(page.getByRole('button', { name: /Siguiente|Continuar|Guardar borrador/ })).toHaveCount(0);
  });

  test('el tabulador recorre el mismo orden, y el primario sigue siendo alcanzable', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCanal(page);
    // Con la factura ADJUNTA, que es cuando el bloque 2 tiene un control tabulable («Quitar el
    // archivo»): es lo que demuestra que ese bloque está ENTRE el vehículo y el propietario en el
    // DOM, y no solo que se ve más arriba.
    await adjuntarFactura(page);

    await campoVin(page).focus();
    for (const siguiente of [
      btnConsultar(page),
      page.getByRole('button', { name: 'Quitar el archivo' }),
      // HU #12094: con la factura adjunta el bloque 2 gana un segundo control —volver a leerla— y
      // va DETRÁS del archivo, no delante: primero se elige el papel y después se relee.
      page.getByRole('button', { name: 'Volver a leer' }),
      page.getByLabel('Tipo de documento'),
      page.getByLabel('Número de documento'),
    ]) {
      await page.keyboard.press('Tab');
      await expect(siguiente).toBeFocused();
    }

    const enviar = btnEnviar(page);
    await expect(enviar).toHaveAttribute('aria-disabled', 'true');
    // Y **sin `disabled` nativo**. Los dos asertos hacen falta: para Playwright `aria-disabled` ya
    // cuenta como deshabilitado, así que `toBeDisabled()` no distingue las dos implementaciones. Lo
    // que las distingue es el atributo nativo —ausente— y el tabulador, que un `disabled` rompería.
    expect(await enviar.getAttribute('disabled')).toBeNull();
    await page.getByRole('button', { name: 'Cancelar' }).focus();
    await page.keyboard.press('Tab');
    await expect(enviar).toBeFocused();
  });
});

// ═════════════════════ AC3 · la ficha con los once datos ═════════════════════════════════════════

test.describe('HU #12091 · AC3 — la ficha del RUNT enseña los once', () => {
  test('los once datos, en tres grupos y en orden, más el organismo aparte', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCanal(page);
    await campoVin(page).fill(VIN);
    await btnConsultar(page).click();

    const ficha = fichaRunt(page);
    await expect(ficha).toBeVisible();
    // La lista COMPLETA y en orden de documento. Un `toBeVisible()` por dato pasaría con la ficha
    // desordenada o con datos de más; esto no.
    await expect(ficha.locator('dt')).toHaveText([
      'Placa', 'VIN', 'Marca', 'Línea', 'Modelo', 'Clase', 'Carrocería',
      'Servicio', 'Cilindraje', 'Capacidad (pasajeros)', 'Puertas',
      'Organismo de tránsito',
    ]);
    await expect(ficha.locator('dd')).toHaveText([
      PLACA_RUNT, VIN, 'RENAULT', 'LOGAN', '2019', 'AUTOMOVIL', 'SEDAN',
      'Particular', '1600', '5', '4',
      'STRIA TTEyTTO MEDELLIN',
    ]);
    // Los tres rótulos de grupo son encabezados REALES, no párrafos en negrita.
    await expect(ficha.getByRole('heading', { level: 4 }))
      .toHaveText(['Identificación', 'Vehículo', 'Ficha técnica']);

    // Texto de solo lectura, **nunca controles deshabilitados** (AC3). Un `<input disabled>` conserva
    // el rol `textbox` en varios motores, así que los dos asertos hacen falta.
    await expect(ficha.getByRole('textbox')).toHaveCount(0);
    await expect(page.locator('input[disabled]')).toHaveCount(0);
    // Y el sello de procedencia y el aviso de que esto no se corrige aquí.
    await expect(ficha.getByText(/^Traídos el /)).toBeVisible();
    await expect(ficha.getByText(/corríjalo ante su organismo de tránsito/)).toBeVisible();
  });

  test('sin capacidad ni puertas los dos siguen ahí, pintan «—» y la ficha no se colapsa', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCanal(page, {
      preconsulta: {
        status: 200,
        cuerpo: { ...RUNT_OK, vehiculo: { ...RUNT_OK.vehiculo, pasajerosSentados: null, puertas: null } },
      },
    });
    await campoVin(page).fill(VIN);
    await btnConsultar(page).click();

    const ficha = fichaRunt(page);
    // El mutante que esto mata es volver a omitir la línea cuando el dato no viene: la ficha se
    // vería «completa» y nadie sabría distinguir «no vino» de «no existe».
    await expect(ficha.locator('dt')).toHaveCount(12);
    await expect(ficha.locator('dd').nth(9)).toHaveText('—');
    await expect(ficha.locator('dd').nth(10)).toHaveText('—');
    await expect(ficha.getByText('Un dato en «—» es un dato que el RUNT no publica. No impide enviar la solicitud.')).toBeVisible();
    // Y no impide enviar: la compuerta sigue abierta.
    await expect(page.getByText('✓ Consultado')).toBeVisible();
  });
});

// ═════════════════════ AC4 · cada desenlace, su mensaje ══════════════════════════════════════════

test.describe('HU #12091 · AC4 — los cuatro desenlaces se distinguen por CÓDIGO', () => {
  /** Consulta con la respuesta pedida y devuelve el capturador, para contar las altas. */
  async function consultarCon(page: Page, respuesta: Respuesta) {
    await loginAs(page, CLIENTE_CON_CANAL);
    const cap = await mockCanal(page, { preconsulta: respuesta });
    await campoVin(page).fill(VIN);
    await btnConsultar(page).click();
    return cap;
  }

  test('503 runt_no_disponible: habla del SERVICIO aunque el mensaje del servidor hable de datos', async ({ page }) => {
    const cap = await consultarCon(page, fallo(503, 'runt_no_disponible', 'Los datos no corresponden: revisa los datos.'));

    await expect(page.getByRole('alert')).toContainText('El RUNT no está disponible, vuelva a consultar.');
    await expect(page.getByText(/revisa los datos/i)).toHaveCount(0);
    // Sin nada suyo que corregir, el foco va al botón y no al campo.
    await expect(btnReconsultar(page)).toBeFocused();
    await expect(btnEnviar(page)).toHaveAttribute('aria-disabled', 'true');
    expect(cap.altas).toHaveLength(0);
  });

  test('422 runt_sin_registro: habla del VIN que no existe, aunque el servidor diga «no disponible»', async ({ page }) => {
    const cap = await consultarCon(page, fallo(422, 'runt_sin_registro', 'El RUNT no está disponible en este momento.'));

    const banda = page.getByRole('alert');
    await expect(banda).toContainText('El RUNT no tiene registrado ningún vehículo con ese VIN.');
    await expect(page.getByText(/no está disponible/)).toHaveCount(0);
    // Su copy dice «compruébelo» y hay exactamente un campo que comprobar.
    await expect(campoVin(page)).toBeFocused();
    expect(cap.altas).toHaveLength(0);
  });

  test('422 runt_no_cuadra con campo VIN: campo inválido y ENFOCADO, y la banda no dice cuál era el bueno', async ({ page }) => {
    const cap = await consultarCon(page, fallo(422, 'runt_no_cuadra', 'El RUNT no está disponible.', { campo: 'vin' }));

    await expect(campoVin(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(campoVin(page)).toBeFocused();
    const banda = page.getByRole('alert');
    await expect(banda).toContainText('Revise el VIN: no coincide con el que el RUNT tiene registrado.');
    // La fuga que nadie debe «mejorar»: el VIN del registro no se enseña en ninguna parte.
    await expect(banda).not.toContainText(VIN);
    // Y ya no manda a comprobar una placa que el Cliente no escribió.
    await expect(banda).not.toContainText(/placa/i);
    expect(cap.altas).toHaveLength(0);
  });

  test('409 soat_vigente: modal propio, cero altas, y el foco vuelve al VIN al cerrarlo', async ({ page }) => {
    const cap = await consultarCon(page, fallo(409, 'soat_vigente', 'Revisa los datos del vehículo.'));

    const modal = page.getByRole('dialog', { name: 'Este vehículo ya tiene SOAT vigente' });
    await expect(modal).toBeVisible();
    await expect(modal.getByText('Según el RUNT, este vehículo tiene una póliza SOAT vigente.')).toBeVisible();
    // Ni la placa (que ya no existe) ni el VIN dentro de la frase o del título del diálogo.
    await expect(modal).not.toContainText(VIN);
    expect(cap.altas).toHaveLength(0);

    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await expect(campoVin(page)).toBeFocused();
  });

  test('los cuatro desenlaces dicen cosas DISTINTAS entre sí, y ninguno nombra la placa', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCanal(page, { preconsulta: fallo(503, 'runt_no_disponible', 'mentira') });
    await campoVin(page).fill(VIN);
    const consultar = page.getByRole('button', { name: /Consultar el RUNT|Volver a consultar/ });

    const textos: string[] = [];
    await consultar.click();
    textos.push((await page.getByRole('alert').innerText()).trim());
    for (const respuesta of [
      fallo(422, 'runt_sin_registro', 'mentira'),
      fallo(422, 'runt_no_cuadra', 'mentira', { campo: 'vin' }),
    ]) {
      await reMockPreconsulta(page, respuesta);
      await consultar.click();
      await expect(page.getByRole('alert')).not.toHaveText(textos[textos.length - 1]);
      textos.push((await page.getByRole('alert').innerText()).trim());
    }
    // El cuarto no es una banda sino un modal, y por eso se lee aparte: el AC pide que los cuatro se
    // vean distintos, no que compartan superficie.
    await reMockPreconsulta(page, fallo(409, 'soat_vigente', 'mentira'));
    await consultar.click();
    textos.push((await page.getByRole('dialog').innerText()).trim());

    expect(new Set(textos).size, textos.join('\n──\n')).toBe(4);
    for (const texto of textos) expect(texto.toLowerCase(), texto).not.toContain('placa');
  });

  test('runt_sin_vin y un código DESCONOCIDO: mensajes propios, y el del servidor no se pinta', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCanal(page, { preconsulta: fallo(422, 'runt_sin_vin', 'Revisa los datos.') });
    await campoVin(page).fill(VIN);
    await btnConsultar(page).click();

    // No está en la lista del AC4 y sigue existiendo en el backend: su copy no empuja a reintentar,
    // porque no hay nada que el Cliente pueda corregir.
    const banda = page.getByRole('alert');
    await expect(banda).toContainText('El RUNT respondió sin el número de chasis');
    await expect(banda).not.toContainText(/Revise el VIN/);

    // `organismo_no_catalogado` se retiró en la #11966; una API desfasada en DEV lo sigue sirviendo,
    // y en DEV el merge ES el deploy.
    await reMockPreconsulta(page, fallo(422, 'organismo_no_catalogado', 'Revisa la placa que escribiste.'));
    await btnReconsultar(page).click();

    // Ni muda ni tuteando: la pantalla no interpola el mensaje del servidor, que además nombra un
    // campo que esta pantalla ya no tiene.
    await expect(page.getByRole('alert')).toContainText('No pudimos consultar el RUNT en este momento.');
    await expect(page.getByText(/Revisa la placa que escribiste/)).toHaveCount(0);
    await expect(btnReconsultar(page)).toBeVisible();
    await expect(btnEnviar(page)).toHaveAttribute('aria-disabled', 'true');
  });
});

// ═════════════════════ AC5 · invalidar la consulta ═══════════════════════════════════════════════

test.describe('HU #12091 · AC5 — editar el VIN invalida la consulta', () => {
  test('un carácter del VIN retira la ficha, lo dice con su literal y vuelve a bloquear con motivo', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCanal(page);
    await llenarTodoYConsultar(page);
    await expect(page.locator('#sol-falta')).toHaveCount(0);

    await campoVin(page).fill('9BWZZZ377VT004252');

    await expect(fichaRunt(page)).toHaveCount(0);
    await expect(page.getByText('✓ Consultado')).toHaveCount(0);
    // `role="status"` y no `alert`: es la consecuencia de lo que el usuario acaba de hacer.
    const aviso = page.getByRole('status').filter({ hasText: 'Cambió el VIN' });
    await expect(aviso).toHaveText('Cambió el VIN: vuelva a consultar el RUNT antes de enviar.');
    await expect(btnEnviar(page)).toHaveAttribute('aria-disabled', 'true');
    // El motivo calca el rótulo del botón al que apunta.
    await expect(page.locator('#sol-falta')).toHaveText('Para enviar falta: volver a consultar el RUNT.');
    await expect(btnReconsultar(page)).toBeVisible();

    // Y **no se castiga al que corrige**: lo tecleado y lo adjuntado siguen ahí.
    await expect(page.getByLabel('Correo electrónico')).toHaveValue(CORREO);
    await expect(page.getByLabel('Municipio')).toHaveValue('Medellín');
    await expect(page.getByLabel('Número de documento')).toHaveValue(NUMERO_DOC);
    await expect(page.getByText('factura.pdf', { exact: false })).toBeVisible();
  });

  test('editar el DOCUMENTO ya no invalida nada: dejó de ser entrada del RUNT', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockCanal(page);
    await llenarTodoYConsultar(page);

    await page.getByLabel('Número de documento').fill('1020304099');
    await page.getByLabel('Tipo de documento').selectOption('CE');

    // El mutante que esto mata es dejar la invalidación de la #11967 atada a un dato que la consulta
    // ya no usa: corregir una tilde del documento tumbaría la ficha sin motivo.
    await expect(fichaRunt(page)).toBeVisible();
    await expect(page.getByText('✓ Consultado')).toBeVisible();
    await expect(page.getByText(/Cambió el VIN/)).toHaveCount(0);
    await expect(btnEnviar(page)).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('la CARRERA: cambiar el VIN con la consulta EN VUELO tira la respuesta que llega tarde', async ({ page }) => {
    // El otro test cambia el VIN DESPUÉS de que la respuesta aterrizó: eso prueba la invalidación, no
    // la carrera. Aquí se cambia con la consulta en el aire, que es como se radicaría una solicitud
    // cuyo RUNT no corresponde a lo enviado.
    //
    // La pantalla tiene DOS cerraduras contra eso y este test mide la segunda. La primera —el
    // `readOnly` del campo mientras consulta— hace que la carrera no sea alcanzable POR TECLEO, y se
    // afirma abajo. La segunda es `turno`, que cubre un cambio de valor que no venga del teclado y
    // sobrevive a que alguien retire ese `readOnly`; sin ella, aquí se pinta la ficha de OTRO
    // vehículo con la compuerta abierta.
    await loginAs(page, CLIENTE_CON_CANAL);
    const cap = await mockCanal(page, { retenerPreconsulta: true });
    await campoVin(page).fill(VIN);
    await adjuntarFactura(page);
    await llenarPropietario(page);
    await btnConsultar(page).click();

    await expect(page.getByRole('button', { name: 'Consultando el RUNT…' })).toBeVisible();
    await expect(page.getByText('La consulta puede tardar hasta un minuto. No cierre esta página.')).toBeVisible();
    // La PRIMERA cerradura, afirmada: el campo no se puede editar mientras la consulta está en
    // vuelo. `readOnly` y no `disabled` —el segundo perdería el foco y saldría del tabulador—, así
    // que el control sigue enfocable y su valor sigue siendo copiable. Los dos asertos describen el
    // estado «consultando» entero: campo no editable y un solo rótulo de botón, el de en curso.
    await expect(campoVin(page)).not.toBeEditable();
    await expect(btnConsultar(page)).toHaveCount(0);
    // Y por eso el cambio se fuerza en el DOM en vez de con `fill`: por teclado esta carrera ya no
    // se puede provocar. Lo que queda por medir es la SEGUNDA cerradura, `turno`, que es la que
    // cubre un cambio llegado por otra vía y la que sigue en pie si mañana alguien retira el
    // `readOnly` de arriba.
    await campoVin(page).evaluate((el: HTMLInputElement) => {
      el.readOnly = false;
      // El setter NATIVO, y no `el.value = …`: React parchea el suyo para llevar la cuenta del valor
      // anterior, y una asignación directa deja ese registro al día — el `input` que sigue se
      // descarta por «no cambió nada» y `onChange` no llega a correr. Es el mismo truco que usa
      // cualquier arnés que teclee sobre React desde fuera.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(el, '9BWZZZ377VT009999');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.getByText('Cambió el VIN: vuelva a consultar el RUNT antes de enviar.')).toBeVisible();

    const respuestaTardia = page.waitForResponse((r) => RE_PRECONSULTA.test(r.url()));
    cap.liberarPreconsulta();
    await respuestaTardia;
    // Se le deja terminar el viaje —leer el cuerpo, resolver la promesa y repintar— antes de exigir
    // que no haya cambiado nada: sin esta espera, el aserto negativo pasaría por llegar ANTES que el
    // fallo y no por ausencia de fallo.
    await page.waitForTimeout(500);

    await expect(fichaRunt(page)).toHaveCount(0);
    await expect(page.getByText('✓ Consultado')).toHaveCount(0);
    await expect(btnEnviar(page)).toHaveAttribute('aria-disabled', 'true');
    expect(cap.preconsultas).toHaveLength(1);
    expect(cap.altas).toHaveLength(0);
  });
});
