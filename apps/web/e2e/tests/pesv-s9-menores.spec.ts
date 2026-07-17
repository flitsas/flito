import { test, expect } from '@playwright/test';
import { loginAs, ADMIN_USER } from '../helpers/auth';

// Cubre Sprint Compliance S9 — RACI + tracker normativo + retención.

test.describe('PESV RACI matriz (S9 Paso 1.5)', () => {
  test.beforeEach(async ({ page }) => { await loginAs(page, ADMIN_USER); });

  test('admin ve matriz pivoteada con celdas R/A/C/I', async ({ page }) => {
    await page.route('**/api/pesv/raci/matriz', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({
          procesos: [
            { codigo: 'S1.5', nombre: 'Definir RACI PESV' },
            { codigo: 'S3.2', nombre: 'Capacitación conductor' },
          ],
          roles: ['admin', 'lider_pesv', 'conductor'],
          celdas: {
            'S1.5': { admin: ['A'], lider_pesv: ['R'], conductor: ['I'] },
            'S3.2': { admin: ['I'], lider_pesv: ['A'], conductor: ['R'] },
          },
        }),
      })
    );

    await page.goto('/pesv/raci');
    await expect(page.getByText(/Matriz RACI|Paso 1\.5/i).first()).toBeVisible();
    await expect(page.getByText(/S1\.5/i).first()).toBeVisible();
    await expect(page.getByText(/Definir RACI PESV/i)).toBeVisible();
    await expect(page.getByText(/Capacitaci[óo]n conductor/i)).toBeVisible();
    // Leyenda con los 4 tipos
    await expect(page.getByText(/Responsible/i).first()).toBeVisible();
    await expect(page.getByText(/Accountable/i).first()).toBeVisible();
  });

  test('matriz vacía → CTA primer proceso', async ({ page }) => {
    await page.route('**/api/pesv/raci/matriz', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ procesos: [], roles: [], celdas: {} }),
      })
    );

    await page.goto('/pesv/raci');
    await expect(page.getByRole('button', { name: /primer proceso|Nuevo proceso/i }).first()).toBeVisible();
  });
});

test.describe('PESV Tracker normativo (S9 Paso 1.7)', () => {
  test.beforeEach(async ({ page }) => { await loginAs(page, ADMIN_USER); });

  test('admin ve seed normativa con próxima revisión', async ({ page }) => {
    const enUnMes = new Date(Date.now() + 25 * 24 * 60 * 60 * 1000).toISOString();

    await page.route('**/api/pesv/normativa**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ data: [
          { id: 1, codigo: 'RES-40595-2022', tipo: 'resolucion', titulo: 'PESV ajuste 24 pasos PHVA',
            emisor: 'MinTransporte', fechaPublicacion: '2022-04-21', vigente: true,
            aplicaA: ['pesv', 'flota'], urlOficial: null, resumenMd: null,
            ultimaRevisionAt: null, proximaRevisionAt: enUnMes, notasMd: null, optimisticV: 1 },
          { id: 2, codigo: 'LEY-1581-2012', tipo: 'ley', titulo: 'Habeas data',
            emisor: 'Congreso', fechaPublicacion: '2012-10-17', vigente: true,
            aplicaA: ['pesv', 'laft'], urlOficial: null, resumenMd: null,
            ultimaRevisionAt: null, proximaRevisionAt: '2027-01-01T00:00:00Z', notasMd: null, optimisticV: 1 },
        ] }),
      })
    );

    await page.goto('/pesv/normativa');
    await expect(page.getByText(/Tracker normativo|Paso 1\.7/i).first()).toBeVisible();
    await expect(page.getByText(/RES-40595-2022/i)).toBeVisible();
    await expect(page.getByText(/LEY-1581-2012/i)).toBeVisible();
    // KPI próximas a revisar (al menos 1 entra dentro de los 30 días)
    await expect(page.getByText(/Pr[óo]ximas a revisar/i)).toBeVisible();
  });
});

test.describe('PESV Retención documental (S9 Paso 19)', () => {
  test.beforeEach(async ({ page }) => { await loginAs(page, ADMIN_USER); });

  test('admin ve políticas seed Ley 594', async ({ page }) => {
    await page.route('**/api/pesv/retencion/politicas**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ data: [
          { id: 1, tipoDocumento: 'incidente_vial', retencionAnios: 10, baseLegal: 'Res 40595 + Ley 594', accion: 'archivar_offline', habilitado: true, notasMd: null, optimisticV: 1 },
          { id: 2, tipoDocumento: 'pii_access_log', retencionAnios: 6, baseLegal: 'Ley 1581 art 17', accion: 'anonimizar', habilitado: true, notasMd: null, optimisticV: 1 },
          { id: 3, tipoDocumento: 'checklist', retencionAnios: 3, baseLegal: 'Res 40595/2022', accion: 'purgar', habilitado: true, notasMd: null, optimisticV: 1 },
        ] }),
      })
    );

    await page.goto('/pesv/retencion');
    await expect(page.getByText(/Retenci[óo]n documental|Paso 19|Ley 594/i).first()).toBeVisible();
    await expect(page.getByText(/incidente_vial/i)).toBeVisible();
    await expect(page.getByText(/pii_access_log/i)).toBeVisible();
    await expect(page.getByText(/anonimizar/i).first()).toBeVisible();
    // Tabs presentes
    await expect(page.getByRole('button', { name: /Pol[íi]ticas/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Bit[áa]cora/i })).toBeVisible();
  });

  test('cambiar a tab Bitácora carga log', async ({ page }) => {
    await page.route('**/api/pesv/retencion/politicas**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) })
    );
    await page.route('**/api/pesv/retencion/log**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ data: [
          { id: 1, politicaId: 1, tipoDocumento: 'audit_log', cantidadAfectada: 0,
            cutoffDate: '2020-05-07', accion: 'archivar_offline',
            ejecutadoAt: '2026-05-07T03:00:00Z', ejecutadoPorCron: true, detalleMd: 'DRY-RUN cron diario count=42' },
        ] }),
      })
    );

    await page.goto('/pesv/retencion');
    await page.getByRole('button', { name: /Bit[áa]cora/i }).click();
    await expect(page.getByText(/audit_log/i)).toBeVisible();
    await expect(page.getByText(/cron/i).first()).toBeVisible();
  });
});
