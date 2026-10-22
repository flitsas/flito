// HU #13806 (+ HU #13807, adjuntos) — Dr. Flit: «Necesito soporte», autorización, datos del caso, confirmación y número
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

interface ParteArchivo { nombre: string; tipo: string; bytes: number; huella: string }

/** JSON (sin adjuntos) o multipart `caso` + `adjuntos` (HU #13805): devuelve el caso y las partes de archivo. */
function leerCuerpoCaso(req: Request): { caso: Record<string, unknown>; adjuntos: ParteArchivo[] | null } {
  const ct = req.headers()['content-type'] ?? '';
  if (!ct.startsWith('multipart/form-data')) return { caso: req.postDataJSON(), adjuntos: null };
  const limite = ct.split('boundary=')[1];
  const cuerpo = req.postDataBuffer()!.toString('latin1');
  let caso: Record<string, unknown> = {};
  const adjuntos: ParteArchivo[] = [];
  for (const parte of cuerpo.split(`--${limite}`).slice(1, -1)) {
    const fin = parte.indexOf('\r\n\r\n');
    const cabeceras = parte.slice(0, fin);
    const datos = parte.slice(fin + 4, parte.length - 2);
    const nombreParte = /name="([^"]+)"/.exec(cabeceras)?.[1];
    if (nombreParte === 'caso') caso = JSON.parse(Buffer.from(datos, 'latin1').toString('utf8'));
    if (nombreParte === 'adjuntos') {
      adjuntos.push({
        nombre: /filename="([^"]*)"/.exec(cabeceras)?.[1] ?? '',
        tipo: /Content-Type: (\S+)/i.exec(cabeceras)?.[1] ?? '',
        bytes: Buffer.from(datos, 'latin1').length,
        huella: Buffer.from(datos, 'latin1').subarray(0, 8).toString('hex'),
      });
    }
  }
  return { caso, adjuntos };
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
    /** Por petición de casos: `null` si fue JSON; si fue multipart, las partes de archivo `adjuntos`. */
    adjuntos: [] as Array<ParteArchivo[] | null>,
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
    const enviado = leerCuerpoCaso(route.request());
    m.casos.push(enviado.caso);
    m.adjuntos.push(enviado.adjuntos);
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

/** Autorizado: «Necesito soporte» → Contacto → Caso → Archivos (paso 3 de 4, con «No»). */
async function hastaArchivos(page: Page) {
  await necesitoSoporte(page).first().click();
  await expect(h3(page)).toContainText('Paso 1 de 4');
  await boton(page, 'Siguiente').click();
  await expect(h3(page)).toContainText('Paso 2 de 4');
  await llenarCaso(page);
  await boton(page, 'Siguiente').click();
  await expect(h3(page)).toContainText('Paso 3 de 4');
}

