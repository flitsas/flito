// HU #12085 (Feature #12072) — Roles y permisos: el cuadro rol × función en `/roles-permisos`.
//
// El backend va mockeado con `page.route`, como `users-historial.spec.ts`: estos casos certifican la
// PANTALLA —qué pide, qué pinta y qué NO pinta—, no las rutas del API (eso lo prueba la #12084).
//
// Método:
//   1. **El guardado se afirma por las DOS puntas.** Que la casilla cambie también es cierto si la
//      pantalla no manda nada; lo que mata ese mutante es `pedidos.at(-1).postDataJSON()`.
//   2. **AC7 / mutante nombrado:** el `PUT` responde un conjunto DISTINTO del enviado y la rejilla
//      tiene que pintar el del servidor. Una rejilla que recalcule del rol (o del borrador) pone
//      rojo TC-h.
//   3. `TZ=UTC QA_AXE_CDN=1 npx playwright test e2e/tests/roles-permisos.spec.ts` (memoria: sin
//      `QA_AXE_CDN=1` salen rojos de axe que no son regresión).
import type { Locator, Page, Request } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER } from '../helpers/auth';
import { cargarAxe, correrAxe, esperarSinViolacionesGraves } from '../helpers/axe';
import { COPY_MARCA_PRIMERO_PANTALLA, COPY_MARCA_PRIMERO_UNA_PANTALLA } from '../../src/pages/roles-permisos/dependencias';

type Item = Record<string, unknown>;

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

const F = (codigo: string, nombreNegocio: string, descripcion: string | null = 'Explicación de la función.', tipo = 'pagina') =>
  ({ codigo, nombreNegocio, descripcion, tipo });

/** Catálogo: 5 módulos con funciones (10 en total) y uno vacío que NO se pinta (vacío D). */
const GRUPOS = [
  { modulo: 'general', funciones: [F('pagina.dashboard', 'Entrar al tablero')] },
  { modulo: 'impuestos', funciones: [
    F('pagina.flito_impuestos', 'Entrar al portal de Impuestos', 'Ve la bandeja de recibos de los organismos que tenga asignados.'),
    F('impuestos.recibo.pagar', 'Marcar un impuesto como pagado', 'Registra el pago del recibo y adjunta el soporte.', 'operacion'),
    F('impuestos.cola.exportar', 'Exportar la cola a Excel', 'Descarga todas las filas que coincidan con el filtro.', 'operacion'),
  ] },
  { modulo: 'permisos', funciones: [F('pagina.roles_permisos', 'Administrar roles y permisos')] },
  { modulo: 'pesv', funciones: [F('pagina.pesv', 'Entrar al tablero PESV'), F('pesv.incidente.crear', 'Registrar un incidente vial', null, 'operacion')] },
  { modulo: 'usuarios', funciones: [F('pagina.users', 'Entrar a Usuarios'), F('usuarios.usuario.exportar', 'Exportar usuarios a Excel', 'Descarga la lista.', 'operacion'), F('usuarios.usuario.crear', 'Crear un usuario', null, 'operacion')] },
  { modulo: 'modulo_sin_filas', funciones: [] },
];
const TODAS = GRUPOS.flatMap((g) => g.funciones.map((f) => f.codigo));
const TOTAL = TODAS.length;

function rol(over: Item): Item {
  return {
    codigo: 'x', nombre: 'X', descripcion: null, tipoEnlace: 'ninguno', tipoPrincipal: 'interno', esSistema: false,
    activo: true, usuarios: 0, borrable: true, motivoNoBorrable: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...over,
  };
}

const ROLES: Item[] = [
  rol({ codigo: 'admin', nombre: 'Administrador', esSistema: true, usuarios: 2, borrable: false, motivoNoBorrable: 'El rol admin es de sistema y no se puede borrar.' }),
  rol({ codigo: 'gestor_impuestos', nombre: 'Gestor de Impuestos', descripcion: 'Atiende la cola de impuestos de los organismos que se le asignen.', tipoEnlace: 'organismos_transito', usuarios: 4, borrable: false, motivoNoBorrable: '4 usuarios tienen este rol' }),
  rol({ codigo: 'consulta_contable', nombre: 'Consulta contable', usuarios: 0 }),
  rol({ codigo: 'cliente', nombre: 'Cliente', tipoEnlace: 'compania', tipoPrincipal: 'externo', usuarios: 3, borrable: false, motivoNoBorrable: '3 usuarios tienen este rol' }),
  rol({ codigo: 'sin_funciones', nombre: 'Sin funciones', usuarios: 0 }),
];

const CUADROS: Record<string, string[]> = {
  admin: [...TODAS],
  gestor_impuestos: ['pagina.flito_impuestos', 'impuestos.recibo.pagar'],
  consulta_contable: ['pagina.dashboard'],
  cliente: ['pagina.dashboard'],
  sin_funciones: [],
};

interface Opciones {
  grupos?: unknown;
  roles?: unknown;
  cuadros?: Record<string, string[]>;
  /** Cuerpo del PUT; por defecto devuelve lo que se envió. */
  put?: (codigo: string, enviadas: string[]) => ReturnType<typeof json>;
  delete?: (codigo: string) => ReturnType<typeof json>;
  post?: (body: Item) => ReturnType<typeof json>;
  patch?: (codigo: string, body: Item) => ReturnType<typeof json>;
  mios?: () => ReturnType<typeof json>;
}

/** Mock de `/api/permisos/*`. Devuelve las peticiones que no son GET, para afirmar cuerpo y método. */
function mockPermisos(page: Page, o: Opciones = {}) {
  const pedidos: Request[] = [];
  const gets: string[] = [];
  const cuadros = o.cuadros ?? CUADROS;
  page.route(/\/api\/permisos\/funciones$/, (route) => { gets.push('funciones'); return route.fulfill(json({ grupos: o.grupos ?? GRUPOS })); });
  page.route(/\/api\/permisos\/mios$/, (route) => { gets.push('mios'); return route.fulfill((o.mios ?? (() => json({ funciones: TODAS, rol: 'admin', tipoPrincipal: 'interno', version: 7, resueltoEn: '2026-09-10T12:00:00.000Z' })))()); });
  page.route(/\/api\/permisos\/roles$/, (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      pedidos.push(req);
      const body = req.postDataJSON() as Item;
      return route.fulfill((o.post ?? ((b: Item) => json({ rol: rol({ ...b, usuarios: 0, borrable: true }) }, 201)))(body));
    }
    gets.push('roles');
    return route.fulfill(json({ roles: o.roles ?? ROLES }));
  });
  page.route(/\/api\/permisos\/roles\/([^/]+)$/, (route) => {
    const req = route.request();
    const codigo = decodeURIComponent(new URL(req.url()).pathname.split('/').at(-1) ?? '');
    pedidos.push(req);
    if (req.method() === 'DELETE') return route.fulfill((o.delete ?? (() => ({ status: 204, body: '' })))(codigo));
    const body = req.postDataJSON() as Item;
    const original = (o.roles ?? ROLES) as Item[];
    return route.fulfill((o.patch ?? ((c: string, b: Item) => json({ rol: { ...original.find((r) => r.codigo === c), ...b } })))(codigo, body));
  });
  page.route(/\/api\/permisos\/roles\/([^/]+)\/funciones$/, (route) => {
    const req = route.request();
    const codigo = decodeURIComponent(new URL(req.url()).pathname.split('/').at(-2) ?? '');
    if (req.method() === 'PUT') {
      pedidos.push(req);
      const enviadas = (req.postDataJSON() as { funciones: string[] }).funciones;
      const responder = o.put ?? ((c: string, f: string[]) => json({ codigo: c, funciones: f, concedidas: [], revocadas: [], aviso: null }));
      return route.fulfill(responder(codigo, enviadas));
    }
    gets.push(`cuadro:${codigo}`);
    return route.fulfill(json({ codigo, tipoPrincipal: codigo === 'cliente' ? 'externo' : 'interno', funciones: cuadros[codigo] ?? [] }));
  });
  return { pedidos, gets };
}

async function abrir(page: Page) {
  // `funciones: null`: `/mios` lo trae `mockPermisos` (cuenta las peticiones y sirve `o.mios`); el
  // mock por defecto de `loginAs` lo taparía al registrarse después.
  await loginAs(page, ADMIN_USER, { funciones: null });
  await page.goto('/roles-permisos');
  await expect(page.getByRole('heading', { name: 'Roles y permisos', level: 1 })).toBeVisible();
}

const lista = (page: Page) => page.getByRole('list').filter({ has: page.getByRole('button', { name: /Administrador/ }) });
const botonRol = (page: Page, nombre: string) => lista(page).getByRole('button', { name: new RegExp(`^${nombre}`) });
/** El encabezado del módulo: `FlitAcordeon` pega «(N)» al título sin espacio, de ahí el `\s?`. */
const modulo = (page: Page, nombre: string) => page.getByRole('button', { name: new RegExp(`^${nombre}\\s?\\(\\d+\\)`) });
const casilla = (page: Page, codigo: string) => page.locator(`input[type="checkbox"][data-codigo="${codigo}"]`);
const urlLimpia = (page: Page) => { const u = new URL(page.url()); return { pathname: u.pathname, search: u.search, hash: u.hash }; };
/** Los encabezados de módulo: el único botón de la pantalla cuyo nombre lleva «(N)». */
const acordeones = (page: Page) => page.locator('main').getByRole('button', { name: /\(\d+\)/ });

// ─── HU #12533 — tres secciones por origen del módulo (ficha §13) ────────────────────────────────
/** Los rótulos de sección: los únicos `h3` de la pantalla. Texto «Título · k de n marcadas». */
const rotulos = (page: Page) => page.locator('main h3');
/**
 * La región de una sección, nombrada por su h3 (`aria-labelledby`): el nombre INCLUYE la cuenta
 * (§13.6), así que se ancla por regex. (El módulo «FLITO (SOAT e Impuestos)» ya no existe: desde la
 * HU #12716 el API agrupa cada pantalla con las acciones de su módulo, p. ej. «Logística».)
 */
const seccion = (page: Page, titulo: string) => page.getByRole('region', { name: new RegExp(`^${titulo} · \\d+ de \\d+ marcadas?$`) });
/** El panel abierto de un módulo, buscado DENTRO de una sección (región anidada). */
const panel = (ambito: Page | Locator, nombre: string) => ambito.getByRole('region', { name: new RegExp(`^${nombre}\\s?\\(\\d+\\)`) });
/** `{ k, n }` de cada rótulo, en orden de DOM. */
const cuentas = async (page: Page) => (await rotulos(page).allTextContents()).map((t) => {
  const m = /· (\d+) de (\d+) marcadas?$/.exec(t);
  if (!m) throw new Error(`Rótulo sin cuenta: «${t}»`);
  return { k: Number(m[1]), n: Number(m[2]) };
});
const TITULOS = ['FLITO', 'Ya existía y FLITO lo usa', 'Existe pero no se usa'] as const;

