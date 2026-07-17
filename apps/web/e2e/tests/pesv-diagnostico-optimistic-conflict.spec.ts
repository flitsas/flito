// Spec 6/7 — Conflicto optimista entre dos sesiones.
//
// Cubre:
//   - Dos sesiones simultáneas como lider_pesv usando browser contexts aislados.
//   - Sesión A abre drawer, cambia nivel a "Implementado", NO guarda.
//   - Sesión B abre el mismo estándar, cambia a "Sostenido", guarda → 200.
//   - Sesión A intenta guardar → 409 conflict (simulado por el handler PATCH).
//   - Modal "Cambios detectados desde otra sesión" + CTA "Recargar".
//   - Click Recargar → drawer hidrata valores de sesión B (Sostenido).
//
// Nota: el backend actual no implementa control de versión optimista en PATCH
// item (el campo optimisticV está en pesvDiagnosticos a nivel diagnóstico).
// El spec valida el manejo client-side del 409 que el backend SÍ devuelve cuando
// diagnostico.estado='cerrado'. Para reflejar la regla "otra sesión modificó",
// el handler de la sesión A retorna 409 ad-hoc tras la actualización de B.
// Cuando el backend gane versioning per-item, el test sigue siendo válido
// porque el frontend ya muestra el ConflictDialog ante cualquier 409 del PATCH.

import { test, expect } from '@playwright/test';
import {
  LIDER_PESV_USER, LIDER_PESV_ALT_USER, loginAsUser, stubPesvSiblings,
  buildDiagDetail, build24Items, jsonRoute, type NivelRubrica,
  rubricaRadio, selectRubricaNivel,
} from '../helpers/pesv-fixtures';

const DIAG_ID = 55;
const ESTANDAR_ID = 1001;

const NIVEL_TO_SCORE: Record<NivelRubrica, string> = {
  no_implementado: '0.00', en_desarrollo: '50.00', implementado: '75.00', sostenido: '100.00',
};

test.describe('PESV Diagnóstico · Conflicto optimista', () => {
  test('sesión A pierde el PATCH frente a sesión B → ConflictDialog + Recargar', async ({ browser }) => {
    // Estado global compartido entre handlers de ambas sesiones.
    const state = { nivel: 'no_implementado' as NivelRubrica, comentarios: null as string | null, version: 0 };

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    // Login en ambas.
    await loginAsUser(pageA, LIDER_PESV_USER);
    await loginAsUser(pageB, LIDER_PESV_ALT_USER);
    await stubPesvSiblings(pageA);
    await stubPesvSiblings(pageB);

    const installRoutes = async (p: typeof pageA, label: 'A' | 'B') => {
      await p.route(`**/api/pesv/diagnostico/${DIAG_ID}`, (route) => {
        const items = build24Items({ diagnosticoId: DIAG_ID });
        items[0] = {
          ...items[0],
          nivelRubrica: state.nivel,
          scorePct: NIVEL_TO_SCORE[state.nivel],
          comentarios: state.comentarios,
          updatedAt: new Date(2026, 4, 12, 10, state.version).toISOString(),
        };
        return jsonRoute(200, { ...buildDiagDetail({ id: DIAG_ID }), items })(route);
      });
      await p.route(`**/api/pesv/diagnostico/${DIAG_ID}/items/${ESTANDAR_ID}/historial`, jsonRoute(200, { data: [] }));
      await p.route(`**/api/pesv/diagnostico/${DIAG_ID}/items/${ESTANDAR_ID}`, async (route) => {
        if (route.request().method() !== 'PATCH') return route.continue();
        const body = route.request().postDataJSON() ?? {};
        // Sesión A debe fallar si version global avanzó después de su carga.
        if (label === 'A' && state.version > 0) {
          return jsonRoute(409, { error: 'conflict: another session modified this item' })(route);
        }
        if (body.nivelRubrica) state.nivel = body.nivelRubrica;
        if ('comentarios' in body) state.comentarios = body.comentarios ?? null;
        state.version += 1;
        return jsonRoute(200, {
          diagnosticoId: DIAG_ID, estandarId: ESTANDAR_ID,
          scorePct: NIVEL_TO_SCORE[state.nivel], nivelRubrica: state.nivel,
          comentarios: state.comentarios, updatedAt: new Date().toISOString(),
        })(route);
      });
    };
    await installRoutes(pageA, 'A');
    await installRoutes(pageB, 'B');

    // Sesión A — abrir drawer y elegir Implementado, NO guardar todavía.
    await pageA.goto(`/pesv/diagnostico/${DIAG_ID}`);
    await pageA.getByRole('button').filter({ hasText: /P1\.1/ }).first().click();
    const drawerA = pageA.getByRole('dialog');
    await selectRubricaNivel(drawerA, 'implementado');
    await expect(rubricaRadio(drawerA, 'implementado')).toBeChecked();

    // Sesión B — abrir el mismo estándar, elegir Sostenido y guardar.
    await pageB.goto(`/pesv/diagnostico/${DIAG_ID}`);
    await pageB.getByRole('button').filter({ hasText: /P1\.1/ }).first().click();
    const drawerB = pageB.getByRole('dialog');
    await selectRubricaNivel(drawerB, 'sostenido');
    await expect(rubricaRadio(drawerB, 'sostenido')).toBeChecked();
    const saveB = drawerB.getByRole('button', { name: /Guardar cambios/i });
    await expect(saveB).toBeEnabled();
    await saveB.click();
    // El banner "Guardado" puede ser fugaz si el effect del drawer resetea
    // savedAt al recargar item (cambio de updatedAt). La fuente de verdad es
    // que el PATCH global persistió `state.nivel = 'sostenido'`.
    await expect.poll(() => state.nivel, { timeout: 5000 }).toBe('sostenido');

    // Sesión A intenta guardar → 409 → ConflictDialog visible.
    await drawerA.getByRole('button', { name: /Guardar cambios/i }).click();
    const conflictDialog = pageA.getByRole('alertdialog', { name: /Cambios detectados desde otra sesi[óo]n/i });
    await expect(conflictDialog).toBeVisible();

    // Click "Recargar" → cierra dialog y onSaved() re-hidrata datos servidor (Sostenido).
    await conflictDialog.getByRole('button', { name: /Recargar/i }).click();
    await expect(conflictDialog).not.toBeVisible();
    await expect(rubricaRadio(drawerA, 'sostenido')).toBeChecked();

    await contextA.close();
    await contextB.close();
  });
});