/** Autorizado: «Necesito soporte» → Contacto → Caso → Archivos («No») → Resumen. */
async function hastaResumen(page: Page) {
  await necesitoSoporte(page).first().click();
  await expect(h3(page)).toContainText('Paso 1 de 4');
  await boton(page, 'Siguiente').click();
  await expect(h3(page)).toContainText('Paso 2 de 4');
  await llenarCaso(page);
  await boton(page, 'Siguiente').click();
  await expect(h3(page)).toContainText('Paso 3 de 4');
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
    await expect(h3(page)).toContainText('Paso 1 de 4');
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
    await expect(h3(page)).toContainText('Paso 1 de 4');
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
    await expect(h3(page)).toContainText('Paso 1 de 4');
  });

  test('AC3/AC4 · área por rol, frecuencia y prioridad sin marcar; «Siguiente» valida y enfoca el primer error', async ({ page }) => {
    await entrar(page, { autorizado: true });
    await necesitoSoporte(page).click();
    await panel(page).getByLabel('Correo').fill('correo-malo');
    await boton(page, 'Siguiente').click();
    await expect(panel(page).getByText('Revise el correo; debe ser como nombre@empresa.co.')).toBeVisible();
    await expect(panel(page).getByLabel('Correo')).toBeFocused();
    await expect(panel(page).getByLabel('Correo')).toHaveAttribute('aria-invalid', 'true');
    await expect(h3(page)).toContainText('Paso 1 de 4');
    await panel(page).getByLabel('Correo').fill(CORREO_SESION);
    await expect(panel(page).getByText('Revise el correo; debe ser como nombre@empresa.co.')).toHaveCount(0);
    await boton(page, 'Siguiente').click();
    await expect(h3(page)).toContainText('Paso 2 de 4');
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
    await expect(h3(page)).toContainText('Paso 2 de 4');
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
    await expect(h3(page)).toContainText('Paso 2 de 4');
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
    await expect(h3(page)).toContainText('Paso 1 de 4');
    await expect(panel(page).getByLabel('Correo')).toBeFocused();
    await expect(panel(page).getByText('Revise el correo; debe ser como nombre@empresa.co.')).toBeVisible();
    expect(await panel(page).innerText()).not.toContain('Correo inválido');
    await boton(page, 'Volver al resumen').click();
    await expect(h3(page)).toContainText('Paso 1 de 4');
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
    await expect(h3(page)).toContainText('Paso 2 de 4');
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
    await expect(h3(page)).toContainText('Paso 1 de 4');
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

// ── HU #13807 · adjuntar archivos al caso (anexo UX F5.4 F, F5.7, F5.9, F5.14) ─────────────────────────

const MB = 1024 * 1024;
/** Cabecera PNG real + relleno: el cliente valida extensión, `File.type` y tamaño; los bytes, el servidor. */
const png = (name: string, bytes = 1200) => ({
  name, mimeType: 'image/png',
  buffer: Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(bytes - 8, 7)]),
});
const pdf = (name: string, bytes = 340 * 1024) => ({
  name, mimeType: 'application/pdf',
  buffer: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(bytes - 9, 32)]),
});
const docx = (name: string) => ({
  name, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  buffer: Buffer.from('504b0304', 'hex'),
});

const grupoAdjuntar = (page: Page) => panel(page).getByRole('group', { name: '¿Quiere adjuntar capturas o documentos?' });
const selector = (page: Page) => panel(page).getByLabel(/Elegir archivos/);
const lista = (page: Page) => panel(page).getByRole('list', { name: 'Archivos adjuntos' });

async function elegirSi(page: Page) {
  await grupoAdjuntar(page).getByText('Sí', { exact: true }).click();
  await expect(grupoAdjuntar(page).getByRole('radio', { name: 'Sí' })).toBeChecked();
}

