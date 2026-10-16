// HU #12085 (Feature #12072) — Roles y permisos: el cuadro rol × función en `/roles-permisos`.
//
// HU #13430: el cuadro pasó a ser el árbol de tres niveles. Aquí quedan la lista de roles, los
// modales de crear / editar / borrar, la salida con cambios, la URL limpia y los cuatro estados; el
// árbol (marcar, conservar, opcionales, transversales, 409, solo lectura) lo cubre
// `permisos-arbol.spec.ts`. Las secciones por origen (#12533) y la dependencia pantalla → acciones
// (#12717) ya no existen: sus casos se retiraron con ellas.
//
// El backend va mockeado con `page.route`, como `users-historial.spec.ts`: estos casos certifican la
// PANTALLA —qué pide, qué pinta y qué NO pinta—, no las rutas del API (eso lo prueba la #12084).
//
// Método:
//   1. **El guardado se afirma por las DOS puntas.** Que la casilla cambie también es cierto si la
//      pantalla no manda nada; lo que mata ese mutante es `pedidos.at(-1).postDataJSON()`.
//   2. `TZ=UTC QA_AXE_CDN=1 npx playwright test e2e/tests/roles-permisos.spec.ts` (memoria: sin
//      `QA_AXE_CDN=1` salen rojos de axe que no son regresión).
import type { Locator, Page, Request } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER } from '../helpers/auth';
import { cargarAxe, correrAxe, esperarSinViolacionesGraves } from '../helpers/axe';
import { accion, arbolRol, codigosDe, elemento, item, type NodoDef } from '../helpers/arbolPermisos';

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
/**
 * HU #13430: el mismo catálogo en el árbol de tres niveles que sirve `/roles/:codigo/arbol` (#13429).
 * Los elementos del menú son funciones con código propio, así que cuentan en el total.
 */
const ARBOL: NodoDef[] = [
  elemento('general', 'General', [item('dashboard', 'Entrar al tablero')]),
  elemento('gestion', 'Gestión', [item('flito_impuestos', 'Impuestos', [
    accion('impuestos.recibo.pagar', 'Marcar un impuesto como pagado'), accion('impuestos.cola.exportar', 'Exportar la cola a Excel'),
  ])]),
  elemento('pesv', 'PESV', [item('pesv', 'Tablero PESV', [accion('pesv.incidente.crear', 'Administrar')], { legado: true })]),
  elemento('administracion', 'Administración', [
    item('users', 'Usuarios', [accion('usuarios.usuario.exportar', 'Exportar usuarios a Excel'), accion('usuarios.usuario.crear', 'Crear un usuario')]),
    item('roles_permisos', 'Roles y permisos'),
  ]),
];
const TODAS = codigosDe(ARBOL);
const TOTAL = TODAS.length;
/** HU #13430 (AC6): los botones van por su operación; `/mios` las trae para quien administra. */
const OPS_PERMISOS = ['permisos.rol.listar', 'permisos.cuadro.ver', 'permisos.cuadro.guardar', 'permisos.rol.crear', 'permisos.rol.editar', 'permisos.rol.borrar'];

function rol(over: Item): Item {
  return {
    codigo: 'x', nombre: 'X', descripcion: null, tipoEnlace: 'ninguno', esSistema: false,
    activo: true, usuarios: 0, borrable: true, motivoNoBorrable: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...over,
  };
}

const ROLES: Item[] = [
  rol({ codigo: 'admin', nombre: 'Administrador', esSistema: true, usuarios: 2, borrable: false, motivoNoBorrable: 'El rol admin es de sistema y no se puede borrar.' }),
  rol({ codigo: 'gestor_impuestos', nombre: 'Gestor de Impuestos', descripcion: 'Atiende la cola de impuestos de los organismos que se le asignen.', tipoEnlace: 'organismos_transito', usuarios: 4, borrable: false, motivoNoBorrable: '4 usuarios tienen este rol' }),
  rol({ codigo: 'consulta_contable', nombre: 'Consulta contable', usuarios: 0 }),
  rol({ codigo: 'cliente', nombre: 'Cliente', tipoEnlace: 'compania', usuarios: 3, borrable: false, motivoNoBorrable: '3 usuarios tienen este rol' }),
  rol({ codigo: 'sin_funciones', nombre: 'Sin funciones', usuarios: 0 }),
];

