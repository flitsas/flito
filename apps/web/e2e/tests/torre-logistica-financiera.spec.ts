// Torre de Control (Épica #14590, bloque B4) — Logística (Traslados · Entregas) y Financiera (Resumen · Facturación ·
// Bolsas). Cubre (UI): pestañas en la URL; cada KPI, desglose y fila abre su detalle con conjunto y segmentos y «Volver»
// regresa a la pestaña; «Ver los N movimientos» de una bolsa lleva `bolsa:<uuid>`; el semáforo dice su texto; sin
// `torre_logistica` no aparece; sin dinero no hay columnas de valor; los 4 estados por subvista; el Excel exporta la
// subvista activa. Backend mockeado con `page.route` (el fixture base responde `200 []` a lo no mockeado).
import { test, expect } from '../helpers/fixtures';
import { loginAs, type UsuarioFixture } from '../helpers/auth';

type Pagina = Parameters<typeof loginAs>[0];

const FUNCIONES = [
  'torre.metricas.consultar', 'torre.metricas.exportar', 'torre.placa.buscar', 'torre.metricas.dinero',
  'torre.tablero_logistica.ver', 'torre.tablero_financiero.ver', 'torre.detalle.ver', 'torre.detalle.exportar', 'perfil.datos.ver',
];
const GERENCIA: UsuarioFixture = {
  id: 731, username: 'e2e_gerencia_log', name: 'Gerencia General E2E', role: 'gerencia_general',
  allowedPages: ['torre_360', 'torre_financiera', 'torre_logistica', 'torre_explorador', 'torre_detalle'], funciones: FUNCIONES,
};
const SIN_DINERO: UsuarioFixture = { ...GERENCIA, id: 732, username: 'e2e_log_sin_dinero', funciones: FUNCIONES.filter((f) => f !== 'torre.metricas.dinero') };
/** `financiera` ve Financiera pero no Logística (gerencia_general ya la trae por defecto de su rol). */
const SIN_LOGISTICA: UsuarioFixture = {
  ...GERENCIA, id: 733, username: 'e2e_sin_logistica', role: 'financiera', allowedPages: ['torre_financiera', 'torre_explorador', 'torre_detalle'],
};

const OPCIONES = {
  companias: [{ id: 1, nombre: 'Compañía Demo A' }], organismos: [{ codigo: '05001', nombre: 'OT Demo Norte' }],
  tiposTramite: [{ valor: 'TRASPASO', etiqueta: 'Traspaso' }], flitEstados: [{ valor: 'borrador', etiqueta: 'Borrador' }],
};
type Seg = { dimension: string; valores: (string | null)[] };
const destino = (conjunto: string, segmentos: Seg[] = []) => ({ tipo: 'conjunto', origen: { tipo: 'conjunto', conjunto }, segmentos });
const NINGUNO = { tipo: 'ninguno' };
const kpi = (frase: string, conjunto: string, segmentos: Seg[] = [], extra: Record<string, unknown> = {}) => ({ frase, definicion: `Definición de ${conjunto}.`, destino: destino(conjunto, segmentos), ...extra });
const BOLSA_A = '3f0c2a5e-8b1d-4c7a-9e21-6d4f0b8a1c33';
const BOLSA_B = '7a9e1c44-2d3b-4f6e-8a10-c5b2d9e0f117';
const MOTIVO = 'a41c9e07d2b5f863';

function fila(clave: string | null, etiqueta: string, n: number, conjunto: string, dimension: string, valor?: number | null) {
  return { clave, etiqueta, n, ...(valor !== undefined ? { valor } : {}), destino: n === 0 || clave === '__otros' ? NINGUNO : destino(conjunto, [{ dimension, valores: [clave] }]) };
}
function tabla(titulo: string, conjunto: string, dimension: string, filas: ReturnType<typeof fila>[], conValor: boolean, foto: boolean, valorTotal?: number | null) {
  return {
    titulo, dimension, conjunto, definicion: `Definición de ${conjunto}.`, conValor, filas,
    total: { clave: null, etiqueta: 'Total', n: filas.reduce((a, f) => a + f.n, 0), ...(conValor ? { valor: valorTotal ?? null } : {}), destino: destino(conjunto) },
    filtrosIgnorados: foto ? ['rango'] : [],
  };
}
const META = { rango: { desde: '2026-11-01', hasta: '2026-11-19' }, generadoEn: '2026-11-19T12:00:00.000Z' };

