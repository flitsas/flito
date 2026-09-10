// FLITO — Tarifas: el configurador de valores con historial de vigencias (HU #12375). Backend mockeado.
//
// Cubre AC1, AC3, AC4, AC6, AC7, AC8, AC9, AC10, AC12 y los cuatro estados (AC13-AC16). Decisiones
// que hacen que los asertos midan algo:
//
//   · **Los toasts se afirman con las cifras de la RESPUESTA**, no con las de pantalla: el mock del
//     PATCH devuelve `valorAnterior: 199999` cuando la fila decía $200.000. Si el toast dijera
//     «$200.000 → …», estaría construido con el estado de la web (mutante de la nota 5 de la ficha).
//   · **AC6 y AC7 se miden sobre las peticiones** (espía de `/tarifas`), porque «sin llamada al
//     servidor» no deja huella visible.
//   · **AC12 se mide con el módulo abortado**: si algo se escapa cae el espía Y cae `NoAccess`.
//   · **El vacío de la lista se separa del error**: `clients: []` y un 500 pintan cosas distintas.

import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, FINANCIERA_USER, AUDITOR_USER, GESTOR_IMPUESTOS_USER } from '../helpers/auth';
import { correrAxe, esperarSinViolacionesGraves } from '../helpers/axe';

const CANARIO = '/api/__qa_canary';
const RE_CLIENTS = /\/api\/clients(\?|$)/;
const RE_ABIERTAS = /\/api\/flito\/parametrizacion\/tarifas$/;
const RE_VISTA_7 = /\/api\/flito\/parametrizacion\/tarifas\/companias\/7$/;
const RE_HISTORIAL_7 = /\/api\/flito\/parametrizacion\/tarifas\/companias\/7\/historial/;
const RE_VIGENCIA = /\/api\/flito\/parametrizacion\/tarifas\/[0-9a-z-]+$/;

const ANDINOS = 'Transportes Andinos S.A.S.';

const CLIENTES = [
  { id: 3, name: 'Agrocarga del Norte', document: '900333', logisticaAutogestionable: true },
  { id: 5, name: 'Coomotor', document: '900555', logisticaAutogestionable: false },
  { id: 7, name: ANDINOS, document: '900777', logisticaAutogestionable: false },
];

/** Vigencias abiertas de TODOS: Andinos 2/4, Coomotor 4/4, Agrocarga 0/4. */
const ABIERTAS = [
  { id: 'v-mat-7', companiaId: 7, concepto: 'tramite_digital', tipoTramite: 'MATRICULA', valor: 270000, activo: true },
  { id: 'v-log-7', companiaId: 7, concepto: 'logistica', tipoTramite: null, valor: 45000, activo: true },
  { id: 'v-mat-5', companiaId: 5, concepto: 'tramite_digital', tipoTramite: 'MATRICULA', valor: 1, activo: true },
  { id: 'v-tra-5', companiaId: 5, concepto: 'tramite_digital', tipoTramite: 'TRASPASO', valor: 1, activo: true },
  { id: 'v-otr-5', companiaId: 5, concepto: 'tramite_digital', tipoTramite: 'OTROS', valor: 1, activo: true },
  { id: 'v-log-5', companiaId: 5, concepto: 'logistica', tipoTramite: null, valor: 1, activo: true },
];

const LAURA = { id: 10, nombre: 'Laura Restrepo' };
const CARLOS = { id: 11, nombre: 'Carlos Ruiz' };

type Fila = Record<string, unknown>;
const fila = (concepto: string, tipoTramite: string | null, over: Fila = {}): Fila => ({
  concepto, tipoTramite, vigenciaId: null, valor: null, vigenteDesde: null, fijadoPor: null, ...over,
});

/** AC1: Matrícula 270000 (1 sep 2026, Laura), logística 45000 (FLITO gestiona), sin Traspaso ni Otros. */
const VISTA = {
  companiaId: 7,
  companiaNombre: ANDINOS,
  tarifas: [
    fila('tramite_digital', 'MATRICULA', { vigenciaId: 'v-mat-7', valor: 270000, vigenteDesde: '2026-09-01T15:00:00.000Z', fijadoPor: LAURA }),
    fila('tramite_digital', 'TRASPASO'),
    fila('tramite_digital', 'OTROS'),
    fila('logistica', null, { vigenciaId: 'v-log-7', valor: 45000, vigenteDesde: '2026-07-03T13:00:00.000Z', fijadoPor: CARLOS, flitoGestionaLogistica: true }),
  ],
  capacidades: { editar: true, verHistorial: true },
};

