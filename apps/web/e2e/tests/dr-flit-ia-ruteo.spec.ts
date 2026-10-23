// HU #13858 (IA-6, Feature #13696) — Dr. Flit lleva a soporte o a la consulta de gestión según el intent.
// Spec UX: docs/ux/flito-dr-flit-f4-ia.md (variantes IA-6, copy IA.9) · AC: HUS-F4-13696.md §IA-6.
// El API se intercepta con `page.route` (autorización, chat y `POST …/buscar`): nunca se llama a
// Anthropic ni a los módulos reales. La IA ya está autorizada en todos los casos.
import { test, expect, type Page, type Route } from '@playwright/test';
import { loginAs, FINANCIERA_USER } from '../helpers/ayuda-fixtures';

const USUARIO = {
  ...FINANCIERA_USER,
  allowedPages: ['flito_tramites', 'flito_soat'],
  funciones: ['tramites.cola.ver', 'soat.cola.ver'],
};
const BUSCAR_TRAMITES = '**/api/flito/tramites/buscar';
const BUSCAR_SOAT = '**/api/flito/soat/buscar';

type Respuesta = Record<string, unknown>;

function chatIa(o: Respuesta): Respuesta {
  return {
    intent: 'gestion', reply: null, enManuales: null, citedSlugs: [], citas: [], gestionTarget: null, gestionRef: null,
    cupo: { usados: 1, tope: 30, restantes: 29 }, ...o,
  };
}

interface Opciones { chat: Respuesta[]; soporte?: boolean; usuario?: typeof USUARIO }

async function montar(page: Page, o: Opciones) {
  const m = { chats: [] as Array<{ mensaje: string; historial: { rol: string; texto: string }[] }>, buscar: [] as unknown[] };
  const chat = [...o.chat];
  await page.route('**/api/flito/dr-flit/autorizacion**', async (route: Route) => {
    const ia = new URL(route.request().url()).searchParams.get('finalidad') === 'ia';
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        finalidad: ia ? 'ia' : 'soporte', autorizado: ia, versionVigente: 'v-e2e-1', textoVigente: 'Texto E2E.',
        aceptadaEn: ia ? '2026-10-22T10:00:00.000Z' : null,
        soporte: {
          disponible: o.soporte ?? false, ambiente: 'DEV', ambienteEtiqueta: 'Otro (DEV)',
          adjuntos: { maxArchivos: 3, maxBytesArchivo: 5_242_880, tipos: ['image/png'] },
        },
        ...(ia ? { ia: { disponible: true, cupo: { usados: 0, tope: 30, restantes: 30 } } } : {}),
      }),
    });
  });
  await page.route('**/api/flito/dr-flit/chat', async (route: Route) => {
    m.chats.push(route.request().postDataJSON());
    const body = chat.shift() ?? chatIa({ intent: 'no_claro', reply: '¿Puede darme más detalle?' });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  for (const ruta of [BUSCAR_TRAMITES, BUSCAR_SOAT]) {
    await page.route(ruta, async (route: Route) => {
      m.buscar.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ total: 0, items: [] }),
      });
    });
  }
  await loginAs(page, o.usuario ?? USUARIO);
  await page.goto('/');
  await page.getByRole('button', { name: 'Abrir Dr. Flit' }).click();
  await expect(panel(page)).toBeVisible();
  return m;
}

const panel = (page: Page) => page.getByRole('complementary', { name: 'Dr. Flit' });
const conversacion = (page: Page) => panel(page).getByRole('log', { name: 'Conversación con Dr. Flit' });
const caja = (page: Page) => panel(page).getByLabel('Escriba su pregunta');

async function preguntar(page: Page, texto: string) {
  await caja(page).fill(texto);
  await caja(page).press('Enter');
}

async function almacenDrFlit(page: Page): Promise<string> {
  return page.evaluate(() => Object.keys(sessionStorage).map((k) => sessionStorage.getItem(k) ?? '').join('\n'));
}

