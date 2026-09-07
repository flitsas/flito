// HU #12079 — SOAT Canal Cliente: gestor por defecto de la compañía, botón de envío y retirada de
// la revisión. Feature #12074.
//
// Diseño que manda: `docs/ux/soat-envio-directo-al-gestor-y-gestor-por-defecto.md`.
//
// ── Qué se prueba aquí y qué NO ─────────────────────────────────────────────────────────────────
//
// Aquí vive lo que esta HU CREA, en sus tres superficies:
//
//   S1 · la ficha de la compañía (`/clients`) — la celda, el modal, sus cuatro estados y la
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
import { loginAs, CLIENTE_CON_CANAL, FINANCIERA_USER, OPERACIONES_USER } from '../helpers/auth';

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

const RE_CLIENTES = /\/api\/clients(\?|$)/;
const RE_PROVEEDORES = /\/api\/flito\/parametrizacion\/proveedores-soat$/;
const RE_PATCH_COMPANIA = /\/api\/flito\/parametrizacion\/companias\/\d+$/;
const RE_COLA = /\/api\/flito\/soat\?/;
const RE_PRECONSULTA = /\/api\/flito\/soat\/cliente\/preconsulta$/;

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

// ─────────────────────────────── S1 · Fixtures de la ficha ───────────────────────────────────────

type Gestor = { id: string; nombre: string; activo: boolean } | null;

/**
 * Una fila de `GET /clients` con la forma que la pantalla espera, **incluido el gestor RESUELTO**
 * (HU #12079): la respuesta trae `{ id, nombre, activo }`. El uuid va DENTRO —hace falta
 * para preseleccionar—; lo que no sale es la columna de `clients` sin resolver, porque `financiera`
 * ve esta pantalla y no puede leer el catálogo con el que cruzarlo.
 */
function cliente(id: number, name: string, soatSinTramite: boolean, gestorSoatSinTramite: Gestor) {
  return {
    id, name, document: `9001${id}`, documentType: 'NIT', phone: null, email: null,
    address: null, city: 'Medellín',
    soatAutogestionable: false, impuestosAutogestionable: false, logisticaAutogestionable: false,
    logisticaPermiteParcial: false, soatSinTramite, gestorSoatSinTramite,
  };
}

const CERRADA = cliente(1, 'Concesionario Norte', false, null);
const ABIERTA = cliente(2, 'Transportes Sur', true, { id: SURA, nombre: 'SURA', activo: true });
const CON_GESTOR_APAGADO = cliente(3, 'Flota Occidente', true, { id: MUNDIAL, nombre: 'MUNDIAL', activo: false });
/**
 * Canal ENCENDIDO y sin gestor: el estado que el diseño no nombra y la implementación añadió con
 * razón. El gate que obliga a elegir gestor es del servidor (HU #12078) y las filas ABIERTAS de
 * antes de esa regla siguen así. Sus solicitudes nuevas caen en la contingencia de Operaciones —el
 * mismo desenlace que el gestor desactivado (`resolverDestinoCanalCliente`, un solo predicado)—.
 */
const SIN_GESTOR = cliente(4, 'Rentadora Caribe', true, null);

const CATALOGO = [
  { id: SURA, nombre: 'SURA', activo: true },
  { id: AXA, nombre: 'AXA', activo: true },
  // Retirado: el catálogo lo entrega igual y filtrarlo al OFRECER es trabajo de la pantalla.
  { id: MUNDIAL, nombre: 'MUNDIAL', activo: false },
];

/**
 * Monta la ficha e intercepta las tres rutas. Devuelve los `PATCH` capturados y el CONTADOR de
 * `GET` del catálogo — contar es lo que distingue «se pidió una vez por pestaña» de «una por fila».
 */
