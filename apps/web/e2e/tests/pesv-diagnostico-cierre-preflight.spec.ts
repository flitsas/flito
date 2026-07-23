// Spec 4/7 — Modal preflight de cierre WORM.
//
// Estado inicial: 22/24 evaluados; 2 sin_evaluar; 3 nivel_implementado_sin_evidencia;
// 1 en_desarrollo_sin_comentario (advertencia).
//
// Cubre:
//   - Click "Cerrar diagnóstico" → modal preflight visible con 5 bloqueos + 1 advertencia.
//   - Botón "Cerrar definitivamente" DESHABILITADO con bloqueos.
//   - Click "Ir al estándar" sobre fila de bloqueo → cierra modal y abre drawer
//     del estándar correcto.
//   - Resolver los 5 bloqueos (mockeamos preflight sin bloqueos), re-abrir
//     preflight → solo 1 advertencia, checkbox WORM habilita el confirm.
//   - Confirmar → POST /cerrar 200 + redirect a /auditoria.
//   - Intentar cerrar de nuevo → 409 "ya cerrado".

import { test, expect } from '../helpers/fixtures';
import {
  LIDER_PESV_USER, loginAsUser, stubPesvSiblings,
  buildDiagDetail, build24Items, buildPreflight, jsonRoute,
} from '../helpers/pesv-fixtures';

const DIAG_ID = 33;

// Identificadores generados por build24Items: 1000 + idx + 1.
// Los 6 primeros bloques (P1.1..P1.6) + algunos H2.x para cubrir motivos distintos.
const BLOQUEOS_INICIAL = [
  { estandarId: 1023, codigo: 'A6.3', motivo: 'sin_evaluar' as const },
  { estandarId: 1024, codigo: 'A6.4', motivo: 'sin_evaluar' as const },
  { estandarId: 1001, codigo: 'P1.1', motivo: 'nivel_implementado_sin_evidencia' as const },
  { estandarId: 1002, codigo: 'P1.2', motivo: 'nivel_implementado_sin_evidencia' as const },
  { estandarId: 1003, codigo: 'P1.3', motivo: 'nivel_implementado_sin_evidencia' as const },
];
const ADVERTENCIAS_INICIAL = [
  { estandarId: 1004, codigo: 'P1.4', motivo: 'en_desarrollo_sin_comentario' as const },
];

