// Ayuda FLITO — menú y NoAccess (HU #11893, AC1 y AC2).
import { test, expect } from '../helpers/fixtures';
import {
  loginAs, abrirAyuda, buscarFichas, OPERACIONES_USER, PROVEEDOR_USER, CONDUCTOR_USER, COMPLIANCE_USER, FINANCIERA_USER, SIN_CATALOGO,
} from '../helpers/ayuda-fixtures';

test.describe('FLITO — Ayuda · acceso', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  // HU #13431: «Ayuda» es su propio elemento del menú, el último, y con un solo ítem se pinta como
  // enlace directo (no hay disclosure «General» que abrir).
  test('AC1 — proveedor ve Ayuda FLITO como último elemento del menú y navega', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Buscar o ir a secci/ })).toBeVisible();

    const nav = page.getByRole('navigation', { name: 'Navegación principal' });
    const enlace = nav.getByRole('link', { name: 'Ayuda', exact: true });
    await expect(enlace).toBeVisible();
    await expect(nav.getByRole('link').last()).toHaveAccessibleName('Ayuda');
    await expect(enlace).toHaveAttribute('href', '/flito/ayuda');
    await enlace.click();
    await expect(page).toHaveURL(/\/flito\/ayuda$/);
    await expect(page.getByRole('heading', { name: 'Ayuda FLITO', exact: true })).toBeVisible();
  });

  test('AC1 — proveedor también la encuentra en el Command Palette', async ({ page }) => {
    await loginAs(page, PROVEEDOR_USER);
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Buscar o ir a secci/ })).toBeVisible();
    await page.keyboard.press('Control+k');
    await page.getByPlaceholder('Buscar o ir a…').fill('ayuda');
    await expect(page.getByRole('option', { name: /^Ayuda/ })).toBeVisible();
  });

  test('AC1 — admin ve el ítem (Object.keys no es el gate; el helper sí)', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Navegación principal' });
    await expect(nav.getByRole('link', { name: 'Ayuda', exact: true })).toBeVisible();
  });

  // HU #13775: la ficha «Tablero de control» cuelga de `dashboard`, que todos los roles del sistema salvo `cliente`
  // tienen de partida (`ROLE_DEFAULT_PAGES`). Los que eran «sin catálogo» (conductor, tránsito, líder PESV y
  // supervisor de flota; Cumplimiento ya salió en la HU #13774) pasan a ver Ayuda, con esa ficha en General.
  for (const usuario of SIN_CATALOGO.filter((u) => u.role !== COMPLIANCE_USER.role)) {
    test(`HU #13775 — ${usuario.role} ya ve Ayuda: el ítem y la ficha «Tablero de control»`, async ({ page }) => {
      await loginAs(page, usuario);
      await page.goto('/flito/ayuda');
      const nav = page.getByRole('navigation', { name: 'Navegación principal' });
      await expect(nav.getByRole('link', { name: 'Ayuda', exact: true })).toBeVisible();
      await expect(page.getByText('Su usuario aún no tiene módulos con ayuda')).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Abrir ficha de Tablero de control' })).toBeVisible();
    });
  }

  // HU #13704 AC7 (P9-3a): quien no tiene ninguna pantalla con ficha no ve el ítem, y la URL directa da el vacío
  // «Su usuario aún no tiene módulos con ayuda» con salida al inicio. Desde la HU #13775 ningún rol del sistema
  // llega aquí de partida; el caso es un rol creado por el administrador sin `dashboard` (sus páginas son solo
  // las que se le dieron).
  const ROL_PROPIO_SIN_FICHAS = {
    id: 25, username: 'e2e_ayuda_rol_propio', name: 'Rol propio Ayuda E2E', role: 'rol_propio_e2e', allowedPages: ['pesv'],
  };
  test('AC2 — sin ninguna pantalla con ficha no ve el ítem; /flito/ayuda muestra el vacío sin módulos (HU #13704 AC7)', async ({ page }) => {
    await loginAs(page, ROL_PROPIO_SIN_FICHAS);
    await page.goto('/flito/ayuda');
    await expect(page.getByRole('navigation', { name: 'Navegación principal' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Su usuario aún no tiene módulos con ayuda' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Volver al inicio' })).toHaveAttribute('href', '/');
    await expect(page.getByRole('heading', { name: /no tienes acceso a ayuda flito/i })).toHaveCount(0);
    await expect(page.getByRole('searchbox', { name: 'Buscar fichas' })).toHaveCount(0);
    await expect(page).toHaveURL(/\/flito\/ayuda$/);
    await expect(page.getByRole('link', { name: 'Ayuda', exact: true })).toHaveCount(0);

    await page.keyboard.press('Control+k');
    await page.getByPlaceholder('Buscar o ir a…').fill('ayuda');
    await expect(page.getByRole('option', { name: /^Ayuda/ })).toHaveCount(0);
  });

  test('AC2 — conductor: la ficha de otra pantalla por URL sigue en NoAccess de esa pantalla', async ({ page }) => {
    await loginAs(page, CONDUCTOR_USER);
    await page.goto('/flito/ayuda/flito_bolsas');
    await expect(page.getByRole('heading', { name: /no tienes acceso a flito — bolsas/i })).toBeVisible();
    await expect(page.getByText('Su usuario aún no tiene módulos con ayuda')).toHaveCount(0);
  });
});

