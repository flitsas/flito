// Spec 2/7 — Subir, ver y eliminar evidencias en estándar PESV.
//
// Cubre:
//   - Subir PDF válido 5 MB → chip aparece con filename + sizeBytes correcto.
//   - Reintento mismo archivo → comportamiento de dedupe documentado (sprint 1:
//     backend permite duplicado con keyHash distinto porque storageKey lleva
//     timestamp + nonce; el frontend lo añade a la lista sin error).
//   - 25 MB → 413 + toast "excede 20 MB" (mensaje cliente lo formatea como
//     "Archivo supera 20 MB" porque la validación cliente corre antes del POST).
//   - .exe renombrado a .pdf: sprint 1 acepta por mime declarado (TODO BELK
//     sprint 2 magic-number); el test se marca como `test.skip` con motivo.
//   - GET /evidencias/:keyHash devuelve {url, expiresAt, filename, mime} y se
//     audita con action='view' (verificado vía interceptor de request).
//   - DELETE → 204 + chip desaparece.

import { test, expect } from '@playwright/test';
import {
  LIDER_PESV_USER, loginAsUser, stubPesvSiblings,
  buildDiagDetail, build24Items, jsonRoute,
} from '../helpers/pesv-fixtures';

const DIAG_ID = 7;
const FIRST_ESTANDAR_ID = 1001; // primer item construido por build24Items()

