// HU #12171 (Feature #12072) — Historial de cambios en usuarios, roles y permisos: la pestaña
// «Historial» de `/users` y la vista única del auditor.
//
// El backend va mockeado con `page.route`, como el resto de la carpeta: estos casos certifican la
// PANTALLA —qué pide, qué pinta y qué NO pinta—, no la consulta SQL. Cubre las Tasks #12391–#12395.
//
// Método (apuntes de `users-reporte.spec.ts` que aquí también aplican):
//
//   1. **El filtro se afirma por las DOS puntas.** Que la tabla cambie también es cierto si la
//      pantalla filtra en el cliente; lo que mata ese mutante es `pedidos.at(-1)` con el parámetro.
//   2. **`TZ=UTC` es obligatorio** para el caso de `hasta + 1 día`: en -05 un rango mal calculado
//      sobrevive al mutante. Se corre `TZ=UTC QA_AXE_CDN=1 npx playwright test e2e/tests/users-historial.spec.ts`.
//   3. **Las páginas del auditor llegan de `/me` mockeado** con `users`: que la 0182 se lo siembre lo
//      prueba el API. Aquí se prueba lo que la pantalla hace con eso.
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER, AUDITOR_USER } from '../helpers/auth';
import { cargarAxe, correrAxe, esperarSinViolacionesGraves } from '../helpers/axe';

type Item = Record<string, unknown>;

const ACTOR = { userId: 1, email: 'admina@test.local', rol: 'admin' };
const TITULAR = { userId: 7, username: 'audita', rol: 'auditor' };

/** Una fila con la forma COMPLETA del DTO; se sobreescribe lo que el caso necesita. */
function fila(over: Item): Item {
  return {
    id: 1, loteId: 'lote-1', entidad: 'usuario', accion: 'editar', campo: 'role',
    valorAntes: 'compliance', valorDespues: 'auditor', titular: TITULAR, rolAfectado: null,
    actor: ACTOR, origen: 'usuario', motivo: null, creadoEn: '2026-09-09T14:32:00.000Z', ...over,
  };
}

const CODIGOS_12 = Array.from({ length: 12 }, (_, i) => `op.${i}`);

/** El fixture del TC-16: un lote de 3, password, borrar, reconstruido, alta de 20, sistema, motivo. */
const ITEMS_DIFF: Item[] = [
  fila({ id: 1, loteId: 'L1', campo: 'role', valorAntes: 'compliance', valorDespues: 'auditor', motivo: 'cambia de área' }),
  fila({ id: 2, loteId: 'L1', campo: 'allowed_pages', valorAntes: { conjunto: ['c', ...CODIGOS_12.slice(2)] }, valorDespues: { conjunto: CODIGOS_12, concedidas: ['b', 'a'], revocadas: ['c'] } }),
  fila({ id: 3, loteId: 'L1', campo: 'active', valorAntes: true, valorDespues: false, accion: 'desactivar' }),
  fila({ id: 4, loteId: 'L2', campo: 'password', valorAntes: null, valorDespues: null }),
  fila({ id: 5, loteId: 'L3', entidad: 'rol', accion: 'borrar', campo: null, valorAntes: null, valorDespues: null, titular: null, rolAfectado: 'consulta_contable' }),
  fila({ id: 6, loteId: 'L4', origen: 'auditoria', campo: 'transito_codigo', valorAntes: '11001', valorDespues: '05001' }),
  fila({ id: 7, loteId: 'L5', entidad: 'rol_funcion', accion: 'crear', campo: 'conjunto', valorAntes: null, valorDespues: { conjunto: Array.from({ length: 20 }, (_, i) => `f.${String(i).padStart(2, '0')}`) }, titular: null, rolAfectado: 'financiera' }),
  fila({ id: 8, loteId: 'L6', campo: 'deleted_at', valorAntes: null, valorDespues: '2026-09-08T09:10:00.000Z', accion: 'baja', actor: { userId: null, email: null, rol: null } }),
  // HU #12087: excepciones codificadas se leen como «Excepciones nuevas / retiradas» + Añadido/Quitado.
  fila({
    id: 9, loteId: 'L7', entidad: 'usuario_funcion', accion: 'editar', campo: 'conjunto',
    valorAntes: { conjunto: ['conceder:pagina.rndc'] },
    valorDespues: {
      conjunto: ['revocar:pagina.users'],
      concedidas: ['revocar:pagina.users'],
      revocadas: ['conceder:pagina.rndc'],
    },
  }),
];

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

