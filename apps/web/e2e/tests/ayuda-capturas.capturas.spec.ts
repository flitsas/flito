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
import { ADMIN_USER, loginAs, MENSAJERO_USER } from '../helpers/auth';
import {
  BOLSAS_DEMO,
  BOLSAS_RIESGO_DEMO,
  CLIENTES_DEMO,
  COMPROBANTE_DETALLE_DEMO,
  COMPROBANTE_IMAGEN_DEMO,
  COMPROBANTES_DEMO,
  CONCILIACION_BOLETAS_DEMO,
  CONCILIACION_DETALLE_DEMO,
  interceptarApiDemo,
  LT_DEMO,
  MI_RUTA_DEMO,
  NOMBRE_ADMIN_DEMO,
  NOMBRE_USUARIO_DEMO,
  RECEPTOR_DEMO,
  SIIGO_BANDEJA_DEMO,
  SIIGO_COMPUERTA_DEMO,
  SIIGO_FRENO_DEMO,
  SIIGO_LINEA_TIEMPO_DEMO,
  SIIGO_MAPEO_DEMO,
  SIIGO_PRODUCTOS_DEMO,
  SIIGO_RESUMEN_DEMO,
  SIIGO_TERCEROS_DEMO,
  SIIGO_VALIDACION_DEMO,
  REPORTE_CONSOLIDADO_DEMO,
  REPORTE_COSTOS_DEMO,
  REPORTE_FACETAS_DEMO,
  REPORTE_FACTURACION_DEMO,
  SERVICIOS_ADICIONALES_DEMO,
  SIIGO_VALIDACION_DETALLE_DEMO,
  TARIFAS_DEMO,
  elegibilidadDemo,
  GASTOS_DIARIOS_DEMO,
  EMPRESAS_DEMO,
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

/** Quita el foco que deja un modal al cerrarse: el anillo de foco no es parte del paso que se ilustra. */
async function sinFoco(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(2, 400); // ni hover: margen izquierdo, fuera de todo control
}

/**
 * Oculta (solo en esta captura, no en la app) la barra de navegación flotante inferior cuando tapa
 * la última fila o columna de lo que se ilustra. Devuelve la función que la vuelve a mostrar.
 */
async function sinBarraFlotante(page: Page): Promise<() => Promise<void>> {
  const barra = page.locator('nav[aria-label="Navegación principal"]'); // por CSS: oculta, sale del árbol accesible
  await barra.evaluate((el) => { el.style.visibility = 'hidden'; });
  return () => barra.evaluate((el) => { el.style.visibility = ''; });
}

/** PNG 1×1 transparente: archivo sintético para ilustrar una carga sin subir nada real. */
const PNG_DEMO = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

async function entrarComoDemo(page: Page, user: Parameters<typeof loginAs>[1]) {
  await page.addInitScript(() => localStorage.setItem('aura-theme', 'light'));
  await loginAs(page, user);
}

/** Sesión del área Facturación (HU #13770): Administrador con nombre demo, que ve todas las acciones. */
const ADMIN_DEMO = { ...ADMIN_USER, username: 'admin_demo', name: NOMBRE_ADMIN_DEMO };

/**
 * Entra como el Administrador demo con el reloj fijo (21-oct-2026, 10:00 hora de Colombia): periodos,
 * «últimos 30 días» y fechas por defecto salen iguales en cada corrida.
 */
async function entrarComoAdminDemo(page: Page) {
  // Desplaza `Date` (no lo congela: los temporizadores siguen corriendo con normalidad).
  await page.addInitScript({ content: `(() => {
    const Real = Date;
    const delta = ${Date.parse('2026-10-21T15:00:00.000Z')} - Real.now();
    class Demo extends Real {
      constructor(...a) { if (a.length === 0) super(Real.now() + delta); else super(...a); }
      static now() { return Real.now() + delta; }
    }
    window.Date = Demo;
  })();` });
  await entrarComoDemo(page, ADMIN_DEMO);
}

type RegistroApi = Awaited<ReturnType<typeof interceptarApiDemo>>;

/** AC1/AC2 de la HU #13769: todo /api lo respondió un fixture y la carpeta tiene exactamente estas capturas. */
function comprobarCierre(api: RegistroApi, dir: string, archivos: string[]) {
  expect(api.noMockeados, 'endpoints /api sin fixture demo').toEqual([]);
  const fueraDeFixture = api.vistas.filter((v) => !api.atendidas.includes(v) && !RUTAS_DE_SESION.test(v));
  expect(fueraDeFixture, 'peticiones /api que no respondió ningún fixture').toEqual([]);
  expect(readdirSync(dir).filter((f) => NOMBRE_CAPTURA.test(f)).sort()).toEqual(archivos);
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

    // AC2 (todo /api con fixture) y AC1 (nombres estables: exactamente estos archivos).
    comprobarCierre(api, dir, [
      '01-recoger-licencias.png',
      '02-resultado-validacion.png',
      '03-confirmar-recogida.png',
      '04-entregar.png',
      '05-sin-conexion.png',
    ]);
  });

  // ── Área Facturación (HU #13770) ──────────────────────────────────────────

  test('siigo_parametrizacion @capturas', async ({ page }) => {
    const dir = prepararCarpeta('siigo_parametrizacion');
    const api = await interceptarApiDemo(page, [
      [/\/api\/siigo\/mapeo-conceptos$/, () => ({ body: SIIGO_MAPEO_DEMO })],
      [/\/api\/siigo\/compuerta$/, () => ({ body: SIIGO_COMPUERTA_DEMO })],
      [/\/api\/siigo\/productos$/, () => ({ body: SIIGO_PRODUCTOS_DEMO })],
      [/\/api\/siigo\/clientes\/validacion$/, () => ({ body: SIIGO_VALIDACION_DEMO })],
      [/\/api\/siigo\/clientes\/validacion\/detalle$/, (route) => {
        const soloPendientes = !route.request().url().includes('incluirFacturables=true');
        const data = SIIGO_VALIDACION_DETALLE_DEMO.data.filter((c) => !soloPendientes || !c.facturable);
        return { body: { total: data.length, data } };
      }],
      [/\/api\/siigo\/terceros\/resumen$/, () => ({ body: SIIGO_TERCEROS_DEMO.resumen })],
      [/\/api\/siigo\/clientes-ciudades\/estado$/, () => ({ body: SIIGO_TERCEROS_DEMO.ciudadesEstado })],
      [/\/api\/siigo\/clientes-ciudades\/(propuestas|obsoletas)$/, () => ({ body: { total: 0, data: [] } })],
    ]);
    await entrarComoAdminDemo(page);

    await page.goto('/siigo/parametrizacion');
    await expect(page.getByRole('heading', { name: 'Conceptos facturables' })).toBeVisible();
    await expect(page.getByText('Sin mapear')).toBeVisible();

    // Paso 1 — Ambiente y compuerta.
    await expect(page.getByText('La emisión en producción está bloqueada')).toBeVisible();
    await capturar(page, dir, '01-compuerta');

    // Paso 2 — Mapeo de conceptos: estados de fila y botones del Administrador.
    await page.getByRole('heading', { name: 'Conceptos facturables' }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => window.scrollBy(0, -80)); // bajo la cabecera fija
    await capturar(page, dir, '02-mapeo-de-conceptos');

    await page.getByRole('button', { name: 'Editar Logística' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await capturar(page, dir, '03-editar-concepto');
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.scrollTo(0, 0));

    // Paso 3 — Terceros: resumen y acceso a los pendientes.
    await page.getByRole('tab', { name: 'Terceros' }).click();
    await expect(page.getByText(/Ver los 1 que no pueden todavía/)).toBeVisible();
    await sinFoco(page);
    await capturar(page, dir, '04-terceros');

    // Paso 4 — Sincronizar terceros con Siigo: se marcan clientes listos y aparece el botón.
    await page.getByRole('checkbox', { name: new RegExp(CLIENTES_DEMO[0].name) }).check();
    await expect(page.getByRole('button', { name: 'Sincronizar 1 en pruebas' })).toBeVisible();
    await page.getByRole('heading', { name: 'Sincronizar terceros con Siigo' })
      .evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await capturar(page, dir, '05-sincronizar-terceros');

    comprobarCierre(api, dir, ['01-compuerta.png', '02-mapeo-de-conceptos.png', '03-editar-concepto.png', '04-terceros.png', '05-sincronizar-terceros.png']);
  });

  test('siigo_operacion @capturas', async ({ page }) => {
    const dir = prepararCarpeta('siigo_operacion');
    const api = await interceptarApiDemo(page, [
      [/\/api\/siigo\/bandeja\/buscar$/, () => ({ body: SIIGO_BANDEJA_DEMO })],
      [/\/api\/siigo\/bandeja\/resumen$/, () => ({ body: SIIGO_RESUMEN_DEMO })],
      [/\/api\/siigo\/freno$/, () => ({ body: SIIGO_FRENO_DEMO })],
      [/\/api\/siigo\/linea-tiempo\/[^/]+$/, () => ({ body: SIIGO_LINEA_TIEMPO_DEMO })],
    ]);
    await entrarComoAdminDemo(page);

    await page.goto('/siigo/operacion');
    await expect(page.getByRole('button', { name: /Ver el caso FLIT-DEMO-1/ })).toBeVisible();

    // Paso 2 — Filtros y tabla Casos detenidos.
    await capturar(page, dir, '01-bandeja');

    // Paso 3 — Ver un caso: qué pasó y qué hacer.
    await page.getByRole('button', { name: /Ver el caso FLIT-DEMO-1/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await capturar(page, dir, '02-ver-caso');
    await page.keyboard.press('Escape');

    // Paso 4 — Varios casos: marcar y reintentar en lote.
    await page.getByRole('checkbox').nth(1).check();
    await page.getByRole('checkbox').nth(2).check();
    await capturar(page, dir, '03-reintentar-varios');

    comprobarCierre(api, dir, ['01-bandeja.png', '02-ver-caso.png', '03-reintentar-varios.png']);
  });

  test('flito_comprobantes @capturas', async ({ page }) => {
    const dir = prepararCarpeta('flito_comprobantes');
    const api = await interceptarApiDemo(page, [
      [/\/api\/flito\/comprobantes$/, () => ({ body: COMPROBANTES_DEMO })],
      [/\/api\/flito\/comprobantes\/[^/]+\/archivo$/, () => ({ body: COMPROBANTE_IMAGEN_DEMO, contentType: 'image/svg+xml' })],
      [/\/api\/flito\/comprobantes\/comp-demo-1$/, () => ({ body: COMPROBANTE_DETALLE_DEMO })],
    ]);
    await entrarComoAdminDemo(page);

    await page.goto('/flito/comprobantes');
    await expect(page.getByRole('button', { name: /Asociar comprobante-demo-1/ })).toBeVisible();

    // Paso 1 — Cargar comprobantes.
    await page.getByRole('button', { name: 'Cargar comprobantes' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('dialog').locator('input[type=file]').setInputFiles([
      { name: 'recibo-derecho-demo.png', mimeType: 'image/png', buffer: PNG_DEMO },
      { name: 'factura-soat-demo.png', mimeType: 'image/png', buffer: PNG_DEMO },
    ]);
    await capturar(page, dir, '01-cargar');
    await page.keyboard.press('Escape');
    await sinFoco(page);

    // Paso 4 — La cola agrupada por carga, con sus filtros.
    await capturar(page, dir, '02-cola');

    // Paso 5 y «Asociar y aplicar» — el documento a la izquierda, lo leído a la derecha.
    await page.getByRole('button', { name: /Asociar comprobante-demo-1/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('img', { name: 'comprobante-demo-1.pdf' })).toBeVisible();
    await capturar(page, dir, '03-asociar');

    comprobarCierre(api, dir, ['01-cargar.png', '02-cola.png', '03-asociar.png']);
  });

  test('flito_conciliacion @capturas', async ({ page }) => {
    const dir = prepararCarpeta('flito_conciliacion');
    const api = await interceptarApiDemo(page, [
      [/\/api\/clients$/, () => ({ body: CLIENTES_DEMO })],
      [/\/api\/flito\/conciliacion\/boletas$/, () => ({ body: CONCILIACION_BOLETAS_DEMO })],
      [/\/api\/flito\/conciliacion\/boletas\/[^/]+$/, (route) => {
        const id = new URL(route.request().url()).pathname.split('/').pop() as string;
        return { body: CONCILIACION_DETALLE_DEMO[id] };
      }],
    ]);
    await entrarComoAdminDemo(page);

    await page.goto('/flito/conciliacion');
    await expect(page.getByRole('button', { name: /Abrir la boleta BOL-DEMO-1/ }).or(page.getByRole('link', { name: /Abrir la boleta BOL-DEMO-1/ }))).toBeVisible();

    // Paso 1 — Cargar boleta del portal.
    await page.getByRole('button', { name: '+ Cargar boleta' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await capturar(page, dir, '01-cargar-boleta');
    await page.keyboard.press('Escape');
    await sinFoco(page);

    // Paso 2 — Bandeja con KPI y filtros.
    const mostrarBarra = await sinBarraFlotante(page); // tapaba la última boleta
    await capturar(page, dir, '02-bandeja');
    await mostrarBarra();

    // Paso 3 — Detalle de una boleta con una línea sin cuadrar.
    await page.goto('/flito/conciliacion/bol-demo-1');
    await expect(page.getByRole('button', { name: 'Volver a cruzar' })).toBeVisible();
    await capturar(page, dir, '03-detalle-sin-cuadrar');

    // Paso 4 — Todas las líneas cuadran: Conciliar boleta y su confirmación.
    await page.goto('/flito/conciliacion/bol-demo-2');
    await page.getByRole('button', { name: 'Conciliar boleta' }).click();
    await expect(page.getByRole('button', { name: 'Sí, conciliar' })).toBeVisible();
    await capturar(page, dir, '04-conciliar');

    // Paso 5 — Boleta conciliada: adjuntar el comprobante del pago PSE.
    await page.goto('/flito/conciliacion/bol-demo-3');
    await expect(page.getByText('Comprobante del pago PSE').first()).toBeVisible();
    await page.getByText('Comprobante del pago PSE').first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await capturar(page, dir, '05-comprobante-pse');

    comprobarCierre(api, dir, ['01-cargar-boleta.png', '02-bandeja.png', '03-detalle-sin-cuadrar.png', '04-conciliar.png', '05-comprobante-pse.png']);
  });

  test('flito_bolsas @capturas', async ({ page }) => {
    const dir = prepararCarpeta('flito_bolsas');
    const api = await interceptarApiDemo(page, [
      [/\/api\/clients$/, () => ({ body: CLIENTES_DEMO })],
      [/\/api\/flito\/bolsas\/consolidado$/, () => ({ body: BOLSAS_DEMO.consolidado })],
      [/\/api\/flito\/bolsas\/riesgo$/, () => ({ body: BOLSAS_RIESGO_DEMO })],
      [/\/api\/flito\/bolsas\/alertas$/, () => ({ body: BOLSAS_DEMO.alertas })],
      [/\/api\/flito\/bolsas\/transito$/, () => ({ body: BOLSAS_DEMO.transito })],
      [/\/api\/flito\/bolsas\/901$/, () => ({ body: BOLSAS_RIESGO_DEMO[0] })],
      [/\/api\/flito\/bolsas\/901\/extracto$/, () => ({ body: BOLSAS_DEMO.extracto })],
      [/\/api\/flito\/bolsas\/901\/movimientos$/, () => ({ body: BOLSAS_DEMO.movimientos })],
      [/\/api\/flito\/bolsas\/901\/cierres$/, () => ({ body: [] })],
    ]);
    await entrarComoAdminDemo(page);

    await page.goto('/flito/bolsas');
    await expect(page.getByText(EMPRESAS_DEMO[0]).first()).toBeVisible();

    // Paso 1 — Periodo contable y KPI.
    await capturar(page, dir, '01-periodo-y-kpi');

    // Paso 2 — Clientes: alertas de saldo y tarjetas con Ver detalle.
    await page.getByText('Alertas de saldo').evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => window.scrollBy(0, -140));
    await capturar(page, dir, '02-clientes');

    // Paso 3 — Detalle del cliente: recargar, mover, corregir o cerrar el periodo.
    await page.getByRole('button', { name: `Ver el detalle de la bolsa de ${EMPRESAS_DEMO[0]}` }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('Ver el libro completo (todos los periodos)')).toBeVisible();
    await capturar(page, dir, '03-detalle-cliente');

    comprobarCierre(api, dir, ['01-periodo-y-kpi.png', '02-clientes.png', '03-detalle-cliente.png']);
  });

  test('flito_tarifas @capturas', async ({ page }) => {
    const dir = prepararCarpeta('flito_tarifas');
    const api = await interceptarApiDemo(page, [
      [/\/api\/clients$/, () => ({ body: CLIENTES_DEMO })],
      [/\/api\/flito\/parametrizacion\/tarifas$/, () => ({ body: TARIFAS_DEMO.abiertas })],
      [/\/api\/flito\/parametrizacion\/tarifas\/companias\/901$/, () => ({ body: TARIFAS_DEMO.vista901 })],
      [/\/api\/flito\/parametrizacion\/tarifas\/companias\/901\/historial$/, () => ({ body: TARIFAS_DEMO.historial })],
    ]);
    await entrarComoAdminDemo(page);

    await page.goto('/flito/tarifas/901');
    await expect(page.getByRole('button', { name: /Fijar valor · / })).toBeVisible();

    // Paso 1 — Elegir la compañía: la lista marca las que tienen valores sin configurar.
    await capturar(page, dir, '01-elegir-compania');

    // Paso 2 — Fijar valor en la fila Sin configurar.
    await page.getByRole('button', { name: /Fijar valor · / }).click();
    await page.getByRole('textbox').last().fill('45000');
    await capturar(page, dir, '02-fijar-valor');
    await page.getByRole('button', { name: /Cancelar · / }).click();
    await sinFoco(page);

    // Paso 5 — Historial del cliente: cada vigencia con valor, desde, hasta y quién la fijó.
    await page.getByRole('button', { name: 'Historial del cliente' }).click();
    await expect(page.getByText('Vigente', { exact: true }).first()).toBeVisible();
    await page.getByText('Historial de vigencias').evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => window.scrollBy(0, -80)); // bajo la cabecera fija
    await sinFoco(page);
    await capturar(page, dir, '03-historial');

    comprobarCierre(api, dir, ['01-elegir-compania.png', '02-fijar-valor.png', '03-historial.png']);
  });

  test('flito_servicios_adicionales @capturas', async ({ page }) => {
    const dir = prepararCarpeta('flito_servicios_adicionales');
    const api = await interceptarApiDemo(page, [
      [/\/api\/flito\/parametrizacion\/servicios-adicionales$/, (route) => {
        const { activos, bajas } = SERVICIOS_ADICIONALES_DEMO;
        const lista = route.request().url().includes('incluirBajas=1') ? [...activos, ...bajas] : activos;
        return { body: [...lista].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')) }; // el servidor ordena por nombre
      }],
    ]);
    await entrarComoAdminDemo(page);

    await page.goto('/flito/servicios-adicionales');
    await expect(page.getByText('Paz y salvo de impuestos')).toBeVisible();

    // Paso 5 — El catálogo, con un tipo inicial todavía Por tarifar.
    await capturar(page, dir, '01-catalogo');

    // Paso 1 — Editar un tipo.
    await page.getByRole('button', { name: /^Editar .*Derecho de petición/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await capturar(page, dir, '02-editar');
    await page.keyboard.press('Escape');

    // Paso 2 — Nuevo tipo.
    await page.getByRole('button', { name: 'Nuevo tipo' }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await capturar(page, dir, '03-nuevo-tipo');
    await page.keyboard.press('Escape');
    await sinFoco(page);

    // Paso 4 — Mostrar dados de baja.
    await page.getByText('Mostrar dados de baja').click();
    await expect(page.getByText('Copia de licencia')).toBeVisible();
    await sinFoco(page);
    await capturar(page, dir, '04-dados-de-baja');

    comprobarCierre(api, dir, ['01-catalogo.png', '02-editar.png', '03-nuevo-tipo.png', '04-dados-de-baja.png']);
  });

  test('finanzas_reporte_costos @capturas', async ({ page }) => {
    const dir = prepararCarpeta('finanzas_reporte_costos');
    const api = await interceptarApiDemo(page, [
      [/\/api\/finanzas\/reporte-costos$/, () => ({ body: REPORTE_COSTOS_DEMO })],
      [/\/api\/finanzas\/reporte-costos\/facturacion-electronica$/, () => ({ body: REPORTE_FACTURACION_DEMO })],
      [/\/api\/finanzas\/reporte-costos\/facetas$/, () => ({ body: REPORTE_FACETAS_DEMO })],
      [/\/api\/finanzas\/reporte-costos\/consolidado$/, () => ({ body: REPORTE_CONSOLIDADO_DEMO })],
      [/\/api\/siigo\/facturacion\/tramites$/, () => ({ body: { items: [] } })],
      [/\/api\/siigo\/elegibilidad\/tramites$/, (route) => ({
        body: elegibilidadDemo((new URL(route.request().url()).searchParams.get('ids') ?? '').split(',').filter(Boolean)),
      })],
    ]);
    await entrarComoAdminDemo(page);

    await page.goto('/finanzas/reporte-costos');
    await expect(page.getByText('FLIT-DEMO-1').first()).toBeVisible();

    // Pasos 1 y 2 — Etapas, filtros y periodo.
    await capturar(page, dir, '01-filtros-y-periodo');

    // Pasos 3 y 4 — La tabla compacta con sus tres secciones y los valores.
    await page.getByText('FLIT-DEMO-1').first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const mostrarBarra = await sinBarraFlotante(page); // tapaba la última fila
    await capturar(page, dir, '02-tabla');
    await mostrarBarra();

    // Paso 5 — Acciones de cada fila: la tabla se desplaza a la derecha hasta la columna de acciones.
    await page.getByText('FLIT-DEMO-1').first().evaluate((el) => {
      let p: HTMLElement | null = el.parentElement;
      while (p && p.scrollWidth <= p.clientWidth) p = p.parentElement;
      if (p) p.scrollLeft = p.scrollWidth;
    });
    await capturar(page, dir, '03-acciones-de-fila');

    // Paso 6 — Consolidado por cliente y periodo.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByRole('button', { name: 'Consolidado' }).click();
    await expect(page.locator('table').getByText(EMPRESAS_DEMO[2])).toBeVisible();
    await sinFoco(page);
    await capturar(page, dir, '04-consolidado');

    comprobarCierre(api, dir, ['01-filtros-y-periodo.png', '02-tabla.png', '03-acciones-de-fila.png', '04-consolidado.png']);
  });

  test('finanzas_gastos_diarios @capturas', async ({ page }) => {
    const dir = prepararCarpeta('finanzas_gastos_diarios');
    const api = await interceptarApiDemo(page, [
      [/\/api\/finanzas\/gastos-diarios$/, () => ({ body: GASTOS_DIARIOS_DEMO })],
      [/\/api\/finanzas\/reporte-costos\/facetas$/, () => ({ body: REPORTE_FACETAS_DEMO })],
    ]);
    await entrarComoAdminDemo(page);

    await page.goto('/finanzas/gastos-diarios');
    await expect(page.getByText('Total del periodo').first()).toBeVisible();

    // Pasos 1 a 3 — Filtros, las cinco tarjetas y el total del periodo.
    await capturar(page, dir, '01-tarjetas-y-total');

    // Paso 6 — Evolución diaria.
    await page.getByText('Evolución diaria').first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => window.scrollBy(0, -80));
    await capturar(page, dir, '02-evolucion-diaria');

    comprobarCierre(api, dir, ['01-tarjetas-y-total.png', '02-evolucion-diaria.png']);
  });
});
