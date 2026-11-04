// HU #13988 — pre-vuelo automático del paso 2: nunca se queda en «Consultando…», un error ofrece
// reintento y RUNT/SIMIT (tienen coste) se consultan una sola vez por trámite y arranque.

import type { Page, Request, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER } from '../helpers/auth';

const CONSULTANDO = /Consultando RUNT, SIMIT e impuesto/;
const json = (r: Route, body: unknown, status = 200) =>
  r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const snap = (label: string, overall = 'green') =>
  ({ overall, checks: [{ key: 'soat', label, status: 'ok', message: 'SOAT' }] });

function tramite(id: number, paso: number) {
  return {
    id, vin: `VIN${id}`, placa: 'ABC123', estado: 'radicado', paso,
    modalidadEntrada: 'traspaso', tipologiaCodigo: 'traspaso_standard', numeroRadicado: `TD-2026-000${id}`,
    vehiculo: { marca: 'Mazda', linea: 'CX-30', vin: `VIN${id}` }, comprador: null,
  };
}

type OpcionesMock = {
  // Respuesta del POST de pre-vuelo; se le pasa el número de llamada (1, 2…) y la petición.
  post?: (n: number, r: Route, req: Request) => Promise<void> | void;
  // Lo que devuelve GET /tramites/:id/preflight.
  guardado?: unknown;
  organismoTransito?: string;
};

async function mockBackend(page: Page, opts: OpcionesMock = {}) {
  const contador = { post: 0, patch: 0 };
  await page.route('**/api/runt/consulta-vehiculo', (r) => json(r, {
    ok: true,
    data: { vehiculo: { marca: 'Mazda', linea: 'CX-30', modelo: '2024', placa: 'ABC123', vin: 'VIN88', ...(opts.organismoTransito ? { organismoTransito: opts.organismoTransito } : {}) } },
  }));
  await page.route('**/api/runt/consulta-persona', (r) => json(r, { ok: true, persona: { nombres: 'Carlos', apellidos: 'Vendedor' } }));
  await page.route('**/api/tramites/preflight', async (r) => {
    contador.post += 1;
    if (opts.post) return opts.post(contador.post, r, r.request());
    return json(r, snap('SOAT vigente'));
  });
  await page.route(/\/api\/tramites\/\d+\/preflight$/, (r) => json(r, { preflight: opts.guardado ?? null }));
  await page.route(/\/api\/tramites\/\d+$/, (r) => {
    if (r.request().method() === 'PATCH') { contador.patch += 1; return json(r, {}); }
    const id = Number(new URL(r.request().url()).pathname.split('/').pop());
    return json(r, tramite(id, 2));
  });
  await page.route('**/api/tramites', (r) => (r.request().method() === 'POST' ? json(r, tramite(88, 1), 201) : json(r, [])));
  return contador;
}

async function radicar(page: Page) {
  await page.goto('/tramite/traspaso');
  await page.getByLabel('Placa').fill('ABC123');
  await page.getByLabel('Documento propietario').fill('111');
  await page.getByRole('button', { name: /Consultar RUNT/i }).click();
  await expect(page.getByText(/Mazda CX-30/)).toBeVisible();
  await page.getByRole('button', { name: /Radicar y continuar/i }).click();
  await expect(page.getByText('2. Validación legal (RUNT/SIMIT)')).toBeVisible();
}

// El SPA corre en <StrictMode> (efectos dobles en dev); sin él, cada efecto corre una sola vez.
// Se prueban los dos: quitar la limpieza del efecto no puede depender de uno de ellos.
async function sinStrictMode(page: Page) {
  await page.route('**/src/main.tsx*', async (r) => {
    const res = await r.fetch();
    const original = await res.text();
    if (!original.includes('React.StrictMode')) throw new Error('main.tsx ya no monta React.StrictMode');
    return r.fulfill({ response: res, body: original.replaceAll('React.StrictMode', 'React.Fragment') });
  });
}

