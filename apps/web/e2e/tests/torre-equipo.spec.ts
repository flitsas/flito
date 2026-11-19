// Torre de Control (Épica #14590, bloque B5) — Operativa › Equipo. Cubre (UI): la pestaña solo existe con
// `torre.equipo.ver` (sin ella no se pinta y `?vista=equipo` cae en Resumen); cada KPI y cada celda abren el detalle con
// su conjunto y `s=funcionario:<id>`; «—» sin enlace en 0; orden alfabético por defecto (sin ranking); sin Excel en esta
// subvista; los 4 estados. Backend mockeado con `page.route` (el fixture base responde `200 []` a lo no mockeado).
import { test, expect } from '../helpers/fixtures';
import { loginAs, type UsuarioFixture } from '../helpers/auth';

type Pagina = Parameters<typeof loginAs>[0];

const FUNCIONES = [
  'torre.metricas.consultar', 'torre.metricas.exportar', 'torre.placa.buscar', 'torre.tablero_operativo.ver',
  'torre.equipo.ver', 'torre.detalle.ver', 'torre.detalle.exportar', 'perfil.datos.ver',
];
const GERENCIA: UsuarioFixture = {
  id: 751, username: 'e2e_gerencia_equipo', name: 'Gerencia General E2E', role: 'gerencia_general',
  allowedPages: ['torre_360', 'torre_operativa', 'torre_explorador', 'torre_detalle'], funciones: FUNCIONES,
};
const SIN_EQUIPO: UsuarioFixture = { ...GERENCIA, id: 752, username: 'e2e_sin_equipo', funciones: FUNCIONES.filter((f) => f !== 'torre.equipo.ver') };

const OPCIONES = {
  companias: [{ id: 1, nombre: 'Compañía Demo A' }], organismos: [{ codigo: '05001', nombre: 'OT Demo Norte' }],
  tiposTramite: [{ valor: 'TRASPASO', etiqueta: 'Traspaso' }], flitEstados: [{ valor: 'borrador', etiqueta: 'Borrador' }],
};
const COLUMNA = { gestionesPeriodo: 'gestiones_funcionario_periodo', cargaAbierta: 'carga_funcionario', fueraAns: 'fuera_ans_funcionario' } as const;
const destino = (conjunto: string, id?: string) => ({ tipo: 'conjunto', origen: { tipo: 'conjunto', conjunto }, segmentos: id ? [{ dimension: 'funcionario', valores: [id] }] : [] });
const NINGUNO = { tipo: 'ninguno' };

