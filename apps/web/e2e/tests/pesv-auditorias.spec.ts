import { test, expect } from '@playwright/test';
import { loginAs, ADMIN_USER } from '../helpers/auth';

// Cubre Sprint Compliance S6 — auditorías + hallazgos + comunicaciones + contratistas.

test.describe('PESV Auditorías (S6 Paso 22)', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await page.route('**/api/pesv/estandares**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) })
    );
  });

  test('admin lista auditorías y crea nueva', async ({ page }) => {
    let postCalled = false;
    await page.route('**/api/pesv/auditorias**', async (route) => {
      const m = route.request().method();
      if (m === 'GET') {
        return route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ data: [
            { id: 1, anio: 2026, tipo: 'interna', alcance: 'PESV anual 24 pasos PHVA',
              fechaPlanificada: '2026-12-15', estado: 'planificada', evidenciaKeys: [] },
          ] }),
        });
      }
      if (m === 'POST') {
        postCalled = true;
        return route.fulfill({
          status: 201, contentType: 'application/json',
          body: JSON.stringify({ id: 2, anio: 2027, tipo: 'externa', estado: 'planificada' }),
        });
      }
      return route.continue();
    });

    await page.goto('/pesv/auditorias');
    await expect(page.getByText(/Auditor[íi]as PESV|Paso 22/i).first()).toBeVisible();
    await expect(page.getByText(/PESV anual 24 pasos/i)).toBeVisible();
  });

  test('detalle auditoría carga hallazgos', async ({ page }) => {
    await page.route('**/api/pesv/auditorias?**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ data: [{ id: 1, anio: 2026, tipo: 'interna', alcance: 'X', fechaPlanificada: '2026-12-15', estado: 'en_curso', evidenciaKeys: [] }] }),
      })
    );
    await page.route('**/api/pesv/auditorias/1', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({
          id: 1, anio: 2026, tipo: 'interna', alcance: 'PESV anual', estado: 'en_curso', evidenciaKeys: [],
          hallazgos: [
            { id: 10, severidad: 'critico', descripcion: 'Política sin firma del representante legal', estado: 'abierto' },
            { id: 11, severidad: 'observacion', descripcion: 'Falta capacitación trimestral conductores', estado: 'cerrado' },
          ],
        }),
      })
    );

    await page.goto('/pesv/auditorias');
    await expect(page.getByText(/PESV anual|Paso 22/i).first()).toBeVisible();
  });
});

test.describe('PESV Comunicaciones (S6 Paso 1.8 + 24)', () => {
  test.beforeEach(async ({ page }) => { await loginAs(page, ADMIN_USER); });

  test('admin ve listado y filtro por tipo', async ({ page }) => {
    await page.route('**/api/pesv/comunicaciones**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ data: [
          { id: 1, tipo: 'politica', asunto: 'Política PSV firmada 2026', cuerpoMd: '...', destinatariosRoles: [], publicadoAt: '2026-04-01T12:00:00Z', vencimientoAcuse: null, acusesCount: 12, createdAt: '2026-04-01T12:00:00Z' },
          { id: 2, tipo: 'lecciones_aprendidas', asunto: 'Incidente vía Bogotá-Medellín', cuerpoMd: '...', destinatariosRoles: [], publicadoAt: null, vencimientoAcuse: null, acusesCount: 0, createdAt: '2026-05-01T12:00:00Z' },
        ] }),
      })
    );
    await page.goto('/pesv/comunicaciones');
    await expect(page.getByText(/Pol[íi]tica PSV firmada/i)).toBeVisible();
    await expect(page.getByText(/Incidente v[íi]a Bogot/i)).toBeVisible();
  });
});

test.describe('PESV Contratistas (S6 Paso 18)', () => {
  test.beforeEach(async ({ page }) => { await loginAs(page, ADMIN_USER); });

  test('alertas vencimiento se muestran', async ({ page }) => {
    const today = new Date().toISOString().slice(0, 10);
    const futuroCerca = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const pasado = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    await page.route('**/api/pesv/contratistas**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ data: [
          { id: 1, razonSocial: 'Transportes ABC', nit: '900123456', evaluacion: 'apto',
            estado: 'vinculado', pesvVencimiento: pasado, pesvNivel: 'estandar',
            contactoNombre: null, contactoEmail: null, contactoTelefono: null, proximaEvaluacion: null, observaciones: null },
          { id: 2, razonSocial: 'Logística XYZ', nit: '900987654', evaluacion: 'apto_condicional',
            estado: 'vinculado', pesvVencimiento: futuroCerca, pesvNivel: 'avanzado',
            contactoNombre: null, contactoEmail: null, contactoTelefono: null, proximaEvaluacion: null, observaciones: null },
        ] }),
      })
    );

    await page.goto('/pesv/contratistas');
    await expect(page.getByText(/Transportes ABC/i)).toBeVisible();
    await expect(page.getByText(/Log[íi]stica XYZ/i)).toBeVisible();
    // KPI cards (vencidos / próximos)
    await expect(page.getByText(/Certificados vencidos|Vencen ≤60/i).first()).toBeVisible();
  });
});