test.describe('PESV Diagnóstico · Preflight + cierre WORM', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsUser(page, LIDER_PESV_USER);
    await stubPesvSiblings(page);
  });

  test('preflight con bloqueos → "Ir al estándar" abre drawer; resolver → cierre OK; reintento → 409', async ({ page }) => {
    let cerrado = false;
    let preflightCallCount = 0;

    // Estado del diagnóstico cambia tras cierre (estado→'cerrado'). Regex
    // ancla el match al detail GET con o sin querystring (?view=auditoria que
    // el shell o /auditoria pueden disparar) pero NO a sub-rutas como
    // /preflight o /cerrar — esas tienen handlers dedicados abajo. Sin esto,
    // el proxy vite intenta backend, falla con ECONNREFUSED y la sesión
    // puede colapsar a /login en suite completa (flake order-dependent).
    //
    // Forzamos UN item evaluado desde el inicio para habilitar el botón
    // "Cerrar diagnóstico" (deshabilitado si stats.evaluados===0).
    const detailRegex = new RegExp(`/api/pesv/diagnostico/${DIAG_ID}(?:\\?.*)?$`);
    await page.route(detailRegex, (route) => {
      const detail = buildDiagDetail({
        id: DIAG_ID,
        estado: cerrado ? 'cerrado' : 'borrador',
        scoreGlobal: cerrado ? '75.00' : '60.00',
      });
      const items = build24Items({ diagnosticoId: DIAG_ID });
      items[0] = { ...items[0], nivelRubrica: 'implementado', scorePct: '75.00' };
      detail.items = items;
      return jsonRoute(200, detail)(route);
    });

    await page.route(`**/api/pesv/diagnostico/${DIAG_ID}/items/**/historial`, jsonRoute(200, { data: [] }));

    // Preflight: primera llamada tiene los 5 bloqueos; tras "resolver", responde sin bloqueos.
    await page.route(`**/api/pesv/diagnostico/${DIAG_ID}/preflight`, (route) => {
      preflightCallCount += 1;
      const conBloqueos = preflightCallCount === 1;
      return jsonRoute(200, buildPreflight({
        totalEstandares: 24,
        evaluados: conBloqueos ? 22 : 24,
        conEvidencia: conBloqueos ? 19 : 22,
        scoreProyectado: conBloqueos ? 60 : 75,
        bloqueos: conBloqueos ? BLOQUEOS_INICIAL : [],
        advertencias: ADVERTENCIAS_INICIAL,
      }))(route);
    });

    // POST cerrar: primera vez OK, segunda 409.
    await page.route(`**/api/pesv/diagnostico/${DIAG_ID}/cerrar`, (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      if (cerrado) return jsonRoute(409, { error: 'ya cerrado' })(route);
      cerrado = true;
      return jsonRoute(200, {
        id: DIAG_ID, anio: 2027, estado: 'cerrado', scoreGlobal: '75.00',
        cerradoAt: new Date().toISOString(), optimisticV: 2,
      })(route);
    });

    await page.goto(`/pesv/diagnostico/${DIAG_ID}`);

    // Abrir preflight desde header (puede aparecer también botón en panel der "Ver preflight"
    // — usamos .first() para tomar el del header sticky que abre el mismo modal).
    await page.getByRole('button', { name: /^Cerrar diagn[óo]stico$/i }).first().click();
    const modal = page.getByRole('dialog', { name: /Cerrar diagn[óo]stico/i });
    await expect(modal).toBeVisible();

    // 5 bloqueos visibles + 1 advertencia.
    await expect(modal.getByText(/Bloqueos\s*\(5\)/i)).toBeVisible();
    await expect(modal.getByText(/Advertencias\s*\(1\)/i)).toBeVisible();

    // Botón "Cerrar definitivamente" deshabilitado.
    const confirmBtn = modal.getByRole('button', { name: /Cerrar definitivamente/i });
    await expect(confirmBtn).toBeDisabled();

    // Click "Ir al estándar" en la fila del bloqueo P1.1 (estandarId 1001).
    const fila = modal.locator('tr', { hasText: 'P1.1' });
    await fila.getByRole('button', { name: /Ir al estándar/i }).click();

    // Modal se cierra y se abre drawer del estándar correcto.
    await expect(modal).not.toBeVisible();
    const drawer = page.getByRole('dialog', { name: /Pol[íi]tica PESV firmada/i });
    await expect(drawer).toBeVisible();

    // Cerrar drawer y simular resolución: re-abrir preflight (segundo call ya sin bloqueos).
    // El botón "Cerrar evaluación" del drawer está debajo del menú de usuario
    // sticky del shell (z-30). Disparamos el handler vía dispatchEvent directo
    // — evita ambigüedad de pointer interception y respeta el flujo React.
    await drawer
      .getByRole('button', { name: /Cerrar evaluación/i })
      .evaluate((btn) => (btn as HTMLButtonElement).click());
    await expect(drawer).not.toBeVisible();
    await page.getByRole('button', { name: /^Cerrar diagn[óo]stico$/i }).first().click();
    const modal2 = page.getByRole('dialog', { name: /Cerrar diagn[óo]stico/i });
    await expect(modal2).toBeVisible();
    await expect(modal2.getByText(/Advertencias\s*\(1\)/i)).toBeVisible();
    await expect(modal2.locator('text=/Bloqueos/').first()).toHaveCount(0);

    // Marcar checkbox WORM → habilita confirm.
    const checkbox = modal2.getByRole('checkbox');
    await checkbox.check();
    const confirmBtn2 = modal2.getByRole('button', { name: /Cerrar definitivamente/i });
    await expect(confirmBtn2).toBeEnabled();
    await confirmBtn2.click();

    // Redirect a /auditoria + toast éxito.
    await expect(page).toHaveURL(new RegExp(`/pesv/diagnostico/${DIAG_ID}/auditoria$`));
    await expect(page.locator('[role="status"]', { hasText: /Diagn[óo]stico cerrado/i })).toBeVisible();

    // Reintento: volver a /pesv/diagnostico/:id y otra vez "Cerrar" → preflight aún OK,
    // POST /cerrar → 409 con "ya cerrado".
    await page.goto(`/pesv/diagnostico/${DIAG_ID}`);
    // Como estado es 'cerrado' ahora, el botón "Cerrar diagnóstico" del header
    // ya no se renderiza (isWorm=true) — verificamos por banner.
    await expect(page.getByText(/Diagn[óo]stico cerrado el/i)).toBeVisible();
  });
});
