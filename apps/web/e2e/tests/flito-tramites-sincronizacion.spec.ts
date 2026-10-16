import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, FUNCIONES_POR_ROL } from '../helpers/auth';
import { cabeceraSincronizacion, expandirSincronizacion } from '../helpers/sincronizacion';

// FLITO — Gestión Trámites · sección «Sincronización» con interruptor por fuente (HU #13238, Feature
// #13236). Backend mockeado: se verifica el cableado de la UI contra el contrato de la HU #13237
// (`GET/PUT /api/flito/sync/interruptores`, `GET /api/flito/sync/estado`, `GET …/flit2/estado`).
// HU #13630: FLIT 1 se lee sola. Sin «Sincronizar FLIT»; el grupo FLIT 1 muestra la última y la próxima lectura,
// el último fallo (aviso de página) y, con `configurar`, los parámetros de lectura (`GET/PUT
// …/flit1/parametros-lectura`, `GET …/flit1/estado-lectura`, contrato de la HU #13628).

const RUTA_INTER = /\/api\/flito\/sync\/interruptores$/;
const RUTA_PUT = /\/api\/flito\/sync\/interruptores\/(flit1|flit2)$/;
const RUTA_ESTADO1 = /\/api\/flito\/sync\/estado$/;
const RUTA_ESTADO2 = /\/api\/flito\/sync\/flit2\/estado$/;
/** Ruta retirada de la web (HU #13630): se mockea solo para contar que nadie la llama. */
const RUTA_SYNC = /\/api\/flito\/sync\/sincronizar$/;
const RUTA_PARAMS = /\/api\/flito\/sync\/flit1\/parametros-lectura$/;
const RUTA_LECTURA = /\/api\/flito\/sync\/flit1\/estado-lectura$/;
/** Texto crudo del API: nunca debe llegar a la pantalla. */
const CRUDO = 'ERROR-CRUDO-e2e-13238';

const hace = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const dentro = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

type Fuente = 'flit1' | 'flit2';
interface Inter { fuente: Fuente; encendido: boolean; actualizadoEn: string | null; actualizadoPor: { id: number; nombre: string } | null }

const inter = (fuente: Fuente, encendido: boolean, conQuien = true): Inter => ({
  fuente, encendido,
  actualizadoEn: conQuien ? hace(5) : null,
  actualizadoPor: conQuien ? { id: 1, nombre: 'Ana Pérez' } : null,
});

const estado1 = (habilitada = true, ultima: string | null = hace(10)) => ({
  habilitada, motivoDeshabilitada: habilitada ? null : 'interruptor', ultimaSincronizacion: ultima, hayTramites: true,
});

const estado2 = (extra: Record<string, unknown> = {}) => ({
  habilitada: true, motivoDeshabilitada: null,
  configurado: true, motivoSinConfigurar: null,
  ultimaExitosaEn: hace(3), ultimoIntentoEn: hace(3),
  atrasada: false, alerta: false, problema: null,
  piiEnmascarada: { tramites: 0, desde: null },
  automatica: { activa: true, intervaloMs: 300_000, proximaEn: dentro(4), enCurso: false, generadoEn: new Date().toISOString() },
  ...extra,
});

const diaAtras = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);

const parametros = (extra: Record<string, unknown> = {}) => ({
  frecuenciaMinutos: 2, ventanaDias: 7, ventanaNocturnaDias: 60, arranque: diaAtras(30), arranquePorDefecto: false,
  actualizadoEn: hace(60) as string | null, actualizadoPor: { id: 1, nombre: 'Ana Pérez' } as { id: number; nombre: string } | null,
  ...extra,
});

const lectura = (extra: Record<string, unknown> = {}) => ({
  ultimaLecturaBuenaEn: hace(1) as string | null, proximaLecturaPrevistaEn: dentro(1) as string | null,
  ultimoFallo: null as { en: string; codigo: string } | null, ...extra,
});

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

interface Escenario {
  f1?: boolean; f2?: boolean; maestro?: boolean;
  e1?: ReturnType<typeof estado1>; e2?: ReturnType<typeof estado2>;
  getStatus?: number;
  params?: ReturnType<typeof parametros>; lectura?: ReturnType<typeof lectura>;
}

