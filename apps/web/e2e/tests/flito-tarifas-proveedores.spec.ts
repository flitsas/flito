// FLITO — Tarifas › modo Proveedores (Épica #13763, ADR-0041 §6). Backend mockeado, como `flito-tarifas.spec.ts`.
// Spec UX: `docs/ux/flito-tarifas-proveedores.md`.
//
// Decisiones que hacen que los asertos midan algo:
//   · Las escrituras se miden sobre el CUERPO de la petición (`45.000` → `valor: 45000`), no solo por el toast.
//   · «Sin rojo» se mide con el color calculado contra `--flit-danger-ink` resuelto en la misma página.
//   · Responsive: `scrollWidth <= innerWidth` a 375 y 768 px, y que no haya tabla (tarjetas).

import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, FINANCIERA_USER } from '../helpers/auth';

const BASE = '/api/flito/parametrizacion/tarifas-proveedores';
const ANDINA_ID = '11111111-1111-4111-8111-111111111111';
const SEGUROS_ID = '22222222-2222-4222-8222-222222222222';
const ANDINA = 'Mensajería Andina Ejemplo S.A.S.';
const SEGUROS = 'Seguros Rápidos Ejemplo';
const ANA = { id: 10, nombre: 'Ana Ejemplo' };
const LUIS = { id: 11, nombre: 'Luis Ejemplo' };

const LISTA = [
  { id: SEGUROS_ID, nombre: SEGUROS, servicios: ['soat'], conceptos: 2, faltan: 2 },
  { id: ANDINA_ID, nombre: ANDINA, servicios: ['logistica', 'soat'], conceptos: 3, faltan: 1 },
];

const vig = (id: string, concepto: string, servicio: string, valor: number, over: Record<string, unknown> = {}) => ({
  id, proveedorId: ANDINA_ID, servicio, concepto, valor,
  vigenteDesde: '2026-11-03T15:00:00.000Z', vigenteHasta: null, fijadoPor: ANA, fijadoEn: '2026-11-03T15:00:00.000Z',
  cerradoPor: null, cerradoEn: null, servicioAsignado: true, ...over,
});

const VISTA = {
  proveedor: { id: ANDINA_ID, nombre: ANDINA, activo: true, eliminado: false },
  filas: [
    { servicio: 'logistica', concepto: 'logistica', vigencia: vig('v-log', 'logistica', 'logistica', 45000) },
    { servicio: 'soat', concepto: 'soat_con_tramite', vigencia: vig('v-con', 'soat_con_tramite', 'soat', 0, { fijadoPor: LUIS }) },
    { servicio: 'soat', concepto: 'soat_sin_tramite', vigencia: null },
  ],
  capacidades: { editar: true, verHistorial: true },
};

const json = (cuerpo: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(cuerpo) });

interface Opciones {
  lista?: unknown[] | 'falla';
  vista?: unknown;
  historial?: unknown[];
  post?: (cuerpo: unknown) => { status: number; body: unknown };
  patch?: (cuerpo: unknown) => { status: number; body: unknown };
}

/** Un solo manejador para todo el módulo: registra cada escritura con su cuerpo. */
async function mockProveedores(page: Page, o: Opciones = {}) {
  const escrituras: Array<{ metodo: string; path: string; cuerpo: unknown }> = [];
  await page.route((url) => url.pathname.startsWith(BASE), async (route: Route) => {
    const req = route.request();
    const { pathname } = new URL(req.url());
    const metodo = req.method();
    if (metodo === 'GET' && pathname === BASE) {
      return o.lista === 'falla' ? route.fulfill(json({ error: 'boom interno' }, 500)) : route.fulfill(json(o.lista ?? LISTA));
    }
    if (metodo === 'GET' && pathname.endsWith('/historial')) return route.fulfill(json(o.historial ?? []));
    if (metodo === 'GET') return route.fulfill(json(o.vista ?? VISTA));
    const cuerpo = req.postDataJSON();
    escrituras.push({ metodo, path: pathname, cuerpo });
    const r = metodo === 'POST'
      ? (o.post ?? (() => ({ status: 201, body: vig('v-nueva', 'soat_sin_tramite', 'soat', 45000) })))(cuerpo)
      : (o.patch ?? (() => ({ status: 200, body: { vigencia: vig('v-log', 'logistica', 'logistica', 45000), accion: 'cerrada', valorAnterior: 45000, valorNuevo: null } })))(cuerpo);
    return route.fulfill(json(r.body, r.status));
  });
  return escrituras;
}

