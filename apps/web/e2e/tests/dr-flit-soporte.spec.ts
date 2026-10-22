// HU #13806 — Dr. Flit: «Necesito soporte», autorización, datos del caso, confirmación y número
// (Feature #13695). Anexo UX: docs/ux/flito-dr-flit.md §F5 · diseño: docs/diseno/feature-13695-dr-flit-soporte.md §HU-4.
// La API de soporte se mockea con `page.route` (GET/POST de autorización y POST de casos); el panel es el real.
import { test, expect, type Page, type Request } from '@playwright/test';
import { loginAs, ADMIN_USER, FINANCIERA_USER } from '../helpers/ayuda-fixtures';
import { claveConversacion } from '../../src/lib/drFlitAlmacen';

const FINANCIERA = { ...FINANCIERA_USER, allowedPages: ['flito_tramites', 'flito_conciliacion'] };
const CORREO_SESION = 'financiera.e2e@empresa.co';
const TEXTO_AUTORIZACION = 'Texto de prueba de la autorización de soporte (E2E).';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Respuesta = { status: number; body: unknown };
interface OpcionesMock {
  autorizado?: boolean;
  disponible?: boolean;
  /** Respuestas del POST de casos, en orden; agotadas → 201 #13742. */
  casos?: Respuesta[];
  /** Respuestas del POST de autorización, en orden; agotadas → 201. */
  aceptar?: Respuesta[];
  /** `GET` de estado que falla (aborta) las primeras N veces. */
  getFallos?: number;
}

function estadoSoporte(autorizado: boolean, disponible: boolean, version = 'v-e2e-1') {
  return {
    finalidad: 'soporte', autorizado, versionVigente: version, textoVigente: TEXTO_AUTORIZACION,
    aceptadaEn: autorizado ? '2026-10-22T10:00:00.000Z' : null,
    soporte: {
      disponible, ambiente: 'DEV', ambienteEtiqueta: 'Otro (DEV)',
      adjuntos: { maxArchivos: 3, maxBytesArchivo: 5_242_880, tipos: ['image/png', 'image/jpeg', 'application/pdf'] },
    },
  };
}

async function mockSoporte(page: Page, o: OpcionesMock = {}) {
  const m = {
    autorizado: o.autorizado ?? false,
    gets: 0,
    aceptaciones: [] as unknown[],
    casos: [] as Array<Record<string, unknown>>,
    getFallos: o.getFallos ?? 0,
  };
  const casos = [...(o.casos ?? [])];
  const aceptar = [...(o.aceptar ?? [])];
  await page.route('**/api/auth/perfil', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ name: FINANCIERA.name, username: FINANCIERA.username, email: CORREO_SESION, rolNombre: null }),
  }));
  await page.route('**/api/flito/dr-flit/autorizacion**', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      m.gets += 1;
      if (m.getFallos > 0) {
        m.getFallos -= 1;
        await route.abort('failed');
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(estadoSoporte(m.autorizado, o.disponible ?? true)) });
      return;
    }
    m.aceptaciones.push(req.postDataJSON());
    const r = aceptar.shift() ?? { status: 201, body: { finalidad: 'soporte', version: 'v-e2e-1', aceptadaEn: '2026-10-22T10:00:00.000Z' } };
    if (r.status < 300) m.autorizado = true;
    await route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body) });
  });
  await page.route('**/api/flito/dr-flit/casos-soporte', async (route) => {
    m.casos.push(route.request().postDataJSON());
    const r = casos.shift() ?? { status: 201, body: { numero: 13742, repetido: false } };
    await route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body) });
  });
  return m;
}

const panel = (page: Page) => page.getByRole('complementary', { name: 'Dr. Flit' });
const conversacion = (page: Page) => panel(page).getByRole('log', { name: 'Conversación con Dr. Flit' });
const caja = (page: Page) => panel(page).getByLabel('Escriba su pregunta');
const necesitoSoporte = (page: Page) => panel(page).getByRole('button', { name: 'Necesito soporte' });
const boton = (page: Page, nombre: string) => panel(page).getByRole('button', { name: nombre, exact: true });
const h3 = (page: Page) => panel(page).getByRole('heading', { level: 3 });

