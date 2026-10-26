// HU #12079 — SOAT Canal Cliente: gestor por defecto de la compañía, botón de envío y retirada de
// la revisión. Feature #12074.
//
// Diseño que manda: `docs/ux/soat-envio-directo-al-gestor-y-gestor-por-defecto.md`.
//
// ── Qué se prueba aquí y qué NO ─────────────────────────────────────────────────────────────────
//
// Aquí vive lo que esta HU CREA, en sus tres superficies:
//
//   S1 · la ficha de la compañía (`/clients`) — RETIRADO por la HU #13968: el interruptor y el
//        «gestor por defecto» ya no existen; vive en `clientes-soat-sin-tramite-proveedor.spec.ts`.
//        (Texto original: la celda, el modal, sus cuatro estados y la
//        decisión entera: el orden de los dos controles deja de importar.
//   S2 · el formulario del Cliente — la enumeración de lo que falta y a dónde lleva el botón.
//   S3 · lo retirado — que no es alcanzable ni por URL.
//
// Lo que esta HU sólo TOCA (el rótulo, el toast, la fila que nace en `solicitado`) se comprueba en
// `soat-cliente-solicitud.spec.ts`, que es donde vivía. Duplicarlo aquí daría dos sitios que
// contradecirse.
//
// Este spec YA está en la lista fija del nocturno (`test:e2e:smoke`, apps/web/package.json), donde
// ocupa el sitio de `soat-revision-rechazo.spec.ts`, retirado en esta misma HU — el conteo del
// workflow sigue en 17. Hace falta porque el CI de PR corre UN solo spec E2E (el visor de PDF).
// El de accesibilidad (`…-gestor-a11y.spec.ts`) queda FUERA a propósito: sin `QA_AXE_CDN=1` o
// `QA_AXE_PATH` sale rojo por entorno, igual que los demás specs de axe del repo.
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, CLIENTE_CON_CANAL, OPERACIONES_USER } from '../helpers/auth';

const PLACA = 'ABC123';
/** El único dato del vehículo que el Cliente teclea desde la HU #12091. */
const VIN = '9BWZZZ377VT004251';
const TIPO_DOC = 'CC';
const NUMERO_DOC = '1020304050';
const CORREO = 'contacto@ejemplo.co';
const UUID_SOLICITUD = '11111111-2222-4333-8444-555555555555';

const SURA = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const AXA = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
/** Un gestor RETIRADO del catálogo pero todavía atado a una compañía. Es el caso que se pierde solo. */
const MUNDIAL = 'cccccccc-dddd-4eee-8fff-000000000000';

const RE_PROVEEDORES = /\/api\/flito\/parametrizacion\/proveedores-soat$/;
const RE_COLA = /\/api\/flito\/soat\?/;
const RE_PRECONSULTA = /\/api\/flito\/soat\/cliente\/preconsulta$/;

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

// La ficha de la compañía (celda, cuadro y sus estados) se prueba desde la HU #13968 en
// `clientes-soat-sin-tramite-proveedor.spec.ts`: el interruptor y el «gestor por defecto» ya no existen.

/** Catálogo de proveedores que la cola usa en AC4. */
const CATALOGO = [
  { id: SURA, nombre: 'SURA', activo: true },
  { id: AXA, nombre: 'AXA', activo: true },
  // Retirado: el catálogo lo entrega igual y filtrarlo al OFRECER es trabajo de la pantalla.
  { id: MUNDIAL, nombre: 'MUNDIAL', activo: false },
];


// ═════════════════════ S2 · AC1 y AC2 — el botón dice QUÉ falta y lleva al sitio ══════════════════

/** Lo que devuelve la preconsulta cuando el RUNT dice que sí. */
const RUNT_OK = {
  vehiculo: {
    placa: PLACA, vin: VIN, marca: 'RENAULT', linea: 'LOGAN', modelo: '2026',
    clase: 'AUTOMOVIL', cilindraje: '1600', tipoServicio: 'Particular', carroceria: 'SEDAN',
    pasajerosSentados: '5', puertas: '4',
  },
  organismo: { codigo: '05001', nombre: 'STRIA TTEyTTO MEDELLIN' },
  propietario: null,
};