async function montarFicha(page: Page, opciones: {
  clientes?: unknown[];
  catalogo?: 'ok' | 'error' | 'vacio' | 'pendiente';
  patch?: { status: number; cuerpo: unknown };
} = {}) {
  const filas = opciones.clientes ?? [CERRADA, ABIERTA];
  const patches: Record<string, unknown>[] = [];
  const catalogos: string[] = [];
  let modo = opciones.catalogo ?? 'ok';
  /** Compuerta para dejar el `GET` del catálogo EN VUELO el tiempo que el test quiera. */
  let abrir: () => void = () => {};
  const enVuelo = new Promise<void>((r) => { abrir = () => r(); });

  await page.route(RE_CLIENTES, (route) => json(route, 200, filas));
  // El informe de facturables se pide aparte y su fallo no puede tumbar esta pantalla.
  await page.route(/\/api\/siigo\/clientes\/validacion\/detalle/, (route) => json(route, 200, { data: [] }));
  await page.route(RE_PROVEEDORES, async (route) => {
    catalogos.push(route.request().url());
    if (modo === 'pendiente') await enVuelo;
    if (modo === 'error') return json(route, 500, { error: 'Catálogo caído' });
    return json(route, 200, modo === 'vacio' ? [] : (opciones.clientes ? CATALOGO : CATALOGO));
  });
  await page.route(RE_PATCH_COMPANIA, (route) => {
    patches.push(route.request().postDataJSON() as Record<string, unknown>);
    return opciones.patch
      ? json(route, opciones.patch.status, opciones.patch.cuerpo)
      : json(route, 200, { id: 1 });
  });

  return {
    patches,
    catalogos,
    liberarCatalogo: () => abrir(),
    arreglarCatalogo: () => { modo = 'ok'; },
  };
}

const celda = (page: Page, nombre: string, texto: string) =>
  page.getByRole('button', { name: `SOAT sin trámite de ${nombre}: ${texto}` });

// ═══════════════════════ S1 · AC0 — el gestor se configura donde se abre el canal ═════════════════

