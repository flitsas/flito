// HU #13857 (IA-5, Feature #13696) — Dr. Flit responde dudas con IA en el panel.
// Spec UX: docs/ux/flito-dr-flit-f4-ia.md · AC: docs/ado-drafts/epic-12756-12757/HUS-F4-13696.md §IA-5.
// El API se intercepta con `page.route` (autorización y chat): nunca se llama a Anthropic. Un test por
// AC (o por grupo de AC que comparten el mismo arreglo).
import { test, expect, type Page, type Route } from '@playwright/test';
import { loginAs, FINANCIERA_USER as FINANCIERA_REPARTO } from '../helpers/ayuda-fixtures';
import { conDrFlit } from '../helpers/auth';

// HU #13942: el reparto inicial solo da «Ver los manuales»; estos casos prueban el panel completo.
const FINANCIERA_USER = conDrFlit(FINANCIERA_REPARTO);

const FINANCIERA_CON_TRAMITES = { ...FINANCIERA_USER, allowedPages: ['flito_tramites', 'flito_conciliacion'] };

const VERSION_IA = '2026-11-v1';
const TEXTO_IA = 'Autorizo a FLIT S.A.S. a tratar con IA lo que escriba en Dr. Flit (texto de prueba E2E).';
const PRIVACIDAD = 'No envío a la IA placas, VIN, documentos ni correos; nombres y direcciones, sí.';
const CUPO_AGOTADO =
  'Por hoy alcanzó el límite de preguntas con IA. Sigo ayudándole con la búsqueda en los manuales; el cupo se renueva a la medianoche.';
const F3_CITAS = 'Esto es lo que encontré en sus manuales:';

type Cupo = { usados: number; tope: number; restantes: number };
type RespuestaMock = { status: number; body?: unknown } | 'abort' | { esperar: Promise<void>; status: number; body: unknown };

interface OpcionesIa {
  disponible?: boolean;
  autorizado?: boolean;
  cupo?: Cupo | null;
  chat?: RespuestaMock[];
  aceptar?: { status: number; body: unknown }[];
}

const CITA_TRAMITES = {
  clave: 'flito_tramites', ancla: 'como-se-entra', tituloFicha: 'Gestión Trámites', tituloSeccion: 'Cómo se entra',
};

function respuesta(o: Record<string, unknown> = {}) {
  return {
    intent: 'duda', reply: 'Entre a Trámites desde el menú.', enManuales: true, citedSlugs: ['flito_tramites'],
    citas: [CITA_TRAMITES], gestionTarget: null, gestionRef: null, cupo: { usados: 1, tope: 30, restantes: 29 }, ...o,
  };
}

function degradado(motivo: string, cupo: Cupo | null = null) {
  return {
    intent: null, reply: null, enManuales: null, citedSlugs: [], citas: [], gestionTarget: null, gestionRef: null,
    degradado: motivo, cupo,
  };
}

async function montarIa(page: Page, o: OpcionesIa = {}) {
  const m = {
    autorizado: o.autorizado ?? false,
    getsIa: 0,
    aceptaciones: [] as unknown[],
    chats: [] as unknown[],
  };
  const chat = [...(o.chat ?? [])];
  const aceptar = [...(o.aceptar ?? [])];
  await page.route('**/api/flito/dr-flit/autorizacion**', async (route: Route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      const ia = new URL(req.url()).searchParams.get('finalidad') === 'ia';
      if (ia) m.getsIa += 1;
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          finalidad: ia ? 'ia' : 'soporte',
          autorizado: ia ? m.autorizado : false,
          versionVigente: ia ? VERSION_IA : 'v-e2e-1',
          textoVigente: ia ? TEXTO_IA : 'Texto de soporte.',
          aceptadaEn: null,
          soporte: { disponible: false, ambiente: null, ambienteEtiqueta: null, adjuntos: { maxArchivos: 0, maxBytesArchivo: 0, tipos: [] } },
          ...(ia ? { ia: { disponible: o.disponible ?? true, cupo: o.cupo === undefined ? { usados: 0, tope: 30, restantes: 30 } : o.cupo } } : {}),
        }),
      });
      return;
    }
    m.aceptaciones.push(req.postDataJSON());
    const r = aceptar.shift() ?? { status: 201, body: { finalidad: 'ia', version: VERSION_IA, aceptadaEn: '2026-11-01T10:00:00.000Z' } };
    if (r.status < 300) m.autorizado = true;
    await route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body) });
  });
  await page.route('**/api/flito/dr-flit/chat', async (route: Route) => {
    m.chats.push(route.request().postDataJSON());
    const r = chat.shift() ?? { status: 200, body: respuesta() };
    if (r === 'abort') {
      await route.abort('failed');
      return;
    }
    if ('esperar' in r) await r.esperar;
    await route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body ?? {}) });
  });
  return m;
}

