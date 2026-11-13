// TEMPORAL (Épica #14560, sesión B): barrido responsive de todas las rutas en 360/390/768/1024/1280/1440 claro + 390/1280
// oscuro, con /api mockeado (fixtures de datos-demo + zz-barrido-fixtures.ts). Mide desborde horizontal, controles fuera del
// viewport o recortados y objetivos táctiles <44 px; escribe PNG + JSON en BARRIDO_OUT. Lo borra la sesión A tras el barrido
// final sobre la base integrada. Solo corre con BARRIDO_OUT (nunca en CI ni en `playwright test` a secas):
//   BARRIDO_OUT=/ruta PW_PORT=5181 npx playwright test e2e/tests/zz-barrido-responsive.spec.ts --project=chromium
//   (BARRIDO_RUTAS="/ruta1 /ruta2" limita las rutas)
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from '@playwright/test';
import { ADMIN_USER, loginAs } from '../helpers/auth';
import * as D from '../helpers/datos-demo';
import { TABLA_EXTRA } from './zz-barrido-fixtures';

const OUT = process.env.BARRIDO_OUT ?? '';
const PUBLICAS = new Set(['/login', '/tramite/verificar']);
const RUTAS = [
  '/login',
  '/tramite/verificar',
  '/',
  '/vehicles',
  '/clients',
  '/soat',
  '/tramite',
  '/tramite/traspaso',
  '/tax-reader',
  '/flito/tramites',
  '/flito/tablero',
  '/flito/soat',
  '/flito/soat/solicitud',
  '/flito/impuestos',
  '/flito/impuestos/certificar',
  '/flito/comprobantes',
  '/flito/derechos',
  '/flito/revisiones',
  '/flito/compuerta',
  '/flito/bitacora',
  '/flito/logistica',
  '/flito/ruta',
  '/flito/ayuda',
  '/flito/ayuda/demo-1',
  '/flito/bolsas',
  '/flito/comparendos',
  '/flito/tarifas',
  '/flito/tarifas/demo-1',
  '/flito/tarifas/proveedores',
  '/flito/tarifas/proveedores/demo-1',
  '/flito/servicios-adicionales',
  '/flito/conciliacion',
  '/flito/conciliacion/demo-1',
  '/siigo/parametrizacion',
  '/siigo/operacion',
  '/siigo/credenciales',
  '/finanzas/reporte-costos',
  '/finanzas/gastos-diarios',
  '/users',
  '/perfil',
  '/roles-permisos',
  '/transito',
  '/transito/traspaso',
  '/transito/organismos',
  '/drive',
  '/laft',
  '/laft/unusual',
  '/laft/trainings',
  '/laft/manual',
  '/laft/oficial',
  '/laft/plan-auditorias',
  '/laft/tablero',
  '/privacy',
  '/fleet',
  '/fleet/demo-1',
  '/maintenance',
  '/maintenance/routines',
  '/maintenance/schedule',
  '/parts',
  '/maintenance/work-orders',
  '/maintenance/work-orders/demo-1',
  '/maintenance/indicators',
  '/pesv',
  '/pesv/conductores',
  '/pesv/conductores/demo-1',
  '/pesv/capacitaciones',
  '/pesv/incidentes',
  '/pesv/incidentes/stats',
  '/pesv/checklists',
  '/pesv/checklists/nuevo',
  '/pesv/alcoholimetria',
  '/pesv/emergencias',
  '/pesv/operacion-indicadores',
  '/pesv/politica',
  '/pesv/comite',
  '/pesv/plan',
  '/pesv/diagnostico',
  '/pesv/diagnostico/demo-1',
  '/pesv/diagnostico/demo-1/auditoria',
  '/pesv/tablero',
  '/pesv/reportar',
  '/pesv/auditorias',
  '/pesv/comunicaciones',
  '/pesv/contratistas',
  '/privacy/log-pii',
  '/pesv/jornadas',
  '/pesv/mi-jornada',
  '/pesv/rutas',
  '/pesv/pernocta',
  '/pesv/raci',
  '/pesv/normativa',
  '/pesv/retencion',
  '/rndc',
  '/rndc/maestros',
  '/rndc/remesas',
  '/rndc/remesas/nueva',
  '/rndc/remesas/demo-1',
  '/rndc/manifiestos',
  '/rndc/manifiestos/nuevo',
  '/rndc/manifiestos/demo-1',
  '/rndc/admin/credenciales',
  '/admin/rendimiento',
  '/admin/tramites-metricas',
];
const VARIANTES: Array<[number, 'claro' | 'oscuro']> = [
  [360, 'claro'], [390, 'claro'], [768, 'claro'], [1024, 'claro'], [1280, 'claro'], [1440, 'claro'], [390, 'oscuro'], [1280, 'oscuro'],
];
const TABLA: Array<[RegExp, D.ManejadorDemo]> = [
  ...TABLA_EXTRA,
  [/\/api\/flito\/logistica\/mi-ruta$/, () => ({ body: D.MI_RUTA_DEMO })],
  [/\/api\/flito\/logistica\/buscar$/, () => ({ body: D.LOGISTICA_TRAMITES_DEMO })],
  [/\/api\/flito\/logistica\/actas\/[^/]+\/mensajeros$/, () => ({ body: D.LOGISTICA_MENSAJEROS_DEMO })],
  [/\/api\/flito\/logistica\/facetas$/, () => ({ body: D.LOGISTICA_FACETAS_DEMO })],
  [/\/api\/flito\/logistica\/actas$/, () => ({ body: D.LOGISTICA_ACTAS_DEMO })],
  [/\/api\/flito\/logistica\/tramites\/tram-log-demo-2\/viajes$/, () => ({ body: D.LOGISTICA_VIAJES_DEMO })],
  [/\/api\/flito\/logistica\/tram-log-demo-2$/, () => ({ body: D.LOGISTICA_DETALLE_DEMO })],
  [/\/api\/privacy\/pii-access-log\/stats$/, () => ({ body: D.LOG_PII_STATS_DEMO })],
  [/\/api\/privacy\/preview$/, () => ({ body: D.PRIVACY_PREVIEW_DEMO })],
  [/\/api\/drive\/procesar-cuentas$/, () => ({ body: D.DRIVE_PROCESO_DEMO })],
  [/\/api\/users\/resumen$/, () => ({ body: D.USUARIOS_RESUMEN_DEMO })],
  [/\/api\/users\/auditoria\/titulares$/, () => ({ body: D.USUARIOS_TITULARES_DEMO })],
  [/\/api\/users\/auditoria$/, () => ({ body: D.USUARIOS_HISTORIAL_DEMO })],
  [/\/api\/users$/, () => ({ body: D.USUARIOS_DEMO })],
  [/\/api\/flito\/parametrizacion\/companias$/, () => ({ body: D.COMPANIAS_DEMO })],
  [/\/api\/siigo\/credenciales\/probar-conexion$/, () => ({ body: D.SIIGO_PRUEBA_DEMO })],
  [/\/api\/siigo\/credenciales$/, () => ({ body: D.SIIGO_CREDENCIALES_DEMO })],
  [/\/api\/siigo\/mapeo-conceptos$/, () => ({ body: D.SIIGO_MAPEO_DEMO })],
  [/\/api\/siigo\/compuerta$/, () => ({ body: D.SIIGO_COMPUERTA_DEMO })],
  [/\/api\/siigo\/productos$/, () => ({ body: D.SIIGO_PRODUCTOS_DEMO })],
  [/\/api\/siigo\/clientes\/validacion$/, () => ({ body: D.SIIGO_VALIDACION_DEMO })],
  [/\/api\/siigo\/terceros\/resumen$/, () => ({ body: D.SIIGO_TERCEROS_DEMO.resumen })],
  [/\/api\/siigo\/clientes-ciudades\/estado$/, () => ({ body: D.SIIGO_TERCEROS_DEMO.ciudadesEstado })],
  [/\/api\/siigo\/bandeja\/buscar$/, () => ({ body: D.SIIGO_BANDEJA_DEMO })],
  [/\/api\/siigo\/bandeja\/resumen$/, () => ({ body: D.SIIGO_RESUMEN_DEMO })],
  [/\/api\/siigo\/freno$/, () => ({ body: D.SIIGO_FRENO_DEMO })],
  [/\/api\/siigo\/linea-tiempo\/[^/]+$/, () => ({ body: D.SIIGO_LINEA_TIEMPO_DEMO })],
  [/\/api\/flito\/comprobantes$/, () => ({ body: D.COMPROBANTES_DEMO })],
  [/\/api\/flito\/comprobantes\/comp-demo-1$/, () => ({ body: D.COMPROBANTE_DETALLE_DEMO })],
  [/\/api\/clients$/, () => ({ body: D.CLIENTES_DEMO })],
  [/\/api\/flito\/conciliacion\/boletas$/, () => ({ body: D.CONCILIACION_BOLETAS_DEMO })],
  [/\/api\/flito\/bolsas\/consolidado$/, () => ({ body: D.BOLSAS_DEMO.consolidado })],
  [/\/api\/flito\/bolsas\/alertas$/, () => ({ body: D.BOLSAS_DEMO.alertas })],
  [/\/api\/flito\/bolsas\/901\/extracto$/, () => ({ body: D.BOLSAS_DEMO.extracto })],
  [/\/api\/flito\/bolsas\/901\/movimientos$/, () => ({ body: D.BOLSAS_DEMO.movimientos })],
  [/\/api\/flito\/bolsas-documentos\/companias\/901$/, () => ({ body: D.EXPEDIENTE_BOLSA_DEMO })],
  [/\/api\/flito\/bolsas-documentos\/estado-lote$/, () => ({ body: D.ESTADO_LOTE_BOLSAS_DEMO })],
  [/\/api\/flito\/parametrizacion\/tarifas$/, () => ({ body: D.TARIFAS_DEMO.abiertas })],
  [/\/api\/flito\/parametrizacion\/tarifas\/companias\/901$/, () => ({ body: D.TARIFAS_DEMO.vista901 })],
  [/\/api\/flito\/parametrizacion\/tarifas\/companias\/901\/historial$/, () => ({ body: D.TARIFAS_DEMO.historial })],
  [/\/api\/finanzas\/reporte-costos$/, () => ({ body: D.REPORTE_COSTOS_DEMO })],
  [/\/api\/finanzas\/reporte-costos\/facturacion-electronica$/, () => ({ body: D.REPORTE_FACTURACION_DEMO })],
  [/\/api\/finanzas\/reporte-costos\/facetas$/, () => ({ body: D.REPORTE_FACETAS_DEMO })],
  [/\/api\/finanzas\/reporte-costos\/consolidado$/, () => ({ body: D.REPORTE_CONSOLIDADO_DEMO })],
  [/\/api\/finanzas\/gastos-diarios$/, () => ({ body: D.GASTOS_DIARIOS_DEMO })],
  [/\/api\/flito\/tablero$/, () => ({ body: D.TABLERO_DEMO })],
  [/\/api\/soat\/stats$/, () => ({ body: D.PANEL_SOAT_STATS_DEMO })],
  [/\/api\/fleet\/documents\/expiring$/, () => ({ body: D.PANEL_VENCIMIENTOS_DEMO })],
  [/\/api\/rndc\/manifiestos$/, () => ({ body: D.PANEL_RNDC_DEMO })],
  [/\/api\/transito\/organismos-config\/[^/]+\/checklist\/[^/]+$/, () => ({ body: D.ORGANISMO_PLANTILLA_DEMO })],
  [/\/api\/transito\/organismos-config$/, () => ({ body: D.ORGANISMOS_CONFIG_DEMO })],
  [/\/api\/flito\/parametrizacion\/organismos\/[^/]+\/vigencias$/, () => ({ body: D.ORGANISMO_VIGENCIAS_DEMO })],
  [/\/api\/flito\/parametrizacion\/organismos$/, () => ({ body: D.ORGANISMOS_MODALIDAD_DEMO })],
  [/\/api\/flito\/bitacora$/, () => ({ body: D.BITACORA_DEMO })],
  [/\/api\/flito\/revisiones\/campos\/soat$/, () => ({ body: D.REVISION_CAMPOS_SOAT })],
  [/\/api\/flito\/soat$/, () => ({ body: D.REVISION_CANDIDATOS_SOAT })],
  [/\/api\/siigo\/clientes\/validacion\/detalle$/, () => ({ body: D.SIIGO_VALIDACION_DETALLE_DEMO })],
  [/\/api\/flito\/comparendos\/registros(\/buscar)?$/, () => ({ body: D.COMPARENDOS_REGISTROS_DEMO })],
  [/\/api\/flito\/comparendos\/registros\/cmp-demo-1$/, () => ({ body: D.COMPARENDO_DETALLE_DEMO })],
  [/\/api\/flito\/comparendos\/nits$/, () => ({ body: D.COMPARENDOS_NITS_DEMO })],
  [/\/api\/flito\/comparendos\/municipios$/, () => ({ body: D.COMPARENDOS_MUNICIPIOS_DEMO })],
  [/\/api\/flito\/comparendos\/causales$/, () => ({ body: D.COMPARENDOS_CAUSALES_DEMO })],
  [/\/api\/flito\/comparendos\/config\/token-simit$/, () => ({ body: D.COMPARENDOS_TOKEN_DEMO })],
  [/\/api\/flito\/comparendos\/sync\/runs$/, () => ({ body: D.COMPARENDOS_RUNS_DEMO })],
  [/\/api\/flito\/tramites$/, () => ({ body: D.TRAMITES_DEMO })],
  [/\/api\/flito\/tramites\/facetas$/, () => ({ body: D.TRAMITES_FACETAS_DEMO })],
  [/\/api\/flito\/sync\/interruptores$/, () => ({ body: D.SYNC_DEMO.interruptores })],
  [/\/api\/flito\/sync\/estado$/, () => ({ body: D.SYNC_DEMO.estado1 })],
  [/\/api\/flito\/sync\/flit2\/estado$/, () => ({ body: D.SYNC_DEMO.estado2 })],
  [/\/api\/flito\/sync\/flit1\/estado-lectura$/, () => ({ body: D.SYNC_DEMO.lectura1 })],
  [/\/api\/flito\/soat\/facetas$/, () => ({ body: D.SOAT_FACETAS_DEMO })],
  [/\/api\/flito\/soat\/soat-demo-2\/documentos-adicionales$/, () => ({ body: D.SOAT_DOCUMENTOS_ADICIONALES_DEMO })],
  [/\/api\/flito\/soat\/cliente\/companias$/, () => ({ body: D.SOAT_COMPANIAS_CANAL_DEMO })],
  [/\/api\/flito\/impuestos\/facetas$/, () => ({ body: D.IMPUESTOS_FACETAS_DEMO })],
  [/\/api\/flito\/impuestos\/imp-demo-2$/, () => ({ body: D.IMPUESTO_DETALLE_DEMO })],
  [/\/api\/flito\/derechos$/, () => ({ body: D.DERECHOS_DEMO })],
  [/\/api\/flito\/derechos\/facetas$/, () => ({ body: D.DERECHOS_FACETAS_DEMO })],
  [/\/api\/flito\/derechos\/cargar$/, () => ({ body: D.DERECHOS_RESULTADO_DEMO })],
  [/\/api\/flito\/derechos\/drive\/archivos$/, () => ({ body: D.DERECHOS_DRIVE_DEMO })],
  [/\/api\/flito\/derechos\/drive\/registro$/, () => ({ body: D.DERECHOS_DRIVE_REGISTRO_DEMO })],
];