function fila(funcionarioId: string, nombre: string, gestionesPeriodo: number, cargaAbierta: number, fueraAns: number) {
  const ns = { gestionesPeriodo, cargaAbierta, fueraAns };
  return {
    funcionarioId, nombre, ...ns,
    destinos: Object.fromEntries((Object.keys(COLUMNA) as (keyof typeof COLUMNA)[]).map((k) => [k, ns[k] ? destino(COLUMNA[k], funcionarioId) : NINGUNO])),
  };
}
const kpi = (frase: string, conjunto: string) => ({ frase, definicion: `Definición de ${conjunto}.`, destino: destino(conjunto) });
function equipo(vacio = false) {
  return {
    cifras: vacio ? { funcionarios: 0, gestionesPeriodo: 0, cargaAbierta: 0, fueraAns: 0 } : { funcionarios: 3, gestionesPeriodo: 822, cargaAbierta: 70, fueraAns: 12 },
    frase: '3 funcionarios registraron gestiones en el periodo; hoy tienen 70 gestiones abiertas a su cargo.',
    explicaciones: {
      gestionesPeriodo: kpi('El equipo registró 822 gestiones en el periodo.', 'gestiones_funcionario_periodo'),
      cargaAbierta: kpi('Hay 70 gestiones abiertas cuyo último movimiento lo hizo alguien del equipo.', 'carga_funcionario'),
      fueraAns: kpi('12 de esas gestiones abiertas ya pasaron su ANS.', 'fuera_ans_funcionario'),
    },
    // Ya en orden alfabético (lo hace el API): Bruno tiene MÁS fuera de ANS que Ana y sigue debajo.
    porFuncionario: vacio ? [] : [fila('41', 'Ana Restrepo', 412, 38, 2), fila('7', 'Bruno Cárdenas', 380, 22, 10), fila('103', 'Carla Díaz', 30, 10, 0)],
    rango: { desde: '2026-11-01', hasta: '2026-11-19' }, generadoEn: '2026-11-19T12:00:00.000Z',
  };
}
const OPERATIVO_ERROR = { error: 'TORRE_ERROR' };
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mockBase(page: Pagina, op: { falla?: () => boolean; vacio?: boolean; lento?: Promise<void> } = {}) {
  const pedidos: unknown[] = [];
  await page.route('**/api/flito/torre/opciones', (r) => r.fulfill(json(OPCIONES)));
  // El Resumen de Operativa no es de este bloque: responde error y queda en su estado.
  await page.route('**/api/flito/torre/tableros/operativa', (r) => r.fulfill(json(OPERATIVO_ERROR, 500)));
  await page.route('**/api/flito/torre/tableros/operativa/equipo', async (route) => {
    pedidos.push(route.request().postDataJSON());
    if (op.lento) await op.lento;
    if (op.falla?.()) { await route.fulfill(json({ error: 'TORRE_ERROR', detalle: 'stack crudo' }, 500)); return; }
    await route.fulfill(json(equipo(op.vacio)));
  });
  await page.route('**/api/flito/torre/detalle/consultar', (r) => r.fulfill(json({
    origen: { tipo: 'conjunto', conjunto: 'carga_funcionario' }, segmentos: [],
    definicion: { etiqueta: 'Carga abierta', definicion: 'Gestiones abiertas.', fechaBase: null, campoFecha: 'creado_en' },
    frase: '0 gestiones.', fraseVacio: 'Sin gestiones.', total: 0, valorTotal: null, columnas: [], filas: [], pagina: 1, tamano: 25,
    truncado: false, filtrosIgnorados: [], rango: null, dineroVisible: false, generadoEn: '2026-11-19T12:00:00.000Z',
  })));
  return pedidos;
}

const q = (page: Pagina) => new URL(page.url()).searchParams;
const tabla = (page: Pagina) => page.locator('[data-torre="tabla-equipo"]');