test.describe('HU #13807 · Dr. Flit, adjuntos del caso de soporte', () => {
  test('AC1 · empieza en «No»; «Sí» + 2 PNG los lista con nombre, tamaño y «Quitar»; el resumen y el multipart los llevan', async ({ page }) => {
    const consola: string[] = [];
    page.on('console', (msg) => consola.push(msg.text()));
    const m = await entrar(page, { autorizado: true });
    await hastaArchivos(page);
    await expect(grupoAdjuntar(page).getByRole('radio', { name: 'No' })).toBeChecked();
    await expect(selector(page)).toHaveCount(0);
    await elegirSi(page);
    await selector(page).setInputFiles([png('pantalla-error.png', Math.round(1.2 * MB)), png('detalle.png', 2048)]);
    const filas = lista(page).getByRole('listitem');
    await expect(filas).toHaveCount(2);
    await expect(filas.nth(0)).toContainText('pantalla-error.png');
    await expect(filas.nth(0)).toContainText('1,2 MB');
    await expect(filas.nth(1)).toContainText('detalle.png');
    await expect(filas.nth(1)).toContainText('2 KB');
    await expect(panel(page).getByRole('button', { name: 'Quitar pantalla-error.png' })).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Quitar detalle.png' })).toBeVisible();
    await boton(page, 'Siguiente').click();
    await expect(h3(page)).toContainText('Paso 4 de 4');
    await expect(panel(page).getByText('Sí · 2 archivos', { exact: true })).toBeVisible();
    await expect(panel(page).getByRole('list', { name: 'Archivos que se enviarán' })).toContainText('pantalla-error.png');
    expect(m.casos).toEqual([]);
    await boton(page, 'Confirmar').click();
    await expect(conversacion(page).getByText('Su caso #13742 quedó radicado.')).toBeVisible();
    expect(m.casos[0].titulo).toBe('No puedo descargar la factura');
    expect(m.casos[0].claveIdempotencia).toMatch(UUID);
    expect(m.adjuntos[0]!.map((a) => [a.nombre, a.tipo])).toEqual([
      ['pantalla-error.png', 'image/png'], ['detalle.png', 'image/png'],
    ]);
    // El nombre del archivo solo se pinta en la UI: ni consola ni almacenamiento.
    expect(consola.join('\n')).not.toMatch(/pantalla-error|detalle\.png/);
    const almacen = await page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }));
    expect(almacen).not.toMatch(/pantalla-error|detalle\.png/);
  });

  test('AC1 · volver a «No» oculta la lista sin borrarla, el resumen dice «No» y se envía JSON sin archivos', async ({ page }) => {
    const m = await entrar(page, { autorizado: true });
    await hastaArchivos(page);
    await elegirSi(page);
    await boton(page, 'Siguiente').click();
    await expect(panel(page).getByText('Adjunte al menos un archivo o elija "No".')).toBeVisible();
    await expect(h3(page)).toContainText('Paso 3 de 4');
    await selector(page).setInputFiles([png('uno.png')]);
    await grupoAdjuntar(page).getByText('No', { exact: true }).click();
    await expect(lista(page)).toHaveCount(0);
    await elegirSi(page);
    await expect(lista(page).getByRole('listitem')).toHaveCount(1);
    await grupoAdjuntar(page).getByText('No', { exact: true }).click();
    await boton(page, 'Siguiente').click();
    const bloque = panel(page).getByRole('heading', { name: 'Archivos', level: 4 }).locator('xpath=../..');
    await expect(bloque.getByText('No', { exact: true })).toBeVisible();
    await boton(page, 'Confirmar').click();
    await expect(conversacion(page).getByText('Su caso #13742 quedó radicado.')).toBeVisible();
    expect(m.adjuntos).toEqual([null]);
  });

  test('AC2 · un .docx y uno de 6 MB se rechazan con su motivo; se conservan los demás y el caso; con 3 desaparece la caja', async ({ page }) => {
    await entrar(page, { autorizado: true });
    await hastaArchivos(page);
    await elegirSi(page);
    await selector(page).setInputFiles([png('bueno.png')]);
    await selector(page).setInputFiles([docx('informe.docx'), pdf('grande.pdf', 6 * MB), pdf('factura-marzo.pdf')]);
    const avisos = panel(page).locator('#drflit-soporte-archivos-avisos');
    await expect(avisos).toHaveAttribute('role', 'status');
    await expect(avisos).toContainText('"informe.docx" no se adjuntó: solo se aceptan PNG, JPG o PDF.');
    await expect(avisos).toContainText('"grande.pdf" no se adjuntó: pesa 6,0 MB y el máximo es 5 MB.');
    await expect(lista(page).getByRole('listitem')).toHaveCount(2);
    await expect(lista(page)).toContainText('bueno.png');
    await expect(lista(page)).toContainText('factura-marzo.pdf');
    await selector(page).setInputFiles([png('tercero.png'), png('cuarto.png')]);
    await expect(avisos).toContainText('"cuarto.png" no se adjuntó: ya tiene 3 archivos, el máximo.');
    await expect(avisos).not.toContainText('informe.docx');
    await expect(lista(page).getByRole('listitem')).toHaveCount(3);
    await expect(selector(page)).toHaveCount(0);
    await expect(panel(page).getByText('Ya tiene 3 archivos, el máximo. Quite uno para adjuntar otro.')).toBeVisible();
    await boton(page, 'Atrás').click();
    await expect(panel(page).getByLabel('Título')).toHaveValue('No puedo descargar la factura');
    await boton(page, 'Siguiente').click();
    await expect(lista(page).getByRole('listitem')).toHaveCount(3);
  });

  test('AC3 · el servidor rechaza un archivo por contenido: se marca ESE archivo, se quita y se confirma sin reescribir', async ({ page }) => {
    const m = await entrar(page, {
      autorizado: true,
      casos: [{
        status: 400,
        body: { error: 'Adjunto 1 inválido', codigo: 'adjunto-invalido', adjunto: { indice: 1, motivo: 'contenido-no-coincide' } },
      }],
    });
    await hastaArchivos(page);
    await elegirSi(page);
    await selector(page).setInputFiles([png('a.png'), pdf('b.pdf'), png('c.png')]);
    await boton(page, 'Siguiente').click();
    await boton(page, 'Confirmar').click();
    await expect(h3(page)).toContainText('Paso 3 de 4');
    const filas = lista(page).getByRole('listitem');
    await expect(filas.nth(1)).toContainText('El contenido no corresponde a un PNG, JPG o PDF. Quítelo para continuar.');
    await expect(filas.nth(0)).not.toContainText('Quítelo');
    await expect(filas.nth(2)).not.toContainText('Quítelo');
    await expect(panel(page).getByRole('button', { name: 'Quitar b.pdf' })).toBeFocused();
    expect(await panel(page).innerText()).not.toContain('Adjunto 1 inválido');
    await boton(page, 'Volver al resumen').click();
    await expect(h3(page)).toContainText('Paso 3 de 4');
    await panel(page).getByRole('button', { name: 'Quitar b.pdf' }).click();
    await expect(panel(page).getByRole('button', { name: 'Quitar c.png' })).toBeFocused();
    await boton(page, 'Volver al resumen').click();
    await expect(panel(page).getByText('Sí · 2 archivos', { exact: true })).toBeVisible();
    await boton(page, 'Confirmar').click();
    await expect(conversacion(page).getByText('Su caso #13742 quedó radicado.')).toBeVisible();
    expect(m.adjuntos[0]!.map((a) => a.nombre)).toEqual(['a.png', 'b.pdf', 'c.png']);
    expect(m.adjuntos[1]!.map((a) => a.nombre)).toEqual(['a.png', 'c.png']);
    expect(m.casos[1]).toEqual(m.casos[0]);
  });

  test('AC4 · ADO no responde: «Reintentar» reenvía los mismos archivos con la misma clave, sin volver a elegirlos', async ({ page }) => {
    const m = await entrar(page, {
      autorizado: true,
      casos: [{ status: 503, body: { error: 'ADO caído', codigo: 'ado-no-disponible', reintentable: true } }],
    });
    await hastaArchivos(page);
    await elegirSi(page);
    await selector(page).setInputFiles([png('pantalla.png', 4096), pdf('soporte.pdf')]);
    await boton(page, 'Siguiente').click();
    await boton(page, 'Confirmar').click();
    await expect(panel(page).getByRole('alert')).toContainText('No pude radicar su caso en este momento.');
    await expect(boton(page, 'Reintentar')).toBeFocused();
    await boton(page, 'Reintentar').click();
    await expect(conversacion(page).getByText('Su caso #13742 quedó radicado.')).toBeVisible();
    expect(m.casos).toHaveLength(2);
    expect(m.casos[1].claveIdempotencia).toBe(m.casos[0].claveIdempotencia);
    expect(m.adjuntos[1]).toEqual(m.adjuntos[0]);
    expect(m.adjuntos[0]!.map((a) => [a.nombre, a.bytes])).toEqual([['pantalla.png', 4096], ['soporte.pdf', 340 * 1024]]);
  });

  test('AC5 · selector con label y operable con teclado; «Quitar» nombra el archivo y mueve el foco', async ({ page }) => {
    await entrar(page, { autorizado: true });
    await hastaArchivos(page);
    // Sí/No con flechas (radios nativos).
    await grupoAdjuntar(page).getByRole('radio', { name: 'No' }).focus();
    await page.keyboard.press('ArrowLeft');
    await expect(grupoAdjuntar(page).getByRole('radio', { name: 'Sí' })).toBeChecked();
    // Tab llega al selector (input `sr-only` con nombre accesible) y Espacio abre el diálogo.
    await page.keyboard.press('Tab');
    await expect(selector(page)).toBeFocused();
    await expect(selector(page)).toHaveAccessibleName(/Elegir archivos.*PNG, JPG o PDF · hasta 3 archivos de 5 MB cada uno/);
    const dialogo = page.waitForEvent('filechooser');
    await page.keyboard.press('Space');
    await (await dialogo).setFiles([png('uno.png'), png('dos.png')]);
    await expect(lista(page).getByRole('listitem')).toHaveCount(2);
    const quitarUno = panel(page).getByRole('button', { name: 'Quitar uno.png' });
    await quitarUno.focus();
    await page.keyboard.press('Enter');
    await expect(panel(page).getByRole('button', { name: 'Quitar dos.png' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(lista(page)).toHaveCount(0);
    await expect(selector(page)).toBeFocused();
  });
});
