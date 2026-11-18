// Torre de Control (Épica #14590) — Explorador flexible: fecha base, segunda agrupación (cruce), preguntas frecuentes,
// filtros múltiples con chips por filtro, lectura del sessionStorage viejo y coincidencias de placa con teclado.
// Backend mockeado con `page.route` (el fixture base responde `200 []` a lo no mockeado).
// Spec UX: docs/ux/flito-torre-explorador-flexible.md; ADR-0044.
import { test, expect } from '../helpers/fixtures';
import { loginAs, type UsuarioFixture } from '../helpers/auth';

type Pagina = Parameters<typeof loginAs>[0];
type Cuerpo = {
  metrica: string; fechaBase?: string; agrupacion?: string; agrupacionColumnas?: string;
  filtro: { rango: unknown; companiaIds?: number[]; organismos?: string[]; flitEstados?: string[]; tiposTramite?: string[] };
};

const GERENCIA: UsuarioFixture = {
  id: 701, username: 'e2e_gerencia', name: 'Gerencia General E2E', role: 'gerencia_general',
  allowedPages: ['torre_360', 'torre_comercial', 'torre_operativa', 'torre_financiera', 'torre_explorador'],
  funciones: [
    'torre.metricas.consultar', 'torre.metricas.exportar', 'torre.placa.buscar', 'torre.metricas.dinero',
    'torre.tablero_ejecutivo.ver', 'torre.tablero_comercial.ver', 'torre.tablero_operativo.ver', 'torre.tablero_financiero.ver',
    'perfil.datos.ver',
  ],
};

const OPCIONES = {
  companias: ['A', 'B', 'C', 'D', 'E', 'F'].map((l, i) => ({ id: i + 1, nombre: `Compañía Demo ${l}` })),
  organismos: [
    { codigo: '05001', nombre: 'OT Demo Norte' }, { codigo: '05002', nombre: 'OT Demo Centro' }, { codigo: '05003', nombre: 'OT Demo Sur' },
  ],
  tiposTramite: [{ valor: 'TRASPASO', etiqueta: 'Traspaso' }, { valor: 'MATRICULA', etiqueta: 'Matrícula' }],
  flitEstados: [{ valor: 'aprobado', etiqueta: 'Aprobado' }, { valor: 'facturado', etiqueta: 'Facturado' }],
};

// `rango`: el que la API resolvió para el preset (RN-TOR-F5); la web solo lo muestra.
const BASE = {
  baseFecha: { campo: 'fecha_aprobacion', excluidosSinFecha: 0, nBaseSincronizacion: 0, fechaBase: 'aprobacion' },
  rango: { desde: '2026-06-01', hasta: '2026-11-18' }, generadoEn: '2026-11-18T12:00:00.000Z',
};
const SIMPLE = {
  ...BASE, metrica: 'tramites', unidad: 'conteo', truncado: false, total: { valor: 1102, n: 1102 },
  filas: [
    { clave: '1', etiqueta: 'Compañía Demo A', valor: 398, n: 398, participacion: 36.1 },
    { clave: '2', etiqueta: 'Compañía Demo B', valor: 231, n: 231, participacion: 21 },
  ],
};
const MESES = ['Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov'];
const DATOS_CRUCE: [string, number[]][] = [
  ['Compañía Demo A', [61, 70, 66, 72, 80, 49]], ['Compañía Demo B', [35, 41, 38, 44, 45, 28]],
  ['Compañía Demo D', [25, 22, 27, 24, 30, 14]], ['Compañía Demo C', [20, 0, 31, 29, 33, 17]],
  ['Compañía Demo E', [18, 20, 19, 21, 22, 12]], ['Compañía Demo F', [15, 16, 14, 18, 17, 9]],
];
const suma = (v: number[]) => v.reduce((a, b) => a + b, 0);
const CRUCE = {
  ...BASE, metrica: 'tramites', unidad: 'conteo', truncado: false, total: { valor: 1102, n: 1102 },
  filas: DATOS_CRUCE.map(([e, v], i) => ({ clave: String(i + 1), etiqueta: e, valor: suma(v), n: suma(v), participacion: (suma(v) / 1102) * 100 })),
  cruce: {
    agrupacion: 'mes', truncadoColumnas: false,
    columnas: MESES.map((m, j) => {
      const v = suma(DATOS_CRUCE.map(([, f]) => f[j]));
      return { clave: `2026-${String(j + 6).padStart(2, '0')}`, etiqueta: m, valor: v, n: v, participacion: (v / 1102) * 100 };
    }),
    celdas: DATOS_CRUCE.map(([, v]) => v.map((x) => (x === 0 ? null : { valor: x, n: x }))),
  },
};
const VACIO = { ...SIMPLE, total: { valor: 0, n: 0 }, filas: [] };

