// Épica #14678 «Organizar FLITO por áreas de la empresa» — PR 3: E2E del menú por áreas.
// Spec UX docs/ux/epica-14678-menu-por-areas.md §4 (estados, también en la paleta), §5 (paleta), §6 (permisos
// limitados) y §11 (deep links). Arquitectura docs/arquitectura/epica-14678-menu-por-areas.md §2.5-§2.6.
//
// Certifica:
//   · un rol limitado solo ve las opciones con entradas suyas (más Ayuda si tiene capítulos);
//   · landing: con `dashboard` se aterriza en `/`; sin él, en la PRIMERA entrada permitida de `NAV_ENTRADAS`
//     (no en la primera que pinta el menú: Organismos STT se presenta al final de Administración);
//   · deep links: la URL no cambia y resalta la opción nueva; en Kyverum el riel arranca en el subgrupo de la página;
//   · paleta: grupos por opción en SECTION_ORDER y Ayuda al final; subtítulo = subgrupo sin consulta y
//     «Opción · subgrupo» (o solo la opción) con consulta;
//   · paleta con `/permisos/mios` caído: «No se pudo cargar el menú.» con «Reintentar», sin entradas ni toast.
// PR 4 (arquitectura §4.9, AC5-AC8; spec UX «Áreas sin pantallas (Próximamente)»):
//   · un área sin entradas con su `menu.*` en `funciones` sale en el dock y el drawer con el aviso, sin enlaces;
//     sin el elemento no sale, y un área CON entradas sin páginas del usuario sigue oculta aunque tenga su elemento;
//   · la paleta no lista áreas vacías;
//   · cerrar un panel del dock no lo vuelve a montar (un solo montaje, sin parpadeo); con reduced-motion, al instante.
//
//   cd apps/web && QA_AXE_CDN=1 npx playwright test e2e/tests/shell-menu-por-areas.spec.ts --reporter=line
import type { Page } from '@playwright/test';
import { ELEMENTOS_PERMISOS } from '@operaciones/shared-types';
import { test, expect } from '../helpers/fixtures';
import { loginAs, sobreDeMios, funcionesDe, ADMIN_USER, FINANCIERA_USER, MENSAJERO_USER } from '../helpers/auth';
import { COPY_MENU_ERROR } from '../../src/components/shell/useEstadoMenu';
import { COPY_PROXIMAMENTE, COPY_PROXIMAMENTE_TEXTO, COPY_PROXIMAMENTE_TITULO } from '../../src/components/shell/sectionMeta';

/** El home (/) pinta <FlitoTablero>, que consume /flito/tablero como OBJETO (no lista). */
const TABLERO_VACIO = {
  soat: {}, impuestos: {}, revisionesPendientes: { soat: 0, impuestos: 0 },
  organismosSinClasificar: 0, tramitesRetenidos: 0, estancados: { soat: 0, impuestos: 0 },
  diferenciasDeValor: 0, compuertaHabilitados: 0,
};

