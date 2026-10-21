// Ayuda FLITO — capturas reproducibles de las fichas sobre datos demo (HU #13769).
//
// NO es un test de regresión: genera las imágenes de `apps/web/public/ayuda/<clave>/NN-<paso>.png`
// que citan las fichas. Va etiquetado `@capturas` y vive en el proyecto Playwright `capturas`
// (`playwright.config.ts`), que el proyecto `chromium` ignora: no entra en el smoke ni en ninguna
// corrida por defecto. Se ejecuta a mano, por ficha:
//
//   npm run capturas:ayuda -w apps/web -- --grep flito_logistica_ruta
//
// Reglas (AC1–AC3):
//   - Todo `/api/**` se responde con fixtures de `e2e/helpers/datos-demo.ts` vía `page.route`; al final
//     de cada ficha se comprueba que ninguna petición a `/api` quedó sin fixture ni salió a la red.
//   - Nombres estables `NN-<paso>.png`: se borran los `NN-*.png` previos de la carpeta y se reescriben
//     los mismos. Otros archivos de la carpeta (diagramas SVG hechos a mano) no se tocan.
//   - 1280 px de ancho, tema claro, sin animaciones ni cursor; ≤ 200 KB por imagen (se comprueba).
//
// Para añadir una ficha: un `test('<clave> @capturas', …)` con sus fixtures en el helper y sus
// pasos con `capturar(page, '<clave>', 'NN-<paso>')`.

import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { loginAs, MENSAJERO_USER } from '../helpers/auth';
import {
  interceptarApiDemo,
  LT_DEMO,
  MI_RUTA_DEMO,
  NOMBRE_USUARIO_DEMO,
  RECEPTOR_DEMO,
} from '../helpers/datos-demo';

const DIR_PUBLICO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../public/ayuda');
const MAX_BYTES = 200 * 1024;
const NOMBRE_CAPTURA = /^\d{2}-[a-z0-9-]+\.png$/;

// Rutas que fija `loginAs` (sesión sintética). Se registran después del interceptor y le ganan.
const RUTAS_DE_SESION = /^GET \/api\/(auth\/me|auth\/perfil|permisos\/mios)$/;

function prepararCarpeta(clave: string): string {
  const dir = resolve(DIR_PUBLICO, clave);
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (NOMBRE_CAPTURA.test(f)) unlinkSync(resolve(dir, f));
  return dir;
}

async function capturar(page: Page, dir: string, nombre: string) {
  expect(`${nombre}.png`).toMatch(NOMBRE_CAPTURA);
  await page.evaluate(() => document.fonts.ready);
  const path = resolve(dir, `${nombre}.png`);
  await page.screenshot({ path, animations: 'disabled', caret: 'hide', scale: 'css' });
  expect(statSync(path).size, `${nombre}.png supera 200 KB`).toBeLessThanOrEqual(MAX_BYTES);
}

async function entrarComoDemo(page: Page, user: Parameters<typeof loginAs>[1]) {
  await page.addInitScript(() => localStorage.setItem('aura-theme', 'light'));
  await loginAs(page, user);
}