function logistica(vacio = false) {
  return {
    ...META, dineroVisible: true,
    traslados: {
      cifras: { abiertos: vacio ? 0 : 58, abiertosMasDeN: vacio ? 0 : 6 }, umbralDias: 3,
      rutasAbiertas: [{ origen: 'sede', destino: 'ot', etiqueta: 'Sede → OT', n: 40 }],
      explicaciones: {
        abiertos: kpi('58 traslados siguen abiertos hoy.', 'traslados_por_estado', [{ dimension: 'estado', valores: ['registrado', 'en_ruta'] }], { desglose: [{ etiqueta: 'Sede → OT', valor: 40 }] }),
        abiertosMasDeN: kpi('6 traslados llevan abiertos más de 3 días.', 'traslados_abiertos_mas_de_n', [], {
          desglose: [{ etiqueta: 'Más de 6 días', valor: 2, destino: destino('traslados_abiertos_mas_de_n', [{ dimension: 'severidad', valores: ['critico'] }]) }],
        }),
      },
      tablas: vacio ? [tabla('Traslados por estado', 'traslados_por_estado', 'estado', [], false, true)] : [tabla('Traslados por estado', 'traslados_por_estado', 'estado', [
        fila('registrado', 'Registrado', 31, 'traslados_por_estado', 'estado'),
        fila('en_ruta', 'En camino', 27, 'traslados_por_estado', 'estado'),
        fila('recibido', 'Recibido', 0, 'traslados_por_estado', 'estado'),
      ], false, true)],
    },
    entregas: {
      cifras: { pendientesEntrega: 23, entregasPeriodo: 240, primerIntento: 221, primerIntentoPct: 92.1, devueltasPeriodo: 12, viajesAdicionales: 26, tramitesConViajes: 19 },
      explicaciones: {
        pendientesEntrega: kpi('23 actas siguen pendientes de entrega hoy.', 'actas_pendientes_entrega'),
        primerIntento: kpi('De las 240 entregas del periodo, 221 se hicieron al primer intento; 19 necesitaron otro viaje.', 'entregas_logistica', [{ dimension: 'nivel', valores: ['primer_intento'] }], {
          desglose: [{ etiqueta: 'Con otro viaje', valor: 19, destino: destino('entregas_logistica', [{ dimension: 'nivel', valores: ['con_viajes'] }]) }],
        }),
        devueltasPeriodo: kpi('12 actas volvieron sin entregarse en el periodo.', 'actas_devueltas_periodo'),
        viajesAdicionales: kpi('26 viajes adicionales en el periodo, en 19 trámites.', 'viajes_adicionales_periodo'),
      },
      tablas: [tabla('Devueltas en el periodo, por motivo', 'actas_devueltas_periodo', 'motivo', [
        fila(MOTIVO, 'Destinatario ausente', 5, 'actas_devueltas_periodo', 'motivo'),
        fila('__otros', 'Otros', 7, 'actas_devueltas_periodo', 'motivo'),
      ], false, false)],
    },
  };
}

function facturacion(dinero: boolean) {
  return {
    ...META, dineroVisible: dinero,
    cifras: { sinFacturar: 63, sinFacturarValor: dinero ? 48_000_000 : null, conError: 9, rechazadasDian: 0, colaAtascada: 5, facturadasPeriodo: 180, facturadoValor: dinero ? 212_000_000 : null },
    explicaciones: {
      sinFacturar: kpi('63 trámites aprobados sin factura.', 'sin_facturar'),
      conError: kpi('9 facturas tienen un error de Siigo o quedaron para revisión.', 'facturas_con_error'),
      rechazadasDian: kpi('Ninguna factura está rechazada por la DIAN.', 'facturas_rechazadas_dian'),
      colaAtascada: kpi('5 trámites esperan en la cola de facturación.', 'cola_facturacion_atascada', [], {
        desglose: [
          { etiqueta: 'Reintento vencido', valor: 3, destino: destino('cola_facturacion_atascada', [{ dimension: 'estado', valores: ['vencido'] }]) },
          { etiqueta: 'Intentos agotados', valor: 2, destino: destino('cola_facturacion_atascada', [{ dimension: 'estado', valores: ['agotado'] }]) },
        ],
      }),
      facturadasPeriodo: kpi(dinero ? 'En el periodo se facturaron $ 212.000.000 en 180 facturas.' : 'En el periodo se emitieron 180 facturas.', 'facturado_periodo'),
    },
    tablas: [tabla('Sin facturar por compañía', 'sin_facturar', 'compania', [
      fila('1', 'Compañía Demo A', 31, 'sin_facturar', 'compania', dinero ? 24_100_000 : null),
      fila('2', 'Compañía Demo B', 32, 'sin_facturar', 'compania', dinero ? 23_900_000 : null),
    ], true, false, dinero ? 48_000_000 : null)],
  };
}