const SUGERENCIAS = {
  hayMas: true,
  sugerencias: [
    ['XXX001', 'Compañía Demo A', 'aprobado'], ['XXX003', 'Compañía Demo B', 'radicado'], ['XXX007', 'Compañía Demo C', 'facturado'],
    ['XXX009', 'Compañía Demo D', 'aprobado'], ['XXX010', 'Compañía Demo E', 'borrador'], ['XXX015', 'Compañía Demo A', 'aprobado'],
    ['XXX021', 'Compañía Demo F', 'radicado'], ['XXX034', 'Compañía Demo B', 'facturado'],
  ].map(([placa, compania, flitEstado]) => ({ placa, compania, flitEstado })),
};
const FICHA = {
  tramiteUuid: '00000000-0000-4000-8000-000000000003', placa: 'XXX003', tipoTramite: 'TRASPASO', vinMascara: '•••••1234',
  compania: { id: 2, nombre: 'Compañía Demo B' }, organismo: { codigo: '05001', nombre: 'OT Demo Norte' },
  flitEstado: 'radicado', fechaCreacion: '2026-10-02T10:00:00.000Z', fechaAprobacion: null, duracionHoras: null,
  baseFecha: { campo: 'fecha_creacion_flit', conFallback: false },
  pasos: { creado: '2026-10-02T10:00:00.000Z', radicado: '2026-10-10T10:00:00.000Z', aprobado: null, facturado: null },
  lineaTiempo: [{ estado: 'radicado', anterior: 'creado', desde: '2026-10-10T10:00:00.000Z' }],
  soat: { estado: 'vigente' }, impuesto: { estado: 'pagado' }, derecho: { estado: 'pagado' }, logistica: { estado: 'entregado' },
};

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function preparar(page: Pagina, responder: (c: Cuerpo) => { status?: number; body: unknown }, filtrosGuardados?: unknown) {
  await loginAs(page, GERENCIA);
  if (filtrosGuardados) {
    await page.addInitScript((f) => sessionStorage.setItem('flito-torre-filtros', f), JSON.stringify(filtrosGuardados));
  }
  await page.route('**/api/flito/torre/opciones', (route) => route.fulfill(json(OPCIONES)));
  const cuerpos: Cuerpo[] = [];
  await page.route('**/api/flito/torre/metricas/consultar', async (route) => {
    const c = route.request().postDataJSON() as Cuerpo;
    cuerpos.push(c);
    const r = responder(c);
    await route.fulfill(json(r.body, r.status ?? 200));
  });
  return cuerpos;
}

const resultado = (page: Pagina) => page.locator('[data-torre="resultado"]');
/** El botón de Compañía: con 2+ elegidas su `aria-label` las nombra todas («Compañía: A, B y C»). */
const triggerCompania = (page: Pagina) => page.locator('[data-torre-selector="Compañía"] [aria-haspopup="listbox"]');
const listaPlaca = (page: Pagina) => page.locator('[data-torre="sugerencias-placa"]');
const ultimo = (c: Cuerpo[]) => c.at(-1)!;
const porRespuesta = (c: Cuerpo) => ({ body: c.agrupacionColumnas ? CRUCE : SIMPLE });