test.describe('Ayuda FLITO — capturas con datos demo @capturas', () => {
  test('flito_logistica_ruta @capturas', async ({ page, context }) => {
    const dir = prepararCarpeta('flito_logistica_ruta');
    const api = await interceptarApiDemo(page, [
      [/\/api\/flito\/logistica\/mi-ruta$/, () => ({ body: MI_RUTA_DEMO })],
      [/\/api\/flito\/logistica\/validar-lt$/, (route) => {
        const { rawValue } = route.request().postDataJSON() as { rawValue: string };
        return rawValue === LT_DEMO.relacionada.raw
          ? { body: { resultado: 'relacionada' } }
          : { body: { resultado: 'sin_match', motivo: 'No hay ningún trámite aprobado con esta placa.' } };
      }],
      [/\/api\/flito\/logistica\/escanear$/, (route) => {
        const { rawValue } = route.request().postDataJSON() as { rawValue: string };
        const placa = Object.values(LT_DEMO).find((lt) => lt.raw === rawValue)?.placa;
        return { body: { resultado: 'recogido', placa } };
      }],
    ]);
    await entrarComoDemo(page, { ...MENSAJERO_USER, username: 'mensajero_demo', name: NOMBRE_USUARIO_DEMO });

    await page.goto('/flito/ruta');
    await expect(page.getByRole('heading', { name: 'Mi ruta' })).toBeVisible();
    await expect(page.getByText('Entregas (1)')).toBeVisible();

    // Paso 1 — Recoger licencias: respaldo «Pega el contenido del código» con una LT demo.
    await page.getByText('Pega el contenido del código').click();
    await page.getByPlaceholder(/10038156339/).fill(LT_DEMO.relacionada.raw);
    await page.getByPlaceholder(/N.º de LT/).fill(LT_DEMO.relacionada.numeroLt);
    await expect(page.getByRole('button', { name: 'Agregar' })).toBeEnabled();
    await capturar(page, dir, '01-recoger-licencias');

    // Paso 2 — Resultado de la validación en cada tarjeta.
    await page.getByRole('button', { name: 'Agregar' }).click();
    await expect(page.getByText('✓ Relacionada')).toBeVisible();
    await page.getByPlaceholder(/10038156339/).fill(LT_DEMO.sinTramite.raw);
    await page.getByRole('button', { name: 'Agregar' }).click();
    await expect(page.getByText('Sin trámite')).toBeVisible();
    await page.getByText('Pega el contenido del código').click(); // cierra el respaldo: se ven las tarjetas
    await capturar(page, dir, '02-resultado-validacion');

    // Paso 3 — Confirmar recogida: la LT relacionada pasa a Registrada.
    await page.getByRole('button', { name: /Confirmar recogida/ }).click();
    await expect(page.getByText('✓ Registrada')).toBeVisible();
    await capturar(page, dir, '03-confirmar-recogida');

    // Paso 4 — Entregar: receptor y firma (sin confirmar: la confirmación pide ubicación).
    await page.getByRole('button', { name: 'Entregar', exact: true }).click();
    await page.getByPlaceholder('Nombre del receptor').fill(RECEPTOR_DEMO.nombre);
    await page.getByPlaceholder('Documento del receptor').fill(RECEPTOR_DEMO.documento);
    await page.getByLabel('Firma del receptor').evaluate((el: HTMLCanvasElement) => {
      const r = el.getBoundingClientRect();
      const pe = (type: string, x: number, y: number) =>
        el.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerId: 1 }));
      pe('pointerdown', 20, 40); pe('pointermove', 70, 15); pe('pointermove', 120, 55); pe('pointermove', 170, 20); pe('pointerup', 170, 20);
    });
    await expect(page.getByRole('button', { name: 'Confirmar entrega' })).toBeEnabled();
    // Centrada: la cabecera translúcida no deja ver contenido borroso detrás.
    await page.getByPlaceholder('Nombre del receptor').evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await capturar(page, dir, '04-entregar');

    // Paso 5 — Sin red: la recogida se encola y se avisa de los cambios sin sincronizar.
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await context.setOffline(true);
    await page.getByText('Pega el contenido del código').click();
    await page.getByPlaceholder(/10038156339/).fill(LT_DEMO.offline.raw);
    await page.getByRole('button', { name: 'Agregar' }).click();
    await expect(page.getByText('Sin validar (offline)')).toBeVisible();
    await page.getByRole('button', { name: /Confirmar recogida/ }).click();
    await expect(page.getByText(/1 cambio\(s\) sin sincronizar/)).toBeVisible();
    await page.getByText('Pega el contenido del código').click(); // cierra el respaldo (su ejemplo no es demo)
    await page.evaluate(() => window.scrollTo(0, 0));
    await capturar(page, dir, '05-sin-conexion');
    await context.setOffline(false);

    // AC2 — todo /api lo respondió un fixture: ni endpoints sin fixture ni peticiones a la red.
    expect(api.noMockeados, 'endpoints /api sin fixture demo').toEqual([]);
    const fueraDeFixture = api.vistas.filter((v) => !api.atendidas.includes(v) && !RUTAS_DE_SESION.test(v));
    expect(fueraDeFixture, 'peticiones /api que no respondió ningún fixture').toEqual([]);

    // AC1 — nombres estables: exactamente estos archivos en la carpeta.
    expect(readdirSync(dir).filter((f) => NOMBRE_CAPTURA.test(f)).sort()).toEqual([
      '01-recoger-licencias.png',
      '02-resultado-validacion.png',
      '03-confirmar-recogida.png',
      '04-entregar.png',
      '05-sin-conexion.png',
    ]);
  });
});