test.describe('Torre de Control · Operativa › Equipo (Épica #14590, B5)', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('con torre.equipo.ver: pestaña en la URL, orden alfabético, sin Excel; KPI y celdas abren su lista por funcionario', async ({ page }) => {
    await loginAs(page, GERENCIA);
    await mockBase(page);
    await page.goto('/flito/torre/operativa');
    const tabs = page.getByRole('tablist', { name: 'Subvistas de Operativa' });
    await expect(tabs.getByRole('tab')).toHaveText(['Resumen', 'Inventario por estado', 'Soportes', 'Equipo']);
    await tabs.getByRole('tab', { name: 'Equipo' }).click();
    await expect(page).toHaveURL(/\/flito\/torre\/operativa\?vista=equipo$/);
    await expect(page.locator('[data-torre="tablero"]')).toHaveAttribute('data-estado', 'lleno');
    await expect(page.locator('[data-torre="exportar-tablero"]')).toHaveCount(0);
    await expect(page.locator('[data-torre="frase-guia"]')).toContainText('3 funcionarios registraron gestiones');

    await expect(tabla(page).locator('thead th')).toHaveText(['Funcionario', 'Gestiones del periodo', 'Carga abierta', 'Pendientes fuera de ANS']);
    await expect(tabla(page).locator('tbody tr td:first-child')).toHaveText(['Ana Restrepo', 'Bruno Cárdenas', 'Carla Díaz']);
    await expect(tabla(page)).not.toContainText(/@|ranking|1\.º/);
    // Celda en 0: «—» sin enlace.
    const carla = tabla(page).locator('tbody tr').filter({ hasText: 'Carla Díaz' });
    await expect(carla.locator('[data-torre="celda-cero"]')).toHaveCount(1);
    await expect(carla.getByRole('link')).toHaveCount(2);

    // Reordenar es opción del usuario: por fuera de ANS, Bruno sube.
    await tabla(page).getByLabel('Ordenar por').selectOption('fueraAns');
    await expect(tabla(page).locator('tbody tr td:first-child').first()).toHaveText('Bruno Cárdenas');

    await page.getByRole('link', { name: 'Bruno Cárdenas: 10 pendientes fuera de ANS. Ver cuáles' }).click();
    expect(q(page).get('c')).toBe('fuera_ans_funcionario');
    expect(q(page).get('s')).toBe('funcionario:7');
    expect(q(page).get('o')).toBe('operativa');
    expect(q(page).get('ov')).toBe('equipo');
    await expect(page.locator('[data-torre="detalle"]')).not.toHaveAttribute('data-estado', 'invalido');
    // El detalle de Equipo no se exporta (el API responde 403 DETALLE_SIN_EXPORTACION): sin botón ni primaria.
    await expect(page.locator('[data-torre="volver"]')).toBeVisible();
    await expect(page.locator('[data-torre="exportar-detalle"]')).toHaveCount(0);
    await page.locator('[data-torre="volver"]').click();
    await expect(page).toHaveURL(/\/flito\/torre\/operativa\?vista=equipo$/);

    await page.locator('[data-torre="kpi-explicable"]').filter({ hasText: 'Carga abierta' }).getByRole('link', { name: /Ver las 70/ }).click();
    expect(q(page).get('c')).toBe('carga_funcionario');
    expect(q(page).get('ov')).toBe('equipo');
  });

  test('sin torre.equipo.ver: la pestaña no se pinta y ?vista=equipo cae en Resumen sin pedir el equipo', async ({ page }) => {
    await loginAs(page, SIN_EQUIPO);
    const pedidos = await mockBase(page);
    await page.goto('/flito/torre/operativa?vista=equipo');
    const tabs = page.getByRole('tablist', { name: 'Subvistas de Operativa' });
    await expect(tabs.getByRole('tab')).toHaveText(['Resumen', 'Inventario por estado', 'Soportes']);
    await expect(tabs.getByRole('tab', { name: 'Resumen' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-torre="tabla-equipo"]')).toHaveCount(0);
    expect(pedidos).toHaveLength(0);
  });

  test('cargando, error con reintento (sin el error crudo) y lleno', async ({ page }) => {
    await loginAs(page, GERENCIA);
    let soltar = () => {};
    const lento = new Promise<void>((r) => { soltar = r; });
    let fallar = true;
    await mockBase(page, { lento, falla: () => fallar });
    await page.goto('/flito/torre/operativa?vista=equipo');
    await expect(page.locator('[data-torre="tablero"]')).toHaveAttribute('data-estado', 'cargando');
    soltar();
    await expect(page.locator('[data-torre="tablero"]')).toHaveAttribute('data-estado', 'error');
    await expect(page.getByText('No pudimos cargar la información del equipo. Intente de nuevo.')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('stack crudo');
    fallar = false;
    await page.getByRole('button', { name: /Reintentar/ }).click();
    await expect(page.locator('[data-torre="tablero"]')).toHaveAttribute('data-estado', 'lleno');
  });

  test('vacío con su siguiente paso', async ({ page }) => {
    await loginAs(page, GERENCIA);
    await mockBase(page, { vacio: true });
    await page.goto('/flito/torre/operativa?vista=equipo');
    await expect(page.locator('[data-torre="tablero"]')).toHaveAttribute('data-estado', 'vacio');
    await expect(page.getByText('Nadie del equipo registró gestiones en el periodo ni tiene gestiones abiertas.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Limpiar filtros' })).toBeVisible();
  });
});