for (const modo of ['con StrictMode', 'sin StrictMode'] as const) {
  test.describe(`Traspaso · pre-vuelo automático (${modo})`, () => {
    test.beforeEach(async ({ page }) => {
      if (modo === 'sin StrictMode') await sinStrictMode(page);
      await loginAs(page, ADMIN_USER);
    });

    test('trámite recién radicado llega al resultado con un solo POST', async ({ page }) => {
      const c = await mockBackend(page, {
        post: async (_n, r) => { await new Promise((ok) => setTimeout(ok, 400)); return json(r, snap('SOAT vigente')); },
      });
      await radicar(page);
      await expect(page.getByText('SOAT vigente')).toBeVisible();
      await expect(page.getByText(CONSULTANDO)).toHaveCount(0);
      expect(c.post).toBe(1);
    });

    test('un error muestra el mensaje y el reintento funciona', async ({ page }) => {
      const c = await mockBackend(page, {
        post: (n, r) => (n === 1 ? json(r, { error: 'RUNT no responde' }, 500) : json(r, snap('SOAT vigente'))),
      });
      await radicar(page);
      await expect(page.getByText('No se pudo completar el pre-vuelo')).toBeVisible();
      await expect(page.getByText(CONSULTANDO)).toHaveCount(0);
      expect(c.post).toBe(1);

      await page.getByRole('button', { name: 'Reintentar pre-vuelo' }).click();
      await expect(page.getByText('SOAT vigente')).toBeVisible();
      await expect(page.getByText('No se pudo completar el pre-vuelo')).toHaveCount(0);
      expect(c.post).toBe(2);
    });

    test('un reintento fallido consulta una sola vez, no dos', async ({ page }) => {
      const c = await mockBackend(page, { post: (_n, r) => json(r, { error: 'RUNT no responde' }, 500) });
      await radicar(page);
      const reintentar = page.getByRole('button', { name: 'Reintentar pre-vuelo' });
      await expect(reintentar).toBeVisible();
      await reintentar.click();
      await expect.poll(() => c.post).toBe(2);
      await expect(reintentar).toBeEnabled();
      await page.waitForTimeout(400); // deja pasar un posible arranque automático de más
      expect(c.post).toBe(2);
      await expect(page.getByText(CONSULTANDO)).toHaveCount(0);
    });

    test('otra dependencia que cambia durante la petición no la cancela ni la duplica', async ({ page }) => {
      // El organismo de la matrícula provoca un PATCH y un setVehiculo con la petición en vuelo.
      const c = await mockBackend(page, {
        organismoTransito: 'SECRETARIA DE MOVILIDAD DE MEDELLIN',
        post: async (_n, r) => { await new Promise((ok) => setTimeout(ok, 600)); return json(r, snap('SOAT vigente')); },
      });
      await radicar(page);
      await expect(page.getByText('SOAT vigente')).toBeVisible();
      await expect(page.getByText(CONSULTANDO)).toHaveCount(0);
      expect(c.patch).toBeGreaterThan(0);
      expect(c.post).toBe(1);
    });

    test('con pre-vuelo guardado no consulta: lo muestra', async ({ page }) => {
      const c = await mockBackend(page, { guardado: snap('SOAT guardado') });
      await radicar(page);
      await expect(page.getByText('SOAT guardado')).toBeVisible();
      expect(c.post).toBe(0);
    });

    test('cambiar de trámite no aplica el resultado del anterior', async ({ page }) => {
      let soltar88: () => void = () => {};
      const c = await mockBackend(page, {
        post: async (_n, r, req) => {
          const { tramiteId } = req.postDataJSON() as { tramiteId: number };
          if (tramiteId === 88) await new Promise<void>((ok) => { soltar88 = ok; });
          return json(r, snap(`SOAT del ${tramiteId}`));
        },
      });
      await page.goto('/tramite/traspaso?id=88');
      await expect.poll(() => c.post).toBe(1);
      await page.evaluate(() => { history.pushState(null, '', '/tramite/traspaso?id=89'); dispatchEvent(new PopStateEvent('popstate')); });
      await expect(page.getByText('TD-2026-00089').first()).toBeVisible();
      // Hay que dejar al 89 en el paso 2 para que arranque su pre-vuelo; el retomar puede saltarlo.
      await page.getByRole('button', { name: /Validación legal/ }).first().click();
      await expect(page.getByText('SOAT del 89')).toBeVisible();
      soltar88();
      await page.waitForTimeout(300);
      await expect(page.getByText('SOAT del 89')).toBeVisible();
      await expect(page.getByText('SOAT del 88')).toHaveCount(0);
      expect(c.post).toBe(2);
    });
  });
}
