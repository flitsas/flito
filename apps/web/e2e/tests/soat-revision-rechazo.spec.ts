// HU #11915 — Revisión de Operaciones, rechazo con causal y subsanación del Cliente.
//
// Eslabón 3 de 4 del Feature #11912. Continúa `soat-cliente-solicitud.spec.ts` (#11914), que dejó al
// Cliente radicando; aquí empieza lo que Operaciones hace con lo radicado, y lo que el Cliente puede
// hacer cuando se lo devuelven.
//
// ── Método, porque sin esto media docena de asertos pasaría por vacío ───────────────────────────
//
//  1. **Los asertos NEGATIVOS y los de «no se envió nada» hacen la mitad del trabajo.** Que salga el
//     mensaje correcto no mata al mutante que ADEMÁS deja pasar la petición: por eso cada validación
//     de campo se afirma también contando las peticiones a `/rechazar-solicitud`.
//  2. **El orden de registro de las rutas importa y va al revés.** Playwright evalúa las rutas en
//     orden INVERSO de registro, así que lo más específico se registra AL FINAL: el detalle
//     (`/soat/<algo>`) casaría con `causales-rechazo`, y por eso el catálogo va después.
//  3. **`solicitud` viaja en el DETALLE (`GET /:id`) y no en la fila de la cola.** Es la única
//     superficie del modal que carga por red, y de ahí que el bloque tenga sus cuatro estados.
//  4. **Cuatro sesiones**: admin (revisa), auditor (mira), proveedor (no le existe la fila) y
//     cliente (subsana). El AC4 es exactamente la diferencia entre ellas.
//
// El backend va mockeado, como en el resto de la carpeta.
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import {
  loginAs, OPERACIONES_USER, AUDITOR_USER, PROVEEDOR_USER, CLIENTE_CON_CANAL,
} from '../helpers/auth';

const ID_REVISION = '11111111-2222-4333-8444-555555555555';
const ID_RECHAZADA = '22222222-3333-4444-8555-666666666666';
const ID_SOLICITADO = '33333333-4444-4555-8666-777777777777';
const ID_PENDIENTE = '44444444-5555-4666-8777-888888888888';

const CAUSALES = [
  { id: 'c1', nombre: 'Factura de venta ilegible', activo: true, orden: 1 },
  { id: 'c2', nombre: 'La factura de venta no corresponde al vehículo', activo: true, orden: 2 },
];

const OBSERVACION = 'La factura está cortada y no se ve el número del chasis. Vuelva a escanearla completa.';
const REVISOR = 'Ana Gómez';

const PROVEEDORES = [{ id: 'p1', nombre: 'Seguros Alfa', activo: true }];

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Una fila de la cola con la forma que `FlitoSoat` espera. */
function fila(over: Record<string, unknown> = {}) {
  return {
    id: ID_REVISION, vin: '9BWZZZ377VT004251', placa: 'REV222', marca: 'RENAULT', linea: 'LOGAN',
    cilindraje: '1600', carroceria: 'SEDAN', tipoServicio: 'Particular',
    estado: 'pendiente_revision', esMultiplePropietario: false, companiaNombre: 'Transportes Sur',
    organismoNombre: 'STRIA TTEyTTO MEDELLIN', proveedorSoatId: null, proveedorSoatNombre: null,
    gestionOperaciones: false,
    compradores: [{ nombreCompleto: 'María Gómez', numeroDocumento: '1020304050', orden: 0, porcentajeParticipacion: null }],
    tramitesFlit: [], tipoTramite: null, fechaAprobacion: null, fechaCreacion: '2026-08-01T10:00:00Z',
    enviadoPorNombre: null, enviadoEn: null, pagadoEn: null, valorPagado: null,
    estancado: false, motivoRechazo: null, creadoEn: '2026-08-01T10:00:00Z',
    ...over,
  };
}

const FILA_REVISION = fila();
const FILA_RECHAZADA = fila({ id: ID_RECHAZADA, placa: 'RCH333', vin: '9BWZZZ377VT004252', estado: 'rechazada' });
const FILA_PENDIENTE = fila({ id: ID_PENDIENTE, placa: 'PEN111', vin: '9BWZZZ377VT004253', estado: 'pendiente' });
const FILA_SOLICITADO = fila({
  id: ID_SOLICITADO, placa: 'SOL444', vin: '9BWZZZ377VT004254', estado: 'solicitado',
  proveedorSoatId: 'p1', proveedorSoatNombre: 'Seguros Alfa', enviadoEn: '2026-08-02T10:00:00Z',
});

