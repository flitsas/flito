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
import type { Page, Request } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER } from '../helpers/auth';
import { cargarAxe, correrAxe, esperarSinViolacionesGraves } from '../helpers/axe';

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
  await loginAs(page, ADMIN_USER);
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
    // catálogo y un cuadro por rol.
    const cargas = gets.filter((g) => g === 'funciones').length;
    expect(cargas).toBeGreaterThanOrEqual(1);
    expect(gets.filter((g) => g === 'roles')).toHaveLength(cargas);
    expect(gets.filter((g) => g === 'mios')).toHaveLength(cargas);
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
    // AC5 / RN-A4: se volvió a pedir /mios y, como la versión cambió, se avisa.
    await expect.poll(() => gets.filter((g) => g === 'mios').length).toBe(miosAntes + 1);
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
    await page.keyboard.press('Space');
    await expect(primera).not.toBeChecked();
    await expect(page.getByText('Sin guardar: 1 desmarcada')).toBeVisible();
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
});