/** La misma vista con Traspaso en 200000, para AC4. */
const VISTA_CON_TRASPASO = {
  ...VISTA,
  tarifas: VISTA.tarifas.map((f) => (f.tipoTramite === 'TRASPASO'
    ? { ...f, vigenciaId: 'v-tra-7', valor: 200000, vigenteDesde: '2026-08-12T15:31:00.000Z', fijadoPor: LAURA }
    : f)),
};

const json = (cuerpo: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(cuerpo) });

async function mockBase(page: Page, opciones: { clientes?: unknown[]; abiertas?: unknown[] | 'falla' } = {}) {
  await page.route(RE_CLIENTS, (route) => route.fulfill(json(opciones.clientes ?? CLIENTES)));
  await page.route(RE_ABIERTAS, (route) => (opciones.abiertas === 'falla'
    ? route.fulfill(json({ error: 'Error del servidor' }, 500))
    : route.fulfill(json(opciones.abiertas ?? ABIERTAS))));
}

/** La vista de Andinos, con un contador de veces que se pidió. */
async function mockVista(page: Page, vista: unknown = VISTA): Promise<{ veces: () => number }> {
  let n = 0;
  await page.route(RE_VISTA_7, (route) => { n += 1; return route.fulfill(json(vista)); });
  return { veces: () => n };
}

/** Punto de reposo: cuando el canario ha salido, lo que fuera a salir en el montaje ya salió. */
async function reposo(page: Page): Promise<void> {
  const salida = page.waitForRequest((r) => r.url().includes('__qa_canary'), { timeout: 10_000 });
  await page.evaluate((ruta) => { void fetch(ruta).catch(() => {}); }, CANARIO);
  await salida;
}

/** Método + path de cada petición del módulo. Sin query: por ahí se filtraría un dato a un artefacto. */
function espiar(page: Page): string[] {
  const vistas: string[] = [];
  page.on('request', (req) => {
    const { pathname } = new URL(req.url());
    if (pathname.startsWith('/api/flito/parametrizacion/tarifas') || pathname.startsWith('/api/clients')) {
      vistas.push(`${req.method()} ${pathname}`);
    }
  });
  return vistas;
}

/** La fila de datos cuyo `<th scope="row">` empieza por `nombre`; las cabeceras de grupo no tienen rowheader. */
const filaDe = (page: Page, nombre: string) =>
  page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: new RegExp(`^${nombre}`) }) });

/** Lleva el calendario del rango al mes pedido (0 = enero), desde el mes actual de la máquina. */
async function irAlMes(page: Page, anio: number, mes: number): Promise<void> {
  const hoy = new Date();
  const saltos = (hoy.getFullYear() - anio) * 12 + hoy.getMonth() - mes;
  const boton = saltos >= 0 ? 'Mes anterior' : 'Mes siguiente';
  for (let i = 0; i < Math.abs(saltos); i += 1) await page.getByRole('button', { name: boton }).click();
}

test.describe('FLITO — Tarifas · acceso (AC12)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('financiera entra, la lista pide clientes y abiertas, y el menú ofrece Tarifas en Finanzas', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    const vistas = espiar(page);
    await mockBase(page);

    await page.goto('/flito/tarifas');
    await expect(page.getByRole('heading', { name: 'Tarifas', level: 1 })).toBeVisible();
    await expect(page.getByText('Elige un cliente de la lista para ver y fijar sus valores.')).toBeVisible();
    await reposo(page);

    expect(vistas).toContain('GET /api/clients');
    expect(vistas).toContain('GET /api/flito/parametrizacion/tarifas');

    const nav = page.getByRole('navigation', { name: 'Navegación principal' });
    await nav.getByRole('button', { name: 'Finanzas', exact: true }).click();
    const enlace = page.getByRole('link', { name: 'Tarifas', exact: true });
    await expect(enlace).toBeVisible();
    await expect(enlace).toHaveAttribute('href', '/flito/tarifas');
  });

  for (const usuario of [AUDITOR_USER, GESTOR_IMPUESTOS_USER]) {
    test(`${usuario.role} no ve la opción, y a mano recibe «sin permiso» sin ninguna petición`, async ({ page }) => {
      await loginAs(page, usuario);
      const vistas = espiar(page);
      await page.route('**/api/flito/parametrizacion/**', (route) => route.abort('failed'));
      await page.route(RE_CLIENTS, (route) => route.abort('failed'));

      await page.goto('/flito/tarifas/7');
      await expect(page.getByRole('heading', { name: /no tienes acceso a .*tarifas/i })).toBeVisible();
      await reposo(page);
      expect(vistas).toEqual([]);

      const nav = page.getByRole('navigation', { name: 'Navegación principal' });
      await expect(nav.getByRole('link', { name: 'Tarifas', exact: true })).toHaveCount(0);
    });
  }
});