test.describe('HU #12079 · AC0 — la celda de la ficha de la compañía', () => {
  test('la tabla NO engorda: 12 columnas, un solo control por fila y ninguna casilla del canal', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montarFicha(page);
    await page.goto('/clients');

    // El mutante que este aserto mata es la disposición descartada: una 13.ª columna con un
    // `FlitSelect` por fila — cientos de regiones `role="status"` vivas y una parada de tabulador
    // más por compañía.
    await expect(page.getByRole('columnheader')).toHaveCount(12);
    await expect(page.getByRole('checkbox', { name: /SOAT sin trámite de/ })).toHaveCount(0);
  });

  test('el nombre accesible CONTIENE el texto visible (WCAG 2.5.3) y lleva el nombre, no el NIT', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montarFicha(page, { clientes: [CERRADA, ABIERTA, CON_GESTOR_APAGADO] });
    await page.goto('/clients');

    const abierta = celda(page, 'Transportes Sur', 'Abierto · SURA');
    // Los DOS asertos, y ninguno sobra: con un `aria-label` que empiece por «Configurar…» el
    // segundo pasa y el primero no — y quien maneja el producto por voz dice «Abierto · SURA» y no
    // pasa nada (SC 2.5.3, «Label in Name»).
    await expect(abierta).toHaveAccessibleName('SOAT sin trámite de Transportes Sur: Abierto · SURA');
    await expect(abierta).toHaveText('Abierto · SURA');
    await expect(celda(page, 'Concesionario Norte', 'Cerrado')).toHaveText('Cerrado');
    // El gestor desactivado se DICE, y en el texto: es el aviso de que esa compañía está radicando
    // en la contingencia de Operaciones sin que nadie se haya enterado. El color es refuerzo.
    await expect(celda(page, 'Flota Occidente', 'Abierto · MUNDIAL (inactivo)')).toBeVisible();
    // Y el NIT no entra en ningún nombre accesible: los selectores de axe arrastran valores de
    // atributo hasta 31 caracteres y acabarían en el informe.
    await expect(page.getByRole('button', { name: /9001\d/ })).toHaveCount(0);
  });

  test('«Abierto · sin gestor»: la celda lo DICE, en el mismo tono de aviso, y el modal lo deja resolver', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const cap = await montarFicha(page, { clientes: [SIN_GESTOR] });
    await page.goto('/clients');

    // El mutante que esto mata es pintar «Abierto» a secas: callaría exactamente el mismo problema
    // que «(inactivo)» existe para contar —esa compañía está radicando en la contingencia—.
    const celdaSinGestor = celda(page, 'Rentadora Caribe', 'Abierto · sin gestor');
    await expect(celdaSinGestor).toHaveText('Abierto · sin gestor');

    // El color es REFUERZO y no portador único —el texto ya lo dice—, pero tiene que ser legible:
    // `--flit-warning-ink` (#B94120 → rgb(185, 65, 32)) da 5,47:1 sobre la tarjeta blanca. El
    // mutante que esto mata es volver al `--flit-warning` que pide el documento de UX: #F05A35 se
    // queda en 3,38:1 e incumple el SC 1.4.3.
    await expect(celdaSinGestor).toHaveCSS('color', 'rgb(185, 65, 32)');

    // Y se resuelve donde se configura: el modal abre con el interruptor ENCENDIDO y el gestor en
    // blanco, y guardar así no manda nada (misma guarda del AC0).
    await celdaSinGestor.click();
    const modal = page.getByRole('dialog', { name: 'SOAT sin trámite · Rentadora Caribe' });
    await expect(modal.getByLabel('Canal abierto')).toBeChecked();
    await expect(modal.getByLabel('Gestor por defecto')).toHaveValue('');

    await modal.getByRole('button', { name: 'Guardar' }).click();
    await expect(modal.getByRole('alert')).toHaveText('Elija el gestor por defecto antes de abrir el canal.');
    expect(cap.patches).toHaveLength(0);

    // Elegir el gestor lo arregla en una sola petición: el canal ya estaba abierto y sigue abierto.
    await modal.getByLabel('Gestor por defecto').selectOption(SURA);
    await modal.getByRole('button', { name: 'Guardar' }).click();
    await expect.poll(() => cap.patches).toHaveLength(1);
    expect(cap.patches[0]).toEqual({ soatSinTramite: true, proveedorSoatSinTramiteId: SURA });
  });

  test('sin permiso de edición se lee el estado completo y NO hay botón que pulsar', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    const cap = await montarFicha(page, { clientes: [CERRADA, ABIERTA] });
    await page.goto('/clients');

    await expect(page.getByText('Abierto · SURA')).toBeVisible();
    await expect(page.getByText('Cerrado')).toBeVisible();
    await expect(page.getByRole('button', { name: /SOAT sin trámite de/ })).toHaveCount(0);
    // Y no se pide un catálogo que esa ruta le negaría con un 403: `financiera` no está en
    // `requireRole('admin','auditor')`. Sin esto, la pantalla pintaría un fallo de catálogo que no
    // se le ofrece a nadie.
    expect(cap.catalogos).toHaveLength(0);
  });

  test('el catálogo se pide por PESTAÑA, no una vez por fila ni una por apertura del modal', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    // TRES filas a propósito: el conteo es lo único que distingue «una por pestaña» de «una por
    // fila», que es la disposición descartada.
    const cap = await montarFicha(page, { clientes: [CERRADA, ABIERTA, CON_GESTOR_APAGADO] });
    await page.goto('/clients');
    await expect(celda(page, 'Transportes Sur', 'Abierto · SURA')).toBeVisible();

    // No se afirma «exactamente 1»: en desarrollo `React.StrictMode` monta, desmonta y vuelve a
    // montar cada efecto, así que un hook correcto pide DOS veces y uno por fila pediría SEIS. Lo
    // que se afirma es lo que de verdad importa y lo que ningún modo de React cambia: **menos
    // peticiones que filas**, y **ninguna más** al abrir modales.
    const traLaCarga = cap.catalogos.length;
    expect(traLaCarga).toBeLessThan(3);

    await celda(page, 'Concesionario Norte', 'Cerrado').click();
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await celda(page, 'Transportes Sur', 'Abierto · SURA').click();
    await expect(page.getByRole('dialog', { name: 'SOAT sin trámite · Transportes Sur' })).toBeVisible();

    expect(cap.catalogos).toHaveLength(traLaCarga);
  });
});