function bolsas(dinero: boolean, sinBolsas = false) {
  const filaB = (bolsaId: string, compania: string, saldo: number, consumo: number, dias: number | null, severidad: string, movimientos: number) => ({
    bolsaId, companiaId: 1, compania, saldo: dinero ? saldo : null, consumoDiario: dinero ? consumo : null, diasCobertura: dias, severidad, movimientos,
    destino: movimientos ? destino('movimientos_bolsa_periodo', [{ dimension: 'bolsa', valores: [bolsaId] }]) : NINGUNO,
  });
  return {
    ...META, dineroVisible: dinero,
    cifras: {
      activas: sinBolsas ? 0 : 14, enCritico: 3, enAtencion: 2, criticasConSaldo: 2, agotadas: 1, movimientosPeriodo: 412, recargas: 50, consumos: 362,
      recargasValor: null, consumosValor: null, boletasSinConciliar: 17, boletasConDiferencia: 4,
    },
    explicaciones: {
      enCritico: kpi('3 bolsas alcanzan para menos de 5 días al ritmo de los últimos 30.', 'bolsas_cobertura', [{ dimension: 'severidad', valores: ['critico'] }], {
        desglose: [{ etiqueta: 'En atención', valor: 2, destino: destino('bolsas_cobertura', [{ dimension: 'severidad', valores: ['atencion'] }]) }],
      }),
      agotadas: kpi('1 bolsa activa está sin saldo.', 'bolsas_agotadas'),
      movimientosPeriodo: kpi('412 movimientos de bolsa en el periodo.', 'movimientos_bolsa_periodo'),
      boletasSinConciliar: kpi('17 boletas de pago al organismo aún no se cruzan con sus trámites.', 'boletas_sin_conciliar'),
      boletasConDiferencia: kpi('4 boletas tienen diferencia entre el total declarado y el cruzado.', 'boletas_con_diferencia'),
    },
    cobertura: {
      filtrosIgnorados: ['rango'], umbralCriticoDias: 5, umbralAtencionDias: 10,
      filas: sinBolsas ? [] : [filaB(BOLSA_A, 'Compañía Demo A', 2_800_000, 1_400_000, 2, 'critico', 38), filaB(BOLSA_B, 'Compañía Demo B', 9_000_000, 0, null, 'ok', 0)],
    },
  };
}

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mockBase(page: Pagina, op: { dinero?: boolean; falla?: () => boolean; vacio?: boolean; lento?: Promise<void> } = {}) {
  const dinero = op.dinero ?? true;
  await page.route('**/api/flito/torre/opciones', (r) => r.fulfill(json(OPCIONES)));
  const servir = (cuerpo: () => unknown) => async (route: Parameters<Parameters<Pagina['route']>[1]>[0]) => {
    if (op.lento) await op.lento;
    if (op.falla?.()) { await route.fulfill(json({ error: 'SIIGO_ERROR', detalle: 'stack crudo' }, 500)); return; }
    await route.fulfill(json(cuerpo()));
  };
  // El Resumen de Financiera no es de este bloque (lo cubre flito-torre-tableros): aquí responde error y queda en su estado.
  await page.route('**/api/flito/torre/tableros/financiera', (r) => r.fulfill(json({ error: 'TORRE_ERROR' }, 500)));
  await page.route('**/api/flito/torre/tableros/logistica', servir(() => logistica(op.vacio)));
  await page.route('**/api/flito/torre/tableros/financiera/facturacion', servir(() => facturacion(dinero)));
  await page.route('**/api/flito/torre/tableros/financiera/bolsas', servir(() => bolsas(dinero, op.vacio)));
  await page.route('**/api/flito/torre/detalle/consultar', (r) => r.fulfill(json({
    origen: { tipo: 'conjunto', conjunto: 'traslados_por_estado' }, segmentos: [],
    definicion: { etiqueta: 'Lista', definicion: 'Lista.', fechaBase: null, campoFecha: 'creado_en' },
    frase: '0 registros.', fraseVacio: 'Sin registros.', total: 0, valorTotal: null, columnas: [], filas: [], pagina: 1, tamano: 25,
    truncado: false, filtrosIgnorados: [], rango: null, dineroVisible: true, generadoEn: META.generadoEn,
  })));
}

