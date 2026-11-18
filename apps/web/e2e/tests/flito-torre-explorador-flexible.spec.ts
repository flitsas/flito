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
    // Vistas flexibles (spec §4): la cabecera temporal lleva la etiqueta corta del eje, desde la clave ISO.
    await expect(tabla.getByRole('columnheader')).toHaveText(['Compañía', ...MESES.map((m) => `${m.toLowerCase()} 2026`), 'Total']);
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

// ── Vistas flexibles (Épica #14590, spec UX docs/ux/flito-torre-vistas-flexibles.md, RN-TOR-K1..K5, W2) ──────────

type CuerpoVista = Cuerpo & { top?: number; comparar?: boolean };

const HOY_FIJO = new Date('2026-11-18T15:00:00.000Z'); // 10:00 en Bogotá
const OCHO = ['A', 'B', 'D', 'C', 'E', 'F', 'G', 'H'].map((l, i) => ({
  clave: String(i + 1), etiqueta: `Compañía Demo ${l}`, valor: [398, 231, 142, 130, 112, 40, 30, 19][i],
  n: [398, 231, 142, 130, 112, 40, 30, 19][i], participacion: [36.1, 21, 12.9, 11.8, 10.2, 3.6, 2.7, 1.7][i],
}));
const SIMPLE_OCHO = { ...SIMPLE, total: { valor: 1102, n: 1102 }, filas: OCHO };
const ANTERIOR = {
  rango: { desde: '2025-12-11', hasta: '2026-05-31' }, total: { valor: 984, n: 984 }, variacion: 12, en: 'relativa',
  filas: OCHO.map((f, i) => ({ clave: f.clave, valor: [350, 240, 120, null, 112, 30, 40, 92][i], variacion: [13.7, -3.8, 18.3, null, 0, 33.3, -25, -79.3][i] })),
};
const COMPARADO = { ...SIMPLE_OCHO, anterior: ANTERIOR };
const ANTERIOR_VACIO = { ...SIMPLE_OCHO, anterior: { ...ANTERIOR, total: { valor: 0, n: 0 }, variacion: null, filas: OCHO.map((f) => ({ clave: f.clave, valor: null, variacion: null })) } };

// 25 semanas (1 jun → 16 nov) × 3 compañías: la del pedido «compañía × semana en 6 meses».
const LUNES = Array.from({ length: 25 }, (_, i) => new Date(Date.UTC(2026, 5, 1 + 7 * i)).toISOString().slice(0, 10));
const SERIES_SEMANA: [string, number][] = [['Compañía Demo A', 30], ['Compañía Demo B', 18], ['Compañía Demo C', 9]];
const CRUCE_SEMANA = {
  ...BASE, metrica: 'tramites', unidad: 'conteo', truncado: false,
  total: { valor: 25 * 57, n: 25 * 57 },
  filas: SERIES_SEMANA.map(([e, v], i) => ({ clave: String(i + 1), etiqueta: e, valor: v * 25, n: v * 25, participacion: (v / 57) * 100 })),
  cruce: {
    agrupacion: 'semana', truncadoColumnas: false,
    columnas: LUNES.map((l) => ({ clave: l, etiqueta: l, valor: 57, n: 57, participacion: 4 })),
    celdas: SERIES_SEMANA.map(([, v]) => LUNES.map(() => ({ valor: v, n: v }))),
  },
};

const atajos = (page: Pagina) => page.getByRole('group', { name: 'Atajos de periodo' });
const desde = (page: Pagina) => page.getByLabel('Desde', { exact: true });
const hasta = (page: Pagina) => page.getByLabel('Hasta', { exact: true });