test.describe('FLITO — Tarifas · lista y matriz (AC1, AC2, AC3)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('la lista marca cuántos valores faltan y el completo no lleva marca', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockBase(page);

    await page.goto('/flito/tarifas');
    const lista = page.getByRole('list', { name: 'Clientes' });
    await expect(lista.getByRole('button', { name: /^Agrocarga del Norte/ })).toContainText('Faltan 4');
    await expect(lista.getByRole('button', { name: /^Transportes Andinos/ })).toContainText('Faltan 2');
    await expect(lista.getByRole('button', { name: /^Coomotor/ })).not.toContainText(/Falta/);

    await page.getByRole('button', { name: /^Con faltantes · 2/ }).click();
    await expect(lista.getByRole('listitem')).toHaveCount(2);
    await expect(lista.getByRole('button', { name: /^Coomotor/ })).toHaveCount(0);
  });

  test('si solo falla /tarifas, la lista se pinta sin inventar marcas', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockBase(page, { abiertas: 'falla' });

    await page.goto('/flito/tarifas');
    await expect(page.getByRole('alert')).toContainText('No se pudo calcular qué clientes tienen valores sin configurar');
    const lista = page.getByRole('list', { name: 'Clientes' });
    await expect(lista.getByRole('listitem')).toHaveCount(3);
    await expect(lista.getByText(/Falta/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Con faltantes' })).toBeDisabled();
  });

  test('cuatro filas, «Sin configurar» nunca es $0, y logística lleva el chip sin control', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockBase(page);
    const vista = await mockVista(page);

    await page.goto('/flito/tarifas/7');
    const tabla = page.getByRole('region', { name: `Valores de ${ANDINOS}` });
    await expect(tabla.getByRole('rowheader')).toHaveCount(4);
    await expect(filaDe(page, 'Matrícula')).toContainText('$270.000');
    await expect(filaDe(page, 'Logística')).toContainText('$45.000');
    await expect(filaDe(page, 'Traspaso')).toContainText('Sin configurar');
    await expect(filaDe(page, 'Otros')).toContainText('Sin configurar');
    await expect(tabla.getByText('$0', { exact: true })).toHaveCount(0);

    // AC2: desde y quién.
    await expect(filaDe(page, 'Matrícula')).toContainText('1 sep 2026');
    await expect(filaDe(page, 'Matrícula')).toContainText('Laura Restrepo');

    // AC1: el chip de logística no es un control.
    const logistica = filaDe(page, 'Logística');
    await expect(logistica.getByText('Gestiona FLITO')).toBeVisible();
    await expect(logistica.getByRole('checkbox')).toHaveCount(0);
    await expect(logistica.getByRole('button', { name: /Gestiona FLITO|Autogestiona/ })).toHaveCount(0);

    // AC11: el cliente de la URL queda elegido y la vista se pidió al montar y no vuelve a pedirse
    // sola. El tope es 2 y no 1 porque el dev server corre con `StrictMode`, que monta dos veces;
    // lo que se mide es que tras el reposo el contador no crece (ni bucle ni sondeo).
    await expect(page.getByRole('list', { name: 'Clientes' }).getByRole('button', { name: /^Transportes Andinos/ })).toHaveAttribute('aria-current', 'true');
    await reposo(page);
    const pedidas = vista.veces();
    expect(pedidas).toBeGreaterThanOrEqual(1);
    expect(pedidas).toBeLessThanOrEqual(2);
    await reposo(page);
    expect(vista.veces()).toBe(pedidas);

    // AC8: en ninguna parte de la pantalla existe «Eliminar» ni «Desactivar».
    await expect(page.getByText(/eliminar|borrar|desactivar|inactiva/i)).toHaveCount(0);
  });
});

