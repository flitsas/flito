// HU #13904 — Comprobantes: desaplicar y reemplazar un comprobante aplicado (Feature #13886).
// UX: docs/ux/flito-comprobantes-desaplicar-reemplazar-13904-slim.md. Backend mockeado con
// `page.route`, mismo patrón que `flito-comprobantes.spec.ts`. Un grupo por AC; el mutante que
// cada aserto mata va en su comentario.

import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../helpers/fixtures';
import { loginAs, FINANCIERA_USER, FUNCIONES_POR_ROL } from '../helpers/auth';

const RUTA = '/flito/comprobantes?asociacion=aplicado_manual';
const PDF = fileURLToPath(new URL('../fixtures/soporte-dos-paginas.pdf', import.meta.url));
const ORIGINAL = '11111111-1111-4111-8111-111111111111';
const REEMPLAZO = '22222222-2222-4222-8222-222222222222';
const OTRO = '33333333-3333-4333-8333-333333333333';
const TRAMITE = { id: '44444444-4444-4444-8444-444444444444', idFlit: 'FLIT-10250', placa: 'XYZ789' };
const BOLSA_ID = '99999999-9999-4999-8999-999999999999';

const DESAPLICAR = 'comprobantes.comprobante.desaplicar';
const REEMPLAZAR = 'comprobantes.comprobante.reemplazar';
const BASE = FUNCIONES_POR_ROL.financiera;
const CON_AMBAS = [...BASE, DESAPLICAR, REEMPLAZAR];

function fila(extra: Record<string, unknown> = {}) {
  return {
    id: ORIGINAL, loteId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', estado: 'aplicado', motivoPendiente: null, detallePendiente: null,
    tipoDocumento: 'recibo_impuesto', esPago: true, concepto: 'impuesto', tramite: TRAMITE, cruce: 'placa',
    placaLeida: 'XYZ789', vinLeido: null, idFlitLeido: null, valor: 312000, fechaDocumento: null,
    numeroDocumento: null, emisor: null, marcadoPorDiferencia: false, diferenciaTarifa: null,
    diferenciaAceptada: false, paginas: null, archivo: { nombre: 'recibo.pdf', contentType: 'application/pdf' },
    createdAt: '2026-10-20T15:42:00.000Z', aplicadoEn: '2026-10-20T16:00:00.000Z', aplicadoAutomaticamente: false, descartadoEn: null,
    subidoPorNombre: 'Ana Pérez', aplicadoPorNombre: 'Luis Gómez', descartadoPorNombre: null,
    aplicadoMotivo: 'Placa corregida', descartadoMotivo: null, soporteAplicadoId: null, ...extra,
  };
}
const detalle = (extra: Record<string, unknown> = {}) => ({ ...fila(extra), campos: [], candidatos: [], diferenciaAceptadaEn: null });
const PENDIENTE_ANTIGUO = fila({ id: OTRO, estado: 'pendiente', motivoPendiente: 'leido', tramite: null, cruce: null, placaLeida: null, concepto: null, valor: null, archivo: { nombre: 'escaneo-17.jpg', contentType: 'image/jpeg' }, createdAt: '2026-10-22T10:00:00.000Z', aplicadoEn: null });
const PENDIENTE_COINCIDE = fila({ id: REEMPLAZO, estado: 'pendiente', motivoPendiente: 'leido', tramite: null, cruce: null, placaLeida: 'XYZ789', valor: 95000, archivo: { nombre: 'recibo-derechos-0412.pdf', contentType: 'application/pdf' }, createdAt: '2026-10-21T10:00:00.000Z', aplicadoEn: null });

type Lista = { items: unknown[]; total: number; page: number; pageSize: number };
const lista = (items: unknown[], total = items.length): Lista => ({ items, total, page: 1, pageSize: 50 });

/** Cola (estado=aplicado) y selector de pendientes (estado=pendiente), por separado; `pendientes` puede ser una función para cambiar entre llamadas. */
async function mockCola(page: Page, pendientes: (n: number) => { status: number; body?: unknown; demora?: number } = () => ({ status: 200, body: lista([PENDIENTE_ANTIGUO, PENDIENTE_COINCIDE]) })) {
  let n = 0;
  await page.route(/\/api\/flito\/comprobantes(\?|$)/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const estado = new URL(route.request().url()).searchParams.get('estado');
    if (estado !== 'pendiente') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(lista([fila()])) });
    const r = pendientes(++n);
    if (r.demora) await new Promise((res) => setTimeout(res, r.demora));
    return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body ?? { error: 'x' }) });
  });
}

