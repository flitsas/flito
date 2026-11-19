// Torre de Control (Épica #14590, ADR-0047, bloque B1b) — Detalle universal y KPI que se explican.
// Cubre: «Ver los 12 borradores» abre el detalle con N filas = N de la tarjeta (AC4); «¿Cómo se calcula?» por teclado
// (AC3); filtrar por placa sin que la placa toque la URL ni el sessionStorage (AC7); «Descargar Excel» (AC8 en la web);
// los 4 estados + vacío por filtros + conjunto inválido (AC14); el Explorador abre «Ver registros» por fila (AC12) y el
// radar abre su conjunto (AC13). Backend mockeado con `page.route` (el fixture base responde `200 []` a lo no mockeado).
// Spec UX: docs/ux/flito-torre-detalle-universal.md §4, §5, §8.
import { test, expect } from '../helpers/fixtures';
import { loginAs, type UsuarioFixture } from '../helpers/auth';

type Pagina = Parameters<typeof loginAs>[0];
type CuerpoDetalle = {
  origen: { tipo: string; conjunto?: string; metrica?: string; fechaBase?: string };
  segmentos?: { dimension: string; valores: (string | null)[] }[];
  filtro: unknown; filtrosDetalle?: { placa?: string; estados?: string[] };
  orden?: { columna: string; dir: string }; pagina?: number; tamano?: number;
};

const GERENCIA: UsuarioFixture = {
  id: 711, username: 'e2e_gerencia_det', name: 'Gerencia General E2E', role: 'gerencia_general',
  allowedPages: ['torre_360', 'torre_comercial', 'torre_operativa', 'torre_financiera', 'torre_explorador', 'torre_detalle'],
  funciones: [
    'torre.metricas.consultar', 'torre.metricas.exportar', 'torre.placa.buscar', 'torre.metricas.dinero',
    'torre.tablero_ejecutivo.ver', 'torre.tablero_comercial.ver', 'torre.tablero_operativo.ver', 'torre.tablero_financiero.ver',
    'torre.detalle.ver', 'torre.detalle.exportar', 'perfil.datos.ver',
  ],
};
const SIN_DETALLE: UsuarioFixture = {
  ...GERENCIA,
  allowedPages: GERENCIA.allowedPages!.filter((p) => p !== 'torre_detalle'),
  funciones: GERENCIA.funciones!.filter((f) => !f.startsWith('torre.detalle.')),
};

const OPCIONES = {
  companias: [{ id: 1, nombre: 'Compañía Demo A' }, { id: 2, nombre: 'Compañía Demo B' }],
  organismos: [{ codigo: '05001', nombre: 'OT Demo Norte' }],
  tiposTramite: [{ valor: 'TRASPASO', etiqueta: 'Traspaso' }],
  flitEstados: [{ valor: 'borrador', etiqueta: 'Borrador' }, { valor: 'aprobado', etiqueta: 'Aprobado' }],
};
const META = { filtrosIgnorados: ['rango'] as string[] };
const DEF_BORRADOR = 'Trámites en estado Borrador que llevan más de 7 días en ese estado. El umbral se cambia en Umbrales y alertas.';
const aConjunto = (conjunto: string, segmentos?: unknown[]) =>
  ({ tipo: 'conjunto', origen: { tipo: 'conjunto', conjunto }, ...(segmentos ? { segmentos } : {}) });

const OPERATIVO = {
  rango: { desde: '2026-11-01', hasta: '2026-11-19' }, dineroVisible: true, generadoEn: '2026-11-19T12:00:00.000Z',
  cifras: { sinGestionFueraAns: 0, borradoresAbandonados: 12, wip: 0, primerIntentoPct: null },
  explicaciones: {
    sinGestionFueraAns: { frase: 'Todas las gestiones de SOAT e impuestos tienen soporte dentro de 48 horas.', definicion: 'Gestiones sin soporte 48 horas después.', destino: { tipo: 'ninguno' } },
    borradoresAbandonados: {
      frase: '12 trámites llevan más de 7 días en Borrador; 4 pasan de 14 días.', definicion: DEF_BORRADOR,
      destino: aConjunto('borrador_abandonado'),
    },
    // Destino de conjunto con cifra 0: la tarjeta NO debe ofrecer «Ver» (lo decide la cifra, no el destino).
    wip: { frase: 'No hay trámites en curso.', definicion: 'Trámites en un estado de trabajo activo.', destino: aConjunto('en_curso') },
    primerIntentoPct: { frase: 'No hubo entregas en el periodo.', definicion: 'Aprobados con logística cobrada.', destino: { tipo: 'ninguno' } },
  },
  radar: {
    ...META,
    filas: [
      { causa: 'borrador_abandonado', etiqueta: 'Borradores abandonados', cantidad: 12, umbral: 7, unidad: 'dias', severidad: 'critico', destino: aConjunto('borrador_abandonado') },
      { causa: 'soat_sin_gestion', etiqueta: 'SOAT sin gestión', cantidad: 0, umbral: 48, unidad: 'horas', severidad: 'ok', destino: { tipo: 'ninguno' } },
    ],
  },
  carga: { ...META, porOrganismo: [], porFuncionario: null },
  benchmarkOt: { ...META, umbralDias: 10, filas: [] },
  logistica: { ...META, entregas: 0, primerIntento: 0, primerIntentoPct: null, viajesAdicionales: 0, tiempoMedioEntregaDias: null },
};