test.describe('HU #13858 · Dr. Flit IA lleva a soporte o a la consulta de gestión', () => {
  test('AC1 · intent soporte → «Necesito soporte» abre el asistente de F5; nada del formulario va al chat', async ({ page }) => {
    const m = await montar(page, { soporte: true, chat: [chatIa({ intent: 'soporte' })] });
    await preguntar(page, 'No me deja radicar, quiero hablar con alguien');
    const log = conversacion(page);
    await expect(log).toContainText('Para eso le conviene hablar con soporte. Puedo ayudarle a radicar su caso desde aquí.');
    const ultimaBurbuja = log.locator('> div').last();
    await ultimaBurbuja.getByRole('button', { name: 'Necesito soporte' }).click();
    await expect(panel(page).getByRole('heading', { name: 'Antes de radicar su caso' })).toBeVisible();
    expect(m.chats).toHaveLength(1);
    expect(JSON.stringify(m.chats)).not.toMatch(/correo|telefono|Contacto/i);
  });

  test('AC1 · sin soporte disponible la oferta no se muestra y la pregunta se responde con los manuales', async ({ page }) => {
    await montar(page, { soporte: false, chat: [chatIa({ intent: 'soporte' })] });
    await preguntar(page, 'quiero hablar con soporte');
    await expect(conversacion(page)).not.toContainText('Para eso le conviene hablar con soporte.');
    await expect(conversacion(page).getByText(/Esto es lo que encontré en sus manuales:|No encontré/).first()).toBeVisible();
  });

  test('AC2 + AC3 + AC7 · gestión con [PLACA_1] → oferta de F6 con el valor local; consulta solo al confirmar y no vuelve al chat', async ({ page }) => {
    const m = await montar(page, { chat: [chatIa({ gestionTarget: 'placa', gestionRef: '[PLACA_1]' })] });
    await preguntar(page, '¿en qué va el SOAT de ABC123?');
    const log = conversacion(page);
    await expect(log).toContainText('Encontré la placa ABC123. ¿Quiere ver en qué va?');
    // AC7: una sola llamada al chat, enmascarada, y nada consultado antes del clic (AC2).
    expect(m.chats).toHaveLength(1);
    expect(m.chats[0].mensaje).toBe('¿en qué va el SOAT de [PLACA_1]?');
    expect(m.buscar).toHaveLength(0);
    await log.getByRole('button', { name: 'Consultar ABC123 en sus módulos' }).click();
    await expect.poll(() => m.buscar.length).toBe(2);
    expect(m.buscar).toEqual([{ valor: 'ABC123' }, { valor: 'ABC123' }].map((b) => expect.objectContaining(b)));
    await expect(log).toContainText('No encontré resultados en sus módulos.');
    // AC3: ni resultados ni valor en sessionStorage ni en el historial del siguiente envío.
    expect(await almacenDrFlit(page)).not.toContain('ABC123');
    await preguntar(page, '¿y cómo renuevo?');
    await expect.poll(() => m.chats.length).toBe(2);
    expect(JSON.stringify(m.chats[1])).not.toMatch(/ABC123|resultados|Consultar/);
  });

  test('AC4 · [PLACA_2] → oferta de XYZ789; gestionRef null → un botón por placa, sin consultar ninguna', async ({ page }) => {
    const m = await montar(page, {
      chat: [
        chatIa({ gestionTarget: 'placa', gestionRef: '[PLACA_2]' }),
        chatIa({ gestionTarget: 'placa', gestionRef: null }),
      ],
    });
    await preguntar(page, 'compare ABC123 con XYZ789, ¿en qué va la segunda?');
    const log = conversacion(page);
    await expect(log).toContainText('Encontré la placa XYZ789. ¿Quiere ver en qué va?');

    await preguntar(page, '¿en qué van ABC123 y XYZ789?');
    await expect(log).toContainText('Encontré varias placas en su mensaje. ¿Cuál quiere consultar?');
    // La oferta anterior pierde sus botones (F6.3).
    await expect(log).toContainText('No consulté XYZ789.');
    const botones = log.getByRole('button', { name: /^Consultar [A-Z0-9]+$/ });
    await expect(botones).toHaveText(['Consultar ABC123', 'Consultar XYZ789']);
    expect(m.buscar).toHaveLength(0);
    await log.getByRole('button', { name: 'Consultar XYZ789', exact: true }).click();
    await expect.poll(() => m.buscar.length).toBe(2);
    expect(JSON.stringify(m.buscar)).toContain('XYZ789');
    expect(JSON.stringify(m.buscar)).not.toContain('ABC123');
    // El pulsado desaparece; el otro sigue vivo hasta el siguiente mensaje.
    await expect(log.getByRole('button', { name: 'Consultar XYZ789', exact: true })).toHaveCount(0);
    await expect(log.getByRole('button', { name: 'Consultar ABC123', exact: true })).toBeVisible();
    await preguntar(page, 'gracias');
    await expect(log).toContainText('No consulté ABC123.');
    await expect(log.getByRole('button', { name: 'Consultar ABC123', exact: true })).toHaveCount(0);
  });

  test('AC5 · gestión sin valor del tipo pedido → copy fijo, nada consultado', async ({ page }) => {
    const m = await montar(page, { chat: [chatIa({ gestionTarget: 'placa', gestionRef: null })] });
    await preguntar(page, '¿en qué va mi SOAT?');
    await expect(conversacion(page)).toContainText('Para consultarlo necesito la placa, el VIN o el id FLIT.');
    await expect(conversacion(page).getByRole('button', { name: /^Consultar/ })).toHaveCount(0);
    expect(m.buscar).toHaveLength(0);
  });

  test('AC6 · gestión por documento → enlaces sin query a los módulos visibles; el documento no viaja ni se consulta', async ({ page }) => {
    const m = await montar(page, { chat: [chatIa({ gestionTarget: 'cliente', gestionRef: '[DOC_1]' })] });
    await preguntar(page, '¿qué trámites tiene el cliente 1020304050?');
    const log = conversacion(page);
    await expect(log).toContainText('Por documento no consulto desde aquí. Búsquelo en la pantalla del módulo:');
    await expect(log.getByRole('link', { name: 'Abrir Trámites' })).toHaveAttribute('href', '/flito/tramites');
    await expect(log.getByRole('link', { name: 'Abrir SOAT' })).toHaveAttribute('href', '/flito/soat');
    await expect(log.getByRole('link', { name: 'Abrir Impuestos' })).toHaveCount(0);
    expect(m.buscar).toHaveLength(0);
    expect(m.chats[0].mensaje).not.toContain('1020304050');
    await log.getByRole('link', { name: 'Abrir Trámites' }).click();
    await expect(page).toHaveURL(/\/flito\/tramites$/);
    expect(page.url()).not.toContain('1020304050');
  });

  test('AC6 · sin ninguno de los tres módulos → pide acceso, sin enlaces', async ({ page }) => {
    await montar(page, {
      usuario: { ...USUARIO, allowedPages: ['flito_conciliacion'], funciones: [] },
      chat: [chatIa({ gestionTarget: 'cliente', gestionRef: null })],
    });
    await preguntar(page, 'cliente 1020304050');
    const log = conversacion(page);
    await expect(log).toContainText(
      'Por documento no consulto desde aquí. Pídale a quien administra su cuenta acceso a Trámites, SOAT o Impuestos.',
    );
    await expect(log.getByRole('link', { name: /^Abrir (Trámites|SOAT|Impuestos)/ })).toHaveCount(0);
  });

  test('AC7 · respuesta degradada con una placa → la oferta de F6 de hoy', async ({ page }) => {
    const m = await montar(page, {
      chat: [chatIa({ intent: null, gestionTarget: null, degradado: 'ia-timeout', cupo: null })],
    });
    await preguntar(page, '¿cómo cambio la placa ABC123 en el trámite?');
    await expect(conversacion(page)).toContainText('Encontré la placa ABC123. ¿Quiere ver en qué va?');
    expect(m.chats).toHaveLength(1);
    expect(m.buscar).toHaveLength(0);
  });
});
