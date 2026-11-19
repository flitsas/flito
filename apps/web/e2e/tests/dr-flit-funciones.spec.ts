// HU #13942 — Dr. Flit según sus funciones (Feature #13696). Spec UX: docs/ux/flito-dr-flit-funciones.md
// Una combinación por caso: solo manuales, sin fichas, sin funciones, sin soporte, sin gestión,
// `sin-manuales` y el 403 `drflit-funcion-no-habilitada` con el panel abierto. El caso «con enlace»
// (AC1/AC6) vive en `dr-flit-panel.spec.ts`.
import { test, expect, type Page, type Route } from '@playwright/test';
import { loginAs, FINANCIERA_USER, ADMIN_USER } from '../helpers/ayuda-fixtures';
import { conDrFlit } from '../helpers/auth';

const M = 'drflit.manuales.ver';
const I = 'drflit.ia.usar';
const G = 'drflit.gestion.consultar';
const S = 'drflit.soporte.radicar';

const CON_TRAMITES = { ...FINANCIERA_USER, allowedPages: ['flito_tramites', 'flito_conciliacion'], funciones: ['tramites.cola.ver'] };

// Sin ninguna pantalla con ficha (el rol `admin` no trae páginas por defecto: aquí ninguna concedida).
const SIN_PANTALLAS = { ...ADMIN_USER, id: 31, username: 'e2e_drflit_sin_pantallas', allowedPages: [] as string[] };

const COPY = {
  sinFichas: 'Todavía no hay manuales de los módulos que usted usa; cuando su administrador le dé acceso a un módulo, aquí podrá consultar cómo funciona.',
  sinFunciones: 'Dr. Flit aún no tiene funciones habilitadas para usted; pídale a su administrador que le active al menos los manuales.',
  sinSoporte: 'Usted no tiene habilitado radicar casos de soporte en Dr. Flit; pídale a su administrador que se lo active.',
  sinManuales: 'No puedo responderle porque usted aún no tiene manuales disponibles; pídale a su administrador que le dé acceso a los manuales de sus módulos.',
  sinGestion: 'Usted no tiene habilitada la consulta de placas y trámites en Dr. Flit; pídale a su administrador que se la active.',
  retirada: 'Esta función ya no está habilitada para usted; si la necesita, pídale a su administrador que se la active.',
};

const panel = (page: Page) => page.getByRole('complementary', { name: 'Dr. Flit' });
const conversacion = (page: Page) => panel(page).getByRole('log', { name: 'Conversación con Dr. Flit' });

type Respuesta = Record<string, unknown>;

function chatIa(o: Respuesta): Respuesta {
  return {
    intent: 'duda', reply: null, enManuales: null, citedSlugs: [], citas: [], gestionTarget: null, gestionRef: null,
    cupo: { usados: 1, tope: 30, restantes: 29 }, ...o,
  };
}

// `autorizacion`: finalidades pedidas (sin repetir: en dev, StrictMode monta los efectos dos veces).
interface Montaje { autorizacion: string[]; chats: number; buscar: number }

/** Mocks de Dr. Flit: autorización (IA autorizada, soporte disponible) y chat con las respuestas dadas. */
async function montar(page: Page, user: Parameters<typeof loginAs>[1], chat: Array<{ status?: number; body: Respuesta }> = []) {
  const m: Montaje = { autorizacion: [], chats: 0, buscar: 0 };
  await page.route('**/api/flito/dr-flit/autorizacion**', async (route: Route) => {
    const finalidad = new URL(route.request().url()).searchParams.get('finalidad') ?? 'post';
    if (!m.autorizacion.includes(finalidad)) m.autorizacion.push(finalidad);
    const ia = finalidad === 'ia';
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        finalidad: ia ? 'ia' : 'soporte', autorizado: ia, versionVigente: 'v-e2e-1', textoVigente: 'Texto E2E.',
        aceptadaEn: ia ? '2026-10-22T10:00:00.000Z' : null,
        soporte: {
          disponible: true, ambiente: 'DEV', ambienteEtiqueta: 'Otro (DEV)',
          adjuntos: { maxArchivos: 3, maxBytesArchivo: 5_242_880, tipos: ['image/png'] },
        },
        ...(ia ? { ia: { disponible: true, cupo: { usados: 0, tope: 30, restantes: 30 } } } : {}),
      }),
    });
  });
  await page.route('**/api/flito/dr-flit/chat', async (route: Route) => {
    m.chats += 1;
    const r = chat.shift() ?? { body: chatIa({ intent: 'no_claro', reply: '¿Puede darme más detalle?' }) };
    await route.fulfill({ status: r.status ?? 200, contentType: 'application/json', body: JSON.stringify(r.body) });
  });
  await page.route('**/api/flito/tramites/buscar', async (route: Route) => {
    m.buscar += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ total: 0, items: [] }) });
  });
  await loginAs(page, user);
  await page.goto('/');
  await page.getByRole('button', { name: 'Abrir Dr. Flit' }).click();
  await expect(panel(page)).toBeVisible();
  return m;
}