test.describe('HU #12079 · AC0 — el modal: los dos controles son UN borrador', () => {
  test('el orden NO importa (a): encender primero y elegir gestor después → UNA sola petición', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const cap = await montarFicha(page);
    await page.goto('/clients');
    await celda(page, 'Concesionario Norte', 'Cerrado').click();

    const modal = page.getByRole('dialog', { name: 'SOAT sin trámite · Concesionario Norte' });
    await modal.getByLabel('Canal abierto').check();
    await modal.getByLabel('Gestor por defecto').selectOption(SURA);
    await modal.getByRole('button', { name: 'Guardar' }).click();

    // UNA. El mutante que esto mata es un `PATCH` por control —que es lo que hoy hacen las otras
    // cuatro banderas—: con dos peticiones, encender primero es un 400 seguro y el usuario tiene
    // que adivinar la secuencia correcta.
    await expect.poll(() => cap.patches).toHaveLength(1);
    expect(cap.patches[0]).toEqual({ soatSinTramite: true, proveedorSoatSinTramiteId: SURA });
  });

  test('el orden NO importa (b): elegir gestor primero y encender después → UNA sola petición', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const cap = await montarFicha(page);
    await page.goto('/clients');
    await celda(page, 'Concesionario Norte', 'Cerrado').click();

    const modal = page.getByRole('dialog', { name: 'SOAT sin trámite · Concesionario Norte' });
    await modal.getByLabel('Gestor por defecto').selectOption(AXA);
    await modal.getByLabel('Canal abierto').check();
    await modal.getByRole('button', { name: 'Guardar' }).click();

    await expect.poll(() => cap.patches).toHaveLength(1);
    expect(cap.patches[0]).toEqual({ soatSinTramite: true, proveedorSoatSinTramiteId: AXA });
  });

  test('canal abierto sin gestor: se ve, se enfoca, NO viaja nada y el interruptor SIGUE encendido', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const cap = await montarFicha(page);
    await page.goto('/clients');
    await celda(page, 'Concesionario Norte', 'Cerrado').click();

    const modal = page.getByRole('dialog', { name: 'SOAT sin trámite · Concesionario Norte' });
    const interruptor = modal.getByLabel('Canal abierto');
    await interruptor.check();
    await modal.getByRole('button', { name: 'Guardar' }).click();

    await expect(modal.getByRole('alert')).toHaveText('Elija el gestor por defecto antes de abrir el canal.');
    await expect(modal.getByLabel('Gestor por defecto')).toBeFocused();
    // El aserto que mata al mutante «delegar en el 400 del servidor»: los otros dos pasarían igual.
    expect(cap.patches).toHaveLength(0);
    // Y el borrador no se castiga: encendido se queda, para que solo haya que elegir el gestor.
    await expect(interruptor).toBeChecked();
    await expect(modal).toBeVisible();

    // Elegir el gestor retira el rechazo y guarda a la primera: dos clics, no cuatro.
    await modal.getByLabel('Gestor por defecto').selectOption(SURA);
    await expect(modal.getByRole('alert')).toHaveCount(0);
    await modal.getByRole('button', { name: 'Guardar' }).click();
    await expect.poll(() => cap.patches).toHaveLength(1);
  });

  test('apagar el canal NO obliga a quitar el gestor: se guarda y el gestor sigue viajando', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const cap = await montarFicha(page);
    await page.goto('/clients');
    await celda(page, 'Transportes Sur', 'Abierto · SURA').click();

    const modal = page.getByRole('dialog', { name: 'SOAT sin trámite · Transportes Sur' });
    await modal.getByLabel('Canal abierto').uncheck();
    await modal.getByRole('button', { name: 'Guardar' }).click();

    await expect.poll(() => cap.patches).toHaveLength(1);
    expect(cap.patches[0]).toEqual({ soatSinTramite: false, proveedorSoatSinTramiteId: SURA });
  });

  test('el gestor DESACTIVADO no se pierde por la espalda: sale seleccionado, con «(inactivo)», y se reenvía', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const cap = await montarFicha(page, { clientes: [CON_GESTOR_APAGADO] });
    await page.goto('/clients');
    await celda(page, 'Flota Occidente', 'Abierto · MUNDIAL (inactivo)').click();

    const modal = page.getByRole('dialog', { name: 'SOAT sin trámite · Flota Occidente' });
    const selector = modal.getByLabel('Gestor por defecto');
    await expect(selector).toHaveValue(MUNDIAL);
    await expect(selector.locator(`option[value="${MUNDIAL}"]`)).toHaveText('MUNDIAL (inactivo)');
    // Guardar SIN tocarlo manda el MISMO id. El mutante —filtrar el catálogo por `activo` sin
    // reinyectar el asignado— deja el `<select>` en blanco y se lleva el gestor de la compañía.
    await modal.getByRole('button', { name: 'Guardar' }).click();
    await expect.poll(() => cap.patches).toHaveLength(1);
    expect(cap.patches[0]).toEqual({ soatSinTramite: true, proveedorSoatSinTramiteId: MUNDIAL });
  });

  test('la advertencia va ANTES en la ayuda del campo y DESPUÉS en el toast, sin diálogo de confirmación', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montarFicha(page);
    await page.goto('/clients');
    await celda(page, 'Transportes Sur', 'Abierto · SURA').click();

    const modal = page.getByRole('dialog', { name: 'SOAT sin trámite · Transportes Sur' });
    await expect(modal.getByText('A este gestor salen las solicitudes NUEVAS del canal. Las ya radicadas conservan el gestor que tienen.')).toBeVisible();

    await modal.getByLabel('Gestor por defecto').selectOption(AXA);
    await modal.getByRole('button', { name: 'Guardar' }).click();

    await expect(page.getByText('Gestor por defecto actualizado. Las solicitudes ya radicadas conservan el suyo.')).toBeVisible();
    // Sin `confirm`: la consecuencia no es destructiva y la pantalla ya lo dijo antes.
    await expect(page.getByRole('dialog', { name: /¿|Confirmar/ })).toHaveCount(0);
  });

  test('el servidor rechaza: el mensaje se lee LITERAL, el modal no se cierra y el borrador no se pierde', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montarFicha(page, {
      patch: { status: 400, cuerpo: { error: 'El gestor por defecto no existe o está inactivo' } },
    });
    await page.goto('/clients');
    await celda(page, 'Concesionario Norte', 'Cerrado').click();

    const modal = page.getByRole('dialog', { name: 'SOAT sin trámite · Concesionario Norte' });
    await modal.getByLabel('Canal abierto').check();
    await modal.getByLabel('Gestor por defecto').selectOption(AXA);
    await modal.getByRole('button', { name: 'Guardar' }).click();

    await expect(modal.getByRole('alert')).toHaveText('El gestor por defecto no existe o está inactivo');
    await expect(modal).toBeVisible();
    await expect(modal.getByLabel('Canal abierto')).toBeChecked();
    await expect(modal.getByLabel('Gestor por defecto')).toHaveValue(AXA);
  });
});