/** Monta todos los mocks y devuelve un control con contadores y respuestas cambiables. */
async function mockear(page: Page, esc: Escenario = {}) {
  const ctl = {
    inter: { fuentes: [inter('flit1', esc.f1 ?? true), inter('flit2', esc.f2 ?? true)], maestroFlit2: esc.maestro ?? true },
    getStatus: esc.getStatus ?? 200,
    e1: esc.e1 ?? estado1(),
    e2: esc.e2 ?? estado2(),
    gets: 0, gets1: 0, puts: [] as { fuente: string; encendido: boolean }[], posts: 0,
    putStatus: 200,
    /** Si está, el PUT espera a que se resuelva. */
    retenerPut: null as Promise<void> | null,
    params: esc.params ?? parametros(),
    paramsGetStatus: 200, getsParams: 0,
    paramsPuts: [] as Record<string, unknown>[],
    paramsPutStatus: 200, paramsPutBody: null as unknown,
    lectura: esc.lectura ?? lectura(),
    lecturaStatus: 200, getsLectura: 0,
  };
  await page.route(/\/api\/flito\/tramites\/facetas/, (r) => json(r, 200, { estados: [], tramites: [], ciudades: [], transitos: [] }));
  await page.route(/\/api\/flito\/tramites\?/, (r) => json(r, 200, { items: [], total: 0, page: 1, pageSize: 50 }));
  await page.route(RUTA_INTER, (r) => { ctl.gets += 1; return json(r, ctl.getStatus, ctl.getStatus === 200 ? ctl.inter : { error: CRUDO }); });
  await page.route(RUTA_PUT, async (r) => {
    const fuente = RUTA_PUT.exec(r.request().url())![1] as Fuente;
    const { encendido } = r.request().postDataJSON() as { encendido: boolean };
    ctl.puts.push({ fuente, encendido });
    if (ctl.retenerPut) await ctl.retenerPut;
    if (ctl.putStatus !== 200) return json(r, ctl.putStatus, { error: CRUDO, codigo: 'X' });
    const nuevo: Inter = { fuente, encendido, actualizadoEn: new Date().toISOString(), actualizadoPor: { id: 7, nombre: 'Operaciones E2E' } };
    ctl.inter = { ...ctl.inter, fuentes: ctl.inter.fuentes.map((f) => (f.fuente === fuente ? nuevo : f)) };
    if (fuente === 'flit1') ctl.e1 = estado1(encendido, ctl.e1.ultimaSincronizacion);
    else ctl.e2 = { ...ctl.e2, habilitada: encendido && ctl.inter.maestroFlit2, motivoDeshabilitada: !ctl.inter.maestroFlit2 ? 'maestro' : encendido ? null : 'interruptor' };
    return json(r, 200, nuevo);
  });
  await page.route(RUTA_ESTADO1, (r) => { ctl.gets1 += 1; return json(r, 200, ctl.e1); });
  await page.route(RUTA_ESTADO2, (r) => json(r, 200, ctl.e2));
  await page.route(RUTA_SYNC, (r) => { ctl.posts += 1; return json(r, 500, { error: CRUDO }); });
  await page.route(RUTA_PARAMS, (r) => {
    if (r.request().method() === 'PUT') {
      const cuerpo = r.request().postDataJSON() as Record<string, unknown>;
      ctl.paramsPuts.push(cuerpo);
      if (ctl.paramsPutStatus !== 200) return json(r, ctl.paramsPutStatus, ctl.paramsPutBody ?? { error: CRUDO });
      ctl.params = { ...ctl.params, ...cuerpo, arranquePorDefecto: false, actualizadoEn: new Date().toISOString(), actualizadoPor: { id: 7, nombre: 'Operaciones E2E' } };
      return json(r, 200, ctl.params);
    }
    ctl.getsParams += 1;
    return json(r, ctl.paramsGetStatus, ctl.paramsGetStatus === 200 ? ctl.params : { error: CRUDO });
  });
  await page.route(RUTA_LECTURA, (r) => { ctl.getsLectura += 1; return json(r, ctl.lecturaStatus, ctl.lecturaStatus === 200 ? ctl.lectura : { error: CRUDO }); });
  return ctl;
}

const seccion = (page: Page) => page.getByTestId('seccion-sincronizacion');
const grupo = (page: Page, f: Fuente) => page.getByTestId(`grupo-${f}`);
const sw = (page: Page, f: Fuente) => page.getByRole('switch', { name: `Recibir trámites de ${f === 'flit1' ? 'FLIT 1' : 'FLIT 2'}` });
const botonSync = (page: Page) => page.getByRole('button', { name: 'Sincronizar FLIT', exact: true });
const botonGuardar = (page: Page) => page.getByRole('button', { name: 'Guardar parámetros', exact: true });
const botonAcceso = (page: Page) => page.getByRole('button', { name: 'Acceso a FLIT 2', exact: true });

/** Abre la página y, salvo `expandir: false`, despliega el acordeón (contraído en cada visita). */
async function abrir(page: Page, { expandir = true } = {}) {
  await page.goto('/flito/tramites');
  await expect(page.getByRole('heading', { name: 'Gestión Trámites', exact: true })).toBeVisible();
  await expect(seccion(page)).not.toHaveAttribute('aria-busy', 'true');
  if (expandir) await expandirSincronizacion(page);
}