test.describe('Torre · Explorador flexible (Épica #14590)', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('ejemplo del pedido en 1 clic: Trámites · aprobación · compañía · últimos 6 meses, SIN filtro de estado (D3)', async ({ page }) => {
    const cuerpos = await preparar(page, porRespuesta);
    await page.goto('/flito/torre/explorador');
    await expect(resultado(page)).toHaveAttribute('data-estado', 'lleno');
    // Al abrir: Trámites · aprobación · Compañía · sin «Y luego por».
    expect(ultimo(cuerpos)).toMatchObject({ metrica: 'tramites', fechaBase: 'aprobacion', agrupacion: 'compania' });

    const chip = page.getByRole('button', { name: 'Aprobados por compañía · 6 meses' });
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => (ultimo(cuerpos).filtro.rango)).toEqual({ preset: 'ultimos_6m' });
    const c = ultimo(cuerpos);
    expect(c).toMatchObject({ metrica: 'tramites', fechaBase: 'aprobacion', agrupacion: 'compania' });
    expect(c.agrupacionColumnas).toBeUndefined();
    expect(c.filtro.flitEstados).toBeUndefined();
    await expect(page.getByRole('heading', { name: 'Trámites aprobados · Últimos 6 meses · por compañía' })).toBeVisible();
    // RN-TOR-F5: el subtítulo nombra las fechas reales que resolvió la API, no las calcula la web.
    await expect(resultado(page).getByText('1 jun – 18 nov 2026 · Todas las compañías', { exact: false })).toBeVisible();
  });

  test('cruce compañía × mes: tabla con 1.ª columna de fila, «Total» en tfoot, 0 en tinta terciaria, gráfica por series e «Intercambiar»', async ({ page }) => {
    const cuerpos = await preparar(page, porRespuesta);
    await page.goto('/flito/torre/explorador');
    await page.getByRole('button', { name: 'Aprobados por compañía y mes' }).click();
    await expect(resultado(page)).toHaveAttribute('data-forma', 'cruzado');
    expect(ultimo(cuerpos)).toMatchObject({ agrupacion: 'compania', agrupacionColumnas: 'mes' });

    const titulo = 'Trámites aprobados · Últimos 6 meses · por compañía y mes';
    await expect(page.getByRole('heading', { name: titulo })).toBeVisible();
    const tabla = page.getByRole('table', { name: `Tabla cruzada: ${titulo}` });
    await expect(tabla.getByRole('columnheader')).toHaveText(['Compañía', ...MESES, 'Total']);
    await expect(tabla.getByRole('rowheader', { name: 'Compañía Demo A' })).toBeVisible();
    const pie = tabla.locator('tfoot tr');
    await expect(pie.locator('th[scope="row"]')).toHaveText('Total');
    await expect(pie.locator('td').last()).toHaveText('1.102');
    await expect(tabla.getByRole('row', { name: /Compañía Demo C/ }).locator('td').nth(1)).toHaveText('0');
    await expect(page.getByRole('region', { name: `Tabla cruzada: ${titulo}` })).toHaveAttribute('tabindex', '0');
    await expect(page.locator('[data-torre="grafica-series"] svg[role="img"]')).toBeVisible();
    // Top 5 + «Los demás» (= Demo F) en la leyenda.
    await expect(page.locator('[data-torre="grafica-series"] .leyenda li')).toHaveCount(6);
    await expect(page.locator('[data-torre="grafica-series"] .leyenda')).toContainText('Los demás');
    await expect(page.getByRole('button', { name: 'Exportar a Excel' })).toBeEnabled();

    await page.getByRole('button', { name: 'Intercambiar filas y columnas' }).click();
    await expect.poll(() => ultimo(cuerpos).agrupacion).toBe('mes');
    expect(ultimo(cuerpos).agrupacionColumnas).toBe('compania');
  });

  test('más de 62 cortes: estado propio sin «Reintentar» y [Agrupar por mes] lo resuelve', async ({ page }) => {
    const cuerpos = await preparar(page, (c) => (c.agrupacionColumnas === 'dia'
      ? { status: 400, body: { error: 'Demasiados cortes', code: 'RANGO_TORRE_EXCEDIDO', campo: 'rango' } }
      : porRespuesta(c)));
    await page.goto('/flito/torre/explorador');
    await expect(resultado(page)).toHaveAttribute('data-estado', 'lleno');
    await page.getByLabel('Y luego por').selectOption('dia');

    await expect(resultado(page)).toHaveAttribute('data-estado', 'cortes');
    await expect(resultado(page).getByText('Con dos agrupaciones, el periodo admite hasta 62 cortes por día.')).toBeVisible();
    await expect(resultado(page).getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Exportar a Excel' })).toBeDisabled();
    await resultado(page).getByRole('button', { name: 'Agrupar por mes' }).click();
    await expect.poll(() => ultimo(cuerpos).agrupacionColumnas).toBe('mes');
    await expect(resultado(page)).toHaveAttribute('data-estado', 'lleno');
  });

  test('matriz medida × fecha: «(no aplica)» deshabilitada, salto a pago y la foto de hoy sin fecha', async ({ page }) => {
    const cuerpos = await preparar(page, () => ({ body: SIMPLE }));
    await page.goto('/flito/torre/explorador');
    const fecha = page.getByLabel('Según la fecha de');
    await expect(fecha.locator('option')).toHaveText(['creación', 'aprobación', 'facturación', 'pago (no aplica)']);

    await page.getByLabel('Medir').selectOption('impuestos_pagados');
    await expect(fecha).toHaveValue('pago');
    await expect(fecha.locator('option[value="aprobacion"]')).toBeDisabled();
    await expect.poll(() => ultimo(cuerpos).fechaBase).toBe('pago');
    await expect(page.getByText('La fecha cambió a pago: aprobación no aplica a Impuestos pagados.', { exact: false })).toBeAttached();

    await page.getByLabel('Medir').selectOption('wip_activo');
    await expect(fecha).toBeDisabled();
    await expect(fecha).toHaveAccessibleDescription('Esta medida es la foto de hoy: no usa fecha ni periodo.');
    await expect.poll(() => ultimo(cuerpos).metrica).toBe('wip_activo');
    expect(ultimo(cuerpos).fechaBase).toBeUndefined();
    await expect(page.getByLabel('Agrupar por').locator('option', { hasText: 'Mes' })).toHaveCount(0);
  });

  test('filtro de estado: el chip del ejemplo NO queda marcado, sale el aviso y «Quitar el filtro de estado» lo quita', async ({ page }) => {
    const cuerpos = await preparar(page, () => ({ body: SIMPLE }), { periodo: 'mes', flitEstados: ['aprobado'] });
    await page.goto('/flito/torre/explorador');
    const chip = page.getByRole('button', { name: 'Aprobados por compañía · 6 meses' });
    await chip.click();
    await expect.poll(() => ultimo(cuerpos).filtro.rango).toEqual({ preset: 'ultimos_6m' });
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect(ultimo(cuerpos).filtro.flitEstados).toEqual(['aprobado']);

    const aviso = page.getByText(/Solo entran los trámites que hoy están en Aprobado\. .*su fecha de aprobación caiga en el periodo/);
    await expect(aviso).toBeVisible();
    await page.getByRole('button', { name: 'Quitar el filtro de estado' }).click();
    await expect.poll(() => ultimo(cuerpos).filtro.flitEstados).toBeUndefined();
    await expect(aviso).toHaveCount(0);
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
  });

  test('sessionStorage viejo (escalar) se lee como listas; al escribir queda solo la forma nueva', async ({ page }) => {
    const cuerpos = await preparar(page, () => ({ body: SIMPLE }),
      { companiaId: 2, periodo: 'mes', rango: null, organismo: '05001', departamento: null, tipoTramite: null, flitEstado: 'aprobado' });
    await page.goto('/flito/torre/explorador');
    await expect(resultado(page)).toHaveAttribute('data-estado', 'lleno');
    expect(ultimo(cuerpos).filtro).toMatchObject({ companiaIds: [2], organismos: ['05001'], flitEstados: ['aprobado'] });
    await expect(triggerCompania(page)).toHaveText('Compañía Demo B');

    const guardado = JSON.parse(await page.evaluate(() => sessionStorage.getItem('flito-torre-filtros') ?? '{}'));
    expect(guardado).toMatchObject({ companiaIds: [2], organismos: ['05001'], flitEstados: ['aprobado'], departamentos: [], tiposTramite: [] });
    for (const viejo of ['companiaId', 'organismo', 'departamento', 'tipoTramite', 'flitEstado']) expect(guardado).not.toHaveProperty(viejo);
  });

  test('compañía múltiple: marcar 3 lanza UNA consulta al cerrar con Esc; teclado ↓/Espacio sin cerrar', async ({ page }) => {
    const cuerpos = await preparar(page, () => ({ body: SIMPLE }));
    await page.goto('/flito/torre/explorador');
    await expect(resultado(page)).toHaveAttribute('data-estado', 'lleno');
    const trigger = triggerCompania(page);
    await trigger.click();
    const lista = page.getByRole('listbox', { name: 'Compañía' });
    await expect(lista).toBeFocused();
    await expect(lista.getByRole('option', { name: 'Todas las compañías' })).toHaveAttribute('aria-selected', 'true');
    const antes = cuerpos.length;
    // ↓ resalta A; Espacio la marca; ↓↓ B (salta nada: orden alfabético); Enter marca; ↓↓ D; Espacio.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press(' ');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press(' ');
    await expect(lista).toBeVisible();
    await expect(page.getByText('3 elegidas', { exact: true })).toBeVisible();
    expect(cuerpos.length).toBe(antes);
    await page.keyboard.press('Escape');
    await expect(lista).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect.poll(() => ultimo(cuerpos).filtro.companiaIds).toEqual([1, 2, 4]);
    expect(cuerpos.length).toBeLessThanOrEqual(antes + 2); // una consulta (StrictMode puede duplicarla en dev)
    await expect(trigger).toHaveText('Compañía Demo A y 2 más');
    await expect(page.getByRole('heading', { name: /por compañía/ })).toBeVisible();
    await expect(resultado(page)).toContainText('Compañía Demo A, Compañía Demo B y 1 más');
  });

  test('«Más filtros» múltiple: un chip por filtro con todos los valores en su ✕; «Limpiar todo» conserva compañía y periodo', async ({ page }) => {
    const cuerpos = await preparar(page, () => ({ body: SIMPLE }), { periodo: 'anio', companiaIds: [1] });
    await page.goto('/flito/torre/explorador');
    await expect(resultado(page)).toHaveAttribute('data-estado', 'lleno');
    await page.getByRole('button', { name: 'Más filtros' }).click();
    await page.getByLabel('Organismo de tránsito').click();
    const ot = page.getByRole('listbox', { name: 'Organismo de tránsito' });
    for (const n of ['OT Demo Centro', 'OT Demo Norte', 'OT Demo Sur']) await ot.getByRole('option', { name: n }).click();
    await page.getByRole('button', { name: 'Listo' }).click();
    await page.getByLabel('Estado actual').click();
    await page.getByRole('listbox', { name: 'Estado actual' }).getByRole('option', { name: 'Aprobado' }).click();
    await page.getByRole('button', { name: 'Listo' }).click();
    await page.getByRole('button', { name: 'Aplicar filtros' }).click();

    await expect.poll(() => ultimo(cuerpos).filtro.organismos).toEqual(['05002', '05001', '05003']);
    const chipOt = page.getByRole('button', { name: 'Quitar filtro OT: OT Demo Centro, OT Demo Norte y OT Demo Sur' });
    await expect(chipOt).toHaveText('OT: OT Demo Centro y 2 más');
    await expect(page.getByRole('button', { name: 'Quitar filtro Estado actual: Aprobado' })).toBeVisible();
    await chipOt.click();
    await expect.poll(() => ultimo(cuerpos).filtro.organismos).toBeUndefined();
    await expect(page.getByRole('button', { name: /^Quitar filtro OT/ })).toHaveCount(0);

    await page.getByRole('button', { name: 'Limpiar todo' }).click();
    await expect.poll(() => ultimo(cuerpos).filtro.flitEstados).toBeUndefined();
    expect(ultimo(cuerpos).filtro).toMatchObject({ companiaIds: [1], rango: { preset: 'anio' } });
  });

  test('vacío con filtros: «Quitar filtros» vacía compañías y «Más filtros» y conserva el periodo', async ({ page }) => {
    const cuerpos = await preparar(page, (c) => ({ body: c.filtro.companiaIds ? VACIO : SIMPLE }), { periodo: 'anio', companiaIds: [6], tiposTramite: ['TRASPASO'] });
    await page.goto('/flito/torre/explorador');
    await expect(resultado(page)).toHaveAttribute('data-estado', 'vacio');
    await expect(resultado(page).getByText('Ningún trámite cumple esta consulta.')).toBeVisible();
    await resultado(page).getByRole('button', { name: 'Quitar filtros' }).click();
    await expect(resultado(page)).toHaveAttribute('data-estado', 'lleno');
    expect(ultimo(cuerpos).filtro).toEqual({ rango: { preset: 'anio' } });
  });
});

