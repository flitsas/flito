// HU #12091 — accesibilidad de la pantalla reordenada y de la ficha de once datos. AC6.
//
// ── Por qué en su propio archivo ────────────────────────────────────────────────────────────────
//
// El repo no tiene `@axe-core/playwright`: `helpers/axe.ts` inyecta `axe.min.js` desde disco
// (`QA_AXE_PATH`) o desde un CDN (`QA_AXE_CDN=1`), y **lanza a propósito** si no hay ninguno de los
// dos (HU #11650). En una máquina sin el interruptor este spec sale rojo por ENTORNO; si viviera
// dentro de `soat-vin-unico-ficha-runt.spec.ts`, ese rojo contaminaría el gate funcional y nadie
// podría distinguir «la pantalla incumple» de «axe no estaba». Es la misma separación que
// `soat-envio-directo-gestor-a11y.spec.ts`.
//
//   QA_AXE_CDN=1 npx playwright test e2e/tests/soat-vin-unico-ficha-runt-a11y.spec.ts
//
// Se recorren los CUATRO estados de la vista, y no solo el primer paint: el vacío no tiene ni la
// banda de desenlace ni la ficha, que son justo las dos superficies que esta HU cambia.
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, CLIENTE_CON_CANAL } from '../helpers/auth';
import { correrAxe, esperarSinViolacionesGraves } from '../helpers/axe';

test.use({ viewport: { width: 1440, height: 900 } });

const VIN = '9BWZZZ377VT004251';

const RUNT_OK = {
  vehiculo: {
    placa: 'ABC123', vin: VIN, marca: 'RENAULT', linea: 'LOGAN', modelo: '2019',
    clase: 'AUTOMOVIL', cilindraje: '1600', tipoServicio: 'Particular', carroceria: 'SEDAN',
    // Dos huecos a propósito: los «—» son texto sobre fondo suave y es donde el contraste se cae.
    pasajerosSentados: null, puertas: null,
  },
  organismo: { codigo: '05001', nombre: 'STRIA TTEyTTO MEDELLIN' },
  propietario: null,
};

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/**
 * La lectura de la factura (HU #12094). Por defecto no saca nada, que es lo que los cuatro estados de
 * la #12091 necesitan; los casos de la #12094 pasan la suya.
 */
const RE_LECTURA = /\/api\/flito\/soat\/cliente\/factura\/lectura$/;

async function montarAlta(
  page: Page,
  preconsulta?: { status: number; cuerpo: unknown },
  lectura?: { status: number; cuerpo: unknown },
) {
  await page.route(/\/api\/flito\/soat\?/, (route) =>
    json(route, 200, { items: [], total: 0, page: 1, pageSize: 50 }));
  await page.route(/\/api\/flito\/soat\/facetas/, (route) =>
    json(route, 200, { companias: [], organismos: [], proveedores: [] }));
  await page.route(/\/api\/flito\/soat\/cliente\/preconsulta$/, (route) => (preconsulta
    ? json(route, preconsulta.status, preconsulta.cuerpo)
    : json(route, 200, RUNT_OK)));
  await page.route(RE_LECTURA, (route) => (lectura
    ? json(route, lectura.status, lectura.cuerpo)
    : json(route, 200, { extraccion: {} })));
  await page.goto('/flito/soat/solicitud');
}

async function adjuntar(page: Page) {
  await page.locator('input[type="file"]').setInputFiles({
    name: 'factura.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 e2e'),
  });
}

const campo = (valor: string | null, confiable = true) =>
  ({ valor, confianza: confiable ? 0.95 : 0.42, confiable });