test.describe('FLITO — Gestión Trámites · sección Sincronización (HU #13238)', () => {
  test('AC1 + AC6: dos grupos rotulados con su interruptor, estado y quién/cuándo; una sola primaria; h-10 y barras alineadas a 1366', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 900 });
    await loginAs(page, OPERACIONES_USER);
    await mockear(page);
    await abrir(page);

    await expect(seccion(page).getByRole('heading', { level: 2, name: 'Sincronización' })).toBeVisible();
    await expect(grupo(page, 'flit1').getByRole('heading', { level: 3, name: 'FLIT 1' })).toBeVisible();
    await expect(grupo(page, 'flit2').getByRole('heading', { level: 3, name: 'FLIT 2' })).toBeVisible();
    for (const f of ['flit1', 'flit2'] as const) {
      await expect(sw(page, f)).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByTestId(`estado-fuente-${f}`)).toHaveText('Encendida');
      await expect(page.getByTestId(`quien-cuando-${f}`)).toHaveText(/^Encendida por Ana Pérez hoy a las /);
    }
    // HU #13630: sin «Sincronizar FLIT»; la única acción de FLIT 1 es guardar los parámetros.
    await expect(botonSync(page)).toHaveCount(0);
    await expect(grupo(page, 'flit1').getByRole('button', { name: 'Guardar parámetros', exact: true })).toBeVisible();
    await expect(grupo(page, 'flit2').getByRole('button', { name: 'Acceso a FLIT 2', exact: true })).toBeVisible();
    await expect(grupo(page, 'flit2').getByTestId('linea-estado-flit2')).toBeVisible();
    await expect(grupo(page, 'flit2').getByTestId('indicador-flit2')).toBeVisible();
    // Una sola primaria (gradiente) en toda la zona.
    const primarias = await seccion(page).locator('button').evaluateAll(
      (bs) => bs.filter((b) => (b as HTMLElement).style.background.includes('gradient')).length,
    );
    expect(primarias).toBe(1);
    // Lado a lado y con las barras alineadas (mismo borde inferior), una sola altura de control.
    const b1 = (await botonGuardar(page).boundingBox())!;
    const b2 = (await botonAcceso(page).boundingBox())!;
    expect(b1.height).toBe(40);
    expect(b2.height).toBe(40);
    expect(Math.abs((b1.y + b1.height) - (b2.y + b2.height))).toBeLessThanOrEqual(1);
    const g1 = (await grupo(page, 'flit1').boundingBox())!;
    const g2 = (await grupo(page, 'flit2').boundingBox())!;
    expect(g2.x).toBeGreaterThan(g1.x + g1.width - 1);
    expect((await sw(page, 'flit1').boundingBox())!.height).toBe(40);
    await expect(grupo(page, 'flit1').getByText('Elegir fecha')).toHaveCount(0);
    await expect(grupo(page, 'flit1').getByText('Desde', { exact: true })).toHaveCount(0);
    for (const c of ['Frecuencia (minutos)', 'Ventana (días)', 'Ventana nocturna (días)', 'Fecha de arranque']) {
      expect((await grupo(page, 'flit1').getByLabel(c, { exact: true }).boundingBox())!.height).toBe(40);
    }
  });

  test('AC1: apagar FLIT 1 pide confirmación con el foco en Cancelar; confirma tras la respuesta con «Guardando…» y un toast cerrable', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const ctl = await mockear(page);
    await abrir(page);

    await sw(page, 'flit1').click();
    const dialogo = page.getByRole('dialog', { name: '¿Apagar FLIT 1?' });
    await expect(dialogo).toBeVisible();
    await expect(dialogo).toContainText('FLITO no lee trámites de FLIT 1 en este ambiente');
    await expect(dialogo).not.toContainText('Sincronizar FLIT');
    await expect(dialogo.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await dialogo.getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialogo).toHaveCount(0);
    await expect(sw(page, 'flit1')).toBeFocused();
    expect(ctl.puts).toHaveLength(0);

    let soltar: () => void = () => {};
    ctl.retenerPut = new Promise<void>((res) => { soltar = res; });
    await sw(page, 'flit1').click();
    await page.getByRole('button', { name: 'Apagar FLIT 1' }).click();
    // No optimista: ocupado, «Guardando…», conserva el valor y no pierde el foco.
    await expect(sw(page, 'flit1')).toHaveAttribute('aria-busy', 'true');
    await expect(sw(page, 'flit1')).toHaveAttribute('aria-disabled', 'true');
    await expect(sw(page, 'flit1')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('estado-fuente-flit1')).toHaveText('Guardando…');
    await sw(page, 'flit1').click({ force: true }); // ocupado: no hace nada
    expect(ctl.puts).toEqual([{ fuente: 'flit1', encendido: false }]);
    soltar();
    await expect(sw(page, 'flit1')).toHaveAttribute('aria-checked', 'false');
    await expect(sw(page, 'flit1')).not.toHaveAttribute('aria-busy', 'true');
    await expect(sw(page, 'flit1')).toBeFocused();
    await expect(page.getByTestId('estado-fuente-flit1')).toHaveText('Apagada');
    await expect(page.getByTestId('quien-cuando-flit1')).toHaveText(/^Apagada por Operaciones E2E hoy a las /);
    const toast = page.getByRole('status').filter({ hasText: 'FLIT 1 quedó apagada' });
    await expect(toast).toBeVisible();
    await toast.getByRole('button', { name: 'Cerrar aviso' }).click();
    await expect(toast).toHaveCount(0);
    // El motivo y la próxima lectura quedan al día; los parámetros siguen editables.
    await expect(page.getByTestId('motivo-flit1')).toContainText('FLIT 1 está apagada: FLITO no lee trámites de FLIT 1.');
    await expect(page.getByTestId('linea-lectura-flit1')).toContainText('Lectura detenida');
    await expect(page.getByLabel('Frecuencia (minutos)')).not.toHaveAttribute('readonly', /.*/);
  });

  test('AC1 + AC7: encender con teclado (Espacio) no pide confirmación', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const ctl = await mockear(page, { f2: false, e2: estado2({ habilitada: false, motivoDeshabilitada: 'interruptor' }) });
    await abrir(page);
    await expect(sw(page, 'flit2')).toHaveAttribute('aria-checked', 'false');
    await sw(page, 'flit2').focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(sw(page, 'flit2')).toHaveAttribute('aria-checked', 'true');
    expect(ctl.puts).toEqual([{ fuente: 'flit2', encendido: true }]);
    await expect(page.getByText('FLIT 2 quedó encendida: la lectura sigue donde quedó en la próxima vuelta automática.')).toBeVisible();
    await expect(page.getByTestId('motivo-flit2')).toHaveCount(0);
  });

  test('AC2: esqueleto mientras carga; error del GET con Reintentar y copy propio; recupera', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const ctl = await mockear(page, { getStatus: 500 });
    let soltar: () => void = () => {};
    const pendiente = new Promise<void>((res) => { soltar = res; });
    await page.route(RUTA_INTER, async (r) => { ctl.gets += 1; await pendiente; return json(r, ctl.getStatus, ctl.getStatus === 200 ? ctl.inter : { error: CRUDO }); });
    await page.goto('/flito/tramites');
    await expect(seccion(page)).toHaveAttribute('aria-busy', 'true');
    // Mientras carga, el resumen no inventa valores.
    await expect(page.getByTestId('resumen-flit1')).toHaveText('FLIT 1: Cargando…');
    await expandirSincronizacion(page);
    await expect(page.getByTestId('esqueleto-switch-flit1')).toBeVisible();
    await expect(page.getByTestId('esqueleto-switch-flit2')).toBeVisible();
    soltar();
    const error = page.getByTestId('error-interruptores');
    await expect(error).toContainText('No se pudo consultar los interruptores de sincronización.');
    await expect(error).toHaveAttribute('role', 'alert');
    expect(await error.getAttribute('style')).toContain('--flit-danger-text');
    await expect(page.getByRole('switch')).toHaveCount(0);
    await expect(page.getByText(CRUDO)).toHaveCount(0);
    // Resumen neutro: no adivina el valor; el error con reintento vive dentro.
    await expect(page.getByTestId('resumen-flit1')).toHaveText('FLIT 1: estado no disponible');
    await expect(page.getByTestId('resumen-flit2')).toHaveText('FLIT 2: estado no disponible');
    // El resto de la zona sigue funcionando.
    await expect(botonGuardar(page)).toBeVisible();
    ctl.getStatus = 200;
    await error.getByRole('button', { name: /Reintentar/ }).click();
    await expect(sw(page, 'flit1')).toHaveAttribute('aria-checked', 'true');
    await expect(error).toHaveCount(0);
  });

  test('AC2: si falla al guardar, el interruptor conserva el valor y sale un toast con copy propio y Reintentar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const ctl = await mockear(page, { f2: false, e2: estado2({ habilitada: false, motivoDeshabilitada: 'interruptor' }) });
    ctl.putStatus = 500;
    await abrir(page);
    await sw(page, 'flit2').click();
    const toast = page.getByRole('alert').filter({ hasText: 'No se pudo guardar el cambio de FLIT 2. Inténtalo de nuevo.' });
    await expect(toast).toBeVisible();
    await expect(sw(page, 'flit2')).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('estado-fuente-flit2')).toHaveText('Apagada');
    await expect(sw(page, 'flit2')).toBeFocused();
    await expect(page.getByText(CRUDO)).toHaveCount(0);
    ctl.putStatus = 200;
    await toast.getByRole('button', { name: 'Reintentar' }).click();
    await expect(sw(page, 'flit2')).toHaveAttribute('aria-checked', 'true');
    expect(ctl.puts).toHaveLength(2);
  });

  test('AC2: un 403 al guardar deja la sección en solo lectura', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const ctl = await mockear(page, { f2: false, e2: estado2({ habilitada: false, motivoDeshabilitada: 'interruptor' }) });
    ctl.putStatus = 403;
    await abrir(page);
    await sw(page, 'flit2').click();
    await expect(page.getByText('No tienes permiso para cambiar la sincronización. Pídeselo a un administrador.')).toBeVisible();
    await expect(page.getByRole('switch')).toHaveCount(0);
    await expect(page.getByTestId('estado-fuente-flit2')).toContainText('Apagada');
  });

  test('AC3: sin la función no hay interruptores ni GET, pero cada grupo dice en texto si está encendida o apagada', async ({ page }) => {
    const sinConfigurar = FUNCIONES_POR_ROL.admin.filter((f) => f !== 'tramites.sincronizacion.configurar');
    await loginAs(page, { ...OPERACIONES_USER, funciones: sinConfigurar });
    const ctl = await mockear(page, { e1: estado1(false) });
    await abrir(page);
    await expect(page.getByRole('switch')).toHaveCount(0);
    expect(ctl.gets).toBe(0);
    await expect(page.getByTestId('estado-fuente-flit1')).toHaveText('FLIT 1: Apagada');
    await expect(page.getByTestId('estado-fuente-flit2')).toHaveText('FLIT 2: Encendida');
    await expect(page.getByTestId('quien-cuando-flit1')).toHaveCount(0);
    await expect(page.getByTestId('motivo-flit1')).toContainText('Pídele a un administrador que la encienda.');
    expect(ctl.getsParams).toBe(0);
  });

  test('AC4 (HU #13630): FLIT 1 apagada dice el motivo nuevo, «Lectura detenida» y deja editar los parámetros', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const ctl = await mockear(page, { f1: false, e1: estado1(false), lectura: lectura({ ultimoFallo: { en: hace(0.5), codigo: 'flit1_timeout' } }) });
    await abrir(page);
    const motivo = page.getByTestId('motivo-flit1');
    await expect(motivo).toHaveAttribute('role', 'status');
    await expect(motivo).toHaveText('FLIT 1 está apagada: FLITO no lee trámites de FLIT 1. Enciéndela con el interruptor para que la lectura automática siga.');
    await expect(page.getByTestId('linea-lectura-flit1')).toContainText('Lectura detenida');
    // Con la fuente apagada gana el aviso de apagada; el fallo vigente baja a línea muted.
    await expect(page.getByTestId('aviso-fallo-flit1')).toHaveCount(0);
    await expect(page.getByTestId('fallo-superado-flit1')).toHaveText(/^Último fallo: hoy a las .+\.$/);
    await page.getByLabel('Frecuencia (minutos)').fill('3');
    await botonGuardar(page).click();
    await expect.poll(() => ctl.paramsPuts.length).toBe(1);
    expect(ctl.posts).toBe(0);
  });

  test('AC5: FLIT 2 apagada por interruptor: indicador y panel dicen que está apagada y por qué, sin alerta de atraso', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockear(page, {
      f2: false,
      e2: estado2({ habilitada: false, motivoDeshabilitada: 'interruptor', alerta: true, problema: { tipo: 'lectura', codigo: null, motivo: null, en: hace(2), hasta: null } }),
    });
    await abrir(page);
    await expect(page.getByTestId('texto-indicador-flit2')).toHaveText('Lectura automática apagada desde Sincronización');
    await expect(page.getByTestId('texto-indicador-flit2')).not.toContainText(/\d+:\d{2}/);
    await expect(page.getByTestId('motivo-flit2')).toContainText('FLIT 2 está apagada: FLITO no lee trámites nuevos de FLIT 2.');
    await expect(page.getByTestId('aviso-estado-flit2')).toHaveCount(0);
    await expect(page.getByText('Falló la última lectura de FLIT 2.')).toHaveCount(0);
  });

  test('AC5: con el maestro apagado, aviso persistente del servidor y estado «Encendida · apagada en el servidor»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockear(page, { maestro: false, e2: estado2({ habilitada: false, motivoDeshabilitada: 'maestro', automatica: { activa: false, intervaloMs: null, proximaEn: null, enCurso: false, generadoEn: new Date().toISOString() } }) });
    await abrir(page);
    await expect(page.getByTestId('estado-fuente-flit2')).toHaveText('Encendida · apagada en el servidor');
    await expect(page.getByTestId('motivo-flit2')).toHaveText('La lectura automática de FLIT 2 está apagada en el servidor; este interruptor no tendrá efecto hasta que se encienda allí.');
    await expect(page.getByTestId('motivo-flit2')).toHaveAttribute('role', 'status');
    await expect(page.getByTestId('texto-indicador-flit2')).toHaveText('Lectura automática apagada en el servidor');
  });

  for (const tema of ['claro', 'oscuro'] as const) {
    test(`AC7 + AC9: hover y foco visible en el interruptor y en los botones (${tema})`, async ({ page }) => {
      if (tema === 'oscuro') await page.addInitScript(() => localStorage.setItem('aura-theme', 'dark'));
      await loginAs(page, OPERACIONES_USER);
      await mockear(page);
      await abrir(page);
      const s = sw(page, 'flit1');
      const fondo = () => s.evaluate((e) => getComputedStyle(e).backgroundColor);
      const reposo = await fondo();
      await s.hover();
      await expect.poll(fondo).not.toBe(reposo);
      // Foco por teclado: anillo visible en el interruptor, en «Guardar parámetros» y en un campo.
      await s.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      await expect(s).toBeFocused();
      const anillo = (sel: ReturnType<typeof sw>) => sel.evaluate((e) => {
        const c = getComputedStyle(e);
        return (c.outlineStyle !== 'none' && c.outlineWidth !== '0px') || c.boxShadow !== 'none';
      });
      expect(await anillo(s)).toBe(true);
      await botonGuardar(page).focus();
      expect(await anillo(botonGuardar(page))).toBe(true);
      const campo = page.getByLabel('Ventana (días)');
      const borde = () => campo.evaluate((e) => getComputedStyle(e).borderColor);
      const bordeReposo = await borde();
      await campo.hover();
      await expect.poll(borde).not.toBe(bordeReposo);
      await campo.focus();
      expect(await anillo(campo)).toBe(true);
      // Los colores del carril salen de tokens (con par oscuro), nunca de HEX.
      const carril = await s.locator('span').first().getAttribute('style');
      expect(carril).toContain('var(--flit-blue-text)');
    });
  }

  test('AC8: a 375 px sin scroll horizontal, grupos apilados y botones a ancho completo', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loginAs(page, OPERACIONES_USER);
    await mockear(page, { maestro: false, f1: false, e1: estado1(false), e2: estado2({ habilitada: false, motivoDeshabilitada: 'maestro' }) });
    await abrir(page);
    // La sección no desborda: ningún elemento suyo pasa del borde del viewport. (La barra superior del
    // shell desborda a 375 por su cuenta —preexistente, fuera de esta HU— y por eso no se mide el
    // `scrollWidth` del documento aquí.)
    const desbordan = await seccion(page).evaluate((sec) => [sec, ...sec.querySelectorAll('*')]
      .filter((e) => e.getBoundingClientRect().right > 375.5).length);
    expect(desbordan).toBe(0);
    expect(await seccion(page).evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    const g1 = (await grupo(page, 'flit1').boundingBox())!;
    const g2 = (await grupo(page, 'flit2').boundingBox())!;
    expect(g2.y).toBeGreaterThanOrEqual(g1.y + g1.height);
    const b = (await botonAcceso(page).boundingBox())!;
    expect(b.width).toBeGreaterThan(g2.width - 40);
    // HU #13630: parámetros en una columna y «Guardar parámetros» a ancho completo.
    const f = (await page.getByLabel('Frecuencia (minutos)').boundingBox())!;
    const v = (await page.getByLabel('Ventana (días)').boundingBox())!;
    expect(v.y).toBeGreaterThan(f.y + f.height);
    expect((await botonGuardar(page).boundingBox())!.width).toBeGreaterThan(g1.width - 40);
  });

  test.describe('Acordeón (HU #13238, 2.º PR)', () => {
    const resumen = (page: Page) => page.getByTestId('resumen-sincronizacion');
    const panel = (page: Page) => seccion(page).getByRole('region', { name: 'Sincronización' });

    test('(a) contraída al entrar: aria-expanded=false y sin controles en el DOM; vuelve contraída en la siguiente visita', async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      await mockear(page);
      await abrir(page, { expandir: false });
      const cab = cabeceraSincronizacion(page);
      await expect(cab).toHaveAttribute('aria-expanded', 'false');
      await expect(seccion(page).getByRole('heading', { level: 2, name: /Sincronización/ })).toBeVisible();
      await expect(page.getByRole('switch')).toHaveCount(0);
      await expect(botonGuardar(page)).toHaveCount(0);
      await expect(botonAcceso(page)).toHaveCount(0);
      await expect(page.getByTestId('linea-estado-flit2')).toHaveCount(0);
      // Se despliega y, al volver a entrar, arranca contraída otra vez (no se recuerda).
      await cab.click();
      await expect(cab).toHaveAttribute('aria-expanded', 'true');
      await abrir(page, { expandir: false });
      await expect(cabeceraSincronizacion(page)).toHaveAttribute('aria-expanded', 'false');
    });

    test('(b) la cabecera resume el estado de cada fuente', async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      await mockear(page, { f2: false, e2: estado2({ habilitada: false, motivoDeshabilitada: 'interruptor' }) });
      await abrir(page, { expandir: false });
      await expect(page.getByTestId('resumen-flit1')).toHaveText('FLIT 1: Encendida');
      await expect(page.getByTestId('resumen-flit2')).toHaveText('FLIT 2: Apagada');
      await expect(cabeceraSincronizacion(page)).toContainText(/Sincronización\s*FLIT 1: Encendida\s*FLIT 2: Apagada/);
      await expect(page.getByTestId('alerta-resumen-flit2')).toHaveCount(0);
    });

    test('(c) clic y Enter despliegan: aparecen interruptores y «Guardar parámetros»; contraer los quita', async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      await mockear(page);
      await abrir(page, { expandir: false });
      const cab = cabeceraSincronizacion(page);
      await cab.click();
      await expect(cab).toHaveAttribute('aria-expanded', 'true');
      const id = await cab.getAttribute('aria-controls');
      await expect(panel(page)).toHaveAttribute('id', id!);
      await expect(sw(page, 'flit1')).toBeVisible();
      await expect(sw(page, 'flit2')).toBeVisible();
      await expect(botonGuardar(page)).toBeVisible();
      await cab.click();
      await expect(cab).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByRole('switch')).toHaveCount(0);
      await expect(botonGuardar(page)).toHaveCount(0);
      // Teclado: Enter despliega, Espacio contrae; foco visible en la cabecera.
      await cab.focus();
      await page.keyboard.press('Enter');
      await expect(cab).toHaveAttribute('aria-expanded', 'true');
      await expect(botonGuardar(page)).toBeVisible();
      expect(await cab.evaluate((e) => {
        const c = getComputedStyle(e);
        return (c.outlineStyle !== 'none' && c.outlineWidth !== '0px') || c.boxShadow !== 'none';
      })).toBe(true);
      await page.keyboard.press('Space');
      await expect(cab).toHaveAttribute('aria-expanded', 'false');
    });

    test('(d) FLIT 2 en alerta pone el distintivo en la cabecera; sin alerta o con la fuente apagada, no', async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      const ctl = await mockear(page, { e2: estado2({ alerta: true, problema: { tipo: 'rechazado', codigo: null, motivo: null, en: hace(40), hasta: null } }) });
      await abrir(page, { expandir: false });
      const distintivo = page.getByTestId('alerta-resumen-flit2');
      await expect(distintivo).toHaveText('Requiere atención');
      await expect(distintivo.locator('svg')).toHaveCount(1);
      await expect(resumen(page)).toContainText('FLIT 2: Encendida');
      ctl.e2 = estado2();
      await abrir(page, { expandir: false });
      await expect(page.getByTestId('resumen-flit2')).toHaveText('FLIT 2: Encendida');
      await expect(page.getByTestId('alerta-resumen-flit2')).toHaveCount(0);
      // Interruptor apagado mientras el estado del servidor aún la da por habilitada y en alerta:
      // la cabecera manda por el interruptor y no marca (sin esto, `apagada` no se pone a prueba).
      ctl.inter = { ...ctl.inter, fuentes: [inter('flit1', true), inter('flit2', false)] };
      ctl.e2 = estado2({ alerta: true, problema: { tipo: 'rechazado', codigo: null, motivo: null, en: hace(40), hasta: null } });
      await abrir(page, { expandir: false });
      await expect(page.getByTestId('resumen-flit2')).toHaveText('FLIT 2: Apagada');
      await expect(page.getByTestId('alerta-resumen-flit2')).toHaveCount(0);
      // Apagada por interruptor: aunque llegue alerta, no se marca (misma regla que la tarjeta de aviso).
      ctl.e2 = estado2({ habilitada: false, motivoDeshabilitada: 'interruptor', alerta: true });
      await abrir(page, { expandir: false });
      await expect(page.getByTestId('resumen-flit2')).toHaveText('FLIT 2: Apagada');
      await expect(page.getByTestId('alerta-resumen-flit2')).toHaveCount(0);
    });

    test('(e) a 375 px el resumen envuelve sin desbordar', async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await loginAs(page, OPERACIONES_USER);
      await mockear(page, { maestro: false, e2: estado2({ habilitada: false, motivoDeshabilitada: 'maestro', alerta: true }) });
      await abrir(page, { expandir: false });
      await expect(page.getByTestId('resumen-flit2')).toHaveText('FLIT 2: Apagada en el servidor');
      const desbordan = await seccion(page).evaluate((sec) => [sec, ...sec.querySelectorAll('*')]
        .filter((e) => e.getBoundingClientRect().right > 375.5).length);
      expect(desbordan).toBe(0);
    });
  });

  test.describe('Lectura automática de FLIT 1 (HU #13630)', () => {
    const campo = (page: Page, c: string) => grupo(page, 'flit1').getByLabel(c, { exact: true });

    test('AC1 + AC6: con configurar, los cuatro campos con su valor vigente, su etiqueta y su rango; sin «Sincronizar FLIT»', async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      const ctl = await mockear(page);
      await abrir(page);
      await expect(page.getByTestId('explicacion-flit1')).toHaveText('FLITO lee FLIT 1 automáticamente cada 2 minutos.');
      await expect(campo(page, 'Frecuencia (minutos)')).toHaveValue('2');
      await expect(campo(page, 'Ventana (días)')).toHaveValue('7');
      await expect(campo(page, 'Ventana nocturna (días)')).toHaveValue('60');
      await expect(campo(page, 'Fecha de arranque')).toHaveValue(ctl.params.arranque);
      // El rango visible sale de LIMITES_PARAMETROS_LECTURA_FLIT1 y va enlazado por aria-describedby.
      await expect(campo(page, 'Frecuencia (minutos)')).toHaveAccessibleDescription(/De 2 a 60\./);
      await expect(campo(page, 'Ventana (días)')).toHaveAccessibleDescription(/De 1 a 90\./);
      await expect(campo(page, 'Ventana nocturna (días)')).toHaveAccessibleDescription(
        'Cada noche, a las 02:00, FLITO relee los trámites creados en los últimos 60 días para recoger cambios de trámites más antiguos. De 7 a 90 y no menos que la ventana.');
      await expect(campo(page, 'Frecuencia (minutos)')).toHaveAttribute('min', '2');
      await expect(campo(page, 'Frecuencia (minutos)')).toHaveAttribute('max', '60');
      await expect(page.getByTestId('parametros-flit1-quien')).toHaveText(/^Cambiados por Ana Pérez hoy a las .+\.$/);
      await expect(page.getByTestId('linea-lectura-flit1')).toContainText('Última lectura');
      await expect(page.getByTestId('linea-lectura-flit1')).toContainText(/Próxima lectura\s*hacia las /);
      // Sin cambios, Guardar está inactivo pero enfocable.
      await expect(botonGuardar(page)).toHaveAttribute('aria-disabled', 'true');
      await expect(botonGuardar(page)).toHaveAccessibleDescription('Cambia un valor para guardar.');
      await botonGuardar(page).click({ force: true });
      expect(ctl.paramsPuts).toHaveLength(0);
      await expect(botonSync(page)).toHaveCount(0);
      expect(ctl.posts).toBe(0);
    });

    test('AC4: vacío útil con valores por defecto y sin lecturas', async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      await mockear(page, {
        params: parametros({ arranquePorDefecto: true, actualizadoEn: null, actualizadoPor: null }),
        lectura: lectura({ ultimaLecturaBuenaEn: null, proximaLecturaPrevistaEn: null }),
      });
      await abrir(page);
      await expect(page.getByTestId('parametros-flit1-quien')).toHaveText('Valores por defecto: nadie los ha cambiado en este ambiente.');
      await expect(campo(page, 'Fecha de arranque')).toHaveAccessibleDescription(/Por defecto, un mes antes de hoy\.$/);
      const linea = page.getByTestId('linea-lectura-flit1');
      await expect(linea).toContainText('Aún sin lecturas');
      await expect(linea).toContainText('En unos minutos');
      await expect(linea).toContainText('La primera lectura trae los trámites desde la fecha de arranque.');
    });

    test('AC2: guardar manda el PUT, deja un toast cerrable y el valor se mantiene al recargar', async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      const ctl = await mockear(page);
      await abrir(page);
      const antes = ctl.getsLectura;
      await campo(page, 'Frecuencia (minutos)').fill('5');
      await expect(botonGuardar(page)).not.toHaveAttribute('aria-disabled', 'true');
      await botonGuardar(page).click();
      await expect.poll(() => ctl.paramsPuts.length).toBe(1);
      expect(ctl.paramsPuts[0]).toEqual({ frecuenciaMinutos: 5, ventanaDias: 7, ventanaNocturnaDias: 60, arranque: ctl.params.arranque });
      const toast = page.getByRole('status').filter({ hasText: 'Parámetros de lectura guardados. FLITO los usa desde la próxima lectura.' });
      await expect(toast).toBeVisible();
      await expect(page.getByTestId('explicacion-flit1')).toHaveText('FLITO lee FLIT 1 automáticamente cada 5 minutos.');
      await expect(page.getByTestId('parametros-flit1-quien')).toHaveText(/^Cambiados por Operaciones E2E hoy a las /);
      await expect(botonGuardar(page)).toHaveAttribute('aria-disabled', 'true');
      await expect.poll(() => ctl.getsLectura).toBeGreaterThan(antes);
      await toast.getByRole('button', { name: 'Cerrar aviso' }).click();
      await expect(toast).toHaveCount(0);
      await abrir(page);
      await expect(campo(page, 'Frecuencia (minutos)')).toHaveValue('5');
    });

    test('AC3: fuera de rango marca el campo y no envía; el foco va al primero inválido', async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      const ctl = await mockear(page);
      await abrir(page);
      const frec = campo(page, 'Frecuencia (minutos)');
      await frec.fill('1');
      await frec.blur();
      await expect(frec).toHaveAttribute('aria-invalid', 'true');
      await expect(frec).toHaveAccessibleDescription(/Debe ser un número entero de 2 a 60\.$/);
      const ventana = campo(page, 'Ventana (días)');
      await ventana.fill('91');
      await ventana.blur();
      await expect(ventana).toHaveAccessibleDescription(/Debe ser un número entero de 1 a 90\.$/);
      await ventana.fill('10');
      await ventana.blur();
      await expect(ventana).not.toHaveAttribute('aria-invalid', 'true');
      const noche = campo(page, 'Ventana nocturna (días)');
      await noche.fill('8');
      await noche.blur();
      await expect(noche).toHaveAccessibleDescription(/No puede ser menor que la ventana \(10 días\)\.$/);
      await botonGuardar(page).click();
      await expect(frec).toBeFocused();
      await page.waitForTimeout(200);
      expect(ctl.paramsPuts).toHaveLength(0);
      // Vacío y fecha futura.
      await frec.fill('');
      await frec.blur();
      await expect(frec).toHaveAccessibleDescription(/Escribe la frecuencia en minutos\.$/);
      await campo(page, 'Fecha de arranque').fill(new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10));
      await campo(page, 'Fecha de arranque').blur();
      await expect(campo(page, 'Fecha de arranque')).toHaveAccessibleDescription(/No puede ser una fecha futura\.$/);
      expect(ctl.paramsPuts).toHaveLength(0);
    });

    test('AC3: un 400 marca el campo sin toast ni texto técnico; un 500 da toast con Reintentar y conserva lo escrito', async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      const ctl = await mockear(page);
      await abrir(page);
      ctl.paramsPutStatus = 400;
      ctl.paramsPutBody = { error: 'datos_invalidos', campos: ['arranque'], faltantes: CRUDO };
      await campo(page, 'Ventana (días)').fill('9');
      await botonGuardar(page).click();
      await expect(page.getByTestId('parametros-flit1-alerta')).toHaveText('No se guardó: revisa los campos marcados.');
      await expect(campo(page, 'Fecha de arranque')).toHaveAttribute('aria-invalid', 'true');
      await expect(campo(page, 'Fecha de arranque')).toHaveAccessibleDescription(/Revisa este valor\.$/);
      await expect(campo(page, 'Fecha de arranque')).toBeFocused();
      await expect(page.getByText(CRUDO)).toHaveCount(0);
      await expect(page.getByRole('alert').filter({ hasText: 'No se pudieron guardar' })).toHaveCount(0);
      ctl.paramsPutStatus = 500;
      ctl.paramsPutBody = null;
      await botonGuardar(page).click();
      const toast = page.getByRole('alert').filter({ hasText: 'No se pudieron guardar los parámetros de lectura. Inténtalo de nuevo.' });
      await expect(toast).toBeVisible();
      await expect(campo(page, 'Ventana (días)')).toHaveValue('9');
      await expect(page.getByText(CRUDO)).toHaveCount(0);
      ctl.paramsPutStatus = 200;
      await toast.getByRole('button', { name: 'Reintentar' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Parámetros de lectura guardados.' })).toBeVisible();
      expect(ctl.paramsPuts.at(-1)).toMatchObject({ ventanaDias: 9 });
    });

    test('AC4: si fallan los parámetros o el estado, hay Reintentar y el interruptor sigue funcionando', async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      const ctl = await mockear(page, { f2: false, e2: estado2({ habilitada: false, motivoDeshabilitada: 'interruptor' }) });
      ctl.paramsGetStatus = 500;
      ctl.lecturaStatus = 500;
      await abrir(page);
      const params = page.getByTestId('parametros-flit1');
      await expect(params.getByRole('alert')).toContainText('No se pudieron cargar los parámetros de lectura.');
      await expect(campo(page, 'Frecuencia (minutos)')).toHaveCount(0);
      await expect(botonGuardar(page)).toHaveCount(0);
      await expect(page.getByTestId('linea-lectura-flit1')).toContainText('No se pudo consultar');
      await expect(page.getByTestId('explicacion-flit1')).toHaveText('FLITO lee FLIT 1 automáticamente.');
      await expect(page.getByText(CRUDO)).toHaveCount(0);
      await sw(page, 'flit2').click();
      await expect(sw(page, 'flit2')).toHaveAttribute('aria-checked', 'true');
      ctl.paramsGetStatus = 200;
      ctl.lecturaStatus = 200;
      await page.getByRole('button', { name: 'Reintentar la carga de los parámetros de lectura de FLIT 1' }).click();
      await expect(campo(page, 'Frecuencia (minutos)')).toHaveValue('2');
      await page.getByRole('button', { name: 'Reintentar la consulta del estado de la lectura de FLIT 1' }).click();
      await expect(page.getByTestId('linea-lectura-flit1')).toContainText('Última lectura');
    });

    test('AC5: con ver_estado sin configurar, solo lectura: última, próxima y fallo vigente como aviso; nunca el código', async ({ page }) => {
      const sinConfigurar = FUNCIONES_POR_ROL.admin.filter((f) => f !== 'tramites.sincronizacion.configurar');
      await loginAs(page, { ...OPERACIONES_USER, funciones: sinConfigurar });
      const ctl = await mockear(page, { lectura: lectura({ ultimaLecturaBuenaEn: hace(10), ultimoFallo: { en: hace(2), codigo: 'flit1_timeout' } }) });
      await abrir(page, { expandir: false });
      // El fallo vigente no queda escondido con la zona contraída.
      await expect(page.getByTestId('alerta-resumen-flit1')).toHaveText('Requiere atención');
      await expandirSincronizacion(page);
      expect(ctl.getsParams).toBe(0);
      await expect(page.getByTestId('parametros-flit1')).toHaveCount(0);
      await expect(botonGuardar(page)).toHaveCount(0);
      await expect(page.getByTestId('explicacion-flit1')).toHaveText('FLITO lee FLIT 1 automáticamente.');
      const aviso = page.getByTestId('aviso-fallo-flit1');
      await expect(aviso).toHaveAttribute('role', 'status');
      await expect(aviso).toContainText('Falló la última lectura de FLIT 1.');
      await expect(aviso).toContainText(/A las .+, FLIT 1 no respondió a tiempo\. FLITO vuelve a intentarlo solo en la próxima lectura\./);
      await expect(page.getByText('flit1_timeout')).toHaveCount(0);
      // 5xx y código desconocido: frase humana, nunca el código ni el status.
      ctl.lectura = lectura({ ultimaLecturaBuenaEn: null, ultimoFallo: { en: hace(2), codigo: 'flit1_http_502' } });
      await abrir(page);
      await expect(page.getByTestId('aviso-fallo-flit1')).toContainText('FLIT 1 tuvo un error de su lado.');
      await expect(page.getByText(/502/)).toHaveCount(0);
      ctl.lectura = lectura({ ultimaLecturaBuenaEn: null, ultimoFallo: { en: hace(2), codigo: 'zzz_inventado' } });
      await abrir(page);
      await expect(page.getByTestId('aviso-fallo-flit1')).toContainText('la lectura de FLIT 1 falló en FLITO');
      await expect(page.getByText('zzz_inventado')).toHaveCount(0);
      ctl.lectura = lectura({ ultimaLecturaBuenaEn: null, ultimoFallo: { en: hace(2), codigo: 'tramites_con_fallo' } });
      await abrir(page);
      await expect(page.getByTestId('aviso-fallo-flit1')).toContainText(
        'La última lectura terminó, pero algunos trámites no se pudieron aplicar. Revísalos en la Bitácora; se reintentan en la siguiente lectura y en la lectura nocturna.');
      // Fallo superado: línea muted, sin aviso ni distintivo.
      ctl.lectura = lectura({ ultimaLecturaBuenaEn: hace(1), ultimoFallo: { en: hace(30), codigo: 'flit1_timeout' } });
      await abrir(page, { expandir: false });
      await expect(page.getByTestId('alerta-resumen-flit1')).toHaveCount(0);
      await expandirSincronizacion(page);
      await expect(page.getByTestId('aviso-fallo-flit1')).toHaveCount(0);
      await expect(page.getByTestId('fallo-superado-flit1')).toHaveText(/^Último fallo: hoy a las .+, ya leyó bien después\.$/);
      expect(ctl.posts).toBe(0);
    });
  });
});