const filaDe = (page: Page, nombre: string) =>
  page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: new RegExp(`^${nombre}`) }) });

async function sinScrollHorizontal(page: Page) {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(r.sw).toBeLessThanOrEqual(r.iw);
}

test.describe('FLITO — Tarifas › Proveedores · escritorio', () => {
  test.use({ viewport: { width: 1366, height: 900 } });

  test('el selector lleva de Clientes a Proveedores, cambia el subtítulo y no preselecciona', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await page.route(/\/api\/clients(\?|$)/, (r) => r.fulfill(json([])));
    await page.route(/\/api\/flito\/parametrizacion\/tarifas$/, (r) => r.fulfill(json([])));
    await mockProveedores(page);

    await page.goto('/flito/tarifas');
    await expect(page.getByText('Lo que FLITO le cobra a cada cliente por el trámite digital y la logística, desde ahora.')).toBeVisible();
    await page.getByRole('button', { name: 'Proveedores', exact: true }).click();

    await expect(page).toHaveURL(/\/flito\/tarifas\/proveedores$/);
    await expect(page.getByText('Lo que cada proveedor le cobra a FLITO por su servicio, desde ahora.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Proveedores (2)' })).toBeVisible();
    await expect(page.getByText('Elige un proveedor de la lista para ver y fijar sus valores.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Proveedores', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });

  test('lleno: grupos LOGÍSTICA y SOAT, «Sin configurar», y la URL solo lleva el uuid', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockProveedores(page);
    await page.goto('/flito/tarifas/proveedores');
    await page.getByRole('list', { name: 'Proveedores' }).getByRole('button', { name: ANDINA }).click();

    await expect(page).toHaveURL(new RegExp(`/flito/tarifas/proveedores/${ANDINA_ID}$`));
    const tabla = page.getByRole('region', { name: `Valores de ${ANDINA}` }).getByRole('table');
    await expect(tabla).toBeVisible();
    await expect(tabla.getByRole('heading', { name: 'Logística', level: 3 })).toBeVisible();
    await expect(tabla.getByRole('heading', { name: 'SOAT', level: 3 })).toBeVisible();
    await expect(filaDe(page, 'Logística')).toContainText('$45.000');
    await expect(filaDe(page, 'Logística')).toContainText('Ana Ejemplo');
    await expect(filaDe(page, 'SOAT sin trámite')).toContainText('Sin configurar');
    await expect(page.getByText('Lo que este proveedor le cobra a FLITO. Valores en pesos, sin IVA.')).toBeVisible();
  });

  test('fijar valor acepta «45.000» y envía 45000; el toast dice «Valor guardado.»', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    const escrituras = await mockProveedores(page);
    await page.goto(`/flito/tarifas/proveedores/${ANDINA_ID}`);

    await page.getByRole('button', { name: `Fijar valor · SOAT sin trámite de ${ANDINA}` }).click();
    await page.getByLabel(`Valor de SOAT sin trámite de ${ANDINA}`).fill('45.000');
    await page.getByRole('button', { name: `Guardar · SOAT sin trámite de ${ANDINA}` }).click();

    await expect(page.getByText('Valor guardado.')).toBeVisible();
    expect(escrituras).toEqual([{ metodo: 'POST', path: `${BASE}/${ANDINA_ID}/vigencias`, cuerpo: { concepto: 'soat_sin_tramite', valor: 45000 } }]);
  });

  test('valor inválido: ⚠ + mensaje, Guardar deshabilitado y ninguna petición', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    const escrituras = await mockProveedores(page);
    await page.goto(`/flito/tarifas/proveedores/${ANDINA_ID}`);

    await page.getByRole('button', { name: `Fijar valor · SOAT sin trámite de ${ANDINA}` }).click();
    const campo = page.getByLabel(`Valor de SOAT sin trámite de ${ANDINA}`);
    await campo.fill('-500');
    await campo.blur();
    await expect(page.getByRole('alert').filter({ hasText: 'El valor debe ser mayor o igual a cero.' })).toBeVisible();
    await expect(campo).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('button', { name: `Guardar · SOAT sin trámite de ${ANDINA}` })).toBeDisabled();
    expect(escrituras).toEqual([]);
  });

  test('$0 pide confirmación y Cancelar no escribe nada', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    const escrituras = await mockProveedores(page);
    await page.goto(`/flito/tarifas/proveedores/${ANDINA_ID}`);

    await page.getByRole('button', { name: `Fijar valor · SOAT sin trámite de ${ANDINA}` }).click();
    await page.getByLabel(`Valor de SOAT sin trámite de ${ANDINA}`).fill('0');
    await page.getByRole('button', { name: `Guardar · SOAT sin trámite de ${ANDINA}` }).click();
    const modal = page.getByRole('dialog', { name: 'Cobrar $0 por SOAT sin trámite' });
    await expect(modal).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Guardar $0' })).toBeVisible();
    await modal.getByRole('button', { name: 'Cancelar' }).click();
    await expect(modal).toBeHidden();
    expect(escrituras).toEqual([]);
  });

  test('dejar de cobrar: botón neutro (sin rojo), modal con primaria del kit y PATCH { cerrar: true }', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    const escrituras = await mockProveedores(page);
    await page.goto(`/flito/tarifas/proveedores/${ANDINA_ID}`);

    const boton = page.getByRole('button', { name: `Dejar de cobrar · Logística de ${ANDINA}` });
    const colores = await boton.evaluate((el) => {
      const sonda = document.createElement('span');
      sonda.style.color = 'var(--flit-danger-ink)';
      document.body.appendChild(sonda);
      const rojo = getComputedStyle(sonda).color;
      sonda.remove();
      return { rojo, boton: getComputedStyle(el).color };
    });
    expect(colores.boton).not.toBe(colores.rojo);

    await boton.click();
    const modal = page.getByRole('dialog', { name: 'Dejar de cobrar Logística' });
    await expect(modal).toContainText('queda sin valor desde ahora');
    await modal.getByRole('button', { name: 'Dejar de cobrar' }).click();
    await expect(page.getByText('Valor quitado. Logística queda sin configurar.')).toBeVisible();
    expect(escrituras).toEqual([{ metodo: 'PATCH', path: `${BASE}/vigencias/v-log`, cuerpo: { cerrar: true } }]);
  });

  test('409 de otro usuario: aviso en página (no toast) y «Recargar» lo quita', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockProveedores(page, {
      patch: () => ({ status: 409, body: { error: 'interno', code: 'TARIFA_PROVEEDOR_CAMBIADA_POR_OTRO' } }),
    });
    await page.goto(`/flito/tarifas/proveedores/${ANDINA_ID}`);

    await page.getByRole('button', { name: `Cambiar · Logística de ${ANDINA}` }).click();
    await page.getByLabel(`Valor de Logística de ${ANDINA}`).fill('50000');
    await page.getByRole('button', { name: `Guardar · Logística de ${ANDINA}` }).click();

    const aviso = page.getByRole('alert').filter({ hasText: 'Otro usuario cambió este valor. Recarga para ver el vigente.' });
    await expect(aviso).toBeVisible();
    await expect(page.getByText('interno')).toHaveCount(0);
    await aviso.getByRole('button', { name: 'Recargar' }).click();
    await expect(aviso).toBeHidden();
  });

  test('proveedor inactivo: aviso neutro y ningún botón de escritura', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockProveedores(page, {
      vista: { ...VISTA, proveedor: { ...VISTA.proveedor, activo: false }, capacidades: { editar: false, verHistorial: true } },
    });
    await page.goto(`/flito/tarifas/proveedores/${ANDINA_ID}`);

    await expect(page.getByRole('status').filter({ hasText: 'Este proveedor está inactivo.' })).toBeVisible();
    await expect(filaDe(page, 'Logística')).toContainText('$45.000');
    await expect(page.getByRole('button', { name: /^(Cambiar|Fijar valor|Dejar de cobrar) ·/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: `Historial · Logística de ${ANDINA}` })).toBeVisible();
  });

  test('historial: Vigente, cerrada con «Cerró», y la latente con «Sin servicio asignado»', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockProveedores(page, {
      historial: [
        vig('h1', 'logistica', 'logistica', 45000),
        vig('h2', 'logistica', 'logistica', 40000, { vigenteHasta: '2026-11-03T15:00:00.000Z', cerradoPor: ANA, cerradoEn: '2026-11-03T15:00:00.000Z', fijadoPor: LUIS }),
        vig('h3', 'soat_con_tramite', 'soat', 9000, { servicioAsignado: false }),
      ],
    });
    await page.goto(`/flito/tarifas/proveedores/${ANDINA_ID}`);
    await page.getByRole('button', { name: 'Historial del proveedor' }).click();

    const tabla = page.getByRole('region', { name: `Historial de ${ANDINA}` }).getByRole('table');
    await expect(tabla.getByRole('row').filter({ hasText: '$45.000' })).toContainText('Vigente');
    await expect(tabla.getByRole('row').filter({ hasText: '$40.000' })).toContainText('Ana Ejemplo');
    await expect(tabla.getByRole('row').filter({ hasText: '$9.000' })).toContainText('Sin servicio asignado');
  });

  test('error de la lista: aviso sin el texto crudo y Reintentar; vacío con su copy', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockProveedores(page, { lista: 'falla' });
    await page.goto('/flito/tarifas/proveedores');
    await expect(page.getByRole('alert').filter({ hasText: 'No se pudo cargar la lista de proveedores.' })).toBeVisible();
    await expect(page.getByText('boom interno')).toHaveCount(0);

    // La ruta registrada después gana: el reintento ya encuentra la lista vacía.
    await page.route((url) => url.pathname === BASE, (r) => r.fulfill(json([])));
    await page.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByText('No hay proveedores activos.')).toBeVisible();
  });

  test('proveedor sin servicios: vacío del panel', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockProveedores(page, { vista: { ...VISTA, filas: [] } });
    await page.goto(`/flito/tarifas/proveedores/${ANDINA_ID}`);
    await expect(page.getByText(`${ANDINA} no tiene servicios asignados.`)).toBeVisible();
  });
});

