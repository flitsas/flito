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
import { test, expect, type Locator, type Page } from '@playwright/test';
import { ADMIN_USER, CLIENTE_CON_CANAL, FUNCIONES_POR_ROL, loginAs, MENSAJERO_USER } from '../helpers/auth';
import { elegirTipoInicial } from '../helpers/soat-tipo';
import { FUNCIONES_BOLSAS, detalleDe, resumenDe } from '../helpers/bolsas';
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
  LOGISTICA_ACTAS_DEMO,
  LOGISTICA_DETALLE_DEMO,
  LOGISTICA_FACETAS_DEMO,
  LOGISTICA_TRAMITES_DEMO,
  LOGISTICA_VIAJES_DEMO,
  LT_DEMO,
  MI_RUTA_DEMO,
  NOMBRE_ADMIN_DEMO,
  NOMBRE_USUARIO_DEMO,
  NOMBRES_DEMO,
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
  ASEGURADORAS_DEMO,
  BITACORA_DEMO,
  CLIENTES_FICHA_DEMO,
  COMPANIAS_DEMO,
  COMPARENDO_DETALLE_DEMO,
  COMPARENDOS_CAUSALES_DEMO,
  COMPARENDOS_MUNICIPIOS_DEMO,
  COMPARENDOS_NITS_DEMO,
  COMPARENDOS_REGISTROS_DEMO,
  COMPARENDOS_RUNS_DEMO,
  COMPARENDOS_TOKEN_DEMO,
  DATOS_DEMO,
  DERECHOS_DEMO,
  DERECHOS_DRIVE_DEMO,
  DERECHOS_DRIVE_REGISTRO_DEMO,
  DERECHOS_FACETAS_DEMO,
  DERECHOS_RESULTADO_DEMO,
  IMPUESTO_DETALLE_DEMO,
  IMPUESTOS_COLA_DEMO,
  IMPUESTOS_FACETAS_DEMO,
  PDF_DEMO,
  PROVEEDORES_SOAT_DEMO,
  REVISION_CAMPOS_SOAT,
  REVISION_CANDIDATOS_SOAT,
  REVISIONES_DEMO,
  SOAT_COLA_DEMO,
  SOAT_FACETAS_DEMO,
  SOAT_COMPANIAS_CANAL_DEMO,
  SOAT_DOCUMENTOS_ADICIONALES_DEMO,
  SOAT_POR_VALIDAR_DEMO,
  SYNC_DEMO,
  TABLERO_DEMO,
  TRAMITES_DEMO,
  TRAMITES_FACETAS_DEMO,
  DRIVE_CARPETA_DEMO,
  DRIVE_PROCESO_DEMO,
  DRIVE_RAIZ_DEMO,
  LOG_PII_DEMO,
  LOG_PII_STATS_DEMO,
  PRIVACY_PREVIEW_DEMO,
  ROLES_DEMO,
  SIIGO_CREDENCIALES_DEMO,
  SIIGO_PRUEBA_DEMO,
  USUARIOS_DEMO,
  USUARIOS_HISTORIAL_DEMO,
  USUARIOS_RESUMEN_DEMO,
  USUARIOS_TITULARES_DEMO,
  ORGANISMO_PLANTILLA_DEMO,
  ORGANISMO_VIGENCIAS_DEMO,
  ORGANISMOS_CONFIG_DEMO,
  ORGANISMOS_MODALIDAD_DEMO,
  PANEL_RNDC_DEMO,
  PANEL_SOAT_STATS_DEMO,
  PANEL_VENCIMIENTOS_DEMO,
  EXPEDIENTE_BOLSA_DEMO,
  ESTADO_LOTE_BOLSAS_DEMO,
} from '../helpers/datos-demo';
import { accion, arbolRol, codigosDe, elemento, item, opcional, type NodoDef } from '../helpers/arbolPermisos';

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

