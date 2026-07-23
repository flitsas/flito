// Spec 5/7 — Vista auditor (compliance) read-only.
//
// Cubre:
//   - Login compliance → ir a /pesv/diagnostico/1 → redirect a /auditoria.
//   - Banner alto contraste "Modo auditoría · solo lectura".
//   - Ausencia total de botones editar/guardar/eliminar.
//   - GET evidencia desde compliance dispara request al backend que (en prod)
//     registra audit_logs.action='view' + pii_access_log. Validamos el hit.
//   - "Exportar este estándar (PDF+ZIP)" → window.location.href apunta a
//     /api/pesv/export/diagnostico/:id/estandar/:codigo.
//   - "Exportar expediente completo (ZIP)" → /api/pesv/export/diagnostico/:id.

import { test, expect } from '../helpers/fixtures';
import {
  COMPLIANCE_USER, loginAsUser, stubPesvSiblings,
  buildDiagDetail, build24Items, jsonRoute,
} from '../helpers/pesv-fixtures';

const DIAG_ID = 1;
const FIRST_ESTANDAR_ID = 1001;

test.describe('PESV Diagnóstico · Vista auditor (compliance)', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsUser(page, COMPLIANCE_USER);
    await stubPesvSiblings(page);
  });

  test('compliance redirigido a /auditoria; banner visible; sin botones de edición', async ({ page }) => {
    // Detail "cerrado" para que NO caiga en empty state "borrador".
    const items = build24Items({ diagnosticoId: DIAG_ID });
    items[0] = {
      ...items[0],
      nivelRubrica: 'implementado',
      scorePct: '75.00',
      evidencias: [{
        keyHash: 'deadbeefdeadbeef',
        filename: 'politica-firmada.pdf',
        sizeBytes: 100_000,
        mime: 'application/pdf',
        uploadedAt: '2026-05-12T10:00:00.000Z',
        uploadedBy: 1001,
      }],
    };
    const cerrado = {
      ...buildDiagDetail({ id: DIAG_ID, estado: 'cerrado', scoreGlobal: '75.00' }),
      items,
    };

    // Tanto detalle normal como `?view=auditoria` responden cerrado.
    await page.route(`**/api/pesv/diagnostico/${DIAG_ID}**`, (route) => {
      const url = route.request().url();
      if (!url.includes('/items/') && !url.includes('/historial') && !url.includes('/preflight')) {
        return jsonRoute(200, cerrado)(route);
      }
      return route.continue();
    });

    await page.goto(`/pesv/diagnostico/${DIAG_ID}`);
    await expect(page).toHaveURL(new RegExp(`/pesv/diagnostico/${DIAG_ID}/auditoria$`));

    // Banner alto contraste.
    await expect(page.getByText(/Modo auditor[íi]a\s*·\s*solo lectura/i)).toBeVisible();

    // Ausencia total de botones edición → no debe existir "Guardar", "Eliminar evidencia",
    // "Guardar cambios", "Cerrar diagnóstico".
    await expect(page.getByRole('button', { name: /Guardar cambios/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Eliminar evidencia/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Cerrar diagn[óo]stico$/i })).toHaveCount(0);
    // El botón "Volver al editor" solo se renderiza para admin/lider_pesv; compliance NO lo ve.
    await expect(page.getByRole('button', { name: /Volver al editor/i })).toHaveCount(0);
  });

  test('GET evidencia dispara hit al backend (audit + pii_access_log server-side)', async ({ page }) => {
    const evidencia = {
      keyHash: 'aabbccddeeff0011',
      filename: 'matriz-riesgo.pdf',
      sizeBytes: 22222,
      mime: 'application/pdf',
      uploadedAt: '2026-05-12T10:00:00.000Z',
      uploadedBy: 1001,
    };
    const items = build24Items({ diagnosticoId: DIAG_ID });
    items[0] = { ...items[0], nivelRubrica: 'implementado', scorePct: '75.00', evidencias: [evidencia] };
    const cerrado = { ...buildDiagDetail({ id: DIAG_ID, estado: 'cerrado' }), items };
    await page.route(`**/api/pesv/diagnostico/${DIAG_ID}**`, (route) => {
      const url = route.request().url();
      if (url.includes('/evidencias/')) return route.continue();
      return jsonRoute(200, cerrado)(route);
    });

    let getCalled = false;
    await page.route(`**/api/pesv/diagnostico/${DIAG_ID}/items/${FIRST_ESTANDAR_ID}/evidencias/${evidencia.keyHash}`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      getCalled = true;
      return route.fulfill({
        status: 200,
        headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://minio.example/pesv/auditor-fake?sig=zzz',
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          filename: evidencia.filename,
          mime: evidencia.mime,
          sizeBytes: evidencia.sizeBytes,
        }),
      });
    });

    await page.goto(`/pesv/diagnostico/${DIAG_ID}/auditoria`);
    // PDF no entra a lightbox (sólo imágenes); abre nueva pestaña.
    const [popup] = await Promise.all([
      page.context().waitForEvent('page').catch(() => null),
      page.getByText(/matriz-riesgo\.pdf/i).first().click(),
    ]);
    expect(getCalled).toBeTruthy();
    if (popup) await popup.close().catch(() => undefined);
  });

  test('Exportar estándar y expediente → URLs correctas', async ({ page }) => {
    const items = build24Items({ diagnosticoId: DIAG_ID });
    items[0] = { ...items[0], nivelRubrica: 'implementado', scorePct: '75.00' };
    const cerrado = { ...buildDiagDetail({ id: DIAG_ID, estado: 'cerrado' }), items };
    await page.route(`**/api/pesv/diagnostico/${DIAG_ID}**`, jsonRoute(200, cerrado));

    // Interceptamos las descargas de ZIP/PDF: las respondemos con OK pero la
    // verificación importante es la URL solicitada.
    const seen: string[] = [];
    await page.route('**/api/pesv/export/diagnostico/**', async (route) => {
      seen.push(route.request().url());
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename=stub.zip' },
        body: 'PK\x03\x04', // header ZIP mínimo
      });
    });

    await page.goto(`/pesv/diagnostico/${DIAG_ID}/auditoria`);
    await page.getByRole('button', { name: /Exportar este estándar/i }).first().click();
    await page.waitForTimeout(200); // window.location.href es síncrono pero el route async puede tardar
    await page.getByRole('button', { name: /Exportar expediente/i }).first().click();
    await page.waitForTimeout(200);

    expect(seen.some((u) => /\/api\/pesv\/export\/diagnostico\/1\/estandar\/P1\.1$/.test(u))).toBeTruthy();
    expect(seen.some((u) => /\/api\/pesv\/export\/diagnostico\/1$/.test(u))).toBeTruthy();
  });
});