/**
 * Catálogo como lo devuelve el API desde la HU #12716: cada pantalla en el grupo de su módulo y
 * PRIMERA en él (`pagina.transito` en `transito`, `pagina.drive` en `derechos`, `pagina.flito_logistica`
 * en `logistica`). La única reubicación de presentación que queda (AC3 de la #12533) es
 * `pagina.privacy` → «Privacidad y datos». Más un módulo desconocido y `pesv` vacío.
 */
const GRUPOS_SECCIONES = [
  { modulo: 'operaciones', funciones: [
    F('pagina.vehiculos', 'Vehículos'), F('pagina.soat', 'SOAT'), F('pagina.tramite_digital', 'Trámite Digital'),
    F('pagina.lectura_impuestos', 'Lectura de Impuestos'),
  ] },
  { modulo: 'administracion', funciones: [F('pagina.privacy', 'Privacidad y datos'), F('pagina.admin', 'Administración')] },
  { modulo: 'transito', funciones: [F('pagina.transito', 'Tránsito'), F('transito.bandeja', 'Ver la bandeja de tránsito', null, 'operacion')] },
  { modulo: 'derechos', funciones: [F('pagina.drive', 'Drive'), F('derechos.consultar', 'Consultar derechos de tránsito', null, 'operacion')] },
  { modulo: 'logistica', funciones: [F('pagina.flito_logistica', 'Entrar a Logística'), F('logistica.viaje.crear', 'Registrar un viaje', null, 'operacion')] },
  { modulo: 'impuestos', funciones: GRUPOS[1].funciones },
  { modulo: 'modulo_nuevo_xyz', funciones: [F('nuevo.entrar', 'Entrar al módulo nuevo')] },
  { modulo: 'pesv', funciones: [] },
];
const TODAS_SEC = GRUPOS_SECCIONES.flatMap((g) => g.funciones.map((f) => f.codigo));
const OPERACIONES_PROPIAS = ['pagina.vehiculos', 'pagina.soat', 'pagina.tramite_digital', 'pagina.lectura_impuestos'];
const CUADROS_SEC: Record<string, string[]> = { admin: [...TODAS_SEC], gestor_impuestos: ['pagina.flito_impuestos', 'pagina.drive'] };

/**
 * Las claves del AC2 por sección (30 desde la HU #12716: sin `flito_soat_e_impuestos`, `finanzas`,
 * `parametrizacion` ni `sync`; con `clientes`, `tarifas`, `servicios_adicionales`,
 * `catalogos_compartidos` y `comprobantes`). `GRUPOS_CLAVES` trae una función `x.<clave>` por cada una.
 */
const CLAVES_SECCION: Record<(typeof TITULOS)[number], string[]> = {
  'FLITO': ['soat', 'tramites', 'impuestos', 'derechos', 'revisiones', 'compuerta', 'tablero', 'bitacora', 'logistica', 'bolsas', 'comparendos', 'conciliacion', 'liquidacion', 'clientes', 'tarifas', 'servicios_adicionales', 'catalogos_compartidos', 'comprobantes'],
  'Ya existía y FLITO lo usa': ['general', 'administracion', 'usuarios', 'permisos', 'transito'],
  'Existe pero no se usa': ['flota', 'mantenimiento', 'pesv', 'rndc', 'cumplimiento_laft', 'tramite', 'operaciones'],
};
const N_CLAVES = Object.values(CLAVES_SECCION).flat().length;
const GRUPOS_CLAVES = Object.values(CLAVES_SECCION).flat().map((clave) => ({ modulo: clave, funciones: [F(`x.${clave}`, `Función de ${clave}`)] }));

// ─── HU #12717 — dependencia pantalla → acciones (ficha §14) ─────────────────────────────────────
/**
 * Catálogo con los cuatro casos de §14.1: una pantalla + 5 acciones (Impuestos), dos pantallas + 3
 * acciones (Logística), sin pantalla (Catálogos compartidos) y solo pantalla (General).
 */
const ACCIONES_IMPUESTOS = ['impuestos.recibo.pagar', 'impuestos.cola.exportar', 'impuestos.recibo.anular', 'impuestos.recibo.reasignar', 'impuestos.cola.filtrar'];
const ACCIONES_LOGISTICA = ['logistica.viaje.crear', 'logistica.viaje.cerrar', 'logistica.viaje.exportar'];
const GRUPOS_DEP = [
  { modulo: 'general', funciones: [F('pagina.dashboard', 'Entrar al tablero')] },
  { modulo: 'impuestos', funciones: [
    F('pagina.flito_impuestos', 'Entrar al portal de Impuestos', 'Ve la bandeja de recibos de los organismos que tenga asignados.'),
    F('impuestos.recibo.pagar', 'Marcar un impuesto como pagado', 'Registra el pago del recibo y adjunta el soporte.', 'operacion'),
    F('impuestos.cola.exportar', 'Exportar la cola a Excel', 'Descarga todas las filas que coincidan con el filtro.', 'operacion'),
    F('impuestos.recibo.anular', 'Anular un recibo', null, 'operacion'),
    F('impuestos.recibo.reasignar', 'Reasignar un recibo', null, 'operacion'),
    F('impuestos.cola.filtrar', 'Filtrar la cola', null, 'operacion'),
  ] },
  { modulo: 'logistica', funciones: [
    F('pagina.flito_logistica', 'Entrar a Logística'), F('pagina.flito_logistica_ruta', 'Entrar a la ruta'),
    ...ACCIONES_LOGISTICA.map((c) => F(c, `Acción ${c}`, null, 'operacion')),
  ] },
  { modulo: 'catalogos_compartidos', funciones: [F('catalogos.leer', 'Leer los catálogos', null, 'operacion'), F('catalogos.exportar', 'Exportar los catálogos', null, 'operacion')] },
];
const TODAS_DEP = GRUPOS_DEP.flatMap((g) => g.funciones.map((f) => f.codigo));
/** `consulta_contable` y `cliente` llegan con acciones sin su pantalla (caso 4 de §14.7). */
const CUADROS_DEP: Record<string, string[]> = {
  admin: [...TODAS_DEP],
  gestor_impuestos: ['pagina.flito_impuestos', ...ACCIONES_IMPUESTOS, 'pagina.flito_logistica', 'pagina.flito_logistica_ruta', ...ACCIONES_LOGISTICA],
  consulta_contable: ['impuestos.recibo.pagar', 'impuestos.cola.exportar', 'logistica.viaje.crear'],
  cliente: ['impuestos.recibo.pagar'],
  sin_funciones: [],
};

