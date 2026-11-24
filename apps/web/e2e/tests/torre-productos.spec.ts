// Torre de Control (Épica #14590, bloque B3) — área Productos: SOAT · Impuestos · Derechos.
// Cubre (UI): la pestaña vive en la URL (`?vista=`, SOAT por defecto); cada KPI con «Ver los N» abre el Detalle con su
// conjunto y segmentos y «Volver» regresa a la pestaña; cada fila de tabla abre su lista (estado y motivo; el motivo viaja como clave
// opaca de 16 hex y su texto no va en la URL); «Otros» y n = 0 van sin enlace; sin permiso de dinero no
// se pinta la columna de valor; sin `torre_productos` la pestaña no aparece en la Torre; los 4 estados; Excel primaria.
// Backend mockeado con `page.route` (el fixture base responde `200 []` a lo no mockeado). Spec UX §B3.
import { test, expect } from '../helpers/fixtures';
import { loginAs, type UsuarioFixture } from '../helpers/auth';

type Pagina = Parameters<typeof loginAs>[0];

const FUNCIONES = [
  'torre.metricas.consultar', 'torre.metricas.exportar', 'torre.placa.buscar', 'torre.metricas.dinero',
  'torre.tablero_productos.ver', 'torre.tablero_operativo.ver', 'torre.detalle.ver', 'torre.detalle.exportar', 'perfil.datos.ver',
];
const GERENCIA: UsuarioFixture = {
  id: 713, username: 'e2e_gerencia_prod', name: 'Gerencia General E2E', role: 'gerencia_general',
  allowedPages: ['torre_360', 'torre_operativa', 'torre_productos', 'torre_explorador', 'torre_detalle'],
  funciones: FUNCIONES,
};
const SIN_DINERO: UsuarioFixture = { ...GERENCIA, id: 714, username: 'e2e_prod_sin_dinero', funciones: FUNCIONES.filter((f) => f !== 'torre.metricas.dinero') };
/** `financiera` ve Financiera y el Explorador pero no Productos (gerencia_general ya lo trae por defecto de su rol). */
const SIN_PRODUCTOS: UsuarioFixture = {
  ...GERENCIA, id: 715, username: 'e2e_sin_productos', role: 'financiera', allowedPages: ['torre_financiera', 'torre_explorador', 'torre_detalle'],
};

const OPCIONES = {
  companias: [{ id: 1, nombre: 'Compañía Demo A' }],
  organismos: [{ codigo: '05001', nombre: 'OT Demo Norte' }],
  tiposTramite: [{ valor: 'TRASPASO', etiqueta: 'Traspaso' }],
  flitEstados: [{ valor: 'borrador', etiqueta: 'Borrador' }],
};
type Seg = { dimension: string; valores: (string | null)[] };
const destino = (conjunto: string, segmentos: Seg[] = []) => ({ tipo: 'conjunto', origen: { tipo: 'conjunto', conjunto }, segmentos });
const NINGUNO = { tipo: 'ninguno' };
const kpi = (frase: string, conjunto: string, segmentos: Seg[] = []) => ({ frase, definicion: `Definición de ${conjunto}.`, destino: destino(conjunto, segmentos) });
const MOTIVO = 'Placa no corresponde, ver organismo';
/** Clave opaca del motivo (16 hex, la resuelve el API): el texto nunca va en la URL. */
const CLAVE_MOTIVO = '9f3a6c21b0d4e875';

function fila(clave: string | null, etiqueta: string, n: number, conjunto: string, dimension: string, valor?: number | null) {
  return { clave, etiqueta, n, ...(valor !== undefined ? { valor } : {}), destino: n === 0 || clave === '__otros' ? NINGUNO : destino(conjunto, [{ dimension, valores: [clave] }]) };
}
function tabla(titulo: string, conjunto: string, dimension: string, filas: ReturnType<typeof fila>[], conValor: boolean, foto: boolean, valorTotal?: number | null) {
  const n = filas.reduce((a, f) => a + f.n, 0);
  return {
    titulo, dimension, conjunto, definicion: `Definición de ${conjunto}.`, conValor, filas,
    total: { clave: null, etiqueta: 'Total', n, ...(conValor ? { valor: valorTotal ?? null } : {}), destino: destino(conjunto) },
    filtrosIgnorados: foto ? ['rango'] : [],
  };
}