/** El bloque `solicitud` de una solicitud SIN rechazar (la que el admin va a revisar). */
const SOLICITUD_EN_REVISION = {
  causalNombre: null, observacion: null, revisadoEn: null,
  reenvios: 0, solicitadoEn: '2026-08-28T14:00:00Z', revisadoPorNombre: null,
};

/** El bloque `solicitud` de una RECHAZADA, tal como lo recibe un lector INTERNO. */
const SOLICITUD_RECHAZADA_INTERNA = {
  causalNombre: CAUSALES[0].nombre, observacion: OBSERVACION,
  revisadoEn: '2026-08-28T16:00:00Z', reenvios: 0, solicitadoEn: '2026-08-28T14:00:00Z',
  revisadoPorNombre: REVISOR,
};

/**
 * El MISMO bloque proyectado para el `cliente`: `revisadoPorNombre` no llega vacío, NO LLEGA. Es lo
 * que hace verdadero el aserto negativo del AC3 y lo que la #11913 retiró del historial.
 */
const SOLICITUD_RECHAZADA_CLIENTE = {
  causalNombre: CAUSALES[0].nombre, observacion: OBSERVACION,
  revisadoEn: '2026-08-28T16:00:00Z', reenvios: 0, solicitadoEn: '2026-08-28T14:00:00Z',
};

interface Capturas {
  /** Los `?...` con los que se pidió la cola: es donde se comprueba que la pastilla FILTRA. */
  colas: string[];
  validaciones: { url: string; body: unknown }[];
  rechazos: { url: string; body: unknown }[];
  subsanaciones: string[];
  /**
   * El catálogo, caído o no, en un objeto MUTABLE que el test manipula.
   *
   * Y no un contador de intentos: `React.StrictMode` monta cada efecto DOS veces en desarrollo, así
   * que «falla el primero y responde el segundo» se resolvería solo, sin que nadie pulsara el botón
   * de reintento — el test pasaría midiendo StrictMode en vez de la pantalla.
   */
  catalogo: { caido: boolean };
}

interface Opciones {
  items?: unknown[];
  /** El `solicitud` que devuelve `GET /:id`. `null` = fila que no nació del canal. */
  solicitud?: unknown;
  /** `404` para el gestor, `null` para el catálogo caído. */
  causales?: unknown[] | null;
  respuestaValidar?: { status: number; cuerpo: unknown };
  respuestaRechazo?: { status: number; cuerpo: unknown };
  detalle404?: boolean;
}

/**
 * Monta la API entera de esta pantalla.
 *
 * El orden es el contrato: cuanto más específico, más tarde se registra (ver el punto 2 de la
 * cabecera). `causales-rechazo` DESPUÉS del detalle, o el detalle se lo come.
 */
async function mockApi(page: Page, o: Opciones = {}): Promise<Capturas> {
  const cap: Capturas = {
    colas: [], validaciones: [], rechazos: [], subsanaciones: [],
    catalogo: { caido: o.causales === null },
  };
  const items = o.items ?? [FILA_REVISION];

  await page.route(/\/api\/flito\/soat\?/, (route) => {
    const url = new URL(route.request().url());
    cap.colas.push(url.search);
    const estado = url.searchParams.get('estado');
    const visibles = estado ? items.filter((i) => (i as { estado: string }).estado === estado) : items;
    return json(route, 200, { items: visibles, total: visibles.length, page: 1, pageSize: 50 });
  });
  await page.route(/\/api\/flito\/soat\/facetas/, (route) =>
    json(route, 200, { companias: [], organismos: [], proveedores: [] }));
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat/, (route) => json(route, 200, PROVEEDORES));
  await page.route(/\/api\/flito\/soat\/[^/?]+\/historial/, (route) => json(route, 200, []));

  // `GET /:id` — el detalle, que es de donde sale `solicitud`.
  await page.route(/\/api\/flito\/soat\/[^/?]+$/, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    if (o.detalle404) return json(route, 404, { error: 'No encontrado' });
    const id = route.request().url().split('/').pop();
    const base = [...items, FILA_RECHAZADA].find((i) => (i as { id: string }).id === id) ?? FILA_REVISION;
    return json(route, 200, { ...(base as object), solicitud: o.solicitud ?? SOLICITUD_EN_REVISION });
  });

  await page.route(/\/api\/flito\/soat\/causales-rechazo$/, (route) => {
    if (cap.catalogo.caido) return json(route, 500, { error: 'Boom' });
    return json(route, 200, o.causales ?? CAUSALES);
  });

  await page.route(/\/api\/flito\/soat\/[^/?]+\/validar$/, (route) => {
    cap.validaciones.push({ url: route.request().url(), body: route.request().postDataJSON() });
    return o.respuestaValidar
      ? json(route, o.respuestaValidar.status, o.respuestaValidar.cuerpo)
      : json(route, 200, { id: ID_REVISION, estado: 'solicitado' });
  });

  await page.route(/\/api\/flito\/soat\/[^/?]+\/rechazar-solicitud$/, (route) => {
    cap.rechazos.push({ url: route.request().url(), body: route.request().postDataJSON() });
    return o.respuestaRechazo
      ? json(route, o.respuestaRechazo.status, o.respuestaRechazo.cuerpo)
      : json(route, 200, { id: ID_REVISION, estado: 'rechazada' });
  });

  await page.route(/\/api\/flito\/soat\/[^/?]+\/solicitud$/, (route) => {
    cap.subsanaciones.push(route.request().url());
    return json(route, 200, { id: ID_RECHAZADA, estado: 'pendiente_revision' });
  });

  return cap;
}