const q = (page: Pagina) => new URL(page.url()).searchParams;
const kpis = (page: Pagina) => page.locator('[data-torre="kpi-explicable"]');
const lleno = (page: Pagina) => expect(page.locator('[data-torre="tablero"]')).toHaveAttribute('data-estado', 'lleno');

test.describe('Torre de Control · Logística y Financiera por pestañas (Épica #14590, B4)', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('Logística: pestañas en la URL; KPI, desglose y fila abren su lista; «Volver» regresa a la pestaña', async ({ page }) => {
    await loginAs(page, GERENCIA);
    await mockBase(page);
    await page.goto('/flito/torre/logistica');
    await expect(page.getByRole('navigation', { name: 'Páginas de la Torre de Control' }).getByRole('link', { name: 'Logística' })).toBeVisible();
    const tabs = page.getByRole('tablist', { name: 'Logística' });
    await expect(tabs.getByRole('tab')).toHaveText(['Traslados', 'Entregas']);
    await lleno(page);
    await expect(page.locator('[data-torre="frase-guia"]')).toHaveText('58 traslados abiertos hoy; 6 llevan más de 3 días.');
    await expect(kpis(page)).toHaveCount(2);

    await kpis(page).filter({ hasText: 'Traslados abiertos' }).getByRole('link', { name: /Ver los 58/ }).click();
    expect(q(page).get('c')).toBe('traslados_por_estado');
    expect(q(page).get('s')).toBe('estado:registrado,en_ruta');
    expect(q(page).get('o')).toBe('logistica');
    await page.locator('[data-torre="volver"]').click();
    await expect(page).toHaveURL(/\/flito\/torre\/logistica$/);

    // Desglose con su propio enlace; n = 0 en la tabla sin enlace.
    await page.getByRole('link', { name: /traslados abiertos hace demasiado, más de 6 días/ }).click();
    expect(q(page).get('c')).toBe('traslados_abiertos_mas_de_n');
    expect(q(page).get('s')).toBe('severidad:critico');
    await page.goBack();
    await expect(page.locator('[data-torre="tabla-principal"] tbody tr').filter({ hasText: 'Recibido' }).getByRole('link')).toHaveCount(0);

    await tabs.getByRole('tab', { name: 'Entregas' }).click();
    await expect(page).toHaveURL(/\?vista=entregas$/);
    await expect(kpis(page)).toHaveCount(4);
    await expect(kpis(page).filter({ hasText: 'Entregas al primer intento' })).toContainText('92,1 %');
    await kpis(page).filter({ hasText: 'Entregas al primer intento' }).getByRole('link', { name: 'Ver las 19 con reintento' }).click();
    expect(q(page).get('c')).toBe('entregas_logistica');
    expect(q(page).get('s')).toBe('nivel:con_viajes');
    expect(q(page).get('ov')).toBe('entregas');
    await page.locator('[data-torre="volver"]').click();
    await expect(page).toHaveURL(/\/flito\/torre\/logistica\?vista=entregas$/);

    const devueltas = page.locator('[data-torre="tabla-principal"]');
    await expect(devueltas.locator('tbody tr').filter({ hasText: 'Otros' }).getByRole('link')).toHaveCount(0);
    await devueltas.getByRole('link', { name: /Ver las 5: .*Destinatario ausente/ }).click();
    expect(q(page).get('s')).toBe(`motivo:${MOTIVO}`);
    expect(decodeURIComponent(page.url())).not.toContain('Destinatario');
  });

  test('Financiera: Facturación con frase guía, desglose de la cola y fila por compañía; Excel de la subvista activa', async ({ page }) => {
    await loginAs(page, GERENCIA);
    await mockBase(page);
    const exportados: string[] = [];
    await page.route('**/api/flito/torre/tableros/**/exportar', async (r) => {
      exportados.push(new URL(r.request().url()).pathname);
      await r.fulfill({ status: 200, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: 'xlsx' });
    });
    await page.goto('/flito/torre/financiera?vista=facturacion');
    const tabs = page.getByRole('tablist', { name: 'Subvistas de Financiera' });
    await expect(tabs.getByRole('tab')).toHaveText(['Resumen', 'Facturación', 'Bolsas']);
    await expect(tabs.getByRole('tab', { name: 'Facturación' })).toHaveAttribute('aria-selected', 'true');
    await lleno(page);
    await expect(page.locator('[data-torre="frase-guia"]')).toContainText('En el periodo se facturaron $ 212.000.000 en 180 facturas.');
    await expect(page.locator('body')).not.toContainText('cartera');
    await expect(kpis(page).filter({ hasText: 'Rechazadas por la DIAN' }).locator('[data-torre="ver-registros"]')).toHaveCount(0);

    await page.locator('[data-torre="exportar-tablero"]').click();
    await expect.poll(() => exportados.at(-1)).toBe('/api/flito/torre/tableros/financiera/facturacion/exportar');

    await expect(page.locator('[data-torre="tabla-principal"] thead th')).toHaveText(['Compañía', 'Trámites sin facturar', 'Valor', 'Registros']);
    await page.getByRole('link', { name: /cola de facturación detenida, intentos agotados/ }).click();
    expect(q(page).get('c')).toBe('cola_facturacion_atascada');
    expect(q(page).get('s')).toBe('estado:agotado');
    expect(q(page).get('ov')).toBe('facturacion');
    await page.locator('[data-torre="volver"]').click();
    await expect(page).toHaveURL(/\/flito\/torre\/financiera\?vista=facturacion$/);

    await page.locator('[data-torre="frase-guia"]').getByRole('link', { name: /Ver las 180/ }).click();
    expect(q(page).get('c')).toBe('facturado_periodo');
    await page.goBack();
    await page.locator('[data-torre="tabla-principal"]').getByRole('link', { name: /Compañía Demo A/ }).click();
    expect(q(page).get('s')).toBe('compania:1');
  });

  test('Financiera: Bolsas con semáforo con texto, «Ver los N movimientos» con bolsa:<uuid> y conciliación de boletas', async ({ page }) => {
    await loginAs(page, GERENCIA);
    await mockBase(page);
    await page.goto('/flito/torre/financiera');
    await page.getByRole('tab', { name: 'Bolsas' }).click();
    await expect(page).toHaveURL(/\?vista=bolsas$/);
    await lleno(page);
    await expect(page.locator('[data-torre="frase-guia"]')).toHaveText('3 bolsas en crítico y 2 en atención, de 14 activas.');
    const cobertura = page.locator('[data-torre="tabla-principal"]');
    await expect(cobertura.locator('thead th')).toHaveText(['Compañía', 'Saldo', 'Consumo diario (30 días)', 'Días de cobertura', 'Semáforo', 'Movimientos']);
    await expect(cobertura.locator('tbody tr').first()).toContainText('Crítico');
    await expect(cobertura.locator('tbody tr').nth(1)).toContainText('Al día');
    await expect(cobertura.locator('tbody tr').nth(1)).toContainText('Sin consumo');
    await expect(cobertura.locator('tbody tr').nth(1).getByRole('link')).toHaveCount(0);

    const boletas = page.locator('[data-torre="bloque-boletas"]');
    await expect(boletas).toContainText('17 boletas de pago al organismo');
    await boletas.getByRole('link', { name: /Ver las 4/ }).click();
    expect(q(page).get('c')).toBe('boletas_con_diferencia');
    expect(q(page).get('ov')).toBe('bolsas');
    await page.goBack();

    await cobertura.getByRole('link', { name: 'Ver los 38 movimientos: movimientos de la bolsa de Compañía Demo A' }).click();
    expect(q(page).get('c')).toBe('movimientos_bolsa_periodo');
    expect(q(page).get('s')).toBe(`bolsa:${BOLSA_A}`);
    await expect(page.locator('[data-torre="detalle"]')).not.toHaveAttribute('data-estado', 'invalido');
    await page.locator('[data-torre="volver"]').click();
    await expect(page).toHaveURL(/\/flito\/torre\/financiera\?vista=bolsas$/);
  });

  test('sin permiso de dinero no hay columnas de valor (facturación ni bolsas)', async ({ page }) => {
    await loginAs(page, SIN_DINERO);
    await mockBase(page, { dinero: false });
    await page.goto('/flito/torre/financiera?vista=facturacion');
    await lleno(page);
    await expect(page.locator('[data-torre="tabla-principal"] thead th')).toHaveText(['Compañía', 'Trámites sin facturar', 'Registros']);
    await expect(page.locator('[data-torre="frase-guia"]')).toContainText('En el periodo se emitieron 180 facturas.');
    await page.getByRole('tab', { name: 'Bolsas' }).click();
    await lleno(page);
    await expect(page.locator('[data-torre="tabla-principal"] thead th')).toHaveText(['Compañía', 'Días de cobertura', 'Semáforo', 'Movimientos']);
  });

  test('sin torre_logistica la pestaña no aparece en la Torre y la ruta no abre', async ({ page }) => {
    await loginAs(page, SIN_LOGISTICA);
    await mockBase(page);
    await page.goto('/flito/torre/financiera?vista=bolsas');
    await lleno(page);
    const torre = page.getByRole('navigation', { name: 'Páginas de la Torre de Control' });
    await expect(torre.getByRole('link', { name: 'Financiera' })).toBeVisible();
    await expect(torre.getByRole('link', { name: 'Logística' })).toHaveCount(0);
    await page.goto('/flito/torre/logistica');
    await expect(page.getByRole('heading', { level: 1, name: 'Logística' })).toHaveCount(0);
  });

  for (const [ruta, error] of [
    ['/flito/torre/logistica', 'No pudimos cargar los traslados. Intente de nuevo.'],
    ['/flito/torre/logistica?vista=entregas', 'No pudimos cargar las entregas. Intente de nuevo.'],
    ['/flito/torre/financiera?vista=facturacion', 'No pudimos cargar la facturación. Intente de nuevo.'],
    ['/flito/torre/financiera?vista=bolsas', 'No pudimos cargar las bolsas. Intente de nuevo.'],
  ] as const) {
    test(`cargando, error con reintento y lleno: ${ruta}`, async ({ page }) => {
      await loginAs(page, GERENCIA);
      let soltar = () => {};
      const lento = new Promise<void>((r) => { soltar = r; });
      let fallar = true;
      await mockBase(page, { lento, falla: () => fallar });
      await page.goto(ruta);
      await expect(page.locator('[data-torre="tablero"]')).toHaveAttribute('data-estado', 'cargando');
      soltar();
      await expect(page.locator('[data-torre="tablero"]')).toHaveAttribute('data-estado', 'error');
      await expect(page.getByText(error)).toBeVisible();
      await expect(page.locator('body')).not.toContainText('stack crudo');
      await expect(page.locator('[data-torre="exportar-tablero"]')).toBeDisabled();
      fallar = false;
      await page.getByRole('button', { name: /Reintentar/ }).click();
      await lleno(page);
    });
  }

  test('vacíos: Traslados con su siguiente paso; Bolsas sin bolsas activas sigue mostrando las boletas', async ({ page }) => {
    await loginAs(page, GERENCIA);
    await mockBase(page, { vacio: true });
    await page.goto('/flito/torre/logistica');
    await expect(page.locator('[data-torre="tablero"]')).toHaveAttribute('data-estado', 'vacio');
    await expect(page.getByText('No hay traslados registrados con estos filtros.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Limpiar filtros' })).toBeVisible();
    await page.goto('/flito/torre/financiera?vista=bolsas');
    await expect(page.locator('[data-torre="tablero"]')).toHaveAttribute('data-estado', 'vacio');
    await expect(page.getByText('No hay bolsas activas con estos filtros.')).toBeVisible();
    await expect(page.locator('[data-torre="bloque-boletas"]')).toContainText('17 boletas');
  });
});
