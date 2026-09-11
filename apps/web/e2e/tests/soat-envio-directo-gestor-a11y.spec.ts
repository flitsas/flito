// HU #12079 — accesibilidad de las DOS superficies que esta HU estrena. AC5.
//
// ── Por qué en su propio archivo ────────────────────────────────────────────────────────────────
//
// El repo no tiene `@axe-core/playwright`: `helpers/axe.ts` inyecta `axe.min.js` desde disco
// (`QA_AXE_PATH`) o desde un CDN (`QA_AXE_CDN=1`), y **lanza a propósito** si no hay ninguno de los
// dos (HU #11650). En una máquina sin el interruptor este spec sale rojo por ENTORNO; si viviera
// dentro de `soat-envio-directo-gestor.spec.ts`, ese rojo contaminaría el gate funcional y nadie
// podría distinguir «la pantalla incumple» de «axe no estaba». Es la misma separación que
// `siigo-credenciales-a11y.spec.ts`.
//
//   QA_AXE_CDN=1 npx playwright test e2e/tests/soat-envio-directo-gestor-a11y.spec.ts
//
// Las dos superficies:
//   · el MODAL de la ficha de la compañía, que es lo único nuevo de `/clients` — y se mide ABIERTO,
//     que es cuando existen el interruptor, el selector y sus mensajes;
//   · la tarjeta de envío del formulario del Cliente con el botón BLOQUEADO, que es cuando existen
//     la línea de faltantes y el `aria-describedby` que la referencia.
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, CLIENTE_CON_CANAL, OPERACIONES_USER } from '../helpers/auth';
import { correrAxe, esperarSinViolacionesGraves } from '../helpers/axe';

test.use({ viewport: { width: 1440, height: 900 } });

const SURA = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function montarFicha(page: Page) {
  await page.route(/\/api\/clients(\?|$)/, (route) => json(route, 200, [{
    id: 1, name: 'Concesionario Norte', document: '900111', documentType: 'NIT',
    phone: null, email: null, address: null, city: 'Medellín',
    soatAutogestionable: false, impuestosAutogestionable: false, logisticaAutogestionable: false,
    logisticaPermiteParcial: false, soatSinTramite: true,
    gestorSoatSinTramite: { id: SURA, nombre: 'SURA', activo: true },
  }]));
  await page.route(/\/api\/siigo\/clientes\/validacion\/detalle/, (route) => json(route, 200, { data: [] }));
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat$/, (route) =>
    json(route, 200, [{ id: SURA, nombre: 'SURA', activo: true }]));
  await page.goto('/clients');
}

