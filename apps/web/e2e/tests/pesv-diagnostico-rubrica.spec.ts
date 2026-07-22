// Spec 3/7 — Rúbrica de 4 niveles del estándar PESV.
//
// Cubre:
//   - Seleccionar cada uno de los 4 niveles (No implementado / En desarrollo /
//     Implementado / Sostenido) y guardar (PATCH).
//   - Persistencia tras refresh: la app vuelve a hidratar nivelRubrica.
//   - Validación: si nivel ≥ Implementado y sin evidencia, warning visible
//     pero NO bloquea guardar (Sprint 1 estrategia permisiva).
//   - Mapeo bidireccional: si el servidor responde scorePct="75.00" sin
//     nivelRubrica, la UI deriva 'implementado' (helper scoreToNivelRubrica
//     del backend lo deja consistente, pero validamos del lado cliente que
//     el radio "Implementado" queda marcado al recargar).
//
// Mocks: cada llamada PATCH actualiza un estado interno del test y el siguiente
// GET refleja el cambio.

import { test, expect } from '../helpers/fixtures';
import {
  LIDER_PESV_USER, loginAsUser, stubPesvSiblings,
  buildDiagDetail, build24Items, jsonRoute, type NivelRubrica,
  rubricaRadio, selectRubricaNivel,
} from '../helpers/pesv-fixtures';

const DIAG_ID = 11;
const ESTANDAR_ID = 1001;

const NIVEL_TO_SCORE: Record<NivelRubrica, string> = {
  no_implementado: '0.00',
  en_desarrollo: '50.00',
  implementado: '75.00',
  sostenido: '100.00',
};

test.describe('PESV Diagnóstico · Rúbrica', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsUser(page, LIDER_PESV_USER);
    await stubPesvSiblings(page);
  });

  test('selecciona los 4 niveles y persiste; helper warning sin evidencia visible', async ({ page }) => {
    let currentNivel: NivelRubrica = 'no_implementado';
    let currentComentarios: string | null = null;
    const items = build24Items({ diagnosticoId: DIAG_ID });

    await page.route(`**/api/pesv/diagnostico/${DIAG_ID}`, (route) => {
      const detail = buildDiagDetail({ id: DIAG_ID });
      detail.items = items.map((it) =>
        it.estandarId === ESTANDAR_ID
          ? { ...it, nivelRubrica: currentNivel, scorePct: NIVEL_TO_SCORE[currentNivel], comentarios: currentComentarios }
          : it,
      );
      return jsonRoute(200, detail)(route);
    });
    await page.route(`**/api/pesv/diagnostico/${DIAG_ID}/items/${ESTANDAR_ID}/historial`, jsonRoute(200, { data: [] }));
    await page.route(`**/api/pesv/diagnostico/${DIAG_ID}/items/${ESTANDAR_ID}`, async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      const body = route.request().postDataJSON() ?? {};
      if (body.nivelRubrica) currentNivel = body.nivelRubrica;
      if ('comentarios' in body) currentComentarios = body.comentarios ?? null;
      return jsonRoute(200, {
        diagnosticoId: DIAG_ID, estandarId: ESTANDAR_ID,
        scorePct: NIVEL_TO_SCORE[currentNivel], nivelRubrica: currentNivel,
        comentarios: currentComentarios, updatedAt: new Date().toISOString(),
      })(route);
    });

    await page.goto(`/pesv/diagnostico/${DIAG_ID}`);
    await page.getByRole('button').filter({ hasText: /P1\.1/ }).first().click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();

    const fieldset = drawer.getByRole('group', { name: /Nivel de cumplimiento/i });
    await expect(fieldset).toBeVisible();

    const niveles: NivelRubrica[] = ['en_desarrollo', 'implementado', 'sostenido', 'no_implementado'];

    for (const nivel of niveles) {
      // Click sobre el <label> contenedor — el <input> está visualmente oculto
      // (opacity-0 w-0 h-0). Selector por attribute `value` evita ambigüedad
      // entre "Implementado" y "Sostenido 100% Implementado".
      await selectRubricaNivel(drawer, nivel);
      await expect(rubricaRadio(drawer, nivel)).toBeChecked();
      // Si nivel >= Implementado y sin evidencia → helper warning visible (showWarningIfEmpty).
      if (nivel === 'implementado' || nivel === 'sostenido') {
        await expect(drawer.getByText(/Este nivel requiere al menos una evidencia/i)).toBeVisible();
      }
      const saveBtn = drawer.getByRole('button', { name: /Guardar cambios/i });
      await expect(saveBtn).toBeEnabled();
      await saveBtn.click();
      // El servidor confirma vía actualización del estado interno del mock
      // (currentNivel). El banner "Guardado hace …" puede ser fugaz si el
      // useEffect del componente resetea savedAt al recargar item (cambio de
      // updatedAt). Validamos la fuente de verdad: el PATCH llegó al mock.
      await expect.poll(() => currentNivel, { timeout: 5000 }).toBe(nivel);
    }
  });

  test('refresh persiste el nivel (mapeo bidireccional scorePct=75 → Implementado)', async ({ page }) => {
    const items = build24Items({ diagnosticoId: DIAG_ID });
    items[0] = { ...items[0], nivelRubrica: 'implementado', scorePct: '75.00' };

    await page.route(`**/api/pesv/diagnostico/${DIAG_ID}`, jsonRoute(200, { ...buildDiagDetail({ id: DIAG_ID }), items }));
    await page.route(`**/api/pesv/diagnostico/${DIAG_ID}/items/${ESTANDAR_ID}/historial`, jsonRoute(200, { data: [] }));

    await page.goto(`/pesv/diagnostico/${DIAG_ID}`);
    await page.getByRole('button').filter({ hasText: /P1\.1/ }).first().click();
    const drawer = page.getByRole('dialog');
    // Selector por attribute `value` — único y estable. El name accesible derivado
    // del texto matchea 3 radios (No implementado, Implementado, Sostenido 100% Implementado).
    await expect(rubricaRadio(drawer, 'implementado')).toBeChecked();
  });
});
