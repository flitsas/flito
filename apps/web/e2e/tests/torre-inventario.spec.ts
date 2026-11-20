// Torre de Control (Épica #14590, bloque B2) — Operativa › Inventario por estado y Soportes.
// Cubre B2-AC1: la pestaña activa vive en la URL (`?vista=`); cada celda abre el detalle con sus segmentos (estado +
// tramo, + organismo si se eligió); la celda en 0 es «—» sin enlace; el ▲ lleva texto accesible; el organismo viaja en
// el body; «Volver» del detalle regresa a la subvista. B2-AC3: en Soportes cada faltante abre su lista. Los 4 estados.
// Backend mockeado con `page.route` (el fixture base responde `200 []` a lo no mockeado). Spec UX §6.1 y §6.2.
import { test, expect } from '../helpers/fixtures';
import { loginAs, type UsuarioFixture } from '../helpers/auth';

type Pagina = Parameters<typeof loginAs>[0];

const GERENCIA: UsuarioFixture = {
  id: 712, username: 'e2e_gerencia_inv', name: 'Gerencia General E2E', role: 'gerencia_general',
  allowedPages: ['torre_360', 'torre_comercial', 'torre_operativa', 'torre_financiera', 'torre_explorador', 'torre_detalle'],
  funciones: [
    'torre.metricas.consultar', 'torre.metricas.exportar', 'torre.placa.buscar', 'torre.metricas.dinero',
    'torre.tablero_operativo.ver', 'torre.detalle.ver', 'torre.detalle.exportar', 'perfil.datos.ver',
  ],
};

const OPCIONES = {
  companias: [{ id: 1, nombre: 'Compañía Demo A' }],
  organismos: [{ codigo: '05001', nombre: 'OT Demo Norte' }, { codigo: '05266', nombre: 'OT Demo Sur' }],
  tiposTramite: [{ valor: 'TRASPASO', etiqueta: 'Traspaso' }],
  flitEstados: [{ valor: 'borrador', etiqueta: 'Borrador' }],
};
const TRAMOS = [
  { clave: '0_2', etiqueta: '0–2 días' }, { clave: '3_7', etiqueta: '3–7 días' }, { clave: '8_15', etiqueta: '8–15 días' },
  { clave: '16_30', etiqueta: '16–30 días' }, { clave: 'mas_30', etiqueta: 'Más de 30' },
] as const;
type Seg = { dimension: string; valores: (string | null)[] };
const destino = (segmentos: Seg[]) => ({ tipo: 'conjunto', origen: { tipo: 'conjunto', conjunto: 'inventario_estado' }, segmentos });
const NINGUNO = { tipo: 'ninguno' };

function celda(n: number, segs: Seg[], sobreUmbral = false) {
  return { n, sobreUmbral, destino: n === 0 ? NINGUNO : destino(segs) };
}

/** Matriz demo: Borrador (umbral 7 d) y Radicado (sin umbral); con organismo, solo Radicado. */
function inventario(organismo: string | null) {
  const org: Seg[] = organismo ? [{ dimension: 'organismo', valores: [organismo] }] : [];
  const valores: Record<string, number[]> = organismo
    ? { radicado: [3, 0, 0, 0, 0] }
    : { borrador: [9, 5, 8, 3, 0], radicado: [40, 31, 12, 4, 0] };
  const filas = Object.entries(valores).map(([estado, ns]) => ({
    estado, etiqueta: estado === 'borrador' ? 'Borrador' : 'Radicado',
    umbral: estado === 'borrador' ? { clave: 'dias_borrador_abandonado', valor: 7 } : null,
    celdas: Object.fromEntries(TRAMOS.map((t, i) => [t.clave, celda(ns[i], [
      { dimension: 'flit_estado', valores: [estado] }, { dimension: 'tramo_antiguedad', valores: [t.clave] }, ...org,
    ], estado === 'borrador' && i >= 2 && ns[i] > 0)])),
    total: celda(ns.reduce((a, b) => a + b, 0), [{ dimension: 'flit_estado', valores: [estado] }, ...org]),
  }));
  const porTramo = TRAMOS.map((_, i) => Object.values(valores).reduce((a, ns) => a + ns[i], 0));
  const total = porTramo.reduce((a, b) => a + b, 0);
  return {
    tramos: TRAMOS, filas,
    totales: {
      celdas: Object.fromEntries(TRAMOS.map((t, i) => [t.clave, celda(porTramo[i], [{ dimension: 'tramo_antiguedad', valores: [t.clave] }, ...org])])),
      total: celda(total, org),
    },
    organismo, organismos: OPCIONES.organismos,
    frase: `${total} trámites en curso hoy, por estado y por días en ese estado.`,
    definicion: 'Trámites en curso hoy, agrupados por su estado actual y por los días que llevan en él. No depende del periodo.',
    leyendaUmbral: '▲ Pasa el umbral de ese estado (Borrador: 7 días; en el organismo: 10 días).',
    generadoEn: '2026-11-19T12:00:00.000Z',
  };
}