async function capturar(page: Page, dir: string, nombre: string, recorte?: Locator) {
  expect(`${nombre}.png`).toMatch(NOMBRE_CAPTURA);
  await page.evaluate(() => document.fonts.ready);
  const path = resolve(dir, `${nombre}.png`);
  // `recorte` (HU #13771): solo la ventana y un margen. El fondo desenfocado de un modal sobre una tabla
  // ancha no comprime y pasa de 200 KB; lo que el paso ilustra es la ventana.
  const caja = recorte ? await recorte.boundingBox() : null;
  const clip = caja ? { x: Math.max(0, caja.x - 24), y: Math.max(0, caja.y - 24), width: caja.width + 48, height: caja.height + 48 } : undefined;
  await page.screenshot({ path, animations: 'disabled', caret: 'hide', scale: 'css', clip });
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
async function entrarComoAdminDemo(page: Page, user: Parameters<typeof loginAs>[1] = ADMIN_DEMO) {
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
  await entrarComoDemo(page, user);
}

type RegistroApi = Awaited<ReturnType<typeof interceptarApiDemo>>;

/** AC1/AC2 de la HU #13769: todo /api lo respondió un fixture y la carpeta tiene exactamente estas capturas. */
function comprobarCierre(api: RegistroApi, dir: string, archivos: string[]) {
  expect(api.noMockeados, 'endpoints /api sin fixture demo').toEqual([]);
  const fueraDeFixture = api.vistas.filter((v) => !api.atendidas.includes(v) && !RUTAS_DE_SESION.test(v));
  expect(fueraDeFixture, 'peticiones /api que no respondió ningún fixture').toEqual([]);
  expect(readdirSync(dir).filter((f) => NOMBRE_CAPTURA.test(f)).sort()).toEqual(archivos);
}

/** Árbol de permisos demo de Roles y permisos y del formulario de Usuarios (HU #13774). Sin datos personales. */
const ARBOL_DEMO: NodoDef[] = [
  elemento('general', 'General', [item('dashboard', 'Tablero', [accion('accion.tablero.ver', 'Ver el tablero')])]),
  elemento('gestion', 'Gestión', [
    item('flito_tramites', 'Gestión Trámites', [accion('accion.tramites.ver', 'Ver la bandeja'), accion('accion.tramites.entregar', 'Entregar trámites')]),
    item('flito_soat', 'SOAT', [
      accion('accion.soat.ver_listado', 'Ver el listado', [], 'Consultar la cola de SOAT.'),
      accion('accion.soat.exportar', 'Exportar a Excel', [opcional('soat.descarga.reintentar', 'Reintentar la descarga')]),
    ]),
  ]),
  elemento('finanzas', 'Finanzas', [item('flito_bolsas', 'Bolsas', [accion('accion.bolsas.ver', 'Ver bolsas')])]),
  elemento('administracion', 'Administración', [
    item('users', 'Usuarios', [accion('accion.usuarios.ver', 'Ver usuarios'), accion('accion.usuarios.editar', 'Editar usuario')]),
    item('roles_permisos', 'Roles y permisos', [accion('accion.roles_permisos.ver', 'Ver roles'), accion('accion.roles_permisos.asignar', 'Asignar permisos')]),
  ]),
  elemento('ayuda', 'Ayuda', [], { derivado: true }),
];
const MARCAS_GESTOR = [
  'menu.general', 'pagina.dashboard', 'accion.tablero.ver',
  'menu.gestion', 'pagina.flito_tramites', 'accion.tramites.ver', 'pagina.flito_soat', 'accion.soat.ver_listado',
];

test.describe('Ayuda FLITO — capturas con datos demo @capturas', () => {
  test('flito_logistica_ruta @capturas', async ({ page, context }) => {
    const dir = prepararCarpeta('flito_logistica_ruta');
    const candidato = {
      tramiteId: 't-demo-1', idFlit: 'FLIT-DEMO-1', companiaNombre: EMPRESAS_DEMO[0],
      organismoCodigo: '11001', gestionable: true, vin: DATOS_DEMO.vins[0],
      organismoNombre: 'STT Bogotá', vehiculo: { marca: 'Renault', linea: 'Duster', modelo: 2024 },
    };
    const api = await interceptarApiDemo(page, [
      [/\/api\/flito\/logistica\/mi-ruta$/, () => ({ body: MI_RUTA_DEMO })],
      [/\/api\/flito\/logistica\/consultar-vehiculo$/, (route) => {
        const { placa } = route.request().postDataJSON() as { placa: string };
        const hit = Object.values(LT_DEMO).some((lt) => lt.placa === placa);
        return hit
          ? { body: { encontrado: true, candidatos: [candidato] } }
          : { body: { encontrado: false } };
      }],
      [/\/api\/flito\/logistica\/escanear$/, (route) => {
        const { placa } = route.request().postDataJSON() as { placa: string };
        return {
          body: {
            resultado: 'recogido', placa, documentoId: `doc-scan-${placa}`,
            organismoCodigo: '11001', companiaNombre: EMPRESAS_DEMO[0],
            vin: DATOS_DEMO.vins[0], numeroLicencia: '10038156339',
            propietarioNombre: NOMBRES_DEMO[0],
          },
        };
      }],
      [/\/api\/flito\/logistica\/recogidas\/confirmar$/, () => ({
        body: { firmanteId: 'f-demo', actas: [{ actaId: 'a-demo-1', companiaId: 901, documentos: 1 }], pendientesTramite: 0 },
      })],
    ]);
    await entrarComoDemo(page, {
      ...MENSAJERO_USER, username: 'mensajero_demo', name: NOMBRE_USUARIO_DEMO,
      funciones: [...FUNCIONES_POR_ROL.mensajero, 'logistica.documento.escanear', 'logistica.recogida.confirmar'],
    });

    await page.goto('/flito/ruta');
    await expect(page.getByRole('heading', { name: 'Mi ruta' })).toBeVisible();
    await expect(page.getByText('Entregas (1)')).toBeVisible();

    // Paso 4 primero (HU #14116): el listado de entregas sigue visible; sin confirmar (pide ubicación).
    await page.getByRole('button', { name: 'Entregar', exact: true }).click();
    await expect(page.getByText('LT de este viaje')).toBeVisible();
    await page.getByLabel('Nombre de quien recibe').fill(RECEPTOR_DEMO.nombre);
    await page.getByLabel('Cédula de quien recibe').fill(RECEPTOR_DEMO.documento);
    await page.getByRole('img', { name: 'Firma de quien recibe, vacía' }).evaluate((el: HTMLCanvasElement) => {
      const r = el.getBoundingClientRect();
      const pe = (type: string, x: number, y: number) =>
        el.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerId: 1 }));
      pe('pointerdown', 20, 40); pe('pointermove', 70, 15); pe('pointermove', 120, 55); pe('pointermove', 170, 20); pe('pointerup', 170, 20);
    });
    await expect(page.getByRole('button', { name: 'Confirmar entrega' })).toBeEnabled();
    await page.getByLabel('Nombre de quien recibe').evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await capturar(page, dir, '04-entregar');
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.getByRole('button', { name: 'Entregar', exact: true })).toBeVisible();

    const agregarAMano = async (lt: typeof LT_DEMO.relacionada) => {
      await page.getByRole('button', { name: 'Ingresar a mano' }).click();
      await page.getByLabel('Placa', { exact: true }).fill(lt.placa);
      await expect(page.getByText('Confirma que es el vehículo')).toBeVisible();
      await page.getByLabel(/licencia de tránsito/).fill('10038156339');
      await page.getByLabel(/sustrato/).fill(lt.numeroLt);
      await page.getByRole('button', { name: 'Agregar LT' }).click();
      await expect(page.getByRole('dialog', { name: 'Ingresar a mano' })).toBeHidden();
    };

    // Paso 1 — Recoger licencias: formulario Ingresar a mano (HU #14111; el pegado del código ya no existe).
    await page.getByRole('button', { name: 'Ingresar a mano' }).click();
    await page.getByLabel('Placa', { exact: true }).fill(LT_DEMO.relacionada.placa);
    await expect(page.getByText('Confirma que es el vehículo')).toBeVisible();
    await page.getByLabel(/licencia de tránsito/).fill('10038156339');
    await page.getByLabel(/sustrato/).fill(LT_DEMO.relacionada.numeroLt);
    await capturar(page, dir, '01-recoger-licencias');
    await page.getByRole('button', { name: 'Agregar LT' }).click();
    await expect(page.getByRole('dialog', { name: 'Ingresar a mano' })).toBeHidden();

    // Paso 2 — Tarjeta de la LT ingresada.
    await expect(page.getByRole('article', { name: `LT ${LT_DEMO.relacionada.placa}` })).toBeVisible();
    await capturar(page, dir, '02-resultado-validacion');

    // Paso 3 — Confirmar recogida: firma del funcionario (sin cédula en URL).
    await page.getByRole('button', { name: /Continuar a la firma/ }).click();
    await page.getByLabel('Nombre', { exact: true }).fill(NOMBRES_DEMO[4]);
    await page.getByLabel('Cédula', { exact: true }).fill(DATOS_DEMO.cedulas[0]);
    await page.getByRole('img', { name: /Firma del funcionario, vacía/ }).evaluate((el: HTMLCanvasElement) => {
      const r = el.getBoundingClientRect();
      const pe = (type: string, x: number, y: number) =>
        el.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerId: 1 }));
      pe('pointerdown', 20, 20); pe('pointermove', 90, 60); pe('pointermove', 140, 30); pe('pointerup', 140, 30);
    });
    await page.getByRole('button', { name: 'Confirmar recogida' }).click();
    await expect(page.getByRole('heading', { name: /Recogida confirmada/ })).toBeVisible();
    await capturar(page, dir, '03-confirmar-recogida');
    await page.getByRole('button', { name: 'Listo' }).click();

    // Paso 5 — Sin red: Ingresar a mano encola la LT.
    await context.setOffline(true);
    await agregarAMano(LT_DEMO.offline);
    await expect(page.getByText('Sin conexión · 1 cambio(s) sin sincronizar')).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await capturar(page, dir, '05-sin-conexion');
    await context.setOffline(false);

    comprobarCierre(api, dir, [
      '01-recoger-licencias.png',
      '02-resultado-validacion.png',
      '03-confirmar-recogida.png',
      '04-entregar.png',
      '05-sin-conexion.png',
    ]);
  });

  // ── Área Mensajero y Logística (HU #13773) ────────────────────────────────
  test('flito_logistica @capturas', async ({ page }) => {
    const dir = prepararCarpeta('flito_logistica');
    const api = await interceptarApiDemo(page, [
      [/\/api\/flito\/logistica$/, () => ({ body: LOGISTICA_TRAMITES_DEMO })],
      [/\/api\/flito\/logistica\/facetas$/, () => ({ body: LOGISTICA_FACETAS_DEMO })],
      [/\/api\/flito\/logistica\/actas$/, () => ({ body: LOGISTICA_ACTAS_DEMO })],
      [/\/api\/flito\/logistica\/tramites\/tram-log-demo-2\/viajes$/, () => ({ body: LOGISTICA_VIAJES_DEMO })],
      [/\/api\/flito\/logistica\/tram-log-demo-2$/, () => ({ body: LOGISTICA_DETALLE_DEMO })],
      [/\/api\/flito\/logistica\/traslados\/buscar$/, () => ({ body: {
        viajes: [
          { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', companiaId: 1, companiaNombre: 'Concesionario Demo Norte', destino: 'cliente', estado: 'en_ruta', cantidadLt: 2, registradoEn: '2026-10-28T14:40:00.000Z' },
          { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', companiaId: 2, companiaNombre: 'Concesionario Demo Sur', destino: 'flit', estado: 'registrado', cantidadLt: 1, registradoEn: '2026-10-27T13:15:00.000Z' },
        ],
        companias: [
          { companiaId: 1, nombre: 'Concesionario Demo Norte' },
          { companiaId: 2, nombre: 'Concesionario Demo Sur' },
        ],
        truncado: false,
      } })],
      [/\/api\/flito\/logistica\/motivos-llegada$/, () => ({ body: [
        { id: 'motivo-demo-1', nombre: 'Sin dirección de entrega al recoger', activo: true, orden: 10 },
        { id: 'motivo-demo-2', nombre: 'Destino lejano (transportadora externa)', activo: true, orden: 20 },
        { id: 'motivo-demo-3', nombre: 'Otro', activo: true, orden: 30 },
        { id: 'motivo-demo-4', nombre: 'Documentos incompletos en el organismo', activo: true, orden: 40 },
      ] })],
    ]);
    await entrarComoAdminDemo(page);

    await page.goto('/flito/logistica');
    await expect(page.getByText('FLIT-DEMO-302')).toBeVisible();

    // Paso 1 — Trámites: buscador, empresa, los cinco estados y la tabla.
    const mostrarBarra = await sinBarraFlotante(page);
    await sinFoco(page);
    await capturar(page, dir, '01-tramites');
    await mostrarBarra();

    // Paso 2 — Detalle de la licencia Registrada: datos, Viajes adicionales y Bitácora.
    await page.getByRole('row', { name: /FLIT-DEMO-302/ }).getByRole('button', { name: 'Detalle' }).click();
    const detalle = page.getByRole('dialog', { name: /^Licencia · / });
    await expect(detalle.getByText('Viajes: 2 (incluye el viaje 1)')).toBeVisible();
    await sinFoco(page);
    await capturar(page, dir, '02-detalle', detalle);

    // Paso 3 — Registrar viaje: motivo y Precio inicial con la tarifa vigente (sin confirmar).
    await detalle.getByRole('button', { name: 'Registrar viaje' }).click();
    const registrar = page.getByRole('dialog', { name: /^Registrar viaje · / });
    await registrar.locator('select').selectOption('segunda_entrega');
    await expect(registrar.getByText(/Se copiará la tarifa vigente/)).toBeVisible();
    await sinFoco(page);
    await capturar(page, dir, '03-registrar-viaje', registrar);
    await registrar.getByRole('button', { name: 'Cancelar' }).click();
    await page.keyboard.press('Escape');
    await expect(detalle).toBeHidden();

    // Paso 6 — Viajes: precio de Cliente y de FLIT (HU #14123).
    await page.getByRole('button', { name: /^Viajes(?! adicionales)/ }).click();
    await expect(page.getByText(/Cliente \$12\.000 por LT/)).toBeVisible();
    await expect(page.getByText(/FLIT \$8\.000 por LT/)).toBeVisible();
    await sinFoco(page);
    await capturar(page, dir, '04-viajes-a-cliente');

    // Paso 7 — Entregas (HU #14125): tabla de seguimiento, sin acciones de destino.
    await page.getByRole('button', { name: 'Entregas' }).click();
    await expect(page.getByRole('columnheader', { name: 'Compañía' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Concesionario Demo Norte' })).toBeVisible();
    await sinFoco(page);
    await capturar(page, dir, '08-entregas');

    // Paso 6 — Actas: Generada, Despachada y Entregada con sus acciones.
    await page.getByRole('button', { name: /^Actas/ }).click();
    await expect(page.getByRole('button', { name: 'Firmar y despachar' })).toBeVisible();
    await sinFoco(page);
    await capturar(page, dir, '05-actas');

    // Paso 7 — Firmar entrega y despachar: mensajero y firma (sin confirmar).
    await page.getByRole('button', { name: 'Firmar y despachar' }).click();
    const despachar = page.getByRole('dialog', { name: 'Firmar entrega y despachar' });
    await despachar.locator('select').selectOption('51');
    await despachar.locator('canvas').evaluate((el: HTMLCanvasElement) => {
      const r = el.getBoundingClientRect();
      const pe = (type: string, x: number, y: number) =>
        el.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerId: 1 }));
      pe('pointerdown', 20, 40); pe('pointermove', 70, 15); pe('pointermove', 120, 55); pe('pointermove', 170, 20); pe('pointerup', 170, 20);
    });
    await expect(despachar.getByRole('button', { name: 'Firmar y despachar' })).toBeEnabled();
    await sinFoco(page);
    await capturar(page, dir, '06-firmar-y-despachar', despachar);
    await page.keyboard.press('Escape');

    // Paso 11 — Motivos de llegada (HU #14120): catálogo en orden, sin badge.
    await page.getByRole('button', { name: 'Motivos de llegada' }).click();
    await expect(page.getByText('Sin dirección de entrega al recoger')).toBeVisible();
    const mostrarBarraMotivos = await sinBarraFlotante(page);
    await sinFoco(page);
    await capturar(page, dir, '07-motivos-de-llegada');
    await mostrarBarraMotivos();

    comprobarCierre(api, dir, [
      '01-tramites.png', '02-detalle.png', '03-registrar-viaje.png', '04-viajes-a-cliente.png',
      '05-actas.png', '06-firmar-y-despachar.png', '07-motivos-de-llegada.png', '08-entregas.png',
    ]);
  });

  // ── Área Super Admin (HU #13774) ──────────────────────────────────────────
  test('privacy_log_pii @capturas', async ({ page }) => {
    const dir = prepararCarpeta('privacy_log_pii');
    const api = await interceptarApiDemo(page, [
      [/\/api\/privacy\/pii-access-log\/stats$/, () => ({ body: LOG_PII_STATS_DEMO })],
      [/\/api\/privacy\/pii-access-log$/, (route) => {
        const accionFiltro = new URL(route.request().url()).searchParams.get('accion');
        const rows = accionFiltro ? LOG_PII_DEMO.rows.filter((r) => r.accion === accionFiltro) : LOG_PII_DEMO.rows;
        return { body: { rows, total: rows.length } };
      }],
    ]);
    await entrarComoAdminDemo(page);
    await page.goto('/privacy/log-pii');
    await expect(page.getByText('Top usuarios (últimos 30 días)')).toBeVisible();
    await expect(page.getByText(LOG_PII_DEMO.rows[0].ipOrigen).first()).toBeVisible();

    // Paso 1 — Resumen de los últimos 30 días: quién y qué recurso concentran los accesos.
    await sinFoco(page);
    await capturar(page, dir, '01-resumen');

    // Paso 2 — Filtro por acción (lectura) y la tabla con fecha, usuario, recurso, campos e IP de documentación.
    await page.locator('select').selectOption('read');
    await expect(page.getByText(/^Total: 2 · página 1 de 1$/)).toBeVisible();
    await page.locator('select').evaluate((el) => el.scrollIntoView({ block: 'start' }));
    const mostrarBarra = await sinBarraFlotante(page);
    await sinFoco(page);
    await capturar(page, dir, '02-filtros');
    await mostrarBarra();

    comprobarCierre(api, dir, ['01-resumen.png', '02-filtros.png']);
  });

  test('privacy @capturas', async ({ page }) => {
    const dir = prepararCarpeta('privacy');
    // AC4 (HU #13774): solo la previsualización tiene fixture. La anonimización no se pulsa ni se mockea: si la
    // captura la disparara, `comprobarCierre` la vería como petición sin fixture.
    const api = await interceptarApiDemo(page, [
      [/\/api\/privacy\/preview\/[^/]+$/, () => ({ body: PRIVACY_PREVIEW_DEMO })],
    ]);
    await entrarComoAdminDemo(page);
    await page.goto('/privacy');
    await expect(page.getByText('Política de anonimización')).toBeVisible();

    // Paso 1 — Política y documento demo escrito (sin previsualizar todavía).
    await page.locator('form input').first().fill(PRIVACY_PREVIEW_DEMO.docNumber);
    await sinFoco(page);
    await capturar(page, dir, '01-documento');

    // Paso 2 — Previsualizar: registros que tocaría, por tipo. Estado previo: nadie pulsa «Anonimizar este documento».
    await page.getByRole('button', { name: 'Previsualizar' }).click();
    await expect(page.getByText(/7 registros afectados/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Anonimizar este documento' })).toBeVisible();
    const mostrarBarra = await sinBarraFlotante(page);
    await sinFoco(page);
    await capturar(page, dir, '02-registros-afectados');
    await mostrarBarra();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    comprobarCierre(api, dir, ['01-documento.png', '02-registros-afectados.png']);
  });

  test('drive @capturas', async ({ page }) => {
    const dir = prepararCarpeta('drive');
    const api = await interceptarApiDemo(page, [
      [/\/api\/drive\/procesar-cuentas$/, () => ({ body: DRIVE_PROCESO_DEMO })],
      [/\/api\/drive$/, (route) => ({
        body: new URL(route.request().url()).searchParams.get('folder') ? DRIVE_CARPETA_DEMO : DRIVE_RAIZ_DEMO,
      })],
    ]);
    await entrarComoAdminDemo(page);
    await page.goto('/drive');
    await expect(page.getByText(DRIVE_RAIZ_DEMO.folders[0].name)).toBeVisible();

    // Paso 1 — Carpeta raíz: carpetas y archivos.
    await sinFoco(page);
    await capturar(page, dir, '01-carpeta-raiz');

    // Paso 2 — Dentro de una carpeta: Atrás, la ruta y los PDF con Descargar y Procesar.
    await page.getByRole('button', { name: DRIVE_RAIZ_DEMO.folders[0].name }).click();
    await expect(page.getByText(DRIVE_CARPETA_DEMO.files[0].name)).toBeVisible();
    await sinFoco(page);
    await capturar(page, dir, '02-carpeta');

    // Paso 5 — Resultado del procesamiento de un PDF de cuentas de cobro demo.
    await page.getByRole('button', { name: 'Procesar', exact: true }).first().click();
    const resultado = page.getByRole('heading', { name: 'Resultado del procesamiento' });
    await expect(resultado).toBeVisible();
    await resultado.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    const mostrarBarra = await sinBarraFlotante(page);
    await sinFoco(page);
    await capturar(page, dir, '03-resultado');
    await mostrarBarra();

    comprobarCierre(api, dir, ['01-carpeta-raiz.png', '02-carpeta.png', '03-resultado.png']);
  });

  test('users @capturas', async ({ page }) => {
    const dir = prepararCarpeta('users');
    const api = await interceptarApiDemo(page, [
      [/\/api\/users\/resumen$/, () => ({ body: USUARIOS_RESUMEN_DEMO })],
      [/\/api\/users\/auditoria\/titulares$/, () => ({ body: USUARIOS_TITULARES_DEMO })],
      [/\/api\/users\/auditoria$/, () => ({ body: USUARIOS_HISTORIAL_DEMO })],
      [/\/api\/users$/, () => ({ body: USUARIOS_DEMO })],
      [/\/api\/permisos\/roles$/, () => ({ body: { roles: ROLES_DEMO } })],
      [/\/api\/permisos\/funciones$/, () => ({ body: { grupos: [] } })],
      [/\/api\/permisos\/roles\/[^/]+\/arbol$/, (route) => {
        const codigo = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2) ?? '');
        const rol = ROLES_DEMO.find((r) => r.codigo === codigo);
        return { body: { rol: { codigo, nombre: rol?.nombre ?? codigo, tipoEnlace: 'ninguno' }, arbol: arbolRol(ARBOL_DEMO, new Set(MARCAS_GESTOR)) } };
      }],
      [/\/api\/flito\/parametrizacion\/companias$/, () => ({ body: COMPANIAS_DEMO })],
      [/\/api\/flito\/parametrizacion\/proveedores-soat$/, () => ({ body: [] })],
      [/\/api\/flito\/parametrizacion\/organismos$/, () => ({ body: [] })],
    ]);
    await entrarComoAdminDemo(page);
    await page.goto('/users');
    await expect(page.getByRole('cell', { name: USUARIOS_DEMO[1].name })).toBeVisible();

    // Paso 1 — Lista: filtros, conteo por rol, Descargar Excel y las acciones de cada fila.
    const mostrarBarra = await sinBarraFlotante(page);
    await sinFoco(page);
    await capturar(page, dir, '01-usuarios');
    await mostrarBarra();

    // Paso 2 — Nuevo usuario: el formulario vacío (no se crea nadie).
    await page.getByRole('button', { name: 'Nuevo usuario' }).click();
    const nuevo = page.getByRole('dialog');
    await expect(nuevo).toBeVisible();
    await sinFoco(page);
    await capturar(page, dir, '02-nuevo-usuario', nuevo);
    await page.keyboard.press('Escape');
    await expect(nuevo).toBeHidden();

    // Paso 6 — Historial: quién cambió qué y cuándo.
    await page.getByRole('tab', { name: 'Historial' }).click();
    await expect(page.getByText(USUARIOS_TITULARES_DEMO[0].username).first()).toBeVisible();
    await sinFoco(page);
    await capturar(page, dir, '03-historial');

    comprobarCierre(api, dir, ['01-usuarios.png', '02-nuevo-usuario.png', '03-historial.png']);
  });

  test('roles_permisos @capturas', async ({ page }) => {
    const dir = prepararCarpeta('roles_permisos');
    const api = await interceptarApiDemo(page, [
      [/\/api\/permisos\/roles$/, () => ({ body: { roles: ROLES_DEMO } })],
      [/\/api\/permisos\/funciones$/, () => ({ body: { grupos: [] } })],
      [/\/api\/permisos\/roles\/[^/]+\/arbol$/, (route) => {
        const codigo = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2) ?? '');
        const rol = ROLES_DEMO.find((r) => r.codigo === codigo);
        const marcas = codigo === 'admin' ? codigosDe(ARBOL_DEMO) : MARCAS_GESTOR;
        return { body: { rol: { codigo, nombre: rol?.nombre ?? codigo, tipoEnlace: 'ninguno' }, arbol: arbolRol(ARBOL_DEMO, new Set(marcas)) } };
      }],
      [/\/api\/permisos\/roles\/[^/]+\/funciones$/, (route) => {
        const codigo = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2) ?? '');
        return { body: { codigo, tipoEnlace: 'ninguno', funciones: codigo === 'admin' ? codigosDe(ARBOL_DEMO) : MARCAS_GESTOR } };
      }],
    ]);
    await entrarComoAdminDemo(page);
    await page.goto('/roles-permisos');
    await expect(page.getByRole('heading', { name: 'Roles y permisos', level: 1 })).toBeVisible();

    // Paso 1 — Elegir el rol en la lista: a la derecha, sus permisos.
    await page.getByRole('button', { name: /^Gestor demo/ }).click();
    await expect(page.getByRole('heading', { name: 'Gestor demo', level: 2 })).toBeVisible();
    await sinFoco(page);
    await capturar(page, dir, '01-roles');

    // Paso 2 — Desplegar el elemento y el ítem: casillas de acción, una parcial.
    await page.getByRole('button', { name: 'Contenido de Gestión', exact: true }).click();
    await page.getByRole('button', { name: 'Contenido de SOAT', exact: true }).click();
    await expect(page.locator('input[type="checkbox"][data-codigo="accion.soat.ver_listado"]')).toBeChecked();
    await sinFoco(page);
    await capturar(page, dir, '02-arbol');

    // Paso 4 — Una marca cambiada: la barra «Sin guardar» con Descartar y Guardar cambios (no se guarda).
    await page.locator('input[type="checkbox"][data-codigo="accion.soat.exportar"]').click();
    await expect(page.getByText(/^Sin guardar/)).toBeVisible();
    const mostrarBarra = await sinBarraFlotante(page);
    await sinFoco(page);
    await capturar(page, dir, '03-sin-guardar');
    await mostrarBarra();
    await page.getByRole('button', { name: 'Descartar' }).click();
    const confirmar = page.getByRole('dialog');
    if (await confirmar.isVisible().catch(() => false)) await confirmar.getByRole('button', { name: /Descartar/ }).last().click();

    // Paso 6 — Nuevo rol: el formulario con las cuatro opciones de Enlace (no se crea).
    await page.getByRole('button', { name: 'Nuevo rol' }).click();
    const nuevo = page.getByRole('dialog', { name: 'Nuevo rol' });
    await expect(nuevo).toBeVisible();
    await sinFoco(page);
    await capturar(page, dir, '04-nuevo-rol', nuevo);
    await page.keyboard.press('Escape');

    comprobarCierre(api, dir, ['01-roles.png', '02-arbol.png', '03-sin-guardar.png', '04-nuevo-rol.png']);
  });

  test('siigo_credenciales @capturas', async ({ page }) => {
    const dir = prepararCarpeta('siigo_credenciales');
    const api = await interceptarApiDemo(page, [
      [/\/api\/siigo\/credenciales\/probar-conexion$/, () => ({ body: SIIGO_PRUEBA_DEMO })],
      [/\/api\/siigo\/credenciales$/, () => ({ body: SIIGO_CREDENCIALES_DEMO })],
    ]);
    await entrarComoAdminDemo(page);
    await page.goto('/siigo/credenciales');
    await expect(page.getByText(SIIGO_CREDENCIALES_DEMO.data[0].username).first()).toBeVisible();

    // Paso 1 — Una tarjeta por ambiente: pruebas Activa y producción Sin configurar.
    await sinFoco(page);
    await capturar(page, dir, '01-ambientes');

    // Paso 2 — Registrar credencial de producción: el formulario vacío (no se guarda nada).
    await page.getByRole('button', { name: /Registrar nueva credencial/ }).last().click();
    const registrar = page.getByRole('dialog');
    await expect(registrar).toBeVisible();
    await sinFoco(page);
    await capturar(page, dir, '02-registrar', registrar);
    await page.keyboard.press('Escape');
    await expect(registrar).toBeHidden();

    // Paso 3 — Probar conexión en pruebas: el resultado en la tarjeta.
    await page.getByRole('button', { name: /Probar conexión/ }).first().click();
    await expect(page.getByText(SIIGO_PRUEBA_DEMO.mensaje)).toBeVisible();
    await sinFoco(page);
    await capturar(page, dir, '03-probar-conexion');

    // Paso 5 — Historial del ambiente de pruebas, abierto.
    const historial = page.getByRole('button', { name: /^Pruebas: Historial de este ambiente/ });
    await historial.scrollIntoViewIfNeeded();
    await historial.click();
    await expect(historial).toHaveAttribute('aria-expanded', 'true');
    await historial.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    const mostrarBarra = await sinBarraFlotante(page);
    await sinFoco(page);
    await capturar(page, dir, '04-historial');
    await mostrarBarra();

    comprobarCierre(api, dir, ['01-ambientes.png', '02-registrar.png', '03-probar-conexion.png', '04-historial.png']);
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
    // HU #13901: listado por `POST /buscar`, detalle por `GET /bolsa/:id` y autogestión por `/estado`.
    const resumenes = BOLSAS_RIESGO_DEMO.map((b) => resumenDe(b));
    // HU #13908: las bolsas de tránsito llegan por el mismo `/buscar` (alcance 'transito'), en tabla.
    const transitos = BOLSAS_DEMO.transito.map((t) => ({
      id: t.id, alcance: 'transito', nombre: t.nombre, companiaId: null, companiaNombre: null, activa: true,
      conceptos: [...new Set(t.cobertura.map((c) => c.concepto))],
      cobertura: t.cobertura.map(({ organismoCodigo, concepto }) => ({ organismoCodigo, concepto })),
      saldo: t.saldo, ultimaEntradaValor: t.ultimaCargaValor, ultimaEntradaEn: t.ultimaCargaEn, nivel: 'normal',
      porcentaje: t.porcentaje,
      transito: { nivel: t.nivel, deuda: t.deuda, totalCargado: t.totalCargado, totalConsumido: t.totalConsumido },
    }));
    const api = await interceptarApiDemo(page, [
      [/\/api\/clients$/, () => ({ body: CLIENTES_DEMO })],
      [/\/api\/flito\/bolsas\/consolidado$/, () => ({ body: BOLSAS_DEMO.consolidado })],
      [/\/api\/flito\/bolsas\/buscar$/, () => ({ body: [...resumenes, ...transitos] })],
      [/\/api\/flito\/bolsas\/alertas$/, () => ({ body: BOLSAS_DEMO.alertas })],
      [/\/api\/flito\/bolsas\/bolsa\/bolsa-demo-1$/, () => ({ body: detalleDe(BOLSAS_RIESGO_DEMO[0], { conceptosAutogestionados: ['soat'] }) })],
      [/\/api\/flito\/bolsas\/compania\/\d+\/estado$/, () => ({ body: { existe: false, activa: false, conceptosAutogestionados: ['soat'] } })],
      [/\/api\/flito\/bolsas\/901\/extracto$/, () => ({ body: BOLSAS_DEMO.extracto })],
      [/\/api\/flito\/bolsas\/901\/movimientos$/, () => ({ body: BOLSAS_DEMO.movimientos })],
      [/\/api\/flito\/bolsas\/901\/cierres$/, () => ({ body: [] })],
      // HU #13892: la sección «Documentos» del detalle lee el expediente al montarse (E1).
      [/\/api\/flito\/bolsas-documentos\/companias\/901$/, () => ({ body: EXPEDIENTE_BOLSA_DEMO })],
      // HU #13893: el chip «Expediente» del listado pide el estado de todas las compañías en un lote (E6).
      [/\/api\/flito\/bolsas-documentos\/estado-lote$/, () => ({ body: ESTADO_LOTE_BOLSAS_DEMO })],
    ]);
    // Ningún rol trae por seed las funciones del expediente: se suman para que la ficha muestre la sección.
    await entrarComoAdminDemo(page, { ...ADMIN_DEMO, funciones: [
      ...(FUNCIONES_POR_ROL.admin ?? []), ...FUNCIONES_BOLSAS, 'bolsas.documentos.ver', 'bolsas.documentos.cargar',
      // HU #13908: el admin real lista y ve las de tránsito (seed 0179); sin ellas no sale el filtro Alcance.
      'bolsas.transito.listar', 'bolsas.transito.ver',
    ] });

    await page.goto('/flito/bolsas');
    await expect(page.getByText(EMPRESAS_DEMO[0]).first()).toBeVisible();

    // Paso 1 — Crear bolsa, KPI y barra de búsqueda.
    await capturar(page, dir, '01-cabecera-y-kpi');

    // Paso 2 — Compañías: alertas de saldo y tabla con estado, saldo, nivel, Expediente y Ver detalle.
    await expect(page.getByText('Docs completos')).toBeVisible();
    await page.getByText('Alertas de saldo').evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => window.scrollBy(0, -140));
    await capturar(page, dir, '02-companias');

    // Paso 3 — Formulario único: alcance, compañía, conceptos y aviso de autogestión.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByRole('button', { name: 'Crear bolsa', exact: true }).first().click();
    const form = page.getByRole('dialog', { name: 'Crear bolsa', exact: true });
    // Una compañía SIN bolsa (las demo con bolsa son 901 y 902): el alta limpia, con su autogestión.
    const sinBolsa = CLIENTES_DEMO.find((c: { id: number }) => !BOLSAS_RIESGO_DEMO.some((b) => b.companiaId === c.id));
    await form.getByLabel('Compañía *').selectOption(String(sinBolsa?.id ?? ''));
    await expect(form.getByText('Autogestionado')).toBeVisible();
    await capturar(page, dir, '03-crear-bolsa');
    await form.getByRole('button', { name: 'Cancelar' }).click();

    // Paso 4 — Detalle: estado, conceptos, recargar, mover, corregir o cerrar el periodo.
    await page.getByRole('button', { name: `Ver el detalle de la bolsa de ${EMPRESAS_DEMO[0]} (compañía)` }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('Ver el libro completo (todos los periodos)')).toBeVisible();
    await capturar(page, dir, '04-detalle-compania');

    // Paso 7 — Documentos: los 5 documentos de la compañía con su estado y sus acciones (HU #13892).
    const documentos = page.getByTestId('expediente-documental');
    await expect(documentos.getByText('Vigencia vencida')).toBeVisible();
    await documentos.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await sinFoco(page);
    await capturar(page, dir, '05-documentos', documentos);

    comprobarCierre(api, dir, [
      '01-cabecera-y-kpi.png', '02-companias.png', '03-crear-bolsa.png', '04-detalle-compania.png', '05-documentos.png',
    ]);
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
    await expect(page.getByRole('button', { name: /Fijar valor · Entrega a FLIT de / })).toBeVisible();

    // Paso 1 — Elegir la compañía: la lista marca las que tienen valores sin configurar.
    await capturar(page, dir, '01-elegir-compania');

    // Paso 2 — Fijar valor en el panel «Entrega a FLIT», Sin configurar.
    await page.getByRole('button', { name: /Fijar valor · Entrega a FLIT de / }).click();
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

  // ── Área Corredor SOAT (HU #13771) ──────────────────────────────────────────────────────────────

  test('flito_tablero @capturas', async ({ page }) => {
    const dir = prepararCarpeta('flito_tablero');
    const api = await interceptarApiDemo(page, [
      [/\/api\/flito\/tablero$/, () => ({ body: TABLERO_DEMO })],
    ]);
    await entrarComoAdminDemo(page);

    await page.goto('/flito/tablero');
    await expect(page.getByText('Revisiones pendientes')).toBeVisible();

    // Pasos 1 y 2 — Los cuatro indicadores y las alertas operativas.
    await capturar(page, dir, '01-indicadores-y-alertas');

    // Paso 3 — SOAT e Impuestos por estado.
    await page.getByText('SOAT por estado').evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await capturar(page, dir, '02-por-estado');

    comprobarCierre(api, dir, ['01-indicadores-y-alertas.png', '02-por-estado.png']);
  });

  // HU #13775 — Tablero de control: el Panel operativo de `/`. Lo ve quien NO tiene el Tablero FLITO
  // (`tablero.tablero.ver`), así que el Administrador demo entra sin esa función.
  test('dashboard @capturas', async ({ page }) => {
    const dir = prepararCarpeta('dashboard');
    const api = await interceptarApiDemo(page, [
      [/\/api\/soat\/stats$/, () => ({ body: PANEL_SOAT_STATS_DEMO })],
      [/\/api\/fleet\/documents\/expiring$/, () => ({ body: PANEL_VENCIMIENTOS_DEMO })],
      [/\/api\/rndc\/manifiestos$/, () => ({ body: PANEL_RNDC_DEMO })],
    ]);
    const sinTableroFlito = { ...ADMIN_DEMO, funciones: FUNCIONES_POR_ROL.admin.filter((f) => f !== 'tablero.tablero.ver') };
    await entrarComoAdminDemo(page, sinTableroFlito);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Estado operativo' })).toBeVisible();
    await expect(page.getByText('36 de 45')).toBeVisible();

    // Paso 1 — Estado operativo con sus cuatro indicadores y las tarjetas Flota y Salud SOAT.
    await page.waitForTimeout(1500); // los contadores animados terminan de subir
    const mostrarBarra = await sinBarraFlotante(page);
    await sinFoco(page);
    await capturar(page, dir, '01-estado-operativo');

    // Paso 3 — Atención operativa y la fila de atajos.
    await page.getByRole('region', { name: 'Atención operativa' }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await sinFoco(page);
    await capturar(page, dir, '02-atencion-y-atajos');
    await mostrarBarra();

    comprobarCierre(api, dir, ['01-estado-operativo.png', '02-atencion-y-atajos.png']);
  });

  // HU #13775 — Organismos de tránsito: tabla y las tres pestañas de Editar. No se guarda nada.
  test('transito_organismos @capturas', async ({ page }) => {
    const dir = prepararCarpeta('transito_organismos');
    const api = await interceptarApiDemo(page, [
      [/\/api\/transito\/organismos-config\/[^/]+\/checklist\/[^/]+$/, () => ({ body: ORGANISMO_PLANTILLA_DEMO })],
      [/\/api\/transito\/organismos-config$/, () => ({ body: ORGANISMOS_CONFIG_DEMO })],
      [/\/api\/flito\/parametrizacion\/organismos\/[^/]+\/vigencias$/, () => ({ body: ORGANISMO_VIGENCIAS_DEMO })],
      [/\/api\/flito\/parametrizacion\/organismos$/, () => ({ body: ORGANISMOS_MODALIDAD_DEMO })],
    ]);
    await entrarComoAdminDemo(page);
    await page.goto('/transito/organismos');
    await expect(page.getByText(ORGANISMOS_CONFIG_DEMO[0].codigo)).toBeVisible();

    // Paso 1 — La tabla con el buscador.
    await sinFoco(page);
    await capturar(page, dir, '01-organismos');

    // Paso 2 — Editar, pestaña General.
    await page.getByRole('button', { name: 'Editar' }).first().click();
    const editar = page.getByRole('dialog');
    await expect(editar).toBeVisible();
    await sinFoco(page);
    await capturar(page, dir, '02-general', editar);

    // Paso 3 — Pestaña Autogestión con el historial de vigencias.
    await editar.getByRole('button', { name: 'Autogestión' }).click();
    const vigencia = editar.getByText(ORGANISMO_VIGENCIAS_DEMO[0].motivo, { exact: false });
    await expect(vigencia).toBeVisible();
    // La ventana se desplaza hasta el historial: es lo que el paso explica junto al cambio de modalidad.
    await vigencia.evaluate((el) => el.scrollIntoView({ block: 'end' }));
    await sinFoco(page);
    await capturar(page, dir, '03-autogestion', editar);

    // Paso 5 — Pestaña Plantilla documentos con un anexo propio del organismo.
    await editar.getByRole('button', { name: 'Plantilla documentos' }).click();
    await expect(editar.getByText(ORGANISMO_PLANTILLA_DEMO.override.add[0].label)).toBeVisible();
    await sinFoco(page);
    await capturar(page, dir, '04-plantilla', editar);

    comprobarCierre(api, dir, ['01-organismos.png', '02-general.png', '03-autogestion.png', '04-plantilla.png']);
  });

  test('flito_bitacora @capturas', async ({ page }) => {
    const dir = prepararCarpeta('flito_bitacora');
    const api = await interceptarApiDemo(page, [
      [/\/api\/flito\/bitacora$/, () => ({ body: BITACORA_DEMO })],
    ]);
    await entrarComoAdminDemo(page);

    await page.goto('/flito/bitacora');
    await expect(page.getByText('Pago confirmado por factura')).toBeVisible();

    // Pasos 1 a 3 — Recurso, límite y la tabla de movimientos.
    await capturar(page, dir, '01-movimientos');

    comprobarCierre(api, dir, ['01-movimientos.png']);
  });

  test('flito_revisiones @capturas', async ({ page }) => {
    const dir = prepararCarpeta('flito_revisiones');
    const api = await interceptarApiDemo(page, [
      [/\/api\/flito\/revisiones$/, (route) => ({
        body: new URL(route.request().url()).searchParams.get('modulo') === 'soat' ? REVISIONES_DEMO : [],
      })],
      [/\/api\/flito\/revisiones\/campos\/soat$/, () => ({ body: REVISION_CAMPOS_SOAT })],
      [/\/api\/flito\/soat$/, () => ({ body: REVISION_CANDIDATOS_SOAT })],
      [/\/api\/flito\/revisiones\/soporte\/[^/]+\/archivo$/, () => ({ body: PDF_DEMO, contentType: 'application/pdf' })],
    ]);
    await entrarComoAdminDemo(page);

    await page.goto('/flito/revisiones');
    await expect(page.getByText(`poliza-${DATOS_DEMO.placas[0]}.pdf`).first()).toBeVisible();
    await expect(page.getByText('Número de póliza')).toBeVisible();

    // Pasos 1 y 2 — Grupo, cola y documento.
    await capturar(page, dir, '01-cola-y-documento');

    // Paso 3 — Elegir el trámite y revisar los campos.
    await page.getByLabel('Trámite contra el que se concilia *').selectOption('soat-demo-1');
    await expect(page.getByText('Leído del PDF')).toBeVisible();
    await sinFoco(page);
    await capturar(page, dir, '02-revisar-campos');

    // Paso 4 — Confirmar y resolver deja constancia.
    await page.getByRole('button', { name: 'Confirmar y resolver' }).click();
    await page.getByText('Deja constancia de qué validaste').evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await sinFoco(page);
    await capturar(page, dir, '03-constancia');

    comprobarCierre(api, dir, ['01-cola-y-documento.png', '02-revisar-campos.png', '03-constancia.png']);
  });

  test('clients @capturas', async ({ page }) => {
    const dir = prepararCarpeta('clients');
    const api = await interceptarApiDemo(page, [
      // HU #14162: `GET /clients` ya trae el proveedor de logística (id y nombre).
      [/\/api\/clients$/, () => ({
        body: (CLIENTES_FICHA_DEMO as any[]).map((c) => (c.logisticaAutogestionable
          ? { ...c, proveedorLogisticaId: null, proveedorLogisticaNombre: null }
          : { ...c, proveedorLogisticaId: '11111111-aaaa-4aaa-8aaa-111111111111', proveedorLogisticaNombre: 'Logística Demo' })),
      })],
      [/\/api\/flito\/parametrizacion\/proveedores-soat$/, () => ({ body: PROVEEDORES_SOAT_DEMO })],
      [/\/api\/flito\/parametrizacion\/proveedores-logistica$/, () => ({ body: [] })],
      // HU #14162: la pestaña Proveedores lee el listado unificado del servidor.
      [/\/api\/flito\/parametrizacion\/proveedores$/, () => ({
        body: (PROVEEDORES_SOAT_DEMO as any[]).map((p) => ({ tipo: 'soat', id: p.id, nombre: p.nombre, nit: null, contacto: null, telefono: null, activo: p.activo, companiasAsignadas: 0 })),
      })],
      [/\/api\/siigo\/clientes\/validacion\/detalle$/, () => ({ body: SIIGO_VALIDACION_DETALLE_DEMO })],
    ]);
    await entrarComoAdminDemo(page);

    await page.goto('/clients');
    await expect(page.getByText(EMPRESAS_DEMO[0]).first()).toBeVisible();

    // Pasos 1 a 3 — Clientes con su autogestión.
    await capturar(page, dir, '01-clientes');

    // Paso 4 — SOAT sin trámite: el proveedor de la compañía, con el aviso del permiso sin efecto.
    // Desde HU #14105 el proveedor se edita en el modal «Editar» de la compañía (el chip ya no es un botón).
    await page.getByRole('button', { name: `Editar ${EMPRESAS_DEMO[2]}`, exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await capturar(page, dir, '02-soat-sin-tramite', page.getByRole('dialog'));
    await page.keyboard.press('Escape');
    await sinFoco(page);

    // Paso 6 — Proveedores.
    await page.getByRole('button', { name: 'Proveedores', exact: true }).click();
    await expect(page.getByText(ASEGURADORAS_DEMO[1])).toBeVisible();
    await sinFoco(page);
    await capturar(page, dir, '03-proveedores');

    comprobarCierre(api, dir, ['01-clientes.png', '02-soat-sin-tramite.png', '03-proveedores.png']);
  });

  test('flito_comparendos @capturas', async ({ page }) => {
    const dir = prepararCarpeta('flito_comparendos');
    const api = await interceptarApiDemo(page, [
      [/\/api\/flito\/comparendos\/registros(\/buscar)?$/, () => ({ body: COMPARENDOS_REGISTROS_DEMO })],
      [/\/api\/flito\/comparendos\/registros\/cmp-demo-1$/, () => ({ body: COMPARENDO_DETALLE_DEMO })],
      [/\/api\/flito\/comparendos\/nits$/, () => ({ body: COMPARENDOS_NITS_DEMO })],
      [/\/api\/flito\/comparendos\/municipios$/, () => ({ body: COMPARENDOS_MUNICIPIOS_DEMO })],
      [/\/api\/flito\/comparendos\/causales$/, () => ({ body: COMPARENDOS_CAUSALES_DEMO })],
      [/\/api\/flito\/comparendos\/config\/token-simit$/, () => ({ body: COMPARENDOS_TOKEN_DEMO })],
      [/\/api\/flito\/comparendos\/sync\/runs$/, () => ({ body: COMPARENDOS_RUNS_DEMO })],
      [/\/api\/flito\/comparendos\/sync\/runs\/run-demo-\d$/, () => ({ body: { ...COMPARENDOS_RUNS_DEMO[0], steps: [] } })],
    ]);
    await entrarComoAdminDemo(page);

    await page.goto('/flito/comparendos');
    await expect(page.getByText('99999000000001').first()).toBeVisible();

    // Paso 1 — Registros: buscar por N.º, NIT o placa y la tabla consolidada.
    await page.getByText('N.º de comparendo', { exact: true }).first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => window.scrollBy(0, -90)); // bajo la cabecera fija
    const mostrarBarraC = await sinBarraFlotante(page);
    await capturar(page, dir, '01-registros');
    await mostrarBarraC();

    // Paso 2 — Detalle del comparendo con causal y observación.
    await page.getByText('99999000000001').first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await capturar(page, dir, '02-detalle');
    await page.keyboard.press('Escape');

    // Paso 4 — Sincronización.
    await page.goto('/flito/comparendos?vista=sincronizacion');
    await expect(page.getByRole('heading', { name: 'Sincronizar ahora' })).toBeVisible();
    await sinFoco(page);
    await capturar(page, dir, '03-sincronizacion');

    // Paso 5 — Configuración.
    await page.goto('/flito/comparendos?vista=configuracion');
    await expect(page.getByText(EMPRESAS_DEMO[0]).first()).toBeVisible();
    await sinFoco(page);
    await capturar(page, dir, '04-configuracion');

    comprobarCierre(api, dir, ['01-registros.png', '02-detalle.png', '03-sincronizacion.png', '04-configuracion.png']);
  });

  test('flito_tramites @capturas', async ({ page }) => {
    const dir = prepararCarpeta('flito_tramites');
    const api = await interceptarApiDemo(page, [
      [/\/api\/flito\/tramites$/, () => ({ body: TRAMITES_DEMO })],
      [/\/api\/flito\/tramites\/facetas$/, () => ({ body: TRAMITES_FACETAS_DEMO })],
      [/\/api\/flito\/parametrizacion\/companias$/, () => ({ body: COMPANIAS_DEMO })],
      [/\/api\/flito\/parametrizacion\/proveedores-soat$/, () => ({ body: PROVEEDORES_SOAT_DEMO })],
      [/\/api\/flito\/sync\/interruptores$/, () => ({ body: SYNC_DEMO.interruptores })],
      [/\/api\/flito\/sync\/estado$/, () => ({ body: SYNC_DEMO.estado1 })],
      [/\/api\/flito\/sync\/flit2\/estado$/, () => ({ body: SYNC_DEMO.estado2 })],
      [/\/api\/flito\/sync\/flit1\/estado-lectura$/, () => ({ body: SYNC_DEMO.lectura1 })],
    ]);
    await entrarComoAdminDemo(page);

    await page.goto('/flito/tramites');
    await expect(page.getByText('FLIT-DEMO-101')).toBeVisible();

    // Pasos 1 y 2 — La tarjeta Sincronización desplegada, con sus dos grupos.
    const cabecera = page.getByTestId('cabecera-sincronizacion');
    await cabecera.click();
    await expect(cabecera).toHaveAttribute('aria-expanded', 'true');
    await sinFoco(page);
    await capturar(page, dir, '01-sincronizacion');
    await cabecera.click();
    await sinFoco(page);

    // Paso 3 — Buscar, filtrar y la tabla.
    await page.getByText('FLIT-DEMO-101').evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const mostrarBarra = await sinBarraFlotante(page);
    await capturar(page, dir, '02-filtros-y-tabla');

    // Pasos 4 y 5 — Marcar trámites: los botones dicen sobre cuántos actúan.
    for (const placa of DATOS_DEMO.placas) await page.getByLabel(`Seleccionar ${placa}`).check();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByText('FLIT-DEMO-101').evaluate((el) => el.scrollIntoView({ block: 'end' }));
    await sinFoco(page);
    await capturar(page, dir, '03-seleccion');
    await mostrarBarra();

    // Paso 6 — Descargar soportes: elegir los documentos del ZIP.
    await page.getByRole('button', { name: /^Descargar soportes \(/ }).click();
    const zip = page.getByRole('dialog', { name: 'Documentos del ZIP' });
    await expect(zip).toBeVisible();
    await capturar(page, dir, '04-documentos-del-zip', zip);
    await page.keyboard.press('Escape');

    comprobarCierre(api, dir, ['01-sincronizacion.png', '02-filtros-y-tabla.png', '03-seleccion.png', '04-documentos-del-zip.png']);
  });

  test('soat @capturas', async ({ page }) => {
    const dir = prepararCarpeta('soat');
    const api = await interceptarApiDemo(page, [
      [/\/api\/flito\/soat$/, () => ({ body: { items: SOAT_COLA_DEMO, total: SOAT_COLA_DEMO.length, page: 1, pageSize: 50 } })],
      [/\/api\/flito\/soat\/facetas$/, () => ({ body: SOAT_FACETAS_DEMO })],
      [/\/api\/flito\/soat\/cliente\/incompletas\/buscar$/, (route) => {
        const { estados } = route.request().postDataJSON() as { estados: string[] };
        const items = estados.includes('incompleta') ? [SOAT_POR_VALIDAR_DEMO] : [];
        return { body: { items, total: items.length, conteos: { incompleta: 1, descartada: 0 } } };
      }],
      [/\/api\/flito\/parametrizacion\/proveedores-soat$/, () => ({ body: PROVEEDORES_SOAT_DEMO })],
      [/\/api\/flito\/soat\/soat-demo-2\/documentos-adicionales$/, () => ({ body: SOAT_DOCUMENTOS_ADICIONALES_DEMO })],
    ]);
    await entrarComoAdminDemo(page);

    await page.goto('/flito/soat');
    await expect(page.getByText(DATOS_DEMO.placas[0]).first()).toBeVisible();

    // Pasos 1 y 2 — Pastillas, buscador, Más filtros y vistas rápidas; arriba, la solicitud por validar.
    await capturar(page, dir, '01-cola');

    // Paso 4 — Marcar filas y enviar al gestor: el botón dice sobre cuántas actúa.
    for (const placa of DATOS_DEMO.placas.slice(0, 3)) await page.getByLabel(new RegExp(`Seleccionar.*${placa}`)).first().check();
    await sinFoco(page);
    await capturar(page, dir, '02-enviar-al-gestor');
    await page.getByRole('button', { name: 'Quitar selección' }).click();

    // Pasos 6 y 7 — El detalle de un SOAT pagado: estado, comprobante y correcciones.
    await page.getByRole('row', { name: new RegExp(`Seleccionar ${DATOS_DEMO.placas[1]}`) }).getByRole('button', { name: 'Ver', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.waitForTimeout(500);
    await capturar(page, dir, '03-detalle', page.getByRole('dialog'));
    await page.keyboard.press('Escape');

    // Paso 8 — Solicitar SOAT (Cliente con el canal abierto): compañía fija, VIN y lo que falta para enviar.
    // Se ilustra antes de consultar el RUNT: el VIN demo lleva «O» (imposible en un VIN real) y el
    // formulario lo rechaza, así que la ficha del RUNT no se puede capturar con datos del registro.
    const cliente = await page.context().newPage();
    const apiCliente = await interceptarApiDemo(cliente, [
      [/\/api\/flito\/soat\/cliente\/companias$/, () => ({ body: SOAT_COMPANIAS_CANAL_DEMO })],
    ]);
    await entrarComoDemo(cliente, { ...CLIENTE_CON_CANAL, username: 'cliente_demo', name: NOMBRES_DEMO[0], companiaId: 901 });
    await cliente.goto('/flito/soat/solicitud');
    await elegirTipoInicial(cliente);
    await expect(cliente.getByText(EMPRESAS_DEMO[0]).first()).toBeVisible();
    await expect(cliente.getByRole('button', { name: 'Consultar el RUNT' })).toBeVisible();
    await sinFoco(cliente);
    await capturar(cliente, dir, '04-solicitar-soat');
    expect(apiCliente.noMockeados, 'endpoints /api sin fixture demo (Cliente)').toEqual([]);
    await cliente.close();

    comprobarCierre(api, dir, ['01-cola.png', '02-enviar-al-gestor.png', '03-detalle.png', '04-solicitar-soat.png']);
  });

  test('flito_impuestos @capturas', async ({ page }) => {
    const dir = prepararCarpeta('flito_impuestos');
    const api = await interceptarApiDemo(page, [
      [/\/api\/flito\/impuestos$/, () => ({ body: { items: IMPUESTOS_COLA_DEMO, total: IMPUESTOS_COLA_DEMO.length, page: 1, pageSize: 50 } })],
      [/\/api\/flito\/impuestos\/facetas$/, () => ({ body: IMPUESTOS_FACETAS_DEMO })],
      [/\/api\/flito\/impuestos\/imp-demo-2$/, () => ({ body: IMPUESTO_DETALLE_DEMO })],
    ]);
    await entrarComoAdminDemo(page);

    await page.goto('/flito/impuestos');
    await expect(page.getByText('FLIT-DEMO-101')).toBeVisible();

    // Pasos 1 y 2 — Pastillas de estado, buscador, filtros y la tabla con el semáforo de cada trámite.
    await page.getByRole('button', { name: 'Todos', exact: true }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => window.scrollBy(0, -90)); // deja ver el borde superior de la tarjeta de filtros
    const mostrarBarraCola = await sinBarraFlotante(page);
    await sinFoco(page);
    await capturar(page, dir, '01-cola');
    await mostrarBarraCola();

    // Paso 4 — Marcar filas: cada acción dice sobre cuántas de las marcadas actúa.
    for (const placa of DATOS_DEMO.placas) await page.getByLabel(`Seleccionar ${placa}`).check();
    await expect(page.getByRole('button', { name: /^Enviar al gestor \(1 de 4\)$/ })).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await sinFoco(page);
    await capturar(page, dir, '02-seleccion');
    for (const placa of DATOS_DEMO.placas) await page.getByLabel(`Seleccionar ${placa}`).uncheck();

    // Paso 7 — Carga masiva de recibos: la fase del recibo se elige antes de enviar.
    await page.getByRole('button', { name: 'Cargar recibos (masivo)' }).click();
    const carga = page.getByRole('dialog');
    await expect(carga).toBeVisible();
    await sinFoco(page);
    await capturar(page, dir, '03-carga-masiva', carga);
    await page.keyboard.press('Escape');
    await expect(carga).toBeHidden();

    // Paso 15 — El semáforo naranja abre la validación factura ↔ RUNT sin salir de la cola.
    await page.getByRole('row', { name: new RegExp(`Seleccionar ${DATOS_DEMO.placas[1]}`) })
      .getByRole('button', { name: /Con diferencias/ }).click();
    const validacion = page.getByRole('dialog');
    await expect(validacion.getByText('2 datos no coinciden: Color, Cilindraje.')).toBeVisible();
    await sinFoco(page);
    await capturar(page, dir, '04-validacion-runt', validacion);
    await page.keyboard.press('Escape');
    await expect(validacion).toBeHidden();

    // Pasos 11 y 16 — El detalle (Ver): factura de venta, liquidación y la validación contra el RUNT.
    await page.getByRole('row', { name: new RegExp(`Seleccionar ${DATOS_DEMO.placas[1]}`) }).getByRole('button', { name: 'Ver', exact: true }).click();
    const detalle = page.getByRole('dialog');
    await expect(detalle.getByText('2 datos no coinciden: Color, Cilindraje.')).toBeVisible();
    await sinFoco(page);
    await capturar(page, dir, '05-detalle', detalle);
    await page.keyboard.press('Escape');

    comprobarCierre(api, dir, ['01-cola.png', '02-seleccion.png', '03-carga-masiva.png', '04-validacion-runt.png', '05-detalle.png']);
  });

  test('flito_derechos @capturas', async ({ page }) => {
    const dir = prepararCarpeta('flito_derechos');
    const api = await interceptarApiDemo(page, [
      [/\/api\/flito\/derechos$/, () => ({ body: DERECHOS_DEMO })],
      [/\/api\/flito\/derechos\/facetas$/, () => ({ body: DERECHOS_FACETAS_DEMO })],
      [/\/api\/flito\/derechos\/cargar$/, () => ({ body: DERECHOS_RESULTADO_DEMO })],
      [/\/api\/flito\/derechos\/drive\/archivos$/, () => ({ body: DERECHOS_DRIVE_DEMO })],
      [/\/api\/flito\/derechos\/drive\/registro$/, () => ({ body: DERECHOS_DRIVE_REGISTRO_DEMO })],
    ]);
    await entrarComoAdminDemo(page);

    await page.goto('/flito/derechos');
    await expect(page.getByText('FLIT-DEMO-101')).toBeVisible();

    // Pasos 1 y 2 — Cargar un recibo (archivo sintético) y leer el resultado por canastas.
    await page.locator('input[type="file"]').setInputFiles({ name: 'recibo-demo.png', mimeType: 'image/png', buffer: PNG_DEMO });
    await page.getByRole('button', { name: 'Cargar (1)' }).click();
    await expect(page.getByText(/Resultado de la carga/)).toBeVisible();
    await page.waitForTimeout(4500); // deja que se vaya el aviso de la carga: el paso ilustra el panel
    await page.getByText(/Resultado de la carga/).evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => window.scrollBy(0, -200)); // el panel con la tarjeta de carga encima
    const mostrarBarraCarga = await sinBarraFlotante(page);
    await sinFoco(page);
    await capturar(page, dir, '01-resultado-de-la-carga');
    await page.getByRole('button', { name: 'Cerrar', exact: true }).click();
    await mostrarBarraCarga();

    // Paso 4 — Drive · Medellín: consolidados del día, Procesar o Reprocesar y el registro de pasadas.
    await page.getByRole('button', { name: 'Drive · Medellín' }).click();
    await page.getByRole('button', { name: /^Ver el registro/ }).click();
    await expect(page.getByText('Registro de procesamientos')).toBeVisible();
    await page.getByRole('button', { name: 'Reprocesar' }).evaluate((el) => el.scrollIntoView({ block: 'end' }));
    await page.evaluate(() => window.scrollBy(0, 40));
    const mostrarBarraDrive = await sinBarraFlotante(page);
    await sinFoco(page);
    await capturar(page, dir, '02-drive');
    await mostrarBarraDrive();

    // Paso 5 — Registrados: buscar, filtrar, abrir el soporte o los documentos; la fila con advertencia.
    await page.getByRole('button', { name: /^Registrados/ }).click();
    await page.getByText('FLIT-DEMO-103').evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const mostrarBarra = await sinBarraFlotante(page);
    await sinFoco(page);
    await capturar(page, dir, '03-registrados');
    await mostrarBarra();

    comprobarCierre(api, dir, ['01-resultado-de-la-carga.png', '02-drive.png', '03-registrados.png']);
  });
});