async function entrar(page: Page, o: OpcionesMock = {}, user: Parameters<typeof loginAs>[1] = FINANCIERA) {
  await loginAs(page, user);
  const m = await mockSoporte(page, o);
  await page.goto('/');
  await page.getByRole('button', { name: 'Abrir Dr. Flit' }).click();
  await expect(panel(page)).toBeVisible();
  return m;
}

async function llenarCaso(page: Page) {
  await panel(page).getByLabel('Título').fill('No puedo descargar la factura');
  await panel(page).getByLabel('Detalle').fill('Al pulsar Descargar en Conciliación no pasa nada.');
  await panel(page).getByLabel('Resultado esperado').fill('Que se descargue el PDF.');
  await panel(page).getByRole('group', { name: 'Frecuencia' }).getByText('Siempre', { exact: true }).click();
  await panel(page).getByRole('group', { name: 'Prioridad' }).getByText('Alta', { exact: true }).click();
}

/** Autorizado: «Necesito soporte» → Contacto → Caso → Resumen. */
async function hastaResumen(page: Page) {
  await necesitoSoporte(page).first().click();
  await expect(h3(page)).toContainText('Paso 1 de 3');
  await boton(page, 'Siguiente').click();
  await expect(h3(page)).toContainText('Paso 2 de 3');
  await llenarCaso(page);
  await boton(page, 'Siguiente').click();
  await expect(h3(page)).toContainText('Revise y confirme');
}