test.describe('FLITO — Tarifas · editar en sitio (AC4, AC5, AC6, AC7)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('cambiar Traspaso aplica sin recargar y el toast lee anterior → nuevo de la respuesta', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockBase(page);
    let vistaActual: unknown = VISTA_CON_TRASPASO;
    await page.route(RE_VISTA_7, (route) => route.fulfill(json(vistaActual)));
    const cuerpos: unknown[] = [];
    await page.route(RE_VIGENCIA, (route: Route) => {
      cuerpos.push(route.request().postDataJSON());
      // Tras el PATCH, la vista que se repide ya trae el valor nuevo con el usuario actual.
      vistaActual = {
        ...VISTA_CON_TRASPASO,
        tarifas: (VISTA_CON_TRASPASO.tarifas as Fila[]).map((f) => (f.tipoTramite === 'TRASPASO'
          ? { ...f, vigenciaId: 'v-tra-7b', valor: 250000, vigenteDesde: new Date().toISOString(), fijadoPor: { id: 10, nombre: 'Financiera E2E' } }
          : f)),
      };
      return route.fulfill(json({ id: 'v-tra-7b', valor: 250000, valorAnterior: 199999, valorNuevo: 250000 }));
    });

    await page.goto('/flito/tarifas/7');
    await page.getByRole('button', { name: `Cambiar · Traspaso de ${ANDINOS}` }).click();
    const campo = page.getByRole('textbox', { name: `Valor de Traspaso de ${ANDINOS}` });
    await expect(campo).toBeFocused();
    await expect(filaDe(page, 'Traspaso')).toContainText('Antes: $200.000');
    // Una sola fila en edición: las otras quedan apagadas.
    await expect(page.getByRole('button', { name: `Cambiar · Matrícula de ${ANDINOS}` })).toBeDisabled();

    await campo.fill('250000');
    await page.getByRole('button', { name: `Guardar · Traspaso de ${ANDINOS}` }).click();

    expect(cuerpos).toEqual([{ valor: 250000 }]);
    await expect(page.getByRole('status').filter({ hasText: '$199.999 → $250.000' })).toBeVisible();
    await expect(filaDe(page, 'Traspaso')).toContainText('$250.000');
    await expect(filaDe(page, 'Traspaso')).toContainText('Financiera E2E');
    await expect(page.getByRole('button', { name: `Cambiar · Traspaso de ${ANDINOS}` })).toBeFocused();
  });

  test('fijar Otros no pide el tipo y el POST lo lleva desde la fila; en logística se omite', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockBase(page);
    await mockVista(page);
    const cuerpos: unknown[] = [];
    await page.route(RE_ABIERTAS, (route: Route) => {
      if (route.request().method() !== 'POST') return route.fulfill(json(ABIERTAS));
      cuerpos.push(route.request().postDataJSON());
      return route.fulfill(json({ id: 'v-nueva', valor: 150000 }, 201));
    });

    await page.goto('/flito/tarifas/7');
    await page.getByRole('button', { name: `Fijar valor · Otros de ${ANDINOS}` }).click();
    const filaOtros = filaDe(page, 'Otros');
    await expect(filaOtros.getByRole('textbox')).toHaveCount(1);
    await expect(filaOtros.getByRole('combobox')).toHaveCount(0);
    await filaOtros.getByRole('textbox').fill('150000');
    await filaOtros.getByRole('textbox').press('Enter');

    await expect(page.getByRole('status').filter({ hasText: 'Sin configurar → $150.000' })).toBeVisible();
    expect(cuerpos).toEqual([{ companiaId: 7, concepto: 'tramite_digital', tipoTramite: 'OTROS', valor: 150000 }]);
  });

  test('valores inválidos se bloquean sin petición; un 400 del servidor se muestra en el campo', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockBase(page);
    await mockVista(page);
    const vistas = espiar(page);
    await page.route(RE_VIGENCIA, (route) => route.fulfill(json({ error: 'Datos inválidos: valor admite a lo sumo dos decimales' }, 400)));

    await page.goto('/flito/tarifas/7');
    await reposo(page);
    const antes = vistas.length;

    await page.getByRole('button', { name: `Cambiar · Matrícula de ${ANDINOS}` }).click();
    const campo = page.getByRole('textbox', { name: `Valor de Matrícula de ${ANDINOS}` });
    const guardar = page.getByRole('button', { name: `Guardar · Matrícula de ${ANDINOS}` });

    const casos: Array<[string, RegExp]> = [
      ['-1', /no puede ser negativo/],
      ['abc', /Solo números/],
      ['1.234', /Hasta dos decimales/],
      ['1e3', /Solo números/],
      ['', /Escribe el valor/],
      ['270000', /mismo valor que ya rige/],
    ];
    for (const [texto, mensaje] of casos) {
      await campo.fill(texto);
      await expect(guardar).toBeDisabled();
      await campo.press('Enter');
      await expect(campo).toHaveAttribute('aria-invalid', 'true');
      await expect(filaDe(page, 'Matrícula').getByRole('alert')).toContainText(mensaje);
    }
    await reposo(page);
    expect(vistas.slice(antes).filter((l) => l.startsWith('PATCH') || l.startsWith('POST'))).toEqual([]);

    // El 400 del servidor, tal cual, en el campo; la fila sigue en edición.
    await campo.fill('280000');
    await expect(guardar).toBeEnabled();
    await guardar.click();
    await expect(filaDe(page, 'Matrícula').getByRole('alert')).toContainText('Datos inválidos: valor admite a lo sumo dos decimales');
    await expect(campo).toBeVisible();
    await expect(campo).toHaveValue('280000');
  });

  test('cero pide confirmación: cancelar no guarda, confirmar manda confirmarCero y la fila dice $0', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockBase(page);
    let vistaActual: unknown = VISTA;
    await page.route(RE_VISTA_7, (route) => route.fulfill(json(vistaActual)));
    const cuerpos: unknown[] = [];
    await page.route(RE_VIGENCIA, (route: Route) => {
      cuerpos.push(route.request().postDataJSON());
      vistaActual = {
        ...VISTA,
        tarifas: (VISTA.tarifas as Fila[]).map((f) => (f.tipoTramite === 'MATRICULA' ? { ...f, vigenciaId: 'v-mat-7b', valor: 0 } : f)),
      };
      return route.fulfill(json({ id: 'v-mat-7b', valor: 0, valorAnterior: 270000, valorNuevo: 0 }));
    });

    await page.goto('/flito/tarifas/7');
    await page.getByRole('button', { name: `Cambiar · Matrícula de ${ANDINOS}` }).click();
    const campo = page.getByRole('textbox', { name: `Valor de Matrícula de ${ANDINOS}` });
    await campo.fill('0');
    await page.getByRole('button', { name: `Guardar · Matrícula de ${ANDINOS}` }).click();

    const modal = page.getByRole('dialog', { name: 'Cobrar cero por Matrícula' });
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Cero no es lo mismo que «Sin configurar»');
    await modal.getByRole('button', { name: 'Cancelar' }).click();
    await expect(modal).toBeHidden();
    expect(cuerpos).toEqual([]);
    await expect(campo).toHaveValue('0');

    await page.getByRole('button', { name: `Guardar · Matrícula de ${ANDINOS}` }).click();
    await page.getByRole('dialog', { name: 'Cobrar cero por Matrícula' }).getByRole('button', { name: 'Cobrar $0' }).click();
    expect(cuerpos).toEqual([{ valor: 0, confirmarCero: true }]);
    await expect(filaDe(page, 'Matrícula')).toContainText('$0');
    await expect(filaDe(page, 'Matrícula')).not.toContainText('Sin configurar');
  });
});