async function preguntar(page: Page, rotulo: string, texto: string) {
  const caja = panel(page).getByLabel(rotulo);
  await caja.fill(texto);
  await caja.press('Enter');
}

test.describe('HU #13942 · Dr. Flit según sus funciones', () => {
  test('AC2 · solo «Ver manuales»: «Buscar en los manuales» + «Explícame»; sin IA, soporte ni gestión, y cero /autorizacion', async ({ page }) => {
    const m = await montar(page, conDrFlit(CON_TRAMITES, [M]));
    const saludo = conversacion(page).locator('> div').first();
    await expect(saludo.getByRole('button', { name: 'Explícame un módulo' })).toBeVisible();
    await expect(saludo.getByRole('link', { name: /Abrir la Ayuda FLITO/ })).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Tengo una pregunta' })).toHaveCount(0);
    await expect(panel(page).getByRole('button', { name: 'Necesito soporte' })).toHaveCount(0);
    await expect(panel(page).getByLabel('Escriba su pregunta')).toHaveCount(0);
    // Decisión del PO: la caja busca en las fichas sin IA; «Enviar» es la primaria.
    await expect(panel(page).getByRole('button', { name: 'Enviar' })).toBeVisible();
    await preguntar(page, 'Buscar en los manuales', '¿cómo se entra a trámites?');
    await expect(conversacion(page).getByText('Esto es lo que encontré en sus manuales:')).toBeVisible();
    // Una placa sin «Consulta de gestión» no ofrece consultar: va a los manuales.
    await preguntar(page, 'Buscar en los manuales', 'ABC123');
    await expect(conversacion(page).getByRole('button', { name: /Consultar ABC123/ })).toHaveCount(0);
    await page.waitForLoadState('networkidle');
    expect(m.autorizacion).toEqual([]);
    expect(m.chats).toBe(0);
    expect(m.buscar).toBe(0);
  });

  test('AC2 · solo «Ver manuales» y ninguna ficha visible: vacío explicativo, sin botones ni caja', async ({ page }) => {
    await montar(page, conDrFlit(SIN_PANTALLAS, [M]));
    await expect(conversacion(page)).toContainText(COPY.sinFichas);
    await expect(panel(page).getByRole('button', { name: 'Explícame un módulo' })).toHaveCount(0);
    await expect(panel(page).getByRole('textbox')).toHaveCount(0);
  });

  test('Sin ninguna función (solo la página): vacío «pídale a su administrador»', async ({ page }) => {
    const m = await montar(page, conDrFlit(CON_TRAMITES, []));
    await expect(conversacion(page)).toContainText(COPY.sinFunciones);
    await expect(panel(page).getByRole('textbox')).toHaveCount(0);
    await page.waitForLoadState('networkidle');
    expect(m.autorizacion).toEqual([]);
  });

  test('AC3 · IA + manuales: caja de IA con privacidad, sin «Necesito soporte» y sin pedir finalidad=soporte', async ({ page }) => {
    const m = await montar(page, conDrFlit(CON_TRAMITES, [M, I]));
    await expect(panel(page).getByLabel('Escriba su pregunta')).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Tengo una pregunta' })).toBeVisible();
    await expect(panel(page).getByText('No envío a la IA placas, VIN, documentos ni correos; nombres y direcciones, sí.')).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Necesito soporte' })).toHaveCount(0);
    expect(m.autorizacion).toEqual(['ia']);
  });

  test('AC4 · sin «Radicar soporte»: la IA detecta soporte → copy 3, sin botón de soporte', async ({ page }) => {
    await montar(page, conDrFlit(CON_TRAMITES, [M, I]), [{ body: chatIa({ intent: 'soporte' }) }]);
    await preguntar(page, 'Escriba su pregunta', 'quiero hablar con soporte');
    await expect(conversacion(page)).toContainText(COPY.sinSoporte);
    await expect(panel(page).getByRole('button', { name: 'Necesito soporte' })).toHaveCount(0);
  });

  test('AC5 · sin «Consulta de gestión»: la IA detecta una placa → copy 5, sin oferta y sin el valor', async ({ page }) => {
    const m = await montar(page, conDrFlit(CON_TRAMITES, [M, I]), [
      { body: chatIa({ intent: 'gestion', gestionTarget: 'placa', gestionRef: '[PLACA_1]' }) },
    ]);
    await preguntar(page, 'Escriba su pregunta', '¿en qué va el SOAT de ABC123?');
    const ultima = conversacion(page).locator('> div').last();
    await expect(ultima).toContainText(COPY.sinGestion);
    await expect(ultima).not.toContainText('ABC123');
    await expect(conversacion(page).getByRole('button', { name: /Consultar/ })).toHaveCount(0);
    expect(m.buscar).toBe(0);
  });

  test('IA sin manuales (degradado `sin-manuales`) → copy 4, sin el código', async ({ page }) => {
    await montar(page, conDrFlit(CON_TRAMITES, [I]), [
      { body: chatIa({ intent: null, degradado: 'sin-manuales', cupo: null }) },
    ]);
    await preguntar(page, 'Escriba su pregunta', '¿cómo se entra a trámites?');
    await expect(conversacion(page)).toContainText(COPY.sinManuales);
    await expect(panel(page)).not.toContainText('sin-manuales');
  });

  test('403 `drflit-funcion-no-habilitada` en el chat → copy 6, la IA se apaga y la caja queda en los manuales', async ({ page }) => {
    await montar(page, conDrFlit(CON_TRAMITES, [M, I]), [{
      status: 403,
      body: { error: 'No habilitada', codigo: 'drflit-funcion-no-habilitada', funcion: I },
    }]);
    await preguntar(page, 'Escriba su pregunta', '¿cómo se entra a trámites?');
    await expect(conversacion(page)).toContainText(COPY.retirada);
    await expect(panel(page)).not.toContainText('drflit-funcion-no-habilitada');
    await expect(panel(page).getByLabel('Buscar en los manuales')).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Tengo una pregunta' })).toHaveCount(0);
  });

  test('403 `drflit-funcion-no-habilitada` al aceptar en el asistente → copy 6, «Volver al chat» y sin «Necesito soporte»', async ({ page }) => {
    await montar(page, conDrFlit(CON_TRAMITES, [M, S]));
    await page.route('**/api/flito/dr-flit/autorizacion', async (route: Route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await route.fulfill({
        status: 403, contentType: 'application/json',
        body: JSON.stringify({ error: 'No habilitada', codigo: 'drflit-funcion-no-habilitada', funcion: S }),
      });
    });
    await conversacion(page).getByRole('button', { name: 'Necesito soporte' }).click();
    await panel(page).getByRole('button', { name: 'Acepto' }).click();
    await expect(panel(page).getByRole('status').filter({ hasText: COPY.retirada })).toBeVisible();
    await expect(panel(page)).not.toContainText('drflit-funcion-no-habilitada');
    await panel(page).getByRole('button', { name: 'Volver al chat' }).click();
    await expect(conversacion(page)).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Necesito soporte' })).toHaveCount(0);
  });

  test('Admin (las cuatro): como hoy — caja de IA, «Necesito soporte» y ambas finalidades', async ({ page }) => {
    const m = await montar(page, conDrFlit(CON_TRAMITES, [M, I, G, S]));
    await expect(panel(page).getByLabel('Escriba su pregunta')).toBeVisible();
    await expect(conversacion(page).getByRole('button', { name: 'Necesito soporte' })).toBeVisible();
    expect([...m.autorizacion].sort()).toEqual(['ia', 'soporte']);
  });
});
