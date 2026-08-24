// FLITO — Comparendos: detalle, línea de tiempo y gestión (HU #11562, AC1..AC8).
//
// Tres cosas que este archivo afirma y que no se pueden afirmar mirando la pantalla:
//
//   1. **Refrescar no es re-consultar** (AC3). Todas las peticiones al módulo quedan en una traza y
//      el test cuenta: tras guardar tiene que seguir habiendo UN `GET /registros/:id` y UNA petición
//      de listado. Un `GET` de más sería el bug —movería la lista bajo los pies de quien acaba de
//      gestionar y gastaría una fila del registro de acceso PII por gestión—, y sin contar las
//      peticiones se vería exactamente igual de bien en pantalla.
//   2. **El evento nuevo lo pone el SERVIDOR.** El cuerpo del `PATCH` que sirven estos mocks trae un
//      evento que el cliente no podría haber adivinado (`gestion_retirada` cuando se limpian los dos
//      campos) y un evento de sync que llegó mientras el formulario estaba abierto. Si algún día
//      alguien fabrica el evento en local, los dos se pierden y estos tests lo dicen.
//   3. **El tope de la observación se comprueba antes de la red** (AC6): se escribe por encima del
//      máximo y se afirma que NO salió ningún `PATCH`.
//
// `timezoneId: 'Asia/Tokyo'` en todo el archivo, a propósito: la máquina de desarrollo está en −05,
// `playwright.config.ts` no fija huso y este panel es el primero que pinta HORAS. Un test que corre
// en Bogotá no puede distinguir «formatea en Colombia» de «formatea en la máquina de quien mira».
//
// Datos SINTÉTICOS (Ley 1581): «900123456» y «ABC123» son de ejemplo. Ni un dato real entra en un
// spec, ni siquiera en un fixture.
import { COMPARENDOS_OBSERVACION_MAX } from '@operaciones/shared-types';
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';

const API = '**/api/flito/comparendos/**';
const REGISTRO_ID = '11111111-1111-4111-8111-111111111111';
const CAUSAL_A = '453cc851-646e-4001-b936-6abe0b7a0570';
const CAUSAL_B = '9b1f2f7e-2f1a-4c2e-8f0a-2b6a1d3c4e5f';
const CAUSAL_VIEJA = 'c0ffee00-0000-4000-8000-000000000001';

const FILA = {
  id: REGISTRO_ID,
  numeroComparendo: '11001000123456',
  nitMonitoreado: '900123456',
  placa: 'ABC123',
  codigoInfraccion: 'C29',
  descripcionInfraccion: 'Estacionar en zona prohibida',
  fechaComparendo: '2026-07-12',
  organismo: 'Secretaría de Movilidad de Medellín',
  municipioFuente: 'ITAGUI',
  monto: '604100.00',
  estadoFuente: 'EN COBRO COACTIVO',
  origenMerge: 'ambos',
  vistoEnSimit: true,
  vistoEnMunicipal: true,
  estado: 'activo',
  // 03:12Z es el 16 en Bogotá (22:12) y el 17 en Tokio (12:12): el instante que separa las dos.
  primeraVistoEn: '2026-08-17T03:12:00Z',
  ultimoVistoEn: '2026-08-18T13:07:00Z',
  inactivadoEn: null,
  ultimoSyncRunId: null,
  causalId: null,
  observacion: null,
  gestionActualizadaEn: null,
  gestionActualizadaPor: null,
  creadoEn: '2026-08-17T03:12:00Z',
  actualizadoEn: '2026-08-18T13:07:00Z',
};

/** La segunda fila existe para que «se actualizó la fila X» no pase por «se repintó la tabla». */
const OTRA_FILA = {
  ...FILA,
  id: '22222222-2222-4222-8222-222222222222',
  numeroComparendo: '05001000998877',
  placa: null,
  causalId: null,
};

const PAGINA = { items: [FILA, OTRA_FILA], nextCursor: null };

const EV_ALTA = {
  id: 'e1', tipo: 'primera_llegada', syncRunId: null,
  detalle: { origen: 'simit' }, ocurridoEn: '2026-07-02T08:12:00Z',
};
const EV_INACTIVACION = {
  id: 'e2', tipo: 'inactivacion', syncRunId: null,
  detalle: { motivo: 'ausente_en_todas_las_fuentes' }, ocurridoEn: '2026-05-12T08:11:00Z',
};
const EV_REAPARICION = {
  id: 'e3', tipo: 'reaparicion', syncRunId: null,
  detalle: { origen: 'municipal' }, ocurridoEn: '2026-06-28T08:20:00Z',
};
/** Sin `detalle`: la comprobación de «un evento sin detalle conocido se muestra igual» (AC2). */
const EV_SIN_DETALLE = {
  id: 'e4', tipo: 'reaparicion', syncRunId: null,
  detalle: null, ocurridoEn: '2026-04-01T08:00:00Z',
};
/** Con una clave que NO está en la lista blanca del API: no se pinta, y el evento tampoco se va. */
const EV_CLAVE_RARA = {
  id: 'e5', tipo: 'primera_llegada', syncRunId: null,
  detalle: { causalId: CAUSAL_A, actorId: 5 }, ocurridoEn: '2026-03-01T08:00:00Z',
};

const DETALLE = { ...FILA, eventos: [EV_ALTA, EV_REAPARICION, EV_INACTIVACION] };

const CAUSALES = [
  { id: CAUSAL_B, nombre: 'Notificado al cliente', activo: true, orden: 2, creadoEn: '', actualizadoEn: '' },
  { id: CAUSAL_A, nombre: 'En verificación', activo: true, orden: 1, creadoEn: '', actualizadoEn: '' },
  { id: CAUSAL_VIEJA, nombre: 'Causal retirada', activo: false, orden: 3, creadoEn: '', actualizadoEn: '' },
];