test.describe('Roles y permisos — cuadro rol × función (HU #12085)', () => {
  test('TC-a (AC1): catálogo agrupado por módulo con total y cuenta; el módulo vacío no se pinta; el código no sale en pantalla', async ({ page }) => {
    const { gets } = mockPermisos(page);
    await abrir(page);

    // 5 módulos con funciones → 5 acordeones; `modulo_sin_filas` no existe. Todo plegado: 0 casillas.
    await expect(acordeones(page)).toHaveCount(5);
    await expect(page.getByText(/Modulo sin filas/i)).toHaveCount(0);
    await expect(page.locator('input[type="checkbox"]')).toHaveCount(0);
    // La lista con la cuenta GUARDADA de cada rol, y el primero (alfabético) seleccionado.
    await expect(botonRol(page, 'Administrador')).toHaveAttribute('aria-current', 'true');
    await expect(botonRol(page, 'Administrador')).toContainText(`${TOTAL}/${TOTAL}`);
    await expect(botonRol(page, 'Gestor de Impuestos')).toContainText(`2/${TOTAL}`);
    await expect(botonRol(page, 'Sin funciones')).toContainText(`0/${TOTAL}`);
    // Encabezado del módulo: etiqueta legible, «(N)» y «k de N marcadas».
    await expect(modulo(page, 'Impuestos')).toContainText('(3)');
    await expect(modulo(page, 'Impuestos')).toContainText('3 de 3 marcadas');
    await expect(modulo(page, 'Roles y permisos')).toContainText('(1)');

    await modulo(page, 'Impuestos').click();
    await expect(page.getByRole('region', { name: /^Impuestos/ }).locator('input[type="checkbox"]')).toHaveCount(3);
    // Nombre de negocio y explicación visibles; el código solo en `data-codigo`.
    await expect(page.getByText('Entrar al portal de Impuestos')).toBeVisible();
    await expect(page.getByText('Ve la bandeja de recibos de los organismos que tenga asignados.')).toBeVisible();
    await expect(casilla(page, 'pagina.flito_impuestos')).toHaveCount(1);
    expect(await page.locator('main').innerText()).not.toContain('pagina.flito_impuestos');
    // La casilla se describe con su explicación.
    const describedBy = await casilla(page, 'pagina.flito_impuestos').getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    await expect(page.locator(`[id="${describedBy}"]`)).toHaveText('Ve la bandeja de recibos de los organismos que tenga asignados.');
    // Ningún cartel de acceso total para admin (AC4): sus casillas están MARCADAS, no ausentes.
    await expect(page.getByText(/acceso total/i)).toHaveCount(0);
    await expect(casilla(page, 'pagina.flito_impuestos')).toBeChecked();
    // Lo que se pidió: catálogo, roles, mios y el cuadro de CADA rol. En `dev` React monta dos
    // veces (StrictMode), así que se afirma la PROPORCIÓN y no el 1: por cada carga, un GET de cada
    // catálogo y un cuadro por rol. `/mios` no va exacto: desde la HU #12170 `AuthProvider` lo pide
    // también por su cuenta al cuajar la sesión (mismo URL, no se puede filtrar), así que se afirma
    // que la pantalla pidió AL MENOS el suyo por carga.
    const cargas = gets.filter((g) => g === 'funciones').length;
    expect(cargas).toBeGreaterThanOrEqual(1);
    expect(gets.filter((g) => g === 'roles')).toHaveLength(cargas);
    expect(gets.filter((g) => g === 'mios').length).toBeGreaterThanOrEqual(cargas);
    expect(gets.filter((g) => g.startsWith('cuadro:'))).toHaveLength(cargas * ROLES.length);
    // En reposo no hay ninguna primaria (decisión 4).
    await expect(page.getByRole('button', { name: 'Guardar cambios' })).toHaveCount(0);
  });

  test('TC-b (AC2): marcar y desmarcar → PUT con el conjunto COMPLETO; la cuenta de la lista se mueve solo al guardar', async ({ page }) => {
    const { pedidos } = mockPermisos(page);
    await abrir(page);
    await botonRol(page, 'Gestor de Impuestos').click();
    await modulo(page, 'Impuestos').click();
    await modulo(page, 'Usuarios').click();

    await casilla(page, 'impuestos.cola.exportar').check();
    await casilla(page, 'pagina.users').check();
    await casilla(page, 'impuestos.recibo.pagar').uncheck();
    await expect(page.getByText('Sin guardar: 2 marcadas, 1 desmarcada')).toBeVisible();
    await expect(modulo(page, 'Impuestos')).toContainText('2 de 3 marcadas');
    await expect(botonRol(page, 'Gestor de Impuestos')).toContainText(`2/${TOTAL}`);
    expect(pedidos).toHaveLength(0);

    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(page.getByText(/ya está aplicado/)).toBeVisible();
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0].method()).toBe('PUT');
    expect(new URL(pedidos[0].url()).pathname).toBe('/api/permisos/roles/gestor_impuestos/funciones');
    // El conjunto entero, no el delta.
    expect(pedidos.at(-1)!.postDataJSON()).toEqual({ funciones: ['impuestos.cola.exportar', 'pagina.flito_impuestos', 'pagina.users'] });
    await expect(botonRol(page, 'Gestor de Impuestos')).toContainText(`3/${TOTAL}`);
    await expect(page.getByRole('button', { name: 'Guardar cambios' })).toHaveCount(0);
  });

  test('TC-c (AC2): aviso de cambios sin guardar, beforeunload registrado y confirm al cambiar de rol', async ({ page }) => {
    mockPermisos(page);
    await abrir(page);
    const disparaBeforeUnload = () => page.evaluate(() => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    });
    // Sin cambios: nada que retener.
    expect(await disparaBeforeUnload()).toBe(false);

    await botonRol(page, 'Gestor de Impuestos').click();
    await modulo(page, 'Impuestos').click();
    await casilla(page, 'impuestos.cola.exportar').check();
    await expect(page.getByText('Sin guardar: 1 marcada')).toBeVisible();
    expect(await disparaBeforeUnload()).toBe(true);

    // Cambiar de rol: el confirm nombra el rol y el número; cancelar deja el cambio puesto.
    const mensajes: string[] = [];
    let aceptar = false;
    page.on('dialog', (d) => { mensajes.push(d.message()); return aceptar ? d.accept() : d.dismiss(); });
    await botonRol(page, 'Administrador').click();
    expect(mensajes.at(-1)).toBe('Tienes 1 cambio sin guardar en el rol Gestor de Impuestos. ¿Salir y perderlos?');
    await expect(botonRol(page, 'Gestor de Impuestos')).toHaveAttribute('aria-current', 'true');
    await expect(casilla(page, 'impuestos.cola.exportar')).toBeChecked();
    await expect(page.getByText('Sin guardar: 1 marcada')).toBeVisible();

    // Aceptar: se pierde y el cuadro nuevo llega plegado.
    aceptar = true;
    await botonRol(page, 'Administrador').click();
    await expect(botonRol(page, 'Administrador')).toHaveAttribute('aria-current', 'true');
    await expect(page.getByText(/Sin guardar/)).toHaveCount(0);
    await expect(page.locator('input[type="checkbox"]')).toHaveCount(0);
    expect(await disparaBeforeUnload()).toBe(false);
    // Y «Volver» con cambios pendientes también pregunta.
    aceptar = false;
    await modulo(page, 'Impuestos').click();
    await casilla(page, 'impuestos.cola.exportar').uncheck();
    await page.getByRole('button', { name: 'Volver' }).click();
    expect(mensajes.at(-1)).toBe('Tienes 1 cambio sin guardar en el rol Administrador. ¿Salir y perderlos?');
    expect(urlLimpia(page)).toEqual({ pathname: '/roles-permisos', search: '', hash: '' });
    // Descartar pide confirmación y devuelve al conjunto guardado.
    aceptar = true;
    await page.getByRole('button', { name: 'Descartar' }).click();
    expect(mensajes.at(-1)).toBe('Vas a perder 1 cambio sin guardar en el rol Administrador. ¿Descartarlos?');
    await expect(casilla(page, 'impuestos.cola.exportar')).toBeChecked();
    await expect(page.getByText(/Sin guardar/)).toHaveCount(0);
  });

  test('TC-d (AC3): crear rol con ámbito y tipo de acceso; el código se deriva del nombre y el nuevo rol queda seleccionado con su vacío', async ({ page }) => {
    const { pedidos } = mockPermisos(page);
    await abrir(page);
    await page.getByRole('button', { name: 'Nuevo rol' }).click();
    const modal = page.getByRole('dialog');
    await expect(modal.getByRole('heading', { name: 'Nuevo rol' })).toBeVisible();

    // Validación local: sin nombre no hay petición y el foco va al campo.
    await modal.getByRole('button', { name: 'Crear rol' }).click();
    await expect(modal.getByRole('alert').filter({ hasText: 'Escribe el nombre del rol.' })).toBeVisible();
    await expect(modal.getByLabel('Nombre del rol')).toBeFocused();
    await expect(modal.getByLabel('Nombre del rol')).toHaveAttribute('aria-invalid', 'true');
    expect(pedidos).toHaveLength(0);

    await modal.getByLabel('Nombre del rol').fill('Gestión Contable');
    await expect(modal.getByText('gestion_contable')).toBeVisible();
    await expect(modal.getByText(/no se puede cambiar después/)).toBeVisible();
    await modal.getByLabel('Descripción').fill('Consulta los cierres contables.');
    await modal.getByLabel('Ámbito de sus usuarios').selectOption('compania');
    await expect(modal.getByText(/habrá que elegirle una compañía/)).toBeVisible();
    await modal.getByRole('radio', { name: /^Externo — solo el canal de cliente/ }).check();
    await expect(modal.getByText('Tipo de acceso', { exact: true })).toBeVisible();
    await modal.getByRole('button', { name: 'Crear rol' }).click();

    expect(pedidos).toHaveLength(1);
    expect(pedidos[0].method()).toBe('POST');
    expect(pedidos[0].postDataJSON()).toEqual({
      codigo: 'gestion_contable', nombre: 'Gestión Contable', descripcion: 'Consulta los cierres contables.', tipoEnlace: 'compania', tipoPrincipal: 'externo',
    });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(botonRol(page, 'Gestión Contable')).toHaveAttribute('aria-current', 'true');
    await expect(botonRol(page, 'Gestión Contable')).toContainText(`0/${TOTAL}`);
    await expect(page.getByText(/quien lo tenga no verá nada al entrar/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Gestión Contable', level: 2 })).toBeVisible();
    // Externo: el aviso general del canal.
    await expect(page.getByText(/Este rol es externo: sus usuarios entran solo al canal de cliente/)).toBeVisible();
    expect(urlLimpia(page)).toEqual({ pathname: '/roles-permisos', search: '', hash: '' });
  });

  test('TC-d2 (AC3): código repetido → el 409 dice cuál; editar manda solo lo que cambió', async ({ page }) => {
    const { pedidos } = mockPermisos(page, { post: () => json({ error: 'Ya existe un rol con ese código' }, 409) });
    await abrir(page);
    await page.getByRole('button', { name: 'Nuevo rol' }).click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('Nombre del rol').fill('Gestor de Impuestos');
    await modal.getByLabel('Descripción').fill('Otra vez.');
    await modal.getByRole('button', { name: 'Crear rol' }).click();
    await expect(modal.getByRole('alert')).toContainText('Ya existe un rol con el código «gestor_de_impuestos». Cambia el nombre.');
    await modal.getByRole('button', { name: 'Cancelar' }).click();

    await botonRol(page, 'Gestor de Impuestos').click();
    await page.getByRole('button', { name: 'Editar rol' }).click();
    const edicion = page.getByRole('dialog');
    await expect(edicion.getByRole('heading', { name: 'Editar el rol Gestor de Impuestos' })).toBeVisible();
    await expect(edicion.getByText(/Código:/)).toHaveCount(0);
    await edicion.getByLabel('Se puede asignar a usuarios nuevos').uncheck();
    await edicion.getByRole('radio', { name: /^Externo/ }).check();
    await expect(edicion.getByText('4 usuarios tienen este rol. Al guardar, dejan de entrar a las pantallas internas de FLITO.')).toBeVisible();
    await edicion.getByRole('button', { name: 'Guardar cambios' }).click();
    const patch = pedidos.at(-1)!;
    expect(patch.method()).toBe('PATCH');
    expect(new URL(patch.url()).pathname).toBe('/api/permisos/roles/gestor_impuestos');
    expect(patch.postDataJSON()).toEqual({ tipoPrincipal: 'externo', activo: false });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(botonRol(page, 'Gestor de Impuestos')).toContainText('Inactivo');
  });

  test('TC-e (AC3): con usuarios el botón está deshabilitado con el conteo; un 409 del DELETE cambia el modal al número fresco y no borra', async ({ page }) => {
    const { pedidos } = mockPermisos(page, { delete: () => json({ error: '2 usuarios tienen este rol', usuarios: 2 }, 409) });
    await abrir(page);
    await botonRol(page, 'Gestor de Impuestos').click();
    const borrar = page.getByRole('button', { name: 'Borrar rol' });
    await expect(borrar).toBeDisabled();
    await expect(page.getByText('4 usuarios tienen este rol')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Gestor de Impuestos', level: 2 })).toBeVisible();
    await expect(page.getByText('Interno · Se atan a organismos de tránsito · 4 usuarios')).toBeVisible();

    // Rol borrable: el modal de confirmación; el servidor responde 409 (alguien se lo asignó entre medias).
    await botonRol(page, 'Consulta contable').click();
    await expect(borrar).toBeEnabled();
    await borrar.click();
    const modal = page.getByRole('dialog');
    await expect(modal.getByRole('heading', { name: 'Borrar el rol Consulta contable' })).toBeVisible();
    await expect(modal.getByText('Ningún usuario tiene este rol.')).toBeVisible();
    await expect(modal.getByText(/No se puede deshacer/)).toBeVisible();
    await modal.getByRole('button', { name: 'Borrar rol' }).click();
    expect(pedidos.at(-1)!.method()).toBe('DELETE');
    expect(new URL(pedidos.at(-1)!.url()).pathname).toBe('/api/permisos/roles/consulta_contable');
    await expect(modal.getByRole('alert')).toHaveText('2 usuarios tienen este rol.');
    await expect(modal.getByText('Un rol no se puede borrar mientras alguien lo tenga. Cámbiales el rol en Usuarios y vuelve aquí.')).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Ir a Usuarios' })).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Borrar rol' })).toHaveCount(0);
    await modal.getByRole('button', { name: 'Cerrar', exact: true }).last().click();
    await expect(botonRol(page, 'Consulta contable')).toHaveCount(1);
    expect(urlLimpia(page)).toEqual({ pathname: '/roles-permisos', search: '', hash: '' });
  });

  test('TC-e2 (AC3): borrar un rol sin usuarios lo saca de la lista y selecciona el primero', async ({ page }) => {
    const { pedidos } = mockPermisos(page);
    await abrir(page);
    await botonRol(page, 'Consulta contable').click();
    await page.getByRole('button', { name: 'Borrar rol' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Borrar rol' }).click();
    expect(pedidos.at(-1)!.method()).toBe('DELETE');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(botonRol(page, 'Consulta contable')).toHaveCount(0);
    await expect(botonRol(page, 'Administrador')).toHaveAttribute('aria-current', 'true');
    // El foco no cae a <body>: va al título de la pantalla.
    await expect(page.getByRole('heading', { name: 'Roles y permisos', level: 1 })).toBeFocused();
  });

  test('TC-f (AC3): rol de sistema → botón de borrar deshabilitado, el motivo del servidor y «Editar rol» a mano', async ({ page }) => {
    mockPermisos(page);
    await abrir(page);
    const borrar = page.getByRole('button', { name: 'Borrar rol' });
    await expect(borrar).toBeDisabled();
    await expect(page.getByText('El rol admin es de sistema y no se puede borrar.')).toBeVisible();
    await expect(page.getByText(/usa «Editar rol»/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Editar rol' })).toBeEnabled();
    // El botón deshabilitado se describe con el motivo.
    const describedBy = await borrar.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    await expect(page.locator(`[id="${describedBy}"]`)).toContainText('El rol admin es de sistema y no se puede borrar.');
  });

  test('TC-g (AC4): «Marcar todas las funciones» marca todas sin guardar; rol externo → advertencia y, tras guardar, las funciones fuera del canal', async ({ page }) => {
    const { pedidos } = mockPermisos(page, {
      put: (codigo, enviadas) => json({
        codigo, funciones: enviadas, concedidas: [], revocadas: [],
        aviso: { tipo: 'fuera_del_canal', mensaje: 'Hay funciones fuera del canal', funciones: ['pagina.pesv', 'pesv.incidente.crear', 'pagina.users'] },
      }),
    });
    await abrir(page);
    await botonRol(page, 'Cliente').click();
    await expect(page.getByText('Este rol es externo: sus usuarios entran solo al canal de cliente y ven únicamente lo de su compañía. Lo que se marque fuera del canal no lo van a poder ejercer.')).toBeVisible();

    await page.getByRole('button', { name: 'Marcar todas las funciones', exact: true }).click();
    await expect(page.getByText(`Sin guardar: ${TOTAL - 1} marcadas`)).toBeVisible();
    await expect(modulo(page, 'PESV')).toContainText('2 de 2 marcadas');
    await modulo(page, 'PESV').click();
    await modulo(page, 'Usuarios').click();
    for (const c of ['pagina.pesv', 'pesv.incidente.crear', 'pagina.users', 'usuarios.usuario.crear']) await expect(casilla(page, c)).toBeChecked();
    // No guardó sola.
    expect(pedidos).toHaveLength(0);
    await expect(page.getByText(/no aplica a roles externos/i)).toHaveCount(0);

    // Marcar todas del MÓDULO y desmarcar todas del módulo.
    await page.getByRole('button', { name: 'Desmarcar todas las funciones de Usuarios' }).click();
    await expect(modulo(page, 'Usuarios')).toContainText('0 de 3 marcadas');
    await page.getByRole('button', { name: 'Marcar todas las funciones de Usuarios', exact: true }).click();
    await expect(modulo(page, 'Usuarios')).toContainText('3 de 3 marcadas');

    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    expect(pedidos.at(-1)!.postDataJSON()).toEqual({ funciones: [...TODAS].sort() });
    // El aviso con el conteo del servidor, los nombres (no los códigos) y la marca solo en esas casillas.
    await expect(page.getByText(/Tiene 3 funciones marcadas fuera del canal que no va a poder ejercer/)).toBeVisible();
    await expect(page.getByText('Entrar al tablero PESV · Registrar un incidente vial · Entrar a Usuarios')).toBeVisible();
    await expect(page.getByText(/no aplica a roles externos/i)).toHaveCount(3);
    // Desmarcar una de ellas la saca del aviso: «2 funciones».
    await casilla(page, 'pagina.users').uncheck();
    await expect(page.getByText(/Tiene 2 funciones marcadas fuera del canal/)).toBeVisible();
    await expect(page.getByText(/no aplica a roles externos/i)).toHaveCount(2);
    // «Desmarcar todas» global.
    await page.getByRole('button', { name: 'Desmarcar todas', exact: true }).click();
    await expect(page.getByText(`Sin guardar: ${TOTAL} desmarcadas`)).toBeVisible();
    await expect(page.getByText(/quien lo tenga no verá nada al entrar/)).toBeVisible();
  });

  test('TC-h (AC5/AC7): tras guardar, el cuadro pinta EXACTAMENTE el conjunto del servidor, vuelve a pedir /mios y avisa si su versión cambió', async ({ page }) => {
    let version = 7;
    const { pedidos, gets } = mockPermisos(page, {
      // El servidor aplica OTRA cosa: descarta `pagina.users`, mantiene `impuestos.recibo.pagar`
      // (que se desmarcó) y añade `pagina.dashboard`. La rejilla tiene que pintar ESTO.
      put: (codigo) => json({
        codigo, funciones: ['impuestos.cola.exportar', 'impuestos.recibo.pagar', 'pagina.dashboard', 'pagina.flito_impuestos'],
        concedidas: ['impuestos.cola.exportar', 'pagina.dashboard'], revocadas: [], aviso: null,
      }),
      mios: () => json({ funciones: TODAS, rol: 'admin', tipoPrincipal: 'interno', version, resueltoEn: '2026-09-10T12:00:00.000Z' }),
    });
    await abrir(page);
    await botonRol(page, 'Gestor de Impuestos').click();
    await modulo(page, 'Impuestos').click();
    await modulo(page, 'Usuarios').click();
    await modulo(page, 'General').click();
    await casilla(page, 'impuestos.cola.exportar').check();
    await casilla(page, 'pagina.users').check();
    await casilla(page, 'impuestos.recibo.pagar').uncheck();
    const miosAntes = gets.filter((g) => g === 'mios').length;
    const cuadrosAntes = gets.filter((g) => g === 'cuadro:gestor_impuestos').length;

    version = 8;
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(page.getByText('Permisos guardados. El cambio ya está aplicado: se aplica en la siguiente acción de cada usuario. No hay que reiniciar nada.')).toBeVisible();
    expect(pedidos.at(-1)!.postDataJSON()).toEqual({ funciones: ['impuestos.cola.exportar', 'pagina.flito_impuestos', 'pagina.users'] });

    // Lo enviado NO es lo que se pinta: manda la respuesta del PUT (mutante AC7).
    await expect(casilla(page, 'pagina.users')).not.toBeChecked();
    await expect(casilla(page, 'impuestos.recibo.pagar')).toBeChecked();
    await expect(casilla(page, 'pagina.dashboard')).toBeChecked();
    await expect(casilla(page, 'impuestos.cola.exportar')).toBeChecked();
    await expect(casilla(page, 'pagina.flito_impuestos')).toBeChecked();
    await expect(modulo(page, 'Impuestos')).toContainText('3 de 3 marcadas');
    await expect(modulo(page, 'Usuarios')).toContainText('0 de 3 marcadas');
    await expect(botonRol(page, 'Gestor de Impuestos')).toContainText(`4/${TOTAL}`);
    // Sin cambios pendientes: la línea base es la del servidor.
    await expect(page.getByText(/Sin guardar/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Guardar cambios' })).toHaveCount(0);
    // AC5 / RN-A4: se volvió a pedir /mios y, como la versión cambió, se avisa. Tras guardar salen
    // DOS: el de la pantalla (compara `version`) y el de `refrescarFunciones` de `AuthProvider`
    // (HU #12170). Se afirma «más que antes» y no el número, para no atar el test a cuántas
    // capas releen el mismo endpoint.
    await expect.poll(() => gets.filter((g) => g === 'mios').length).toBeGreaterThan(miosAntes);
    await expect(page.getByRole('status').filter({ hasText: 'Este guardado cambió tu propio conjunto de funciones. Ya está aplicado en esta sesión, sin volver a entrar.' })).toBeVisible();
    // Cambiar de rol y volver: el cuadro sigue siendo el del servidor (cache por código).
    await botonRol(page, 'Administrador').click();
    await botonRol(page, 'Gestor de Impuestos').click();
    await modulo(page, 'Usuarios').click();
    await expect(casilla(page, 'pagina.users')).not.toBeChecked();
    expect(gets.filter((g) => g === 'cuadro:gestor_impuestos')).toHaveLength(cuadrosAntes);
  });

  test('TC-h2 (AC2): un guardado fallido NO borra el trabajo; el 409 anti-bloqueo trae su literal', async ({ page }) => {
    let respuesta = json({ error: 'Base caída' }, 500);
    mockPermisos(page, { put: () => respuesta });
    await abrir(page);
    await botonRol(page, 'Gestor de Impuestos').click();
    await modulo(page, 'Impuestos').click();
    await casilla(page, 'impuestos.cola.exportar').check();
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    const alerta = page.getByRole('alert');
    await expect(alerta).toContainText('No se pudieron guardar los permisos. Los cambios siguen aquí; vuelve a intentarlo.');
    await expect(alerta).toContainText('Base caída');
    await expect(casilla(page, 'impuestos.cola.exportar')).toBeChecked();
    await expect(page.getByText('Sin guardar: 1 marcada')).toBeVisible();

    respuesta = json({ error: 'Nadie quedaría con la función', funcion: 'pagina.roles_permisos' }, 409);
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(page.getByRole('alert')).toContainText('No se puede guardar: FLITO se quedaría sin nadie que pueda administrar roles y permisos. Deja marcada «Administrar roles y permisos» en al menos un rol que tenga usuarios activos.');
    await expect(casilla(page, 'impuestos.cola.exportar')).toBeChecked();
  });

  test('TC-i (AC6): axe sin violaciones graves; casillas navegables por teclado con nombre «función · rol»', async ({ page }) => {
    mockPermisos(page);
    await abrir(page);
    await cargarAxe(page);
    esperarSinViolacionesGraves(await correrAxe(page), 'roles y permisos · lleno, plegado');

    await botonRol(page, 'Gestor de Impuestos').click();
    // La única región viva anuncia el cuadro nuevo.
    await expect(page.getByRole('status').filter({ hasText: `Cuadro del rol Gestor de Impuestos. 2 de ${TOTAL} funciones marcadas.` })).toHaveCount(1);
    await modulo(page, 'Impuestos').click();
    const primera = casilla(page, 'pagina.flito_impuestos');
    await expect(page.getByRole('checkbox', { name: 'Entrar al portal de Impuestos · rol Gestor de Impuestos' })).toHaveCount(1);
    await expect(page.getByRole('group', { name: 'Funciones de Impuestos para el rol Gestor de Impuestos' })).toBeVisible();
    // Tab desde el encabezado del módulo: pasa por los dos botones del encabezado y llega a la casilla.
    await modulo(page, 'Impuestos').focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(primera).toBeFocused();
    // HU #12717: desmarcar la pantalla desmarca su acción marcada en el mismo gesto (2 desmarcadas)
    // y las acciones quedan `disabled`; volver a marcarla las habilita sin marcarlas. El foco sigue
    // en la casilla de la pantalla en los dos gestos (§14.6) y el siguiente Tab cae en la primera acción.
    await page.keyboard.press('Space');
    await expect(primera).not.toBeChecked();
    await expect(page.getByText('Sin guardar: 2 desmarcadas')).toBeVisible();
    await expect(casilla(page, 'impuestos.recibo.pagar')).toBeDisabled();
    await expect(primera).toBeFocused();
    await page.keyboard.press('Space');
    await expect(primera).toBeChecked();
    await expect(page.getByText('Sin guardar: 1 desmarcada')).toBeVisible();
    await expect(primera).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(casilla(page, 'impuestos.recibo.pagar')).toBeFocused();
    await cargarAxe(page);
    esperarSinViolacionesGraves(await correrAxe(page), 'roles y permisos · módulo abierto con cambios');

    // Ningún atributo accesible lleva códigos: viven en data-codigo.
    const atributos = await page.locator('[aria-label], [title]').evaluateAll((nodos) =>
      nodos.map((n) => `${n.getAttribute('aria-label') ?? ''} ${n.getAttribute('title') ?? ''}`));
    for (const a of atributos) expect(a).not.toMatch(/pagina\.|impuestos\./);

    await page.getByRole('button', { name: 'Nuevo rol' }).click();
    await cargarAxe(page);
    esperarSinViolacionesGraves(await correrAxe(page), 'roles y permisos · modal de rol');
  });

  test('TC-j (AC6): la URL no cambia al seleccionar rol, abrir el modal ni borrar', async ({ page }) => {
    mockPermisos(page);
    await abrir(page);
    const limpia = () => expect(urlLimpia(page)).toEqual({ pathname: '/roles-permisos', search: '', hash: '' });
    limpia();
    await botonRol(page, 'Cliente').click();
    limpia();
    await botonRol(page, 'Consulta contable').click();
    limpia();
    await page.getByRole('button', { name: 'Editar rol' }).click();
    limpia();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancelar' }).click();
    await page.getByRole('button', { name: 'Borrar rol' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Borrar rol' }).click();
    await expect(botonRol(page, 'Consulta contable')).toHaveCount(0);
    limpia();
    expect(page.url()).not.toContain('consulta_contable');
    expect(page.url()).not.toContain('cliente');
  });

  test('TC-k (AC6): los cuatro estados — esqueleto de dos columnas, error con Reintentar, vacío de roles, vacío de funciones', async ({ page }) => {
    // Un solo juego de rutas con comportamiento mutable: `unrouteAll` se llevaría también el
    // `/auth/me` de `loginAs` y la sesión se caería en el siguiente `goto`.
    let modo: 'retenido' | 'error' | 'lleno' | 'sinRoles' | 'sinFunciones' = 'retenido';
    let funciones = 0;
    let roles = 0;
    await page.route(/\/api\/permisos\/funciones$/, (route) => {
      funciones++;
      if (modo === 'retenido') return new Promise<void>(() => { /* retenida: la pantalla se queda cargando */ });
      if (modo === 'error') return route.fulfill(json({ error: 'Base caída' }, 500));
      return route.fulfill(json({ grupos: modo === 'sinFunciones' ? [] : GRUPOS }));
    });
    await page.route(/\/api\/permisos\/roles$/, (route) => { roles++; return route.fulfill(json({ roles: modo === 'sinRoles' ? [] : ROLES })); });
    await page.route(/\/api\/permisos\/roles\/([^/]+)\/funciones$/, (route) => route.fulfill(json({ codigo: 'x', tipoPrincipal: 'interno', funciones: [] })));
    await page.route(/\/api\/permisos\/mios$/, (route) => route.fulfill(json({ funciones: [], rol: 'admin', tipoPrincipal: 'interno', version: 1, resueltoEn: '' })));

    // 1 · Cargando.
    await abrir(page);
    await expect(page.getByRole('status', { name: 'Cargando roles y permisos' })).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('button', { name: 'Nuevo rol' })).toHaveCount(0);

    // 2 · Error 500: alerta con el mensaje del servidor; Reintentar dispara un SEGUNDO GET y llega el lleno.
    modo = 'error';
    await page.goto('/roles-permisos');
    const alerta = page.getByRole('alert');
    await expect(alerta).toContainText('No se pudo cargar el catálogo de roles y funciones.');
    await expect(alerta).toContainText('Base caída');
    await expect(page.getByText(/Todavía no hay roles/)).toHaveCount(0);
    await expect(page.getByText(/El catálogo de funciones llegó vacío/)).toHaveCount(0);
    const antes = { funciones, roles };
    modo = 'lleno';
    await page.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(acordeones(page)).toHaveCount(5);
    expect(funciones).toBe(antes.funciones + 1);
    expect(roles).toBe(antes.roles + 1);

    // 3 · Vacío A: sin roles → la ÚNICA primaria es «Nuevo rol».
    modo = 'sinRoles';
    await page.goto('/roles-permisos');
    await expect(page.getByText('Todavía no hay roles. Crea el primero para poder repartir funciones.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Nuevo rol' })).toHaveCount(1);
    await expect(page.getByRole('alert')).toHaveCount(0);

    // 4 · Vacío B: sin funciones → Reintentar, y no se confunde con el A.
    modo = 'sinFunciones';
    await page.goto('/roles-permisos');
    await expect(page.getByText(/El catálogo de funciones llegó vacío/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible();
    await expect(page.getByText(/Todavía no hay roles/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Nuevo rol' })).toHaveCount(0);
  });
  // ─── HU #12533 — tres secciones por origen del módulo ─────────────────────────────────────────
  test('TC-l (AC1): tres rótulos en orden fijo con la cuenta de sus módulos; acordeones alfabéticos dentro, plegados; el rótulo no es botón', async ({ page }) => {
    mockPermisos(page);
    await abrir(page);
    // Administrador: todo marcado. GRUPOS reparte impuestos → FLITO; general/permisos/usuarios → 2; pesv → 3.
    await expect(rotulos(page)).toHaveText(['FLITO · 3 de 3 marcadas', 'Ya existía y FLITO lo usa · 5 de 5 marcadas', 'Existe pero no se usa · 2 de 2 marcadas']);
    await botonRol(page, 'Gestor de Impuestos').click();
    await expect(rotulos(page)).toHaveText(['FLITO · 2 de 3 marcadas', 'Ya existía y FLITO lo usa · 0 de 5 marcadas', 'Existe pero no se usa · 0 de 2 marcadas']);
    // Acordeones dentro de su sección, alfabéticos; el total de acordeones no cambia y siguen plegados.
    await expect(seccion(page, 'FLITO').getByRole('button', { name: /\(\d+\)/ })).toHaveText([/Impuestos/]);
    await expect(seccion(page, 'Ya existía y FLITO lo usa').getByRole('button', { name: /\(\d+\)/ })).toHaveText([/General/, /Roles y permisos/, /Usuarios/]);
    await expect(seccion(page, 'Existe pero no se usa').getByRole('button', { name: /\(\d+\)/ })).toHaveText([/PESV/]);
    await expect(acordeones(page)).toHaveCount(5);
    await expect(page.locator('input[type="checkbox"]')).toHaveCount(0);
    // El rótulo: h3, no botón, sin «(N)»; en el DOM va en caja de frase (la mayúscula es CSS).
    await expect(rotulos(page)).toHaveCount(3);
    for (const t of await rotulos(page).allTextContents()) expect(t).not.toMatch(/\(\d+\)/);
    await expect(page.getByRole('button', { name: /^Ya existía/ })).toHaveCount(0);
    // La ayuda: una línea, solo bajo la sección 3.
    await expect(seccion(page, 'Existe pero no se usa').getByText('Si se marcan, el rol sí entra a esas pantallas. FLITO no las usa hoy.')).toBeVisible();
    await expect(page.getByText(/Si se marcan, el rol sí entra/)).toHaveCount(1);
    // La cuenta se mueve con el borrador y SOLO en su sección (decisión 24; mutante: contar el catálogo entero).
    await modulo(page, 'PESV').click();
    await casilla(page, 'pagina.pesv').check();
    await expect(rotulos(page)).toHaveText(['FLITO · 2 de 3 marcadas', 'Ya existía y FLITO lo usa · 0 de 5 marcadas', 'Existe pero no se usa · 1 de 2 marcada']);
  });

  test('TC-m (AC1 borde): una sección sin módulos no se pinta —ausente o vacío—; con solo FLITO queda un rótulo', async ({ page }) => {
    const sinPesv = GRUPOS.filter((g) => g.modulo !== 'pesv');
    mockPermisos(page, { grupos: sinPesv });
    await abrir(page);
    await expect(rotulos(page)).toHaveText([/^FLITO · /, /^Ya existía y FLITO lo usa · /]);
    await expect(page.getByText('Existe pero no se usa')).toHaveCount(0);
    await expect(page.getByText(/Si se marcan, el rol sí entra/)).toHaveCount(0);
    await expect(page.getByText(/0 de 0/)).toHaveCount(0);

    // `pesv: []` es lo mismo que no traerlo (vacío D + vacío E). La ruta registrada después manda.
    mockPermisos(page, { grupos: [...sinPesv, { modulo: 'pesv', funciones: [] }] });
    await page.goto('/roles-permisos');
    await expect(rotulos(page)).toHaveText([/^FLITO · /, /^Ya existía y FLITO lo usa · /]);
    await expect(page.getByText('Existe pero no se usa')).toHaveCount(0);

    mockPermisos(page, { grupos: GRUPOS.filter((g) => g.modulo === 'impuestos') });
    await page.goto('/roles-permisos');
    await expect(rotulos(page)).toHaveText(['FLITO · 3 de 3 marcadas']);
    await expect(acordeones(page)).toHaveCount(1);
  });

  test('TC-n (AC2): cada una de las 30 claves cae en su sección y en ninguna otra', async ({ page }) => {
    mockPermisos(page, { grupos: GRUPOS_CLAVES, cuadros: { admin: [] } });
    await abrir(page);
    expect(N_CLAVES).toBe(30);
    await expect(acordeones(page)).toHaveCount(N_CLAVES);
    await expect(rotulos(page)).toHaveText(['FLITO · 0 de 18 marcadas', 'Ya existía y FLITO lo usa · 0 de 5 marcadas', 'Existe pero no se usa · 0 de 7 marcadas']);
    for (let i = 0; i < N_CLAVES; i++) await acordeones(page).nth(i).click();
    await expect(page.locator('input[type="checkbox"]')).toHaveCount(N_CLAVES);
    // Las etiquetas nuevas de la #12716 y ninguna del cajón viejo.
    for (const nombre of ['Clientes', 'Tarifas', 'Servicios adicionales', 'Catálogos compartidos', 'Comprobantes', 'Logística']) await expect(seccion(page, 'FLITO').getByRole('button', { name: new RegExp(`^${nombre}\\s?\\(1\\)`) })).toHaveCount(1);
    await expect(page.getByRole('button', { name: /SOAT e Impuestos/ })).toHaveCount(0);
    for (const titulo of TITULOS) {
      for (const clave of CLAVES_SECCION[titulo]) {
        await expect(seccion(page, titulo).locator(`input[data-codigo="x.${clave}"]`), `x.${clave} en «${titulo}»`).toHaveCount(1);
        for (const otro of TITULOS.filter((t) => t !== titulo)) {
          await expect(seccion(page, otro).locator(`input[data-codigo="x.${clave}"]`), `x.${clave} NO en «${otro}»`).toHaveCount(0);
        }
      }
    }
  });

  test('TC-o (AC2 negativo): un módulo desconocido cae en FLITO con su etiqueta, sin error de página y con la casilla operable', async ({ page }) => {
    const errores: string[] = [];
    page.on('pageerror', (e) => errores.push(e.message));
    mockPermisos(page, { grupos: GRUPOS_SECCIONES, cuadros: CUADROS_SEC });
    await abrir(page);
    const nuevo = seccion(page, 'FLITO').getByRole('button', { name: /^Modulo nuevo xyz\s?\(1\)/ });
    await expect(nuevo).toHaveCount(1);
    await expect(seccion(page, 'Existe pero no se usa').getByRole('button', { name: /Modulo nuevo xyz/ })).toHaveCount(0);
    await expect(seccion(page, 'Ya existía y FLITO lo usa').getByRole('button', { name: /Modulo nuevo xyz/ })).toHaveCount(0);
    await nuevo.click();
    await casilla(page, 'nuevo.entrar').uncheck();
    await expect(page.getByText('Sin guardar: 1 desmarcada')).toBeVisible();
    await expect(rotulos(page).nth(0)).toHaveText('FLITO · 7 de 8 marcadas');
    expect(errores).toEqual([]);
  });

  test('TC-p (AC3): privacy se pinta en su acordeón destino, una sola vez; transito y drive se pintan donde el API las agrupa (pantalla primera); Operaciones y Administración conservan lo suyo', async ({ page }) => {
    mockPermisos(page, { grupos: GRUPOS_SECCIONES, cuadros: CUADROS_SEC });
    await abrir(page);
    await expect(modulo(page, 'Operaciones')).toContainText('(4)');
    await expect(modulo(page, 'Tránsito')).toContainText('(2)');
    await expect(modulo(page, 'Derechos de tránsito')).toContainText('(2)');
    await expect(modulo(page, 'Logística')).toContainText('(2)');
    await expect(modulo(page, 'Privacidad y datos')).toContainText('(1)');
    await expect(modulo(page, 'Administración')).toContainText('(1)');
    for (const m of ['Operaciones', 'Tránsito', 'Derechos de tránsito', 'Logística', 'Privacidad y datos', 'Administración']) await modulo(page, m).click();

    const flito = seccion(page, 'FLITO');
    const enUso = seccion(page, 'Ya existía y FLITO lo usa');
    const sinUso = seccion(page, 'Existe pero no se usa');
    // HU #12716: la pantalla llega PRIMERA en el grupo de su módulo y la pantalla respeta ese orden.
    await expect(panel(enUso, 'Tránsito').locator('input[type="checkbox"]').first()).toHaveAttribute('data-codigo', 'pagina.transito');
    await expect(panel(flito, 'Derechos de tránsito').locator('input[type="checkbox"]').first()).toHaveAttribute('data-codigo', 'pagina.drive');
    await expect(panel(flito, 'Logística').locator('input[type="checkbox"]').first()).toHaveAttribute('data-codigo', 'pagina.flito_logistica');
    await expect(panel(flito, 'Logística').locator('input[data-codigo="logistica.viaje.crear"]')).toHaveCount(1);
    await expect(casilla(page, 'pagina.drive')).toBeChecked();
    await expect(panel(sinUso, 'Privacidad y datos').locator('input[data-codigo="pagina.privacy"]')).toHaveCount(1);
    await expect(panel(sinUso, 'Operaciones').locator('input[type="checkbox"]')).toHaveCount(4);
    for (const c of OPERACIONES_PROPIAS) await expect(panel(sinUso, 'Operaciones').locator(`input[data-codigo="${c}"]`)).toHaveCount(1);
    await expect(panel(enUso, 'Administración').locator('input[type="checkbox"]')).toHaveCount(1);
    await expect(panel(enUso, 'Administración').locator('input[data-codigo="pagina.admin"]')).toHaveCount(1);
    // Una sola vez en toda la página (mutante: pintarla en origen y destino).
    for (const c of ['pagina.transito', 'pagina.drive', 'pagina.privacy']) await expect(casilla(page, c)).toHaveCount(1);
  });

  test('TC-p2 (AC3 borde): si el destino no viene se crea; si el origen queda vacío no se pinta; transito y drive ya no se mueven', async ({ page }) => {
    mockPermisos(page, {
      grupos: [
        { modulo: 'transito', funciones: [F('pagina.transito', 'Tránsito')] },
        { modulo: 'derechos', funciones: [F('pagina.drive', 'Drive')] },
        { modulo: 'administracion', funciones: [F('pagina.privacy', 'Privacidad y datos')] },
      ],
      cuadros: {},
    });
    await abrir(page);
    await expect(modulo(page, 'Tránsito')).toContainText('(1)');
    await expect(modulo(page, 'Derechos de tránsito')).toContainText('(1)');
    await expect(modulo(page, 'Privacidad y datos')).toContainText('(1)');
    await expect(modulo(page, 'Operaciones')).toHaveCount(0);
    await expect(modulo(page, 'Administración')).toHaveCount(0);
    await expect(acordeones(page)).toHaveCount(3);
    await expect(rotulos(page)).toHaveText(['FLITO · 0 de 1 marcadas', 'Ya existía y FLITO lo usa · 0 de 1 marcadas', 'Existe pero no se usa · 0 de 1 marcadas']);
    for (let i = 0; i < 3; i++) await acordeones(page).nth(i).click();
    await expect(page.locator('input[type="checkbox"]')).toHaveCount(3);
  });

  test('TC-q (AC4): el PUT manda los códigos de siempre —la reubicación no llega al servidor— y «Marcar todas» cubre el catálogo sin duplicados', async ({ page }) => {
    const { pedidos } = mockPermisos(page, { grupos: GRUPOS_SECCIONES, cuadros: CUADROS_SEC });
    await abrir(page);
    await botonRol(page, 'Gestor de Impuestos').click();
    for (const m of ['Tránsito', 'Derechos de tránsito', 'Privacidad y datos']) await modulo(page, m).click();
    // HU #12717: la acción se marca en un módulo cuya pantalla queda marcada (Tránsito); desmarcar
    // `pagina.drive` sin acciones marcadas en Derechos no arrastra nada.
    await casilla(page, 'pagina.transito').check();
    await casilla(page, 'transito.bandeja').check();
    await casilla(page, 'pagina.privacy').check();
    await casilla(page, 'pagina.drive').uncheck();
    await expect(page.getByText('Sin guardar: 3 marcadas, 1 desmarcada')).toBeVisible();
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(page.getByText(/ya está aplicado/)).toBeVisible();
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0].method()).toBe('PUT');
    expect(new URL(pedidos[0].url()).pathname).toBe('/api/permisos/roles/gestor_impuestos/funciones');
    expect(pedidos[0].postDataJSON()).toEqual({ funciones: ['pagina.flito_impuestos', 'pagina.privacy', 'pagina.transito', 'transito.bandeja'] });

    await page.getByRole('button', { name: 'Marcar todas las funciones', exact: true }).click();
    await expect(page.getByText(`Sin guardar: ${TODAS_SEC.length - 4} marcadas`)).toBeVisible();
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect.poll(() => pedidos.length).toBe(2);
    const enviadas = (pedidos[1].postDataJSON() as { funciones: string[] }).funciones;
    expect(enviadas).toEqual([...TODAS_SEC].sort());
    expect(new Set(enviadas).size).toBe(TODAS_SEC.length);
  });

  test('TC-r (AC4 suma): Σn de los rótulos == total del catálogo; Σk == marcadas del rol; con todo abierto, un checkbox por código y sin duplicados', async ({ page }) => {
    mockPermisos(page, { grupos: GRUPOS_SECCIONES, cuadros: CUADROS_SEC });
    await abrir(page);
    await expect(rotulos(page)).toHaveCount(3);
    const total = TODAS_SEC.length;
    let c = await cuentas(page);
    expect(c.reduce((s, x) => s + x.n, 0)).toBe(total);
    expect(c.reduce((s, x) => s + x.k, 0)).toBe(total);
    await expect(botonRol(page, 'Administrador')).toContainText(`${total}/${total}`);
    const n = await acordeones(page).count();
    for (let i = 0; i < n; i++) await acordeones(page).nth(i).click();
    await expect(page.locator('input[type="checkbox"]')).toHaveCount(total);
    const codigos = await page.locator('input[type="checkbox"]').evaluateAll((ns) => ns.map((x) => x.getAttribute('data-codigo') ?? ''));
    expect([...codigos].sort()).toEqual([...TODAS_SEC].sort());
    expect(new Set(codigos).size).toBe(codigos.length);

    await botonRol(page, 'Gestor de Impuestos').click();
    await expect(page.getByRole('heading', { name: 'Gestor de Impuestos', level: 2 })).toBeVisible();
    await expect(rotulos(page).nth(0)).toHaveText(/· 2 de \d+ marcadas$/);
    c = await cuentas(page);
    expect(c.reduce((s, x) => s + x.k, 0)).toBe(2);
    expect(c.reduce((s, x) => s + x.n, 0)).toBe(total);
  });

  test('TC-s (AC4 por acordeón): «Marcar/Desmarcar todas» de un módulo actúa solo sobre sus funciones; la reubicada pertenece al destino', async ({ page }) => {
    const { pedidos } = mockPermisos(page, { grupos: GRUPOS_SECCIONES, cuadros: CUADROS_SEC });
    await abrir(page);
    await botonRol(page, 'Sin funciones').click();
    // Vacío C: el copy sigue y las tres secciones se pintan en «0 de n» (decisión 25).
    await expect(page.getByText(/quien lo tenga no verá nada al entrar/)).toBeVisible();
    await expect(rotulos(page)).toHaveText(['FLITO · 0 de 8 marcadas', 'Ya existía y FLITO lo usa · 0 de 3 marcadas', 'Existe pero no se usa · 0 de 5 marcadas']);

    await modulo(page, 'Derechos de tránsito').click();
    await page.getByRole('button', { name: 'Marcar todas las funciones de Derechos de tránsito', exact: true }).click();
    await expect(casilla(page, 'pagina.drive')).toBeChecked();
    await expect(casilla(page, 'derechos.consultar')).toBeChecked();
    await expect(rotulos(page).nth(0)).toHaveText('FLITO · 2 de 8 marcadas');

    await modulo(page, 'Operaciones').click();
    await modulo(page, 'Tránsito').click();
    await page.getByRole('button', { name: 'Desmarcar todas las funciones de Operaciones', exact: true }).click();
    await expect(casilla(page, 'pagina.drive')).toBeChecked();
    await page.getByRole('button', { name: 'Marcar todas las funciones de Operaciones', exact: true }).click();
    await expect(modulo(page, 'Operaciones')).toContainText('4 de 4 marcadas');
    for (const c of OPERACIONES_PROPIAS) await expect(casilla(page, c)).toBeChecked();
    await expect(casilla(page, 'pagina.transito')).not.toBeChecked();
    await expect(casilla(page, 'pagina.drive')).toBeChecked();
    await expect(rotulos(page)).toHaveText(['FLITO · 2 de 8 marcadas', 'Ya existía y FLITO lo usa · 0 de 3 marcadas', 'Existe pero no se usa · 4 de 5 marcadas']);
    expect(pedidos).toHaveLength(0);
  });

  test('TC-t (AC5): una región por sección nombrada por su h3, h1→h2→h3, foco = orden visual sin paradas nuevas, axe sin graves', async ({ page }) => {
    mockPermisos(page);
    await abrir(page);
    await cargarAxe(page);
    esperarSinViolacionesGraves(await correrAxe(page), 'roles y permisos · tres secciones plegadas');

    for (const t of TITULOS) {
      const region = seccion(page, t);
      await expect(region).toHaveCount(1);
      const h3 = region.getByRole('heading', { level: 3 });
      await expect(h3).toHaveCount(1);
      await expect(h3).toHaveText(new RegExp(`^${t} · \\d+ de \\d+ marcadas?$`));
      await expect(h3).not.toHaveAttribute('tabindex', /.*/);
      await expect(region.getByText(t, { exact: true })).toHaveCount(0); // el título vive dentro del h3, no suelto
    }
    await expect(page.getByRole('heading', { level: 1, name: 'Roles y permisos' })).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 2, name: 'Administrador' })).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 3 })).toHaveCount(3);
    // El h3 no recibe foco.
    await rotulos(page).first().focus();
    await expect(rotulos(page).first()).not.toBeFocused();

    // Orden de tabulación = visual, cruzando secciones, un acordeón plegado = una parada.
    await modulo(page, 'Impuestos').focus();
    for (const nombre of ['General', 'Roles y permisos', 'Usuarios', 'PESV']) {
      await page.keyboard.press('Tab');
      await expect(modulo(page, nombre)).toBeFocused();
    }
    // Compat TC-i: con Impuestos abierto, Tab ×3 desde su encabezado llega a la primera casilla.
    await modulo(page, 'Impuestos').click();
    await modulo(page, 'Impuestos').focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press('Tab');
    await expect(casilla(page, 'pagina.flito_impuestos')).toBeFocused();
    await cargarAxe(page);
    esperarSinViolacionesGraves(await correrAxe(page), 'roles y permisos · sección con módulo abierto');
  });

  // ─── HU #12717 — las acciones de un módulo dependen de su pantalla (ficha §14) ─────────────────
  test('TC-u (AC1/AC5/AC9): sin pantalla marcada las acciones van disabled y desmarcadas con el motivo por aria-describedby; las pantallas siguen habilitadas; sin pantalla no hay dependencia', async ({ page }) => {
    mockPermisos(page, { grupos: GRUPOS_DEP, cuadros: CUADROS_DEP });
    await abrir(page);
    await botonRol(page, 'Sin funciones').click();
    await modulo(page, 'Impuestos').click();
    const impuestos = panel(page, 'Impuestos');
    await expect(casilla(page, 'pagina.flito_impuestos')).toBeEnabled();
    for (const c of ACCIONES_IMPUESTOS) {
      await expect(casilla(page, c)).toBeDisabled();
      await expect(casilla(page, c)).not.toBeChecked();
      // Primero qué hace (si tiene explicación), después por qué no se puede: el último id resuelve al copy del módulo.
      const ids = (await casilla(page, c).getAttribute('aria-describedby'))!.split(' ');
      await expect(page.locator(`[id="${ids.at(-1)}"]`)).toHaveText(COPY_MARCA_PRIMERO_PANTALLA);
    }
    // Una línea por módulo, no una por casilla (decisión 31); el nombre apagado va en text-secondary, sin opacity (decisión 30).
    await expect(impuestos.getByText(COPY_MARCA_PRIMERO_PANTALLA)).toHaveCount(1);
    const estilos = await impuestos.locator('label').evaluateAll((ls) => ls.map((l) => ({
      nombre: (l.querySelector('span') as HTMLElement).style.color,
      opacity: getComputedStyle(l).opacity,
      opacityFila: getComputedStyle(l.parentElement as HTMLElement).opacity,
    })));
    expect(estilos[0].nombre).toBe('var(--flit-text-primary)');
    for (const e of estilos.slice(1)) expect(e.nombre).toBe('var(--flit-text-secondary)');
    for (const e of estilos) { expect(e.opacity).toBe('1'); expect(e.opacityFila).toBe('1'); }
    // La pantalla sigue describiéndose solo con su explicación.
    const describedBy = await casilla(page, 'pagina.flito_impuestos').getAttribute('aria-describedby');
    await expect(page.locator(`[id="${describedBy}"]`)).toHaveText('Ve la bandeja de recibos de los organismos que tenga asignados.');
    // Ningún `title`: el motivo vive en el DOM.
    await expect(impuestos.locator('[title]')).toHaveCount(0);
    // Dos pantallas: el copy dice «una de las dos pantallas».
    await modulo(page, 'Logística').click();
    await expect(panel(page, 'Logística').getByText(COPY_MARCA_PRIMERO_UNA_PANTALLA)).toHaveCount(1);
    await expect(casilla(page, 'logistica.viaje.crear')).toBeDisabled();
    await expect(casilla(page, 'pagina.flito_logistica')).toBeEnabled();
    await expect(casilla(page, 'pagina.flito_logistica_ruta')).toBeEnabled();
    // Sin pantalla (Catálogos compartidos): nada disabled, ningún «Marca primero» (mutante: tratar «sin pantalla» como «desmarcada»).
    await modulo(page, 'Catálogos compartidos').click();
    const catalogos = panel(page, 'Catálogos compartidos');
    await expect(catalogos.locator('input[type="checkbox"]')).toHaveCount(2);
    await expect(catalogos.locator('input[type="checkbox"]:disabled')).toHaveCount(0);
    await expect(catalogos.getByText(/Marca primero/)).toHaveCount(0);
    await casilla(page, 'catalogos.exportar').check();
    await expect(page.getByText('Sin guardar: 1 marcada')).toBeVisible();
    // Solo pantalla (General): sin línea ni explicación.
    await modulo(page, 'General').click();
    await expect(panel(page, 'General').getByText(/Marca primero/)).toHaveCount(0);
    await expect(panel(page, 'General').locator('.border-t')).toHaveCount(0);
    await expect(impuestos.locator('.border-t')).toHaveCount(1);
    await cargarAxe(page);
    esperarSinViolacionesGraves(await correrAxe(page), 'roles y permisos · acciones deshabilitadas por su pantalla');
  });

  test('TC-v (AC2/AC3): marcar la pantalla habilita sin marcar y no mueve el foco; desmarcar la única pantalla desmarca sus acciones en el mismo gesto; Descartar lo devuelve', async ({ page }) => {
    const { pedidos } = mockPermisos(page, { grupos: GRUPOS_DEP, cuadros: CUADROS_DEP });
    await abrir(page);
    await botonRol(page, 'Sin funciones').click();
    await modulo(page, 'Impuestos').click();
    const pantalla = casilla(page, 'pagina.flito_impuestos');
    await pantalla.check();
    await expect(pantalla).toBeFocused();
    await expect(page.getByText('Sin guardar: 1 marcada')).toBeVisible();
    for (const c of ACCIONES_IMPUESTOS) {
      await expect(casilla(page, c)).toBeEnabled();
      await expect(casilla(page, c)).not.toBeChecked();
    }
    await expect(panel(page, 'Impuestos').getByText(/Marca primero/)).toHaveCount(0);
    await casilla(page, 'impuestos.recibo.pagar').check();
    await expect(page.getByText('Sin guardar: 2 marcadas')).toBeVisible();
    // Desmarcar la pantalla con una acción marcada: las dos se van; base vacía → no hay barra.
    await pantalla.uncheck();
    await expect(casilla(page, 'impuestos.recibo.pagar')).not.toBeChecked();
    await expect(casilla(page, 'impuestos.recibo.pagar')).toBeDisabled();
    await expect(page.getByText(/Sin guardar/)).toHaveCount(0);

    // Con línea base (pantalla + 5 acciones): la barra cuenta las 6 y «Descartar» devuelve todo (decisión 32: sin confirm por gesto).
    await botonRol(page, 'Gestor de Impuestos').click();
    await modulo(page, 'Impuestos').click();
    await expect(modulo(page, 'Impuestos')).toContainText('6 de 6 marcadas');
    await casilla(page, 'pagina.flito_impuestos').uncheck();
    await expect(page.getByText('Sin guardar: 6 desmarcadas')).toBeVisible();
    await expect(modulo(page, 'Impuestos')).toContainText('0 de 6 marcadas');
    for (const c of ACCIONES_IMPUESTOS) {
      await expect(casilla(page, c)).not.toBeChecked();
      await expect(casilla(page, c)).toBeDisabled();
    }
    await expect(panel(page, 'Impuestos').getByText(COPY_MARCA_PRIMERO_PANTALLA)).toHaveCount(1);
    page.on('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Descartar' }).click();
    await expect(page.getByText(/Sin guardar/)).toHaveCount(0);
    await expect(casilla(page, 'pagina.flito_impuestos')).toBeChecked();
    for (const c of ACCIONES_IMPUESTOS) {
      await expect(casilla(page, c)).toBeChecked();
      await expect(casilla(page, c)).toBeEnabled();
    }
    expect(pedidos).toHaveLength(0);
  });

  test('TC-w (AC4): con dos pantallas basta una; desmarcar UNA de dos no toca las acciones; desmarcar la última las desmarca (5 desmarcadas)', async ({ page }) => {
    const { pedidos } = mockPermisos(page, { grupos: GRUPOS_DEP, cuadros: CUADROS_DEP });
    await abrir(page);
    await botonRol(page, 'Gestor de Impuestos').click();
    await modulo(page, 'Logística').click();
    await expect(modulo(page, 'Logística')).toContainText('5 de 5 marcadas');
    await casilla(page, 'pagina.flito_logistica_ruta').uncheck();
    await expect(page.getByText('Sin guardar: 1 desmarcada')).toBeVisible();
    for (const c of ACCIONES_LOGISTICA) {
      await expect(casilla(page, c)).toBeChecked();
      await expect(casilla(page, c)).toBeEnabled();
    }
    await expect(panel(page, 'Logística').getByText(/Marca primero/)).toHaveCount(0);
    await casilla(page, 'pagina.flito_logistica').uncheck();
    await expect(page.getByText('Sin guardar: 5 desmarcadas')).toBeVisible();
    for (const c of ACCIONES_LOGISTICA) {
      await expect(casilla(page, c)).not.toBeChecked();
      await expect(casilla(page, c)).toBeDisabled();
    }
    await expect(panel(page, 'Logística').getByText(COPY_MARCA_PRIMERO_UNA_PANTALLA)).toHaveCount(1);
    // Con la segunda pantalla sola también se habilitan (siguen desmarcadas).
    await casilla(page, 'pagina.flito_logistica_ruta').check();
    await expect(page.getByText('Sin guardar: 4 desmarcadas')).toBeVisible();
    for (const c of ACCIONES_LOGISTICA) {
      await expect(casilla(page, c)).toBeEnabled();
      await expect(casilla(page, c)).not.toBeChecked();
    }
    // AC8: el PUT lleva exactamente el borrador.
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(page.getByText(/ya está aplicado/)).toBeVisible();
    expect(pedidos.at(-1)!.postDataJSON()).toEqual({ funciones: [...CUADROS_DEP.gestor_impuestos.filter((c) => !c.startsWith('logistica.') && c !== 'pagina.flito_logistica')].sort() });
  });

  test('TC-x (AC6/AC8): carga inconsistente → marcadas y bloqueadas con aviso role=status, sufijo en el encabezado, sin PUT; marcar la pantalla desbloquea; Descartar la devuelve; «Desmarcarlas» limpia y enfoca la pantalla', async ({ page }) => {
    const { pedidos } = mockPermisos(page, { grupos: GRUPOS_DEP, cuadros: CUADROS_DEP });
    await abrir(page);
    await botonRol(page, 'Consulta contable').click();
    // Con el módulo plegado la inconsistencia se ve en el encabezado (decisión 33); no hay barra ni PUT (AC8).
    await expect(modulo(page, 'Impuestos')).toContainText('2 de 6 marcadas · 2 sin pantalla');
    await expect(modulo(page, 'Logística')).toContainText('1 de 5 marcadas · 1 sin pantalla');
    await expect(modulo(page, 'General')).not.toContainText('sin pantalla');
    await expect(page.getByText(/Sin guardar/)).toHaveCount(0);
    expect(pedidos).toHaveLength(0);

    await modulo(page, 'Impuestos').click();
    const impuestos = panel(page, 'Impuestos');
    const aviso = impuestos.getByRole('status');
    await expect(aviso).toHaveText('2 acciones marcadas sin la pantalla. Marca «Entrar al portal de Impuestos» o desmárcalas.');
    // Es lo primero del panel, antes de todas las casillas.
    await expect(impuestos.locator('[role="status"], input[type="checkbox"]').first()).toHaveAttribute('role', 'status');
    const boton = impuestos.getByRole('button', { name: 'Desmarcarlas las acciones sin pantalla de Impuestos' });
    await expect(boton).toBeVisible();
    for (const c of ['impuestos.recibo.pagar', 'impuestos.cola.exportar']) {
      await expect(casilla(page, c)).toBeChecked();
      await expect(casilla(page, c)).toBeDisabled();
      const ids = (await casilla(page, c).getAttribute('aria-describedby'))!.split(' ');
      await expect(page.locator(`[id="${ids.at(-1)}"]`)).toHaveAttribute('role', 'status');
    }
    // Las otras acciones del módulo: desmarcadas y bloqueadas, con la explicación.
    await expect(casilla(page, 'impuestos.recibo.anular')).toBeDisabled();
    await expect(casilla(page, 'impuestos.recibo.anular')).not.toBeChecked();
    await expect(casilla(page, 'pagina.flito_impuestos')).toBeEnabled();
    await expect(casilla(page, 'pagina.flito_impuestos')).not.toBeChecked();

    // Marcar la pantalla: se desbloquean, siguen marcadas, el aviso y el sufijo desaparecen; solo la pantalla cuenta.
    await casilla(page, 'pagina.flito_impuestos').check();
    await expect(impuestos.getByRole('status')).toHaveCount(0);
    await expect(boton).toHaveCount(0);
    for (const c of ['impuestos.recibo.pagar', 'impuestos.cola.exportar']) {
      await expect(casilla(page, c)).toBeChecked();
      await expect(casilla(page, c)).toBeEnabled();
    }
    await expect(page.getByText('Sin guardar: 1 marcada')).toBeVisible();
    await expect(modulo(page, 'Impuestos')).toContainText('3 de 6 marcadas');
    await expect(modulo(page, 'Impuestos')).not.toContainText('sin pantalla');

    // «Descartar» devuelve la inconsistencia (decisión 34): aviso y bloqueo otra vez.
    page.on('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Descartar' }).click();
    await expect(impuestos.getByRole('status')).toHaveText(/2 acciones marcadas sin la pantalla/);
    await expect(casilla(page, 'impuestos.recibo.pagar')).toBeChecked();
    await expect(casilla(page, 'impuestos.recibo.pagar')).toBeDisabled();
    await expect(modulo(page, 'Impuestos')).toContainText('· 2 sin pantalla');

    // «Desmarcarlas»: solo las huérfanas de ESTE módulo; el foco va a la casilla de la pantalla (decisión 36).
    await boton.click();
    await expect(impuestos.getByRole('status')).toHaveCount(0);
    for (const c of ['impuestos.recibo.pagar', 'impuestos.cola.exportar']) await expect(casilla(page, c)).not.toBeChecked();
    await expect(page.getByText('Sin guardar: 2 desmarcadas')).toBeVisible();
    await expect(casilla(page, 'pagina.flito_impuestos')).toBeFocused();
    await expect(modulo(page, 'Impuestos')).toContainText('0 de 6 marcadas');
    await expect(modulo(page, 'Logística')).toContainText('1 de 5 marcadas · 1 sin pantalla');

    // Singular con dos pantallas: nombra las dos y el botón es «Desmarcarla».
    await modulo(page, 'Logística').click();
    const logistica = panel(page, 'Logística');
    await expect(logistica.getByRole('status')).toHaveText('1 acción marcada sin ninguna de sus pantallas. Marca «Entrar a Logística» o «Entrar a la ruta», o desmárcala.');
    await expect(logistica.getByRole('button', { name: 'Desmarcarla las acciones sin pantalla de Logística' })).toBeVisible();
    await expect(casilla(page, 'logistica.viaje.crear')).toBeChecked();
    await expect(casilla(page, 'logistica.viaje.crear')).toBeDisabled();
    await cargarAxe(page);
    esperarSinViolacionesGraves(await correrAxe(page), 'roles y permisos · carga inconsistente con aviso');

    // AC8: una inconsistencia heredada que no se toca se guarda tal cual (mutante: «corregir» la línea base al mandar).
    await modulo(page, 'General').click();
    await casilla(page, 'pagina.dashboard').check();
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(page.getByText(/ya está aplicado/)).toBeVisible();
    expect(pedidos.at(-1)!.postDataJSON()).toEqual({ funciones: ['logistica.viaje.crear', 'pagina.dashboard'] });
    // Y tras guardar sigue heredada: el aviso de Logística no se fue.
    await expect(logistica.getByRole('status')).toHaveText(/1 acción marcada sin ninguna de sus pantallas/);
  });

  test('TC-x2 (AC6 singular): una sola acción sin la pantalla → «1 acción marcada» y «Desmarcarla»', async ({ page }) => {
    mockPermisos(page, { grupos: GRUPOS_DEP, cuadros: CUADROS_DEP });
    await abrir(page);
    await botonRol(page, 'Cliente').click();
    await expect(modulo(page, 'Impuestos')).toContainText('1 de 6 marcadas · 1 sin pantalla');
    await modulo(page, 'Impuestos').click();
    const impuestos = panel(page, 'Impuestos');
    await expect(impuestos.getByRole('status')).toHaveText('1 acción marcada sin la pantalla. Marca «Entrar al portal de Impuestos» o desmárcala.');
    await impuestos.getByRole('button', { name: 'Desmarcarla las acciones sin pantalla de Impuestos' }).click();
    await expect(impuestos.getByRole('status')).toHaveCount(0);
    await expect(page.getByText('Sin guardar: 1 desmarcada')).toBeVisible();
    await expect(casilla(page, 'pagina.flito_impuestos')).toBeFocused();
  });

  test('TC-y (AC7): «Marcar todas» del módulo y del rol marcan pantalla(s) y acciones habilitadas; «Desmarcar todas» del módulo deja todo desmarcado y deshabilitado', async ({ page }) => {
    const { pedidos } = mockPermisos(page, { grupos: GRUPOS_DEP, cuadros: CUADROS_DEP });
    await abrir(page);
    await botonRol(page, 'Sin funciones').click();
    await modulo(page, 'Impuestos').click();
    await page.getByRole('button', { name: 'Marcar todas las funciones de Impuestos', exact: true }).click();
    await expect(casilla(page, 'pagina.flito_impuestos')).toBeChecked();
    for (const c of ACCIONES_IMPUESTOS) {
      await expect(casilla(page, c)).toBeChecked();
      await expect(casilla(page, c)).toBeEnabled();
    }
    await expect(panel(page, 'Impuestos').getByRole('status')).toHaveCount(0);
    await expect(modulo(page, 'Impuestos')).toContainText('6 de 6 marcadas');
    await expect(modulo(page, 'Impuestos')).not.toContainText('sin pantalla');
    await page.getByRole('button', { name: 'Desmarcar todas las funciones de Impuestos', exact: true }).click();
    await expect(casilla(page, 'pagina.flito_impuestos')).not.toBeChecked();
    for (const c of ACCIONES_IMPUESTOS) {
      await expect(casilla(page, c)).not.toBeChecked();
      await expect(casilla(page, c)).toBeDisabled();
    }
    await expect(panel(page, 'Impuestos').getByText(COPY_MARCA_PRIMERO_PANTALLA)).toHaveCount(1);
    await expect(page.getByText(/Sin guardar/)).toHaveCount(0);

    await page.getByRole('button', { name: 'Marcar todas las funciones', exact: true }).click();
    await expect(page.getByText(`Sin guardar: ${TODAS_DEP.length} marcadas`)).toBeVisible();
    await modulo(page, 'Logística').click();
    for (const c of ['pagina.flito_logistica', 'pagina.flito_logistica_ruta', ...ACCIONES_LOGISTICA, ...ACCIONES_IMPUESTOS]) {
      await expect(casilla(page, c)).toBeChecked();
      await expect(casilla(page, c)).toBeEnabled();
    }
    await expect(page.locator('input[type="checkbox"]:disabled')).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: /sin (la pantalla|ninguna de sus pantallas)/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(page.getByText(/ya está aplicado/)).toBeVisible();
    expect(pedidos.at(-1)!.postDataJSON()).toEqual({ funciones: [...TODAS_DEP].sort() });
  });
});
