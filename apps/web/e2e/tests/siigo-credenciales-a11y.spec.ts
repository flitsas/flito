// Siigo — credenciales: accesibilidad de la pantalla (HU #11890, AC6). TC-14.
//
// ── Por qué este TC vive en su PROPIO archivo ───────────────────────────────────────────────────
//
// El repo no tiene `@axe-core/playwright`: `helpers/axe.ts` inyecta `axe.min.js` desde disco
// (`QA_AXE_PATH`) o desde un CDN (`QA_AXE_CDN=1`), y si no hay ninguno de los dos LANZA a propósito
// —un chequeo de accesibilidad que no se ejecuta y aun así sale en verde hace creer que hay
// cobertura donde no la hay (HU #11650)—. Consecuencia práctica: en una máquina sin el interruptor,
// este spec sale rojo por ENTORNO. Si viviera dentro de `siigo-credenciales.spec.ts`, ese rojo
// contaminaría el gate funcional de la HU y nadie sabría distinguir «la pantalla incumple» de «axe
// no estaba». Separado, el gate lee dos cosas distintas en dos sitios distintos.
//
//   QA_AXE_CDN=1 npx playwright test e2e/tests/siigo-credenciales-a11y.spec.ts
//
// Lo que se mide aquí y no en el spec principal es solo axe. Las otras dos mitades del AC6 —labels
// asociados y nombre accesible de los botones— se comprueban también aquí, porque son la condición
// para que los localizadores por rol del spec funcional signifiquen algo.
import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER } from '../helpers/auth';
import { correrAxe, esperarSinViolacionesGraves } from '../helpers/axe';
import {
  RUTA_PAGINA, abrirFormulario, botonGuardar, botonProbar, campoAccessKey, campoUsuario,
  credencial, modal, montarApiSiigo,
} from '../helpers/siigo-fixtures';

test.use({ viewport: { width: 1440, height: 900 } });

test.describe('Siigo — credenciales: accesibilidad (HU #11890, AC6)', () => {
  test('TC-14 · AC6 — axe sin violaciones graves, cada campo por su label y el foco se ve', async ({ page }) => {
    await montarApiSiigo(page, {
      credenciales: [
        credencial({ id: 8201, ambiente: 'pruebas', username: 'qa_siigo_pruebas', activo: true }),
        credencial({ id: 8202, ambiente: 'produccion', username: 'qa_siigo_pdn', activo: false }),
      ],
    });
    await loginAs(page, ADMIN_USER);
    await page.goto(RUTA_PAGINA);

    // El ambiente NO es un control de formulario en este diseño (§3.1 del doc de UX): es el contexto
    // de la tarjeta. Su equivalente accesible es que cada tarjeta sea una región con nombre propio,
    // y eso es lo que se exige aquí — un `<select>` de ambiente etiquetado sería el AC6 del diseño
    // que se descartó, no el de esta pantalla.
    for (const etiqueta of [/^Pruebas$/, /^Producción$/]) {
      await expect(page.getByRole('region', { name: etiqueta })).toHaveCount(1);
    }

    await abrirFormulario(page, 'pruebas');

    // ── 1 · Cada input tiene su label ASOCIADO ────────────────────────────────────────────────
    // `getByLabel` resuelve por la asociación real (`<label for>`, `aria-labelledby`, `aria-label`).
    // Eso ES la comprobación del AC6, y es más fuerte que contar etiquetas `<label>` en el DOM: un
    // `<label>` suelto al lado de un input, sin `for`, cuenta igual y no sirve para nada a un lector
    // de pantalla. `toHaveCount(1)` además impide el empate de dos controles con el mismo nombre.
    await expect(campoUsuario(page)).toHaveCount(1);
    await expect(campoAccessKey(page)).toHaveCount(1);

    // ── 2 · Los botones tienen nombre accesible (texto o `aria-label`) ────────────────────────
    for (const boton of [botonGuardar(page).first(), page.getByRole('button', { name: /cancelar/i }).first()]) {
      const nombre = (await boton.getAttribute('aria-label')) ?? (await boton.textContent()) ?? '';
      expect(nombre.trim(), 'hay un botón sin nombre accesible').not.toEqual('');
    }
    // Y ningún botón de la pantalla se queda mudo — el de solo icono es el que se olvida.
    const mudos = await page.locator('main button, [role="dialog"] button').evaluateAll(
      (els) => els.filter((el) => {
        const etiqueta = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
        return etiqueta === '';
      }).length,
    );
    expect(mudos, 'hay botones sin texto ni aria-label').toBe(0);

    // ── 3 · El foco se VE ─────────────────────────────────────────────────────────────────────
    // Se llega por teclado a propósito: el `:focus-visible` de un clic de ratón no se pinta en
    // muchos navegadores, así que un foco enfocado con `el.focus()` diría poco. Se compara el estilo
    // calculado antes y después: lo que el AC pide es que el foco produzca una diferencia visible,
    // no que use un token concreto (`flit-focus` es la convención del repo, no una obligación
    // del AC).
    const estiloDe = () => campoAccessKey(page).evaluate((el) => {
      const s = getComputedStyle(el);
      return `${s.outlineStyle}|${s.outlineWidth}|${s.outlineColor}|${s.boxShadow}|${s.borderColor}`;
    });
    const sinFoco = await estiloDe();
    await campoUsuario(page).focus();
    await page.keyboard.press('Tab');
    await expect(campoAccessKey(page)).toBeFocused();
    const conFoco = await estiloDe();
    expect(conFoco, 'el campo enfocado por teclado se ve igual que sin foco').not.toEqual(sinFoco);

    // ── 4 · axe sobre la pantalla con datos ───────────────────────────────────────────────────
    esperarSinViolacionesGraves(await correrAxe(page), 'Siigo · credenciales (tarjetas + modal de alta)');

    // Y la pantalla de fondo, sin el modal: el `dialog` tapa el listado, así que medir solo con el
    // modal abierto dejaría las tarjetas sin auditar.
    await modal(page).getByRole('button', { name: /cancelar/i }).click();
    await expect(modal(page)).toHaveCount(0);
    await expect(botonProbar(page, 'pruebas')).toBeVisible();
    esperarSinViolacionesGraves(await correrAxe(page), 'Siigo · credenciales (tarjetas)');
  });

  test('TC-14b · AC6 — el estado de error también se anuncia y pasa axe', async ({ page }) => {
    // El estado de error es el que más se olvida en la revisión de accesibilidad, y es justo el que
    // hay que oír: `role="alert"` lo anuncia solo, sin que el usuario tenga que ir a buscarlo.
    await montarApiSiigo(page, { credenciales: [], getStatus: 500 });
    await loginAs(page, ADMIN_USER);
    await page.goto(RUTA_PAGINA);

    await expect(page.getByRole('alert').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /reintentar/i })).toBeVisible();

    esperarSinViolacionesGraves(await correrAxe(page), 'Siigo · credenciales (estado de error)');
  });
});