interface Traza {
  /** `${método} ${pathname}` de CADA petición al módulo. Es lo que prueba el AC3. */
  peticiones: string[];
  /** Cuerpos de los `PATCH` de gestión, tal cual salieron. */
  cuerpos: string[];
  lista: { status: number; body: unknown };
  detalle: { status: number; body: unknown };
  gestion: { status: number; body: unknown };
}

/**
 * Un solo `route` para todo el módulo, y no uno por endpoint.
 *
 * Los mocks se sirven TODOS aunque el test no los mire —lo pide la spec de UX— y, sobre todo, una
 * sola traza ordenada es lo que permite afirmar «no salió ninguna petición más», que es una
 * afirmación sobre el conjunto y no sobre una ruta.
 */
async function mockModulo(page: Page): Promise<Traza> {
  const traza: Traza = {
    peticiones: [],
    cuerpos: [],
    lista: { status: 200, body: PAGINA },
    detalle: { status: 200, body: DETALLE },
    gestion: { status: 200, body: DETALLE },
  };
  await page.route(API, (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const ruta = url.pathname.replace('/api/flito/comparendos', '');
    traza.peticiones.push(`${req.method()} ${ruta}`);

    const json = (elegida: { status: number; body: unknown }) => route.fulfill({
      status: elegida.status,
      contentType: 'application/json',
      body: JSON.stringify(elegida.body),
    });

    if (ruta === '/municipios') {
      return json({ status: 200, body: [{ id: 'm1', codigoFuente: 'ITAGUI', nombre: 'Itagüí', activo: true, creadoEn: '', actualizadoEn: '' }] });
    }
    if (ruta === '/causales') return json({ status: 200, body: CAUSALES });
    if (ruta === '/nits') {
      return json({ status: 200, body: [{ id: 'n1', nit: '900123456', alias: 'Transportes Andinos SAS', activo: true, creadoEn: '', actualizadoEn: '' }] });
    }
    if (ruta.endsWith('/gestion')) {
      traza.cuerpos.push(req.postData() ?? '');
      return json(traza.gestion);
    }
    if (/\/registros\/[^/]+$/.test(ruta)) return json(traza.detalle);
    return json(traza.lista);
  });
  return traza;
}

const abrirLista = async (page: Page) => {
  await loginAs(page, OPERACIONES_USER);
  const traza = await mockModulo(page);
  await page.goto('/flito/comparendos');
  await expect(page.getByRole('button', { name: `Ver el comparendo ${FILA.numeroComparendo}` })).toBeVisible();
  return traza;
};

const panel = (page: Page) => page.getByRole('dialog');
const boton = (page: Page, nombre: string) => page.getByRole('button', { name: nombre, exact: true });
const eventos = (page: Page) => panel(page).getByRole('listitem');

/** Cuántas veces se pidió algo que empieza por `prefijo`. */
const veces = (traza: Traza, prefijo: string) =>
  traza.peticiones.filter((p) => p.startsWith(prefijo)).length;