const SOPORTES = {
  aprobados: 230,
  incompletos: { n: 52, destino: { tipo: 'conjunto', origen: { tipo: 'conjunto', conjunto: 'soportes_faltantes' } } },
  porFaltante: [
    { faltante: 'soat', etiqueta: 'SOAT', n: 30, destino: { tipo: 'conjunto', origen: { tipo: 'conjunto', conjunto: 'soportes_faltantes' }, segmentos: [{ dimension: 'faltante', valores: ['soat'] }] } },
    { faltante: 'impuesto', etiqueta: 'Impuesto', n: 18, destino: { tipo: 'conjunto', origen: { tipo: 'conjunto', conjunto: 'soportes_faltantes' }, segmentos: [{ dimension: 'faltante', valores: ['impuesto'] }] } },
    { faltante: 'derecho', etiqueta: 'Derecho', n: 0, destino: NINGUNO },
  ],
  frase: 'De 230 trámites aprobados en el periodo, a 52 les falta al menos un soporte.',
  definicion: 'Trámites aprobados en el periodo a los que les falta el soporte de SOAT, impuesto o derecho.',
  rango: { desde: '2026-11-01', hasta: '2026-11-19' }, generadoEn: '2026-11-19T12:00:00.000Z',
};

const META = { filtrosIgnorados: [] as string[] };
/** Resumen mínimo de Operativa (la pestaña por defecto). */
const OPERATIVO = {
  rango: { desde: '2026-11-01', hasta: '2026-11-19' }, dineroVisible: true, generadoEn: '2026-11-19T12:00:00.000Z',
  cifras: { sinGestionFueraAns: 0, borradoresAbandonados: 2, wip: 112, primerIntentoPct: null },
  explicaciones: {},
  radar: { ...META, filas: [] },
  carga: { ...META, porOrganismo: [], porFuncionario: null },
  benchmarkOt: { ...META, umbralDias: 10, filas: [] },
  logistica: { ...META, entregas: 0, primerIntento: 0, primerIntentoPct: null, viajesAdicionales: 0, tiempoMedioEntregaDias: null },
};

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mockBase(page: Pagina, cuerpos: { organismo?: string | null; filtro?: unknown }[], opciones: {
  falla?: () => boolean; vacio?: boolean; soportes?: unknown;
} = {}) {
  await page.route('**/api/flito/torre/opciones', (r) => r.fulfill(json(OPCIONES)));
  await page.route('**/api/flito/torre/tableros/operativa', (r) => r.fulfill(json(OPERATIVO)));
  await page.route('**/api/flito/torre/tableros/operativa/inventario', async (route) => {
    const c = route.request().postDataJSON() as { organismo?: string | null; filtro?: unknown };
    cuerpos.push(c);
    if (opciones.falla?.()) { await route.fulfill(json({ error: 'TORRE_ERROR', detalle: 'stack crudo' }, 500)); return; }
    const d = inventario(c.organismo ?? null);
    if (opciones.vacio || c.organismo === '05001') {
      d.filas = [];
      d.totales.total = celda(0, []);
    }
    await route.fulfill(json(d));
  });
  await page.route('**/api/flito/torre/tableros/operativa/soportes', (r) => r.fulfill(json(opciones.soportes ?? SOPORTES)));
  // El detalle responde vacío: aquí solo importa la URL y la vuelta.
  await page.route('**/api/flito/torre/detalle/consultar', (r) => r.fulfill(json({
    origen: { tipo: 'conjunto', conjunto: 'inventario_estado' }, segmentos: [],
    definicion: { etiqueta: 'Inventario por estado', definicion: 'Trámites en curso.', fechaBase: null, campoFecha: 'fecha_creacion' },
    frase: '0 trámites.', fraseVacio: 'Sin trámites.', total: 0, valorTotal: null, columnas: [], filas: [], pagina: 1, tamano: 25,
    truncado: false, filtrosIgnorados: [], rango: null, dineroVisible: true, generadoEn: '2026-11-19T12:00:00.000Z',
  })));
}

const matriz = (page: Pagina) => page.locator('[data-torre="inventario"] table');

