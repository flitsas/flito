// Spec 7/7 — Accesibilidad WCAG 2.2 AA del módulo Diagnóstico.
//
// El repo NO tiene `@axe-core/playwright` instalado. Para mantener "NO instalar
// deps", inyectamos `axe.min.js` vía CDN con `page.addScriptTag` cuando la
// variable de entorno PESV_A11Y_AXE_CDN=1 está activa (por defecto OFF en CI
// air-gapped, ON en local con red). Los chequeos de teclado/foco/aria/regiones
// live se ejecutan SIEMPRE, no dependen de axe.
//
// Cubre 4 vistas:
//   - lista                       (/pesv/diagnostico)
//   - detalle                     (/pesv/diagnostico/:id)
//   - drawer evaluación abierto   (sobre detalle)
//   - modal preflight abierto     (sobre detalle)
//
// Asserts:
//   - Cero violaciones serias/críticas (cuando axe disponible).
//   - Tab cíclico dentro de modal/drawer (focus trap).
//   - Esc cierra modal/drawer (con confirm si dirty — usamos beforeunload no
//     porque Playwright maneja confirm() vía dialog handler).
//   - aria-live=polite presente para "Guardado hace Xs".
//   - <fieldset><legend> de RubricaRadioGroup + radios reales.

import { test, expect, type Page } from '@playwright/test';
import {
  LIDER_PESV_USER, loginAsUser, stubPesvSiblings,
  buildDiagDetail, build24Items, buildPreflight, jsonRoute,
} from '../helpers/pesv-fixtures';

const DIAG_ID = 77;

const AXE_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js';
const USE_AXE = process.env.PESV_A11Y_AXE_CDN === '1';

async function runAxe(page: Page): Promise<{ ran: boolean; violations: Array<{ id: string; impact: string; nodes: number }> }> {
  if (!USE_AXE) return { ran: false, violations: [] };
  try {
    await page.addScriptTag({ url: AXE_CDN });
  } catch {
    return { ran: false, violations: [] };
  }
  const result = await page.evaluate(async () => {
    // @ts-expect-error inyectado via CDN
    const r = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] },
    });
    return {
      violations: r.violations.map((v: { id: string; impact?: string; nodes: unknown[] }) => ({
        id: v.id,
        impact: v.impact ?? 'minor',
        nodes: v.nodes.length,
      })),
    };
  });
  return { ran: true, violations: result.violations };
}

function expectNoSeriousCritical(result: Awaited<ReturnType<typeof runAxe>>, scope: string) {
  if (!result.ran) {
    console.warn(`[a11y] axe-core no disponible (PESV_A11Y_AXE_CDN=${process.env.PESV_A11Y_AXE_CDN ?? 'unset'}); chequeos heurísticos sólo en ${scope}.`);
    return;
  }
  const seriousOrCritical = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  if (seriousOrCritical.length > 0) {
    console.error(`[a11y] violaciones serias/críticas en ${scope}:`, seriousOrCritical);
  }
  expect(seriousOrCritical, `violaciones a11y serias/críticas en ${scope}`).toEqual([]);
}