const panel = (page: Page) => page.getByRole('complementary', { name: 'Dr. Flit' });
const conversacion = (page: Page) => panel(page).getByRole('log', { name: 'Conversación con Dr. Flit' });
const caja = (page: Page) => panel(page).getByLabel('Escriba su pregunta');
const tituloIa = (page: Page) => panel(page).getByRole('heading', { name: 'Antes de usar la IA' });

async function abrirPanel(page: Page) {
  await loginAs(page, FINANCIERA_CON_TRAMITES);
  await page.goto('/');
  await page.getByRole('button', { name: 'Abrir Dr. Flit' }).click();
  await expect(panel(page)).toBeVisible();
}

async function preguntar(page: Page, texto: string) {
  await caja(page).fill(texto);
  await caja(page).press('Enter');
}

async function aceptarIa(page: Page) {
  await expect(tituloIa(page)).toBeVisible();
  await panel(page).getByRole('button', { name: 'Aceptar' }).click();
  await expect(caja(page)).toBeFocused();
}

test.describe('HU #13857 · Dr. Flit responde dudas con IA', () => {
  test('AC10 · IA apagada: ni autorización ni mención a la IA, y el panel responde como hoy', async ({ page }) => {
    const m = await montarIa(page, { disponible: false });
    await abrirPanel(page);
    await expect.poll(() => m.getsIa).toBeGreaterThan(0);
    await expect(tituloIa(page)).toHaveCount(0);
    await preguntar(page, '¿cómo se entra a trámites?');
    await expect(conversacion(page).getByText(F3_CITAS)).toBeVisible();
    await expect(panel(page)).not.toContainText('IA');
    expect(m.chats).toHaveLength(0);
  });

  test('AC1 + AC3 · primera vez: autorización con Aceptar/Ahora no; Esc = Ahora no → búsqueda F3 y enlace para activar', async ({ page }) => {
    const m = await montarIa(page);
    await abrirPanel(page);
    await expect(tituloIa(page)).toBeVisible();
    await expect(tituloIa(page)).toBeFocused();
    await expect(panel(page).getByText(TEXTO_IA)).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Aceptar' })).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Ahora no' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(tituloIa(page)).toHaveCount(0);
    await expect(panel(page)).toBeVisible();
    await expect(caja(page)).toBeFocused();
    await expect(panel(page).getByRole('status').filter({ hasText: 'Le respondo con la búsqueda en los manuales.' })).toBeVisible();

    await preguntar(page, '¿cómo se entra a trámites?');
    await expect(conversacion(page).getByText(F3_CITAS)).toBeVisible();
    expect(m.chats).toHaveLength(0);
    expect(m.aceptaciones).toHaveLength(0);

    // Una vez por sesión: al cerrar y reabrir no vuelve sola; el enlace la abre.
    await panel(page).getByRole('button', { name: 'Cerrar' }).first().click();
    await page.getByRole('button', { name: 'Abrir Dr. Flit' }).click();
    await expect(panel(page).getByRole('button', { name: 'Activar respuestas con IA' })).toBeVisible();
    await expect(tituloIa(page)).toHaveCount(0);
    await panel(page).getByRole('button', { name: 'Activar respuestas con IA' }).click();
    await expect(tituloIa(page)).toBeFocused();
  });

  test('AC2 + AC5 · Aceptar registra la versión mostrada; la duda llega con «pensando», texto plano y citas a la ficha', async ({ page }) => {
    let soltar = () => {};
    const esperar = new Promise<void>((r) => { soltar = r; });
    const m = await montarIa(page, {
      chat: [{
        esperar, status: 200,
        body: respuesta({
          reply: 'Entre a **Trámites** <a href="https://malo.example">aquí</a>.',
          citas: [CITA_TRAMITES, { ...CITA_TRAMITES, ancla: 'no-existe', tituloSeccion: 'Inventada' }],
        }),
      }],
    });
    await abrirPanel(page);
    await aceptarIa(page);
    expect(m.aceptaciones).toEqual([{ finalidad: 'ia', version: VERSION_IA }]);
    await expect(panel(page).getByText(PRIVACIDAD)).toBeVisible();

    await caja(page).fill('¿cómo hago para certificar un SOAT?');
    await caja(page).press('Enter');
    await expect(conversacion(page).getByText('Dr. Flit está pensando…')).toBeVisible();
    await caja(page).fill('otra');
    await caja(page).press('Enter');
    // Enviar está `aria-disabled`: el clic forzado tampoco envía (no hay doble envío).
    await panel(page).getByRole('button', { name: 'Enviar' }).click({ force: true });
    soltar();

    await expect(conversacion(page).getByText('Respondido con IA; confirme en la ficha citada.')).toBeVisible();
    expect(m.chats).toHaveLength(1);
    expect(Object.keys(m.chats[0] as object).sort()).toEqual(['historial', 'mensaje']);
    await expect(conversacion(page).getByText('Entre a **Trámites** <a href="https://malo.example">aquí</a>.')).toBeVisible();
    await expect(conversacion(page).locator('a[href="https://malo.example"]')).toHaveCount(0);
    const citas = conversacion(page).getByRole('listitem').getByRole('link');
    await expect(citas).toHaveCount(2);
    await expect(citas.nth(0)).toHaveAttribute('href', '/flito/ayuda/flito_tramites#como-se-entra');
    await expect(citas.nth(0)).toContainText('Cómo se entra');
    await expect(citas.nth(1)).toHaveAttribute('href', '/flito/ayuda/flito_tramites');
    await expect(conversacion(page).getByText('En sus manuales:')).toBeVisible();

    // Sin volver a pedir la autorización: la siguiente pregunta va directo al chat.
    await preguntar(page, '¿y para anular?');
    await expect.poll(() => m.chats.length).toBe(2);
    await expect(tituloIa(page)).toHaveCount(0);
  });

  test('AC4 · falla al registrar: aviso con Reintentar sin el error crudo; versión no vigente recarga el texto', async ({ page }) => {
    const m = await montarIa(page, {
      aceptar: [
        { status: 500, body: { error: 'ERROR CRUDO DEL API' } },
        { status: 400, body: { error: 'CRUDO 400', codigo: 'version-no-vigente' } },
      ],
    });
    await abrirPanel(page);
    await panel(page).getByRole('button', { name: 'Aceptar' }).click();
    const alerta = panel(page).getByRole('alert');
    await expect(alerta).toContainText('No pude registrar su autorización.');
    await expect(alerta).toContainText('Revise su conexión e intente de nuevo.');
    await expect(panel(page)).not.toContainText('ERROR CRUDO DEL API');

    await alerta.getByRole('button', { name: 'Reintentar' }).click();
    await expect(panel(page).getByRole('alert')).toContainText('Las condiciones cambiaron mientras las leía.');
    await expect(panel(page)).not.toContainText('CRUDO 400');
    const antes = m.getsIa;
    await panel(page).getByRole('alert').getByRole('button', { name: 'Reintentar' }).click();
    await expect.poll(() => m.getsIa).toBe(antes + 1);
    await expect(panel(page).getByRole('alert')).toHaveCount(0);
    await panel(page).getByRole('button', { name: 'Aceptar' }).click();
    await expect(caja(page)).toBeFocused();
    expect(m.aceptaciones).toHaveLength(3);

    // Mientras no aceptaba, nada fue al chat.
    expect(m.chats).toHaveLength(0);
  });

  test('AC6 · sin manuales → Ayuda (+ marca IA); no_claro → pregunta de seguimiento sin citas ni marca', async ({ page }) => {
    await montarIa(page, {
      autorizado: true,
      chat: [
        { status: 200, body: respuesta({ enManuales: false, citas: [], citedSlugs: [], reply: null }) },
        { status: 200, body: respuesta({ intent: 'no_claro', enManuales: null, citas: [], reply: '¿Se refiere a Trámites o a SOAT?' }) },
      ],
    });
    await abrirPanel(page);
    await preguntar(page, '¿cuánto cuesta un café?');
    await expect(conversacion(page).getByText('No encontré eso en sus manuales.')).toBeVisible();
    await expect(conversacion(page).getByText('Respondido con IA.')).toBeVisible();
    await expect(conversacion(page).getByRole('link', { name: 'Abrir la Ayuda FLITO' }).last()).toBeVisible();

    await preguntar(page, '¿y eso?');
    const seguimiento = conversacion(page).getByText('¿Se refiere a Trámites o a SOAT?');
    await expect(seguimiento).toBeVisible();
    await expect(conversacion(page).getByText('Respondido con IA', { exact: false })).toHaveCount(1);
  });

  for (const caso of ['ia-timeout', 'ia-error', 'respuesta-invalida', 'red', '429'] as const) {
    test(`AC7 · ${caso} → búsqueda F3 de la misma pregunta, sin error ni «degradado»`, async ({ page }) => {
      const r: RespuestaMock = caso === 'red' ? 'abort'
        : caso === '429' ? { status: 429, body: { error: 'Demasiados', codigo: 'demasiados-mensajes' } }
          : { status: 200, body: degradado(caso, { usados: 3, tope: 30, restantes: 27 }) };
      const m = await montarIa(page, { autorizado: true, chat: [r] });
      await abrirPanel(page);
      await preguntar(page, '¿cómo se entra a trámites?');
      await expect(conversacion(page).getByText(F3_CITAS)).toBeVisible();
      expect(m.chats).toHaveLength(1);
      await expect(panel(page)).not.toContainText(/degradado|error|timeout/i);
      await expect(panel(page).getByRole('alert')).toHaveCount(0);
    });
  }

  test('AC8 · cupo agotado: aviso persistente literal, respuesta F3 y las siguientes no llaman al chat; cupo bajo visible', async ({ page }) => {
    const m = await montarIa(page, {
      autorizado: true,
      cupo: { usados: 27, tope: 30, restantes: 3 },
      chat: [{ status: 200, body: degradado('cupo-agotado', { usados: 30, tope: 30, restantes: 0 }) }],
    });
    await abrirPanel(page);
    await expect(panel(page).getByText('Le quedan 3 preguntas con IA hoy.')).toBeVisible();
    await preguntar(page, '¿cómo se entra a trámites?');
    await expect(conversacion(page).getByText(F3_CITAS)).toBeVisible();
    await expect(panel(page).getByRole('status').filter({ hasText: CUPO_AGOTADO })).toBeVisible();
    await expect(panel(page).getByText(PRIVACIDAD)).toHaveCount(0);
    await preguntar(page, '¿cómo se entra a trámites otra vez?');
    await expect(conversacion(page).getByText(F3_CITAS)).toHaveCount(2);
    expect(m.chats).toHaveLength(1);
  });

  test('AC8 · con 6 restantes no hay línea de cupo', async ({ page }) => {
    await montarIa(page, { autorizado: true, cupo: { usados: 24, tope: 30, restantes: 6 } });
    await abrirPanel(page);
    await expect(panel(page).getByText(PRIVACIDAD)).toBeVisible();
    await expect(panel(page).getByText(/Le queda/)).toHaveCount(0);
  });

  test('AC8 · con 1 restante, en singular', async ({ page }) => {
    await montarIa(page, { autorizado: true, cupo: { usados: 29, tope: 30, restantes: 1 } });
    await abrirPanel(page);
    await expect(panel(page).getByText('Le queda 1 pregunta con IA hoy.')).toBeVisible();
  });

  test('AC9 · caja ≤300; el valor viaja enmascarado, se restaura solo en pantalla y nunca en sessionStorage', async ({ page }) => {
    const m = await montarIa(page, {
      autorizado: true,
      chat: [{ status: 200, body: respuesta({ intent: 'no_claro', enManuales: null, citas: [], reply: '¿Qué quiere saber de [PLACA_1]?' }) }],
    });
    await abrirPanel(page);
    await expect(caja(page)).toHaveAttribute('maxlength', '300');
    await preguntar(page, 'tengo dudas con ABC123');
    await expect(conversacion(page).getByText('¿Qué quiere saber de ABC123?')).toBeVisible();
    const enviado = JSON.stringify(m.chats[0]);
    expect(enviado).toContain('[PLACA_1]');
    expect(enviado).not.toContain('ABC123');
    const almacen = await page.evaluate(() => JSON.stringify(Object.entries(sessionStorage)));
    expect(almacen).not.toContain('ABC123');
    expect(almacen).toContain('respuestaIa');
    expect(page.url()).not.toContain('ABC123');

    await page.reload();
    await page.getByRole('button', { name: 'Abrir Dr. Flit' }).click();
    await expect(conversacion(page).getByText('¿Qué quiere saber de (placa oculta)?')).toBeVisible();
    await expect(conversacion(page)).not.toContainText('[PLACA_1]');
  });

  test('AC3 · 428 por versión nueva: respuesta F3 sin error y aviso «Revisar y aceptar» que abre el texto vigente', async ({ page }) => {
    const m = await montarIa(page, {
      autorizado: true,
      chat: [{ status: 428, body: { error: 'Autorización requerida', codigo: 'autorizacion-requerida' } }],
    });
    await abrirPanel(page);
    await preguntar(page, '¿cómo se entra a trámites?');
    await expect(conversacion(page).getByText(F3_CITAS)).toBeVisible();
    await expect(panel(page).getByRole('status').filter({ hasText: 'Cambiaron las condiciones de uso de la IA.' })).toBeVisible();
    await expect(tituloIa(page)).toHaveCount(0);
    const antes = m.getsIa;
    await panel(page).getByRole('button', { name: 'Revisar y aceptar' }).click();
    await expect(tituloIa(page)).toBeVisible();
    await expect.poll(() => m.getsIa).toBe(antes + 1);
    await expect(panel(page).getByText(TEXTO_IA)).toBeVisible();
  });
});
