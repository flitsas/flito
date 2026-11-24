// Torre de Control (Épica #14590, bloque B6) — «Para hoy» y «Lo que cambió en el periodo» en el Resumen 360°.
// Cubre (UI): «Para hoy» va primero, en el orden del API, con gravedad en texto, cifra y frase; cada «Ver los N» abre el
// detalle con conjunto y segmentos (sin facturar con `p=mes`); «Revisar» de la caída de clientes lleva a Comercial con
// foco en su bloque; con más de 8 frentes, el resto tras un disclosure con `aria-expanded`; vacío; error con reintento
// sin el error crudo; los hallazgos con su «Ver en <área>»; «Los 5 riesgos de hoy» ya no aparece.
import { test, expect } from '../helpers/fixtures';
import { loginAs, type UsuarioFixture } from '../helpers/auth';

type Pagina = Parameters<typeof loginAs>[0];

const GERENCIA: UsuarioFixture = {
  id: 771, username: 'e2e_gerencia_parahoy', name: 'Gerencia General E2E', role: 'gerencia_general',
  allowedPages: ['torre_360', 'torre_comercial', 'torre_operativa', 'torre_financiera', 'torre_productos', 'torre_logistica', 'torre_explorador', 'torre_detalle'],
  funciones: [
    'torre.metricas.consultar', 'torre.placa.buscar', 'torre.metricas.dinero', 'torre.tablero_ejecutivo.ver', 'torre.tablero_comercial.ver',
    'torre.tablero_operativo.ver', 'torre.tablero_financiero.ver', 'torre.tablero_productos.ver', 'torre.detalle.ver', 'perfil.datos.ver',
  ],
};
const OPCIONES = {
  companias: [{ id: 1, nombre: 'Compañía Demo A' }], organismos: [{ codigo: '05001', nombre: 'OT Demo Norte' }],
  tiposTramite: [{ valor: 'TRASPASO', etiqueta: 'Traspaso' }], flitEstados: [{ valor: 'borrador', etiqueta: 'Borrador' }],
};
type Seg = { dimension: string; valores: (string | null)[] };
const destino = (conjunto: string, segmentos: Seg[] = []) => ({ tipo: 'conjunto', origen: { tipo: 'conjunto', conjunto }, segmentos });
const frente = (conjunto: string, cifra: number, frase: string, severidad: 'critico' | 'atencion', segmentos: Seg[] = [], mes = false) => ({
  clave: conjunto, conjunto, cifra, frase, severidad, accion: 'ver', destino: destino(conjunto, segmentos), rango: mes ? { preset: 'mes' } : null,
});
const FUGA = {
  clave: 'fuga', conjunto: null, cifra: 3, frase: 'compañías crearon al menos 30 % menos trámites que su promedio.', severidad: 'atencion',
  accion: 'revisar', destino: { tipo: 'bloque', bloque: 'fuga' }, rango: null,
};
const SEIS = [
  frente('soat_sin_gestion', 14, 'gestiones de SOAT e impuestos llevan más de 48 horas sin soporte.', 'critico'),
  frente('bolsas_cobertura', 3, 'bolsas alcanzan para menos de 5 días; la más baja, Compañía Demo A.', 'critico', [{ dimension: 'severidad', valores: ['critico'] }]),
  frente('borrador_abandonado', 12, 'trámites llevan más de 7 días en Borrador.', 'atencion'),
  frente('estancado_ot', 41, 'trámites llevan en el organismo más de 10 días.', 'atencion'),
  frente('sin_facturar', 63, 'trámites aprobados este mes aún no tienen factura ($ 48 M).', 'atencion', [], true),
  FUGA,
];
const ONCE = [
  ...SEIS,
  frente('soat_por_vencer', 27, 'SOAT vencen en los próximos 30 días.', 'atencion'),
  frente('actas_pendientes_entrega', 23, 'actas siguen pendientes de entrega.', 'atencion'),
  frente('facturas_con_error', 9, 'facturas tienen un error de Siigo o están en revisión.', 'atencion'),
  frente('impuestos_con_diferencia', 8, 'impuestos tienen diferencia entre lo liquidado y lo pagado.', 'atencion'),
  frente('boletas_con_diferencia', 4, 'boletas de pago al organismo tienen diferencia con lo cruzado.', 'atencion'),
];
const HALLAZGOS = [
  { regla: 'H1', frase: 'Se crearon 1.240 trámites, 7 % más que en el periodo anterior (1.155).', area: 'comercial' },
  { regla: 'H5', frase: 'Las entregas al primer intento bajaron de 95 % a 92 %.', area: 'logistica', vista: 'entregas' },
];

