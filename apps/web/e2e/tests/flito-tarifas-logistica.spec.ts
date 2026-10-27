// FLITO — Tarifas · los dos precios de logística (HU #14107). Backend mockeado.
// AC1 dos precios con vigencias · AC2 sin precio FLIT, guardar abre vigencia · AC3 cero pide confirmación · AC4 estados.

import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, FINANCIERA_USER } from '../helpers/auth';

const ANDINOS = 'Transportes Andinos S.A.S.';
const RE_CLIENTS = /\/api\/clients(\?|$)/;
const RE_ABIERTAS = /\/api\/flito\/parametrizacion\/tarifas$/;
const RE_VISTA = /\/api\/flito\/parametrizacion\/tarifas\/companias\/7$/;
const RE_CREAR = /\/api\/flito\/parametrizacion\/tarifas$/;
const ANA = { id: 10, nombre: 'Ana Pérez' };

const json = (cuerpo: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(cuerpo) });
type Fila = Record<string, unknown>;
const fila = (concepto: string, tipoTramite: string | null, over: Fila = {}): Fila => ({
  concepto, tipoTramite, vigenciaId: null, valor: null, vigenteDesde: null, fijadoPor: null, ...over,
});

/** Cliente con valor y FLIT sin configurar: el API aún manda la logística del cliente como `logistica`. */
const VISTA = {
  companiaId: 7,
  companiaNombre: ANDINOS,
  tarifas: [
    fila('tramite_digital', 'MATRICULA', { vigenciaId: 'v-mat', valor: 270000, vigenteDesde: '2026-09-01T15:00:00.000Z', fijadoPor: ANA }),
    fila('tramite_digital', 'TRASPASO', { vigenciaId: 'v-tra', valor: 200000, vigenteDesde: '2026-09-01T15:00:00.000Z', fijadoPor: ANA }),
    fila('tramite_digital', 'OTROS', { vigenciaId: 'v-otr', valor: 1000, vigenteDesde: '2026-09-01T15:00:00.000Z', fijadoPor: ANA }),
    fila('logistica', null, { vigenciaId: 'v-log', valor: 38000, vigenteDesde: '2026-10-02T15:00:00.000Z', fijadoPor: ANA, flitoGestionaLogistica: true }),
  ],
  capacidades: { editar: true, verHistorial: true },
};

async function preparar(page: Page, vista: unknown = VISTA) {
  await loginAs(page, FINANCIERA_USER);
  await page.route(RE_CLIENTS, (r) => r.fulfill(json([{ id: 7, name: ANDINOS, document: '900777', logisticaAutogestionable: false }])));
  await page.route(RE_ABIERTAS, (r) => (r.request().method() === 'GET' ? r.fulfill(json([])) : r.fallback()));
  await page.route(RE_VISTA, (r) => r.fulfill(json(vista)));
}

const panelDe = (page: Page, nombre: string) => page.getByRole('region', { name: nombre, exact: true });

test.describe('FLITO — Tarifas · logística cliente y FLIT (HU #14107)', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('AC1: ambos precios, con desde y quién; FLIT sin configurar se marca como falta', async ({ page }) => {
    await preparar(page);
    await page.goto('/flito/tarifas/7');
    const cliente = panelDe(page, 'Entrega a cliente');
    await expect(cliente).toContainText('$38.000');
    await expect(cliente).toContainText('Desde 2 oct 2026 · Ana Pérez');
    const flit = panelDe(page, 'Entrega a FLIT');
    await expect(flit).toContainText('Sin configurar');
    await expect(flit).toContainText('Falta');
    await expect(flit).toContainText('Sin este precio no se puede registrar un viaje con este destino.');
    await expect(flit.getByRole('button', { name: /^Dejar de cobrar/ })).toBeDisabled();
    await expect(page.getByText('Gestiona FLITO')).toHaveCount(1);
    await expect(page.getByText('Falta 1 valor', { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/\blogistica(_flit)?\b/)).toHaveCount(0);
  });

  test('AC2: fijar el precio FLIT crea una vigencia nueva con concepto logistica_flit', async ({ page }) => {
    await preparar(page);
    const cuerpos: unknown[] = [];
    await page.route(RE_CREAR, (r) => {
      if (r.request().method() !== 'POST') return r.fallback();
      cuerpos.push(r.request().postDataJSON());
      return r.fulfill(json({ id: 'v-flit', valor: 12000 }, 201));
    });
    await page.goto('/flito/tarifas/7');
    await panelDe(page, 'Entrega a FLIT').getByRole('button', { name: /^Fijar valor/ }).click();
    await page.getByLabel(`Valor de Entrega a FLIT de ${ANDINOS}`).fill('12000');
    await page.getByRole('button', { name: /^Guardar/ }).click();
    expect(cuerpos).toEqual([{ companiaId: 7, concepto: 'logistica_flit', valor: 12000 }]);
    await expect(page.getByText(`Entrega a FLIT de ${ANDINOS}: Sin configurar → $12.000. Rige desde ahora.`)).toBeVisible();
  });

  test('AC3: guardar 0 pide la confirmación y cancelar no guarda', async ({ page }) => {
    await preparar(page);
    let posts = 0;
    await page.route(RE_CREAR, (r) => { if (r.request().method() === 'POST') posts += 1; return r.fallback(); });
    await page.goto('/flito/tarifas/7');
    await panelDe(page, 'Entrega a FLIT').getByRole('button', { name: /^Fijar valor/ }).click();
    await page.getByLabel(`Valor de Entrega a FLIT de ${ANDINOS}`).fill('0');
    await page.getByRole('button', { name: /^Guardar/ }).click();
    const modal = page.getByRole('dialog', { name: 'Cobrar cero por Entrega a FLIT' });
    await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: 'Cancelar' }).click();
    expect(posts).toBe(0);
  });

  test('AC4: error con reintento y carga', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await page.route(RE_CLIENTS, (r) => r.fulfill(json([{ id: 7, name: ANDINOS, document: '900777', logisticaAutogestionable: false }])));
    await page.route(RE_ABIERTAS, (r) => r.fulfill(json([])));
    let falla = true;
    await page.route(RE_VISTA, (r) => (falla ? r.fulfill(json({ error: 'boom' }, 500)) : r.fulfill(json(VISTA))));
    await page.goto('/flito/tarifas/7');
    await expect(page.getByText(`No se pudieron cargar los valores de ${ANDINOS}.`)).toBeVisible();
    falla = false;
    await page.getByRole('button', { name: 'Reintentar' }).click();
    await expect(panelDe(page, 'Entrega a cliente')).toContainText('$38.000');
  });

  test('móvil 375: los paneles se apilan sin desbordar la página', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await preparar(page);
    await page.goto('/flito/tarifas/7');
    await expect(panelDe(page, 'Entrega a FLIT')).toBeVisible();
    const ancho = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(ancho).toBe(true);
  });
});