for (const ancho of [375, 768]) {
  test.describe(`FLITO — Tarifas › Proveedores · ${ancho} px`, () => {
    test.use({ viewport: { width: ancho, height: 900 } });

    test('tarjetas sin tabla, edición dentro de la tarjeta y sin scroll horizontal', async ({ page }) => {
      await loginAs(page, FINANCIERA_USER);
      await mockProveedores(page, { historial: [vig('h1', 'logistica', 'logistica', 45000)] });
      await page.goto(`/flito/tarifas/proveedores/${ANDINA_ID}`);

      const grupo = page.getByRole('group', { name: `Valores de ${ANDINA}` });
      await expect(grupo.getByRole('article', { name: 'Logística' })).toContainText('$45.000');
      await expect(page.getByRole('table')).toHaveCount(0);
      await sinScrollHorizontal(page);

      const tarjeta = grupo.getByRole('article', { name: 'SOAT sin trámite' });
      await tarjeta.getByRole('button', { name: `Fijar valor · SOAT sin trámite de ${ANDINA}` }).click();
      await expect(tarjeta.getByLabel('Valor en pesos, sin IVA')).toBeVisible();
      await expect(tarjeta.getByRole('button', { name: `Guardar · SOAT sin trámite de ${ANDINA}` })).toBeVisible();
      await sinScrollHorizontal(page);

      await page.getByRole('button', { name: `Cancelar · SOAT sin trámite de ${ANDINA}` }).click();
      await page.getByRole('button', { name: 'Historial del proveedor' }).click();
      await expect(page.getByRole('list', { name: `Historial de ${ANDINA}` })).toBeVisible();
      await sinScrollHorizontal(page);
    });
  });
}