test.describe('FLITO — Tarifas · dejar de cobrar e historial (AC8, AC9, AC10)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  const HISTORIAL_TRASPASO = [
    { id: 'h3', concepto: 'tramite_digital', tipoTramite: 'TRASPASO', valor: 250000, vigenteDesde: '2026-09-03T21:02:00.000Z', vigenteHasta: '2026-09-10T14:14:00.000Z', fijadoPor: LAURA, fijadoEn: '2026-09-03T21:02:00.000Z', cerradoPor: CARLOS, cerradoEn: '2026-09-10T14:14:00.000Z' },
    { id: 'h2', concepto: 'tramite_digital', tipoTramite: 'TRASPASO', valor: 200000, vigenteDesde: '2026-08-12T15:31:00.000Z', vigenteHasta: '2026-09-03T21:02:00.000Z', fijadoPor: LAURA, fijadoEn: '2026-08-12T15:31:00.000Z', cerradoPor: LAURA, cerradoEn: '2026-09-03T21:02:00.000Z' },
    { id: 'h1', concepto: 'tramite_digital', tipoTramite: 'TRASPASO', valor: 180000, vigenteDesde: '2026-07-02T13:05:00.000Z', vigenteHasta: '2026-08-12T15:31:00.000Z', fijadoPor: CARLOS, fijadoEn: '2026-07-02T13:05:00.000Z', cerradoPor: LAURA, cerradoEn: '2026-08-12T15:31:00.000Z' },
  ];

  test('dejar de cobrar la logística cierra la vigencia y la fila vuelve a «Sin configurar»', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockBase(page);
    let vistaActual: unknown = VISTA;
    await page.route(RE_VISTA_7, (route) => route.fulfill(json(vistaActual)));
    const cuerpos: unknown[] = [];
    await page.route(RE_VIGENCIA, (route: Route) => {
      cuerpos.push(route.request().postDataJSON());
      vistaActual = { ...VISTA, tarifas: (VISTA.tarifas as Fila[]).map((f) => (f.concepto === 'logistica' ? fila('logistica', null, { flitoGestionaLogistica: true }) : f)) };
      return route.fulfill(json({ id: 'v-log-7', valor: 45000, activo: false, valorAnterior: 45000, valorNuevo: null }));
    });
    await page.route(RE_HISTORIAL_7, (route) => route.fulfill(json([
      { id: 'h-log', concepto: 'logistica', tipoTramite: null, valor: 45000, vigenteDesde: '2026-07-03T13:00:00.000Z', vigenteHasta: '2026-09-10T15:00:00.000Z', fijadoPor: CARLOS, fijadoEn: '2026-07-03T13:00:00.000Z', cerradoPor: { id: 10, nombre: 'Financiera E2E' }, cerradoEn: '2026-09-10T15:00:00.000Z' },
    ])));

    await page.goto('/flito/tarifas/7');
    await page.getByRole('button', { name: `Dejar de cobrar · Logística de ${ANDINOS}` }).click();
    const modal = page.getByRole('dialog', { name: 'Dejar de cobrar la logística' });
    await expect(modal).toContainText('La vigencia de $45.000 queda cerrada');
    await modal.getByRole('button', { name: 'Dejar de cobrar' }).click();

    expect(cuerpos).toEqual([{ activo: false }]);
    await expect(page.getByRole('status').filter({ hasText: '$45.000 → Sin configurar' })).toBeVisible();
    const logistica = filaDe(page, 'Logística');
    await expect(logistica).toContainText('Sin configurar');
    await expect(logistica.getByRole('button', { name: /^Fijar valor/ })).toBeVisible();
    await expect(logistica.getByRole('button', { name: /^Dejar de cobrar/ })).toHaveCount(0);
    // El foco no se pierde en <body>: vuelve a la cabecera de la fila.
    await expect(logistica.getByRole('rowheader')).toBeFocused();

    await logistica.getByRole('button', { name: /^Historial/ }).click();
    const historial = page.getByRole('region', { name: `Historial de Logística de ${ANDINOS}` });
    await expect(historial.getByRole('row').nth(1)).toContainText('Financiera E2E');
    await expect(historial.getByRole('row').nth(1)).toContainText('10 sep 2026');
    await expect(historial.getByText('Vigente')).toHaveCount(0);
  });

  test('el historial de una fila trae las tres vigencias, de la más reciente a la más antigua', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockBase(page);
    await mockVista(page, VISTA_CON_TRASPASO);
    const consultas: string[] = [];
    await page.route(RE_HISTORIAL_7, (route) => {
      consultas.push(new URL(route.request().url()).search);
      return route.fulfill(json(HISTORIAL_TRASPASO));
    });

    await page.goto('/flito/tarifas/7');
    await expect(page.getByRole('button', { name: 'Historial de vigencias' })).toHaveAttribute('aria-expanded', 'false');
    await page.getByRole('button', { name: `Historial · Traspaso de ${ANDINOS}` }).click();

    await expect(page.getByRole('button', { name: 'Traspaso', exact: true, pressed: true })).toBeVisible();
    expect(consultas).toEqual(['?concepto=tramite_digital&tipoTramite=TRASPASO']);
    const tabla = page.getByRole('region', { name: `Historial de Traspaso de ${ANDINOS}` });
    const filas = tabla.getByRole('row');
    await expect(filas).toHaveCount(4);
    await expect(filas.nth(1)).toContainText('$250.000');
    await expect(filas.nth(1)).toContainText('Carlos Ruiz');
    await expect(filas.nth(2)).toContainText('$200.000');
    await expect(filas.nth(3)).toContainText('$180.000');
    await expect(tabla.getByText('Vigente')).toHaveCount(0);
  });

  test('el historial del cliente filtra por rango en el servidor y «Quitar el rango» lo devuelve entero', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockBase(page);
    await mockVista(page, VISTA_CON_TRASPASO);
    const consultas: string[] = [];
    await page.route(RE_HISTORIAL_7, (route) => {
      const q = new URL(route.request().url()).search;
      consultas.push(q);
      return route.fulfill(json(q.includes('desde=2026-08-01') ? [HISTORIAL_TRASPASO[1]] : HISTORIAL_TRASPASO));
    });

    await page.goto('/flito/tarifas/7');
    await page.getByRole('button', { name: 'Historial del cliente' }).click();
    await expect(page.getByRole('button', { name: 'Todos', exact: true, pressed: true })).toBeVisible();
    const tabla = page.getByRole('region', { name: `Historial de todas las llaves de ${ANDINOS}` });
    await expect(tabla.getByRole('row')).toHaveCount(4);
    await expect(tabla.getByRole('columnheader', { name: 'Trámite' })).toBeVisible();

    await page.locator('summary').filter({ hasText: 'Fijadas entre' }).click();
    await irAlMes(page, 2026, 7);
    await page.getByRole('button', { name: '2026-08-01', exact: true }).click();
    await page.getByRole('button', { name: '2026-08-31', exact: true }).click();

    await expect(tabla.getByRole('row')).toHaveCount(2);
    await expect(tabla.getByRole('row').nth(1)).toContainText('Traspaso');
    expect(consultas.at(-1)).toBe('?desde=2026-08-01&hasta=2026-08-31');

    await page.getByRole('button', { name: 'Quitar el rango' }).click();
    await expect(tabla.getByRole('row')).toHaveCount(4);
    expect(consultas.at(-1)).toBe('');
  });
});