test.describe('HU #13806 · Dr. Flit «Necesito soporte»', () => {
  test('AC1 · «Necesito soporte» es la cuarta acción del saludo y el segundo botón de «sin resultados»', async ({ page }) => {
    await entrar(page, { autorizado: true });
    const saludo = conversacion(page).locator('div', { hasText: '¿Por dónde empezamos?' }).last();
    await expect(saludo.getByRole('button', { name: 'Necesito soporte' })).toBeVisible();
    await caja(page).fill('xyzzy');
    await caja(page).press('Enter');
    const vacio = conversacion(page).locator('div', { hasText: 'No encontré nada sobre' }).last();
    await expect(vacio.getByRole('link', { name: 'Abrir la Ayuda FLITO' })).toBeVisible();
    await expect(vacio.getByRole('button', { name: 'Necesito soporte' })).toBeVisible();
    await expect(necesitoSoporte(page)).toHaveCount(2);
  });

  test('AC1 · con soporte no disponible el botón no existe en ningún sitio', async ({ page }) => {
    const m = await entrar(page, { disponible: false });
    await expect.poll(() => m.gets).toBeGreaterThan(0);
    await caja(page).fill('xyzzy');
    await caja(page).press('Enter');
    await expect(conversacion(page).getByText(/No encontré nada sobre/)).toBeVisible();
    await expect(necesitoSoporte(page)).toHaveCount(0);
  });

  test('AC1 · si falla la consulta del estado, el botón se ve y al pulsarlo reconsulta con Reintentar', async ({ page }) => {
    const m = await entrar(page, { autorizado: true, getFallos: 99 });
    await necesitoSoporte(page).click();
    await expect(panel(page).getByText('No pude conectar con el servicio de soporte.')).toBeVisible();
    await expect(boton(page, 'Reintentar')).toBeFocused();
    const antes = m.gets;
    m.getFallos = 0;
    await boton(page, 'Reintentar').click();
    await expect(h3(page)).toContainText('Paso 1 de 3');
    expect(m.gets).toBe(antes + 1);
  });

  test('AC2 · sin autorización: «Ahora no» vuelve al chat sin registrar nada', async ({ page }) => {
    const m = await entrar(page);
    await necesitoSoporte(page).click();
    await expect(h3(page)).toHaveText('Antes de radicar su caso');
    await expect(h3(page)).toBeFocused();
    await expect(panel(page).getByText(TEXTO_AUTORIZACION)).toBeVisible();
    // «Terminar chat» no convive con el asistente.
    await expect(panel(page).getByRole('button', { name: 'Terminar chat' })).toHaveCount(0);
    await boton(page, 'Ahora no').click();
    await expect(conversacion(page)).toBeVisible();
    await expect(necesitoSoporte(page)).toBeFocused();
    expect(m.aceptaciones).toEqual([]);
  });

  test('AC2 · «Acepto» registra la versión vigente una vez y abre el paso 1 con nombre y correo de la sesión', async ({ page }) => {
    const m = await entrar(page);
    await necesitoSoporte(page).click();
    await boton(page, 'Acepto').click();
    await expect(h3(page)).toContainText('Paso 1 de 3');
    await expect(h3(page)).toContainText('Sus datos de contacto');
    await expect(h3(page)).toBeFocused();
    expect(m.aceptaciones).toEqual([{ finalidad: 'soporte', version: 'v-e2e-1' }]);
    await expect(panel(page).getByLabel('Nombre')).toHaveValue(FINANCIERA.name);
    await expect(panel(page).getByLabel('Correo')).toHaveValue(CORREO_SESION);
    await expect(panel(page).getByLabel('Teléfono (opcional)')).toHaveValue('');
    await panel(page).getByLabel('Nombre').fill('Laura Gómez');
    await expect(panel(page).getByLabel('Nombre')).toHaveValue('Laura Gómez');
  });

  test('AC2 · si la versión cambió (409), recarga el texto con aviso', async ({ page }) => {
    const m = await entrar(page, { aceptar: [{ status: 409, body: { error: 'x', codigo: 'version-no-vigente' } }] });
    await necesitoSoporte(page).click();
    await boton(page, 'Acepto').click();
    await expect(panel(page).getByText('El texto de la autorización cambió. Léalo y acéptelo para radicar su caso.')).toBeVisible();
    expect(m.gets).toBeGreaterThanOrEqual(2);
    await boton(page, 'Acepto').click();
    await expect(h3(page)).toContainText('Paso 1 de 3');
  });

  test('AC3/AC4 · área por rol, frecuencia y prioridad sin marcar; «Siguiente» valida y enfoca el primer error', async ({ page }) => {
    await entrar(page, { autorizado: true });
    await necesitoSoporte(page).click();
    await panel(page).getByLabel('Correo').fill('correo-malo');
    await boton(page, 'Siguiente').click();
    await expect(panel(page).getByText('Revise el correo; debe ser como nombre@empresa.co.')).toBeVisible();
    await expect(panel(page).getByLabel('Correo')).toBeFocused();
    await expect(panel(page).getByLabel('Correo')).toHaveAttribute('aria-invalid', 'true');
    await expect(h3(page)).toContainText('Paso 1 de 3');
    await panel(page).getByLabel('Correo').fill(CORREO_SESION);
    await expect(panel(page).getByText('Revise el correo; debe ser como nombre@empresa.co.')).toHaveCount(0);
    await boton(page, 'Siguiente').click();
    await expect(h3(page)).toContainText('Paso 2 de 3');
    await expect(panel(page).getByLabel('Área')).toHaveValue('facturacion');
    await expect(panel(page).getByRole('radio', { checked: true })).toHaveCount(0);
    await boton(page, 'Siguiente').click();
    const titulo = panel(page).getByLabel('Título');
    await expect(titulo).toBeFocused();
    await expect(titulo).toHaveAttribute('aria-invalid', 'true');
    await expect(titulo).toHaveAttribute('aria-describedby', /drflit-soporte-titulo-error/);
    for (const texto of ['Escriba un título para su caso.', 'Describa qué pasó.', 'Escriba qué esperaba que pasara.',
      'Elija con qué frecuencia pasa.', 'Elija la prioridad.']) {
      await expect(panel(page).getByText(texto)).toBeVisible();
    }
    await expect(h3(page)).toContainText('Paso 2 de 3');
    await expect(page.getByRole('status').filter({ hasText: /error/i })).toHaveCount(0);
  });

  test('AC3 · el admin no tiene área sugerida: «Elija un área»', async ({ page }) => {
    await entrar(page, { autorizado: true }, ADMIN_USER);
    await necesitoSoporte(page).click();
    await boton(page, 'Siguiente').click();
    await expect(panel(page).getByLabel('Área')).toHaveValue('');
    await boton(page, 'Siguiente').click();
    await expect(panel(page).getByText('Elija el área.')).toBeVisible();
    await expect(panel(page).getByLabel('Área')).toBeFocused();
  });

  test('AC5 · resumen con todos los datos; «Corregir» vuelve al paso y nada sale antes de Confirmar', async ({ page }) => {
    const m = await entrar(page, { autorizado: true });
    await hastaResumen(page);
    for (const texto of ['Financiera E2E', CORREO_SESION, 'No indicado', 'Facturación', 'No puedo descargar la factura',
      'Que se descargue el PDF.', 'Siempre', 'Alta', 'Otro (DEV)']) {
      await expect(panel(page).getByText(texto, { exact: true })).toBeVisible();
    }
    await expect(panel(page).getByText('Fecha', { exact: true })).toBeVisible();
    await expect(panel(page).getByRole('textbox')).toHaveCount(0);
    await panel(page).getByRole('button', { name: 'Corregir caso' }).click();
    await expect(h3(page)).toContainText('Paso 2 de 3');
    await expect(panel(page).getByLabel('Área')).toBeFocused();
    await panel(page).getByLabel('Título').fill('No descarga la factura de marzo');
    await boton(page, 'Volver al resumen').click();
    await expect(h3(page)).toContainText('Revise y confirme');
    await expect(panel(page).getByText('No descarga la factura de marzo', { exact: true })).toBeVisible();
    expect(m.casos).toEqual([]);
  });

  test('AC6 · éxito: «Su caso #N quedó radicado» en la conversación, solo el número guardado, nada en el navegador', async ({ page }) => {
    const m = await entrar(page, { autorizado: true });
    await hastaResumen(page);
    await boton(page, 'Confirmar').click();
    await expect(conversacion(page).getByText('Su caso #13742 quedó radicado.')).toBeVisible();
    await expect(conversacion(page).getByText('El equipo de soporte lo revisará. Guarde este número: es la referencia de su caso.')).toBeVisible();
    await expect(caja(page)).toBeFocused();
    expect(m.casos).toHaveLength(1);
    const cuerpo = m.casos[0];
    expect(cuerpo.claveIdempotencia).toMatch(UUID);
    expect(cuerpo).toMatchObject({
      contacto: { nombre: 'Financiera E2E', correo: CORREO_SESION }, area: 'facturacion',
      titulo: 'No puedo descargar la factura', resultadoEsperado: 'Que se descargue el PDF.',
      frecuencia: 'siempre', prioridad: 'alta',
    });
    expect(Object.keys(cuerpo).sort()).toEqual(
      ['area', 'claveIdempotencia', 'contacto', 'detalle', 'frecuencia', 'prioridad', 'resultadoEsperado', 'titulo'],
    );
    const enlaces = conversacion(page).locator('div', { hasText: 'quedó radicado' }).last().getByRole('link');
    await expect(enlaces).toHaveCount(0);
    expect(await panel(page).innerText()).not.toMatch(/Azure|DevOps/);
    // Solo el número en la conversación guardada; nada del formulario en ningún almacenamiento.
    const almacen = await page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }));
    for (const dato of ['No puedo descargar', 'Que se descargue', CORREO_SESION, cuerpo.claveIdempotencia as string]) {
      expect(almacen).not.toContain(dato);
    }
    const guardado = await page.evaluate((k) => sessionStorage.getItem(k), claveConversacion(FINANCIERA.id));
    const radicado = JSON.parse(guardado ?? '{}').mensajes.find((x: { tipo: string }) => x.tipo === 'casoRadicado');
    expect(Object.keys(radicado).sort()).toEqual(['de', 'id', 'numero', 'tipo', 'ts']);
    expect(radicado.numero).toBe(13742);
    // Al recargar la burbuja se restaura con el número.
    await page.reload();
    await page.getByRole('button', { name: 'Abrir Dr. Flit' }).click();
    await expect(conversacion(page).getByText('Su caso #13742 quedó radicado.')).toBeVisible();
  });

  test('AC7 · 503: aviso con «Reintentar» en el lugar de Confirmar, misma clave al reintentar, sin error crudo', async ({ page }) => {
    const m = await entrar(page, {
      autorizado: true,
      casos: [{ status: 503, body: { error: 'ADO caído PAT-xyz', codigo: 'ado-no-disponible', reintentable: true } }],
    });
    await hastaResumen(page);
    await boton(page, 'Confirmar').click();
    const aviso = panel(page).getByRole('alert');
    await expect(aviso).toContainText('No pude radicar su caso en este momento.');
    await expect(aviso).toContainText('Su información sigue aquí. Intente de nuevo en unos minutos.');
    await expect(boton(page, 'Reintentar')).toBeFocused();
    await expect(boton(page, 'Confirmar')).toHaveCount(0);
    expect(await panel(page).innerText()).not.toMatch(/ADO|PAT|503/);
    await boton(page, 'Reintentar').click();
    await expect(conversacion(page).getByText('Su caso #13742 quedó radicado.')).toBeVisible();
    expect(m.casos).toHaveLength(2);
    expect(m.casos[1].claveIdempotencia).toBe(m.casos[0].claveIdempotencia);
  });

  test('AC7 · 429 usa su copy; 403 de autorización pide aceptar y vuelve al resumen; 400 lleva al campo', async ({ page }) => {
    const m = await entrar(page, {
      autorizado: true,
      casos: [
        { status: 429, body: { error: 'Demasiadas', codigo: 'demasiadas-radicaciones' } },
        { status: 403, body: { error: 'x', codigo: 'autorizacion-requerida' } },
        { status: 400, body: { error: 'Correo inválido', codigo: 'campo-invalido', campo: 'contacto.correo' } },
      ],
    });
    await hastaResumen(page);
    await boton(page, 'Confirmar').click();
    await expect(panel(page).getByRole('alert')).toContainText('Ya radicó varios casos en la última hora.');
    await boton(page, 'Reintentar').click();
    await expect(h3(page)).toHaveText('Antes de radicar su caso');
    await expect(panel(page).getByText('El texto de la autorización cambió. Léalo y acéptelo para radicar su caso.')).toBeVisible();
    await boton(page, 'Acepto').click();
    await expect(h3(page)).toContainText('Revise y confirme');
    expect(m.casos).toHaveLength(2);
    await boton(page, 'Confirmar').click();
    await expect(h3(page)).toContainText('Paso 1 de 3');
    await expect(panel(page).getByLabel('Correo')).toBeFocused();
    await expect(panel(page).getByText('Revise el correo; debe ser como nombre@empresa.co.')).toBeVisible();
    expect(await panel(page).innerText()).not.toContain('Correo inválido');
    await boton(page, 'Volver al resumen').click();
    await expect(h3(page)).toContainText('Paso 1 de 3');
    await panel(page).getByLabel('Correo').fill('otra.persona@empresa.co');
    await boton(page, 'Volver al resumen').click();
    await boton(page, 'Confirmar').click();
    await expect(conversacion(page).getByText('Su caso #13742 quedó radicado.')).toBeVisible();
    expect(new Set(m.casos.map((c) => c.claveIdempotencia)).size).toBe(1);
  });

  test('AC8 · el borrador sobrevive a «Volver al chat», a cerrar el panel y a navegar; solo en memoria', async ({ page }) => {
    const peticiones: Request[] = [];
    page.on('request', (r) => { if (r.method() !== 'GET') peticiones.push(r); });
    await entrar(page, { autorizado: true });
    await necesitoSoporte(page).click();
    await boton(page, 'Siguiente').click();
    await panel(page).getByLabel('Título').fill('Borrador en memoria');
    await boton(page, 'Volver al chat').click();
    await expect(caja(page)).toBeFocused();
    await necesitoSoporte(page).click();
    await expect(panel(page).getByLabel('Título')).toHaveValue('Borrador en memoria');
    await panel(page).getByRole('button', { name: 'Cerrar' }).click();
    // Navegación del SPA (sin recargar: el borrador vive en memoria).
    await page.evaluate(() => {
      history.pushState({}, '', '/flito/ayuda');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.getByRole('heading', { name: 'Ayuda FLITO' })).toBeVisible();
    await page.getByRole('button', { name: 'Abrir Dr. Flit' }).click();
    await expect(h3(page)).toContainText('Paso 2 de 3');
    await expect(h3(page)).toBeFocused();
    await expect(panel(page).getByLabel('Título')).toHaveValue('Borrador en memoria');
    const almacen = await page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }));
    expect(almacen).not.toContain('Borrador en memoria');
    expect(peticiones.filter((r) => r.url().includes('casos-soporte'))).toHaveLength(0);
    // Esc = Volver al chat; un segundo Esc cierra el panel.
    await page.keyboard.press('Escape');
    await expect(caja(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
  });

  test('AC8 · «Terminar chat» con borrador avisa del caso sin enviar y lo borra', async ({ page }) => {
    await entrar(page, { autorizado: true });
    await caja(page).fill('xyzzy');
    await caja(page).press('Enter');
    await expect(conversacion(page).getByText(/No encontré nada sobre/)).toBeVisible();
    await necesitoSoporte(page).last().click();
    await boton(page, 'Siguiente').click();
    await panel(page).getByLabel('Título').fill('Se va a borrar');
    await boton(page, 'Volver al chat').click();
    await panel(page).getByRole('button', { name: 'Terminar chat' }).click();
    await expect(panel(page).getByText('Se borrarán esta conversación y el caso que no ha enviado, y no podrá recuperarlos.')).toBeVisible();
    await boton(page, 'Sí, terminar').click();
    await necesitoSoporte(page).click();
    await expect(h3(page)).toContainText('Paso 1 de 3');
    await boton(page, 'Siguiente').click();
    await expect(panel(page).getByLabel('Título')).toHaveValue('');
  });

  test('AC9 · asistente sin scroll horizontal y controles de 44 px a 390 px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await entrar(page, { autorizado: true });
    await necesitoSoporte(page).click();
    await boton(page, 'Siguiente').click();
    await boton(page, 'Siguiente').click();
    const medidas = await page.evaluate(() => {
      const p = document.getElementById('drflit-panel')!;
      return { doc: document.documentElement.scrollWidth, ancho: window.innerWidth, panel: p.scrollWidth - p.clientWidth };
    });
    expect(medidas.doc).toBeLessThanOrEqual(medidas.ancho);
    expect(medidas.panel).toBeLessThanOrEqual(0);
    for (const nombre of ['Volver al chat', 'Atrás', 'Siguiente']) {
      const caja = await boton(page, nombre).boundingBox();
      expect(caja!.height, nombre).toBeGreaterThanOrEqual(44);
    }
    const fuente = await panel(page).getByLabel('Título').evaluate((el) => getComputedStyle(el).fontSize);
    expect(fuente).toBe('16px');
  });
});