test.describe('HU #12079 · AC0 — los cuatro estados del catálogo de gestores', () => {
  test('cargando: el selector lo dice, y con el canal cerrado se puede guardar igual', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const cap = await montarFicha(page, { catalogo: 'pendiente' });
    await page.goto('/clients');
    await celda(page, 'Concesionario Norte', 'Cerrado').click();

    const modal = page.getByRole('dialog', { name: 'SOAT sin trámite · Concesionario Norte' });
    await expect(modal.getByText('Cargando gestores…')).toBeVisible();
    await expect(modal.getByLabel('Gestor por defecto')).toBeDisabled();
    cap.liberarCatalogo();
  });

  test('error: mensaje propio Y botón que dispara un SEGUNDO GET', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const cap = await montarFicha(page, { catalogo: 'error' });
    await page.goto('/clients');
    await celda(page, 'Concesionario Norte', 'Cerrado').click();

    const modal = page.getByRole('dialog', { name: 'SOAT sin trámite · Concesionario Norte' });
    await expect(modal.getByText('No se pudieron cargar los gestores.')).toBeVisible();
    const antes = cap.catalogos.length;

    // El botón no es decorativo: dispara un `GET` NUEVO. Es la mitad que mata al mutante de pintar
    // un reintento que solo repinta el mensaje. (Se compara contra `antes` y no contra 1 por el
    // doble montaje de `React.StrictMode` en desarrollo.)
    cap.arreglarCatalogo();
    await modal.getByRole('button', { name: 'Volver a cargar gestores' }).click();
    await expect.poll(() => cap.catalogos.length).toBeGreaterThan(antes);
    await expect(modal.getByLabel('Gestor por defecto')).toBeEnabled();
  });

  test('vacío: nombra la pantalla donde se crean y NO ofrece reintento', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montarFicha(page, { catalogo: 'vacio' });
    await page.goto('/clients');
    await celda(page, 'Concesionario Norte', 'Cerrado').click();

    const modal = page.getByRole('dialog', { name: 'SOAT sin trámite · Concesionario Norte' });
    await expect(modal.getByText('No hay gestores de SOAT activos. Cree uno en la pestaña Proveedores antes de abrir el canal de esta compañía.')).toBeVisible();
    // Volver a pedir la lista no crea gestores: un botón que no arregla nada es peor que ninguno.
    // Y el mutante que esto mata es colapsar error y vacío en el mismo texto.
    await expect(modal.getByRole('button', { name: 'Volver a cargar gestores' })).toHaveCount(0);
    await expect(modal.getByText('No se pudieron cargar los gestores.')).toHaveCount(0);
  });

  test('lleno: solo los ACTIVOS, más la opción vacía, y cada opción con su etiqueta', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montarFicha(page);
    await page.goto('/clients');
    await celda(page, 'Concesionario Norte', 'Cerrado').click();

    const selector = page.getByRole('dialog').getByLabel('Gestor por defecto');
    await expect(selector.locator('option')).toHaveText(['Seleccione gestor…', 'SURA', 'AXA']);
  });

  // ── El hueco que la ronda de QA encontró ────────────────────────────────────────────────────────
  //
  // Con el catálogo SANO quien bloquea «canal abierto sin gestor» es el `required={abierto}` nativo
  // del `FlitSelect`, no la guarda de `guardar`. Por eso borrar la guarda dejaba los 15 tests de AC0
  // en verde: ninguno pisaba el estado en el que la guarda es la ÚNICA defensa.
  //
  // Ese estado es el que su propio comentario nombra: catálogo **caído** o **vacío**. Ahí el
  // `<select>` va `disabled`, un control `disabled` queda FUERA de la validación del navegador, el
  // `required` no dispara y —sin guarda— la pantalla manda
  // `PATCH {soatSinTramite: true, proveedorSoatSinTramiteId: null}`, que el servidor rechaza por
  // contrato (HU #12078). Medido con el mutante: una petición inválida en los dos modos.
  for (const modo of ['error', 'vacio'] as const) {
    test(`catálogo ${modo}: abrir el canal y guardar NO manda NADA — aquí el \`required\` nativo no dispara`, async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      const cap = await montarFicha(page, { catalogo: modo });
      await page.goto('/clients');
      await celda(page, 'Concesionario Norte', 'Cerrado').click();

      const modal = page.getByRole('dialog', { name: 'SOAT sin trámite · Concesionario Norte' });
      // La premisa que hace PORTANTE a la guarda, afirmada y no supuesta: si algún día el selector
      // dejara de ir `disabled` en estos dos modos, este aserto cae y el test cambia de sentido.
      await expect(modal.getByLabel('Gestor por defecto')).toBeDisabled();

      await modal.getByLabel('Canal abierto').check();
      await modal.getByRole('button', { name: 'Guardar' }).click();

      // Una ventana REAL antes de contar, y por eso una espera fija: contar justo tras el clic sería
      // verde trivial —se cumple en el primer instante, sin darle a la petición tiempo de salir—, y
      // para un aserto NEGATIVO no hay `expect.poll` que valga. La ruta apunta el `PATCH` en cuanto
      // llega, así que en un segundo ya estaría apuntado.
      await page.waitForTimeout(1000);
      // El aserto que mata al mutante, y va PRIMERO para que sea él quien caiga. Medido con la
      // guarda borrada: `Received length: 1`, cuerpo
      // `{"soatSinTramite":true,"proveedorSoatSinTramiteId":null}` — una petición inválida por
      // contrato (HU #12078), que el mensaje del aserto imprime entera.
      expect(cap.patches, JSON.stringify(cap.patches)).toHaveLength(0);
      // Y el desenlace correcto: el rechazo lo pone el CLIENTE, no un 400 del servidor.
      await expect(modal.getByRole('alert')).toHaveText('Elija el gestor por defecto antes de abrir el canal.');
      // El modal no se cierra y el borrador no se castiga: queda encendido, a la espera de que
      // alguien arregle el catálogo o apague el canal.
      await expect(modal).toBeVisible();
      await expect(modal.getByLabel('Canal abierto')).toBeChecked();
    });
  }
});

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
  await expect(page.getByText('✓ Consultado')).toBeVisible();
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
    await page.getByRole('dialog').getByRole('button', { name: 'Cerrar' }).click();

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
    await expect(page.getByText('Al enviarla, su SOAT entra en gestión de inmediato. No se guarda como borrador.')).toBeVisible();
    await expect(page.getByText('Al enviarla, su SOAT entra en gestión de inmediato.', { exact: false }).first()).toBeVisible();

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
    await expect(page.getByRole('dialog').getByText('Motivo de rechazo: La factura no corresponde al vehículo')).toBeVisible();
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