const COLUMNAS = [
  { id: 'placa', etiqueta: 'Placa', tipo: 'texto', dinero: false, ordenable: true },
  { id: 'compania', etiqueta: 'Compañía', tipo: 'texto', dinero: false, ordenable: false },
  { id: 'tipo_tramite', etiqueta: 'Tipo de trámite', tipo: 'texto', dinero: false, ordenable: true },
  { id: 'estado', etiqueta: 'Estado', tipo: 'texto', dinero: false, ordenable: true },
  { id: 'organismo', etiqueta: 'Secretaría', tipo: 'texto', dinero: false, ordenable: false },
  { id: 'creado_en', etiqueta: 'Creado', tipo: 'fecha', dinero: false, ordenable: true },
  { id: 'dias_antiguedad', etiqueta: 'Días desde creado', tipo: 'dias', dinero: false, ordenable: true },
];
const fila = (i: number, placa = `FLT${String(100 + i)}`) => ({
  id: `t-${i}`, tramiteId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  celdas: {
    placa, compania: i % 2 ? 'Compañía Demo A' : 'Compañía Demo B', tipo_tramite: 'Traspaso', estado: 'borrador',
    organismo: 'OT Demo Norte', creado_en: '2026-10-28', dias_antiguedad: 30 - i,
  },
});

function resultado(c: CuerpoDetalle, total: number, filas: unknown[]) {
  return {
    origen: c.origen, segmentos: c.segmentos ?? [],
    definicion: c.origen.tipo === 'conjunto'
      ? { etiqueta: 'Borradores abandonados', definicion: DEF_BORRADOR, fechaBase: null, campoFecha: 'fecha_creacion' }
      : { etiqueta: 'Trámites', definicion: 'Trámites con la fecha base en el periodo.', fechaBase: 'aprobacion', campoFecha: 'fecha_aprobacion' },
    // El API arma la frase con el total vivo (`fraseDeConjunto`); la web la pinta tal cual.
    frase: c.origen.tipo === 'conjunto' ? `${total} trámites llevan más de 7 días en Borrador.` : `${total} trámites aprobados en el periodo.`,
    fraseVacio: 'Hoy ningún borrador lleva más de 7 días.',
    total, valorTotal: null, columnas: COLUMNAS, filas, pagina: c.pagina ?? 1, tamano: c.tamano ?? 25, truncado: false,
    filtrosIgnorados: [], rango: null, dineroVisible: true, generadoEn: '2026-11-19T12:00:00.000Z',
  };
}

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mockBase(page: Pagina) {
  await page.route('**/api/flito/torre/opciones', (r) => r.fulfill(json(OPCIONES)));
  await page.route('**/api/flito/torre/tableros/operativa', (r) => r.fulfill(json(OPERATIVO)));
}