/** Abre el detalle de una fila por su placa. */
async function abrirDetalle(page: Page, placa: string) {
  await page.getByRole('row', { name: new RegExp(placa) }).getByRole('button', { name: 'Ver' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

// ═════════════════════════ AC1 · encontrar el trabajo y saber qué acción aplica ══════════════════

test.describe('HU #11915 · AC1 — la revisión de Operaciones', () => {
  test('la pastilla «Pendiente de revisión» FILTRA de verdad, y no solo existe', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const cap = await mockApi(page, { items: [FILA_PENDIENTE, FILA_REVISION, FILA_RECHAZADA] });
    await page.goto('/flito/soat');

    await page.getByRole('button', { name: 'Pendiente de revisión' }).click();

    // El aserto que mata al mutante: sin el estado en el `ESTADOS` del servidor la pastilla se pinta,
    // el filtro se cae EN SILENCIO (un estado desconocido se ignora, no da 400) y la cola devuelve
    // todo presentándolo como el resultado del filtro. Afirmar que la pastilla existe no lo caza.
    await expect.poll(() => cap.colas.at(-1)).toContain('estado=pendiente_revision');
    await expect(page.getByRole('row', { name: /REV222/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /PEN111/ })).toHaveCount(0);
    await expect(page.getByRole('row', { name: /RCH333/ })).toHaveCount(0);
  });

  test('las pastillas del admin NO son los destinos de la reversa: reversar al canal no se ofrece', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockApi(page, { items: [FILA_SOLICITADO] });
    await page.goto('/flito/soat');

    // Las seis pastillas incluyen los dos estados del canal…
    await expect(page.getByRole('button', { name: 'Pendiente de revisión' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rechazada' })).toBeVisible();

    // …y el selector «Estado destino» sigue teniendo CUATRO. Es el mutante de una sola línea:
    // añadir los dos estados a la lista compartida habilita reversar a `pendiente_revision`, que el
    // ADR-0008 §8 prohíbe, y ningún test anterior mira este selector.
    await abrirDetalle(page, 'SOL444');
    await page.getByRole('button', { name: 'Reversar' }).click();
    const destino = page.getByLabel('Estado destino');
    await expect(destino.locator('option')).toHaveCount(4);
    await expect(destino.locator('option', { hasText: 'Pendiente de revisión' })).toHaveCount(0);
    await expect(destino.locator('option', { hasText: 'Rechazada' })).toHaveCount(0);
  });

  /**
   * **La garantía se movió de sitio con la HU #11910, no desapareció.**
   *
   * Hasta esa HU la fila del canal no tenía casilla, y eso era lo que impedía «aprobar diez
   * solicitudes sin abrir una sola factura». Desde el AC1 de la #11910 la casilla está en TODAS las
   * filas visibles —hace falta para llevarse los soportes de una fila ya resuelta— así que lo que
   * hay que comprobar ya no es la ausencia del control, sino que **la solicitud del canal no entra
   * en el cuerpo de `POST /flito/soat/enviar`**. Eso es lo que el mutante tiene que romper, y es una
   * afirmación más fuerte que la anterior: la de antes se podía cumplir dejando la fila fuera de la
   * casilla y dentro de la petición.
   */
  test('las dos clases de fila conviven: la del canal se marca pero NO se envía, y la de trámite no tiene «Validar»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockApi(page, { items: [FILA_PENDIENTE, FILA_REVISION] });
    const enviados: unknown[] = [];
    await page.route(/\/api\/flito\/soat\/enviar$/, (route) => {
      enviados.push(route.request().postDataJSON());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enviados: 1 }) });
    });
    await page.goto('/flito/soat');

    // La de trámite: casilla sí (entra en el envío masivo), «Validar» no.
    const pendiente = page.getByRole('row', { name: /PEN111/ });
    await expect(pendiente.getByRole('checkbox')).toHaveCount(1);
    await abrirDetalle(page, 'PEN111');
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Validar' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Cerrar' }).click();

    // La del canal: «Validar» sí, y casilla también —para el ZIP de soportes—.
    await expect(page.getByRole('row', { name: /REV222/ }).getByRole('checkbox')).toHaveCount(1);
    await abrirDetalle(page, 'REV222');
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Validar' })).toBeVisible();
    await page.getByRole('button', { name: 'Cerrar' }).click();

    // Marcadas las DOS, el envío sigue siendo solo el de la fila Pendiente.
    await page.getByLabel('Seleccionar las filas de esta página').check();
    await expect(page.getByRole('button', { name: 'Enviar al gestor (1 de 2)' })).toBeVisible();
    await page.getByLabel('Enviar a').selectOption({ index: 1 });
    await page.getByRole('button', { name: /^Enviar/ }).click();

    await expect.poll(() => enviados.length).toBe(1);
    expect(enviados[0]).toMatchObject({ ids: [FILA_PENDIENTE.id] });
  });

  test('la puerta trasera se cierra: una solicitud del canal no se reversa ni cambia de proveedor', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockApi(page, { items: [FILA_REVISION, FILA_RECHAZADA] });
    await page.goto('/flito/soat');

    // Reversar una `pendiente_revision` a `pendiente` la mete en el alcance de `POST /enviar`: sería
    // despachar al gestor una solicitud que nadie validó.
    await abrirDetalle(page, 'REV222');
    await expect(page.getByRole('button', { name: /^(Reversar|Cambiar proveedor)$/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Cerrar' }).click();

    await abrirDetalle(page, 'RCH333');
    await expect(page.getByRole('button', { name: /^(Reversar|Cambiar proveedor)$/ })).toHaveCount(0);
  });

  test('«Validar» abre un panel con destino obligatorio y envía UNA sola petición', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const cap = await mockApi(page);
    await page.goto('/flito/soat');
    await abrirDetalle(page, 'REV222');

    // La fecha se afirma tolerando el año de dos cifras: `dateStyle: 'short'` en es-CO da «28/08/26»
    // en unas versiones de ICU y «28/08/2026» en otras, y eso no es lo que este test mide.
    await expect(page.getByText(/Solicitud del canal Cliente · radicada el 28\/08\/\d{2}/)).toBeVisible();
    await page.getByRole('button', { name: 'Validar' }).click();

    // Sin destino no se puede confirmar: un `solicitado` sin proveedor es un SOAT en la cola de nadie
    // y sin ANS con el que medirlo.
    const confirmar = page.getByRole('button', { name: /^Validar y enviar/ });
    await expect(confirmar).toBeDisabled();

    await page.getByLabel('Destino').selectOption({ label: 'Seguros Alfa' });
    await expect(page.getByRole('button', { name: 'Validar y enviar al gestor' })).toBeEnabled();
    await page.getByRole('button', { name: 'Validar y enviar al gestor' }).click();

    await expect.poll(() => cap.validaciones.length).toBe(1);
    expect(cap.validaciones[0].url).toContain(`/${ID_REVISION}/validar`);
    expect(cap.validaciones[0].body).toEqual({ proveedorSoatId: 'p1' });
    await expect(page.getByText('Solicitud validada y enviada al gestor.')).toBeVisible();
  });

  test('la contingencia es una opción MÁS de la misma lista, y el botón lo dice', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const cap = await mockApi(page);
    await page.goto('/flito/soat');
    await abrirDetalle(page, 'REV222');

    await page.getByRole('button', { name: 'Validar' }).click();
    await page.getByLabel('Destino').selectOption({ label: 'Gestionado por Operaciones' });
    await page.getByRole('button', { name: 'Validar y enviar a Operaciones' }).click();

    await expect.poll(() => cap.validaciones.length).toBe(1);
    // Es imposible construir el 400 de destino ambiguo: un solo control decide, así que nunca viajan
    // las dos claves.
    expect(cap.validaciones[0].body).toEqual({ gestionOperaciones: true });
    await expect(page.getByText('Solicitud validada y enviada a Operaciones.')).toBeVisible();
  });

  test('el botón de confirmar queda apagado mientras la validación está en vuelo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    let liberar = () => {};
    const puerta = new Promise<void>((r) => { liberar = r; });
    const cap = await mockApi(page);
    // Se registra DESPUÉS del mock, así que gana: retiene la respuesta hasta que el test la suelta.
    await page.route(/\/api\/flito\/soat\/[^/?]+\/validar$/, async (route) => {
      cap.validaciones.push({ url: route.request().url(), body: route.request().postDataJSON() });
      await puerta;
      return json(route, 200, { id: ID_REVISION, estado: 'solicitado' });
    });

    await page.goto('/flito/soat');
    await abrirDetalle(page, 'REV222');
    await page.getByRole('button', { name: 'Validar' }).click();
    await page.getByLabel('Destino').selectOption({ label: 'Seguros Alfa' });
    await page.getByRole('button', { name: 'Validar y enviar al gestor' }).click();

    // Sin `disabled`, un doble clic son dos validaciones y la segunda da 409: un error inexplicable
    // justo después de un éxito.
    const enVuelo = page.getByRole('button', { name: 'Validando…' });
    await expect(enVuelo).toBeVisible();
    await expect(enVuelo).toBeDisabled();
    liberar();
    await expect.poll(() => cap.validaciones.length).toBe(1);
  });

  test('si otra persona la revisó primero, se dice y se ofrece actualizar la cola', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockApi(page, {
      respuestaValidar: { status: 409, cuerpo: { error: 'Ya no está', codigo: 'estado_no_permite' } },
    });
    await page.goto('/flito/soat');
    await abrirDetalle(page, 'REV222');

    await page.getByRole('button', { name: 'Validar' }).click();
    await page.getByLabel('Destino').selectOption({ label: 'Seguros Alfa' });
    await page.getByRole('button', { name: 'Validar y enviar al gestor' }).click();

    // Se lee por el `codigo` y no por el texto del servidor: el mensaje del 409 dice otra cosa.
    await expect(page.getByText(/alguien la revisó mientras usted la tenía abierta/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Actualizar la cola' })).toBeVisible();
  });
});