async function montarAlta(page: Page) {
  const altas: string[] = [];
  await page.route(RE_COLA, (route) => json(route, 200, { items: [], total: 0, page: 1, pageSize: 50 }));
  await page.route(/\/api\/flito\/soat\/facetas/, (route) =>
    json(route, 200, { companias: [], organismos: [], proveedores: [] }));
  await page.route(RE_PRECONSULTA, (route) => json(route, 200, RUNT_OK));
  await page.route(/\/api\/flito\/soat\/cliente$/, (route) => {
    altas.push(route.request().method());
    return json(route, 201, { id: UUID_SOLICITUD, estado: 'solicitado' });
  });
  await page.goto('/flito/soat/solicitud');
  return { altas };
}

const linea = (page: Page) => page.locator('#sol-falta');
const btnEnviar = (page: Page) => page.getByRole('button', { name: 'Enviar al gestor' });

/**
 * Consulta el RUNT, para abrir la compuerta y nada más.
 *
 * HU #12091: el bloque 1 pide **un solo dato**. Tipo y número de documento se fueron al bloque del
 * propietario y la placa desapareció, así que este helper ya no los teclea — los teclea
 * `llenarPropietario`, que es donde viven ahora.
 */
async function consultarRunt(page: Page) {
  await page.getByLabel('VIN').fill(VIN);
  await page.getByRole('button', { name: 'Consultar el RUNT' }).click();
  await expect(page.getByText('Consultado', { exact: true })).toBeVisible();
}

test.describe('HU #12079 · AC1 — el botón bloqueado enumera lo que falta', () => {
  test('formulario en blanco: el RUNT va primero, hay tope y la plantilla es única', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await montarAlta(page);

    // El mutante que este aserto mata es un mensaje genérico («Complete los datos obligatorios»); el
    // segundo mata enumerar sin tope, que con el formulario en blanco son doce nombres.
    // HU #12091: «Placa» pasa a «VIN» y el conteo se queda en 10 — el bloque 1 pierde tres campos y
    // el VIN pasa a obligatorio, así que siguen faltando doce cosas.
    await expect(linea(page)).toHaveText('Para enviar falta: consultar el RUNT, VIN y 10 datos más.');
    await expect(linea(page)).toHaveText(/^Para enviar falta: consultar el RUNT,.* y \d+ datos más\.$/);
  });

  test('el botón la referencia con aria-describedby SOLO mientras está bloqueado', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await montarAlta(page);

    const enviar = btnEnviar(page);
    await expect(enviar).toHaveAttribute('aria-disabled', 'true');
    await expect(enviar).toHaveAttribute('aria-describedby', 'sol-falta');
    // Y no es una región viva: una `role="status"` aquí se reanunciaría con cada tecla de un
    // formulario de doce campos.
    await expect(linea(page)).not.toHaveAttribute('role', 'status');

    await llenarTodo(page);
    await expect(linea(page)).toHaveCount(0);
    await expect(enviar).not.toHaveAttribute('aria-disabled', 'true');
    expect(await enviar.getAttribute('aria-describedby')).toBeNull();
  });

  test('con el RUNT en verde, la lista nombra los campos por su ETIQUETA y en el orden del foco', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await montarAlta(page);
    await consultarRunt(page);
    await llenarPropietario(page);
    await adjuntarFactura(page);
    // Se vacían dos, en desorden: la frase tiene que salir en el orden del formulario igual.
    await page.getByLabel('Celular').fill('');
    await page.getByLabel('Correo electrónico').fill('');

    await expect(linea(page)).toHaveText('Para enviar falta: Correo electrónico y Celular.');
    // Y son ETIQUETAS, nunca valores: esta frase se pinta y se lee en voz alta.
    await expect(linea(page)).not.toContainText(NUMERO_DOC);
    await expect(linea(page)).not.toContainText(VIN);
  });

  test('un valor INVÁLIDO no desaparece de la lista, que es lo que un chequeo de vacíos no ve', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await montarAlta(page);
    await consultarRunt(page);
    await llenarPropietario(page);
    await adjuntarFactura(page);
    // No está vacío y sigue siendo inválido. El mutante —calcular los faltantes con `campo === ''`
    // en vez de con `validarTodo`— deja el botón activo y la pulsación sin efecto visible.
    await page.getByLabel('Correo electrónico').fill('hola@');

    await expect(linea(page)).toHaveText('Para enviar falta: Correo electrónico.');
    await expect(btnEnviar(page)).toHaveAttribute('aria-disabled', 'true');
  });

  test('solo la factura: la frase la nombra por el rótulo del bloque', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await montarAlta(page);
    await consultarRunt(page);
    await llenarPropietario(page);

    await expect(linea(page)).toHaveText('Para enviar falta: Factura de venta.');
  });

  test('cambiar el VIN después de consultar: la frase pasa a «volver a consultar el RUNT»', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await montarAlta(page);
    await llenarTodo(page);
    await expect(linea(page)).toHaveCount(0);

    // HU #12091: el identificador que invalida es el VIN, y es el único. Tocar el documento ya no
    // retira la ficha — eso se comprueba en `soat-cliente-solicitud.spec.ts`.
    await page.getByLabel('VIN').fill('9BWZZZ377VT004252');
    // Calca el rótulo del botón al que la frase apunta. Un «consultar el RUNT» aquí mandaría a un
    // botón que dice «Volver a consultar».
    await expect(linea(page)).toHaveText('Para enviar falta: volver a consultar el RUNT.');
  });

  test('SOAT vigente: la frase NO es una lista — no falta nada, está prohibido', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await page.route(RE_COLA, (route) => json(route, 200, { items: [], total: 0, page: 1, pageSize: 50 }));
    await page.route(/\/api\/flito\/soat\/facetas/, (route) =>
      json(route, 200, { companias: [], organismos: [], proveedores: [] }));
    await page.route(RE_PRECONSULTA, (route) => json(route, 409, {
      error: 'El RUNT reporta que este vehículo ya tiene un SOAT vigente.', codigo: 'soat_vigente',
    }));
    await page.goto('/flito/soat/solicitud');

    await page.getByLabel('VIN').fill(VIN);
    await page.getByRole('button', { name: 'Consultar el RUNT' }).click();
    // HU #12844: ya no hay modal que cerrar; la tarjeta de bloqueo queda en la página.
    await expect(page.getByRole('region', { name: 'Este vehículo ya tiene SOAT activo' })).toBeVisible();

    await expect(linea(page)).toHaveText('Este vehículo tiene SOAT vigente según el RUNT: no se puede radicar la solicitud.');
    await expect(linea(page)).not.toContainText('Para enviar falta');
  });
});