/** Catch-all `[]` sin tapar la sesión ni los permisos (los mockea `loginAs`). */
async function mockApi(page: Page) {
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/auth/me') || url.includes('/permisos/mios')) return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.route('**/api/flito/tablero', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TABLERO_VACIO) }));
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Navegación principal' });
const opcion = (clave: string) => ELEMENTOS_PERMISOS.find((n) => n.codigo === `menu.${clave}`)!.nombre;
const OPCIONES = ['operaciones', 'financiera', 'gerencial', 'kyverum', 'administracion'] as const;

// Los roles `e2e_*` no tienen páginas por defecto (`sobreDeMe` une las del rol): solo ven lo de `allowedPages`.

/**
 * Toasts de `react-hot-toast` (montado en App.tsx): cada aviso es `role="status"` dentro del contenedor
 * `[data-rht-toaster]`. Se acota al toaster para no confundirlo con los `role="status"` de la página.
 */
const toasts = (page: Page) => page.locator('[data-rht-toaster]').getByRole('status');

async function listo(page: Page) {
  await expect(page.getByRole('button', { name: /^Buscar o ir a sección/ })).toBeVisible();
}

async function abrirPaleta(page: Page) {
  await page.getByRole('button', { name: /^Buscar o ir a sección/ }).click();
  const paleta = page.getByRole('dialog', { name: 'Paleta de comandos' });
  await expect(paleta).toBeVisible();
  return paleta;
}

/** Fila de la paleta cuyo nombre (el <strong>) es exactamente `nombre`. */
const fila = (paleta: ReturnType<Page['getByRole']>, nombre: string) =>
  paleta.getByRole('option').filter({ has: paleta.page().locator('strong').getByText(nombre, { exact: true }) });

// 1920 px: las seis opciones del admin caben en una fila con su nombre.
test.use({ viewport: { width: 1920, height: 900 } });

test.describe('Épica #14678 · permisos limitados (spec §6)', () => {
  test('rol solo con Financiera: ve Financiera y Ayuda; las opciones sin entradas suyas no aparecen', async ({ page }) => {
    await loginAs(page, { ...FINANCIERA_USER, role: 'e2e_solo_financiera', allowedPages: ['flito_bolsas', 'flito_tarifas', 'flito_comprobantes'] }, { funciones: [] });
    await mockApi(page);
    await page.goto('/flito/bolsas');
    await listo(page);

    await expect(nav(page).getByRole('button', { name: opcion('financiera'), exact: true })).toBeVisible();
    await expect(nav(page).getByRole('link', { name: opcion('ayuda'), exact: true })).toBeVisible();
    for (const clave of OPCIONES.filter((c) => c !== 'financiera')) {
      await expect(nav(page).getByRole('button', { name: opcion(clave), exact: true })).toHaveCount(0);
      await expect(nav(page).getByRole('link', { name: opcion(clave), exact: true })).toHaveCount(0);
    }
  });
});

test.describe('Épica #14678 · landing (arquitectura §2.6)', () => {
  test('con `dashboard` se aterriza en `/` (Tablero, en Gerencial)', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockApi(page);
    await page.goto('/');
    await listo(page);
    await expect(page).toHaveURL(/\/$/);
    await expect(nav(page).getByRole('button', { name: opcion('gerencial'), exact: true })).toHaveAttribute('aria-current', 'page');
  });

  test('sin `dashboard`: la primera entrada permitida de NAV_ENTRADAS, aunque el menú la pinte al final', async ({ page }) => {
    // Organismos STT va antes que Usuarios en NAV_ENTRADAS, aunque en el panel de Administración se pinte la última.
    await loginAs(page, { ...MENSAJERO_USER, role: 'e2e_solo_administracion', allowedPages: ['users', 'transito_organismos'] }, { funciones: [] });
    await mockApi(page);
    await page.goto('/');
    await expect(page).toHaveURL(/\/transito\/organismos$/);
    await listo(page);
    await expect(nav(page).getByRole('button', { name: opcion('administracion'), exact: true })).toHaveAttribute('aria-current', 'page');
  });
});

test.describe('Épica #14678 · deep links (spec §11)', () => {
  const CASOS = [
    { ruta: '/pesv/conductores', clave: 'kyverum' },
    { ruta: '/siigo/credenciales', clave: 'financiera' },
    { ruta: '/transito/organismos', clave: 'administracion' },
    { ruta: '/flito/torre/resumen', clave: 'gerencial' },
  ] as const;

  for (const { ruta, clave } of CASOS) {
    test(`${ruta} resalta ${clave} sin cambiar la URL ni abrir el panel`, async ({ page }) => {
      await loginAs(page, ADMIN_USER);
      await mockApi(page);
      await page.goto(ruta);
      await listo(page);
      await expect(page).toHaveURL(new RegExp(`${ruta.replaceAll('/', '\\/')}$`));
      const activa = nav(page).getByRole('button', { name: opcion(clave), exact: true });
      await expect(activa).toHaveAttribute('aria-current', 'page');
      await expect(activa).toHaveAttribute('aria-expanded', 'false');
      for (const otra of OPCIONES.filter((c) => c !== clave)) {
        await expect(nav(page).getByRole('button', { name: opcion(otra), exact: true })).not.toHaveAttribute('aria-current', /.*/);
      }
    });
  }

  test('/pesv/conductores: al abrir Kyverum el riel arranca en PESV', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockApi(page);
    await page.goto('/pesv/conductores');
    await listo(page);
    await nav(page).getByRole('button', { name: opcion('kyverum'), exact: true }).click();
    await expect(page.getByRole('tab', { name: 'PESV', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'Tránsito', exact: true })).toHaveAttribute('aria-selected', 'false');
  });
});