test.describe('Torre de Control · Operativa › Inventario por estado y Soportes (Épica #14590, B2)', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('B2-AC1: la pestaña va en la URL, la celda abre su lista con estado y tramo, y «Volver» regresa a la subvista', async ({ page }) => {
    await loginAs(page, GERENCIA);
    const cuerpos: { organismo?: string | null }[] = [];
    await mockBase(page, cuerpos);
    await page.goto('/flito/torre/operativa');

    const pestanas = page.getByRole('tablist', { name: 'Subvistas de Operativa' });
    await expect(pestanas.getByRole('tab')).toHaveText(['Resumen', 'Inventario por estado', 'Soportes']);
    await pestanas.getByRole('tab', { name: 'Inventario por estado' }).click();
    await expect(page).toHaveURL(/\/flito\/torre\/operativa\?vista=inventario$/);
    await expect(pestanas.getByRole('tab', { name: 'Inventario por estado' })).toHaveAttribute('aria-selected', 'true');
    // Sin Excel en esta subvista: la primaria del encabezado no se pinta.
    await expect(page.locator('[data-torre="exportar-tablero"]')).toHaveCount(0);

    const inv = page.locator('[data-torre="inventario"]');
    await expect(inv).toHaveAttribute('data-estado', 'lleno');
    await expect(inv).toContainText('112 trámites en curso hoy');
    await expect(inv.getByText('Foto de hoy')).toBeVisible();
    await expect(matriz(page).locator('thead th')).toHaveText(['Estado', '0–2 días', '3–7 días', '8–15 días', '16–30 días', 'Más de 30', 'Total']);
    await expect(inv.locator('[data-torre="leyenda-umbral"]')).toContainText('▲ Pasa el umbral');

    // ▲ con texto accesible (nunca solo color).
    const sobre = page.getByRole('link', { name: 'Borrador, 8 a 15 días: 8 trámites, pasan el umbral. Ver cuáles' });
    await expect(sobre).toHaveText('▲ 8');
    await expect(sobre).toHaveAttribute('data-umbral', 'true');
    // Sin umbral: sin ▲.
    await expect(page.getByRole('link', { name: 'Radicado, 8 a 15 días: 12 trámites. Ver cuáles' })).toHaveText('12');
    // Celda en 0: «—» sin enlace (Borrador, más de 30).
    const filaBorrador = matriz(page).locator('tbody tr').filter({ hasText: 'Borrador' });
    await expect(filaBorrador.locator('[data-torre="celda-cero"]')).toHaveCount(1);
    await expect(filaBorrador.locator('[data-torre="celda-cero"]')).toContainText('—');
    await expect(filaBorrador.getByRole('link')).toHaveCount(5);
    // Totales: también abren su lista.
    await expect(page.getByRole('link', { name: 'Total general, total: 112 trámites. Ver cuáles' })).toBeVisible();

    // «¿Cómo se calcula?» muestra la definición del API.
    await inv.getByRole('button', { name: /¿Cómo se calcula\?/ }).click();
    await expect(inv.locator('[data-torre="definicion"]')).toContainText('No depende del periodo.');

    await sobre.click();
    await expect(page).toHaveURL(/\/flito\/torre\/detalle\?/);
    const url = new URL(page.url());
    expect(url.searchParams.get('c')).toBe('inventario_estado');
    expect(url.searchParams.get('s')).toBe('flit_estado:borrador;tramo_antiguedad:8_15');
    expect(url.searchParams.get('o')).toBe('operativa');
    expect(url.searchParams.get('ov')).toBe('inventario');

    await page.getByRole('link', { name: /Volver a Inventario por estado/ }).click();
    await expect(page).toHaveURL(/\/flito\/torre\/operativa\?vista=inventario$/);
    await expect(page.getByRole('tab', { name: 'Inventario por estado' })).toHaveAttribute('aria-selected', 'true');
    expect(cuerpos[0]).toMatchObject({ organismo: null });
  });

  test('B2-AC1: el organismo se suma al filtro (body) y la celda abre la lista con el organismo; vacío con organismo', async ({ page }) => {
    await loginAs(page, GERENCIA);
    const cuerpos: { organismo?: string | null }[] = [];
    await mockBase(page, cuerpos);
    await page.goto('/flito/torre/operativa?vista=inventario');
    const inv = page.locator('[data-torre="inventario"]');
    await expect(inv).toHaveAttribute('data-estado', 'lleno');

    await inv.getByLabel('Organismo').selectOption('05266');
    await expect.poll(() => cuerpos.at(-1)?.organismo).toBe('05266');
    expect(page.url()).not.toContain('05266');
    await expect(inv).toContainText('3 trámites en curso hoy');
    await page.getByRole('link', { name: 'Radicado, 0 a 2 días: 3 trámites. Ver cuáles' }).click();
    expect(new URL(page.url()).searchParams.get('s')).toBe('flit_estado:radicado;tramo_antiguedad:0_2;organismo:05266');

    // Vacío con organismo: su copy y el siguiente paso («Todos»).
    await page.goBack();
    await inv.getByLabel('Organismo').selectOption('05001');
    await expect(inv).toHaveAttribute('data-estado', 'vacio');
    await expect(inv).toContainText('Este organismo no tiene trámites en curso. Elija «Todos» para ver el resto.');
    await inv.getByRole('button', { name: 'Ver todos los organismos' }).click();
    await expect(inv).toHaveAttribute('data-estado', 'lleno');
    await expect(inv.getByLabel('Organismo')).toHaveValue('');
  });

  test('B2-AC1: error con Reintentar (sin el error crudo) y vuelta al lleno', async ({ page }) => {
    await loginAs(page, GERENCIA);
    let fallar = true;
    const cuerpos: unknown[] = [];
    await mockBase(page, cuerpos, { falla: () => fallar });
    await page.goto('/flito/torre/operativa?vista=inventario');
    const inv = page.locator('[data-torre="inventario"]');
    await expect(inv).toHaveAttribute('data-estado', 'error');
    await expect(inv).toContainText('No pudimos cargar el inventario por estado. Intente de nuevo.');
    await expect(inv).not.toContainText('stack crudo');
    fallar = false;
    await inv.getByRole('button', { name: 'Reintentar' }).click();
    await expect(inv).toHaveAttribute('data-estado', 'lleno');
  });

  test('B2-AC1: vacío del día sin organismo', async ({ page }) => {
    await loginAs(page, GERENCIA);
    await mockBase(page, [], { vacio: true });
    await page.goto('/flito/torre/operativa?vista=inventario');
    const inv = page.locator('[data-torre="inventario"]');
    await expect(inv).toHaveAttribute('data-estado', 'vacio');
    await expect(inv).toContainText('No hay trámites en curso hoy.');
  });

  test('B2-AC3: en Soportes cada faltante abre su lista y «Volver» regresa a Soportes', async ({ page }) => {
    await loginAs(page, GERENCIA);
    await mockBase(page, []);
    await page.goto('/flito/torre/operativa?vista=soportes');
    const sop = page.locator('[data-torre="soportes"]');
    await expect(sop).toHaveAttribute('data-estado', 'lleno');
    await expect(page.getByRole('article', { name: 'Aprobados del periodo' })).toContainText('230');
    const inc = page.getByRole('article', { name: 'Con soportes incompletos' });
    await expect(inc).toContainText('52');
    await expect(inc).toContainText('a 52 les falta al menos un soporte');
    await expect(inc.getByRole('link', { name: /Ver los 52 incompletos/ })).toBeVisible();

    const tabla = page.locator('[data-torre="bloque-faltantes"]');
    await expect(tabla.getByRole('link', { name: 'Ver los 18: trámites sin Impuesto' })).toBeVisible();
    // Derecho en 0: sin enlace.
    await expect(tabla.getByRole('link', { name: /sin Derecho/ })).toHaveCount(0);
    await tabla.getByRole('link', { name: 'Ver los 30: trámites sin SOAT' }).click();
    const url = new URL(page.url());
    expect(url.searchParams.get('c')).toBe('soportes_faltantes');
    expect(url.searchParams.get('s')).toBe('faltante:soat');
    expect(url.searchParams.get('ov')).toBe('soportes');
    await page.getByRole('link', { name: /Volver a Soportes/ }).click();
    await expect(page).toHaveURL(/\/flito\/torre\/operativa\?vista=soportes$/);
  });

  test('B2-AC3: Soportes sin aprobados en el periodo muestra el vacío con su siguiente paso', async ({ page }) => {
    await loginAs(page, GERENCIA);
    await mockBase(page, [], { soportes: { ...SOPORTES, aprobados: 0, incompletos: { n: 0, destino: NINGUNO }, porFaltante: [] } });
    await page.goto('/flito/torre/operativa?vista=soportes');
    const sop = page.locator('[data-torre="soportes"]');
    await expect(sop).toHaveAttribute('data-estado', 'vacio');
    await expect(sop).toContainText('No hay trámites aprobados en el periodo.');
  });

  test('una vista desconocida en la URL cae en Resumen con su Excel', async ({ page }) => {
    await loginAs(page, GERENCIA);
    await mockBase(page, []);
    await page.goto('/flito/torre/operativa?vista=equipo');
    await expect(page.getByRole('tab', { name: 'Resumen' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-torre="exportar-tablero"]')).toHaveCount(1);
  });
});