const CUADROS: Record<string, string[]> = {
  admin: [...TODAS],
  gestor_impuestos: ['menu.gestion', 'pagina.flito_impuestos', 'impuestos.recibo.pagar'],
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
  page.route(/\/api\/permisos\/mios$/, (route) => { gets.push('mios'); return route.fulfill((o.mios ?? (() => json({ funciones: [...TODAS, ...OPS_PERMISOS], rol: 'admin', version: 7, resueltoEn: '2026-09-10T12:00:00.000Z' })))()); });
  page.route(/\/api\/permisos\/roles\/([^/]+)\/arbol$/, (route) => {
    const codigo = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2) ?? '');
    gets.push(`arbol:${codigo}`);
    const datos = ((o.roles ?? ROLES) as Item[]).find((r) => r.codigo === codigo);
    return route.fulfill(json({ rol: { codigo, nombre: datos?.nombre ?? codigo, tipoEnlace: 'ninguno' }, arbol: arbolRol(ARBOL, new Set(cuadros[codigo] ?? [])), transversales: [] }));
  });
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
    return route.fulfill(json({ codigo, funciones: cuadros[codigo] ?? [] }));
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
/** HU #13430: el botón que despliega un nodo del árbol. */
const desplegar = (page: Page, nombre: string) => page.getByRole('button', { name: `Contenido de ${nombre}`, exact: true });
const casilla = (page: Page, codigo: string) => page.locator(`input[type="checkbox"][data-codigo="${codigo}"]`);
const urlLimpia = (page: Page) => { const u = new URL(page.url()); return { pathname: u.pathname, search: u.search, hash: u.hash }; };
/** HU #13430: las filas de nivel 1 del árbol (elementos del menú). */
const elementos = (page: Page) => page.locator('main li[data-codigo-fila^="menu."]');