/** El detalle de borradores: 12 registros; con placa, solo los que empiezan por ella (0 para «ABC123»). */
async function mockDetalle(page: Pagina, cuerpos: CuerpoDetalle[], opciones: { demoraMs?: number; falla?: () => boolean; vacio?: boolean } = {}) {
  await page.route('**/api/flito/torre/detalle/consultar', async (route) => {
    const c = route.request().postDataJSON() as CuerpoDetalle;
    cuerpos.push(c);
    if (opciones.demoraMs) await new Promise((r) => setTimeout(r, opciones.demoraMs));
    if (opciones.falla?.()) { await route.fulfill(json({ error: 'TORRE_ERROR', detalle: 'stack crudo' }, 500)); return; }
    if (c.origen.tipo === 'metrica') { await route.fulfill(json(resultado(c, 398, Array.from({ length: 25 }, (_, i) => fila(i))))); return; }
    const todas = opciones.vacio ? [] : Array.from({ length: 12 }, (_, i) => fila(i));
    const placa = c.filtrosDetalle?.placa;
    const filas = placa ? todas.filter((f) => f.celdas.placa.startsWith(placa)) : todas;
    await route.fulfill(json(resultado(c, filas.length, filas)));
  });
}

const tablaDetalle = (page: Pagina) => page.locator('[data-torre="tabla-detalle"] table');