test.describe('Épica #14678 · paleta de comandos (spec §5)', () => {
  test('grupos por opción en el orden del menú, con Ayuda al final', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockApi(page);
    await page.goto('/');
    await listo(page);
    const paleta = await abrirPaleta(page);
    const grupos = await paleta.getByRole('group').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    expect(grupos).toEqual([...OPCIONES, 'ayuda'].map(opcion));
  });

  test('sin consulta el subtítulo es el subgrupo; con consulta, «Opción · subgrupo» o solo la opción', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockApi(page);
    await page.goto('/');
    await listo(page);
    const paleta = await abrirPaleta(page);

    await expect(fila(paleta, 'Remesas').locator('small')).toHaveText('RNDC');
    await expect(fila(paleta, 'Resumen 360°').locator('small')).toHaveText('Torre de Control');
    // Financiera no tiene subgrupos: la fila no lleva subtítulo.
    await expect(fila(paleta, 'Integración con Siigo').locator('small')).toHaveCount(0);

    const buscar = paleta.getByRole('combobox', { name: 'Buscar' });
    await buscar.fill('remesas');
    await expect(fila(paleta, 'Remesas').locator('small')).toHaveText(`${opcion('kyverum')} · RNDC`);
    await buscar.fill('resumen 360');
    await expect(fila(paleta, 'Resumen 360°').locator('small')).toHaveText(`${opcion('gerencial')} · Torre de Control`);
    await buscar.fill('credenciales');
    await expect(fila(paleta, 'Integración con Siigo').locator('small')).toHaveText(opcion('financiera'));
  });
});

