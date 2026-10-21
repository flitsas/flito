// HU #13767 — Dr. Flit: conversación que dura la sesión, «Terminar chat» y borrado al cerrar sesión
// (Feature #13694). Spec UX: docs/ux/flito-dr-flit.md · slim: docs/diseno/feature-13694-dr-flit-panel-slim.md §4–§5
// Un test por AC. La parte pura importa `serializar` / `restaurar` desde `src`; la UI recorre el panel real.
import { test, expect, type Page } from '@playwright/test';
import { loginAs, ADMIN_USER, FINANCIERA_USER } from '../helpers/ayuda-fixtures';
import {
  MAX_MENSAJES, restaurar, serializar, VERSION_CONVERSACION, type MensajeDrFlit,
} from '../../src/lib/drFlitConversacion';
import { claveConversacion, PREFIJO_DRFLIT } from '../../src/lib/drFlitAlmacen';

// Financiera con Gestión Trámites habilitado por usuario y sin «Integración con Siigo».
const FINANCIERA_CON_TRAMITES = { ...FINANCIERA_USER, allowedPages: ['flito_tramites', 'flito_conciliacion'] };
const CLAVE = claveConversacion(FINANCIERA_USER.id);
const MD_SIIGO_CRED = /siigo_credenciales\.md/;

const panel = (page: Page) => page.getByRole('complementary', { name: 'Dr. Flit' });
const conversacion = (page: Page) => panel(page).getByRole('log', { name: 'Conversación con Dr. Flit' });
const caja = (page: Page) => panel(page).getByLabel('Escriba su pregunta');
const lista = (page: Page) => panel(page).getByRole('group', { name: '¿Qué módulo quiere conocer?' });
const terminarChat = (page: Page) => panel(page).getByRole('button', { name: 'Terminar chat' });
const mensajesUsuario = (page: Page) => conversacion(page).getByText(/^Usted: /);

async function abrirPanel(page: Page) {
  await page.getByRole('button', { name: 'Abrir Dr. Flit' }).click();
  await expect(panel(page)).toBeVisible();
}

async function entrar(page: Page, user: Parameters<typeof loginAs>[1] = FINANCIERA_CON_TRAMITES) {
  await loginAs(page, user);
  await page.goto('/');
  await abrirPanel(page);
}

async function preguntar(page: Page, texto: string) {
  await caja(page).fill(texto);
  await caja(page).press('Enter');
}

/** Pregunta con citas + «Explícame Gestión Trámites»: la conversación base de AC1, AC2 y AC4. */
async function conversar(page: Page) {
  await preguntar(page, '¿cómo se entra a trámites?');
  await expect(conversacion(page).getByText('Esto es lo que encontré en sus manuales:')).toBeVisible();
  await panel(page).getByRole('button', { name: 'Explícame un módulo' }).first().click();
  await lista(page).getByRole('button', { name: 'Gestión Trámites', exact: true }).click();
  await expect(conversacion(page).getByRole('link', { name: 'Abrir la ficha de Gestión Trámites' })).toBeVisible();
}

const guardado = (page: Page) =>
  page.evaluate((prefijo) => Object.fromEntries(
    Object.keys(sessionStorage).filter((k) => k.startsWith(prefijo)).map((k) => [k, sessionStorage.getItem(k)]),
  ), PREFIJO_DRFLIT);

const sembrar = (page: Page, clave: string, valor: string) =>
  page.evaluate(([k, v]) => sessionStorage.setItem(k, v), [clave, valor] as const);

const pregunta = (i: number, texto = `pregunta ${i}`): MensajeDrFlit =>
  ({ id: `m${i}`, ts: 1_700_000_000_000 + i, de: 'usuario', tipo: 'pregunta', texto });

/** Tras una salida de sesión: nada de Dr. Flit en la pestaña y el siguiente usuario ve el saludo. */
async function otroUsuarioVePanelVacio(page: Page) {
  expect(await guardado(page)).toEqual({});
  await loginAs(page, ADMIN_USER);
  await page.goto('/');
  await abrirPanel(page);
  await expect(conversacion(page).getByText('¿Por dónde empezamos?')).toBeVisible();
  await expect(mensajesUsuario(page)).toHaveCount(0);
  await expect(terminarChat(page)).toHaveCount(0);
  expect(await guardado(page)).toEqual({});
}