async function preparar(page: Page, funciones: readonly string[] = CON_AMBAS, d: unknown = detalle()) {
  await loginAs(page, FINANCIERA_USER, { funciones: [...funciones] });
  await page.route(new RegExp(`/api/flito/comprobantes/${ORIGINAL}$`), (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(d) }));
  await page.route(/\/api\/flito\/comprobantes\/[0-9a-f-]+\/archivo$/, (route) => route.fulfill({ status: 200, contentType: 'application/pdf', path: PDF }));
}

async function abrirFicha(page: Page) {
  await page.goto(RUTA);
  await page.getByRole('button', { name: 'Ver recibo.pdf' }).click();
  const dialog = page.getByRole('dialog', { name: /^Comprobante · / });
  await expect(dialog).toBeVisible();
  return dialog;
}

type Captura = { bodies: Record<string, unknown>[] };
async function mockPost(page: Page, accion: 'desaplicar' | 'reemplazar', responder: (n: number) => { status: number; body?: unknown } | 'abort'): Promise<Captura> {
  const bodies: Record<string, unknown>[] = [];
  await page.route(new RegExp(`/api/flito/comprobantes/${ORIGINAL}/${accion}$`), (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    const r = responder(bodies.length);
    if (r === 'abort') return route.abort('internetdisconnected');
    return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body ?? {}) });
  });
  return { bodies };
}

const toast = (page: Page) => page.locator('p[role="status"]');
const error409 = (codigo: string, extra: Record<string, unknown> = {}) => ({ status: 409, body: { error: `CRUDO-${codigo}`, codigo, ...extra } });