test.describe('Torre · coincidencias de placa (Épica #14590)', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('2 caracteres: pista sin petición; 3+: POST con el texto en el cuerpo, 8 placas, pie «hay más» y ↓↓ + Enter abre la ficha', async ({ page }) => {
    await preparar(page, () => ({ body: SIMPLE }));
    const sugerencias: unknown[] = [];
    await page.route('**/api/flito/torre/placa/sugerencias', async (route) => {
      sugerencias.push(route.request().postDataJSON());
      await route.fulfill(json(SUGERENCIAS));
    });
    const busquedas: unknown[] = [];
    await page.route('**/api/flito/torre/placa/buscar', async (route) => {
      busquedas.push(route.request().postDataJSON());
      await route.fulfill(json({ placa: 'XXX003', tramites: [FICHA] }));
    });
    await page.goto('/flito/torre/explorador');
    const buscador = page.getByRole('combobox', { name: /Buscar placa/ });

    await buscador.fill('xx');
    await expect(listaPlaca(page).getByText('Escriba al menos 3 caracteres para ver coincidencias.')).toBeVisible();
    await expect(buscador).toHaveAttribute('aria-expanded', 'true');
    await page.waitForTimeout(400);
    expect(sugerencias).toHaveLength(0);

    await buscador.pressSequentially('x0');
    const lista = page.getByRole('listbox', { name: 'Coincidencias de placa' });
    await expect(lista.getByRole('option')).toHaveCount(8);
    for (const s of sugerencias) expect(s).toEqual({ texto: 'XXX0' });
    await expect(lista.getByRole('option').first()).toHaveAccessibleName('XXX001 · Compañía Demo A · Aprobado');
    await expect(lista.getByRole('option').first().locator('strong')).toHaveText('XXX0');
    await expect(listaPlaca(page).getByText('Hay más coincidencias: siga escribiendo.')).toBeVisible();

    await buscador.press('ArrowDown');
    await buscador.press('ArrowDown');
    await expect(lista.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(buscador).toHaveAttribute('aria-activedescendant', await lista.getByRole('option').nth(1).getAttribute('id') ?? '');
    await expect(buscador).toBeFocused();
    await buscador.press('Enter');

    await expect(page.getByRole('dialog', { name: 'Ficha de la placa' })).toBeVisible();
    for (const b of busquedas) expect(b).toEqual({ placa: 'XXX003' });
    expect(page.url()).not.toMatch(/xxx/i);
    const almacenado = await page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }));
    expect(almacenado).not.toMatch(/XXX0/);
  });

  test('Esc cierra solo la lista y conserva el texto; Enter sin resaltado se comporta como siempre', async ({ page }) => {
    await preparar(page, () => ({ body: SIMPLE }));
    await page.route('**/api/flito/torre/placa/sugerencias', (route) => route.fulfill(json(SUGERENCIAS)));
    const busquedas: unknown[] = [];
    await page.route('**/api/flito/torre/placa/buscar', async (route) => {
      busquedas.push(route.request().postDataJSON());
      await route.fulfill(json({ placa: 'XXX001', tramites: [{ ...FICHA, placa: 'XXX001' }] }));
    });
    await page.goto('/flito/torre/explorador');
    const buscador = page.getByRole('combobox', { name: /Buscar placa/ });
    await buscador.fill('XXX001');
    const lista = page.getByRole('listbox', { name: 'Coincidencias de placa' });
    await expect(lista.getByRole('option')).toHaveCount(8);
    await buscador.press('Escape');
    await expect(lista).toBeHidden();
    await expect(buscador).toHaveValue('XXX001');
    await buscador.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Ficha de la placa' })).toBeVisible();
    expect(busquedas[0]).toEqual({ placa: 'XXX001' });
  });

  test('sin coincidencias y error con «Reintentar» (sin el error crudo)', async ({ page }) => {
    await preparar(page, () => ({ body: SIMPLE }));
    let falla = true;
    await page.route('**/api/flito/torre/placa/sugerencias', async (route) => {
      await route.fulfill(falla ? json({ error: 'boom interno' }, 500) : json({ sugerencias: [], hayMas: false }));
    });
    await page.goto('/flito/torre/explorador');
    const buscador = page.getByRole('combobox', { name: /Buscar placa/ });
    await buscador.fill('XQZ');
    await expect(listaPlaca(page).getByText('No pudimos traer coincidencias. Puede escribir la placa completa y pulsar Enter.')).toBeVisible();
    await expect(page.getByText('boom interno')).toHaveCount(0);
    falla = false;
    await listaPlaca(page).getByRole('button', { name: 'Reintentar' }).click();
    await expect(listaPlaca(page).getByText('Ninguna placa contiene «XQZ». Revise que esté bien escrita.')).toBeVisible();
    await expect(buscador).toBeFocused();
  });
});