test.describe('Torre · vistas flexibles: barra de fechas, eje legible, Top, % y comparar (Épica #14590)', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(HOY_FIJO); });

  test('atajo → campos con sus fechas; editar a mano desmarca y manda el rango; «Mes» llena el mes y «Hoy» lo devuelve', async ({ page }) => {
    const cuerpos = await preparar(page, () => ({ body: SIMPLE }));
    await page.goto('/flito/torre/explorador');
    await expect(resultado(page)).toHaveAttribute('data-estado', 'lleno');
    // Por defecto «Este mes»: 1 → 18 nov, con `max = hoy` en Bogotá.
    await expect(atajos(page).getByRole('button', { name: 'Este mes' })).toHaveAttribute('aria-pressed', 'true');
    await expect(desde(page)).toHaveValue('2026-11-01');
    await expect(hasta(page)).toHaveValue('2026-11-18');
    await expect(hasta(page)).toHaveAttribute('max', '2026-11-18');

    // RN-TOR-F5: «Últimos 6 meses» alineado a mes; la web sigue enviando el preset.
    await atajos(page).getByRole('button', { name: 'Últimos 6 meses' }).click();
    await expect(desde(page)).toHaveValue('2026-06-01');
    await expect(hasta(page)).toHaveValue('2026-11-18');
    await expect.poll(() => ultimo(cuerpos).filtro.rango).toEqual({ preset: 'ultimos_6m' });

    await desde(page).fill('2026-07-01');
    await expect.poll(() => ultimo(cuerpos).filtro.rango).toEqual({ desde: '2026-07-01', hasta: '2026-11-18' });
    await expect(atajos(page).getByRole('button', { pressed: true })).toHaveCount(0);

    await page.getByLabel('Mes', { exact: true }).selectOption({ label: 'Octubre 2026' });
    await expect(desde(page)).toHaveValue('2026-10-01');
    await expect(hasta(page)).toHaveValue('2026-10-31');
    await expect.poll(() => ultimo(cuerpos).filtro.rango).toEqual({ desde: '2026-10-01', hasta: '2026-10-31' });
    await atajos(page).getByRole('button', { name: 'Hoy' }).click();
    await expect(page.getByLabel('Mes', { exact: true })).toHaveValue('');
    await expect(desde(page)).toHaveValue('2026-11-18');
    // Persistencia: sessionStorage, nunca la URL.
    const guardado = await page.evaluate(() => sessionStorage.getItem('flito-torre-filtros'));
    expect(JSON.parse(guardado ?? '{}').periodo).toBe('hoy');
    expect(page.url()).not.toContain('2026');
  });

  test('rango inválido: error en línea con aria-invalid, NINGUNA petición y el último resultado con su aviso', async ({ page }) => {
    const cuerpos = await preparar(page, () => ({ body: SIMPLE }));
    await page.goto('/flito/torre/explorador');
    await expect(resultado(page)).toHaveAttribute('data-estado', 'lleno');
    const antes = cuerpos.length;

    await desde(page).fill('2026-11-20');
    const error = page.locator('[data-torre="error-rango"]');
    await expect(error).toHaveText('⚠ La fecha «Desde» es posterior a «Hasta». Corrija una de las dos.');
    await expect(desde(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(hasta(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText('El resultado corresponde al último periodo válido: 1 nov – 18 nov 2026.')).toBeVisible();
    await expect(resultado(page)).toHaveAttribute('data-estado', 'lleno');
    await expect(atajos(page).getByRole('button', { pressed: true })).toHaveCount(0);

    await hasta(page).fill('');
    await expect(error).toHaveText('⚠ Escriba la fecha completa en «Desde» y en «Hasta».');
    await page.waitForTimeout(300);
    expect(cuerpos.length).toBe(antes);

    // Corregido: vuelve a consultar con el rango propio.
    await desde(page).fill('2026-11-02');
    await hasta(page).fill('2026-11-10');
    await expect.poll(() => ultimo(cuerpos).filtro.rango).toEqual({ desde: '2026-11-02', hasta: '2026-11-10' });
    await expect(error).toHaveText('');
    await expect(desde(page)).not.toHaveAttribute('aria-invalid', 'true');
  });

  test('«Mostrar 5 grupos»: `top: 5` en el cuerpo; ranking y tabla con 5 filas + «Los demás (3)»', async ({ page }) => {
    const cuerpos = await preparar(page, () => ({ body: SIMPLE_OCHO }));
    await page.goto('/flito/torre/explorador');
    await expect(resultado(page)).toHaveAttribute('data-estado', 'lleno');
    expect((ultimo(cuerpos) as CuerpoVista).top).toBe(10);
    await resultado(page).getByLabel('Mostrar').selectOption('5');
    await expect.poll(() => (ultimo(cuerpos) as CuerpoVista).top).toBe(5);
    const tabla = resultado(page).getByRole('table', { name: /Desglose/ });
    await expect(tabla.locator('tbody tr')).toHaveCount(6);
    await expect(tabla.locator('tbody tr').last()).toContainText('Los demás (3)');
    await expect(tabla.locator('tbody tr').last()).toContainText('89');
    // Con «Agrupar por» temporal sola, «Mostrar» no aparece.
    await page.getByLabel('Agrupar por').selectOption('mes');
    await expect(resultado(page).getByLabel('Mostrar')).toHaveCount(0);
  });

  test('comparar: `comparar: true`; cifra «▲ 12,0 % frente a 984» con fechas; Anterior y Variación sin color; «Nuevo»', async ({ page }) => {
    const cuerpos = await preparar(page, (c) => ({ body: c.agrupacionColumnas ? CRUCE : (c as CuerpoVista).comparar ? COMPARADO : SIMPLE_OCHO }));
    await page.goto('/flito/torre/explorador');
    await expect(resultado(page)).toHaveAttribute('data-estado', 'lleno');
    expect((ultimo(cuerpos) as CuerpoVista).comparar).toBeUndefined();
    const sw = resultado(page).getByRole('switch', { name: 'Comparar con el periodo anterior' });
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => (ultimo(cuerpos) as CuerpoVista).comparar).toBe(true);
    const cmp = resultado(page).locator('[data-torre="comparacion"]');
    await expect(cmp.locator('[data-torre="variacion"] [aria-hidden="true"]')).toHaveText('▲ 12,0 %');
    await expect(cmp).toContainText('frente a 984');
    await expect(cmp).toContainText('Periodo anterior: 11 dic 2025 – 31 may 2026');
    await expect(cmp.locator('.sr-only')).toHaveText('sube 12,0 %');
    const tabla = resultado(page).getByRole('table', { name: /Desglose/ });
    await expect(tabla.getByRole('columnheader', { name: 'Anterior' })).toBeVisible();
    await expect(tabla.getByRole('columnheader', { name: 'Variación' })).toBeVisible();
    const filaC = tabla.locator('tbody tr', { hasText: 'Compañía Demo C' });
    await expect(filaC).toContainText('Nuevo');
    await expect(tabla.locator('tbody tr', { hasText: 'Compañía Demo E' })).toContainText('= 0,0 %');
    // Sin verde ni rojo: la variación va en la tinta secundaria.
    const color = await filaC.locator('[data-torre="variacion"]').evaluate((e) => getComputedStyle(e).color);
    const secundaria = await page.evaluate(() => {
      const p = document.createElement('p'); p.style.color = 'var(--flit-text-secondary)'; document.body.append(p);
      const c = getComputedStyle(p).color; p.remove(); return c;
    });
    expect(color).toBe(secundaria);
    // Persistido (sessionStorage, no URL).
    expect(JSON.parse((await page.evaluate(() => sessionStorage.getItem('flito-torre-vista'))) ?? '{}').comparar).toBe(true);
    // En el cruce el switch no se ofrece y se apaga (sin `comparar` en el cuerpo).
    await page.getByRole('button', { name: 'Aprobados por compañía y mes' }).click();
    await expect.poll(() => ultimo(cuerpos).agrupacionColumnas).toBe('mes');
    expect((ultimo(cuerpos) as CuerpoVista).comparar).toBeUndefined();
    await expect(resultado(page).getByRole('switch')).toHaveCount(0);
  });

  test('comparar con el periodo anterior sin datos: «Sin datos en el periodo anterior (…)» y «Nuevo» en las filas', async ({ page }) => {
    await preparar(page, (c) => ({ body: (c as CuerpoVista).comparar ? ANTERIOR_VACIO : SIMPLE_OCHO }));
    await page.goto('/flito/torre/explorador');
    await resultado(page).getByRole('switch', { name: 'Comparar con el periodo anterior' }).click();
    await expect(resultado(page).locator('[data-torre="comparacion"]')).toHaveText('Sin datos en el periodo anterior (11 dic 2025 – 31 may 2026)');
    await expect(resultado(page).getByRole('table', { name: /Desglose/ }).locator('tbody tr').first()).toContainText('Nuevo');
  });

  test('«Valores %» en el cruce compañía × mes: cada columna suma 100 % y el tfoot cierra en 100 %', async ({ page }) => {
    await preparar(page, porRespuesta);
    await page.goto('/flito/torre/explorador');
    await page.getByRole('button', { name: 'Aprobados por compañía y mes' }).click();
    await expect(resultado(page)).toHaveAttribute('data-forma', 'cruzado');
    await resultado(page).getByRole('group', { name: 'Valores: absoluto o porcentaje' }).getByRole('button', { name: '%' }).click();
    const tabla = resultado(page).locator('[data-torre="tabla-cruzada"]');
    await expect(tabla).toHaveAttribute('data-valores', 'pct');
    await expect(tabla.locator('tfoot td')).toHaveText(Array(7).fill('100 %'));
    const columnas = await tabla.locator('tbody tr').evaluateAll((filas) => {
      const n = (t: string) => Number(t.replace(/\s|%/g, '').replace(',', '.'));
      const sumas: number[] = [];
      for (const f of filas) [...f.querySelectorAll('td')].slice(0, 6).forEach((td, j) => { sumas[j] = (sumas[j] ?? 0) + n(td.textContent ?? '0'); });
      return sumas;
    });
    expect(columnas).toHaveLength(6);
    for (const s of columnas) expect(Math.abs(s - 100)).toBeLessThanOrEqual(0.6);
  });

  test('compañía × semana (25 cortes): gráfica a todo el ancho, rótulos espaciados sin encimarse y cabeceras cortas; a 375 se desliza', async ({ page }) => {
    await preparar(page, (c) => ({ body: c.agrupacionColumnas ? CRUCE_SEMANA : SIMPLE }));
    await page.goto('/flito/torre/explorador');
    await page.getByRole('button', { name: 'Aprobados por compañía y mes' }).click();
    const grafica = resultado(page).locator('[data-torre="grafica-series"]');
    await expect(grafica).toBeVisible();
    const anchoTarjeta = (await resultado(page).boundingBox())!.width;
    expect((await grafica.boundingBox())!.width).toBeGreaterThan(anchoTarjeta * 0.85);
    // 25 marcas (todas con tick y columna de tip) y 13 rótulos «1 jun», «15 jun»… (paso 2).
    await expect(grafica.locator('.grafico__marca')).toHaveCount(25);
    await expect(grafica.locator('.grafico__columna')).toHaveCount(25);
    const rotulos = grafica.locator('[data-rotulo="x"]');
    await expect(rotulos).toHaveCount(13);
    await expect(rotulos.nth(1)).toHaveText('15 jun');
    const cajas = await rotulos.evaluateAll((ts) => ts.map((t) => t.getBoundingClientRect()).map((r) => ({ x: r.left, fin: r.right })));
    for (let i = 1; i < cajas.length; i++) expect(cajas[i].x).toBeGreaterThan(cajas[i - 1].fin);
    // Cabeceras de la tabla cruzada con la etiqueta corta.
    await expect(resultado(page).locator('[data-torre="tabla-cruzada"] thead')).toContainText('8 jun');
    // Tip con la etiqueta larga.
    await grafica.locator('.grafico__columna').nth(1).hover();
    await expect(grafica.locator('.grafico__tip')).toContainText('Semana del 8 al 14 jun 2026');

    await page.setViewportSize({ width: 375, height: 812 });
    const region = grafica.getByRole('region', { name: /desplazable/ });
    await expect(region).toBeVisible();
    await expect(grafica.getByText('Deslice para ver todos los cortes.')).toBeVisible();
    await expect.poll(() => region.evaluate((e) => e.scrollLeft)).toBeGreaterThan(0);
    const sinDesborde = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    expect(sinDesborde).toBe(true);
  });
});