test.describe('HU #13904 · AC1 — acciones solo en aplicado y con su función', () => {
  /** Mutantes: mostrar los botones sin `hasFuncion`; pintarlos `disabled` en vez de omitirlos. */
  test('con ambas funciones aparecen las dos; con una sola, solo esa; sin ninguna, no hay pie', async ({ page }) => {
    await mockCola(page);
    await preparar(page);
    const dialog = await abrirFicha(page);
    await expect(dialog.getByRole('button', { name: 'Desaplicar', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Reemplazar', exact: true })).toBeVisible();
  });

  test('solo desaplicar', async ({ page }) => {
    await mockCola(page);
    await preparar(page, [...BASE, DESAPLICAR]);
    const dialog = await abrirFicha(page);
    await expect(dialog.getByRole('button', { name: 'Desaplicar', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Reemplazar', exact: true })).toHaveCount(0);
  });

  test('solo reemplazar', async ({ page }) => {
    await mockCola(page);
    await preparar(page, [...BASE, REEMPLAZAR]);
    const dialog = await abrirFicha(page);
    await expect(dialog.getByRole('button', { name: 'Reemplazar', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Desaplicar', exact: true })).toHaveCount(0);
  });

  test('sin funciones no hay botones; un descartado tampoco los tiene', async ({ page }) => {
    await mockCola(page);
    await preparar(page, BASE);
    const dialog = await abrirFicha(page);
    await expect(dialog.getByText('Motivo: «Placa corregida»')).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^(Desaplicar|Reemplazar)$/ })).toHaveCount(0);
  });

  test('descartado con ambas funciones: sin botones', async ({ page }) => {
    await mockCola(page);
    await preparar(page, CON_AMBAS, detalle({ estado: 'descartado', descartadoMotivo: 'Duplicado', descartadoEn: '2026-10-21T10:00:00.000Z', aplicadoEn: null }));
    const dialog = await abrirFicha(page);
    await expect(dialog.getByText('Motivo: «Duplicado»')).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^(Desaplicar|Reemplazar)$/ })).toHaveCount(0);
  });
});

test.describe('HU #13904 · AC2 — Desaplicar', () => {
  /** Mutantes: enviar sin destino o con motivo < 5; cerrar el detalle tras el 200; toast sin ✕ o tapado por el modal. */
  test('valida al pulsar, envía destino + motivo, repinta sin cerrar y el toast se cierra con ✕ encima del modal', async ({ page }) => {
    await mockCola(page);
    await preparar(page);
    const post = await mockPost(page, 'desaplicar', () => ({
      status: 200, body: { resultado: 'desaplicado', comprobante: detalle({ estado: 'pendiente', motivoPendiente: 'leido', aplicadoEn: null, candidatos: [] }) },
    }));
    const dialog = await abrirFicha(page);
    await dialog.getByRole('button', { name: 'Desaplicar', exact: true }).click();
    const volver = dialog.getByRole('radio', { name: /Volver a la cola/ });
    await expect(volver).toBeFocused();
    await expect(volver).not.toBeChecked();
    await expect(dialog.getByRole('radio', { name: /Descartar/ })).not.toBeChecked();
    await expect(dialog.getByText('Se deshace lo que este comprobante registró en FLIT-10250 · Impuesto.')).toBeVisible();

    // Sin destino y con motivo corto: nada sale.
    await dialog.getByLabel('Motivo (mínimo 5 caracteres)').fill('abcd');
    await dialog.getByRole('button', { name: 'Desaplicar', exact: true }).click();
    await expect(dialog.getByText('Elige si el comprobante vuelve a la cola o se descarta.')).toBeVisible();
    await expect(dialog.getByText('Escribe el motivo para desaplicar (mínimo 5 caracteres).')).toBeVisible();
    await expect(volver).toBeFocused();
    await volver.check();
    await dialog.getByRole('button', { name: 'Desaplicar', exact: true }).click();
    await expect(dialog.getByLabel('Motivo (mínimo 5 caracteres)')).toBeFocused();
    expect(post.bodies).toHaveLength(0);

    await dialog.getByLabel('Motivo (mínimo 5 caracteres)').fill('Trámite equivocado');
    await dialog.getByRole('button', { name: 'Desaplicar', exact: true }).click();
    await expect(toast(page)).toHaveText('Comprobante desaplicado de FLIT-10250: volvió a la cola.');
    expect(post.bodies).toEqual([{ destino: 'pendiente', motivo: 'Trámite equivocado' }]);
    // Sigue abierto y repintado como pendiente (panel de asociación).
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('¿Qué es este documento?')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Desaplicar', exact: true })).toHaveCount(0);

    // El toast queda ENCIMA del modal: el punto central del toast pertenece al toast.
    const encima = await toast(page).evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!top && el.parentElement!.contains(top);
    });
    expect(encima).toBe(true);
    await page.getByRole('button', { name: 'Cerrar aviso' }).click();
    await expect(toast(page)).toHaveText('');
  });

  test('destino descartado: queda en solo lectura de descartado con su motivo; Esc cierra el bloque y devuelve el foco', async ({ page }) => {
    await mockCola(page);
    await preparar(page);
    await mockPost(page, 'desaplicar', () => ({
      status: 200, body: { resultado: 'desaplicado', comprobante: detalle({ estado: 'descartado', descartadoMotivo: 'No era de este trámite', descartadoEn: '2026-10-24T10:00:00.000Z', aplicadoEn: null }) },
    }));
    const dialog = await abrirFicha(page);
    const boton = dialog.getByRole('button', { name: 'Desaplicar', exact: true });
    await boton.click();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(boton).toBeFocused();
    await boton.click();
    await dialog.getByRole('radio', { name: /Descartar/ }).check();
    await dialog.getByLabel('Motivo (mínimo 5 caracteres)').fill('No era de este trámite');
    await dialog.getByRole('button', { name: 'Desaplicar', exact: true }).click();
    await expect(toast(page)).toHaveText('Comprobante desaplicado de FLIT-10250 y descartado.');
    await expect(dialog.getByText('Motivo: «No era de este trámite»')).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^(Desaplicar|Reemplazar)$/ })).toHaveCount(0);
  });
});

