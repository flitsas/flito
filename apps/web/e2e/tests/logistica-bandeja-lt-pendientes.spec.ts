import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';

// FLITO — Logística: bandeja «LT pendientes de trámite» (HU #14149, Feature C1 #14091).
// Diseño: docs/ux/logistica-bandeja-lt-pendientes-14149-full.md. Backend mockeado con estado.

type Page = import('@playwright/test').Page;
const FUNCION = 'logistica.documento.resolver_tramite';
const BASE = ['logistica.documento.ver', 'logistica.lote.cerrar'];
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

const CAND_A = { tramiteId: 'tr-a', idFlit: 'FL-48213', companiaId: 1, companiaNombre: 'Seguros Andina S. A.', organismoCodigo: 'CALI', fechaAprobacion: '2026-10-18T12:00:00Z', tipoTramite: 'Matrícula inicial' };
const CAND_B = { tramiteId: 'tr-b', idFlit: 'FL-48377', companiaId: 2, companiaNombre: 'Transportes del Valle S. A. S.', organismoCodigo: 'CALI', fechaAprobacion: '2026-10-22T12:00:00Z', tipoTramite: 'Traspaso' };
const LT1 = { documentoId: 'd1', placa: 'ABC123', organismoCodigo: 'CALI', estado: 'recogido', firmada: true, recogidoEn: '2026-10-16T15:40:00Z', recogidoPorNombre: 'Mensajero Uno', antiguedadDias: 12, candidatos: [CAND_A, CAND_B] };
const LT2 = { documentoId: 'd2', placa: 'XYZ987', organismoCodigo: 'BOGOTA', estado: 'recogido', firmada: false, recogidoEn: '2026-10-23T09:15:00Z', recogidoPorNombre: 'Mensajero Dos', antiguedadDias: 5, candidatos: [CAND_B] };
const LT3 = { documentoId: 'd3', placa: 'QWE456', organismoCodigo: 'CALI', estado: 'recogido', firmada: true, recogidoEn: '2026-10-28T08:02:00Z', recogidoPorNombre: 'Mensajero Uno', antiguedadDias: 0, candidatos: [] };

async function mockBase(page: Page) {
  await page.route(/\/api\/flito\/logistica\/facetas/, (r) => r.fulfill(json({ estados: [], empresas: [], organismos: [], companiasCerrables: [], mensajeros: [] })));
  await page.route(/\/api\/flito\/logistica\/actas$/, (r) => r.fulfill(json([])));
  await page.route(/\/api\/flito\/logistica\?/, (r) => r.fulfill(json({ items: [], total: 7, page: 1, pageSize: 50 })));
}

interface Mock { lista?: unknown[]; listaFalla?: boolean; candidatos?: Record<string, unknown[]>; resolver?: (n: number) => { status: number; body: unknown } }
async function mockBandeja(page: Page, m: Mock = {}) {
  const st = { lista: m.lista ?? [LT1, LT2, LT3], listaGets: 0, resolverPosts: [] as unknown[], candGets: 0, falla: !!m.listaFalla };
  await mockBase(page);
  await page.route(/\/api\/flito\/logistica\/pendientes-tramite$/, (r) => {
    st.listaGets++;
    return st.falla ? r.fulfill(json({ error: 'boom SQL' }, 500)) : r.fulfill(json({ pendientes: st.lista }));
  });
  await page.route(/\/api\/flito\/logistica\/documentos\/([^/]+)\/candidatos-tramite$/, (r) => {
    st.candGets++;
    const id = /documentos\/([^/]+)\//.exec(r.request().url())![1];
    return r.fulfill(json({ candidatos: (m.candidatos ?? {})[id] ?? st.lista.find((x) => (x as { documentoId: string }).documentoId === id) ? ((m.candidatos ?? {})[id] ?? (st.lista.find((x) => (x as { documentoId: string }).documentoId === id) as { candidatos: unknown[] }).candidatos) : [] }));
  });
  await page.route(/\/api\/flito\/logistica\/documentos\/([^/]+)\/resolver-tramite$/, (r) => {
    st.resolverPosts.push(r.request().postDataJSON());
    const res = m.resolver ? m.resolver(st.resolverPosts.length) : { status: 200, body: { documentoId: 'd1', tramiteId: 'tr-b', companiaId: 2, actaId: 'a1' } };
    if (res.status === 200) st.lista = st.lista.filter((x) => (x as { documentoId: string }).documentoId !== 'd1');
    return r.fulfill(json(res.body, res.status));
  });
  return st;
}

