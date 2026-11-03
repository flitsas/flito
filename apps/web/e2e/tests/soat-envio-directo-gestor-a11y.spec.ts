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
import { elegirTipoInicial } from '../helpers/soat-tipo';
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
    logisticaPermiteParcial: false,
    gestorSoatSinTramite: { id: SURA, nombre: 'SURA', activo: true },
    // HU #13968: el aviso del cuadro, para medirlo con axe y comprobar que el selector lo referencia.
    permisoSinTramiteSinEfecto: true,
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

    await page.getByRole('button', { name: 'Editar Concesionario Norte', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Editar · Concesionario Norte' });
    await expect(modal).toBeVisible();

    // ── 1 · Cada control por su label ASOCIADO ────────────────────────────────────────────────
    // `getByLabel` resuelve por la asociación real, así que esto ES la comprobación —más fuerte que
    // contar `<label>` en el DOM: uno suelto al lado del control, sin `for` ni envoltura, cuenta
    // igual y no le sirve de nada a un lector de pantalla. `toHaveCount(1)` impide además el empate
    // de dos controles con el mismo nombre.
    // HU #13968: un solo control; el interruptor «Canal abierto» ya no existe.
    await expect(modal.getByLabel('Canal abierto')).toHaveCount(0);
    await expect(modal.getByLabel('Proveedor de SOAT sin trámite')).toHaveCount(1);
    // El aviso del permiso sin efecto se lee al llegar al control (AC4).
    await expect(modal.getByLabel('Proveedor de SOAT sin trámite')).toHaveAccessibleDescription(
      /Tiene usuarios con permiso de SOAT sin trámite, pero no tiene proveedor elegido/,
    );

    // ── 2 · Ningún botón mudo ─────────────────────────────────────────────────────────────────
    const mudos = await page.locator('[role="dialog"] button').evaluateAll(
      (els) => els.filter((el) => !el.getAttribute('aria-labelledby') && ((el.getAttribute('aria-label') ?? el.textContent ?? '').trim() === '')).length,
    );
    expect(mudos, 'hay botones sin texto ni aria-label en el modal').toBe(0);

    // ── 3 · El foco se VE, y se llega por TECLADO ─────────────────────────────────────────────
    // El `:focus-visible` de un clic de ratón no se pinta en muchos navegadores, así que enfocar con
    // `el.focus()` diría poco. Lo que se exige es que el foco produzca una diferencia visible, no
    // que use un token concreto.
    const selector = modal.getByLabel('Proveedor de SOAT sin trámite');
    const estiloDe = () => selector.evaluate((el) => {
      const s = getComputedStyle(el);
      return `${s.outlineStyle}|${s.outlineWidth}|${s.outlineColor}|${s.boxShadow}|${s.borderColor}`;
    });
    await modal.getByRole('button', { name: 'Cerrar', exact: true }).focus();
    const sinFoco = await estiloDe();
    // HU #14105: entre el cierre y el selector hay ahora las pestañas del modal y los datos.
    for (let i = 0; i < 8 && !(await selector.evaluate((el) => el === document.activeElement)); i += 1) {
      await page.keyboard.press('Tab');
    }
    await expect(selector).toBeFocused();
    expect(await estiloDe(), 'el foco del selector de proveedor no produce ninguna diferencia visible')
      .not.toEqual(sinFoco);

    // ── 4 · axe, con el modal ABIERTO ─────────────────────────────────────────────────────────
    esperarSinViolacionesGraves(await correrAxe(page), 'ficha de la compañía · modal «SOAT sin trámite»');
  });

  test('el modal en rechazo: axe con el `role="alert"` pintado y el cuadro abierto', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await page.route(/\/api\/flito\/parametrizacion\/companias\/1$/, (route) => json(route, 403, { error: 'Sin permiso' }));
    await montarFicha(page);

    await page.getByRole('button', { name: 'Editar Concesionario Norte', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Editar · Concesionario Norte' });
    // HU #13968: «Sin proveedor» es válido; el `role="alert"` lo pinta el guardado rechazado.
    await modal.getByLabel('Proveedor de SOAT sin trámite').selectOption('');
    await modal.getByRole('button', { name: 'Guardar cambios' }).click();

    await expect(modal.getByRole('alert')).toHaveText('No tiene permiso para elegir el proveedor de esta compañía.');
    esperarSinViolacionesGraves(await correrAxe(page), 'modal «SOAT sin trámite» · rechazo del cliente');
  });

  test('la tarjeta de envío con el botón BLOQUEADO: axe, la línea referenciada y el foco alcanzable', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await page.route(/\/api\/flito\/soat\?/, (route) =>
      json(route, 200, { items: [], total: 0, page: 1, pageSize: 50 }));
    await page.route(/\/api\/flito\/soat\/facetas/, (route) =>
      json(route, 200, { companias: [], organismos: [], proveedores: [] }));
    await page.goto('/flito/soat/solicitud');
    await elegirTipoInicial(page);

    const enviar = page.getByRole('button', { name: 'Enviar solicitud' });
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