// ═════════════════════════ AC2 · rechazar con causal y observación ══════════════════════════════

/** Deja abierto el formulario de rechazo de la solicitud en revisión. */
async function abrirRechazo(page: Page) {
  await page.goto('/flito/soat');
  await abrirDetalle(page, 'REV222');
  await page.getByRole('button', { name: 'Rechazar la solicitud' }).click();
}

test.describe('HU #11915 · AC2 — el rechazo pide las dos cosas', () => {
  test('sin observación no se rechaza: lo dice, marca el campo, lo enfoca y NO envía nada', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const cap = await mockApi(page);
    await abrirRechazo(page);

    await page.getByLabel('Causal del rechazo').selectOption({ label: CAUSALES[0].nombre });
    await page.getByRole('button', { name: 'Confirmar el rechazo' }).click();

    const observacion = page.getByLabel('Observación para el cliente');
    await expect(page.getByText('Escriba la observación que va a leer el cliente.')).toBeVisible();
    await expect(observacion).toHaveAttribute('aria-invalid', 'true');
    // Al CONTROL y no al mensaje: enfocándolo el lector anuncia etiqueta, inválido y descripción.
    await expect(observacion).toBeFocused();
    await expect(page.getByText('Falta la causal o la observación. Sin las dos, la solicitud no cambia de estado.')).toBeVisible();
    // El aserto que caza al mutante «validar solo la causal»: sin él, un servidor permisivo dejaría
    // pasar el test.
    expect(cap.rechazos).toHaveLength(0);
  });

  test('sin causal tampoco, y el mensaje dice CUÁL falta —no un botón muerto—', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const cap = await mockApi(page);
    await abrirRechazo(page);

    await page.getByLabel('Observación para el cliente').fill(OBSERVACION);
    const confirmar = page.getByRole('button', { name: 'Confirmar el rechazo' });
    // Con dos campos un `disabled` no puede decir cuál falta: valida AL PULSAR.
    await expect(confirmar).toBeEnabled();
    await confirmar.click();

    await expect(page.getByText('Elija la causal del rechazo.')).toBeVisible();
    await expect(page.getByLabel('Causal del rechazo')).toHaveAttribute('aria-invalid', 'true');
    expect(cap.rechazos).toHaveLength(0);
  });

  test('una observación de dos letras no es «vacía» y se lo dice con otras palabras', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const cap = await mockApi(page);
    await abrirRechazo(page);

    await page.getByLabel('Causal del rechazo').selectOption({ label: CAUSALES[0].nombre });
    await page.getByLabel('Observación para el cliente').fill('ok');
    await page.getByRole('button', { name: 'Confirmar el rechazo' }).click();

    await expect(page.getByText(/La observación es demasiado corta/)).toBeVisible();
    expect(cap.rechazos).toHaveLength(0);
  });

  test('el aviso de que lo lee una empresa tercera es VISIBLE y está enlazado al campo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockApi(page);
    await abrirRechazo(page);

    const observacion = page.getByLabel('Observación para el cliente');
    const ids = ((await observacion.getAttribute('aria-describedby')) ?? '').split(' ').filter(Boolean);
    expect(ids.length).toBeGreaterThan(0);
    const descripciones = page.locator(ids.map((i) => `#${i}`).join(', '));
    // Visible y no un `title`: un tooltip se lee DESPUÉS de haber escrito, que es tarde. Es la única
    // contención de la fuga de lenguaje interno hacia una empresa tercera.
    await expect(descripciones.filter({ hasText: /lee la empresa cliente/ })).toHaveCount(1);
    await expect(descripciones.filter({ hasText: /lee la empresa cliente/ })).toBeVisible();
    // Y el contador, que también cuelga del mismo `aria-describedby`.
    await observacion.fill('hola');
    await expect(page.getByText('4/500')).toBeVisible();
  });

  test('catálogo VACÍO: se explica, y no hay ni selector ni confirmar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockApi(page, { causales: [] });
    await abrirRechazo(page);

    await expect(page.getByText(/Todavía no hay causales de rechazo configuradas/)).toBeVisible();
    // Pintar un selector vacío haría que el admin eligiera nada, confirmara y comiera un 400 que no
    // puede arreglar.
    await expect(page.getByLabel('Causal del rechazo')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Confirmar el rechazo' })).toHaveCount(0);
    // Pero el botón que abre el formulario sigue existiendo: esconderlo haría creer que el rechazo
    // no existe en el producto.
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.getByRole('button', { name: 'Rechazar la solicitud' })).toBeVisible();
  });

  test('catálogo CAÍDO: lo dice, deja reintentar y el confirmar sigue apagado', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const cap = await mockApi(page, { causales: null });
    await abrirRechazo(page);

    await expect(page.getByText('No se pudieron cargar las causales de rechazo.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirmar el rechazo' })).toBeDisabled();

    // El catálogo se repara ANTES de pulsar: así el verde solo puede venir del reintento.
    cap.catalogo.caido = false;
    await page.getByRole('button', { name: 'Volver a cargar las causales' }).click();
    await expect(page.getByLabel('Causal del rechazo')).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Confirmar el rechazo' })).toBeEnabled();
  });

  test('con las dos: se envía la causal y la observación, y se avisa de que el cliente ya la ve', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const cap = await mockApi(page);
    await abrirRechazo(page);

    await page.getByLabel('Causal del rechazo').selectOption({ label: CAUSALES[0].nombre });
    await page.getByLabel('Observación para el cliente').fill(OBSERVACION);
    await page.getByRole('button', { name: 'Confirmar el rechazo' }).click();

    await expect.poll(() => cap.rechazos.length).toBe(1);
    expect(cap.rechazos[0].url).toContain(`/${ID_REVISION}/rechazar-solicitud`);
    expect(cap.rechazos[0].body).toEqual({ causalId: 'c1', observacion: OBSERVACION });
    await expect(page.getByText('Solicitud rechazada. El cliente ya puede ver la causal y corregirla.')).toBeVisible();
  });

  test('si la causal se desactivó, el mensaje manda a recargar el catálogo y NO se pierde lo escrito', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockApi(page, {
      respuestaRechazo: { status: 400, cuerpo: { error: 'Causal fuera del catálogo', codigo: 'causal_invalida' } },
    });
    await abrirRechazo(page);

    await page.getByLabel('Causal del rechazo').selectOption({ label: CAUSALES[0].nombre });
    await page.getByLabel('Observación para el cliente').fill(OBSERVACION);
    await page.getByRole('button', { name: 'Confirmar el rechazo' }).click();

    await expect(page.getByText('Esa causal ya no está disponible. Vuelva a cargar las causales y elija otra.')).toBeVisible();
    // El error de la acción no puede borrar una observación de tres líneas.
    await expect(page.getByLabel('Observación para el cliente')).toHaveValue(OBSERVACION);
  });
});