const respuesta = (items: Item[], over: Item = {}) => ({ items, total: items.length, limite: 50, offset: 0, desdeCuando: '2026-09-01T12:00:00.000Z', ...over });

/**
 * Mock del historial. `pedidos` guarda cada URL para afirmar QUÉ se pidió; `responder` decide el
 * cuerpo por petición. El de titulares se registra DESPUÉS porque Playwright resuelve la última
 * ruta que casa y `/users/auditoria/titulares` también casa con el patrón del historial si este
 * fuera laxo: aquí el `\?` lo impide, pero el orden se mantiene por claridad.
 */
function mockHistorial(page: Page, responder: (url: URL) => ReturnType<typeof json>, titulares: unknown[] = [TITULAR]) {
  const pedidos: string[] = [];
  page.route(/\/api\/users\/auditoria\?/, (route) => {
    const url = new URL(route.request().url());
    pedidos.push(url.toString());
    return route.fulfill(responder(url));
  });
  page.route(/\/api\/users\/auditoria\/titulares$/, (route) => route.fulfill(json(titulares)));
  return pedidos;
}

/** Entra como admin y abre la pestaña Historial. */
async function abrirHistorial(page: Page) {
  await loginAs(page, ADMIN_USER);
  await page.goto('/users');
  await page.getByRole('tab', { name: 'Historial' }).click();
}

const panel = (page: Page) => page.getByRole('region', { name: 'Historial de cambios en usuarios, roles y permisos' });
const urlLimpia = (page: Page) => {
  const u = new URL(page.url());
  return { pathname: u.pathname, search: u.search, hash: u.hash };
};