test.describe('HU #12091 · AC6 — accesibilidad de los cuatro estados', () => {
  test('vacío: un solo campo con label asociado, ayuda enlazada y foco visible', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await montarAlta(page);

    const vehiculo = page.getByRole('region', { name: '1 · Vehículo' });
    // `getByLabel` resuelve por la asociación REAL, así que esto ES la comprobación: un `<label>`
    // suelto al lado del control, sin `for` ni envoltura, cuenta igual en el DOM y no le sirve de
    // nada a un lector de pantalla.
    await expect(vehiculo.getByLabel('VIN (número de chasis)')).toHaveCount(1);

    // El foco se VE. Se exige que produzca una diferencia visible, no que use un token concreto: el
    // `:focus-visible` de un clic de ratón no se pinta en muchos navegadores, así que se llega con
    // el teclado.
    const vin = page.getByLabel('VIN (número de chasis)');
    const estiloDe = () => vin.evaluate((el) => {
      const s = getComputedStyle(el);
      return `${s.outlineStyle}|${s.outlineWidth}|${s.outlineColor}|${s.boxShadow}|${s.borderColor}`;
    });
    const sinFoco = await estiloDe();
    await page.getByRole('heading', { name: 'Solicitud de SOAT' }).focus();
    await page.keyboard.press('Tab');
    await expect(vin).toBeFocused();
    expect(await estiloDe(), 'el foco del campo VIN no produce ninguna diferencia visible')
      .not.toEqual(sinFoco);

    esperarSinViolacionesGraves(await correrAxe(page), 'alta del Cliente · vacío');
  });

  test('cargando: el campo va readOnly y nunca disabled, y el aviso es un status', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await page.route(/\/api\/flito\/soat\?/, (route) =>
      json(route, 200, { items: [], total: 0, page: 1, pageSize: 50 }));
    await page.route(/\/api\/flito\/soat\/facetas/, (route) =>
      json(route, 200, { companias: [], organismos: [], proveedores: [] }));
    // Se deja en vuelo el tiempo que dure el test: el estado «consultando» es el que hay que medir.
    await page.route(/\/api\/flito\/soat\/cliente\/preconsulta$/, () => new Promise(() => {}));
    await page.goto('/flito/soat/solicitud');

    await page.getByLabel('VIN (número de chasis)').fill(VIN);
    await page.getByRole('button', { name: 'Consultar el RUNT' }).click();

    await expect(page.getByRole('button', { name: 'Consultando el RUNT…' })).toBeVisible();
    // `readOnly` y NUNCA `disabled`: un control deshabilitado pierde el foco que tuviera y sale del
    // recorrido de tabulación a media consulta.
    await expect(page.locator('input[disabled]')).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'La consulta puede tardar' })).toBeVisible();

    esperarSinViolacionesGraves(await correrAxe(page), 'alta del Cliente · consultando');
  });

  test('desenlace de error: la banda es un alert y describe el campo inválido', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await montarAlta(page, {
      status: 422,
      cuerpo: { error: 'no cuadra', codigo: 'runt_no_cuadra', campo: 'vin' },
    });

    await page.getByLabel('VIN (número de chasis)').fill(VIN);
    await page.getByRole('button', { name: 'Consultar el RUNT' }).click();

    const vin = page.getByLabel('VIN (número de chasis)');
    await expect(vin).toHaveAttribute('aria-invalid', 'true');
    // La banda explica el error desde FUERA del campo, así que el campo tiene que apuntarla: sin
    // esto, el lector anuncia «inválido» y no dice por qué.
    expect(await vin.getAttribute('aria-describedby')).toContain('sol-desenlace-runt');
    await expect(page.locator('#sol-desenlace-runt')).toHaveAttribute('role', 'alert');

    esperarSinViolacionesGraves(await correrAxe(page), 'alta del Cliente · desenlace del RUNT');
  });

  test('lleno: la ficha se alcanza por encabezados, no tiene controles y sus «—» pasan axe', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await montarAlta(page);

    await page.getByLabel('VIN (número de chasis)').fill(VIN);
    await page.getByRole('button', { name: 'Consultar el RUNT' }).click();

    const ficha = page.getByRole('region', { name: 'Datos del RUNT' });
    await expect(ficha).toBeVisible();
    // La ficha NO está en el recorrido de tabulación, y eso es correcto: es texto, no controles. Se
    // alcanza por encabezados, y por eso los rótulos de grupo son `<h4>` reales.
    await expect(ficha.getByRole('heading')).toHaveCount(4);
    await expect(ficha.locator('input, select, textarea, button')).toHaveCount(0);
    // Ningún botón mudo en la pantalla entera.
    const mudos = await page.locator('button').evaluateAll(
      (els) => els.filter((el) => ((el.getAttribute('aria-label') ?? el.textContent ?? '').trim() === '')).length,
    );
    expect(mudos, 'hay botones sin texto ni aria-label').toBe(0);

    esperarSinViolacionesGraves(await correrAxe(page), 'alta del Cliente · ficha del RUNT');
  });
});