function ejecutivo(paraHoy: unknown[], hallazgos: unknown[] = HALLAZGOS) {
  return {
    rango: { desde: '2026-11-01', hasta: '2026-11-19' }, dineroVisible: true, generadoEn: '2026-11-19T12:00:00.000Z',
    comercial: { tramitesMes: 1240, clientesEnCaida: 3 }, operativo: { pctDentroAns: 88, umbralDias: 10 },
    financiero: { margenPct: 21, sinFacturarValor: 48_000_000 },
    proyeccion: { diasMes: 30, diasTranscurridos: 19, acumulado: [{ dia: 1, valor: 40 }, { dia: 19, valor: 900 }], mesAnterior: [{ dia: 1, valor: 30 }], proyeccionCierre: 1420, totalMesAnterior: 1300, variacionPct: 9, meta: null },
    riesgos: [{ area: 'comercial', frase: 'Riesgo viejo que ya no se pinta', umbral: 'x', severidad: 'critico' }],
    paraHoy, hallazgos, explicaciones: {},
  };
}
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mockBase(page: Pagina, op: { paraHoy?: unknown[]; hallazgos?: unknown[]; falla?: () => boolean; lento?: Promise<void> } = {}) {
  await page.route('**/api/flito/torre/opciones', (r) => r.fulfill(json(OPCIONES)));
  await page.route('**/api/flito/torre/tableros/ejecutivo', async (route) => {
    if (op.lento) await op.lento;
    if (op.falla?.()) { await route.fulfill(json({ error: 'TORRE_ERROR', detalle: 'stack crudo' }, 500)); return; }
    await route.fulfill(json(ejecutivo(op.paraHoy ?? SEIS, op.hallazgos)));
  });
  // Los otros tableros no son de este bloque: responden error y quedan en su estado.
  await page.route('**/api/flito/torre/tableros/comercial', (r) => r.fulfill(json({ error: 'x' }, 500)));
  await page.route('**/api/flito/torre/tableros/logistica', (r) => r.fulfill(json({ error: 'x' }, 500)));
  await page.route('**/api/flito/torre/detalle/consultar', (r) => r.fulfill(json({
    origen: { tipo: 'conjunto', conjunto: 'sin_facturar' }, segmentos: [],
    definicion: { etiqueta: 'Lista', definicion: 'Lista.', fechaBase: null, campoFecha: 'creado_en' },
    frase: '0 registros.', fraseVacio: 'Sin registros.', total: 0, valorTotal: null, columnas: [], filas: [], pagina: 1, tamano: 25,
    truncado: false, filtrosIgnorados: [], rango: null, dineroVisible: true, generadoEn: '2026-11-19T12:00:00.000Z',
  })));
}

const bloque = (page: Pagina) => page.locator('[data-torre="bloque-para-hoy"]');
const q = (page: Pagina) => new URL(page.url()).searchParams;