test.describe('Usuarios — Historial de cambios (HU #12171)', () => {
  test('TC-15a: cargando — fila role="status" con el copy y los filtros operables', async ({ page }) => {
    // El mock retiene la respuesta: la pantalla se queda en el primer estado.
    await page.route(/\/api\/users\/auditoria\?/, () => new Promise(() => { /* nunca responde */ }));
    await page.route(/\/api\/users\/auditoria\/titulares$/, (route) => route.fulfill(json([TITULAR])));
    await abrirHistorial(page);

    const cargando = page.getByRole('status').filter({ hasText: 'Cargando el historial…' });
    await expect(cargando).toBeVisible();
    await expect(page.getByLabel('Usuario', { exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Roles' })).toBeEnabled();
  });

  test('TC-15b: error 500 — role="alert", mensaje del servidor y Reintentar dispara un SEGUNDO GET', async ({ page }) => {
    let falla = true;
    const pedidos = mockHistorial(page, () => (falla ? json({ error: 'Base caída' }, 500) : json(respuesta([fila({})]))));
    await abrirHistorial(page);

    const alerta = page.getByRole('alert');
    await expect(alerta).toContainText('No se pudo cargar el historial.');
    await expect(alerta).toContainText('Base caída');
    // El mutante: un solo texto para vacío y error; y el suelo temporal pintado bajo el error.
    await expect(page.getByText(/Todavía no hay cambios/)).toHaveCount(0);
    await expect(page.getByText(/El historial comienza/)).toHaveCount(0);
    await expect(page.getByText(/Lo anterior está en la bitácora/)).toHaveCount(0);
    expect(pedidos).toHaveLength(1);

    await cargarAxe(page);
    esperarSinViolacionesGraves(await correrAxe(page), 'historial · error');

    falla = false;
    await page.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(panel(page).locator('tbody tr')).toHaveCount(1);
    expect(pedidos).toHaveLength(2);
    await expect(page.getByText(/El historial comienza el 1 de septiembre de 2026/)).toBeVisible();
  });

  test('TC-15c: vacío A con y sin desdeCuando; vacío B con filtro y «Quitar filtros»', async ({ page }) => {
    let conSuelo = true;
    const pedidos = mockHistorial(page, () => json(respuesta([], { desdeCuando: conSuelo ? '2026-09-01T12:00:00.000Z' : null })));
    await abrirHistorial(page);

    await expect(page.getByText('Todavía no hay cambios registrados desde el 1 de septiembre de 2026. Cuando alguien cree o edite un usuario, un rol o sus funciones, aparecerá aquí.')).toBeVisible();
    await expect(page.getByText('El historial comienza el 1 de septiembre de 2026. Los cambios anteriores a esa fecha no se registraron con este detalle.')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);

    // Vacío B: con un filtro puesto el copy es otro y ofrece el siguiente paso.
    await page.getByRole('button', { name: 'Roles' }).click();
    await expect(page.getByRole('button', { name: 'Roles' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Ningún cambio coincide con estos filtros. Amplía el rango de fechas o quita el filtro de usuario o de recurso.')).toBeVisible();
    expect(pedidos.at(-1)).toContain('entidad=rol');

    await page.getByRole('button', { name: 'Quitar filtros' }).click();
    await expect(page.getByText(/Todavía no hay cambios registrados desde/)).toBeVisible();
    expect(pedidos.at(-1)).not.toContain('entidad=');
    expect(pedidos.at(-1)).not.toContain('titularUserId=');
    expect(pedidos.at(-1)).not.toContain('desde=');
    expect(pedidos.at(-1)).not.toContain('hasta=');
    await expect(page.getByRole('button', { name: 'Todos' }).first()).toHaveAttribute('aria-pressed', 'true');

    // Sin `desdeCuando` (tabla vacía) el copy no inventa una fecha.
    conSuelo = false;
    await page.getByRole('button', { name: 'Usuarios', exact: true }).click();
    await page.getByRole('button', { name: 'Todos' }).first().click();
    await expect(page.getByText('Todavía no hay cambios registrados. Aparecerán aquí a partir del primer cambio en un usuario, un rol o sus funciones.')).toBeVisible();
    await expect(page.getByText(/El historial comienza/)).toHaveCount(0);
  });

  test('TC-15d: lleno — tabla + region viva «128 cambios · página 1 de 3»; axe limpio', async ({ page }) => {
    const pagina = Array.from({ length: 50 }, (_, i) => fila({ id: i + 1 }));
    mockHistorial(page, () => json(respuesta(pagina, { total: 128 })));
    await abrirHistorial(page);

    await expect(panel(page).locator('tbody tr')).toHaveCount(50);
    const vivo = page.getByRole('status').filter({ hasText: /cambios · página/ });
    await expect(vivo).toContainText('128 cambios · página 1 de 3');

    await cargarAxe(page);
    esperarSinViolacionesGraves(await correrAxe(page), 'historial · lleno');
  });

  test('TC-15e: un 403 se pinta como error, no como vacío', async ({ page }) => {
    mockHistorial(page, () => json({ error: 'Sin permisos para esta operación' }, 403));
    await abrirHistorial(page);
    await expect(page.getByRole('alert')).toContainText('No se pudo cargar el historial.');
    await expect(page.getByText(/Todavía no hay cambios/)).toHaveCount(0);
  });

  test('TC-16: diff legible, escalares con etiqueta, password sin valores, borrar con «—», una fila por cambio', async ({ page }) => {
    mockHistorial(page, () => json(respuesta(ITEMS_DIFF)));
    await abrirHistorial(page);

    const filas = panel(page).locator('tbody tr');
    // 9 items → 9 <tr>: el lote L1 (3 filas) NO se agrupa.
    await expect(filas).toHaveCount(9);
    for (let i = 0; i < 9; i++) {
      const celdas = filas.nth(i).locator('td');
      await expect(celdas).toHaveCount(4);
      for (let c = 0; c < 4; c++) expect((await celdas.nth(c).innerText()).trim()).not.toBe('');
    }

    // Conjunto: la palabra, el conteo y lo que queda. Ordenados por código.
    const lista = filas.nth(1).locator('ul');
    await expect(lista).toContainText('Añadidas (2): a · b');
    await expect(lista).toContainText('Quitadas (1): c');
    await expect(lista).toContainText('Quedan 12');
    // Escalares con etiqueta de negocio: nunca true/false/null.
    await expect(filas.nth(0)).toContainText('Cumplimiento');
    await expect(filas.nth(0)).toContainText('Auditor');
    await expect(filas.nth(0)).toContainText('Motivo: cambia de área');
    await expect(filas.nth(2)).toContainText('Activo → Inactivo');
    await expect(filas.nth(2)).toContainText('Estado');
    const texto = await panel(page).innerText();
    expect(texto).not.toMatch(/\btrue\b|\bfalse\b|\bnull\b/);
    // password: el hecho sin valor.
    await expect(filas.nth(3)).toContainText('Contraseña restablecida');
    expect(await filas.nth(3).innerText()).not.toContain('→');
    // borrar: «Rol borrado», «—» y el sr-only.
    await expect(filas.nth(4)).toContainText('Rol borrado');
    await expect(filas.nth(4).locator('td').nth(3)).toContainText('—');
    await expect(filas.nth(4).locator('.sr-only', { hasText: 'Sin valor' })).toHaveCount(1);
    // origen auditoria: « · reconstruido» con title y el mismo texto accesible.
    await expect(filas.nth(5).locator('[title]')).toHaveAttribute('title', /Reconstruido desde la auditoría/);
    await expect(filas.nth(5).locator('.sr-only', { hasText: /reconstruido/ })).toHaveCount(1);
    // Alta de 20: se cortan a 12 y se dice cuántas faltan.
    await expect(filas.nth(6)).toContainText('Asignadas (20):');
    await expect(filas.nth(6)).toContainText('… y 8 más');
    await expect(filas.nth(6)).toContainText('f.11');
    await expect(filas.nth(6)).not.toContainText('f.12');
    // Sistema, baja y la fecha en `medium`.
    await expect(filas.nth(7)).toContainText('Sistema');
    await expect(filas.nth(7)).toContainText('En alta → Dado de baja');
    // HU #12087: usuario_funcion decodifica excepciones.
    await expect(filas.nth(8)).toContainText('Excepciones nuevas (1)');
    await expect(filas.nth(8)).toContainText(/Quitado ·/);
    await expect(filas.nth(8)).toContainText('Excepciones retiradas (1)');
    await expect(filas.nth(8)).toContainText(/Añadido ·/);
    // Chromium/es-CO: «9 de sept de 2026, 14:32» — día, mes abreviado, año completo y hora de 24 h.
    await expect(filas.nth(0)).toContainText(/9 de sept\.? de 2026, 14:32/);
  });

  test('TC-17a: el auditor ve solo el historial y no dispara GET a las cinco rutas de la gestión', async ({ page }) => {
    // Las cinco rutas REALES de la gestión (`UsersGestion.tsx`, `CompaniaField.tsx`, `AtaduraFields.tsx`):
    // el listado, el resumen y los tres catálogos de `/api/flito/parametrizacion/…`. Un patrón que no
    // casa con la URL real es un centinela que nunca dispara: se midieron con `grep api.get`.
    const prohibidas = [
      /\/api\/users(\?.*)?$/,
      /\/api\/users\/resumen/,
      /\/api\/flito\/parametrizacion\/companias/,
      /\/api\/flito\/parametrizacion\/proveedores-soat/,
      /\/api\/flito\/parametrizacion\/organismos/,
    ];
    const disparos: string[] = [];
    page.on('request', (req) => {
      const { pathname, search } = new URL(req.url());
      if (prohibidas.some((p) => p.test(pathname + search))) disparos.push(pathname + search);
    });
    const pedidos = mockHistorial(page, () => json(respuesta([fila({})])));
    let titularesPedidos = 0;
    await page.route(/\/api\/users\/auditoria\/titulares$/, (route) => { titularesPedidos++; return route.fulfill(json([TITULAR])); });

    await loginAs(page, { ...AUDITOR_USER, allowedPages: ['users'] });
    await page.goto('/users');

    await expect(page.getByRole('heading', { name: 'Usuarios', exact: true })).toBeVisible();
    await expect(page.getByText('Historial de cambios en usuarios, roles y permisos').first()).toBeVisible();
    await expect(panel(page).locator('tbody tr')).toHaveCount(1);
    await expect(page.getByRole('tablist')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Nuevo usuario' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /descargar excel/i })).toHaveCount(0);
    await expect(page.getByLabel('Rol', { exact: true })).toHaveCount(0);
    expect(disparos).toEqual([]);
    expect(pedidos).toHaveLength(1);
    expect(titularesPedidos).toBe(1);
  });

  test('TC-17b: el admin tiene dos pestañas accesibles y la primaria solo en «Usuarios»', async ({ page }) => {
    mockHistorial(page, () => json(respuesta([fila({})])));
    await loginAs(page, ADMIN_USER);
    await page.goto('/users');

    const tablist = page.getByRole('tablist', { name: 'Secciones de usuarios' });
    const tabs = tablist.getByRole('tab');
    await expect(tabs).toHaveCount(2);
    const tabUsuarios = tabs.nth(0);
    const tabHistorial = tabs.nth(1);
    await expect(tabUsuarios).toHaveAttribute('aria-selected', 'true');
    await expect(tabUsuarios).toHaveAttribute('aria-controls', /panel-users-usuarios/);
    await expect(tabHistorial).not.toHaveAttribute('aria-controls', /.+/);
    await expect(page.getByRole('button', { name: 'Nuevo usuario' })).toHaveCount(1);
    await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'tab-users-usuarios');

    await tabHistorial.click();
    await expect(tabHistorial).toHaveAttribute('aria-selected', 'true');
    await expect(tabHistorial).toHaveAttribute('aria-controls', /panel-users-historial/);
    await expect(tabUsuarios).not.toHaveAttribute('aria-controls', /.+/);
    await expect(page.getByRole('button', { name: 'Nuevo usuario' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Historial de cambios', exact: true })).toBeFocused();

    // Teclado: ← vuelve a Usuarios (foco en la pestaña), Fin va a Historial, Inicio a Usuarios.
    await tabHistorial.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(tabUsuarios).toBeFocused();
    await expect(tabUsuarios).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: 'Nuevo usuario' })).toHaveCount(1);
    await page.keyboard.press('End');
    await expect(tabHistorial).toBeFocused();
    await expect(tabHistorial).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(tabUsuarios).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Lista de usuarios', exact: true })).toHaveCount(1);
  });

  test('TC-18: ningún id en la URL; filtro por las dos puntas; hasta +1 día; cambio de filtro → offset=0', async ({ page }) => {
    const genericas = Array.from({ length: 50 }, (_, i) => fila({ id: i + 1, titular: { userId: 3, username: 'otro', rol: 'admin' } }));
    const delTitular = [fila({ id: 900, titular: TITULAR })];
    const pedidos = mockHistorial(page, (url) => {
      const conTitular = url.searchParams.get('titularUserId') === '7';
      return json(respuesta(conTitular ? delTitular : genericas, { total: conTitular ? 1 : 128 }));
    });
    await abrirHistorial(page);
    const esperarLimpia = () => expect(urlLimpia(page)).toEqual({ pathname: '/users', search: '', hash: '' });

    // A la página 3 (offset=100).
    const vivo = page.getByRole('status').filter({ hasText: /cambios · página/ });
    await page.getByRole('button', { name: 'Siguiente' }).click();
    await page.getByRole('button', { name: 'Siguiente' }).click();
    await expect(vivo).toContainText('página 3 de 3');
    expect(pedidos.at(-1)).toContain('offset=100');
    esperarLimpia();

    // (a) Usuario: la query lleva el id, la tabla pinta las filas del titular, la URL no lleva nada.
    const select = page.getByLabel('Usuario', { exact: true });
    await expect(select.locator('option', { hasText: 'audita' })).toHaveAttribute('value', '7');
    await select.selectOption('7');
    await expect(panel(page).locator('tbody tr')).toHaveCount(1);
    await expect(panel(page)).toContainText('audita');
    expect(pedidos.at(-1)).toContain('titularUserId=7');
    expect(pedidos.at(-1)).toContain('offset=0');
    await expect(vivo).toContainText('1 cambios · página 1 de 1');
    esperarLimpia();

    // (b) Hasta inclusivo: se manda el día siguiente; Desde tal cual.
    await page.getByLabel('Desde').fill('2026-09-01');
    await page.getByLabel('Hasta').fill('2026-09-10');
    await expect.poll(() => pedidos.at(-1)).toContain('hasta=2026-09-11');
    expect(pedidos.at(-1)).toContain('desde=2026-09-01');
    esperarLimpia();

    // (c) Recurso: offset vuelve a 0 y el pill queda pulsado.
    await select.selectOption('');
    await expect(vivo).toContainText('128 cambios · página 1 de 3');
    await page.getByRole('button', { name: 'Siguiente' }).click();
    await expect(vivo).toContainText('página 2 de 3');
    await page.getByRole('button', { name: 'Roles' }).click();
    await expect.poll(() => pedidos.at(-1)).toContain('entidad=rol');
    expect(pedidos.at(-1)).toContain('offset=0');
    await expect(vivo).toContainText('página 1 de 3');
    await expect(page.getByRole('button', { name: 'Roles' })).toHaveAttribute('aria-pressed', 'true');
    esperarLimpia();

    // (d) Ida y vuelta de pestaña.
    await page.getByRole('tab', { name: 'Usuarios' }).click();
    esperarLimpia();
    await page.getByRole('tab', { name: 'Historial' }).click();
    await expect(vivo).toContainText('página 1 de 3');
    esperarLimpia();

    // (e) Avanzar: offset=50, sin nada en la dirección.
    await page.getByRole('button', { name: 'Siguiente' }).click();
    await expect(vivo).toContainText('página 2 de 3');
    expect(pedidos.at(-1)).toContain('offset=50');
    esperarLimpia();
    // Y la dirección nunca llevó el nombre del titular.
    expect(page.url()).not.toContain('audita');
  });

  test('TC-19: sin PII del titular aunque el DTO la traiga; ningún aria-label ni title con datos', async ({ page }) => {
    const titularConPii = { userId: 7, username: 'titu', rol: 'auditor', email: 'titular@test.local', name: 'Nombre Titular', document: '900123' };
    mockHistorial(page, () => json(respuesta([fila({ titular: titularConPii })])), [titularConPii]);
    await abrirHistorial(page);
    // Primero la fila, luego el texto: `innerText` no espera y leería el estado «Cargando».
    await expect(panel(page).locator('tbody tr')).toHaveCount(1);
    await expect(page.getByLabel('Usuario', { exact: true }).locator('option')).toHaveCount(2);

    const texto = await panel(page).innerText();
    expect(texto).toContain('titu');
    expect(texto).toContain('admina@test.local');
    expect(texto).not.toContain('titular@test.local');
    expect(texto).not.toContain('Nombre Titular');
    expect(texto).not.toContain('900123');
    // El único «@» del panel está en la celda Quién (actor).
    const arrobas = (texto.match(/@/g) ?? []).length;
    expect(arrobas).toBe(1);
    await expect(panel(page).locator('tbody tr td').nth(1)).toContainText('admina@test.local');

    // Ningún atributo accesible lleva datos.
    const atributos = await page.locator('[aria-label], [title]').evaluateAll((nodos) =>
      nodos.map((n) => `${n.getAttribute('aria-label') ?? ''} ${n.getAttribute('title') ?? ''}`));
    for (const a of atributos) {
      expect(a).not.toContain('@');
      expect(a).not.toContain('titu');
    }
    // El select lista usernames, no correos ni nombres.
    const opciones = await page.getByLabel('Usuario', { exact: true }).locator('option').allInnerTexts();
    expect(opciones).toEqual(['Todos', 'titu']);
  });
});