// ═══════════════ HU #12094 · AC8 — los estados NUEVOS del bloque 2 y la marca de revisión ════════
//
// Se añaden al recorrido de axe de arriba y no a un archivo aparte por el mismo motivo que aquellos
// viven juntos: son estados de LA MISMA pantalla, y el `QA_AXE_CDN=1` que hace falta es el mismo.
test.describe('HU #12094 · AC8 — accesibilidad de la lectura de la factura', () => {
  test('leyendo: el aviso es un status y NADA queda deshabilitado', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    // La lectura se queda en vuelo el resto del test: ese es el estado que hay que medir.
    await page.route(/\/api\/flito\/soat\?/, (route) =>
      json(route, 200, { items: [], total: 0, page: 1, pageSize: 50 }));
    await page.route(/\/api\/flito\/soat\/facetas/, (route) =>
      json(route, 200, { companias: [], organismos: [], proveedores: [] }));
    await page.route(RE_LECTURA, () => new Promise(() => {}));
    await page.goto('/flito/soat/solicitud');

    await adjuntar(page);

    await expect(page.getByRole('status').filter({ hasText: 'Leyendo la factura…' })).toBeVisible();
    await expect(page.locator('input[disabled], select[disabled]')).toHaveCount(0);

    esperarSinViolacionesGraves(await correrAxe(page), 'alta del Cliente · leyendo la factura');
  });

  test('lectura caída: la banda es un alert y su reintento tiene nombre propio', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await montarAlta(page, undefined, { status: 503, cuerpo: { error: 'El lector no está disponible' } });

    await adjuntar(page);

    const banda = page.getByRole('alert').filter({ hasText: 'No pudimos leer la factura.' });
    await expect(banda).toBeVisible();
    await expect(banda.getByRole('button', { name: 'Volver a leer la factura' })).toBeVisible();

    esperarSinViolacionesGraves(await correrAxe(page), 'alta del Cliente · lectura caída');
  });

  test('leída con un campo dudoso: el chip describe el campo sin marcarlo inválido', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await montarAlta(page, undefined, {
      status: 200,
      cuerpo: {
        extraccion: {
          tipoDocumento: campo('CC'), numeroDocumento: campo('1020304050'),
          nombres: campo('MARÍA FERNANDA'), apellidos: campo('GÓMEZ RUIZ'),
          direccion: campo('CL 30 # 5-10'), departamento: campo('ANTIOQUIA'),
          celular: campo('3009999999'), municipio: campo('MEDELLÍN', false),
        },
      },
    });

    await adjuntar(page);

    // Por id: `getByLabel('Municipio')` casa por subcadena y resolvería además el botón
    // «Confirmar municipio», que es uno de los nodos que este caso mide.
    const municipio = page.locator('#sol-municipio');
    await expect(municipio).toHaveValue('MEDELLÍN');
    // `aria-invalid` NO: no es un error, es un dato correcto que quizá no lo sea. Lo que sí hay es
    // una descripción enlazada — sin ella la marca sería solo visual.
    await expect(municipio).not.toHaveAttribute('aria-invalid', 'true');
    expect(await municipio.getAttribute('aria-describedby')).toContain('sol-municipio-revision');
    await expect(page.getByRole('button', { name: 'Confirmar municipio' })).toBeVisible();
    // Ningún botón mudo, y ninguno con el VALOR leído dentro del nombre accesible.
    const nombres = await page.locator('button').evaluateAll(
      (els) => els.map((el) => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim()),
    );
    expect(nombres.filter((n) => n === '')).toHaveLength(0);
    expect(nombres.some((n) => n.includes('MEDELLÍN'))).toBe(false);

    esperarSinViolacionesGraves(await correrAxe(page), 'alta del Cliente · factura leída con revisión');
  });

  test('banda de sobrescritura: casillas con label propio y sin robar el foco', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await montarAlta(page, undefined, {
      status: 200,
      cuerpo: { extraccion: { municipio: campo('MEDELLÍN'), celular: campo('3009999999') } },
    });

    await page.locator('#sol-municipio').fill('ENVIGADO');
    await page.locator('#sol-celular').fill('3005555555');
    const correo = page.getByLabel('Correo electrónico');
    await correo.focus();
    await adjuntar(page);

    const banda = page.getByRole('status').filter({ hasText: 'Esta factura dice otra cosa' });
    await expect(banda).toBeVisible();
    await expect(banda.getByRole('checkbox', { name: 'Municipio' })).toBeChecked();
    // La banda aparece tras una lectura que pudo tardar un minuto: NO mueve el foco de donde estaba.
    await expect(correo).toBeFocused();

    esperarSinViolacionesGraves(await correrAxe(page), 'alta del Cliente · banda de sobrescritura');
  });
});