test.describe('HU #12079 · AC5 — accesibilidad', () => {
  test('el modal del canal: axe sin violaciones graves, cada control por su label y el foco se ve', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montarFicha(page);

    await page.getByRole('button', { name: 'SOAT sin trámite de Concesionario Norte: Abierto · SURA' }).click();
    const modal = page.getByRole('dialog', { name: 'SOAT sin trámite · Concesionario Norte' });
    await expect(modal).toBeVisible();

    // ── 1 · Cada control por su label ASOCIADO ────────────────────────────────────────────────
    // `getByLabel` resuelve por la asociación real, así que esto ES la comprobación —más fuerte que
    // contar `<label>` en el DOM: uno suelto al lado del control, sin `for` ni envoltura, cuenta
    // igual y no le sirve de nada a un lector de pantalla. `toHaveCount(1)` impide además el empate
    // de dos controles con el mismo nombre.
    await expect(modal.getByLabel('Canal abierto')).toHaveCount(1);
    await expect(modal.getByLabel('Gestor por defecto')).toHaveCount(1);

    // ── 2 · Ningún botón mudo ─────────────────────────────────────────────────────────────────
    const mudos = await page.locator('[role="dialog"] button').evaluateAll(
      (els) => els.filter((el) => ((el.getAttribute('aria-label') ?? el.textContent ?? '').trim() === '')).length,
    );
    expect(mudos, 'hay botones sin texto ni aria-label en el modal').toBe(0);

    // ── 3 · El foco se VE, y se llega por TECLADO ─────────────────────────────────────────────
    // El `:focus-visible` de un clic de ratón no se pinta en muchos navegadores, así que enfocar con
    // `el.focus()` diría poco. Lo que se exige es que el foco produzca una diferencia visible, no
    // que use un token concreto.
    const selector = modal.getByLabel('Gestor por defecto');
    const estiloDe = () => selector.evaluate((el) => {
      const s = getComputedStyle(el);
      return `${s.outlineStyle}|${s.outlineWidth}|${s.outlineColor}|${s.boxShadow}|${s.borderColor}`;
    });
    await modal.getByLabel('Canal abierto').focus();
    const sinFoco = await estiloDe();
    await page.keyboard.press('Tab');
    await expect(selector).toBeFocused();
    expect(await estiloDe(), 'el foco del selector de gestor no produce ninguna diferencia visible')
      .not.toEqual(sinFoco);

    // ── 4 · axe, con el modal ABIERTO ─────────────────────────────────────────────────────────
    esperarSinViolacionesGraves(await correrAxe(page), 'ficha de la compañía · modal «SOAT sin trámite»');
  });

  test('el modal en rechazo: axe con el `role="alert"` pintado y el control inválido enfocado', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await page.route(/\/api\/flito\/parametrizacion\/companias\/1$/, (route) => json(route, 200, { id: 1 }));
    await montarFicha(page);

    await page.getByRole('button', { name: /SOAT sin trámite de Concesionario Norte/ }).click();
    const modal = page.getByRole('dialog', { name: 'SOAT sin trámite · Concesionario Norte' });
    // Se vacía el gestor con el canal encendido: el estado donde el modal pinta su `role="alert"` y
    // pone `aria-invalid` en el `<select>`. Un axe corrido solo sobre el modal limpio no vería nada
    // de eso.
    await modal.getByLabel('Gestor por defecto').selectOption('');
    await modal.getByRole('button', { name: 'Guardar' }).click();

    await expect(modal.getByRole('alert')).toHaveText('Elija el gestor por defecto antes de abrir el canal.');
    await expect(modal.getByLabel('Gestor por defecto')).toHaveAttribute('aria-invalid', 'true');
    esperarSinViolacionesGraves(await correrAxe(page), 'modal «SOAT sin trámite» · rechazo del cliente');
  });

  test('la tarjeta de envío con el botón BLOQUEADO: axe, la línea referenciada y el foco alcanzable', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await page.route(/\/api\/flito\/soat\?/, (route) =>
      json(route, 200, { items: [], total: 0, page: 1, pageSize: 50 }));
    await page.route(/\/api\/flito\/soat\/facetas/, (route) =>
      json(route, 200, { companias: [], organismos: [], proveedores: [] }));
    await page.goto('/flito/soat/solicitud');

    const enviar = page.getByRole('button', { name: 'Enviar al gestor' });
    await expect(enviar).toHaveAttribute('aria-disabled', 'true');
    // El lector tiene que poder llegar a la explicación DESDE el botón, que es cuando importa. Los
    // dos asertos: la referencia existe y apunta a algo que de verdad está en el árbol.
    const idDescripcion = await enviar.getAttribute('aria-describedby');
    expect(idDescripcion).toBe('sol-falta');
    await expect(page.locator(`#${idDescripcion}`)).toContainText('Para enviar falta:');

    // Y el botón bloqueado sigue en el recorrido de tabulación: `aria-disabled`, no `disabled`.
    await page.getByRole('button', { name: 'Cancelar' }).focus();
    await page.keyboard.press('Tab');
    await expect(enviar).toBeFocused();

    esperarSinViolacionesGraves(await correrAxe(page), 'formulario del Cliente · tarjeta de envío bloqueada');
  });
});