// HU #13774 — manuales del área Super Admin: cada ficha cuelga del permiso de su pantalla.
test.describe('FLITO — Ayuda · acceso a las fichas de Super Admin (HU #13774)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  const ADMINISTRACION = 'section[aria-labelledby="ayuda-grupo-administracion"] a';

  test('AC2 — con `privacy` ve Privacidad y datos y Log accesos PII, y nada más de Administración', async ({ page }) => {
    await abrirAyuda(page, COMPLIANCE_USER);
    const enlaces = page.locator(ADMINISTRACION);
    await expect(enlaces).toHaveCount(2);
    expect(await enlaces.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).toEqual([
      'Abrir ficha de Log accesos PII', 'Abrir ficha de Privacidad y datos',
    ]);

    await page.getByRole('link', { name: 'Abrir ficha de Log accesos PII' }).click();
    await expect(page).toHaveURL(/\/flito\/ayuda\/privacy_log_pii$/);
    await expect(page.getByRole('heading', { name: 'Qué es', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ir a la pantalla Log accesos PII' })).toHaveAttribute('href', '/privacy/log-pii');

    await page.goto('/flito/ayuda/privacy');
    await expect(page.getByRole('heading', { name: 'Qué es', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ir a la pantalla Privacidad y datos' })).toHaveAttribute('href', '/privacy');
  });

  test('AC3 — sin el permiso no hay ficha: ni en el índice, ni buscando, ni por URL directa', async ({ page }) => {
    // Financiera tiene fichas (Finanzas) pero ninguna pantalla de Super Admin.
    await abrirAyuda(page, FINANCIERA_USER);
    await expect(page.locator('section[aria-labelledby="ayuda-grupo-finanzas"] a').first()).toBeVisible();
    await expect(page.locator(ADMINISTRACION)).toHaveCount(0);
    const fichas = /Abrir ficha de (Usuarios|Google Drive|Privacidad y datos|Log accesos PII)$/;
    for (const consulta of ['usuarios', 'Google Drive', 'anonimizar', 'accesos PII']) {
      await buscarFichas(page, consulta);
      await expect(page.getByRole('link', { name: fichas })).toHaveCount(0);
    }

    const sinAcceso: Array<[string, RegExp]> = [
      ['users', /no tienes acceso a usuarios/i],
      ['drive', /no tienes acceso a google drive/i],
      ['privacy', /no tienes acceso a privacidad y datos/i],
      ['privacy_log_pii', /no tienes acceso a privacidad y datos/i],
    ];
    for (const [clave, titulo] of sinAcceso) {
      await page.goto(`/flito/ayuda/${clave}`);
      await expect(page.getByRole('heading', { name: titulo }), clave).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Qué es', exact: true }), clave).toHaveCount(0);
    }
  });
});