// ═══════════════ HU #12213 · AC5 — el aviso de vigencia próxima ante un lector y ante axe ════════
//
//   QA_AXE_CDN=1 npx playwright test e2e/tests/soat-vin-unico-ficha-runt-a11y.spec.ts
//
// Es un quinto estado de la misma vista: `fase: ok` **con** aviso. Vive aquí y no en el spec
// funcional por lo mismo que los otros cuatro — sin el interruptor de axe, este archivo entero es
// un rojo de ENTORNO y no puede contaminar el gate de la HU.
test.describe('HU #12213 · AC5 — accesibilidad del aviso de vigencia próxima', () => {
  test('se anuncia como status (no alert), no roba el foco y pasa axe', async ({ page }) => {
    await loginAs(page, CLIENTE_CON_CANAL);
    await montarAlta(page, {
      status: 200,
      cuerpo: { ...RUNT_OK, vigenciaProxima: { venceEl: '2026-10-05' } },
    });

    const consultar = page.getByRole('button', { name: 'Consultar el RUNT' });
    await page.getByLabel('VIN').fill(VIN);
    await consultar.click();

    const aviso = page.getByRole('status').filter({ hasText: 'todavía tiene SOAT vigente' });
    await expect(aviso).toBeVisible();
    // `status` y no `alert`: `alert` es assertive, interrumpe, y ese registro es el de los fallos.
    await expect(page.getByRole('alert')).toHaveCount(0);
    // El botón cambió de rótulo, que es como se sabe que la fase es `ok`.
    await expect(consultar).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Consultar de nuevo' })).toBeVisible();

    // El foco NO lo mueve el aviso: el efecto de foco de la página solo actúa en `fase === 'fallo'`
    // y no debe extenderse aquí —no hay nada que corregir y robarlo interrumpiría a quien ya
    // estuviera escribiendo abajo—. No se afirma sobre el BOTÓN: se deshabilita mientras consulta y
    // el navegador le quita el foco por su cuenta, así que ese aserto mediría a Chromium y no a la
    // pantalla. Lo que esta HU tiene prohibido es LLEVAR el foco a algo suyo: ni al VIN (que es lo
    // que sí hace el 422) ni dentro del propio aviso.
    await expect(page.getByLabel('VIN')).not.toBeFocused();
    expect(await aviso.evaluate((el) => el.contains(document.activeElement))).toBe(false);

    // El texto es autosuficiente (SC 1.4.1): quitando el color, las dos frases dicen lo mismo. El
    // punto del chip es decorativo y `aria-hidden`, así que el lector anuncia solo la etiqueta.
    await expect(aviso).toContainText('Puede continuar');
    await expect(aviso).toContainText('sí puede enviar esta solicitud');

    esperarSinViolacionesGraves(await correrAxe(page), 'alta del Cliente · aviso de vigencia próxima');
  });
});