// ═════════════════════════ AC3 · el Cliente ve la causal, corrige y reenvía ══════════════════════

test.describe('HU #11915 · AC3 — la subsanación del Cliente', () => {
  test('en su detalle ve la causal y la observación, y NO quién la rechazó', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockApi(page, { items: [FILA_RECHAZADA], solicitud: SOLICITUD_RECHAZADA_CLIENTE });
    await page.goto('/flito/soat');
    await abrirDetalle(page, 'RCH333');

    const bloque = page.getByRole('region', { name: 'Por qué se rechazó' });
    await expect(bloque.getByText(CAUSALES[0].nombre, { exact: true })).toBeVisible();
    await expect(bloque.getByText(`«${OBSERVACION}»`)).toBeVisible();
    // Solo lo mata el aserto NEGATIVO: servir `revisadoPorNombre` al cliente pasaría el positivo.
    await expect(page.getByRole('dialog').getByText(REVISOR)).toHaveCount(0);
  });

  test('«Corregir y reenviar» existe y lleva a la subsanación de ESA fila', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockApi(page, { items: [FILA_RECHAZADA], solicitud: SOLICITUD_RECHAZADA_CLIENTE });
    await page.goto('/flito/soat');
    await abrirDetalle(page, 'RCH333');

    // Hasta esta HU el único camino a subsanar era intentar radicar otra vez el mismo VIN y chocar
    // con el modal de bloqueo de la RN-01.
    const enlace = page.getByRole('link', { name: 'Corregir y reenviar' });
    await expect(enlace).toHaveAttribute('href', `/flito/soat/solicitud/${ID_RECHAZADA}`);
    await enlace.click();
    await expect(page).toHaveURL(new RegExp(`/flito/soat/solicitud/${ID_RECHAZADA}$`));
  });

  test('la vista de subsanación ya no pinta el bloque vacío: dice la causal y reenvía la MISMA fila', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    const cap = await mockApi(page, {
      items: [FILA_RECHAZADA],
      solicitud: SOLICITUD_RECHAZADA_CLIENTE,
    });
    await page.goto(`/flito/soat/solicitud/${ID_RECHAZADA}`);

    await expect(page.getByRole('heading', { name: 'Por qué se rechazó' })).toBeVisible();
    await expect(page.getByText(CAUSALES[0].nombre, { exact: true })).toBeVisible();
    await expect(page.getByText(`«${OBSERVACION}»`)).toBeVisible();

    await page.getByLabel('Tipo de documento').selectOption('CC');
    await page.getByRole('button', { name: 'Reenviar la solicitud' }).click();

    // La ruta existe desde esta HU: hasta ayer la allowlist del canal la negaba con un 403.
    await expect.poll(() => cap.subsanaciones.length).toBe(1);
    expect(cap.subsanaciones[0]).toContain(`/flito/soat/${ID_RECHAZADA}/solicitud`);
    await expect(page.getByText('Solicitud enviada. FLITO la va a revisar.')).toBeVisible();
  });

  test('tras el reenvío el revisor no lee una razón vieja: el bloque cuenta los reenvíos', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    // Lo que el servidor devuelve DESPUÉS de subsanar: causal y observación borradas, `reenvios` a 1.
    await mockApi(page, {
      solicitud: { ...SOLICITUD_EN_REVISION, reenvios: 1 },
    });
    await page.goto('/flito/soat');
    await abrirDetalle(page, 'REV222');

    await expect(page.getByText(/Es el 1\.º reenvío de esta solicitud/)).toBeVisible();
    // Un dato correcto en el momento equivocado es la peor clase de dato en una pantalla de revisión.
    await expect(page.getByRole('dialog').getByText(CAUSALES[0].nombre)).toHaveCount(0);
  });
});

