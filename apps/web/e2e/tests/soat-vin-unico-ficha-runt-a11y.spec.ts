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

async function montarAlta(page: Page, preconsulta?: { status: number; cuerpo: unknown }) {
  await page.route(/\/api\/flito\/soat\?/, (route) =>
    json(route, 200, { items: [], total: 0, page: 1, pageSize: 50 }));
  await page.route(/\/api\/flito\/soat\/facetas/, (route) =>
    json(route, 200, { companias: [], organismos: [], proveedores: [] }));
  await page.route(/\/api\/flito\/soat\/cliente\/preconsulta$/, (route) => (preconsulta
    ? json(route, preconsulta.status, preconsulta.cuerpo)
    : json(route, 200, RUNT_OK)));
  await page.goto('/flito/soat/solicitud');
}

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