// ═══════════ La ficha de ayuda in-app de «Clientes y proveedores» ════════════════════════════════
//
// `flito-ayuda-fichas-gestion.spec.ts` comprueba ESTRUCTURA —que la ficha está publicada, que tiene
// sus seis `h2` y que no dice «Esta ficha está pendiente.»—, y con esa vara la ficha podría seguir
// describiendo la CASILLA que esta HU sustituyó por un botón con estado. Este test vive aquí, en el
// spec de la HU que cambió la pantalla, porque es esta HU la que puede dejar la ficha mintiendo.
//
// La técnica es la de `soat-cliente-solicitud.spec.ts:854`: los literales NO se teclean, se leen del
// DOM de `/clients` y luego se le exigen a la ficha. Así, el día que «Abierto · sin gestor» cambie
// de redacción, la ficha se pone roja sin que nadie tenga que acordarse de ella.
//
// Se lee con **Operaciones**: `ayudaFlito.puedeVerEntradaAyuda` le niega toda ficha al rol
// `cliente`, y esta pantalla no es suya de todos modos.
test.describe('HU #12079 · la ficha de ayuda in-app de Clientes y proveedores', () => {
  test('la ficha nombra los CUATRO textos de la columna —«Abierto · sin gestor» incluido— y qué hacer con ellos', async ({ page }) => {
    // ── 1 · Lo que la columna dice HOY, leído del DOM ────────────────────────────────────────────
    // Una fila por estado. El desactivado se monta con SURA a propósito: la ficha lo cita como
    // ejemplo con ESE nombre, y así el aserto comprueba que el ejemplo está bien FORMADO —«(inactivo)»
    // entre paréntesis y al final— y no solo que alguien escribió la palabra.
    const SURA_APAGADO = cliente(5, 'Autos del Valle', true, { id: SURA, nombre: 'SURA', activo: false });
    await loginAs(page, OPERACIONES_USER);
    await montarFicha(page, { clientes: [CERRADA, ABIERTA, SIN_GESTOR, SURA_APAGADO] });
    await page.goto('/clients');

    const textos: string[] = [];
    for (const [compania, esperado] of [
      ['Concesionario Norte', 'Cerrado'],
      ['Transportes Sur', 'Abierto · SURA'],
      ['Rentadora Caribe', 'Abierto · sin gestor'],
      ['Autos del Valle', 'Abierto · SURA (inactivo)'],
    ] as const) {
      textos.push((await celda(page, compania, esperado).innerText()).trim());
    }
    // Y el rótulo del modal, que es a donde la ficha manda a resolverlo.
    await celda(page, 'Rentadora Caribe', 'Abierto · sin gestor').click();
    const modal = page.getByRole('dialog', { name: 'SOAT sin trámite · Rentadora Caribe' });
    const etiquetaGestor = (await modal.getByText('Gestor por defecto').first().innerText()).trim();

    // ── 2 · La ficha PUBLICADA ──────────────────────────────────────────────────────────────────
    await page.goto('/flito/ayuda/clients');
    const ficha = page.getByRole('article', { name: 'Clientes y proveedores' });
    await expect(ficha).toBeVisible();
    await expect(page.getByText('Esta ficha está pendiente.')).toHaveCount(0);

    for (const literal of [...textos, etiquetaGestor]) {
      await expect(ficha, literal).toContainText(literal);
    }

    // Lo que «Abierto · sin gestor» SIGNIFICA y qué hay que hacer: sin esto, la ficha podría
    // limitarse a repetir el rótulo y dejar al administrador sin saber que esa fila está radicando
    // en la contingencia. Es el MISMO desenlace que el gestor desactivado
    // (`resolverDestinoCanalCliente`: un solo predicado para los dos casos).
    for (const frase of [
      'el canal está abierto pero esa compañía no tiene Gestor por defecto configurado',
      'sus solicitudes nuevas quedan Gestionado por Operaciones, igual que si el gestor estuviera desactivado',
    ]) {
      await expect(ficha, frase).toContainText(frase);
    }
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
  await page.locator('input[type="file"]').setInputFiles({
    name: 'factura.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 e2e'),
  });
}

/** El estado desde el que se puede enviar: los cuatro identificadores, el RUNT en verde y todo lleno. */
async function llenarTodo(page: Page) {
  await consultarRunt(page);
  await llenarPropietario(page);
  await adjuntarFactura(page);
}