test.describe('HU #12079 · AC1 — el botón bloqueado sigue siendo del teclado y lleva al sitio correcto', () => {
  test('RUNT en verde y correo vacío: el foco cae en Correo electrónico, NO en «Consultar de nuevo»', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    const cap = await montarAlta(page);
    await consultarRunt(page);
    await llenarPropietario(page);
    await adjuntarFactura(page);
    await page.getByLabel('Correo electrónico').fill('');

    const enviar = btnEnviar(page);
    // Alcanzable con Tab: `aria-disabled` y NO `disabled`. Los dos asertos hacen falta —para
    // Playwright `aria-disabled` ya cuenta como deshabilitado, así que `toBeDisabled` no distingue
    // las dos implementaciones—; lo que las distingue es el atributo nativo y el tabulador.
    expect(await enviar.getAttribute('disabled')).toBeNull();
    await page.getByRole('button', { name: 'Cancelar' }).focus();
    await page.keyboard.press('Tab');
    await expect(enviar).toBeFocused();
    await page.keyboard.press('Enter');

    // El mutante que esto caza: meter los faltantes dentro de la compuerta sin tocar
    // `intentarEnviar` manda el foco al botón de consulta, un control que no tiene nada de malo.
    await expect(page.getByLabel('Correo electrónico')).toBeFocused();
    expect(cap.altas).toHaveLength(0);
  });

  test('sin consultar el RUNT: el foco SÍ va al botón de consulta y no se envía nada', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    const cap = await montarAlta(page);
    await page.getByLabel('VIN').fill(VIN);
    await llenarPropietario(page);
    await adjuntarFactura(page);

    await page.getByRole('button', { name: 'Cancelar' }).focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');

    await expect(page.getByRole('button', { name: 'Consultar el RUNT' })).toBeFocused();
    expect(cap.altas).toHaveLength(0);
  });
});