test.describe('FLITO — Comparendos · detalle y gestión (HU #11562)', () => {
  // El huso es del archivo entero: el panel pinta horas y la máquina de desarrollo está en −05.
  test.use({ viewport: { width: 1600, height: 900 }, timezoneId: 'Asia/Tokyo', locale: 'es-CO' });

  // ───────────────────────────────────────────────────────────────────────────────────────────────
  // AC1 — abrir la fila
  // ───────────────────────────────────────────────────────────────────────────────────────────────
  test('AC1 — la fila abre el panel con los campos consolidados y su timeline', async ({ page }) => {
    const traza = await abrirLista(page);
    await boton(page, `Ver el comparendo ${FILA.numeroComparendo}`).click();

    await expect(panel(page)).toBeVisible();
    // El título ya está antes de que llegue nada: sale de la fila, no de la respuesta.
    await expect(panel(page)).toHaveAttribute('aria-label', `Comparendo ${FILA.numeroComparendo}`);

    // Los campos consolidados, incluidos los de nivel C que la tabla NO pinta.
    await expect(panel(page)).toContainText('EN COBRO COACTIVO');
    await expect(panel(page)).toContainText('Transportes Andinos SAS');
    await expect(panel(page)).toContainText('Itagüí');
    await expect(panel(page)).toContainText('12 de julio de 2026');
    await expect(panel(page)).toContainText('Estacionar en zona prohibida');
    // El timeline NO se pide aparte: `GET /registros/:id` ya trae `eventos[]`, y pedirlo por su
    // ruta sería una segunda petición por cada panel abierto para un dato que ya llegó.
    expect(traza.peticiones.filter((p) => p.includes('/eventos'))).toEqual([]);
    // Y el detalle se pide UNA vez por apertura. El rango es por `React.StrictMode`, que en modo
    // desarrollo monta cada efecto dos veces a propósito: afirmar `toBe(1)` aquí sería afirmar que
    // StrictMode está apagado, no que la pantalla no pide de más. Quien lleva el peso de «no se
    // piden datos de más» es el AC3, que compara el ANTES y el DESPUÉS de guardar — esa resta vale
    // lo mismo con StrictMode o sin él.
    expect(veces(traza, `GET /registros/${REGISTRO_ID}`)).toBeGreaterThan(0);
    expect(veces(traza, `GET /registros/${REGISTRO_ID}`)).toBeLessThanOrEqual(2);
  });

  // El `id` de la fila se interpola en la ruta del detalle, y hasta la HU #11652 (AC3) lo hacía sin
  // codificar. Hoy es un UUID del servidor y no hay nada explotable; el fixture usa a propósito un
  // identificador que NO lo es, porque si no el defecto no se puede ver desde ningún test.
  test('AC1 — el id del registro viaja CODIFICADO: no abre un segmento ni una query de más (HU #11652)', async ({ page }) => {
    const ID_RARO = 'reg/uno?x=1';
    await loginAs(page, OPERACIONES_USER);
    const traza = await mockModulo(page);
    traza.lista = { status: 200, body: { items: [{ ...FILA, id: ID_RARO }], nextCursor: null } };

    await page.goto('/flito/comparendos');
    await boton(page, `Ver el comparendo ${FILA.numeroComparendo}`).click();

    // Se espera a que el detalle se pida y se mira CÓMO se pidió. Sin codificar, la traza dice
    // `GET /registros/reg/uno`: otra ruta, y el resto del identificador convertido en query. El
    // `Set` es por `StrictMode`, que en desarrollo monta el efecto dos veces (ver el TC de arriba).
    await expect.poll(() => [...new Set(traza.peticiones.filter((p) => p.startsWith('GET /registros/')))])
      .toEqual([`GET /registros/${encodeURIComponent(ID_RARO)}`]);
    // El espejo: con la ruta bien formada el panel recibe SU detalle y no la página del listado.
    await expect(panel(page)).toContainText('EN COBRO COACTIVO');
  });

  test('AC1 — el panel abre en esqueleto y no espera a la respuesta para existir', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const traza = await mockModulo(page);
    // El detalle se retiene hasta que el test lo suelte: es la única forma de mirar el estado de
    // carga, que en un mock instantáneo no existe el tiempo suficiente para verlo.
    let soltar = () => {};
    const retenido = new Promise<void>((r) => { soltar = r; });
    await page.route(`**/api/flito/comparendos/registros/${REGISTRO_ID}`, async (route) => {
      traza.peticiones.push(`GET /registros/${REGISTRO_ID}`);
      await retenido;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DETALLE) });
    });

    await page.goto('/flito/comparendos');
    await boton(page, `Ver el comparendo ${FILA.numeroComparendo}`).click();

    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByRole('status')).toHaveAttribute('aria-busy', 'true');
    // Ni un dato de la respuesta todavía, pero el número ya está en el título.
    await expect(panel(page)).not.toContainText('EN COBRO COACTIVO');
    await expect(panel(page)).toHaveAttribute('aria-label', `Comparendo ${FILA.numeroComparendo}`);

    soltar();
    await expect(panel(page)).toContainText('EN COBRO COACTIVO');
  });

  test('AC1 — un 500 se queda DENTRO del panel, con reintento, y el panel no se cierra', async ({ page }) => {
    const traza = await abrirLista(page);
    traza.detalle = { status: 500, body: { error: 'boom' } };
    await boton(page, `Ver el comparendo ${FILA.numeroComparendo}`).click();

    await expect(panel(page).getByRole('alert')).toBeVisible();
    // Sin eco del servidor: «boom» no llega a pantalla (la decisión de la #11559, y aquí pesa más
    // porque el panel se pide por identificador).
    await expect(panel(page)).not.toContainText('boom');
    await expect(panel(page)).toContainText('No se pudo cargar el comparendo');
    await expect(panel(page)).toBeVisible();

    traza.detalle = { status: 200, body: DETALLE };
    await panel(page).getByRole('button', { name: 'Reintentar' }).click();
    await expect(panel(page)).toContainText('EN COBRO COACTIVO');
  });

  test('AC1 — el 404 ofrece cerrar y actualizar la lista, y la actualiza de verdad', async ({ page }) => {
    const traza = await abrirLista(page);
    traza.detalle = { status: 404, body: { error: 'El comparendo no existe.', codigo: 'no_encontrado' } };
    await boton(page, `Ver el comparendo ${FILA.numeroComparendo}`).click();

    await expect(panel(page)).toContainText('Este comparendo ya no está en el sistema');
    const antes = veces(traza, 'GET /registros');
    await panel(page).getByRole('button', { name: 'Cerrar y actualizar la lista' }).click();

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => veces(traza, 'GET /registros')).toBeGreaterThan(antes);
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────────
  // AC2 — el timeline
  // ───────────────────────────────────────────────────────────────────────────────────────────────
  test('AC2 — del más reciente al más antiguo, con etiquetas en español', async ({ page }) => {
    const traza = await abrirLista(page);
    // Llegan DESORDENADOS a propósito: el orden es una afirmación de la pantalla, no una suerte.
    traza.detalle = {
      status: 200,
      body: { ...FILA, eventos: [EV_INACTIVACION, EV_ALTA, EV_REAPARICION] },
    };
    await boton(page, `Ver el comparendo ${FILA.numeroComparendo}`).click();
    await expect(panel(page)).toContainText('EN COBRO COACTIVO');

    await expect(eventos(page)).toHaveCount(3);
    // 2 jul > 28 jun > 12 may.
    await expect(eventos(page).nth(0)).toContainText('Primera vez que se vio');
    await expect(eventos(page).nth(1)).toContainText('Reapareció en las fuentes');
    await expect(eventos(page).nth(2)).toContainText('Dejó de reportarse');
    // Ni un `snake_case` en pantalla: el motivo del backend se traduce.
    await expect(panel(page)).not.toContainText('ausente_en_todas_las_fuentes');
    await expect(eventos(page).nth(2)).toContainText('Motivo: ausente en todas las fuentes');
    // La lista blanca de `detalle`: `origen` sí, tal cual.
    await expect(eventos(page).nth(0)).toContainText('Origen: simit');
  });

  test('AC2 — un evento sin detalle conocido se muestra igual, sin dejar hueco', async ({ page }) => {
    const traza = await abrirLista(page);
    traza.detalle = {
      status: 200,
      body: {
        ...FILA,
        eventos: [EV_ALTA, EV_SIN_DETALLE, EV_CLAVE_RARA, { ...EV_ALTA, id: 'e9', tipo: 'tipo_del_futuro', ocurridoEn: '2026-02-01T08:00:00Z' }],
      },
    };
    await boton(page, `Ver el comparendo ${FILA.numeroComparendo}`).click();
    await expect(panel(page)).toContainText('EN COBRO COACTIVO');

    // Los cuatro están: ninguno desaparece por no saber pintarlo.
    await expect(eventos(page)).toHaveCount(4);
    await expect(eventos(page).nth(1)).toContainText('Reapareció en las fuentes');
    await expect(eventos(page).nth(2)).toContainText('Primera vez que se vio');
    // Un tipo que este navegador no conoce: se pinta crudo, pero se pinta.
    await expect(eventos(page).nth(3)).toContainText('tipo_del_futuro');
    // Y las claves fuera de la lista blanca NO llegan a pantalla: `causalId` y `actorId` son PII.
    await expect(panel(page)).not.toContainText(CAUSAL_A);
    await expect(panel(page)).not.toContainText('actorId');
  });

  test('AC2 — con más de ocho eventos el historial se recorta y se despliega', async ({ page }) => {
    const traza = await abrirLista(page);
    const muchos = Array.from({ length: 11 }, (_, i) => ({
      ...EV_ALTA,
      id: `hist-${i}`,
      // El i=0 es el más reciente. Días distintos, para que el orden no dependa del desempate.
      ocurridoEn: `2026-07-${String(20 - i).padStart(2, '0')}T13:00:00Z`,
    }));
    traza.detalle = { status: 200, body: { ...FILA, eventos: muchos } };
    await boton(page, `Ver el comparendo ${FILA.numeroComparendo}`).click();
    await expect(panel(page)).toContainText('EN COBRO COACTIVO');

    await expect(eventos(page)).toHaveCount(8);
    await panel(page).getByRole('button', { name: 'Ver los 3 anteriores' }).click();
    await expect(eventos(page)).toHaveCount(11);
  });

  test('AC2 — el instante del evento se pinta en hora de Colombia, con hora', async ({ page }) => {
    const traza = await abrirLista(page);
    traza.detalle = {
      status: 200,
      body: {
        ...FILA,
        eventos: [
          // 03:12Z → Bogotá 16 ago 22:12 (día ANTERIOR) · Tokio 17 ago 12:12
          { ...EV_ALTA, id: 'tz1', ocurridoEn: '2026-08-17T03:12:00Z' },
          // 20:00Z → Bogotá 16 ago 15:00 · Tokio 17 ago 05:00. Un desfase constante no puede
          // satisfacer las dos a la vez.
          { ...EV_ALTA, id: 'tz2', ocurridoEn: '2026-08-16T20:00:00Z' },
        ],
      },
    };
    await boton(page, `Ver el comparendo ${FILA.numeroComparendo}`).click();
    await expect(panel(page)).toContainText('EN COBRO COACTIVO');

    expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('Asia/Tokyo');
    await expect(eventos(page).nth(0), '03:12Z son las 22:12 en Bogotá, del día anterior').toContainText('22:12');
    await expect(eventos(page).nth(0)).not.toContainText('12:12');
    await expect(eventos(page).nth(1), '20:00Z son las 15:00 en Bogotá').toContainText('15:00');
    await expect(eventos(page).nth(1)).not.toContainText('05:00');
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────────
  // AC3 y AC4 — gestionar
  // ───────────────────────────────────────────────────────────────────────────────────────────────
  test('AC3 — causal y observación se guardan, y el panel, el timeline y la fila se refrescan SIN volver a pedir la página', async ({ page }) => {
    const traza = await abrirLista(page);
    await boton(page, `Ver el comparendo ${FILA.numeroComparendo}`).click();
    await expect(panel(page)).toContainText('EN COBRO COACTIVO');

    const listaAntes = veces(traza, 'GET /registros');
    const detalleAntes = veces(traza, `GET /registros/${REGISTRO_ID}`);

    // Lo que el servidor devolverá: el registro entero con su timeline ya actualizado, incluido un
    // evento de sync que entró mientras el formulario estaba abierto. Si alguien fabricara el
    // evento en el cliente, ese segundo evento se perdería.
    traza.gestion = {
      status: 200,
      body: {
        ...FILA,
        causalId: CAUSAL_B,
        observacion: 'Se envió copia al cliente.',
        gestionActualizadaEn: '2026-08-18T14:14:00Z',
        gestionActualizadaPor: { id: 7, nombre: 'María Ruiz' },
        eventos: [
          { id: 'g1', tipo: 'gestion', syncRunId: null, detalle: { motivo: 'gestion_registrada' }, ocurridoEn: '2026-08-18T14:14:00Z' },
          { id: 's1', tipo: 'reaparicion', syncRunId: 'r1', detalle: { origen: 'municipal' }, ocurridoEn: '2026-08-18T13:00:00Z' },
          EV_ALTA,
        ],
      },
    };

    await panel(page).getByLabel('Causal').selectOption(CAUSAL_B);
    await panel(page).getByLabel('Observación').fill('Se envió copia al cliente.');
    await boton(page, 'Guardar gestión').click();

    // El cuerpo lleva SOLO lo que cambió.
    await expect.poll(() => traza.cuerpos.length).toBe(1);
    expect(JSON.parse(traza.cuerpos[0])).toEqual({
      causalId: CAUSAL_B,
      observacion: 'Se envió copia al cliente.',
    });

    // El evento nuevo es el primero, y el del sync tampoco se perdió.
    await expect(eventos(page).nth(0)).toContainText('Gestión registrada');
    await expect(eventos(page).nth(1)).toContainText('Reapareció en las fuentes');
    // AC5, en el sitio donde el contrato lo da.
    await expect(panel(page)).toContainText('María Ruiz');

    // La fila de la tabla, por detrás del panel, ya dice la causal nueva.
    const fila = page.getByRole('row').filter({ hasText: FILA.numeroComparendo });
    await expect(fila).toContainText('Notificado al cliente');
    // …y la OTRA fila no se tocó: se parcheó una, no se repintó la página.
    await expect(page.getByRole('row').filter({ hasText: OTRA_FILA.numeroComparendo })).toContainText('Sin gestión');

    // LO IMPORTANTE: ni un `GET` de más. Ni de la lista ni del detalle.
    expect(veces(traza, 'GET /registros'), 'no se vuelve a pedir la página').toBe(listaAntes);
    expect(veces(traza, `GET /registros/${REGISTRO_ID}`), 'no se vuelve a pedir el detalle').toBe(detalleAntes);
  });

  test('AC3 — sin cambios no se puede guardar, y solo viaja el campo que se tocó', async ({ page }) => {
    const traza = await abrirLista(page);
    traza.detalle = {
      status: 200,
      body: { ...DETALLE, causalId: CAUSAL_A, observacion: 'Lo de siempre.' },
    };
    await boton(page, `Ver el comparendo ${FILA.numeroComparendo}`).click();
    await expect(panel(page)).toContainText('EN COBRO COACTIVO');

    await expect(boton(page, 'Guardar gestión')).toBeDisabled();

    await panel(page).getByLabel('Observación').fill('Otra cosa.');
    await expect(boton(page, 'Guardar gestión')).toBeEnabled();
    traza.gestion = { status: 200, body: { ...DETALLE, causalId: CAUSAL_A, observacion: 'Otra cosa.' } };
    await boton(page, 'Guardar gestión').click();

    await expect.poll(() => traza.cuerpos.length).toBe(1);
    // Sin `causalId`: nadie lo tocó, y mandarlo pisaría lo que otra persona acabe de poner.
    expect(JSON.parse(traza.cuerpos[0])).toEqual({ observacion: 'Otra cosa.' });
  });

  test('AC3 — la causal inactiva ASIGNADA sigue en el selector; las demás inactivas no', async ({ page }) => {
    const traza = await abrirLista(page);
    traza.detalle = { status: 200, body: { ...DETALLE, causalId: CAUSAL_VIEJA } };
    await boton(page, `Ver el comparendo ${FILA.numeroComparendo}`).click();
    await expect(panel(page)).toContainText('EN COBRO COACTIVO');

    const causal = panel(page).getByLabel('Causal');
    await expect(causal).toHaveValue(CAUSAL_VIEJA);
    await expect(causal.locator('option')).toHaveText([
      '— Sin causal —', 'En verificación', 'Notificado al cliente', 'Causal retirada (inactiva)',
    ]);

    // Con la asignada ACTIVA, la inactiva no aparece por ninguna parte.
    traza.detalle = { status: 200, body: { ...DETALLE, causalId: CAUSAL_A } };
    await panel(page).getByRole('button', { name: 'Cerrar' }).click();
    await boton(page, `Ver el comparendo ${FILA.numeroComparendo}`).click();
    await expect(panel(page)).toContainText('EN COBRO COACTIVO');
    // El orden es el de `orden`, no el alfabético ni el de llegada.
    await expect(panel(page).getByLabel('Causal').locator('option')).toHaveText([
      '— Sin causal —', 'En verificación', 'Notificado al cliente',
    ]);
  });

  test('AC3 — con el catálogo de causales caído, el selector NO finge que no hay causal', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const traza = await mockModulo(page);
    // El catálogo se cae. `useCatalogosComparendos` se lo traga a propósito —son etiquetas— y aquí
    // llega vacío con un comparendo que SÍ tiene causal.
    await page.route('**/api/flito/comparendos/causales', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }));
    traza.detalle = { status: 200, body: { ...DETALLE, causalId: CAUSAL_A } };

    await page.goto('/flito/comparendos');
    await boton(page, `Ver el comparendo ${FILA.numeroComparendo}`).click();
    await expect(panel(page)).toContainText('EN COBRO COACTIVO');

    const causal = panel(page).getByLabel('Causal');
    // Ni «— Sin causal —» seleccionado (mentira) ni el UUID crudo (ruido).
    await expect(causal).toHaveValue(CAUSAL_A);
    await expect(causal).toContainText('Causal asignada (no se pudo cargar el catálogo)');
    // Y no se puede guardar nada por accidente: nada cambió.
    await expect(boton(page, 'Guardar gestión')).toBeDisabled();
  });

  test('AC4 — limpiar los dos deja los campos vacíos y registra el evento que decida el servidor', async ({ page }) => {
    const traza = await abrirLista(page);
    traza.detalle = {
      status: 200,
      body: {
        ...DETALLE,
        causalId: CAUSAL_A,
        observacion: 'Algo escrito antes.',
        gestionActualizadaEn: '2026-08-17T13:00:00Z',
        gestionActualizadaPor: { id: 7, nombre: 'María Ruiz' },
      },
    };
    await boton(page, `Ver el comparendo ${FILA.numeroComparendo}`).click();
    await expect(panel(page)).toContainText('EN COBRO COACTIVO');

    traza.gestion = {
      status: 200,
      body: {
        ...FILA,
        causalId: null,
        observacion: null,
        gestionActualizadaEn: '2026-08-18T14:20:00Z',
        gestionActualizadaPor: { id: 7, nombre: 'María Ruiz' },
        // El servidor decide que esto fue una RETIRADA. El cliente no podía saberlo.
        eventos: [
          { id: 'g2', tipo: 'gestion', syncRunId: null, detalle: { motivo: 'gestion_retirada' }, ocurridoEn: '2026-08-18T14:20:00Z' },
          EV_ALTA,
        ],
      },
    };

    await panel(page).getByLabel('Causal').selectOption('');
    await panel(page).getByLabel('Observación').fill('');
    await boton(page, 'Guardar gestión').click();

    await expect.poll(() => traza.cuerpos.length).toBe(1);
    expect(JSON.parse(traza.cuerpos[0])).toEqual({ causalId: null, observacion: null });

    await expect(panel(page).getByLabel('Causal')).toHaveValue('');
    await expect(panel(page).getByLabel('Observación')).toHaveValue('');
    // La etiqueta la puso el servidor: «retirada», no «registrada».
    await expect(eventos(page).nth(0)).toContainText('Gestión retirada');
    await expect(eventos(page).nth(0)).not.toContainText('gestion_retirada');
    // Y la fila vuelve a «Sin gestión».
    await expect(page.getByRole('row').filter({ hasText: FILA.numeroComparendo })).toContainText('Sin gestión');
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────────
  // AC5 — quién y cuándo
  // ───────────────────────────────────────────────────────────────────────────────────────────────
  test('AC5 — se dice quién hizo la última gestión y cuándo, en hora de Colombia', async ({ page }) => {
    const traza = await abrirLista(page);
    traza.detalle = {
      status: 200,
      body: {
        ...DETALLE,
        causalId: CAUSAL_A,
        // 03:12Z → 16 de agosto, 22:12 en Bogotá. En Tokio sería el 17 a las 12:12.
        gestionActualizadaEn: '2026-08-17T03:12:00Z',
        gestionActualizadaPor: { id: 7, nombre: 'María Ruiz' },
      },
    };
    await boton(page, `Ver el comparendo ${FILA.numeroComparendo}`).click();
    await expect(panel(page)).toContainText('EN COBRO COACTIVO');

    await expect(panel(page)).toContainText('María Ruiz');
    await expect(panel(page)).toContainText('22:12');
    // Nunca el id suelto: «usuario 7» no responde «quién hizo la última gestión».
    await expect(panel(page)).not.toContainText('usuario 7');

    // Sin gestión, se dice que no la hay en vez de dejar el hueco.
    traza.detalle = { status: 200, body: DETALLE };
    await panel(page).getByRole('button', { name: 'Cerrar' }).click();
    await boton(page, `Ver el comparendo ${FILA.numeroComparendo}`).click();
    await expect(panel(page)).toContainText('Nadie ha gestionado este comparendo todavía');
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────────
  // AC6 — validación y rechazo del servidor
  // ───────────────────────────────────────────────────────────────────────────────────────────────
  test('AC6 — una observación por encima del tope la para el FORMULARIO, antes de llamar al API', async ({ page }) => {
    const traza = await abrirLista(page);
    await boton(page, `Ver el comparendo ${FILA.numeroComparendo}`).click();
    await expect(panel(page)).toContainText('EN COBRO COACTIVO');

    await panel(page).getByLabel('Observación').fill('x'.repeat(1001));
    await expect(panel(page)).toContainText('1001 / 1000 caracteres');
    await expect(panel(page)).toContainText('La observación admite hasta 1000 caracteres.');
    await expect(boton(page, 'Guardar gestión')).toBeDisabled();

    // Y el candado de verdad no es el atributo del botón: se fuerza el `submit` del formulario
    // saltándose el botón inhabilitado, y aun así NO sale ninguna petición. La afirmación del AC6
    // («lo impide antes de llamar al API») es sobre la red, no sobre un `disabled`.
    await panel(page).locator('form').evaluate((f) => (f as HTMLFormElement).requestSubmit());
    expect(traza.cuerpos, 'no salió ningún PATCH').toEqual([]);

    // Justo en el tope sí se puede guardar, y esto **llega hasta el PATCH a propósito**.
    //
    // Antes el test se paraba en `toBeEnabled()`, y eso NO prueba lo que el caso dice probar: un
    // botón habilitado y un `enviar` que traga el submit exactamente en 1000 caracteres conviven
    // tan campantes. El peligro que este TC cubre —que el borde se caiga por un `>=` donde va un
    // `>`— vive en la capa de abajo, así que la afirmación tiene que ser sobre la RED: sale el
    // PATCH, y su cuerpo lleva los 1000 caracteres enteros, sin recortar.
    const alTope = 'x'.repeat(COMPARENDOS_OBSERVACION_MAX);
    traza.gestion = { status: 200, body: { ...DETALLE, observacion: alTope } };
    await panel(page).getByLabel('Observación').fill(alTope);
    await expect(panel(page)).toContainText(`${COMPARENDOS_OBSERVACION_MAX} / ${COMPARENDOS_OBSERVACION_MAX} caracteres`);
    // Y el mensaje de exceso NO está: el límite es «hasta 1000», no «menos de 1000».
    await expect(panel(page)).not.toContainText('La observación admite hasta');
    await expect(boton(page, 'Guardar gestión')).toBeEnabled();

    await boton(page, 'Guardar gestión').click();
    await expect.poll(() => traza.cuerpos.length, 'el máximo exacto SÍ se manda').toBe(1);
    const enviado = JSON.parse(traza.cuerpos[0]) as { observacion: string };
    expect(enviado.observacion, 'no se recorta ni un carácter').toHaveLength(COMPARENDOS_OBSERVACION_MAX);
    expect(enviado.observacion).toBe(alTope);
  });

  test('AC6 — una causal que el servidor rechaza se explica y el detalle no queda a medias', async ({ page }) => {
    const traza = await abrirLista(page);
    traza.detalle = { status: 200, body: { ...DETALLE, observacion: 'Lo de siempre.' } };
    await boton(page, `Ver el comparendo ${FILA.numeroComparendo}`).click();
    await expect(panel(page)).toContainText('EN COBRO COACTIVO');

    traza.gestion = {
      status: 422,
      body: {
        error: 'La causal indicada no existe o está desactivada en el catálogo.',
        codigo: 'causal_invalida',
      },
    };
    await panel(page).getByLabel('Causal').selectOption(CAUSAL_B);
    await panel(page).getByLabel('Observación').fill('Texto que no se puede perder.');
    await boton(page, 'Guardar gestión').click();

    const alerta = panel(page).getByRole('alert');
    await expect(alerta).toContainText('La causal que elegiste ya no existe o está desactivada');
    // Lo escrito SIGUE ahí: perder una observación por un error es lo que hace que la gente deje de
    // usar el campo.
    await expect(panel(page).getByLabel('Observación')).toHaveValue('Texto que no se puede perder.');
    await expect(panel(page).getByLabel('Causal')).toHaveValue(CAUSAL_B);
    // Y el detalle no quedó a medias: los datos de fuente y el timeline siguen enteros.
    await expect(panel(page)).toContainText('EN COBRO COACTIVO');
    await expect(eventos(page)).toHaveCount(3);
    // Se puede reintentar sin volver a escribir nada.
    traza.gestion = { status: 200, body: { ...DETALLE, causalId: CAUSAL_B, observacion: 'Texto que no se puede perder.' } };
    await boton(page, 'Guardar gestión').click();
    await expect(alerta).toHaveCount(0);
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────────
  // AC7 — la fuente no se edita
  // ───────────────────────────────────────────────────────────────────────────────────────────────
  test('AC7 — la sección de datos de fuente no tiene NINGÚN control', async ({ page }) => {
    await abrirLista(page);
    await boton(page, `Ver el comparendo ${FILA.numeroComparendo}`).click();
    await expect(panel(page)).toContainText('EN COBRO COACTIVO');

    const fuente = panel(page).getByRole('region', { name: 'Datos de la fuente' });
    await expect(fuente).toBeVisible();
    // Ni habilitados ni inhabilitados: un control inhabilitado dice «esto se edita, pero tú no
    // puedes», y lo cierto es que NO se edita.
    await expect(fuente.locator('input, select, textarea, button, [contenteditable]')).toHaveCount(0);
    // Es un `<dl>`, que es lo que un lector anuncia como pares término/definición.
    await expect(fuente.locator('dl')).toHaveCount(1);
    // Los dos únicos controles del panel que escriben viven en la sección de gestión.
    await expect(panel(page).getByRole('region', { name: 'Gestión' }).locator('select, textarea')).toHaveCount(2);
  });

  test('AC1 — un `origenMerge` que este navegador no conoce se pinta crudo, nunca «undefined»', async ({ page }) => {
    const traza = await abrirLista(page);
    // El backend va un paso por delante de la pestaña: añadió un origen y aquí llega sin etiqueta.
    // El mapa es un `Record` sobre la unión —añadir un valor al contrato NO compila hasta que
    // alguien le escriba su texto— pero eso no protege de lo que viene por la RED.
    traza.lista = {
      status: 200,
      body: { items: [{ ...FILA, origenMerge: 'origen_del_futuro' }, OTRA_FILA], nextCursor: null },
    };
    traza.detalle = { status: 200, body: { ...DETALLE, origenMerge: 'origen_del_futuro' } };
    await page.reload();

    const fila = page.getByRole('row').filter({ hasText: FILA.numeroComparendo });
    await expect(fila).toContainText('origen_del_futuro');
    await expect(fila).not.toContainText('undefined');

    await boton(page, `Ver el comparendo ${FILA.numeroComparendo}`).click();
    await expect(panel(page)).toContainText('Origen: origen_del_futuro');
    await expect(panel(page)).not.toContainText('undefined');
  });

  test('AC7 — un campo nulo se pinta «—» y lo dice también el lector', async ({ page }) => {
    const traza = await abrirLista(page);
    traza.detalle = {
      status: 200,
      body: { ...DETALLE, placa: null, monto: null, organismo: null, estadoFuente: null },
    };
    await boton(page, `Ver el comparendo ${FILA.numeroComparendo}`).click();
    await expect(panel(page)).toContainText('Primera vez que se vio');

    // Un guion solo no se lee: cada ausencia lleva su «Sin dato» para el lector de pantalla.
    await expect(panel(page).getByText('Sin dato')).toHaveCount(5);
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────────
  // AC8 — foco y anuncios
  // ───────────────────────────────────────────────────────────────────────────────────────────────
  test('AC8 — el foco entra al panel al abrir y VUELVE al origen al cerrar', async ({ page }) => {
    await abrirLista(page);
    const origen = boton(page, `Ver el comparendo ${FILA.numeroComparendo}`);
    await origen.focus();
    await origen.press('Enter');

    // Entra: el foco está en el diálogo, que lleva el número en su nombre accesible.
    await expect(panel(page)).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // Y vuelve exactamente al botón que lo abrió, no al principio de la página.
    await expect(origen).toBeFocused();
  });

  test('AC8 — la trampa de foco se arma con el ESQUELETO, no cuando llegan los datos', async ({ page }) => {
    // El peligro que cierra este caso está escrito en `useFocusTrap` y hasta ahora solo lo protegía
    // un comentario: condicionar `enabled` a que los datos hayan cargado. Es tentador —el esqueleto
    // no tiene nada enfocable— y rompe DOS cosas a la vez, así que se afirman las dos.
    //
    // Ningún otro test lo puede ver: todos los mocks resuelven al instante y la fase de esqueleto
    // no dura ni un fotograma. Aquí la respuesta se retiene a mano.
    await loginAs(page, OPERACIONES_USER);
    const traza = await mockModulo(page);
    let soltar = () => {};
    const retenido = new Promise<void>((r) => { soltar = r; });
    await page.route(`**/api/flito/comparendos/registros/${REGISTRO_ID}`, async (route) => {
      traza.peticiones.push(`GET /registros/${REGISTRO_ID}`);
      await retenido;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DETALLE) });
    });

    await page.goto('/flito/comparendos');
    const origen = boton(page, `Ver el comparendo ${FILA.numeroComparendo}`);
    await origen.focus();
    await origen.press('Enter');

    // (1) MIENTRAS carga. Con `enabled` atado a los datos, el foco se quedaría FUERA del diálogo
    // —en la fila de la tabla— y el lector de pantalla no anunciaría que se abrió nada.
    await expect(panel(page).getByRole('status')).toHaveAttribute('aria-busy', 'true');
    await expect(panel(page), 'el foco entra al abrir, no al cargar').toBeFocused();

    soltar();
    await expect(panel(page)).toContainText('EN COBRO COACTIVO');
    // Llegar los datos no puede sacar el foco de donde estaba.
    await expect(panel(page)).toBeFocused();

    // (2) Y al CERRAR. Ésta es la mitad que menos se ve: si el efecto se rearmara al llegar los
    // datos, `previouslyFocused` capturaría el propio contenedor del diálogo —que para entonces ya
    // tiene el foco— y al cerrar el foco acabaría en un nodo desmontado, es decir en <body>.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(origen, 'vuelve a la fila, no a <body>').toBeFocused();
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
  });

  test('AC8 — si la fila de origen ya no existe, el foco va al encabezado y NUNCA a <body>', async ({ page }) => {
    const traza = await abrirLista(page);
    traza.detalle = { status: 404, body: { error: 'no existe', codigo: 'no_encontrado' } };
    // Al recargar, la lista ya no trae la fila que abrió el panel: su botón se desmonta.
    traza.lista = { status: 200, body: { items: [OTRA_FILA], nextCursor: null } };

    await boton(page, `Ver el comparendo ${FILA.numeroComparendo}`).click();
    await expect(panel(page)).toContainText('Este comparendo ya no está en el sistema');
    await panel(page).getByRole('button', { name: 'Cerrar y actualizar la lista' }).click();

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: `Ver el comparendo ${FILA.numeroComparendo}` })).toHaveCount(0);
    // Lo que NO puede pasar: acabar en <body> y obligar a recorrer la página entera otra vez.
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
    await expect(page.getByRole('heading', { name: 'Lista de comparendos', level: 2 })).toBeFocused();
  });

  test('AC8 — Esc con una gestión sin guardar pide confirmación; sin cambios cierra directo', async ({ page }) => {
    await abrirLista(page);
    await boton(page, `Ver el comparendo ${FILA.numeroComparendo}`).click();
    await expect(panel(page)).toContainText('EN COBRO COACTIVO');

    // Sin cambios: cierra sin preguntar.
    let preguntas = 0;
    page.on('dialog', (d) => { preguntas += 1; void d.dismiss(); });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(preguntas).toBe(0);

    // Con una observación a medio escribir: pregunta, y al decir que no, no cierra.
    await boton(page, `Ver el comparendo ${FILA.numeroComparendo}`).click();
    await panel(page).getByLabel('Observación').fill('A medio escribir');
    await page.keyboard.press('Escape');
    await expect.poll(() => preguntas).toBe(1);
    await expect(panel(page)).toBeVisible();
  });

  test('AC8 — los dos campos tienen etiqueta asociada y los errores se anuncian', async ({ page }) => {
    const traza = await abrirLista(page);
    await boton(page, `Ver el comparendo ${FILA.numeroComparendo}`).click();
    await expect(panel(page)).toContainText('EN COBRO COACTIVO');

    // `getByLabel` falla si el `<label>` no envuelve al control ni lo apunta.
    await expect(panel(page).getByLabel('Causal')).toBeVisible();
    await expect(panel(page).getByLabel('Observación')).toBeVisible();
    // El contador está atado al textarea, así que el lector lo anuncia con el campo.
    const descrito = await panel(page).getByLabel('Observación').getAttribute('aria-describedby');
    expect(descrito).toBeTruthy();
    await expect(panel(page).locator(`#${descrito?.split(' ')[0]}`)).toContainText('0 / 1000 caracteres');

    // El error del guardado interrumpe: `role="alert"`.
    traza.gestion = { status: 500, body: { error: 'boom' } };
    await panel(page).getByLabel('Observación').fill('Algo');
    await boton(page, 'Guardar gestión').click();
    await expect(panel(page).getByRole('alert')).toContainText('No se pudo guardar la gestión');
    // Sin eco del servidor.
    await expect(panel(page)).not.toContainText('boom');

    // El historial es una lista de verdad, no un montón de `<div>`.
    await expect(panel(page).getByRole('list', { name: 'Historial del comparendo' })).toBeVisible();
  });
});