function tablero(dinero: boolean) {
  const v = (x: number) => (dinero ? x : null);
  return {
    rango: { desde: '2026-11-01', hasta: '2026-11-19' }, dineroVisible: dinero, generadoEn: '2026-11-19T12:00:00.000Z',
    soat: {
      cifras: { pagadosPeriodo: 138, pagadosValor: v(96_000_000), porVencer: 27, sinGestion: 9, vigenciaNoVerificada: 0 },
      explicaciones: {
        sinGestion: kpi('9 gestiones de SOAT llevan más de 48 horas sin soporte.', 'soat_sin_gestion'),
        porVencer: kpi('27 SOAT vencen en los próximos 30 días.', 'soat_por_vencer'),
        vigenciaNoVerificada: kpi('Todos los SOAT pagados tienen su vigencia verificada en el RUNT.', 'soat_vigencia_no_verificada'),
        pagadosPeriodo: kpi(dinero ? '138 SOAT pagados en el periodo por $ 96 M.' : '138 SOAT pagados en el periodo.', 'soat_pagados_periodo'),
      },
      tablas: [
        tabla('SOAT del periodo por estado', 'soat_por_estado', 'estado', [
          fila('pendiente', 'Pendiente', 88, 'soat_por_estado', 'estado', v(0)),
          fila('solicitado', 'Solicitado', 201, 'soat_por_estado', 'estado', v(0)),
          fila('pagado', 'Pagado', 123, 'soat_por_estado', 'estado', v(96_000_000)),
          fila('novedad', 'Con novedad', 0, 'soat_por_estado', 'estado', v(0)),
        ], true, false, v(96_000_000)),
        tabla('Solicitudes incompletas abiertas, por motivo', 'soat_incompletas_abiertas', 'motivo', [
          fila('4c1e0a9b7d2f6e38', 'RUNT sin respuesta', 7, 'soat_incompletas_abiertas', 'motivo'),
          fila('__otros', 'Otros', 2, 'soat_incompletas_abiertas', 'motivo'),
        ], false, true),
      ],
    },
    impuestos: {
      cifras: { pagadosPeriodo: 97, pagadosValor: v(41_000_000), sinGestion: 5, conDiferencia: 8, direccionPendiente: 4 },
      explicaciones: {
        sinGestion: kpi('5 gestiones de impuesto llevan más de 48 horas sin soporte.', 'impuesto_sin_gestion'),
        conDiferencia: kpi('8 impuestos tienen diferencia.', 'impuestos_con_diferencia'),
        direccionPendiente: kpi('4 impuestos tienen la dirección pendiente de revisión.', 'impuestos_direccion_pendiente'),
        pagadosPeriodo: kpi('97 impuestos pagados en el periodo.', 'impuestos_pagados_periodo'),
      },
      tablas: [
        tabla('Impuestos del periodo por estado', 'impuestos_por_estado', 'estado', [
          fila('pendiente', 'Pendiente', 139, 'impuestos_por_estado', 'estado', v(0)),
          fila('pagado', 'Pagado', 97, 'impuestos_por_estado', 'estado', v(41_000_000)),
        ], true, false, v(41_000_000)),
        tabla('Con novedad en el periodo, por motivo', 'impuestos_rechazados_periodo', 'motivo', [
          fila(CLAVE_MOTIVO, MOTIVO, 6, 'impuestos_rechazados_periodo', 'motivo'),
        ], false, false),
      ],
    },
    derechos: {
      cifras: { pagadosPeriodo: 184, pagadosValor: v(23_000_000), sinSoporte: 7, pendientesSinResolver: 11 },
      explicaciones: {
        pagadosPeriodo: kpi('184 derechos de tránsito pagados en el periodo.', 'derechos_pagados_periodo'),
        sinSoporte: kpi('7 derechos de tránsito no tienen soporte.', 'derechos_sin_soporte'),
        pendientesSinResolver: kpi('11 recibos siguen sin asociar a un trámite.', 'derechos_pendientes_sin_resolver'),
      },
      tablas: [],
    },
  };
}

function vacio() {
  const t = tablero(true);
  t.soat.cifras = { pagadosPeriodo: 0, pagadosValor: 0, porVencer: 0, sinGestion: 0, vigenciaNoVerificada: 0 };
  t.soat.tablas = [tabla('SOAT del periodo por estado', 'soat_por_estado', 'estado', [], true, false, 0)];
  return t;
}

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mockBase(page: Pagina, opciones: { dinero?: boolean; falla?: () => boolean; vacio?: boolean; lento?: Promise<void> } = {}) {
  await page.route('**/api/flito/torre/opciones', (r) => r.fulfill(json(OPCIONES)));
  await page.route('**/api/flito/torre/tableros/productos', async (route) => {
    if (opciones.lento) await opciones.lento;
    if (opciones.falla?.()) { await route.fulfill(json({ error: 'TORRE_ERROR', detalle: 'stack crudo' }, 500)); return; }
    await route.fulfill(json(opciones.vacio ? vacio() : tablero(opciones.dinero ?? true)));
  });
  await page.route('**/api/flito/torre/detalle/consultar', (r) => r.fulfill(json({
    origen: { tipo: 'conjunto', conjunto: 'soat_por_estado' }, segmentos: [],
    definicion: { etiqueta: 'SOAT por estado', definicion: 'Gestiones de SOAT.', fechaBase: 'creacion', campoFecha: 'creado_en' },
    frase: '0 gestiones.', fraseVacio: 'Sin gestiones.', total: 0, valorTotal: null, columnas: [], filas: [], pagina: 1, tamano: 25,
    truncado: false, filtrosIgnorados: [], rango: null, dineroVisible: true, generadoEn: '2026-11-19T12:00:00.000Z',
  })));
}