test.describe('HU #12079 · AC2 — las TRES frases que prometían revisión', () => {
  test('ni la tarjeta, ni el subtítulo, ni el toast dicen ya «revisión de FLITO»', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await montarAlta(page);

    // El subtítulo de la página y la tarjeta de envío, antes de enviar.
    await expect(page.getByText(/revisión de FLITO/)).toHaveCount(0);
    // HU #12819 (§12.2): la frase vive solo en la barra de envío, con el copy nuevo.
    await expect(page.getByText('No se guarda como borrador: al enviarla, entra en gestión.')).toBeVisible();
    await expect(page.getByText('entra en gestión', { exact: false }).first()).toBeVisible();

    await llenarTodo(page);
    await btnEnviar(page).click();

    // Y el toast. El mutante que esto mata es cambiar solo la frase que el AC2 nombra y aterrizar en
    // la cola con un «FLITO la va a revisar» encima de una fila en Solicitado.
    await expect(page.getByText('Solicitud enviada. Ya está en gestión.')).toBeVisible();
    await expect(page.getByText(/va a revisar/)).toHaveCount(0);
    await expect(page).toHaveURL(/\/flito\/soat$/);
  });
});

// ═════════════════════ S3 · AC3 y AC4 — lo retirado no es alcanzable ═════════════════════════════

test.describe('HU #12079 · AC3 — las pantallas retiradas no existen ni por URL', () => {
  test('/flito/soat/solicitud/:id ya no pinta un alta en blanco: aterriza en la cola del Cliente', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await page.route(RE_COLA, (route) => json(route, 200, { items: [], total: 0, page: 1, pageSize: 50 }));
    await page.route(/\/api\/flito\/soat\/facetas/, (route) =>
      json(route, 200, { companias: [], organismos: [], proveedores: [] }));

    await page.goto(`/flito/soat/solicitud/${UUID_SOLICITUD}`);

    // El mutante: borrar el componente y dejar la ruta de `App.tsx`. Entonces `FlitoSoatSolicitud`
    // caería en `<Alta />` y una dirección guardada prometería una solicitud existente pintando un
    // formulario NUEVO en blanco. Los dos asertos hacen falta.
    await expect(page).toHaveURL(/\/flito\/soat$/);
    await expect(page.getByRole('button', { name: 'Enviar al gestor' })).toHaveCount(0);
  });
});