test.describe('Épica #14678 · paleta con el menú en error (spec §4)', () => {
  test('si falla /permisos/mios: «No se pudo cargar el menú.» con «Reintentar», sin entradas; al reintentar las lista', async ({ page }) => {
    let falla = true;
    await loginAs(page, ADMIN_USER, { funciones: null });
    await page.route(/\/api\/permisos\/mios$/, (route) => (falla
      ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"x"}' })
      : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sobreDeMios(ADMIN_USER)) })));
    await mockApi(page);
    // Un toast de duración por defecto se va en segundos: un aserto puntual llegaría tarde. El observador cuenta
    // cada aviso que `react-hot-toast` monte en su contenedor durante toda la vida del documento.
    await page.addInitScript(() => {
      const w = window as unknown as { __toastsVistos: number };
      w.__toastsVistos = 0;
      const vistos = new WeakSet<Element>();
      const contar = (el: Element) => {
        const candidatos = [el, ...Array.from(el.querySelectorAll('[role="status"]'))];
        for (const c of candidatos) {
          if (c.matches('[role="status"]') && c.closest('[data-rht-toaster]') && !vistos.has(c)) {
            vistos.add(c);
            w.__toastsVistos += 1;
          }
        }
      };
      new MutationObserver((cambios) => {
        for (const cambio of cambios) {
          cambio.addedNodes.forEach((n) => { if (n instanceof Element) contar(n); });
        }
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto('/');
    await listo(page);

    const paleta = await abrirPaleta(page);
    await expect(paleta.getByRole('alert')).toHaveText(COPY_MENU_ERROR);
    await expect(paleta.getByRole('option')).toHaveCount(0);
    await expect(paleta.getByRole('group')).toHaveCount(0);
    await expect(paleta.getByText(/resultados?$/)).toHaveCount(0);
    // Enter no navega a ninguna entrada.
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/$/);
    await expect(toasts(page)).toHaveCount(0);
    // Ningún toast en todo el tramo en error, ni siquiera uno que ya se haya ido.
    expect(await page.evaluate(() => (window as unknown as { __toastsVistos?: number }).__toastsVistos ?? 0)).toBe(0);

    falla = false;
    await paleta.getByRole('button', { name: 'Reintentar', exact: true }).click();
    await expect(paleta.getByRole('alert')).toHaveCount(0);
    await expect(paleta.getByRole('group', { name: opcion('operaciones') })).toBeVisible();
    await expect(nav(page).getByRole('alert')).toHaveCount(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PR 4 — áreas sin pantallas (Próximamente) y cierre del panel sin parpadeo.

const ADMIN_CON_COMERCIAL = { funciones: [...funcionesDe(ADMIN_USER), 'menu.comercial'] };
const SOLO_FINANCIERA = { ...FINANCIERA_USER, role: 'e2e_solo_financiera', allowedPages: ['flito_bolsas', 'flito_tarifas', 'flito_comprobantes'] };
const DESCRIPCION_PROXIMAMENTE = `${COPY_PROXIMAMENTE_TITULO} ${COPY_PROXIMAMENTE_TEXTO}`;

/** Las opciones de la fila del dock, en el orden en que se pintan. */
const ordenDelDock = (page: Page) => nav(page).locator(':scope > .dock__grupo, :scope > a.dock__item')
  .evaluateAll((els) => els.map((e) => e.getAttribute('data-seccion')));

test.describe('Épica #14678 PR 4 · área sin pantallas en el dock (AC5)', () => {
  test('con menu.comercial: «Comercial» entre Financiera y Gerencial; el panel dice «Próximamente», sin enlaces', async ({ page }) => {
    await loginAs(page, ADMIN_USER, ADMIN_CON_COMERCIAL);
    await mockApi(page);
    await page.goto('/');
    await listo(page);

    const orden = await ordenDelDock(page);
    expect(orden.indexOf('comercial')).toBe(orden.indexOf('financiera') + 1);
    expect(orden.indexOf('gerencial')).toBe(orden.indexOf('comercial') + 1);

    const boton = nav(page).getByRole('button', { name: opcion('comercial'), exact: true });
    // Cerrado, el lector de pantalla ya oye el aviso (texto `hidden` referenciado por aria-describedby).
    await expect(boton).toHaveAccessibleDescription(DESCRIPCION_PROXIMAMENTE);
    await boton.click();
    await expect(boton).toHaveAttribute('aria-expanded', 'true');
    const panel = page.locator('#flit-navbar-panel-comercial');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.dock__cabeza strong')).toHaveText(opcion('comercial'));
    await expect(panel.locator('.dock__cabeza small')).toHaveText(COPY_PROXIMAMENTE);
    await expect(panel.locator('.dock-proximamente__titulo')).toHaveText(COPY_PROXIMAMENTE_TITULO);
    await expect(panel.locator('.dock-proximamente__texto')).toHaveText(COPY_PROXIMAMENTE_TEXTO);
    await expect(panel.getByRole('link')).toHaveCount(0);
    await expect(panel.getByRole('button')).toHaveCount(0);
    // Abierto, la descripción es el cuerpo del panel.
    await expect(boton).toHaveAccessibleDescription(DESCRIPCION_PROXIMAMENTE);
    // Ancho base del kit (320 px), no el de un área llena (880 px).
    expect((await panel.boundingBox())!.width).toBeLessThanOrEqual(330);

    await page.keyboard.press('Escape');
    await expect(boton).toHaveAttribute('aria-expanded', 'false');
    await expect(boton).toBeFocused();
  });

  test('sin menu.comercial, «Comercial» no aparece', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockApi(page);
    await page.goto('/');
    await listo(page);
    await expect(nav(page).getByRole('button', { name: opcion('gerencial'), exact: true })).toBeVisible();
    await expect(nav(page).getByRole('button', { name: opcion('comercial'), exact: true })).toHaveCount(0);
  });

  test('un área CON entradas y sin páginas del usuario sigue oculta aunque tenga su elemento', async ({ page }) => {
    await loginAs(page, SOLO_FINANCIERA, { funciones: ['menu.operaciones', 'menu.comercial'] });
    await mockApi(page);
    await page.goto('/flito/bolsas');
    await listo(page);
    await expect(nav(page).getByRole('button', { name: opcion('financiera'), exact: true })).toBeVisible();
    await expect(nav(page).getByRole('button', { name: opcion('comercial'), exact: true })).toBeVisible();
    await expect(nav(page).locator('[data-seccion="operaciones"]')).toHaveCount(0);
  });
});

test.describe('Épica #14678 PR 4 · área sin pantallas en el drawer (AC6)', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('375 px: «Comercial» sin cantidad; al desplegarla, el aviso sin enlaces', async ({ page }) => {
    await loginAs(page, ADMIN_USER, ADMIN_CON_COMERCIAL);
    await mockApi(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Abrir menú de navegación' }).click();
    const menu = page.getByRole('dialog', { name: 'Menú de navegación' });
    const fila = menu.locator('li[data-seccion="comercial"]');
    const boton = fila.getByRole('button', { name: opcion('comercial'), exact: true });
    await expect(boton).toBeVisible();
    await expect(fila.locator('.menu-lateral__cuenta')).toHaveCount(0);
    await expect(boton).toHaveAttribute('aria-expanded', 'false');
    await boton.click();
    await expect(boton).toHaveAttribute('aria-expanded', 'true');
    const aviso = fila.locator('.menu-lateral__proximamente');
    await expect(aviso).toBeVisible();
    await expect(aviso.locator('.dock-proximamente__titulo')).toHaveText(COPY_PROXIMAMENTE_TITULO);
    await expect(aviso.locator('.dock-proximamente__texto')).toHaveText(COPY_PROXIMAMENTE_TEXTO);
    await expect(fila.getByRole('link')).toHaveCount(0);
    await expect(boton).toHaveAccessibleDescription(DESCRIPCION_PROXIMAMENTE);
    // Sin desborde horizontal a 375 px.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  });
});

test.describe('Épica #14678 PR 4 · la paleta no lista áreas vacías (AC7)', () => {
  test('con menu.comercial, la paleta no tiene grupo «Comercial»', async ({ page }) => {
    await loginAs(page, ADMIN_USER, ADMIN_CON_COMERCIAL);
    await mockApi(page);
    await page.goto('/');
    await listo(page);
    const paleta = await abrirPaleta(page);
    const grupos = await paleta.getByRole('group').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    expect(grupos).toEqual([...OPCIONES, 'ayuda'].map(opcion));
    await expect(paleta.getByRole('group', { name: opcion('comercial') })).toHaveCount(0);
  });
});

test.describe('Épica #14678 PR 4 · cierre del panel del dock sin parpadeo (AC8, arquitectura §4.7)', () => {
  /**
   * Cuenta cada vez que se MONTA un nodo `[data-grupo="financiera"]` durante la vida del documento. Con el
   * `useEffect` de antes, cerrar desmontaba el panel un fotograma y lo volvía a montar como nodo nuevo: 2 montajes.
   */
  async function contarMontajes(page: Page) {
    await page.addInitScript(() => {
      const w = window as unknown as { __montajesPanel: number };
      w.__montajesPanel = 0;
      new MutationObserver((cambios) => {
        for (const c of cambios) {
          c.addedNodes.forEach((n) => {
            if (!(n instanceof Element)) return;
            if (n.matches('[data-grupo="financiera"]')) w.__montajesPanel += 1;
            w.__montajesPanel += n.querySelectorAll('[data-grupo="financiera"]').length;
          });
        }
      }).observe(document, { childList: true, subtree: true });
    });
  }
  const montajes = (page: Page) => page.evaluate(() => (window as unknown as { __montajesPanel: number }).__montajesPanel);

  test('al cerrar, el panel se funde y desaparece sin volver a montarse: un solo montaje', async ({ page }) => {
    await contarMontajes(page);
    await loginAs(page, ADMIN_USER);
    await mockApi(page);
    await page.goto('/');
    await listo(page);
    const boton = nav(page).getByRole('button', { name: opcion('financiera'), exact: true });
    const panel = page.locator('[data-grupo="financiera"]');

    await boton.click();
    await expect(panel).toBeVisible();
    expect(await montajes(page)).toBe(1);

    await boton.click();
    await expect(boton).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toHaveCount(0);
    expect(await montajes(page)).toBe(1);
  });

  test('al cerrar, el primer cambio del nodo vivo es su clase de salida, no su desmontaje', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await mockApi(page);
    await page.goto('/');
    await listo(page);
    const boton = nav(page).getByRole('button', { name: opcion('financiera'), exact: true });
    await boton.click();
    const panel = page.locator('[data-grupo="financiera"]');
    await expect(panel).toBeVisible();
    await panel.evaluate((el) => {
      const w = window as unknown as { __primerCambio: string | null };
      w.__primerCambio = null;
      new MutationObserver((cambios) => {
        for (const c of cambios) {
          if (w.__primerCambio) return;
          if (c.type === 'attributes' && c.target === el && el.classList.contains('dock__menu--saliendo')) w.__primerCambio = 'clase';
          else if (c.type === 'childList' && Array.from(c.removedNodes).includes(el)) w.__primerCambio = 'desmontado';
        }
      }).observe(el.parentElement!, { childList: true, attributes: true, subtree: true, attributeFilter: ['class'] });
    });
    await boton.click();
    await expect(panel).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __primerCambio: string | null }).__primerCambio)).toBe('clase');
  });

  test('con reduced-motion se oculta al instante, sin fundido', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await contarMontajes(page);
    await loginAs(page, ADMIN_USER);
    await mockApi(page);
    await page.goto('/');
    await listo(page);
    const boton = nav(page).getByRole('button', { name: opcion('financiera'), exact: true });
    const panel = page.locator('[data-grupo="financiera"]');
    await boton.click();
    await expect(panel).toBeVisible();
    await boton.click();
    // Sin espera: tras el clic el panel ya no está (ni con la clase de salida).
    expect(await panel.count()).toBe(0);
    expect(await montajes(page)).toBe(1);
  });
});