test.describe('HU #13904 · AC3 — Reemplazar y sus 4 estados', () => {
  /** Mutantes: sin esqueleto `aria-busy`; error sin Reintentar; vacío que pinta motivo y botón; orden sin «coincide» primero. */
  test('cargando → error → Reintentar → lleno ordenado; valida; envía y repinta el original descartado', async ({ page }) => {
    await mockCola(page, (n) => (n === 1 ? { status: 500, demora: 400 } : { status: 200, body: lista([PENDIENTE_ANTIGUO, PENDIENTE_COINCIDE], 80) }));
    await preparar(page);
    const post = await mockPost(page, 'reemplazar', () => ({
      status: 200, body: {
        resultado: 'reemplazado',
        original: detalle({ estado: 'descartado', descartadoMotivo: 'Recibo equivocado', descartadoEn: '2026-10-24T10:00:00.000Z', aplicadoEn: null }),
        comprobante: { ...detalle({ id: REEMPLAZO, archivo: { nombre: 'recibo-derechos-0412.pdf', contentType: 'application/pdf' } }), bolsa: { movimientos: [], omitidos: [], alertas: [] } },
      },
    }));
    const dialog = await abrirFicha(page);
    await dialog.getByRole('button', { name: 'Reemplazar', exact: true }).click();
    await expect(dialog.getByText('Reemplazar el comprobante de FLIT-10250 · Impuesto')).toBeVisible();
    await expect(dialog.locator('fieldset[aria-busy="true"]')).toBeVisible();
    await expect(dialog.getByText('No se pudieron cargar los comprobantes pendientes.')).toBeVisible();
    await dialog.getByLabel('Motivo del reemplazo (mínimo 5 caracteres)').fill('Recibo equivocado');
    await dialog.getByRole('button', { name: 'Reintentar' }).click();

    const radios = dialog.getByRole('radio');
    await expect(radios).toHaveCount(2);
    await expect(radios.first()).toHaveAccessibleName(/recibo-derechos-0412\.pdf/);
    await expect(dialog.getByText('Coincide con FLIT-10250')).toHaveCount(1);
    await expect(dialog.getByText(/Sin concepto leído · Sin valor leído/)).toBeVisible();
    await expect(dialog.getByText('Se muestran los 2 pendientes más recientes. Si no ves el que buscas, revisa la cola.')).toBeVisible();
    // El motivo sobrevivió al error y a la recarga de la lista.
    await expect(dialog.getByLabel('Motivo del reemplazo (mínimo 5 caracteres)')).toHaveValue('Recibo equivocado');

    await dialog.getByRole('button', { name: 'Reemplazar', exact: true }).click();
    await expect(dialog.getByText('Elige el comprobante que va en su lugar.')).toBeVisible();
    expect(post.bodies).toHaveLength(0);
    await radios.first().check();
    await dialog.getByRole('button', { name: 'Reemplazar', exact: true }).click();
    await expect(toast(page)).toHaveText('Comprobante reemplazado: recibo-derechos-0412.pdf quedó aplicado a FLIT-10250 · Impuesto.');
    expect(post.bodies).toEqual([{ reemplazoId: REEMPLAZO, motivo: 'Recibo equivocado' }]);
    await expect(dialog.getByText('Motivo: «Recibo equivocado»')).toBeVisible();
  });

  test('vacío: lo explica y no pinta motivo ni «Reemplazar»; Cancelar devuelve el pie', async ({ page }) => {
    await mockCola(page, () => ({ status: 200, body: lista([]) }));
    await preparar(page);
    const dialog = await abrirFicha(page);
    await dialog.getByRole('button', { name: 'Reemplazar', exact: true }).click();
    await expect(dialog.getByText(/No hay comprobantes pendientes para usar en su lugar\. Carga el comprobante correcto/)).toBeVisible();
    await expect(dialog.getByLabel(/Motivo del reemplazo/)).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Reemplazar', exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialog.getByRole('button', { name: 'Desaplicar', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Reemplazar', exact: true })).toBeFocused();
  });
});

test.describe('HU #13904 · AC4 — periodo cerrado como aviso de la ficha', () => {
  /** Mutantes: pintar `AAAA-MM` o el uuid; usar toast; no tener respaldo sin `bolsaNombre`. */
  test('con bolsaNombre: «octubre de 2026 de la bolsa …»; sin él, el respaldo', async ({ page }) => {
    await mockCola(page);
    await preparar(page);
    await mockPost(page, 'desaplicar', (n) => error409('periodo_cerrado', { bolsaId: BOLSA_ID, periodo: '2026-10', bolsaNombre: n === 1 ? 'Renting Andino' : '' }));
    const dialog = await abrirFicha(page);
    for (const nombre of ['la bolsa Renting Andino', 'la bolsa del cliente']) {
      await dialog.getByRole('button', { name: 'Desaplicar', exact: true }).click();
      await dialog.getByRole('radio', { name: /Volver a la cola/ }).check();
      await dialog.getByLabel('Motivo (mínimo 5 caracteres)').fill('Trámite equivocado');
      await dialog.getByRole('button', { name: 'Desaplicar', exact: true }).click();
      const aviso = dialog.getByRole('alert');
      await expect(aviso).toHaveText(`No se puede corregir este comprobante: su descuento cae en octubre de 2026 de ${nombre}, y ese periodo ya está cerrado.`);
      await expect(dialog).not.toContainText(BOLSA_ID);
      await expect(dialog).not.toContainText('2026-10');
      await expect(dialog).not.toContainText('CRUDO');
    }
  });
});

