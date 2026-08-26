// LAFT — smoke de las 7 vistas del módulo (HU #11275, AC1).
//
// El módulo llegaba a esta HU con 0 % de cobertura E2E. Antes de este archivo, cualquiera de las 7
// pantallas podía quedarse en blanco en `develop` —un `import` mal renombrado, un campo que dejó de
// venir, un `.map` sobre `undefined`— y nada lo decía: son vistas de cumplimiento, se abren una vez
// al trimestre y quien las abre no es quien despliega.
//
// ── Los tres sensores que aquí NO valen solos, y con qué se acompañan ──────────────────────────
//
//   1. **El `<h1>` no prueba nada.** `PageHeaderCard` lo pinta FUERA de cualquier condicional de
//      carga o error, y `NoAccess` también tiene el suyo: un aserto de encabezado pasa con la vista
//      atascada en «Cargando…» y pasa sin permiso. Por eso cada test añade tres cosas: una huella
//      del CUERPO que sale del fixture (no del microcopy), la ausencia de la fila «Cargando...» y
//      la ausencia del encabezado de `NoAccess`.
//   2. **El glob que falla no se nota.** El fixture base instala un catch-all que responde `200 []`
//      a todo `/api/**`, así que equivocarse de glob no rompe el test: la vista recibe lista vacía
//      y pinta su estado vacío tan feliz. El seguro es un espía de peticiones REALES
//      (`page.on('request')`) que comprueba el `pathname` exacto — independiente del glob del mock.
//   3. **Un colector de consola sin control positivo pasa siempre.** `expect(errores).toEqual([])`
//      es verde tanto si no hubo errores como si el colector nunca estuvo enchufado. El control
//      vive abajo, en el test «canario»: provoca un `console.error` y una excepción de verdad y
//      exige que el colector vea las dos.
//
// Los datos son SINTÉTICOS y se ven como tales (documentos 9000000xx, correos `example.invalid`).
// Ni un dato personal real entra en un spec — AGENTS.md, Ley 1581.
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs } from '../helpers/auth';
import { COMPLIANCE_LAFT_USER, VISTAS_LAFT, mockVista } from '../helpers/laft-fixtures';

/** Acumula lo que el navegador considera un error, venga de `console.error` o de una excepción. */
function vigilarErrores(page: Page): string[] {
  const errores: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errores.push(`console: ${msg.text()}`); });
  page.on('pageerror', (err) => { errores.push(`pageerror: ${err.message}`); });
  return errores;
}

/**
 * Espía de peticiones reales al API de LAFT. Solo el `pathname`: la query es justo el sitio por el
 * que un documento se colaría a un artefacto de CI (AGENTS.md §14).
 */
function espiarApiLaft(page: Page): string[] {
  const vistas: string[] = [];
  page.on('request', (req) => {
    const { pathname } = new URL(req.url());
    if (pathname.startsWith('/api/laft')) vistas.push(pathname);
  });
  return vistas;
}

/** Lo que distingue «montada» de «montada a medias» o «montada sin permiso». */
async function noEstaNiCargandoNiBloqueada(page: Page): Promise<void> {
  await expect(page.getByText(/^Cargando\.\.\.$/)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /No tienes acceso a/ })).toHaveCount(0);
}

test.describe('LAFT — las 7 vistas montan (HU #11275, AC1)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const vista of VISTAS_LAFT) {
    test(`AC1 — ${vista.ruta} renderiza su estado CARGADO sin errores de consola`, async ({ page }) => {
      const errores = vigilarErrores(page);
      const pedidas = espiarApiLaft(page);
      await loginAs(page, COMPLIANCE_LAFT_USER);
      await mockVista(page, vista);

      await page.goto(vista.ruta);

      // 1 · No es una pantalla en blanco: el `<h1>` de la vista está ahí…
      await expect(page.getByRole('heading', { level: 1, name: vista.titulo })).toBeVisible();
      // 2 · …y el estado es el CARGADO: lo que se ve viene del CUERPO de la respuesta, no del
      //     microcopy de la plantilla. Esta es la afirmación que aguanta.
      await expect(page.getByText(vista.textoCargado).first()).toBeVisible();
      // 3 · Ni «Cargando...» ni `NoAccess` ocupan la pantalla.
      await noEstaNiCargandoNiBloqueada(page);
      // 4 · Y el dato salió del endpoint que se cree, comprobado sobre la petición real: si el glob
      //     del mock se escribiera mal, el catch-all respondería `200 []` sin que nada chistara.
      expect(pedidas, `${vista.ruta} no consultó ${vista.ruta_api}`).toContain(vista.ruta_api);

      expect(errores, `errores de consola en ${vista.ruta}`).toEqual([]);
    });
  }

  for (const vista of VISTAS_LAFT) {
    test(`AC1 — ${vista.ruta} renderiza su estado VACÍO sin errores de consola`, async ({ page }) => {
      const errores = vigilarErrores(page);
      const pedidas = espiarApiLaft(page);
      await loginAs(page, COMPLIANCE_LAFT_USER);
      await mockVista(page, vista, vista.cuerpoVacio);

      await page.goto(vista.ruta);

      await expect(page.getByRole('heading', { level: 1, name: vista.titulo })).toBeVisible();
      await expect(page.getByText(vista.textoVacio).first()).toBeVisible();
      // El vacío es un vacío, no un cargado a medias: la huella del fixture con datos NO está.
      await expect(page.getByText(vista.textoCargado)).toHaveCount(0);
      await noEstaNiCargandoNiBloqueada(page);
      expect(pedidas, `${vista.ruta} no consultó ${vista.ruta_api}`).toContain(vista.ruta_api);

      expect(errores, `errores de consola en ${vista.ruta}`).toEqual([]);
    });
  }

  /**
   * Control POSITIVO del colector de errores.
   *
   * Sin este test, los 14 de arriba comparten un punto ciego: `expect(errores).toEqual([])` es verde
   * cuando no hubo errores Y también cuando el colector no estaba escuchando —un `page.on` puesto
   * después de navegar, un cambio de API de Playwright, un filtro de tipo que deja de casar—. Aquí
   * se provocan las dos clases a propósito y se exige que las vea.
   */
  test('AC1 (canario) — el colector de errores SÍ ve un console.error y una excepción', async ({ page }) => {
    const errores = vigilarErrores(page);
    await loginAs(page, COMPLIANCE_LAFT_USER);
    await page.goto('/laft/tablero');
    await expect(page.getByRole('heading', { level: 1, name: 'Estado del cumplimiento' })).toBeVisible();

    await page.evaluate(() => { console.error('canario-e2e-console'); });
    await page.evaluate(() => { setTimeout(() => { throw new Error('canario-e2e-pageerror'); }, 0); });

    await expect.poll(() => errores.join('|')).toContain('canario-e2e-console');
    await expect.poll(() => errores.join('|')).toContain('canario-e2e-pageerror');
  });
});