const irABandeja = async (page: Page) => {
  await page.goto('/flito/logistica');
  await page.getByRole('button', { name: /^LT pendientes/ }).click();
};

test.describe('FLITO — Logística · bandeja de LT pendientes', () => {
  test('sin la función: ni pestaña ni llamada al API', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER, { funciones: BASE });
    const st = await mockBandeja(page);
    await page.goto('/flito/logistica');
    await expect(page.getByRole('button', { name: /Trámites/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /LT pendientes/ })).toHaveCount(0);
    expect(st.listaGets).toBe(0);
  });

  test('con la función: contador, orden por antigüedad, aria-sort y alternar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER, { funciones: [...BASE, FUNCION] });
    await mockBandeja(page);
    await page.goto('/flito/logistica');
    await expect(page.getByRole('button', { name: 'LT pendientes, 3' })).toBeVisible();
    await page.getByRole('button', { name: /^LT pendientes/ }).click();
    const filas = page.getByRole('row');
    await expect(filas.nth(1)).toContainText('ABC123');
    await expect(filas.nth(1)).toContainText('2 candidatos');
    await expect(filas.nth(1)).toContainText('Firmada');
    await expect(filas.nth(2)).toContainText('XYZ987');
    await expect(filas.nth(2)).toContainText('Sin firma');
    await expect(filas.nth(3)).toContainText('Hoy');
    await expect(page.getByRole('columnheader', { name: /Antigüedad/ })).toHaveAttribute('aria-sort', 'descending');
    await page.getByRole('columnheader', { name: /Antigüedad/ }).getByRole('button').click();
    await expect(page.getByRole('columnheader', { name: /Antigüedad/ })).toHaveAttribute('aria-sort', 'ascending');
    await expect(page.getByRole('row').nth(1)).toContainText('QWE456');
  });

  test('filtros: placa, firma, combinados, vacío con filtro y Limpiar; la placa no va a la URL', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER, { funciones: [...BASE, FUNCION] });
    await mockBandeja(page);
    await irABandeja(page);
    await page.getByRole('button', { name: 'Sin firma' }).click();
    await expect(page.getByRole('row')).toHaveCount(2);
    await expect(page.getByRole('row').nth(1)).toContainText('XYZ987');
    await page.getByRole('button', { name: 'Todas' }).click();
    await page.getByLabel('Buscar por placa').fill('abc');
    await expect(page.getByRole('row')).toHaveCount(2);
    expect(page.url()).not.toContain('abc');
    await page.getByRole('button', { name: 'Sin firma' }).click();
    await expect(page.getByText('Ninguna LT coincide con tu búsqueda.')).toBeVisible();
    await page.getByRole('button', { name: 'Limpiar filtros' }).click();
    await expect(page.getByRole('row')).toHaveCount(4);
  });

  test('diálogo de dos pasos: sin preselección, confirmar con firma y toast', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER, { funciones: [...BASE, FUNCION] });
    const st = await mockBandeja(page);
    await irABandeja(page);
    await page.getByRole('row', { name: /ABC123/ }).getByRole('button', { name: /Elegir trámite/ }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg).toContainText('Matrícula inicial');
    await expect(dlg).toContainText('Traspaso');
    await expect(dlg.getByRole('radio', { checked: true })).toHaveCount(0);
    await expect(dlg.getByRole('button', { name: 'Continuar' })).toBeDisabled();
    await expect(dlg).toContainText('Elige un trámite para continuar.');
    await dlg.getByRole('radio', { name: /Transportes del Valle/ }).check();
    await dlg.getByRole('button', { name: 'Continuar' }).click();
    await expect(dlg).toContainText('ya tiene la firma del organismo');
    await dlg.getByRole('button', { name: 'Volver' }).click();
    await dlg.getByRole('radio', { name: /Transportes del Valle/ }).check();
    await dlg.getByRole('button', { name: 'Continuar' }).click();
    await dlg.getByRole('button', { name: 'Asignar trámite' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('LT de ABC123 asignada al trámite FL-48377 de Transportes del Valle S. A. S. Entró a su acta de organismo con la firma ya capturada.')).toBeVisible();
    expect(st.resolverPosts).toEqual([{ tramiteId: 'tr-b' }]);
    await expect(page.getByRole('row', { name: /ABC123/ })).toHaveCount(0);
  });

  test('LT sin firma: el paso 2 y el toast dicen que entrará cuando el organismo firme', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER, { funciones: [...BASE, FUNCION] });
    await mockBandeja(page, { resolver: () => ({ status: 200, body: { documentoId: 'd2', tramiteId: 'tr-b', companiaId: 2, actaId: null } }) });
    await irABandeja(page);
    await page.getByRole('row', { name: /XYZ987/ }).getByRole('button', { name: /Elegir trámite/ }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByRole('radio').check();
    await dlg.getByRole('button', { name: 'Continuar' }).click();
    await expect(dlg).toContainText('Aún no tiene firma del organismo');
    await dlg.getByRole('button', { name: 'Asignar trámite' }).click();
    await expect(page.getByText(/Entrará al acta cuando el organismo firme\./)).toBeVisible();
  });

  test('sin candidatos: vacío y solo Cerrar, sin anular', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER, { funciones: [...BASE, FUNCION] });
    await mockBandeja(page);
    await irABandeja(page);
    await page.getByRole('row', { name: /QWE456/ }).getByRole('button', { name: /Elegir trámite/ }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg).toContainText('Aún no hay trámites aprobados de este vehículo para elegir.');
    await expect(dlg.getByRole('button', { name: 'Cerrar' }).first()).toBeVisible();
    await expect(dlg.getByRole('button', { name: /anular/i })).toHaveCount(0);
  });

  for (const [codigo, status] of [['LT_NO_PENDIENTE', 409], ['LT_NO_ENCONTRADA', 404]] as const) {
    test(`${codigo}: cierra, refresca y toast propio (no el texto del API)`, async ({ page }) => {
      await loginAs(page, OPERACIONES_USER, { funciones: [...BASE, FUNCION] });
      const st = await mockBandeja(page, { resolver: () => ({ status, body: { error: 'TEXTO CRUDO DEL API', codigo } }) });
      await irABandeja(page);
      const antes = st.listaGets;
      await page.getByRole('row', { name: /ABC123/ }).getByRole('button', { name: /Elegir trámite/ }).click();
      await page.getByRole('dialog').getByRole('radio').first().check();
      await page.getByRole('dialog').getByRole('button', { name: 'Continuar' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Asignar trámite' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByText(codigo === 'LT_NO_PENDIENTE' ? /Esta LT ya no está pendiente/ : /No encontramos esta LT/)).toBeVisible();
      await expect(page.getByText('TEXTO CRUDO DEL API')).toHaveCount(0);
      expect(st.listaGets).toBeGreaterThan(antes);
    });
  }

  for (const [codigo, status, copy] of [
    ['TRAMITE_NO_CANDIDATO', 422, /Ese trámite ya no es una opción para esta LT/], ['TRAMITE_YA_TIENE_LT', 409, /Ese trámite ya tiene otra LT/],
  ] as const) {
    test(`${codigo}: alerta en el diálogo, vuelve al paso 1 y recarga candidatos`, async ({ page }) => {
      await loginAs(page, OPERACIONES_USER, { funciones: [...BASE, FUNCION] });
      const st = await mockBandeja(page, { resolver: () => ({ status, body: { error: 'CRUDO', codigo } }) });
      await irABandeja(page);
      await page.getByRole('row', { name: /ABC123/ }).getByRole('button', { name: /Elegir trámite/ }).click();
      const dlg = page.getByRole('dialog');
      await dlg.getByRole('radio').first().check();
      await dlg.getByRole('button', { name: 'Continuar' }).click();
      await dlg.getByRole('button', { name: 'Asignar trámite' }).click();
      await expect(dlg.getByRole('alert')).toContainText(copy);
      await expect(dlg.getByRole('button', { name: 'Continuar' })).toBeDisabled();
      await expect(dlg.getByRole('radio', { checked: true })).toHaveCount(0);
      expect(st.candGets).toBeGreaterThanOrEqual(2);
    });
  }

  test('error genérico 500: alerta con Reintentar y el reintento asigna', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER, { funciones: [...BASE, FUNCION] });
    const st = await mockBandeja(page, { resolver: (n) => n === 1 ? { status: 500, body: { error: 'stack SQL' } } : { status: 200, body: { documentoId: 'd1', tramiteId: 'tr-a', companiaId: 1, actaId: 'a' } } });
    await irABandeja(page);
    await page.getByRole('row', { name: /ABC123/ }).getByRole('button', { name: /Elegir trámite/ }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByRole('radio').first().check();
    await dlg.getByRole('button', { name: 'Continuar' }).click();
    await dlg.getByRole('button', { name: 'Asignar trámite' }).click();
    await expect(dlg.getByRole('alert')).toContainText('No pudimos asignar el trámite.');
    await expect(dlg).not.toContainText('stack SQL');
    await dlg.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(st.resolverPosts).toHaveLength(2);
  });

  test('vacío sin LT: sin badge y con copy de espera', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER, { funciones: [...BASE, FUNCION] });
    await mockBandeja(page, { lista: [] });
    await irABandeja(page);
    await expect(page.getByText('No hay LT esperando trámite.')).toBeVisible();
    await expect(page.getByRole('button', { name: /^LT pendientes,/ })).toHaveCount(0);
  });

  test('error de carga: alerta con Reintentar que recupera', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER, { funciones: [...BASE, FUNCION] });
    const st = await mockBandeja(page, { listaFalla: true });
    await irABandeja(page);
    const alerta = page.getByRole('alert');
    await expect(alerta).toContainText('No pudimos cargar las LT pendientes.');
    await expect(alerta).not.toContainText('boom SQL');
    st.falla = false;
    await alerta.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByRole('row', { name: /ABC123/ })).toBeVisible();
  });

  test('tope de 500: aviso «Mostrando las 500 más antiguas»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER, { funciones: [...BASE, FUNCION] });
    const lista = Array.from({ length: 500 }, (_, i) => ({ ...LT1, documentoId: `x${i}`, placa: `PL${String(i).padStart(4, '0')}`, antiguedadDias: i }));
    await mockBandeja(page, { lista });
    await irABandeja(page);
    await expect(page.getByText('Mostrando las 500 más antiguas.')).toBeVisible();
  });

  test('375 px: tarjetas, orden por select, sin scroll horizontal', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loginAs(page, OPERACIONES_USER, { funciones: [...BASE, FUNCION] });
    await mockBandeja(page);
    await irABandeja(page);
    await expect(page.getByRole('table')).toBeHidden();
    await expect(page.getByRole('button', { name: /Elegir trámite de ABC123/ })).toBeVisible();
    await page.getByLabel('Orden').selectOption('desc');
    await expect(page.getByRole('listitem').first()).toContainText('QWE456');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