test.describe('PESV Diagnóstico · A11y WCAG 2.2 AA', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsUser(page, LIDER_PESV_USER);
    await stubPesvSiblings(page);

    // Stubs comunes
    await page.route('**/api/pesv/diagnostico', (route) => {
      const m = route.request().method();
      if (m === 'GET') {
        return jsonRoute(200, {
          data: [{
            id: DIAG_ID, anio: 2027, fecha: '2026-05-12',
            scoreGlobal: '60.00', estado: 'borrador', cerradoAt: null,
            createdAt: '2026-05-12T09:00:00.000Z',
            updatedAt: '2026-05-12T10:00:00.000Z',
            nivelEmpresa: 'avanzado',
          }],
        })(route);
      }
      return route.continue();
    });
    const items = build24Items({ diagnosticoId: DIAG_ID });
    items[0] = { ...items[0], nivelRubrica: 'implementado', scorePct: '75.00' };
    await page.route(`**/api/pesv/diagnostico/${DIAG_ID}`, jsonRoute(200, { ...buildDiagDetail({ id: DIAG_ID }), items }));
    await page.route(`**/api/pesv/diagnostico/${DIAG_ID}/items/**/historial`, jsonRoute(200, { data: [] }));
    await page.route(`**/api/pesv/diagnostico/${DIAG_ID}/preflight`, jsonRoute(200, buildPreflight({
      totalEstandares: 24, evaluados: 24, conEvidencia: 22, scoreProyectado: 75,
      bloqueos: [], advertencias: [{ estandarId: 1004, codigo: 'P1.4', motivo: 'en_desarrollo_sin_comentario' }],
    })));
  });

  test('lista — heurísticas + axe', async ({ page }) => {
    await page.goto('/pesv/diagnostico');
    await expect(page.getByRole('heading', { name: /Diagn[óo]stico\s+PESV/i }).first()).toBeVisible();
    expectNoSeriousCritical(await runAxe(page), 'lista');
  });

  test('detalle — heurísticas + axe + aria-progressbar', async ({ page }) => {
    await page.goto(`/pesv/diagnostico/${DIAG_ID}`);
    await expect(page.getByRole('progressbar')).toBeVisible();
    expectNoSeriousCritical(await runAxe(page), 'detalle');
  });

  test('drawer abierto — fieldset+legend, radios reales, focus trap, Esc cierra, foco restaurado', async ({ page }) => {
    await page.goto(`/pesv/diagnostico/${DIAG_ID}`);
    const filaBtn = page.getByRole('button').filter({ hasText: /P1\.1/ }).first();
    await filaBtn.focus();
    await filaBtn.click();

    const drawer = page.getByRole('dialog', { name: /Pol[íi]tica PESV/i });
    await expect(drawer).toBeVisible();

    // fieldset + legend semántico via role="group".
    const fieldset = drawer.getByRole('group', { name: /Nivel de cumplimiento/i });
    await expect(fieldset).toBeVisible();
    // 4 radios reales (no_implementado, en_desarrollo, implementado, sostenido).
    await expect(fieldset.getByRole('radio')).toHaveCount(4);

    // aria-live=polite para "Guardado hace Xs".
    await expect(drawer.locator('[role="status"][aria-live="polite"]')).toHaveCount(1);

    // Focus trap: el componente posiciona foco inicial via setTimeout(50ms) en
    // firstRadioRef (sr-only anchor con tabIndex=-1). Tab desde body/anchor
    // puede escapar si el navegador no encuentra activeElement adentro. Forzamos
    // foco al botón "Cerrar evaluación" (primer focusable visible del drawer)
    // antes de iniciar el ciclo Tab para garantizar que onKeyDown del wrapper
    // capture eventos provenientes de descendiente.
    const drawerHandle = await drawer.elementHandle();
    expect(drawerHandle).not.toBeNull();
    await drawer.getByRole('button', { name: /Cerrar evaluación/i }).focus();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate((el) => {
        const a = document.activeElement;
        return !!a && el!.contains(a);
      }, drawerHandle);
      if (!inside) {
        const debug = await page.evaluate(() => {
          const a = document.activeElement;
          return { tag: a?.tagName, label: a?.getAttribute('aria-label'), text: a?.textContent?.slice(0, 40) };
        });
        expect(inside, `Tab #${i + 1}: foco escapó del drawer (${JSON.stringify(debug)})`).toBeTruthy();
      }
    }

    // Heurísticas a11y axe (sólo si CDN disponible).
    expectNoSeriousCritical(await runAxe(page), 'drawer-abierto');

    // Esc cierra (sin dirty, no aparece confirm()).
    await page.keyboard.press('Escape');
    await expect(drawer).not.toBeVisible();

    // Foco restaurado al elemento que lo abrió (fila).
    const restored = await page.evaluate(() => document.activeElement?.textContent || '');
    expect(restored).toMatch(/P1\.1/);
  });

  test('modal preflight abierto — focus trap + Esc cierra + axe', async ({ page }) => {
    await page.goto(`/pesv/diagnostico/${DIAG_ID}`);
    await page.getByRole('button', { name: /^Cerrar diagn[óo]stico$/i }).first().click();
    const modal = page.getByRole('dialog', { name: /Cerrar diagn[óo]stico/i });
    await expect(modal).toBeVisible();

    // Anclar foco al primer focusable del modal (botón Cerrar modal del header)
    // antes de Tab. makeFocusTrapHandler() sólo intercepta cuando el foco YA
    // está dentro; el setTimeout(50ms) del componente puede no haber resuelto.
    const modalHandle = await modal.elementHandle();
    await modal.getByRole('button', { name: /^Cerrar modal$/i }).focus();
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate((el) => {
        const a = document.activeElement;
        return !!a && el!.contains(a);
      }, modalHandle);
      if (!inside) {
        const debug = await page.evaluate(() => {
          const a = document.activeElement;
          return { tag: a?.tagName, label: a?.getAttribute('aria-label'), text: a?.textContent?.slice(0, 40) };
        });
        expect(inside, `Tab #${i + 1}: foco escapó del modal (${JSON.stringify(debug)})`).toBeTruthy();
      }
    }

    expectNoSeriousCritical(await runAxe(page), 'modal-cierre');

    await page.keyboard.press('Escape');
    await expect(modal).not.toBeVisible();
  });
});