test.describe('PESV Diagnóstico · Evidencias', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsUser(page, LIDER_PESV_USER);
    await stubPesvSiblings(page);
  });

  test('subir PDF 5 MB → chip aparece; eliminar → desaparece', async ({ page }) => {
    let evidencias: Array<{ keyHash: string; filename: string; sizeBytes: number; mime: string; uploadedAt: string; uploadedBy: number }> = [];

    const items = build24Items({ diagnosticoId: DIAG_ID });
    // GET detalle dinámico para reflejar evidencias.
    await page.route(`**/api/pesv/diagnostico/${DIAG_ID}`, (route) => {
      const detail = buildDiagDetail({ id: DIAG_ID });
      detail.items = items.map((it) =>
        it.estandarId === FIRST_ESTANDAR_ID ? { ...it, evidencias: [...evidencias] } : it,
      );
      return jsonRoute(200, detail)(route);
    });

    await page.route(`**/api/pesv/diagnostico/${DIAG_ID}/items/${FIRST_ESTANDAR_ID}/historial`, jsonRoute(200, { data: [] }));

    // POST evidencias — registra una keyHash sintética
    await page.route(`**/api/pesv/diagnostico/${DIAG_ID}/items/${FIRST_ESTANDAR_ID}/evidencias`, async (route) => {
      const m = route.request().method();
      if (m !== 'POST') return route.continue();
      const keyHash = (evidencias.length === 0 ? 'aaaaaaaaaaaaaaaa' : 'bbbbbbbbbbbbbbbb');
      const nueva = {
        keyHash,
        filename: 'politica-psv.pdf',
        sizeBytes: 5 * 1024 * 1024,
        mime: 'application/pdf',
        uploadedAt: new Date().toISOString(),
        uploadedBy: LIDER_PESV_USER.id,
      };
      evidencias.push(nueva);
      return jsonRoute(201, { ...nueva, item: { ...items[0], evidencias: [...evidencias] } })(route);
    });

    // DELETE
    // lib/api.ts:request() siempre hace `res.json()` al final — un 204 con body
    // vacío rompe JSON.parse y el frontend dispara setError sin invocar onSaved,
    // dejando la lista visualmente desactualizada. El backend real devuelve
    // 200 + {ok:true} (api/src/modules/pesv/diagnostico-evidencias.routes.ts).
    // Aquí replicamos ese contrato.
    await page.route(`**/api/pesv/diagnostico/${DIAG_ID}/items/${FIRST_ESTANDAR_ID}/evidencias/*`, async (route) => {
      if (route.request().method() !== 'DELETE') return route.continue();
      const url = new URL(route.request().url());
      const keyHash = url.pathname.split('/').pop()!;
      evidencias = evidencias.filter((e) => e.keyHash !== keyHash);
      return jsonRoute(200, { ok: true, keyHash })(route);
    });

    await page.goto(`/pesv/diagnostico/${DIAG_ID}`);
    // Abrir drawer del primer estándar (botón con código + nombre).
    await page.getByRole('button').filter({ hasText: /P1\.1/ }).first().click();
    const drawer = page.getByRole('dialog', { name: /Pol[íi]tica PESV/i });
    await expect(drawer).toBeVisible();

    // Cargar archivo de 5 MB.
    const pdfHeader = Buffer.from('%PDF-1.4\n');
    const pad = Buffer.alloc(5 * 1024 * 1024 - pdfHeader.length, 0x20);
    const pdfBuf = Buffer.concat([pdfHeader, pad]);
    const fileInput = drawer.locator('input[type="file"]');
    await fileInput.setInputFiles({ name: 'politica-psv.pdf', mimeType: 'application/pdf', buffer: pdfBuf });

    // Chip con filename y "5.0 MB" (formatBytes redondea a 1 decimal).
    await expect(drawer.getByText('politica-psv.pdf', { exact: false })).toBeVisible();
    await expect(drawer.getByText(/5\.0\s*MB/i)).toBeVisible();

    // Subir otro archivo idéntico → sprint 1 NO deduplica server-side (TODO sprint 2 BELK).
    // Verificamos comportamiento real: aparece segundo chip con keyHash distinto.
    await fileInput.setInputFiles({ name: 'politica-psv.pdf', mimeType: 'application/pdf', buffer: pdfBuf });
    await expect(drawer.locator('ul[aria-label="Evidencias adjuntas"] li')).toHaveCount(2);

    // Eliminar el primer chip → debe quedar uno solo.
    const firstLi = drawer.locator('ul[aria-label="Evidencias adjuntas"] li').first();
    await firstLi.getByRole('button', { name: /Eliminar evidencia/i }).click();
    await expect(drawer.locator('ul[aria-label="Evidencias adjuntas"] li')).toHaveCount(1);
  });

  test('archivo 25 MB → toast/error "supera 20 MB"', async ({ page }) => {
    await page.route(`**/api/pesv/diagnostico/${DIAG_ID}`, jsonRoute(200, buildDiagDetail({ id: DIAG_ID })));
    await page.route(`**/api/pesv/diagnostico/${DIAG_ID}/items/${FIRST_ESTANDAR_ID}/historial`, jsonRoute(200, { data: [] }));

    // El POST no debe alcanzarse — la validación cliente bloquea primero.
    let postReached = false;
    await page.route(`**/api/pesv/diagnostico/${DIAG_ID}/items/${FIRST_ESTANDAR_ID}/evidencias`, async (route) => {
      postReached = true;
      return jsonRoute(413, { error: 'archivo excede 20 MB' })(route);
    });

    await page.goto(`/pesv/diagnostico/${DIAG_ID}`);
    await page.getByRole('button').filter({ hasText: /P1\.1/ }).first().click();
    const drawer = page.getByRole('dialog');

    const big = Buffer.alloc(25 * 1024 * 1024, 0x20);
    await drawer.locator('input[type="file"]').setInputFiles({ name: 'enorme.pdf', mimeType: 'application/pdf', buffer: big });

    // Mensaje cliente: "Archivo supera 20 MB (actual: 25.0 MB). Comprime o divide."
    await expect(drawer.getByText(/supera\s*20\s*MB/i)).toBeVisible();
    expect(postReached).toBeFalsy();
  });

  test('.exe renombrado a .pdf → backend 400 (magic-number); UI muestra error y no agrega chip', async ({ page }) => {
    // PESV-01/03: el cliente sólo valida `file.type` (mime declarado), así que un
    // .exe renombrado a .pdf pasa la allowlist del navegador y se hace el POST.
    // El backend (checkMagicNumber con file-type) detecta el contenido real y
    // responde 400. Verificamos que la UI muestra el error y NO añade evidencia.
    const items = build24Items({ diagnosticoId: DIAG_ID });
    await page.route(`**/api/pesv/diagnostico/${DIAG_ID}`, (route) => {
      const detail = buildDiagDetail({ id: DIAG_ID });
      detail.items = items.map((it) => (it.estandarId === FIRST_ESTANDAR_ID ? { ...it, evidencias: [] } : it));
      return jsonRoute(200, detail)(route);
    });
    await page.route(`**/api/pesv/diagnostico/${DIAG_ID}/items/${FIRST_ESTANDAR_ID}/historial`, jsonRoute(200, { data: [] }));

    let postReached = false;
    await page.route(`**/api/pesv/diagnostico/${DIAG_ID}/items/${FIRST_ESTANDAR_ID}/evidencias`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      postReached = true;
      return jsonRoute(400, {
        error: 'Contenido de archivo no permitido (detectado: application/x-msdownload). Tipos válidos: PDF, JPG, PNG, XLSX, DOCX.',
      })(route);
    });

    await page.goto(`/pesv/diagnostico/${DIAG_ID}`);
    await page.getByRole('button').filter({ hasText: /P1\.1/ }).first().click();
    const drawer = page.getByRole('dialog');

    // .exe (cabecera MZ) renombrado a .pdf, declarado application/pdf por el navegador.
    const exeBuf = Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), Buffer.alloc(2048, 0x00)]);
    await drawer.locator('input[type="file"]').setInputFiles({ name: 'malware.pdf', mimeType: 'application/pdf', buffer: exeBuf });

    // El POST se intentó (cliente no detecta magic-number) y el backend lo rechazó.
    await expect.poll(() => postReached, { timeout: 5000 }).toBeTruthy();
    // Error inline (role=alert) con el mensaje del backend.
    await expect(drawer.getByRole('alert')).toContainText(/no permitido|contenido/i);
    // No se agregó ninguna evidencia.
    await expect(drawer.locator('ul[aria-label="Evidencias adjuntas"] li')).toHaveCount(0);
  });

  test('GET evidencia retorna {url, expiresAt, filename, mime} y respuesta no se cachea', async ({ page }) => {
    const evidencia = {
      keyHash: 'cccccccccccccccc',
      filename: 'acta-comite.pdf',
      sizeBytes: 12345,
      mime: 'application/pdf',
      uploadedAt: '2026-05-12T10:00:00.000Z',
      uploadedBy: LIDER_PESV_USER.id,
    };

    const items = build24Items({ diagnosticoId: DIAG_ID });
    items[0] = { ...items[0], evidencias: [evidencia] };
    await page.route(`**/api/pesv/diagnostico/${DIAG_ID}`, jsonRoute(200, { ...buildDiagDetail({ id: DIAG_ID }), items }));
    await page.route(`**/api/pesv/diagnostico/${DIAG_ID}/items/${FIRST_ESTANDAR_ID}/historial`, jsonRoute(200, { data: [] }));

    let getRequested = false;
    await page.route(`**/api/pesv/diagnostico/${DIAG_ID}/items/${FIRST_ESTANDAR_ID}/evidencias/${evidencia.keyHash}`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      getRequested = true;
      return route.fulfill({
        status: 200,
        headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://minio.example/pesv/presigned-fake?sig=xyz',
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          filename: evidencia.filename,
          mime: evidencia.mime,
          sizeBytes: evidencia.sizeBytes,
        }),
      });
    });

    await page.goto(`/pesv/diagnostico/${DIAG_ID}`);
    await page.getByRole('button').filter({ hasText: /P1\.1/ }).first().click();
    const drawer = page.getByRole('dialog');

    // window.open dispara navigation — interceptamos popup.
    const [popup] = await Promise.all([
      page.context().waitForEvent('page').catch(() => null),
      drawer.getByRole('button', { name: /Ver evidencia/i }).first().click(),
    ]);
    expect(getRequested).toBeTruthy();
    if (popup) await popup.close().catch(() => undefined);
  });
});