test.describe('HU #13904 · AC5 — avisos por código, nunca el error crudo', () => {
  const CASOS: [string, string | RegExp][] = [
    ['dueno_no_reversible', 'Este pago no se deshace desde Comprobantes. Corrige el pago en su módulo (Impuesto).'],
    ['tramite_liquidado', 'La liquidación de FLIT-10250 está sellada. Reversa la liquidación en el reporte de costos y vuelve a intentarlo.'],
    ['no_aplicado', /Este comprobante ya no está aplicado: otro usuario lo desaplicó o lo reemplazó mientras lo tenías abierto\./],
    ['servicio_no_reversible', /Corrige el valor en Servicios adicionales\./],
  ];
  /** Mutante: pintar `err.error` (CRUDO-…) o el código. */
  test('cada código muestra su copy en la ficha', async ({ page }) => {
    await mockCola(page);
    await preparar(page);
    await mockPost(page, 'desaplicar', (n) => error409(CASOS[n - 1][0]));
    const dialog = await abrirFicha(page);
    for (const [codigo, copy] of CASOS) {
      await dialog.getByRole('button', { name: 'Desaplicar', exact: true }).click();
      await dialog.getByRole('radio', { name: /Descartar/ }).check();
      await dialog.getByLabel('Motivo (mínimo 5 caracteres)').fill('Motivo válido');
      await dialog.getByRole('button', { name: 'Desaplicar', exact: true }).click();
      await expect(dialog.getByRole('alert')).toContainText(copy);
      await expect(dialog).not.toContainText('CRUDO');
      await expect(dialog).not.toContainText(codigo);
      if (codigo === 'no_aplicado') await expect(dialog.getByRole('button', { name: 'Actualizar', exact: true })).toBeVisible();
    }
  });
});