const detalleUrl = (page: Pagina) => new URL(page.url()).searchParams;

test.describe('Torre de Control · Productos (Épica #14590, B3)', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('B3: pestañas en la URL; cada KPI abre su conjunto y «Volver» regresa a la pestaña', async ({ page }) => {
    await loginAs(page, GERENCIA);
    await mockBase(page);
    await page.goto('/flito/torre/productos');

    await expect(page.getByRole('heading', { level: 1, name: 'Productos' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Páginas de la Torre de Control' }).getByRole('link', { name: 'Productos' })).toBeVisible();
    const pestanas = page.getByRole('tablist', { name: 'Productos' });
    await expect(pestanas.getByRole('tab')).toHaveText(['SOAT', 'Impuestos', 'Derechos']);
    await expect(pestanas.getByRole('tab', { name: 'SOAT' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-torre="tablero"]')).toHaveAttribute('data-estado', 'lleno');
    // Excel es la primaria del encabezado.
    await expect(page.locator('[data-torre="exportar-tablero"]')).toBeEnabled();

    // SOAT: 4 KPI; la de 0 no tiene «Ver».
    const kpis = page.locator('[data-torre="kpi-explicable"]');
    await expect(kpis).toHaveCount(4);
    await expect(kpis.filter({ hasText: 'Vigencia sin verificar' }).locator('[data-torre="ver-registros"]')).toHaveCount(0);
    await kpis.filter({ hasText: 'SOAT por vencer' }).getByRole('link', { name: /Ver los 27/ }).click();
    await expect(page).toHaveURL(/\/flito\/torre\/detalle\?/);
    expect(detalleUrl(page).get('c')).toBe('soat_por_vencer');
    expect(detalleUrl(page).get('o')).toBe('productos');
    expect(detalleUrl(page).get('ov')).toBeNull();
    await page.locator('[data-torre="volver"]').click();
    await expect(page).toHaveURL(/\/flito\/torre\/productos$/);

    // Impuestos: la pestaña viaja y el detalle vuelve a ella.
    await pestanas.getByRole('tab', { name: 'Impuestos' }).click();
    await expect(page).toHaveURL(/\/flito\/torre\/productos\?vista=impuestos$/);
    await kpis.filter({ hasText: 'Con diferencia de valor' }).getByRole('link', { name: /Ver los 8/ }).click();
    expect(detalleUrl(page).get('c')).toBe('impuestos_con_diferencia');
    expect(detalleUrl(page).get('ov')).toBe('impuestos');
    await page.locator('[data-torre="volver"]').click();
    await expect(page).toHaveURL(/\/flito\/torre\/productos\?vista=impuestos$/);
    await expect(page.getByRole('tab', { name: 'Impuestos' })).toHaveAttribute('aria-selected', 'true');

    // Derechos: 3 KPI y sin tabla principal.
    await pestanas.getByRole('tab', { name: 'Derechos' }).click();
    await expect(page).toHaveURL(/\?vista=derechos$/);
    await expect(kpis).toHaveCount(3);
    await expect(page.locator('[data-torre="tablero"] table')).toHaveCount(0);
    await kpis.filter({ hasText: 'Pendientes sin resolver' }).getByRole('link', { name: /Ver los 11/ }).click();
    expect(detalleUrl(page).get('c')).toBe('derechos_pendientes_sin_resolver');
    expect(detalleUrl(page).get('ov')).toBe('derechos');
  });

  test('B3: cada fila abre su lista; «Otros» y n = 0 sin enlace; el motivo con espacios llega al detalle', async ({ page }) => {
    await loginAs(page, GERENCIA);
    await mockBase(page);
    await page.goto('/flito/torre/productos');
    const principal = page.locator('[data-torre="tabla-principal"]');
    await expect(principal.locator('thead th')).toHaveText(['Estado', 'SOAT', 'Valor', 'Registros']);
    await expect(principal.locator('tbody tr')).toHaveCount(5);
    // n = 0 sin enlace; la fila Total sí abre (el conjunto sin segmento).
    await expect(principal.locator('tbody tr').filter({ hasText: 'Con novedad' }).getByRole('link')).toHaveCount(0);
    await expect(principal.getByRole('link', { name: 'Ver los 412: SOAT del periodo por estado' })).toBeVisible();

    const incompletas = page.locator('[data-torre="tabla-soat_incompletas_abiertas"]');
    await expect(incompletas.getByText('Foto de hoy')).toBeVisible();
    await expect(incompletas.locator('tbody tr').filter({ hasText: 'Otros' }).getByRole('link')).toHaveCount(0);

    await principal.getByRole('link', { name: 'Ver los 201: SOAT del periodo por estado: Solicitado' }).click();
    expect(detalleUrl(page).get('c')).toBe('soat_por_estado');
    expect(detalleUrl(page).get('s')).toBe('estado:solicitado');
    await page.goBack();

    await page.getByRole('tab', { name: 'Impuestos' }).click();
    // El motivo viaja como clave opaca: el detalle la acepta y la manda en el body; su texto nunca va en la URL.
    const pedido = page.waitForRequest('**/api/flito/torre/detalle/consultar');
    await page.getByRole('link', { name: `Ver los 6: Con novedad en el periodo, por motivo: ${MOTIVO}` }).click();
    expect(detalleUrl(page).get('c')).toBe('impuestos_rechazados_periodo');
    expect(detalleUrl(page).get('s')).toBe(`motivo:${CLAVE_MOTIVO}`);
    expect(decodeURIComponent(page.url())).not.toContain('Placa no corresponde');
    await expect(page.locator('[data-torre="detalle"]')).not.toHaveAttribute('data-estado', 'invalido');
    const cuerpo = (await pedido).postDataJSON() as { segmentos: Seg[] };
    expect(cuerpo.segmentos).toEqual([{ dimension: 'motivo', valores: [CLAVE_MOTIVO] }]);
  });

  test('B3: sin permiso de dinero no se pinta la columna de valor', async ({ page }) => {
    await loginAs(page, SIN_DINERO);
    await mockBase(page, { dinero: false });
    await page.goto('/flito/torre/productos');
    const principal = page.locator('[data-torre="tabla-principal"]');
    await expect(principal.locator('thead th')).toHaveText(['Estado', 'SOAT', 'Registros']);
    await expect(principal).not.toContainText('$');
  });

  test('B3: sin torre_productos la pestaña no aparece en la Torre y la ruta no abre', async ({ page }) => {
    await loginAs(page, SIN_PRODUCTOS);
    await page.route('**/api/flito/torre/opciones', (r) => r.fulfill(json(OPCIONES)));
    // El catch-all respondería `200 []` (forma inválida) a la consulta del Explorador: aquí solo importa la navegación.
    await page.route('**/api/flito/torre/metricas/consultar', (r) => r.fulfill(json({ error: 'TORRE_ERROR' }, 500)));
    await page.goto('/flito/torre/explorador');
    const torre = page.getByRole('navigation', { name: 'Páginas de la Torre de Control' });
    await expect(torre.getByRole('link', { name: 'Explorador' })).toBeVisible();
    await expect(torre.getByRole('link', { name: 'Productos' })).toHaveCount(0);
    await page.goto('/flito/torre/productos');
    await expect(page.getByRole('heading', { level: 1, name: 'Productos' })).toHaveCount(0);
  });

  test('B3: cargando, error con reintento (sin el error crudo) y vacío', async ({ page }) => {
    await loginAs(page, GERENCIA);
    let soltar = () => {};
    const lento = new Promise<void>((r) => { soltar = r; });
    let fallar = true;
    await mockBase(page, { lento, falla: () => fallar });
    await page.goto('/flito/torre/productos');
    await expect(page.locator('[data-torre="tablero"]')).toHaveAttribute('data-estado', 'cargando');
    soltar();
    await expect(page.locator('[data-torre="tablero"]')).toHaveAttribute('data-estado', 'error');
    await expect(page.getByText('No pudimos cargar los SOAT. Intente de nuevo.')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('stack crudo');
    await expect(page.locator('[data-torre="exportar-tablero"]')).toBeDisabled();
    fallar = false;
    await page.getByRole('button', { name: /Reintentar/ }).click();
    await expect(page.locator('[data-torre="tablero"]')).toHaveAttribute('data-estado', 'lleno');
  });

  test('B3: vacío de SOAT con su siguiente paso; las otras pestañas siguen con su contenido', async ({ page }) => {
    await loginAs(page, GERENCIA);
    await mockBase(page, { vacio: true });
    await page.goto('/flito/torre/productos');
    await expect(page.locator('[data-torre="tablero"]')).toHaveAttribute('data-estado', 'vacio');
    await expect(page.getByText('No hay SOAT en gestión ni pagados en el periodo con estos filtros.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Limpiar filtros' })).toBeVisible();
    await page.getByRole('tab', { name: 'Impuestos' }).click();
    await expect(page.locator('[data-torre="tablero"]')).toHaveAttribute('data-estado', 'lleno');
  });
});