test.describe('HU #13767 · Dr. Flit — conversación de la sesión', () => {
  test('AC1 · pregunta + explicación → cambiar de pantalla y recargar → la misma conversación con citas y enlaces', async ({ page }) => {
    await entrar(page);
    await conversar(page);
    // F5 justo al llegar a Ayuda, con el `/auth/me` del documento anterior aún en vuelo: el navegador
    // lo aborta al descargar y eso NO puede barrer la conversación (retrabajo QA B, HU #13767). El
    // retraso hace la carrera determinista.
    await page.route('**/api/auth/me', async (route) => {
      await new Promise((r) => setTimeout(r, 1_500));
      await route.fallback();
    });
    const enVuelo = page.waitForRequest('**/api/auth/me');
    await page.goto('/flito/ayuda');
    await enVuelo;
    await page.reload();
    await abrirPanel(page);
    await expect(conversacion(page).getByText('Usted: ¿cómo se entra a trámites?')).toBeVisible();
    await expect(conversacion(page).getByText('Usted: Explíqueme Gestión Trámites')).toBeVisible();
    await expect(conversacion(page).getByRole('listitem').getByRole('link').first())
      .toHaveAttribute('href', '/flito/ayuda/flito_tramites#como-se-entra');
    await expect(conversacion(page).getByRole('link', { name: 'Abrir la ficha de Gestión Trámites' }))
      .toHaveAttribute('href', '/flito/ayuda/flito_tramites');
    await expect(conversacion(page).getByText('Dr. Flit está buscando…')).toHaveCount(0);
  });

  test('AC1 · una pregunta hecha nada más abrir tras recargar se suma a lo guardado, no lo pisa', async ({ page }) => {
    await loginAs(page, FINANCIERA_CON_TRAMITES);
    await sembrar(page, CLAVE, serializar([pregunta(1, 'pregunta anterior')]));
    await page.goto('/flito/ayuda');
    await abrirPanel(page);
    await preguntar(page, 'zzqxwv');
    await expect(conversacion(page).getByText(/^No encontré nada sobre/)).toBeVisible();
    await expect(mensajesUsuario(page)).toHaveCount(2);
    const dato = JSON.parse((await guardado(page))[CLAVE] as string) as { mensajes: MensajeDrFlit[] };
    expect(dato.mensajes.map((m) => (m.tipo === 'pregunta' ? m.texto : m.tipo)))
      .toEqual(['pregunta anterior', 'zzqxwv', 'sinResultados']);
  });

  test('AC2 · «Terminar chat» + confirmar → se borra del panel y del almacenamiento y vuelve la bienvenida', async ({ page }) => {
    await entrar(page);
    await expect(terminarChat(page)).toHaveCount(0);
    await conversar(page);
    expect(Object.keys(await guardado(page))).toEqual([CLAVE]);

    // Esc y «Cancelar» no borran nada; el foco empieza en «Cancelar».
    await terminarChat(page).click();
    const confirmacion = panel(page).getByRole('group', { name: '¿Terminar el chat?' });
    await expect(confirmacion).toBeVisible();
    await expect(confirmacion.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(confirmacion).toHaveCount(0);
    await expect(panel(page)).toBeVisible();
    await expect(terminarChat(page)).toBeFocused();

    await terminarChat(page).click();
    await confirmacion.getByRole('button', { name: 'Sí, terminar' }).click();
    await expect(mensajesUsuario(page)).toHaveCount(0);
    await expect(conversacion(page).getByText('¿Por dónde empezamos?')).toBeVisible();
    await expect(panel(page).getByRole('status').filter({ hasText: 'Conversación terminada.' })).toBeAttached();
    await expect(panel(page).getByRole('heading', { name: 'Dr. Flit' })).toBeFocused();
    await expect(terminarChat(page)).toHaveCount(0);
    expect(await guardado(page)).toEqual({});
    await page.reload();
    await abrirPanel(page);
    await expect(mensajesUsuario(page)).toHaveCount(0);
  });

  test('AC3 · «Cerrar sesión», 401, arranque sin token y /auth/me caído → el siguiente usuario ve el panel sin conversación', async ({ page }) => {
    const conversacionGuardada = serializar([pregunta(1, 'algo de la sesión anterior')]);

    // 1. «Cerrar sesión» desde el menú de usuario.
    await entrar(page);
    await sembrar(page, CLAVE, conversacionGuardada);
    await page.getByRole('button', { name: /Menú de usuario/ }).click();
    await page.getByRole('menuitem', { name: 'Cerrar sesión' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await otroUsuarioVePanelVacio(page);

    // 2. Expiración del token: una petición autenticada responde 401 (SESSION_ENDED).
    await entrar(page);
    await sembrar(page, CLAVE, conversacionGuardada);
    await page.route(/\/api\/permisos\/mios$/, (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Sesión expirada"}' }));
    await page.reload();
    await expect(page).toHaveURL(/\/login/);
    await page.unroute(/\/api\/permisos\/mios$/);
    await otroUsuarioVePanelVacio(page);

    // 3. Token que ya no sirve al arrancar (/auth/me falla sin 401).
    await entrar(page);
    await sembrar(page, CLAVE, conversacionGuardada);
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 502, body: '' }));
    await page.reload();
    await expect(page).toHaveURL(/\/login/);
    await page.unroute('**/api/auth/me');
    await otroUsuarioVePanelVacio(page);
  });

  test('AC3 · la pestaña arranca sin token → se barre la conversación y el siguiente usuario ve el panel vacío', async ({ page }) => {
    // Sin `loginAs` previo: ningún init script repone el token en esta pestaña.
    await page.goto('/login');
    await sembrar(page, CLAVE, serializar([pregunta(1, 'algo de la sesión anterior')]));
    await sembrar(page, `${PREFIJO_DRFLIT}otra-cosa`, 'x');
    await page.reload();
    await expect(page).toHaveURL(/\/login$/);
    await expect.poll(() => guardado(page)).toEqual({});
    await otroUsuarioVePanelVacio(page);
  });

  test('AC4 · sessionStorage solo con mensajes del usuario y {clave, ancla}; nada de fichas ni en localStorage', async ({ page }) => {
    await entrar(page);
    await conversar(page);
    const todo = await guardado(page);
    expect(Object.keys(todo)).toEqual([CLAVE]);
    const crudo = todo[CLAVE] as string;
    const dato = JSON.parse(crudo) as { v: number; mensajes: Record<string, unknown>[] };
    expect(dato.v).toBe(VERSION_CONVERSACION);
    const permitidas = new Set(['id', 'ts', 'de', 'tipo', 'texto', 'clave', 'ref', 'respondeA', 'refs']);
    for (const m of dato.mensajes) {
      expect(Object.keys(m).every((k) => permitidas.has(k))).toBe(true);
      const refs = (m.refs ?? (m.ref ? [m.ref] : [])) as Record<string, unknown>[];
      for (const r of refs) expect(Object.keys(r).every((k) => k === 'clave' || k === 'ancla')).toBe(true);
    }
    expect(dato.mensajes.map((m) => m.tipo)).toEqual(['pregunta', 'citas', 'modulo', 'explicacion']);
    // Ni títulos (se derivan al pintar), ni el resumen ni el cuerpo de la ficha.
    const resumen = await conversacion(page).locator('p', { hasText: /^Gestión Trámites$/ })
      .locator('xpath=following-sibling::p[1]').textContent();
    expect(resumen?.length ?? 0).toBeGreaterThan(0);
    for (const prohibido of ['Gestión Trámites', 'Cómo se entra', resumen as string]) expect(crudo).not.toContain(prohibido);
    const locales = await page.evaluate((p) => Object.keys(localStorage).filter((k) => k.startsWith(p) || k.includes('drflit')), PREFIJO_DRFLIT);
    expect(locales).toEqual([]);
  });

  test('AC5 · cita a ficha sin permiso o ancla inexistente → «Esta referencia ya no está disponible», sin título ni enlace', async ({ page }) => {
    const pedidas: string[] = [];
    page.on('request', (r) => pedidas.push(r.url()));
    await loginAs(page, FINANCIERA_CON_TRAMITES);
    const base = { de: 'drflit', ts: 1_700_000_000_000 } as const;
    await sembrar(page, CLAVE, serializar([
      pregunta(1, '¿credenciales?'),
      { ...base, id: 'r1', tipo: 'citas', respondeA: 'm1', refs: [
        { clave: 'siigo_credenciales', ancla: 'como-se-entra' },
        { clave: 'flito_tramites', ancla: 'seccion-que-ya-no-existe' },
        { clave: 'flito_tramites', ancla: 'como-se-entra' },
      ] },
      { id: 'm2', ts: 1_700_000_000_001, de: 'usuario', tipo: 'modulo', clave: 'siigo_credenciales' },
      { ...base, id: 'r2', tipo: 'explicacion', ref: { clave: 'siigo_credenciales' } },
    ]));
    await page.goto('/');
    await abrirPanel(page);
    await expect(conversacion(page).getByText(/^Esta referencia ya no está disponible\.?$/)).toHaveCount(3);
    const enlaces = conversacion(page).getByRole('listitem').getByRole('link');
    await expect(enlaces).toHaveCount(1);
    await expect(enlaces).toHaveAttribute('href', '/flito/ayuda/flito_tramites#como-se-entra');
    await expect(conversacion(page).locator('a[href*="siigo_credenciales"]')).toHaveCount(0);
    // El título de la ficha sin permiso no se pinta (la burbuja del usuario sí dice qué pidió).
    await expect(conversacion(page).getByText(/^Integración con Siigo$/)).toHaveCount(0);
    expect(pedidas.some((u) => MD_SIIGO_CRED.test(u))).toBe(false);
  });

  test('AC6 · corrupto, versión anterior o sessionStorage bloqueado → bienvenida o memoria, sin error', async ({ page }) => {
    // Puro: ilegible y `v` distinta → []; un mensaje roto se descarta y el resto sobrevive.
    expect(restaurar('{no es json')).toEqual([]);
    expect(restaurar(JSON.stringify({ v: 0, mensajes: [pregunta(1)] }))).toEqual([]);
    expect(restaurar(JSON.stringify({ v: 1, mensajes: [pregunta(1), { id: 'x', ts: 1, de: 'drflit', tipo: 'desconocido' },
      { ...pregunta(2), texto: 'a'.repeat(301) }, { id: 'y', ts: 1, de: 'usuario', tipo: 'modulo', clave: 'no-existe' }] })))
      .toEqual([pregunta(1)]);

    const errores: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errores.push(m.text()); });
    page.on('pageerror', (e) => errores.push(e.message));

    for (const valor of ['{no es json', JSON.stringify({ v: 0, mensajes: [pregunta(1)] })]) {
      await loginAs(page, FINANCIERA_CON_TRAMITES);
      await sembrar(page, CLAVE, valor);
      await page.goto('/');
      await abrirPanel(page);
      await expect(conversacion(page).getByText('¿Por dónde empezamos?')).toBeVisible();
      await expect(mensajesUsuario(page)).toHaveCount(0);
      await expect(panel(page).getByText(/No pude|error/i)).toHaveCount(0);
      expect(await guardado(page)).toEqual({});
    }

    // Almacenamiento bloqueado: el accesor lanza. La conversación vive en memoria.
    await page.addInitScript(() => {
      Object.defineProperty(window, 'sessionStorage', { configurable: true, get() { throw new DOMException('bloqueado', 'SecurityError'); } });
    });
    await page.goto('/');
    await abrirPanel(page);
    await preguntar(page, '¿cómo se entra a trámites?');
    await expect(conversacion(page).getByText('Esto es lo que encontré en sus manuales:')).toBeVisible();
    await expect(mensajesUsuario(page)).toHaveCount(1);
    expect(errores.filter((e) => /drflit|Dr\. Flit|sessionStorage|bloqueado/i.test(e))).toEqual([]);
  });

  test('AC7 · más de 50 mensajes → solo los 50 más recientes; el texto tal cual, sin red ni consola', async ({ page }) => {
    // Puro: 60 → los 50 últimos, en orden.
    const sesenta = Array.from({ length: 60 }, (_, i) => pregunta(i));
    const recortada = JSON.parse(serializar(sesenta)) as { mensajes: MensajeDrFlit[] };
    expect(recortada.mensajes).toHaveLength(MAX_MENSAJES);
    expect(recortada.mensajes.map((m) => m.id)).toEqual(sesenta.slice(-MAX_MENSAJES).map((m) => m.id));

    // UI: 49 guardados + pregunta + respuesta = 51 → se guardan los 50 más recientes.
    const MARCA = 'zzqx «quokka» "ñandúzz" <zzb>';
    const fugas: string[] = [];
    page.on('request', (r) => { if (`${r.url()} ${r.postData() ?? ''}`.includes('quokka')) fugas.push(r.url()); });
    page.on('console', (m) => { if (m.text().includes('quokka')) fugas.push(m.text()); });
    await loginAs(page, FINANCIERA_CON_TRAMITES);
    await sembrar(page, CLAVE, serializar(Array.from({ length: 49 }, (_, i) => pregunta(i))));
    await page.goto('/');
    await abrirPanel(page);
    await expect(mensajesUsuario(page)).toHaveCount(49);
    await preguntar(page, MARCA);
    await expect(conversacion(page).getByText(/^No encontré nada sobre/)).toBeVisible();
    const dato = JSON.parse((await guardado(page))[CLAVE] as string) as { mensajes: MensajeDrFlit[] };
    expect(dato.mensajes).toHaveLength(MAX_MENSAJES);
    expect(dato.mensajes[0].id).toBe('m1');
    const ultima = dato.mensajes[MAX_MENSAJES - 2];
    expect(ultima.tipo === 'pregunta' && ultima.texto).toBe(MARCA);
    expect(dato.mensajes[MAX_MENSAJES - 1].tipo).toBe('sinResultados');
    expect(page.url()).not.toContain('quokka');
    expect(fugas).toEqual([]);
  });
});