test.describe('FLITO — Tarifas · cuatro estados (AC13, AC14, AC15, AC16)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('sin clientes: vacío con el siguiente paso y sin filas ni errores', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockBase(page, { clientes: [], abiertas: [] });

    await page.goto('/flito/tarifas');
    await expect(page.getByText('Todavía no hay clientes.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ir a Clientes y proveedores' })).toHaveAttribute('href', '/clients');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('rowheader')).toHaveCount(0);
  });

  test('cargando: esqueleto en el lugar de la matriz y ningún control de edición', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockBase(page);
    let soltar: () => void = () => {};
    const espera = new Promise<void>((r) => { soltar = r; });
    await page.route(RE_VISTA_7, async (route) => { await espera; return route.fulfill(json(VISTA)); });

    await page.goto('/flito/tarifas/7');
    await expect(page.getByRole('status', { name: `Cargando los valores de ${ANDINOS}` })).toBeVisible();
    await expect(page.getByRole('button', { name: /Cambiar ·|Fijar valor ·|Dejar de cobrar ·/ })).toHaveCount(0);
    soltar();
    await expect(page.getByRole('button', { name: `Cambiar · Matrícula de ${ANDINOS}` })).toBeEnabled();
  });

  test('500 al cargar la matriz: mensaje con reintento que vuelve a pedir, y ninguna fila pintada', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockBase(page);
    // Falla hasta que el usuario pulsa «Reintentar»: así el doble montaje de StrictMode no cuela un
    // segundo GET verde por la espalda y el reintento se mide de verdad.
    let n = 0;
    let reintentado = false;
    await page.route(RE_VISTA_7, (route) => {
      n += 1;
      return route.fulfill(reintentado ? json(VISTA) : json({ error: 'Error del servidor' }, 500));
    });

    await page.goto('/flito/tarifas/7');
    await expect(page.getByRole('alert')).toContainText(`No se pudieron cargar los valores de ${ANDINOS}`);
    await expect(page.getByRole('rowheader')).toHaveCount(0);
    await expect(page.getByText('Sin configurar')).toHaveCount(0);
    await expect(page.getByText('$0', { exact: true })).toHaveCount(0);

    await reposo(page);
    const antes = n;
    reintentado = true;
    await page.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByRole('rowheader')).toHaveCount(4);
    expect(n).toBe(antes + 1);
  });

  test('500 al guardar: la fila conserva lo escrito y avisa', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockBase(page);
    await mockVista(page, VISTA_CON_TRASPASO);
    await page.route(RE_VIGENCIA, (route) => route.fulfill(json({ error: 'Error del servidor' }, 500)));

    await page.goto('/flito/tarifas/7');
    await page.getByRole('button', { name: `Cambiar · Traspaso de ${ANDINOS}` }).click();
    const campo = page.getByRole('textbox', { name: `Valor de Traspaso de ${ANDINOS}` });
    await campo.fill('250000');
    await page.getByRole('button', { name: `Guardar · Traspaso de ${ANDINOS}` }).click();

    await expect(filaDe(page, 'Traspaso').getByRole('alert')).toContainText('No se pudo guardar. El valor que escribiste sigue aquí');
    await expect(campo).toHaveValue('250000');
    await expect(page.getByRole('button', { name: `Guardar · Traspaso de ${ANDINOS}` })).toBeEnabled();
  });

  test('con teclado: se llega a cada valor, se edita y se guarda sin ratón', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockBase(page);
    let vistaActual: unknown = VISTA_CON_TRASPASO;
    await page.route(RE_VISTA_7, (route) => route.fulfill(json(vistaActual)));
    await page.route(RE_VIGENCIA, (route: Route) => {
      vistaActual = {
        ...VISTA_CON_TRASPASO,
        tarifas: (VISTA_CON_TRASPASO.tarifas as Fila[]).map((f) => (f.tipoTramite === 'TRASPASO' ? { ...f, valor: 260000 } : f)),
      };
      return route.fulfill(json({ id: 'v-tra-7c', valor: 260000, valorAnterior: 200000, valorNuevo: 260000 }));
    });

    await page.goto('/flito/tarifas/7');
    const cambiar = page.getByRole('button', { name: `Cambiar · Traspaso de ${ANDINOS}` });
    await cambiar.focus();
    await page.keyboard.press('Enter');
    const campo = page.getByRole('textbox', { name: `Valor de Traspaso de ${ANDINOS}` });
    await expect(campo).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(cambiar).toBeFocused();

    await page.keyboard.press('Enter');
    await campo.fill('260000');
    await page.keyboard.press('Enter');
    await expect(filaDe(page, 'Traspaso')).toContainText('$260.000');
    await expect(cambiar).toBeFocused();
  });
});