test.describe('Roles y permisos — cuadro rol × función (HU #12085)', () => {
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
    await desplegar(page, 'Gestión').click();
    await desplegar(page, 'Impuestos').click();
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

    // Aceptar: se pierde y el árbol nuevo llega plegado (solo los elementos del menú a la vista).
    aceptar = true;
    await botonRol(page, 'Administrador').click();
    await expect(botonRol(page, 'Administrador')).toHaveAttribute('aria-current', 'true');
    await expect(page.getByText(/Sin guardar/)).toHaveCount(0);
    await expect(casilla(page, 'impuestos.cola.exportar')).toHaveCount(0);
    await expect(elementos(page)).toHaveCount(4);
    expect(await disparaBeforeUnload()).toBe(false);
    // Y «Volver» con cambios pendientes también pregunta.
    aceptar = false;
    await desplegar(page, 'Gestión').click();
    await desplegar(page, 'Impuestos').click();
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

  test('TC-d (AC3): crear rol con enlace (HU #12876: sin tipo de acceso); el código se deriva del nombre y el nuevo rol queda seleccionado con su vacío', async ({ page }) => {
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
    await modal.getByRole('radio', { name: 'Compañía', exact: true }).check();
    await expect(modal.getByText(/Tipo de acceso/)).toHaveCount(0);
    await modal.getByRole('button', { name: 'Crear rol' }).click();

    expect(pedidos).toHaveLength(1);
    expect(pedidos[0].method()).toBe('POST');
    expect(pedidos[0].postDataJSON()).toEqual({
      codigo: 'gestion_contable', nombre: 'Gestión Contable', descripcion: 'Consulta los cierres contables.', tipoEnlace: 'compania',
    });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(botonRol(page, 'Gestión Contable')).toHaveAttribute('aria-current', 'true');
    await expect(botonRol(page, 'Gestión Contable')).toContainText(`0/${TOTAL}`);
    await expect(page.getByText(/quien lo tenga no verá ningún elemento del menú al entrar/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Gestión Contable', level: 2 })).toBeVisible();
    // HU #12876: la cabecera dice el enlace; ya no hay aviso de canal externo.
    await expect(page.getByText('Enlace: Compañía · 0 usuarios')).toBeVisible();
    await expect(page.getByText(/Este rol es externo/)).toHaveCount(0);
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
    // HU #12876: cambiar el enlace con usuarios avisa; volver al guardado lo retira y no viaja.
    await expect(edicion.getByRole('radio', { name: 'Organismos', exact: true })).toBeChecked();
    await edicion.getByRole('radio', { name: 'Ninguno', exact: true }).check();
    await expect(edicion.getByText('4 usuarios ya tienen este rol: FLITO no deja cambiar el enlace mientras alguien lo tenga. Cámbiales el rol en Usuarios y vuelve aquí.')).toBeVisible();
    await edicion.getByRole('radio', { name: 'Organismos', exact: true }).check();
    await expect(edicion.getByText(/no deja cambiar el enlace/)).toHaveCount(0);
    await edicion.getByRole('button', { name: 'Guardar cambios' }).click();
    const patch = pedidos.at(-1)!;
    expect(patch.method()).toBe('PATCH');
    expect(new URL(patch.url()).pathname).toBe('/api/permisos/roles/gestor_impuestos');
    expect(patch.postDataJSON()).toEqual({ activo: false });
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
    await expect(page.getByText('Enlace: Organismos · 4 usuarios')).toBeVisible();

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
    // HU #13430: la pantalla ya no pide `/funciones`; el catálogo es el árbol del primer rol.
    let modo: 'retenido' | 'error' | 'lleno' | 'sinRoles' | 'sinFunciones' = 'retenido';
    let arboles = 0;
    let roles = 0;
    await page.route(/\/api\/permisos\/roles$/, (route) => {
      roles++;
      if (modo === 'retenido') return new Promise<void>(() => { /* retenida: la pantalla se queda cargando */ });
      if (modo === 'error') return route.fulfill(json({ error: 'Base caída' }, 500));
      return route.fulfill(json({ roles: modo === 'sinRoles' ? [] : ROLES }));
    });
    await page.route(/\/api\/permisos\/roles\/([^/]+)\/funciones$/, (route) => route.fulfill(json({ codigo: 'x', funciones: [] })));
    await page.route(/\/api\/permisos\/roles\/([^/]+)\/arbol$/, (route) => {
      arboles++;
      const vacio = modo === 'sinFunciones';
      return route.fulfill(json({ rol: { codigo: 'admin', nombre: 'Administrador', tipoEnlace: 'ninguno' }, arbol: vacio ? [] : arbolRol(ARBOL, new Set()), transversales: [] }));
    });
    await page.route(/\/api\/permisos\/mios$/, (route) => route.fulfill(json({ funciones: OPS_PERMISOS, rol: 'admin', version: 1, resueltoEn: '' })));

    // 1 · Cargando.
    await abrir(page);
    await expect(page.getByRole('status', { name: 'Cargando roles y permisos' })).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('button', { name: 'Nuevo rol' })).toHaveCount(0);

    // 2 · Error 500: alerta con el mensaje del servidor; Reintentar dispara un SEGUNDO GET y llega el lleno.
    modo = 'error';
    await page.goto('/roles-permisos');
    const alerta = page.getByRole('alert');
    await expect(alerta).toHaveText('No se pudo cargar el catálogo de roles y permisos. Revisa tu conexión y vuelve a intentarlo.');
    await expect(page.getByText(/Base caída/)).toHaveCount(0);
    await expect(page.getByText(/Todavía no hay roles/)).toHaveCount(0);
    await expect(page.getByText(/El catálogo de funciones llegó vacío/)).toHaveCount(0);
    const antes = { arboles, roles };
    modo = 'lleno';
    await page.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(elementos(page)).toHaveCount(4);
    expect(arboles).toBe(antes.arboles + 1);
    expect(roles).toBe(antes.roles + 1);

    // 3 · Vacío A: sin roles → la ÚNICA primaria es «Nuevo rol».
    modo = 'sinRoles';
    await page.goto('/roles-permisos');
    await expect(page.getByText('Todavía no hay roles. Crea el primero para poder repartir permisos.')).toBeVisible();
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
});

// ─── HU #12876 — panel de roles sin tipo y con enlace único de cuatro opciones ───────────────────
// TCs de `docs/qa/hu-12876-tcs.md`. Mutantes nombrados: W1 (sigue mandando `tipoPrincipal`) lo matan
// TC-01b/TC-01c; W2 (`proveedor_soat`) lo mata TC-02d; W3 (casillas) lo matan TC-02a/TC-02b.
const ENLACES = ['Ninguno', 'Compañía', 'Proveedor', 'Organismos'] as const;
const grupoEnlace = (modal: Locator) => modal.getByRole('radiogroup', { name: 'Enlace' });
const radioEnlace = (modal: Locator, nombre: string) => grupoEnlace(modal).getByRole('radio', { name: nombre, exact: true });

async function abrirNuevoRol(page: Page) {
  await page.getByRole('button', { name: 'Nuevo rol' }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.getByRole('heading', { name: 'Nuevo rol' })).toBeVisible();
  return modal;
}

test.describe('HU #12876 · panel de roles: sin tipo y con enlace único', () => {
  test('TC-01a · el formulario no tiene tipo de acceso ni «interno/externo»', async ({ page }) => {
    mockPermisos(page);
    await abrir(page);
    const modal = await abrirNuevoRol(page);
    await expect(modal.getByText(/interno|externo/i)).toHaveCount(0);
    await expect(modal.getByLabel(/tipo de acceso/i)).toHaveCount(0);
    await expect(modal.getByText(/tipo de acceso/i)).toHaveCount(0);
  });

  test('TC-01b + TC-02d · crear con Proveedor manda `proveedor` y sin `tipoPrincipal`', async ({ page }) => {
    const { pedidos } = mockPermisos(page);
    await abrir(page);
    const modal = await abrirNuevoRol(page);
    await modal.getByLabel('Nombre del rol').fill('Proveedor externo');
    await modal.getByLabel('Descripción').fill('Atiende la cola de su proveedor.');
    await radioEnlace(modal, 'Proveedor').check();
    await modal.getByRole('button', { name: 'Crear rol' }).click();
    expect(pedidos).toHaveLength(1);
    const body = pedidos[0].postDataJSON() as Item;
    expect(body).not.toHaveProperty('tipoPrincipal');
    expect(body.tipoEnlace).toBe('proveedor');
    expect(body).toEqual({ codigo: 'proveedor_externo', nombre: 'Proveedor externo', descripcion: 'Atiende la cola de su proveedor.', tipoEnlace: 'proveedor' });
    await expect(page.getByText('Enlace: Proveedor · 0 usuarios')).toBeVisible();
  });

  test('TC-01c · editar un rol de compañía manda solo lo que cambió, sin `tipoPrincipal`', async ({ page }) => {
    const { pedidos } = mockPermisos(page);
    await abrir(page);
    await botonRol(page, 'Cliente').click();
    await page.getByRole('button', { name: 'Editar rol' }).click();
    const edicion = page.getByRole('dialog');
    await expect(radioEnlace(edicion, 'Compañía')).toBeChecked();
    await edicion.getByLabel('Se puede asignar a usuarios nuevos').uncheck();
    await edicion.getByRole('button', { name: 'Guardar cambios' }).click();
    const patch = pedidos.at(-1)!;
    expect(patch.method()).toBe('PATCH');
    expect(patch.postDataJSON()).not.toHaveProperty('tipoPrincipal');
    expect(patch.postDataJSON()).toEqual({ activo: false });
  });

  test('TC-02a + TC-02b + TC-02c · cuatro radios en orden fijo, una sola marcada, cada una con su ayuda', async ({ page }) => {
    mockPermisos(page);
    await abrir(page);
    const modal = await abrirNuevoRol(page);
    const radios = grupoEnlace(modal).getByRole('radio');
    await expect(radios).toHaveCount(4);
    await expect(grupoEnlace(modal).getByRole('checkbox')).toHaveCount(0);
    const nombres = await radios.evaluateAll((ns) => ns.map((n) => document.getElementById(n.getAttribute('aria-labelledby') ?? '')?.textContent ?? ''));
    expect(nombres).toEqual([...ENLACES]);
    // Al crear viene Ninguno.
    await expect(radioEnlace(modal, 'Ninguno')).toBeChecked();
    // Selección única.
    await radioEnlace(modal, 'Compañía').check();
    await radioEnlace(modal, 'Proveedor').check();
    await expect(radioEnlace(modal, 'Proveedor')).toBeChecked();
    await expect(radioEnlace(modal, 'Compañía')).not.toBeChecked();
    await expect(radioEnlace(modal, 'Ninguno')).not.toBeChecked();
    // Una ayuda no vacía y distinta por opción, asociada por aria-describedby.
    const ayudas = await radios.evaluateAll((ns) => ns.map((n) => document.getElementById(n.getAttribute('aria-describedby') ?? '')?.textContent?.trim() ?? ''));
    expect(ayudas.every((a) => a.length > 0)).toBe(true);
    expect(new Set(ayudas).size).toBe(4);
    expect(ayudas[2]).toBe('Ve solo lo asignado a su proveedor. Hoy aplica a SOAT.');
    // HU #13452: los módulos con el nombre del MENÚ (Bolsas, Derechos) y la Bandeja de trámites de organismos.
    expect(ayudas[1]).toBe('Ve solo lo de su compañía en el Tablero, Gestión Trámites, SOAT, Impuestos, Bolsas, Comprobantes y Logística. No ve catálogos ni configuración; el resto le queda cerrado.');
    expect(ayudas[3]).toBe('Ve solo lo de sus secretarías de tránsito en Impuestos, Derechos y la Bandeja de trámites. El resto le queda cerrado.');
    // Ayuda del grupo.
    await expect(modal.getByText('Decide qué datos ven las personas con este rol. La compañía, el proveedor o las secretarías de cada una se eligen en Usuarios.')).toBeVisible();
  });

  test('TC-02e · al editar aparece marcado el enlace guardado; cambiarlo a Ninguno lo manda', async ({ page }) => {
    const { pedidos } = mockPermisos(page);
    await abrir(page);
    await botonRol(page, 'Gestor de Impuestos').click();
    await page.getByRole('button', { name: 'Editar rol' }).click();
    const edicion = page.getByRole('dialog');
    await expect(radioEnlace(edicion, 'Organismos')).toBeChecked();
    await radioEnlace(edicion, 'Ninguno').check();
    // Con usuarios: el aviso del 409 nombra el enlace y queda en la descripción del grupo.
    const aviso = edicion.getByText(/FLITO no deja cambiar el enlace mientras alguien lo tenga/);
    await expect(aviso).toBeVisible();
    await expect(grupoEnlace(edicion)).toHaveAttribute('aria-describedby', /rol-enlace-bloqueo/);
    await edicion.getByRole('button', { name: 'Guardar cambios' }).click();
    expect(pedidos.at(-1)!.method()).toBe('PATCH');
    expect(pedidos.at(-1)!.postDataJSON()).toEqual({ tipoEnlace: 'ninguno' });
  });

  test('TC-03a · un rol de enlace proveedor se lee «Proveedor»; nunca «gestor/proveedor SOAT»', async ({ page }) => {
    const roles = [...ROLES, rol({ codigo: 'proveedor', nombre: 'Aliado', tipoEnlace: 'proveedor', usuarios: 1 })];
    mockPermisos(page, { roles, cuadros: { ...CUADROS, proveedor: ['pagina.dashboard'] } });
    await abrir(page);
    await botonRol(page, 'Aliado').click();
    await expect(page.getByText('Enlace: Proveedor · 1 usuario')).toBeVisible();
    await expect(page.getByText(/gestor SOAT|proveedor SOAT/i)).toHaveCount(0);
    await page.getByRole('button', { name: 'Editar rol' }).click();
    const edicion = page.getByRole('dialog');
    await expect(radioEnlace(edicion, 'Proveedor')).toBeChecked();
    await expect(edicion.getByText(/gestor SOAT|proveedor SOAT/i)).toHaveCount(0);
  });

  test('TC-04a + TC-04b · grupo con nombre accesible; Tab y flechas con foco visible', async ({ page }) => {
    mockPermisos(page);
    await abrir(page);
    const modal = await abrirNuevoRol(page);
    await expect(grupoEnlace(modal)).toBeVisible();
    await modal.getByLabel('Descripción').focus();
    await page.keyboard.press('Tab');
    const ninguno = radioEnlace(modal, 'Ninguno');
    await expect(ninguno).toBeFocused();
    await page.keyboard.press('ArrowDown');
    const compania = radioEnlace(modal, 'Compañía');
    await expect(compania).toBeFocused();
    await expect(compania).toBeChecked();
    const anillo = await compania.evaluate((n) => { const c = getComputedStyle(n); return { outline: c.outlineStyle, sombra: c.boxShadow }; });
    expect(anillo.outline !== 'none' || anillo.sombra !== 'none').toBe(true);
  });

  test('error al guardar: copy pulido en el modal con role=alert, nunca el error crudo', async ({ page }) => {
    mockPermisos(page, { post: () => json({ error: 'duplicate key value violates unique constraint "permisos_roles_pkey"' }, 500) });
    await abrir(page);
    const modal = await abrirNuevoRol(page);
    await modal.getByLabel('Nombre del rol').fill('Auditoría');
    await modal.getByLabel('Descripción').fill('Revisa.');
    await modal.getByRole('button', { name: 'Crear rol' }).click();
    await expect(modal.getByRole('alert')).toHaveText('No se pudo guardar el rol. Inténtalo de nuevo; si se repite, recarga la página.');
    await expect(modal.getByText(/duplicate key|permisos_roles_pkey/)).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(1);
  });

  test.describe('móvil 390×844', () => {
    test.use({ viewport: { width: 390, height: 844 } });
    test('TC-04c + TC-04d · el formulario no desborda y las cuatro opciones son pulsables; axe sin graves', async ({ page }) => {
      mockPermisos(page);
      await abrir(page);
      const modal = await abrirNuevoRol(page);
      for (const n of ENLACES) {
        await radioEnlace(modal, n).scrollIntoViewIfNeeded();
        await expect(radioEnlace(modal, n)).toBeVisible();
      }
      await radioEnlace(modal, 'Organismos').check();
      await expect(radioEnlace(modal, 'Organismos')).toBeChecked();
      // Se mide el MODAL: la barra superior del shell desborda a 390 px por su cuenta (preexistente,
      // fuera de esta HU; declarado en el HANDOFF).
      const desborde = await page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]') as HTMLElement;
        const caja = d.getBoundingClientRect();
        const fuera = [...d.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > caja.right + 1).length;
        return { scroll: d.scrollWidth - d.clientWidth, derecha: caja.right - window.innerWidth, fuera };
      });
      expect(desborde).toEqual({ scroll: 0, derecha: expect.any(Number) as number, fuera: 0 });
      expect(desborde.derecha).toBeLessThanOrEqual(0);
      await cargarAxe(page);
      esperarSinViolacionesGraves(await correrAxe(page), 'roles y permisos · modal de rol en móvil');
    });
  });
});