// ═════════════════════════ AC4 · quién NO valida ni rechaza ═════════════════════════════════════

test.describe('HU #11915 · AC4 — la ausencia de los controles, no un botón que da error', () => {
  test('el cliente no tiene ni «Validar» ni «Rechazar» en su solicitud en revisión', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await mockApi(page, { items: [FILA_REVISION] });
    await page.goto('/flito/soat');
    await abrirDetalle(page, 'REV222');

    const modal = page.getByRole('dialog');
    // Incluidos los deshabilitados: un botón `disabled` sin explicación es peor que su ausencia, y
    // uno que da 403 es la interfaz prometiendo lo que el servidor niega.
    await expect(modal.getByRole('button', { name: /Validar|Rechazar/ })).toHaveCount(0);
    await expect(modal.locator('button:disabled')).toHaveCount(0);
    await expect(modal.getByRole('region', { name: 'Revisión de la solicitud' })).toHaveCount(0);
  });

  test('el gestor no recibe el bloque aunque la fila llegue a su cola', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    // Adversarial a propósito: en producción la fila NO le llega —los dos estados del canal están
    // fuera de su lista blanca y `GET /:id` le responde 404—, así que aquí se le entrega igualmente
    // para comprobar que la pantalla no inventa el bloque a partir de la fila.
    await mockApi(page, { items: [FILA_REVISION], detalle404: true });
    // Su cola arranca filtrada por «Solicitado» y no tiene pastilla «Todos», así que la fila del
    // canal no le llegaría ni por accidente: se le entrega a la fuerza para poder ABRIRLA.
    await page.route(/\/api\/flito\/soat\?/, (route) =>
      json(route, 200, { items: [FILA_REVISION], total: 1, page: 1, pageSize: 50 }));
    await page.goto('/flito/soat');
    await abrirDetalle(page, 'REV222');

    const modal = page.getByRole('dialog');
    await expect(modal.getByRole('region', { name: 'Revisión de la solicitud' })).toHaveCount(0);
    await expect(modal.getByRole('button', { name: /Validar|Rechazar la solicitud/ })).toHaveCount(0);
    // Y su cola tampoco le ofrece los estados del canal.
    await page.getByRole('button', { name: 'Cerrar' }).click();
    await expect(page.getByRole('button', { name: 'Pendiente de revisión' })).toHaveCount(0);
  });

  test('auditoría ve la causal y la observación, y ninguna acción', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mockApi(page, { items: [FILA_RECHAZADA], solicitud: SOLICITUD_RECHAZADA_INTERNA });
    await page.goto('/flito/soat');
    await abrirDetalle(page, 'RCH333');

    const bloque = page.getByRole('region', { name: 'Revisión de la solicitud' });
    await expect(bloque).toContainText('Rechazada · a la espera de que el cliente corrija');
    await expect(bloque).toContainText(CAUSALES[0].nombre);
    // El lector es INTERNO: saber a quién preguntar por un rechazo de hace tres días es la mitad del
    // valor del registro.
    await expect(bloque).toContainText(new RegExp(`Rechazada el 28\\/08\\/\\d{2,4} por ${REVISOR}`));
    await expect(page.getByRole('dialog').getByRole('button', { name: /Validar|Rechazar/ })).toHaveCount(0);
  });

  test('auditoría tampoco valida ni rechaza una solicitud EN revisión, que es donde hay acciones', async ({ page }) => {
    await loginAs(page, AUDITOR_USER);
    await mockApi(page, { items: [FILA_REVISION] });
    await page.goto('/flito/soat');
    await abrirDetalle(page, 'REV222');

    // Es el caso que separa `esOperaciones && !soloLectura` de la forma tentadora `!esCliente`: con
    // ella el auditor —que no es cliente— se llevaría los dos botones sobre la fila que SÍ los tiene.
    await expect(page.getByRole('region', { name: 'Revisión de la solicitud' })).toBeVisible();
    await expect(page.getByRole('dialog').getByRole('button', { name: /Validar|Rechazar/ })).toHaveCount(0);
    await expect(page.getByText('Solo lectura · Auditoría observa, no ejecuta acciones.')).toBeVisible();
  });

  test('el admin ve la rechazada en solo lectura: ni «reactivar» ni «validar de todos modos»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockApi(page, { items: [FILA_RECHAZADA], solicitud: SOLICITUD_RECHAZADA_INTERNA });
    await page.goto('/flito/soat');
    await abrirDetalle(page, 'RCH333');

    const bloque = page.getByRole('region', { name: 'Revisión de la solicitud' });
    await expect(bloque).toContainText(CAUSALES[0].nombre);
    await expect(bloque).toContainText(`«${OBSERVACION}»`);
    // En `rechazada` la pelota es del Cliente y el único camino de vuelta es que él reenvíe: una
    // segunda salida no está en el diagrama de estados.
    await expect(page.getByRole('dialog').getByRole('button', { name: /Validar|Rechazar|Reactivar/ })).toHaveCount(0);
  });
});