test.describe('Torre de Control · Detalle universal y KPI explicables (Épica #14590, B1b)', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('AC4/AC13: «Ver los 12 borradores» abre el detalle con tantas filas como dice la tarjeta', async ({ page }) => {
    await loginAs(page, GERENCIA);
    await mockBase(page);
    const cuerpos: CuerpoDetalle[] = [];
    await mockDetalle(page, cuerpos);
    await page.goto('/flito/torre/operativa');

    const kpi = page.getByRole('article', { name: 'Borradores abandonados' });
    await expect(kpi).toContainText('12');
    await expect(kpi.getByText('Foto de hoy')).toBeVisible();
    await expect(kpi).toContainText('12 trámites llevan más de 7 días en Borrador');
    // Cifra 0: sin «Ver».
    // Cifra 0 con destino de conjunto: sin «Ver» (ni enlace alguno en la tarjeta).
    const enCurso = page.getByRole('article', { name: 'Trámites en curso' });
    await expect(enCurso.getByRole('button', { name: /¿Cómo se calcula\?/ })).toBeVisible();
    await expect(enCurso.locator('[data-torre="ver-registros"]')).toHaveCount(0);
    await expect(enCurso.getByRole('link')).toHaveCount(0);

    await kpi.getByRole('link', { name: /Ver los 12 borradores/ }).click();
    await expect(page).toHaveURL(/\/flito\/torre\/detalle\?c=borrador_abandonado&o=operativa$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Borradores abandonados' })).toBeFocused();
    await expect(page.locator('[data-torre="definicion-detalle"]')).toContainText(DEF_BORRADOR);
    await expect(page.locator('[data-torre="detalle"]')).toHaveAttribute('data-estado', 'lleno');
    await expect(tablaDetalle(page).locator('tbody tr')).toHaveCount(12);
    await expect(page.locator('[data-kit="cabecera"]')).toContainText('12 trámites llevan más de 7 días en Borrador.');
    // Sin nombre ni cédula del titular: solo las columnas que mandó el API.
    await expect(tablaDetalle(page).locator('thead')).not.toContainText(/Nombre|Cédula/i);
    expect(cuerpos[0]).toMatchObject({ origen: { tipo: 'conjunto', conjunto: 'borrador_abandonado' }, pagina: 1, tamano: 25 });

    await page.getByRole('link', { name: /Volver a Operativa/ }).click();
    await expect(page).toHaveURL(/\/flito\/torre\/operativa$/);

    // Radar: la fila abre el mismo conjunto («Ver cola» sin filtrar era el defecto de AC13).
    await page.locator('[data-torre="bloque-radar"]').getByRole('link', { name: /Ver los 12: Borradores abandonados/ }).click();
    await expect(page).toHaveURL(/c=borrador_abandonado/);
  });

  test('AC3: «¿Cómo se calcula?» se abre con Enter, Esc lo cierra y el foco vuelve al botón', async ({ page }) => {
    await loginAs(page, GERENCIA);
    await mockBase(page);
    await page.goto('/flito/torre/operativa');
    const kpi = page.getByRole('article', { name: 'Borradores abandonados' });
    const boton = kpi.getByRole('button', { name: /¿Cómo se calcula\?/ });
    await expect(boton).toHaveAttribute('aria-expanded', 'false');
    await expect(kpi.getByText(DEF_BORRADOR)).toBeHidden();

    await boton.focus();
    await page.keyboard.press('Enter');
    await expect(boton).toHaveAttribute('aria-expanded', 'true');
    const region = page.locator(`#${await boton.getAttribute('aria-controls')}`);
    await expect(region).toBeVisible();
    await expect(region).toHaveText(DEF_BORRADOR);

    await page.keyboard.press('Escape');
    await expect(boton).toHaveAttribute('aria-expanded', 'false');
    await expect(region).toBeHidden();
    await expect(boton).toBeFocused();
  });

  test('sin torre.detalle.ver la KPI se explica pero no tiene «Ver»', async ({ page }) => {
    await loginAs(page, SIN_DETALLE);
    await mockBase(page);
    await page.goto('/flito/torre/operativa');
    const kpi = page.getByRole('article', { name: 'Borradores abandonados' });
    await expect(kpi.getByRole('button', { name: /¿Cómo se calcula\?/ })).toBeVisible();
    await expect(kpi.getByRole('link')).toHaveCount(0);
  });

  test('AC7: la placa filtra por el body del POST y nunca aparece en la URL ni en sessionStorage; vacío por filtros', async ({ page }) => {
    await loginAs(page, GERENCIA);
    await mockBase(page);
    const cuerpos: CuerpoDetalle[] = [];
    await mockDetalle(page, cuerpos);
    await page.goto('/flito/torre/detalle?c=borrador_abandonado&o=operativa');
    await expect(tablaDetalle(page).locator('tbody tr')).toHaveCount(12);

    await page.getByLabel('Placa', { exact: true }).fill('abc123');
    await expect(page.locator('[data-torre="detalle"]')).toHaveAttribute('data-estado', 'vacio');
    await expect(page.getByText('Ningún registro de esta lista coincide con los filtros.')).toBeVisible();
    const conPlaca = cuerpos.find((c) => c.filtrosDetalle?.placa);
    expect(conPlaca?.filtrosDetalle?.placa).toBe('ABC123');
    expect(page.url()).not.toContain('ABC123');
    expect(page.url().toUpperCase()).not.toContain('ABC123');
    const almacenado = await page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }));
    expect(almacenado.toUpperCase()).not.toContain('ABC123');

    // Filtrar a una placa existente vuelve a llenar la lista.
    await page.locator('[data-torre="quitar-filtros"]').click();
    await expect(tablaDetalle(page).locator('tbody tr')).toHaveCount(12);
    await page.getByLabel('Placa', { exact: true }).fill('FLT105');
    await expect(tablaDetalle(page).locator('tbody tr')).toHaveCount(1);
    await expect(tablaDetalle(page)).toContainText('FLT105');
    expect(page.url()).not.toContain('FLT105');
  });

  test('AC8: «Descargar Excel» es la primaria y descarga con el mismo conjunto, filtros y orden', async ({ page }) => {
    await loginAs(page, GERENCIA);
    await mockBase(page);
    await mockDetalle(page, []);
    const exportados: CuerpoDetalle[] = [];
    await page.route('**/api/flito/torre/detalle/exportar', async (route) => {
      exportados.push(route.request().postDataJSON() as CuerpoDetalle);
      await route.fulfill({
        status: 200, body: 'xlsx',
        headers: {
          'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'content-disposition': 'attachment; filename="torre-detalle-borrador_abandonado-20261119.xlsx"',
        },
      });
    });
    await page.goto('/flito/torre/detalle?c=borrador_abandonado&o=operativa');
    await expect(tablaDetalle(page).locator('tbody tr')).toHaveCount(12);

    const descarga = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Descargar Excel' }).click();
    expect((await descarga).suggestedFilename()).toBe('torre-detalle-borrador_abandonado-20261119.xlsx');
    expect(exportados).toHaveLength(1);
    expect(exportados[0]).toMatchObject({ origen: { tipo: 'conjunto', conjunto: 'borrador_abandonado' }, orden: { columna: 'dias_antiguedad' } });
    expect(exportados[0].pagina).toBeUndefined();
    // «Descargar Excel» es la ÚNICA primaria de la página; «Volver a Operativa» es ligera.
    await expect(page.locator('[data-variante="primario"]')).toHaveCount(1);
    await expect(page.locator('[data-variante="primario"]')).toHaveText(/Descargar Excel/);
    await expect(page.locator('[data-torre="volver"]')).toHaveAttribute('class', /\bghost\b/);
    await expect(page.getByText('Se descargó el Excel con 12 registros.')).toBeVisible();
  });

  test('AC14: cargando, error con Reintentar (sin el error crudo) y conjunto inválido', async ({ page }) => {
    await loginAs(page, GERENCIA);
    await mockBase(page);
    // Falla hasta que el test lo diga (en dev, StrictMode pide dos veces y la primera respuesta se descarta).
    let falla = true;
    await mockDetalle(page, [], { demoraMs: 800, falla: () => falla });
    await page.goto('/flito/torre/detalle?c=borrador_abandonado&o=operativa');

    await expect(page.getByRole('heading', { level: 1, name: 'Borradores abandonados' })).toBeVisible();
    await expect(page.locator('[data-torre="detalle"]')).toHaveAttribute('data-estado', 'cargando');
    await expect(page.locator('[data-torre="lista"]')).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByText('No pudimos cargar la lista de borradores abandonados.', { exact: false })).toBeVisible();
    await expect(page.getByText('stack crudo')).toHaveCount(0);
    falla = false;
    await page.getByRole('button', { name: 'Reintentar' }).click();
    await expect(tablaDetalle(page).locator('tbody tr')).toHaveCount(12);

    await page.goto('/flito/torre/detalle?c=no_existe');
    await expect(page.getByText('Esta lista no existe o ya no está disponible.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ir al Resumen 360°' })).toBeVisible();
  });

  test('AC12: el Explorador abre «Ver los N registros» de una fila con su segmento', async ({ page }) => {
    await loginAs(page, GERENCIA);
    await mockBase(page);
    const cuerpos: CuerpoDetalle[] = [];
    await mockDetalle(page, cuerpos);
    await page.route('**/api/flito/torre/metricas/consultar', (r) => r.fulfill(json({
      metrica: 'tramites', unidad: 'conteo', truncado: false, total: { valor: 629, n: 629 },
      baseFecha: { campo: 'fecha_aprobacion', excluidosSinFecha: 0, nBaseSincronizacion: 0, fechaBase: 'aprobacion' },
      rango: { desde: '2026-11-01', hasta: '2026-11-19' }, generadoEn: '2026-11-19T12:00:00.000Z',
      filas: [
        { clave: '1', etiqueta: 'Compañía Demo A', valor: 398, n: 398, participacion: 63.3 },
        { clave: '2', etiqueta: 'Compañía Demo B', valor: 231, n: 231, participacion: 36.7 },
      ],
    })));
    await page.goto('/flito/torre/explorador');

    await page.getByRole('link', { name: 'Ver los 398 registros de Compañía Demo A' }).click();
    await expect(page).toHaveURL(/\/flito\/torre\/detalle\?m=tramites&fb=aprobacion&s=compania%3A1&o=explorador$/);
    await expect(page.locator('[data-kit="cabecera"]')).toContainText('398 trámites aprobados en el periodo.');
    expect(cuerpos.at(-1)).toMatchObject({
      origen: { tipo: 'metrica', metrica: 'tramites', fechaBase: 'aprobacion' },
      segmentos: [{ dimension: 'compania', valores: ['1'] }],
    });
    await expect(page.getByRole('link', { name: /Volver al Explorador/ })).toBeVisible();
  });

  test('AC14: vacío del conjunto con su frase del API y «Volver a Operativa» ligera', async ({ page }) => {
    await loginAs(page, GERENCIA);
    await mockBase(page);
    await mockDetalle(page, [], { vacio: true });
    await page.goto('/flito/torre/detalle?c=borrador_abandonado&o=operativa');
    await expect(page.locator('[data-torre="detalle"]')).toHaveAttribute('data-estado', 'vacio');
    await expect(page.locator('[data-torre="vacio-lista"]')).toContainText('Hoy ningún borrador lleva más de 7 días.');
    await expect(page.getByRole('button', { name: 'Descargar Excel' })).toBeDisabled();
    await expect(page.locator('[data-torre="volver"]')).toHaveAttribute('class', /ghost/);
  });

  test('«Abrir trámite» abre la ficha de la placa en el panel lateral, con la placa solo en el body', async ({ page }) => {
    await loginAs(page, GERENCIA);
    await mockBase(page);
    await mockDetalle(page, []);
    const buscadas: unknown[] = [];
    await page.route('**/api/flito/torre/placa/buscar', async (route) => {
      buscadas.push(route.request().postDataJSON());
      await route.fulfill(json({ error: 'NO_ENCONTRADO' }, 404));
    });
    await page.goto('/flito/torre/detalle?c=borrador_abandonado&o=operativa');
    await expect(tablaDetalle(page).locator('tbody tr')).toHaveCount(12);

    await page.getByRole('button', { name: 'Abrir trámite FLT103 (abre la ficha de la placa)' }).click();
    const panel = page.getByRole('dialog');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('FLT103');
    // (en dev, StrictMode y el reintento del panel pueden repetir la petición: todas llevan la placa en el body)
    expect(buscadas.length).toBeGreaterThan(0);
    for (const b of buscadas) expect(b).toMatchObject({ placa: 'FLT103' });
    expect(page.url()).not.toContain('FLT103');
    // La lista sigue debajo, en la misma página.
    await expect(page).toHaveURL(/\/flito\/torre\/detalle\?c=borrador_abandonado/);
  });

  test('AC12: «Otros» (fila del resultado, fila y columna del cruce) no abre registros', async ({ page }) => {
    await loginAs(page, GERENCIA);
    await mockBase(page);
    const base = {
      metrica: 'tramites', unidad: 'conteo', truncado: true,
      baseFecha: { campo: 'fecha_aprobacion', excluidosSinFecha: 0, nBaseSincronizacion: 0, fechaBase: 'aprobacion' },
      rango: { desde: '2026-11-01', hasta: '2026-11-19' }, generadoEn: '2026-11-19T12:00:00.000Z',
    };
    let cruzado = false;
    await page.route('**/api/flito/torre/metricas/consultar', (r) => r.fulfill(json(cruzado ? {
      ...base, total: { valor: 60, n: 60 },
      filas: [
        { clave: '1', etiqueta: 'Compañía Demo A', valor: 40, n: 40, participacion: 66.7 },
        { clave: 'otros', etiqueta: 'Otros', valor: 20, n: 20, participacion: 33.3, esOtros: true },
      ],
      cruce: {
        agrupacion: 'organismo', truncadoColumnas: true,
        columnas: [
          { clave: '05001', etiqueta: 'OT Demo Norte', valor: 35, n: 35, participacion: 58.3 },
          { clave: 'otros', etiqueta: 'Otros', valor: 25, n: 25, participacion: 41.7, esOtros: true },
        ],
        celdas: [[{ valor: 25, n: 25 }, { valor: 15, n: 15 }], [{ valor: 10, n: 10 }, { valor: 10, n: 10 }]],
      },
    } : {
      ...base, total: { valor: 60, n: 60 },
      filas: [
        { clave: '1', etiqueta: 'Compañía Demo A', valor: 40, n: 40, participacion: 66.7 },
        { clave: 'otros', etiqueta: 'Otros', valor: 20, n: 20, participacion: 33.3, esOtros: true },
      ],
    })));

    // Resultado simple: solo la fila con clave expresable tiene «Ver los N registros».
    await page.goto('/flito/torre/explorador');
    const verFila = page.locator('[data-torre="resultado"] [data-torre="ver-registros"]');
    await expect(verFila).toHaveCount(1);
    await expect(verFila).toHaveAccessibleName('Ver los 40 registros de Compañía Demo A');

    // Cruce: solo la celda Compañía Demo A × OT Demo Norte abre registros; las de «Otros» no.
    cruzado = true;
    await page.reload();
    const celdas = page.locator('[data-torre="celda-registros"]');
    await expect(celdas).toHaveCount(1);
    await expect(celdas).toHaveAccessibleName('Compañía Demo A · OT Demo Norte: 25 registros. Ver registros');
    await expect(page.locator('[data-torre="tabla-cruzada"] a[aria-label*="Otros"]')).toHaveCount(0);
  });

  test('AC2: Comercial dice «Concentración en 3 compañías» con sus nombres y %, sin la pista del Top 5', async ({ page }) => {
    await loginAs(page, GERENCIA);
    await page.route('**/api/flito/torre/opciones', (r) => r.fulfill(json(OPCIONES)));
    const META_P = { filtrosIgnorados: [] as string[] };
    const conc = {
      top: [{ companiaId: 1, compania: 'Compañía Demo A', valor: 61, pct: 61 }, { companiaId: 2, compania: 'Compañía Demo B', valor: 25, pct: 25 }, { companiaId: 3, compania: 'Compañía Demo C', valor: 12, pct: 12 }],
      demas: { n: 1, valor: 2, pct: 2 }, top3Pct: 98, top5Pct: 100, total: 100,
    };
    const FRASE_C2 = '98 % de los 100 trámites creados en el periodo vienen de 3 compañías: Compañía Demo A (61 %), Compañía Demo B (25 %) y Compañía Demo C (12 %). Con las 5 más grandes: 100 %.';
    await page.route('**/api/flito/torre/tableros/comercial', (r) => r.fulfill(json({
      rango: { desde: '2026-11-01', hasta: '2026-11-19' }, dineroVisible: false, generadoEn: '2026-11-19T12:00:00.000Z',
      cifras: { clientesEnCaida: 0, concentracionTop3Pct: 98, concentracionTop5Pct: 100, conversionFacturadoPct: 25, tramitesPeriodo: 100, tramitesPeriodoAnterior: 90, sparkline: [1, 2, 3] },
      explicaciones: {
        concentracionTop3Pct: {
          frase: FRASE_C2, definicion: 'Trámites creados en el periodo, agrupados por compañía.',
          destino: aConjunto('tramites_creados', [{ dimension: 'compania', valores: ['1', '2', '3'] }]),
        },
      },
      fuga: { ...META_P, umbralPct: 30, ventanaDias: 30, filas: [] },
      concentracion: { ...META_P, volumen: conc, ingreso: null },
      embudo: { ...META_P, pasos: [{ paso: 'creados', valor: 100, pct: 100 }] },
      tendencia: { ...META_P, mensual: [], trimestral: [] },
      ventaCruzada: { ...META_P, filas: [] },
    })));
    await page.goto('/flito/torre/comercial');
    const kpi = page.getByRole('article', { name: 'Concentración en 3 compañías' });
    await expect(kpi).toContainText('98 %');
    await expect(kpi.locator('[data-torre="frase"]')).toHaveText(FRASE_C2);
    await expect(kpi).not.toContainText('Top 5');
    await expect(page.getByText('Concentración en el Top 3')).toHaveCount(0);
  });

  test('AC13: «Ver los N» de Trabajo sin facturar abre su conjunto con la compañía y los filtros actuales', async ({ page }) => {
    await loginAs(page, GERENCIA);
    await page.addInitScript((f) => sessionStorage.setItem('flito-torre-filtros', f), JSON.stringify({
      companiaIds: [1], periodo: 'mes_anterior', rango: null, organismos: ['05001'], departamentos: [], tiposTramite: [], flitEstados: [],
    }));
    await page.route('**/api/flito/torre/opciones', (r) => r.fulfill(json(OPCIONES)));
    const META_P = { filtrosIgnorados: [] as string[] };
    await page.route('**/api/flito/torre/tableros/financiera', (r) => r.fulfill(json({
      rango: { desde: '2026-10-01', hasta: '2026-10-31' }, dineroVisible: false, generadoEn: '2026-11-19T12:00:00.000Z',
      cifras: { menorCobertura: null, sinFacturarValor: null, sinFacturarTramites: 7, margenPct: null, soportesCompletosPct: null },
      explicaciones: {},
      bolsas: { ...META_P, umbralAtencionDias: 10, umbralCriticoDias: 5, filas: [] },
      sinFacturar: {
        ...META_P,
        filas: [{ companiaId: 1, compania: 'Compañía Demo A', tramites: 7, valorEstimado: null, masAntiguoDias: 12,
          destino: aConjunto('sin_facturar', [{ dimension: 'compania', valores: ['1'] }]) }],
      },
      margen: null,
      conciliacion: { ...META_P, completos: 0, dos: 0, uno: 0, cero: 0, total: 0, pctCompletos: null },
    })));
    const cuerpos: CuerpoDetalle[] = [];
    await mockDetalle(page, cuerpos);
    await page.goto('/flito/torre/financiera');

    const bloque = page.locator('[data-torre="bloque-sin-facturar"]');
    await expect(bloque.getByText('Ver en reporte de costos')).toHaveCount(0);
    await bloque.getByRole('link', { name: 'Ver los 7: trabajo sin facturar de Compañía Demo A' }).click();
    await expect(page).toHaveURL(/\/flito\/torre\/detalle\?c=sin_facturar&s=compania%3A1&o=financiera$/);
    await expect(page.locator('[data-torre="detalle"]')).toHaveAttribute('data-estado', 'lleno');
    expect(cuerpos.at(-1)).toMatchObject({
      origen: { tipo: 'conjunto', conjunto: 'sin_facturar' },
      segmentos: [{ dimension: 'compania', valores: ['1'] }],
      filtro: { rango: { preset: 'mes_anterior' }, companiaIds: [1], organismos: ['05001'] },
    });
  });
});