const slug = (r: string) => (r === '/' ? 'inicio' : r.slice(1).replace(/\//g, '_'));

test.describe.configure({ mode: 'serial' });
test.skip(!process.env.BARRIDO_OUT, 'Barrido responsive temporal: solo con BARRIDO_OUT');
// BARRIDO_RUTAS="/fleet /pesv" recorre solo esas rutas (lista separada por espacios).
const RUTAS_A_RECORRER = process.env.BARRIDO_RUTAS ? process.env.BARRIDO_RUTAS.split(/\s+/).filter(Boolean) : RUTAS;
for (const ruta of RUTAS_A_RECORRER) {
  test(`barrido ${ruta}`, async ({ browser }) => {
    test.setTimeout(180_000);
    mkdirSync(OUT, { recursive: true });
    const resultados: unknown[] = [];
    for (const [ancho, tema] of VARIANTES) {
      const ctx = await browser.newContext({ viewport: { width: ancho, height: 900 }, serviceWorkers: 'block' });
      const page = await ctx.newPage();
      const errores: string[] = [];
      page.on('pageerror', (e) => errores.push(e.message.slice(0, 160)));
      await page.addInitScript((t) => { localStorage.setItem('flit-tema', t); localStorage.setItem('aura-theme', t); }, tema === 'oscuro' ? 'dark' : 'light');
      await D.interceptarApiDemo(page, TABLA);
      if (!PUBLICAS.has(ruta)) await loginAs(page, ADMIN_USER);
      try {
        await page.goto(ruta, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
        await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 4_000 }).catch(() => {});
        await page.waitForTimeout(300);
      } catch (e) { errores.push(`goto: ${(e as Error).message.slice(0, 120)}`); }
      const m = await page.evaluate((umbral) => {
        const vw = document.documentElement.clientWidth;
        const desborde = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - vw;
        const enScroll = (el: Element) => {
          if (el.closest('details:not([open]) > :not(summary)')) return true;
          for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            const ox = getComputedStyle(p).overflowX;
            if ((ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') && p.scrollWidth > p.clientWidth + 1) return true;
          }
          return false;
        };
        const desc = (el: Element) => {
          const t = (el.getAttribute('aria-label') || (el as HTMLElement).innerText || el.getAttribute('placeholder') || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40);
          return `${el.tagName.toLowerCase()}«${t}»`;
        };
        const ctrl = [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab]')]
          .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; });
        const fuera = ctrl.filter((el) => { const r = el.getBoundingClientRect(); return (r.right > vw + 1 || r.left < -1) && !enScroll(el); }).map(desc);
        const recortados = ctrl.filter((el) => { const h = el as HTMLElement; return h.scrollWidth > h.clientWidth + 2 && getComputedStyle(h).overflowX === 'hidden' && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT'; }).map(desc);
        const anchos = [...document.querySelectorAll('body *')].filter((el) => { const r = el.getBoundingClientRect(); return r.right > vw + 1 && r.width > 0 && getComputedStyle(el).visibility !== 'hidden' && !enScroll(el); })
          .slice(0, 400).filter((el) => !el.parentElement || el.parentElement.getBoundingClientRect().right <= vw + 1).slice(0, 6)
          .map((el) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className || '').split(' ').slice(0, 3).join('.')} (${Math.round(el.getBoundingClientRect().right)}px)`);
        const pequenos = umbral ? ctrl.filter((el) => { const r = el.getBoundingClientRect(); return (r.height < 44 || r.width < 44) && !enScroll(el); }).length : null;
        const culpables = desborde > 0 ? [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > vw + 0.5 && ![...el.children].some((c) => c.getBoundingClientRect().right > vw + 0.5)).slice(0, 3).map((el) => {
          const cad: string[] = []; for (let p: Element | null = el; p && cad.length < 7; p = p.parentElement) cad.push(`${p.tagName.toLowerCase()}.${String((p as HTMLElement).className).slice(0, 70)}[${Math.round(p.getBoundingClientRect().right)}]`);
          return `${el.outerHTML.slice(0, 140)} ← ${cad.join(' ← ')}`; }) : [];
        return { culpables, desborde, fuera: [...new Set(fuera)].slice(0, 8), recortados: [...new Set(recortados)].slice(0, 8), anchos, controles: ctrl.length, pequenos, url: location.pathname };
      }, ancho < 1024);
      await page.screenshot({ path: `${OUT}/${slug(ruta)}-${ancho}-${tema}.png`, animations: 'disabled', caret: 'hide' }).catch(() => {});
      resultados.push({ ruta, ancho, tema, ...m, errores });
      await ctx.close();
    }
    writeFileSync(`${OUT}/${slug(ruta)}.json`, JSON.stringify(resultados, null, 1));
  });
}