// axe necesita `QA_AXE_CDN=1` o `QA_AXE_PATH` explícitos: sin ellos el helper falla a propósito (no
// se salta), así que estos casos van en su propio bloque para que el resto del spec no dependa de red.
test.describe('FLITO — Tarifas · accesibilidad con axe (AC16)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('la matriz llena, una fila en edición y el historial abierto no tienen violaciones serias', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockBase(page);
    await mockVista(page, VISTA_CON_TRASPASO);
    await page.route(RE_HISTORIAL_7, (route) => route.fulfill(json([])));

    await page.goto('/flito/tarifas/7');
    await expect(filaDe(page, 'Matrícula')).toContainText('$270.000');
    esperarSinViolacionesGraves(await correrAxe(page), 'tarifas · matriz llena');

    await page.getByRole('button', { name: `Cambiar · Traspaso de ${ANDINOS}` }).click();
    await expect(page.getByRole('textbox', { name: `Valor de Traspaso de ${ANDINOS}` })).toBeFocused();
    esperarSinViolacionesGraves(await correrAxe(page), 'tarifas · fila en edición');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Historial del cliente' }).click();
    await expect(page.getByText('Este cliente todavía no tiene ninguna vigencia.')).toBeVisible();
    esperarSinViolacionesGraves(await correrAxe(page), 'tarifas · historial abierto');
  });

  test('el modal de dejar de cobrar no tiene violaciones serias', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockBase(page);
    await mockVista(page);

    await page.goto('/flito/tarifas/7');
    await page.getByRole('button', { name: `Dejar de cobrar · Logística de ${ANDINOS}` }).click();
    await expect(page.getByRole('dialog', { name: 'Dejar de cobrar la logística' })).toBeVisible();
    esperarSinViolacionesGraves(await correrAxe(page), 'tarifas · modal dejar de cobrar');
  });
});