test.describe('HU #13904 · AC6 — aviso de saldo negativo solo con la respuesta', () => {
  /** Mutantes: ignorar `bolsa.alertas`; pintar el uuid; repetir el aviso dentro de la ficha. */
  test('reemplazar con alertas: aviso en la página con nombre y saldo; se cierra con ✕; la ficha no lo repite', async ({ page }) => {
    await mockCola(page);
    await preparar(page);
    await mockPost(page, 'reemplazar', () => ({
      status: 200, body: {
        resultado: 'reemplazado',
        original: detalle({ estado: 'descartado', descartadoMotivo: 'Recibo equivocado', descartadoEn: '2026-10-24T10:00:00.000Z', aplicadoEn: null }),
        comprobante: { ...detalle({ id: REEMPLAZO }), bolsa: { movimientos: [], omitidos: [], alertas: [{ bolsaId: BOLSA_ID, bolsaNombre: 'Renting Andino', alcance: 'cliente', saldoResultante: -120000 }] } },
      },
    }));
    const dialog = await abrirFicha(page);
    await dialog.getByRole('button', { name: 'Reemplazar', exact: true }).click();
    await dialog.getByRole('radio').first().check();
    await dialog.getByLabel('Motivo del reemplazo (mínimo 5 caracteres)').fill('Recibo equivocado');
    await dialog.getByRole('button', { name: 'Reemplazar', exact: true }).click();
    await expect(toast(page)).toContainText('Comprobante reemplazado');
    await expect(dialog).not.toContainText('saldo negativo');
    await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click();
    const aviso = page.getByText('La bolsa Renting Andino quedó en saldo negativo: −$ 120.000. El comprobante se aplicó igual.');
    await expect(aviso).toBeVisible();
    await expect(page.locator('body')).not.toContainText(BOLSA_ID);
    await page.getByRole('button', { name: 'Cerrar el aviso de saldo' }).click();
    await expect(aviso).toHaveCount(0);
  });

  test('aplicar con alertas (panel de asociación): el mismo aviso; sin nombre, el respaldo', async ({ page }) => {
    const PEND = fila({ estado: 'pendiente', motivoPendiente: 'leido', aplicadoEn: null });
    await loginAs(page, FINANCIERA_USER);
    await page.route(/\/api\/flito\/comprobantes(\?|$)/, (route) => route.request().method() !== 'GET' ? route.fallback()
      : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(lista([PEND])) }));
    const candidato = { tramiteId: TRAMITE.id, idFlit: TRAMITE.idFlit, placa: TRAMITE.placa, vin: null, tipoTramite: 'Traspaso', empresa: 'Renting Andino', flitEstado: 'solicitado', liquidado: false,
      admite: { derecho: 'admite', soat: 'admite', impuesto: 'admite', tramite_digital: 'admite', logistica: 'admite', servicios_adicionales: 'admite' } };
    const campo = (c: string, valor: string | null) => ({ campo: c, valor, confianza: valor ? 0.9 : 0, confiable: !!valor, nivel: valor ? 'alta' : null, confirmadoPor: null });
    const campos = [campo('tipoDocumento', 'recibo_impuesto'), campo('esComprobantePago', 'true'), campo('concepto', 'impuesto'), campo('placa', 'XYZ789'), campo('valorTotal', '312000')];
    await page.route(new RegExp(`/api/flito/comprobantes/${ORIGINAL}$`), (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...detalle({ estado: 'pendiente', motivoPendiente: 'leido', aplicadoEn: null }), campos, candidatos: [candidato] }) }));
    await page.route(/\/api\/flito\/comprobantes\/[0-9a-f-]+\/archivo$/, (route) => route.fulfill({ status: 200, contentType: 'application/pdf', path: PDF }));
    await page.route(/\/api\/flito\/comprobantes\/tramites\/buscar$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidatos: [] }) }));
    await page.route(new RegExp(`/api/flito/comprobantes/${ORIGINAL}/aplicar$`), (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ resultado: 'aplicado', comprobante: { ...detalle(), bolsa: { movimientos: [], omitidos: [], alertas: [{ bolsaId: BOLSA_ID, bolsaNombre: '', alcance: 'cliente', saldoResultante: -5000 }] } } }),
    }));
    await page.goto('/flito/comprobantes');
    await page.getByRole('button', { name: 'Asociar recibo.pdf' }).click();
    const dialog = page.getByRole('dialog', { name: /^Comprobante · / });
    await dialog.getByRole('button', { name: 'Aplicar' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('La bolsa del cliente quedó en saldo negativo: −$ 5.000. El comprobante se aplicó igual.')).toBeVisible();
  });
});

test.describe('HU #13904 · AC7 — red o servidor: Reintentar y el bloque conserva lo escrito', () => {
  /** Mutantes: cerrar el bloque o vaciar el motivo en un fallo de red; pintar el mensaje crudo de fetch. */
  test('offline y luego 500: «Reintentar» reenvía lo mismo; con el 200 se repinta', async ({ page }) => {
    await mockCola(page);
    await preparar(page);
    const post = await mockPost(page, 'desaplicar', (n) => (n === 1 ? 'abort' : n === 2 ? { status: 500, body: { error: 'CRUDO boom' } } : {
      status: 200, body: { resultado: 'desaplicado', comprobante: detalle({ estado: 'descartado', descartadoMotivo: 'Trámite equivocado', descartadoEn: '2026-10-24T10:00:00.000Z', aplicadoEn: null }) },
    }));
    const dialog = await abrirFicha(page);
    await dialog.getByRole('button', { name: 'Desaplicar', exact: true }).click();
    await dialog.getByRole('radio', { name: /Descartar/ }).check();
    await dialog.getByLabel('Motivo (mínimo 5 caracteres)').fill('Trámite equivocado');
    await dialog.getByRole('button', { name: 'Desaplicar', exact: true }).click();
    for (let i = 0; i < 2; i += 1) {
      await expect(dialog.getByText('No se pudo desaplicar. Revisa tu conexión y vuelve a intentarlo.')).toBeVisible();
      await expect(dialog.getByLabel('Motivo (mínimo 5 caracteres)')).toHaveValue('Trámite equivocado');
      await expect(dialog.getByRole('radio', { name: /Descartar/ })).toBeChecked();
      await expect(dialog).not.toContainText('CRUDO');
      await dialog.getByRole('button', { name: 'Reintentar' }).click();
    }
    await expect(toast(page)).toHaveText('Comprobante desaplicado de FLIT-10250 y descartado.');
    expect(post.bodies).toHaveLength(3);
    expect(new Set(post.bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });
});