test.describe('HU #12079 · AC4 — la cola, los filtros y la reversa no ofrecen lo retirado', () => {
  const filaSoat = (over: Record<string, unknown> = {}) => ({
    id: UUID_SOLICITUD, vin: '9BWZZZ377VT004251', placa: PLACA, marca: 'RENAULT', linea: 'LOGAN',
    cilindraje: '1600', carroceria: 'SEDAN', tipoServicio: 'Particular',
    estado: 'con_novedad', esMultiplePropietario: false, companiaNombre: 'Transportes Sur',
    organismoNombre: 'STRIA TTEyTTO MEDELLIN', compradores: [], tramitesFlit: [], tipoTramite: null,
    fechaAprobacion: null, fechaCreacion: '2026-09-01T10:00:00Z', enviadoEn: '2026-09-01T10:00:00Z',
    pagadoEn: null, estancado: false, motivoRechazo: 'La factura no corresponde al vehículo',
    creadoEn: '2026-09-01T10:00:00Z', ...over,
  });

  async function montarCola(page: Page, items: unknown[] = []) {
    await page.route(RE_COLA, (route) => json(route, 200, {
      items, total: items.length, page: 1, pageSize: 50,
    }));
    await page.route(/\/api\/flito\/soat\/facetas/, (route) =>
      json(route, 200, { companias: [], organismos: [], proveedores: [] }));
    await page.route(RE_PROVEEDORES, (route) => json(route, 200, CATALOGO));
    await page.goto('/flito/soat');
  }

  for (const quien of ['admin', 'cliente'] as const) {
    test(`las pastillas de ${quien} no ofrecen «Pendiente de revisión» ni «Rechazada»`, async ({ page }) => {
      await loginAs(page, quien === 'admin' ? OPERACIONES_USER : CLIENTE_CON_CANAL);
      await montarCola(page, [filaSoat()]);

      await expect(page.getByRole('button', { name: 'Solicitado', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Pendiente de revisión' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Rechazada', exact: true })).toHaveCount(0);
    });
  }

  test('el selector «Estado destino» de la reversa tampoco los ofrece, y la reversa SÍ se ofrece', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montarCola(page, [filaSoat()]);
    await page.getByRole('button', { name: 'Ver' }).first().click();

    const detalle = page.getByRole('dialog');
    // Una fila del canal recupera «Reversar»: la #11915 se la quitaba por un riesgo que ya no existe.
    await detalle.getByRole('button', { name: 'Reversar' }).click();
    const destinos = detalle.getByLabel('Estado destino');
    await expect(destinos.locator('option')).toHaveText(['Pendiente', 'Solicitado', 'Pagado', 'Con novedad']);
  });

  test('el bloque «Revisión de la solicitud» ya no se monta para nadie', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montarCola(page, [filaSoat({ estado: 'solicitado', motivoRechazo: null })]);
    await page.getByRole('button', { name: 'Ver' }).first().click();

    const detalle = page.getByRole('dialog');
    await expect(detalle.getByRole('button', { name: 'Validar' })).toHaveCount(0);
    await expect(detalle.getByRole('button', { name: 'Rechazar la solicitud' })).toHaveCount(0);
    await expect(detalle.getByText(/Revisión de la solicitud|Actualizar verificación/)).toHaveCount(0);
    // Y en su lugar están las acciones de siempre para un SOAT en gestión.
    await expect(detalle.getByRole('button', { name: 'Rechazar', exact: true })).toBeVisible();
  });

  test('«Con novedad» gana el siguiente paso para el Cliente, y solo para él', async ({ page }) => {
    const FRASE = 'Su solicitud sigue abierta: FLITO está resolviendo esta novedad con el gestor. No tiene que hacer nada por ahora.';

    await loginAs(page, CLIENTE_CON_CANAL);
    await montarCola(page, [filaSoat()]);
    await page.getByRole('button', { name: 'Ver' }).first().click();
    // HU #12819 (§7.1, zona 2): el motivo va en su tarjeta, con el rótulo «Motivo de la novedad».
    await expect(page.getByRole('dialog').getByText('Motivo de la novedad')).toBeVisible();
    await expect(page.getByRole('dialog').getByText('La factura no corresponde al vehículo')).toBeVisible();
    // Es lo único que se AÑADE al retirar «Corregir y reenviar»: sin esto queda una caja roja sin
    // siguiente paso, que es exactamente lo que la retirada dejaba.
    await expect(page.getByRole('dialog').getByText(FRASE)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Corregir y reenviar' })).toHaveCount(0);

    await loginAs(page, OPERACIONES_USER);
    await montarCola(page, [filaSoat()]);
    await page.getByRole('button', { name: 'Ver' }).first().click();
    // A Operaciones no se le dice que no tiene que hacer nada: es quien tiene que hacerlo.
    await expect(page.getByRole('dialog').getByText(FRASE)).toHaveCount(0);
  });
});


// ─────────────────────────────── Auxiliares del formulario ───────────────────────────────────────

async function llenarPropietario(page: Page) {
  // El documento se edita AQUÍ desde la HU #12091: era entrada de la consulta y dejó de serlo.
  await page.getByLabel('Tipo de documento').selectOption(TIPO_DOC);
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
  // HU #13363: el bloque 4 suma otro input de archivo; la factura se busca en su bloque.
  await page.getByRole('region', { name: '2 · Factura de venta' }).locator('input[type="file"]').setInputFiles({
    name: 'factura.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 e2e'),
  });
}

/** El estado desde el que se puede enviar: los cuatro identificadores, el RUNT en verde y todo lleno. */
async function llenarTodo(page: Page) {
  await consultarRunt(page);
  await llenarPropietario(page);
  await adjuntarFactura(page);
}