test.describe('Torre de Control · Resumen 360° › «Para hoy» y hallazgos (Épica #14590, B6)', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('lleno con 6 frentes en su orden, primero en el 360°, sin «Los 5 riesgos de hoy»', async ({ page }) => {
    await loginAs(page, GERENCIA);
    await mockBase(page);
    await page.goto('/flito/torre/resumen');
    await expect(page.locator('[data-torre="tablero"]')).toHaveAttribute('data-estado', 'lleno');
    await expect(bloque(page).getByRole('heading', { level: 2 })).toHaveText('Para hoy: hay 6 frentes por atender');
    const filas = bloque(page).locator('[data-torre="frente"]');
    await expect(filas).toHaveCount(6);
    expect(await filas.evaluateAll((els) => els.map((e) => e.getAttribute('data-clave'))))
      .toEqual(['soat_sin_gestion', 'bolsas_cobertura', 'borrador_abandonado', 'estancado_ot', 'sin_facturar', 'fuga']);
    await expect(filas.first()).toContainText('Crítico');
    await expect(filas.nth(2)).toContainText('Atención');
    await expect(filas.nth(2)).toContainText('12');
    // «Para hoy» antes de las tarjetas de área.
    // «Para hoy» primero; «Lo que cambió en el periodo» después de las tarjetas y antes de la proyección.
    const y = async (sel: string) => (await page.locator(sel).first().boundingBox())!.y;
    const yParaHoy = await y('[data-torre="bloque-para-hoy"]');
    const yTarjetas = await y('text=Comercial · trámites del mes');
    const yHallazgos = await y('[data-torre="bloque-hallazgos"]');
    expect(yParaHoy).toBeLessThan(yTarjetas);
    expect(yTarjetas).toBeLessThan(yHallazgos);
    expect(yHallazgos).toBeLessThan(await y('[data-torre="bloque-proyeccion"]'));
    await expect(page.getByText('Los 5 riesgos de hoy')).toHaveCount(0);
    await expect(page.getByText('Riesgo viejo que ya no se pinta')).toHaveCount(0);
    await expect(bloque(page).locator('[data-torre="frentes-restantes"]')).toHaveCount(0);
  });

  test('cada «Ver los N» abre su detalle (sin facturar con p=mes) y «Revisar» lleva a Comercial al bloque de caídas', async ({ page }) => {
    await loginAs(page, GERENCIA);
    await mockBase(page);
    await page.goto('/flito/torre/resumen');
    await bloque(page).getByRole('link', { name: /^Ver las 3: bolsas alcanzan/ }).click();
    expect(q(page).get('c')).toBe('bolsas_cobertura');
    expect(q(page).get('s')).toBe('severidad:critico');
    expect(q(page).get('o')).toBe('360');
    expect(q(page).get('p')).toBeNull();
    await page.goBack();
    await bloque(page).getByRole('link', { name: /^Ver los 63: trámites aprobados/ }).click();
    expect(q(page).get('c')).toBe('sin_facturar');
    expect(q(page).get('p')).toBe('mes');
    await page.goBack();
    await bloque(page).getByRole('link', { name: /^Revisar:/ }).click();
    await expect(page).toHaveURL(/\/flito\/torre\/comercial#bloque-caidas$/);
  });

  test('con más de 8 frentes, el resto va tras «Ver los N frentes restantes» con aria-expanded', async ({ page }) => {
    await loginAs(page, GERENCIA);
    await mockBase(page, { paraHoy: ONCE });
    await page.goto('/flito/torre/resumen');
    await expect(bloque(page).getByRole('heading', { level: 2 })).toHaveText('Para hoy: hay 11 frentes por atender');
    await expect(bloque(page).locator('[data-torre="frente"]')).toHaveCount(8);
    const boton = bloque(page).getByRole('button', { name: /Ver los 3 frentes restantes/ });
    await expect(boton).toHaveAttribute('aria-expanded', 'false');
    await boton.click();
    await expect(bloque(page).getByRole('button', { name: /Ver menos frentes/ })).toHaveAttribute('aria-expanded', 'true');
    await expect(bloque(page).locator('[data-torre="frente"]')).toHaveCount(11);
    await expect(bloque(page).getByRole('link', { name: /^Ver las 4: boletas/ })).toBeVisible();
  });

  test('un solo frente en singular; vacío con su línea; sin hallazgos no hay tarjeta', async ({ page }) => {
    await loginAs(page, GERENCIA);
    await mockBase(page, { paraHoy: [SEIS[2]], hallazgos: [] });
    await page.goto('/flito/torre/resumen');
    await expect(bloque(page).getByRole('heading', { level: 2 })).toHaveText('Para hoy: hay 1 frente por atender');
    await expect(page.locator('[data-torre="bloque-hallazgos"]')).toHaveCount(0);
    await page.unroute('**/api/flito/torre/tableros/ejecutivo');
    await page.route('**/api/flito/torre/tableros/ejecutivo', (r) => r.fulfill(json(ejecutivo([]))));
    await page.reload();
    await expect(bloque(page).getByRole('heading', { level: 2 })).toHaveText('Para hoy: nada por atender');
    await expect(bloque(page)).toContainText('Hoy ninguna cifra pasa su umbral. Las cifras de cada área siguen en sus pestañas.');
  });

  test('hallazgos con su «Ver en <área>» (y su subvista)', async ({ page }) => {
    await loginAs(page, GERENCIA);
    await mockBase(page);
    await page.goto('/flito/torre/resumen');
    const h = page.locator('[data-torre="bloque-hallazgos"]');
    await expect(h.getByRole('heading', { level: 2 })).toHaveText('Lo que cambió en el periodo');
    await expect(h.locator('[data-torre="hallazgo"]')).toHaveCount(2);
    await expect(h.getByRole('link', { name: /Ver en Comercial/ })).toHaveAttribute('href', '/flito/torre/comercial');
    await h.getByRole('link', { name: /Ver en Logística/ }).click();
    await expect(page).toHaveURL(/\/flito\/torre\/logistica\?vista=entregas$/);
  });

  test('cargando con la estructura de «Para hoy», error con reintento (sin el error crudo) y lleno', async ({ page }) => {
    await loginAs(page, GERENCIA);
    let soltar = () => {};
    const lento = new Promise<void>((r) => { soltar = r; });
    let fallar = true;
    await mockBase(page, { lento, falla: () => fallar });
    await page.goto('/flito/torre/resumen');
    await expect(page.locator('[data-torre="tablero"]')).toHaveAttribute('data-estado', 'cargando');
    await expect(page.locator('[data-torre="bloque-para-hoy"][data-estado="cargando"] li')).toHaveCount(4);
    soltar();
    await expect(page.locator('[data-torre="tablero"]')).toHaveAttribute('data-estado', 'error');
    await expect(page.locator('body')).not.toContainText('stack crudo');
    fallar = false;
    await page.getByRole('button', { name: /Reintentar/ }).click();
    await expect(page.locator('[data-torre="tablero"]')).toHaveAttribute('data-estado', 'lleno');
  });
});
