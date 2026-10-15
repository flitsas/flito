// HU #13430 (Feature #13416, Épica #13411) — Panel de roles y de excepciones en tres niveles.
//
// El backend va mockeado con `page.route` (patrón de `roles-permisos.spec.ts`): el árbol que sirve el
// mock se CALCULA de las marcas guardadas (`e2e/helpers/arbolPermisos.ts`), así que tras un `PUT` la
// pantalla recibe lo que el servidor habría devuelto, no una respuesta ya pintada.
//
// Método: el guardado se afirma por las dos puntas (lo que se ve Y el cuerpo del `PUT`/`PATCH`).
//   TZ=UTC npx playwright test e2e/tests/permisos-arbol.spec.ts
//   (el caso de axe exige QA_AXE_CDN=1 o QA_AXE_PATH: sin fuente falla a propósito, HU #11650).
//
// Mapa AC → test: AC1/AC2/AC8 → «árbol»; AC3 (+P-26, P-31, P-32, Ayuda) → «sin acciones, opcionales y
// marcar todo»; AC5 → «409»; AC6/AC7 → «solo lectura» y «409» (admin editable); AC4 → «usuario»;
// AC8 axe → «axe».
//
// HU #13589 (P-35..P-37): sin bloque «Permisos que no dependen del menú»; el árbol es solo el del menú y
// Administración trae «Rendimiento». AC1/AC3/AC4 (panel) → «HU #13589 · panel sin permisos sueltos»; AC2 →
// aserto en «usuario». Menú, Tablero y /admin/rendimiento → `permisos-rendimiento.spec.ts`.
import type { Page, Request } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER } from '../helpers/auth';
import { cargarAxe, correrAxe, esperarSinViolacionesGraves } from '../helpers/axe';
import {
  accion, arbolRol, arbolUsuario, codigosDe, elemento, item, opcional, type NodoDef,
} from '../helpers/arbolPermisos';
import {
  COPY_AYUDA_DERIVADA, COPY_ITEM_ANTIGUO, COPY_ITEM_ANTIGUO_OPCIONALES, avisoSinAcciones, explicacionDesmarcado, fraseSinEfecto,
  rotuloOpcional,
} from '../../src/pages/roles-permisos/arbol';
import { COPY_SOLO_LECTURA } from '../../src/pages/roles-permisos/CuadroRol';
import { COPY_ERROR_GUARDADO } from '../../src/pages/RolesPermisos';

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

const ARBOL: NodoDef[] = [
  elemento('general', 'General', [item('dashboard', 'Tablero', [accion('accion.tablero.ver', 'Ver el tablero')])]),
  elemento('gestion', 'Gestión', [
    item('flito_soat', 'SOAT', [
      accion('accion.soat.ver_listado', 'Ver el listado', [], 'Consultar la cola de SOAT.'),
      accion('accion.soat.exportar', 'Exportar a Excel', [
        accion('accion.soat.exportar_pago', 'Exportar con datos de pago y trazabilidad'),
        opcional('soat.descarga.reintentar', 'Reintentar la descarga'),
      ]),
    ]),
    item('vehicles', 'Vehículos', [opcional('vehiculos.documento.ver', 'Ver el documento del propietario')], { legado: true }),
    item('tramite', 'Trámite Digital', [], { legado: true }),
  ]),
  elemento('transito', 'Tránsito', [item('organismos', 'Organismos STT', [accion('accion.organismos.ver', 'Ver')])]),
  elemento('pesv', 'PESV', [
    item('pesv', 'Tablero PESV', [], { legado: true }),
    item('pesv_conductores', 'Conductores', [accion('accion.pesv_conductores.administrar', 'Administrar')], { legado: true }),
  ]),
  elemento('administracion', 'Administración', [
    item('users', 'Usuarios', [accion('accion.usuarios.ver', 'Ver usuarios'), accion('accion.usuarios.editar', 'Editar usuario')]),
    item('roles_permisos', 'Roles y permisos', [accion('accion.roles_permisos.ver', 'Ver roles'), accion('accion.roles_permisos.asignar', 'Asignar permisos')]),
    item('admin_rendimiento', 'Rendimiento', [], { legado: true }),
  ]),
  elemento('ayuda', 'Ayuda', [], { derivado: true }),
  elemento('perfil', 'Perfil', [item('perfil', 'Mi perfil', [], { legado: true })]),
];
const TODO = codigosDe(ARBOL);
const TITULO_SUELTOS = 'Permisos que no dependen del menú';
const ELEMENTOS = ['General', 'Gestión', 'Tránsito', 'PESV', 'Administración', 'Ayuda', 'Perfil'];

const GESTOR = [
  'menu.general', 'pagina.dashboard', 'accion.tablero.ver',
  'menu.gestion', 'pagina.flito_soat', 'accion.soat.ver_listado', 'accion.soat.exportar', 'pagina.vehicles', 'pagina.tramite',
];

const rol = (codigo: string, nombre: string, usuarios = 0) => ({
  codigo, nombre, descripcion: null, tipoEnlace: 'ninguno', esSistema: codigo === 'admin', activo: true, usuarios,
  borrable: usuarios === 0 && codigo !== 'admin', motivoNoBorrable: usuarios > 0 ? `${usuarios} usuarios tienen este rol` : null,
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
});
const ROLES = [rol('admin', 'Administrador', 2), rol('gestor_tramites', 'Gestor de trámites', 4), rol('sin_nada', 'Sin nada')];

interface Opciones { put?: (codigo: string, funciones: string[]) => ReturnType<typeof json> }

function mockPermisos(page: Page, o: Opciones = {}) {
  const cuadros: Record<string, string[]> = { admin: [...TODO], gestor_tramites: [...GESTOR], sin_nada: [] };
  const puts: Request[] = [];
  page.route(/\/api\/permisos\/roles$/, (r) => r.fulfill(json({ roles: ROLES })));
  page.route(/\/api\/permisos\/funciones$/, (r) => r.fulfill(json({ grupos: [] })));
  page.route(/\/api\/permisos\/roles\/([^/]+)\/arbol$/, (r) => {
    const codigo = decodeURIComponent(new URL(r.request().url()).pathname.split('/').at(-2) ?? '');
    const marcas = new Set(cuadros[codigo] ?? []);
    const datos = ROLES.find((x) => x.codigo === codigo);
    return r.fulfill(json({
      rol: { codigo, nombre: datos?.nombre ?? codigo, tipoEnlace: 'ninguno' },
      arbol: arbolRol(ARBOL, marcas),
    }));
  });
  page.route(/\/api\/permisos\/roles\/([^/]+)\/funciones$/, (r) => {
    const req = r.request();
    const codigo = decodeURIComponent(new URL(req.url()).pathname.split('/').at(-2) ?? '');
    if (req.method() === 'PUT') {
      puts.push(req);
      const enviadas = (req.postDataJSON() as { funciones: string[] }).funciones;
      const respuesta = (o.put ?? ((c: string, f: string[]) => json({ codigo: c, funciones: f, concedidas: [], revocadas: [], aviso: null })))(codigo, enviadas);
      if (respuesta.status === 200) cuadros[codigo] = enviadas;
      return r.fulfill(respuesta);
    }
    return r.fulfill(json({ codigo, funciones: cuadros[codigo] ?? [] }));
  });
  return { puts };
}

async function abrir(page: Page, funciones?: readonly string[]) {
  await loginAs(page, ADMIN_USER, funciones ? { funciones } : {});
  await page.goto('/roles-permisos');
  await expect(page.getByRole('heading', { name: 'Roles y permisos', level: 1 })).toBeVisible();
}

const casilla = (page: Page, codigo: string) => page.locator(`input[type="checkbox"][data-codigo="${codigo}"]`);
const desplegar = (page: Page, nombre: string) => page.getByRole('button', { name: `Contenido de ${nombre}`, exact: true });
const fila = (page: Page, codigo: string) => page.locator(`li[data-codigo-fila="${codigo}"]`);
const botonRol = (page: Page, nombre: string) => page.getByRole('button', { name: new RegExp(`^${nombre}`) });

test.describe('HU #13430 · árbol de permisos del rol', () => {
  test('árbol (AC1/AC2/AC8/AC9): elementos en el orden del menú, parcial mixed, Ayuda sin casilla; desmarcar el nivel 1 conserva y el PUT lo manda', async ({ page }) => {
    const { puts } = mockPermisos(page);
    await abrir(page);
    await botonRol(page, 'Gestor de trámites').click();
    await expect(page.getByRole('heading', { name: 'Gestor de trámites', level: 2 })).toBeVisible();

    // AC1: los elementos en el orden del menú, con sus nombres; Ayuda sin casilla ni chevron, con su frase.
    const filas = await page.locator('main li[data-codigo-fila^="menu."]').evaluateAll((els) => els.map((e) => e.getAttribute('data-codigo-fila')));
    expect(filas).toEqual(ELEMENTOS.map((n) => `menu.${n === 'Gestión' ? 'gestion' : n === 'Tránsito' ? 'transito' : n === 'Administración' ? 'administracion' : n.toLowerCase()}`));
    for (const nombre of ELEMENTOS.filter((n) => n !== 'Ayuda')) {
      await expect(page.getByRole('checkbox', { name: `${nombre} · rol Gestor de trámites`, exact: true })).toBeVisible();
    }
    await expect(casilla(page, 'menu.ayuda')).toHaveCount(0);
    await expect(desplegar(page, 'Ayuda')).toHaveCount(0);
    await expect(fila(page, 'menu.ayuda')).toContainText(COPY_AYUDA_DERIVADA);

    // Tri-estado: General completo → marcada sin aria-checked; Gestión con algo sin marcar → mixed.
    await expect(casilla(page, 'menu.general')).toBeChecked();
    await expect(casilla(page, 'menu.general')).not.toHaveAttribute('aria-checked', /.*/);
    await expect(casilla(page, 'menu.gestion')).toHaveAttribute('aria-checked', 'mixed');
    expect(await casilla(page, 'menu.gestion').evaluate((el: HTMLInputElement) => el.indeterminate)).toBe(true);
    await expect(casilla(page, 'menu.transito')).not.toBeChecked();

    // Plegado al montar; el chevron se maneja con teclado (Enter) y dice su estado.
    await expect(casilla(page, 'pagina.flito_soat')).toHaveCount(0);
    await desplegar(page, 'Gestión').focus();
    await page.keyboard.press('Enter');
    await expect(desplegar(page, 'Gestión')).toHaveAttribute('aria-expanded', 'true');
    await desplegar(page, 'SOAT').click();
    await expect(casilla(page, 'accion.soat.ver_listado')).toBeChecked();
    // Label por casilla: nombre visible + «· rol {rol}».
    await expect(page.getByRole('checkbox', { name: 'Ver el listado · rol Gestor de trámites' })).toBeVisible();

    // AC2: desmarcar el elemento (un clic en el parcial lo desmarca) → los hijos siguen visibles, deshabilitados y con sus marcas.
    await casilla(page, 'menu.gestion').click();
    await expect(page.getByText('Sin guardar: 1 desmarcada')).toBeVisible();
    await expect(casilla(page, 'pagina.flito_soat')).toBeDisabled();
    await expect(casilla(page, 'pagina.flito_soat')).toHaveAttribute('aria-checked', 'mixed');
    await expect(casilla(page, 'accion.soat.ver_listado')).toBeDisabled();
    await expect(casilla(page, 'accion.soat.ver_listado')).toBeChecked();
    await expect(page.getByText(explicacionDesmarcado('Gestión', 'rol'))).toBeVisible();
    await expect(fila(page, 'menu.gestion')).toContainText(/Inactivo · conserva \d+ de \d+/);
    // La casilla inactiva se explica por aria-describedby con la frase del padre desmarcado.
    const describe = await casilla(page, 'accion.soat.ver_listado').getAttribute('aria-describedby');
    const textos = await Promise.all((describe ?? '').split(' ').map((id) => page.locator(`[id="${id}"]`).textContent()));
    expect(textos.join(' ')).toContain(explicacionDesmarcado('Gestión', 'rol'));

    // Volver a marcarlo: reaparecen activos con sus marcas.
    await casilla(page, 'menu.gestion').click();
    await expect(casilla(page, 'accion.soat.ver_listado')).toBeEnabled();
    await expect(casilla(page, 'accion.soat.ver_listado')).toBeChecked();
    await expect(page.getByText(/Sin guardar/)).toHaveCount(0);

    // Desmarcar y guardar: el PUT lleva lo conservado, sin el elemento y nunca `menu.ayuda`.
    await casilla(page, 'menu.gestion').click();
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(page.getByText('Permisos de Gestor de trámites guardados: cada usuario los verá en su siguiente acción.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cerrar aviso' }).first()).toBeVisible();
    expect(puts).toHaveLength(1);
    const enviadas = (puts[0].postDataJSON() as { funciones: string[] }).funciones;
    expect(enviadas).toEqual([...GESTOR].filter((c) => c !== 'menu.gestion').sort());
    expect(enviadas).not.toContain('menu.ayuda');
    await expect(page.getByText(/Sin guardar/)).toHaveCount(0);
    await expect(casilla(page, 'accion.soat.ver_listado')).toBeDisabled();
    await expect(casilla(page, 'accion.soat.ver_listado')).toBeChecked();
    await expect(page.getByRole('heading', { name: 'Gestor de trámites', level: 2 })).toBeFocused();
  });

  test('sin acciones, opcionales y marcar todo (AC3, P-26, P-31, P-32): aviso explicativo, opcional aparte; «Marcar todo» no regala opcionales', async ({ page }) => {
    const { puts } = mockPermisos(page);
    await abrir(page);
    await botonRol(page, 'Gestor de trámites').click();
    await desplegar(page, 'Gestión').click();

    // Ítems antiguos: Trámite Digital sin chevron con su frase; Vehículos (solo opcional) como hoja, con su frase.
    await expect(desplegar(page, 'Trámite Digital')).toHaveCount(0);
    await expect(fila(page, 'pagina.tramite')).toContainText(COPY_ITEM_ANTIGUO);
    await expect(fila(page, 'pagina.vehicles')).toContainText(COPY_ITEM_ANTIGUO_OPCIONALES);
    await expect(casilla(page, 'pagina.vehicles')).toBeChecked();
    await expect(casilla(page, 'pagina.vehicles')).not.toHaveAttribute('aria-checked', /.*/);
    // P-32: Vehículos marcado sin su opcional no avisa.
    await expect(fila(page, 'pagina.vehicles').locator('[data-aviso="sin-acciones"]')).toHaveCount(0);
    await desplegar(page, 'Vehículos').click();
    await expect(page.getByText(rotuloOpcional('Vehículos'))).toBeVisible();
    await expect(casilla(page, 'vehiculos.documento.ver')).not.toBeChecked();

    // AC3: SOAT marcado sin ninguna acción → aviso (no lista vacía) y la cuenta del elemento plegado lo suma.
    await desplegar(page, 'SOAT').click();
    await casilla(page, 'accion.soat.ver_listado').uncheck();
    await expect(page.getByText(avisoSinAcciones('SOAT', 'rol'))).toHaveCount(0);
    await casilla(page, 'accion.soat.exportar').click();
    await expect(page.getByText(avisoSinAcciones('SOAT', 'rol'))).toBeVisible();
    await desplegar(page, 'Gestión').click();
    await expect(fila(page, 'menu.gestion')).toContainText('· 1 ítem sin acciones');
    await desplegar(page, 'Gestión').click();
    await casilla(page, 'accion.soat.ver_listado').check();
    await expect(page.getByText(avisoSinAcciones('SOAT', 'rol'))).toHaveCount(0);

    // P-26: con todas sus acciones (sin el opcional), «Exportar» está completo, no parcial.
    await casilla(page, 'accion.soat.exportar').click();
    await desplegar(page, 'Exportar a Excel').click();
    await casilla(page, 'accion.soat.exportar_pago').check();
    await expect(casilla(page, 'accion.soat.exportar')).toBeChecked();
    await expect(casilla(page, 'accion.soat.exportar')).not.toHaveAttribute('aria-checked', /.*/);
    await expect(page.getByText(rotuloOpcional('Exportar a Excel'))).toBeVisible();

    // P-31: «Marcar todo» marca ítems y acciones pero NO opcionales; Ayuda no entra (HU #13589: sin sueltos).
    await page.getByRole('button', { name: 'Marcar todo en el rol Gestor de trámites', exact: true }).click();
    await expect(casilla(page, 'vehiculos.documento.ver')).not.toBeChecked();
    await expect(casilla(page, 'soat.descarga.reintentar')).not.toBeChecked();
    await expect(casilla(page, 'menu.transito')).toBeChecked();
    await expect(casilla(page, 'menu.administracion')).toBeChecked();
    await expect(desplegar(page, TITULO_SUELTOS)).toHaveCount(0);
    // Los opcionales se marcan aparte; «Desmarcar todo» los quita también.
    await casilla(page, 'vehiculos.documento.ver').check();
    await expect(fila(page, 'pagina.vehicles')).toContainText('1 opcional');
    await page.getByRole('button', { name: 'Desmarcar todo en el rol Gestor de trámites', exact: true }).click();
    await expect(casilla(page, 'vehiculos.documento.ver')).not.toBeChecked();
    await expect(page.locator('[data-aviso="rol-vacio"]')).toBeVisible();
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect.poll(() => puts.length).toBe(1);
    expect((puts[0].postDataJSON() as { funciones: string[] }).funciones).toEqual([]);

    // PESV (todos antiguos, uno con «Administrar»): una sola frase en el panel del elemento.
    await desplegar(page, 'PESV').click();
    await expect(fila(page, 'menu.pesv')).toContainText('En PESV, marcar un ítem da su pantalla.');
    await expect(fila(page, 'pagina.pesv')).not.toContainText(COPY_ITEM_ANTIGUO);
  });

  test('409 (AC5/AC7): aviso en la barra con el nodo, sin texto del API ni toast; conserva los cambios; «Mostrar dónde está» enfoca la casilla', async ({ page }) => {
    let modo: 'nodo' | 'sin_nombre' = 'nodo';
    mockPermisos(page, {
      put: () => json(modo === 'nodo'
        ? { error: 'ANTI_BLOQUEO texto crudo del API', funcion: 'pagina.users', nodo: 'menu.administracion' }
        : { error: 'ANTI_BLOQUEO texto crudo del API', funcion: 'operacion.que.no.existe' }, 409),
    });
    await abrir(page);
    // AC7: admin se ve y se edita como cualquier rol.
    await expect(page.getByRole('heading', { name: 'Administrador', level: 2 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Editar rol' })).toBeVisible();
    await expect(casilla(page, 'menu.administracion')).toBeEnabled();
    await casilla(page, 'menu.administracion').uncheck();
    await page.getByRole('button', { name: 'Guardar cambios' }).click();

    const alerta = page.getByRole('alert');
    await expect(alerta).toContainText('No se guardó: con este cambio FLITO se quedaría sin ningún usuario activo que pueda administrar Usuarios y Roles y permisos.');
    await expect(alerta).toContainText('Deja marcado «Administración» en este rol o dáselo antes a otro rol con usuarios activos. Tus cambios siguen aquí, sin guardar.');
    await expect(page.getByText(/texto crudo/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cerrar aviso' })).toHaveCount(0);
    await expect(alerta).toBeFocused();
    await expect(page.getByText('Sin guardar: 1 desmarcada')).toBeVisible();
    await expect(casilla(page, 'menu.administracion')).not.toBeChecked();

    await page.getByRole('button', { name: 'Mostrar dónde está' }).click();
    await expect(casilla(page, 'menu.administracion')).toBeFocused();

    // Sin `nodo` y con una `funcion` fuera del árbol → copy sin nombre y sin «Mostrar dónde está».
    modo = 'sin_nombre';
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(page.getByRole('alert')).toContainText('Revisa Administración, Usuarios y Roles y permisos en este rol antes de guardar.');
    await expect(page.getByRole('button', { name: 'Mostrar dónde está' })).toHaveCount(0);
    await expect(page.getByText('Sin guardar: 1 desmarcada')).toBeVisible();
  });

  test('solo lectura (AC6): con «ver» y sin asignar/crear/editar/borrar no hay botones de edición y las casillas no se tocan', async ({ page }) => {
    const { puts } = mockPermisos(page);
    await abrir(page, ['permisos.rol.listar', 'permisos.cuadro.ver']);
    await expect(page.getByText(COPY_SOLO_LECTURA)).toBeVisible();
    for (const nombre of ['Nuevo rol', 'Editar rol', 'Borrar rol', 'Marcar todo en el rol Administrador', 'Desmarcar todo en el rol Administrador']) {
      await expect(page.getByRole('button', { name: nombre })).toHaveCount(0);
    }
    await expect(casilla(page, 'menu.general')).toBeDisabled();
    await expect(casilla(page, 'menu.general')).toBeChecked();
    // Desplegar sí funciona.
    await desplegar(page, 'Gestión').click();
    await expect(casilla(page, 'pagina.flito_soat')).toBeDisabled();
    await expect(page.getByRole('button', { name: /Marcar todo/ })).toHaveCount(0);
    await expect(page.getByText(/Sin guardar/)).toHaveCount(0);
    expect(puts).toHaveLength(0);
  });

  test('axe (AC8): sin violaciones graves con el árbol desplegado y un parcial', async ({ page }) => {
    mockPermisos(page);
    await abrir(page);
    await botonRol(page, 'Gestor de trámites').click();
    await desplegar(page, 'Gestión').click();
    await desplegar(page, 'SOAT').click();
    await casilla(page, 'menu.gestion').click();
    await cargarAxe(page);
    esperarSinViolacionesGraves(await correrAxe(page), 'árbol de permisos · elemento desmarcado con hijos inactivos');
  });
  // ─── Retrabajo QA B (B1–B4): cobertura que tenían los casos retirados del cuadro plano ─────────
  test('B1 (AC7 de #12085): tras guardar se pinta el conjunto del SERVIDOR, no el enviado; la lista cuenta lo guardado', async ({ page }) => {
    // El servidor aplica otra cosa: añade lo pedido pero quita «Ver el listado» y «Trámite Digital».
    const servidor = [...GESTOR.filter((c) => c !== 'accion.soat.ver_listado' && c !== 'pagina.tramite'), 'accion.soat.exportar_pago'].sort();
    const { puts } = mockPermisos(page, { put: (c) => json({ codigo: c, funciones: servidor, concedidas: [], revocadas: [], aviso: null }) });
    await abrir(page);
    await botonRol(page, 'Gestor de trámites').click();
    await expect(botonRol(page, 'Gestor de trámites')).toContainText(`${GESTOR.length}/${TODO.length}`);
    await desplegar(page, 'Gestión').click();
    await desplegar(page, 'SOAT').click();
    await desplegar(page, 'Exportar a Excel').click();
    await casilla(page, 'accion.soat.exportar_pago').check();
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect.poll(() => puts.length).toBe(1);
    expect((puts[0].postDataJSON() as { funciones: string[] }).funciones).toContain('accion.soat.ver_listado');

    await expect(page.getByText(/Sin guardar/)).toHaveCount(0);
    await expect(casilla(page, 'accion.soat.exportar_pago')).toBeChecked();
    await expect(casilla(page, 'accion.soat.ver_listado')).not.toBeChecked();
    await expect(casilla(page, 'pagina.tramite')).not.toBeChecked();
    await expect(botonRol(page, 'Gestor de trámites')).toContainText(`${servidor.length}/${TODO.length}`);
  });

  test('B2 (RN-A4 de #12085): si el guardado cambia la versión propia en /mios (7 → 8) aparece el aviso en página', async ({ page }) => {
    const { puts } = mockPermisos(page);
    let mios = 0;
    await page.route(/\/api\/permisos\/mios$/, (r) => {
      mios++;
      return r.fulfill(json({
        funciones: ['permisos.rol.listar', 'permisos.cuadro.ver', 'permisos.cuadro.guardar', 'permisos.rol.crear', 'permisos.rol.editar', 'permisos.rol.borrar'],
        rol: 'admin', tipoEnlace: null, version: puts.length > 0 ? 8 : 7, resueltoEn: '2026-10-15T12:00:00.000Z',
      }));
    });
    await loginAs(page, ADMIN_USER, { funciones: null });
    await page.goto('/roles-permisos');
    await expect(page.getByRole('heading', { name: 'Administrador', level: 2 })).toBeVisible();
    const avisoPropio = page.getByText('Este guardado cambió tu propio conjunto de funciones. Ya está aplicado en esta sesión, sin volver a entrar.');
    await expect(avisoPropio).toHaveCount(0);
    const antes = mios;
    await casilla(page, 'menu.perfil').uncheck();
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(avisoPropio).toBeVisible();
    expect(mios).toBeGreaterThan(antes);
  });

  test('B3: un PUT que responde 500 deja el aviso pulido en la barra, conserva el borrador y no enseña el error crudo ni un toast', async ({ page }) => {
    mockPermisos(page, { put: () => json({ error: 'duplicate key value violates unique constraint "permisos_rol_funciones_pkey"' }, 500) });
    await abrir(page);
    await casilla(page, 'menu.perfil').uncheck();
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(page.getByRole('alert')).toHaveText(COPY_ERROR_GUARDADO);
    await expect(page.getByText(/duplicate key|permisos_rol_funciones_pkey|Error del servidor/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cerrar aviso' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Mostrar dónde está' })).toHaveCount(0);
    await expect(page.getByText('Sin guardar: 1 desmarcada')).toBeVisible();
    await expect(casilla(page, 'menu.perfil')).not.toBeChecked();
  });

  test('B4 (AC8): 390×844 con el árbol desplegado, sin scroll horizontal en la página y axe sin graves', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    mockPermisos(page);
    await abrir(page);
    await page.getByLabel('Rol', { exact: true }).selectOption('gestor_tramites');
    await expect(page.getByRole('heading', { name: 'Gestor de trámites', level: 2 })).toBeVisible();
    for (const nombre of ['Gestión', 'SOAT', 'Exportar a Excel', 'Vehículos', 'PESV', 'Conductores']) {
      await desplegar(page, nombre).click();
    }
    await casilla(page, 'menu.gestion').click(); // inactivos + explicación: el caso más largo
    await expect(page.getByText(explicacionDesmarcado('Gestión', 'rol'))).toBeVisible();
    // La barra superior del shell ya desbordaba antes de esta HU: se mide la página (`main`), no el documento.
    const medida = await page.evaluate(() => {
      const main = document.querySelector('main') as HTMLElement;
      const fuera = [...main.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).length;
      return { scroll: main.scrollWidth, client: main.clientWidth, fuera };
    });
    expect(medida.scroll).toBeLessThanOrEqual(medida.client);
    expect(medida.fuera).toBe(0);
    await cargarAxe(page);
    esperarSinViolacionesGraves(await correrAxe(page), 'árbol de permisos · 390×844 desplegado con inactivos');
  });
});


test.describe('HU #13589 · panel sin permisos sueltos', () => {
  test('AC1/AC3/AC4: solo el árbol del menú, «N de M» = casillas del árbol, «Rendimiento» marcable en Administración', async ({ page }) => {
    const { puts } = mockPermisos(page);
    await abrir(page);
    await expect(page.getByRole('heading', { name: 'Administrador', level: 2 })).toBeVisible();
    // AC1: ni el bloque ni sus casillas.
    await expect(page.getByText(TITULO_SUELTOS)).toHaveCount(0);
    await expect(page.locator('li[data-codigo-fila="__transversales"]')).toHaveCount(0);
    for (const nombre of ['Consultar vehículos', 'Consultar persona en el RUNT', 'Leer la cédula', 'Buscar en Fasecolda']) {
      await expect(page.getByRole('checkbox', { name: new RegExp(`^${nombre}`) })).toHaveCount(0);
    }
    // AC3: el total es el de las casillas del árbol (sin Ayuda), nada más.
    await expect(page.getByRole('status').filter({ hasText: 'Permisos del rol Administrador.' }))
      .toHaveText(`Permisos del rol Administrador. ${TODO.length} de ${TODO.length} marcados.`);
    // AC4: Administración trae «Rendimiento», marcable.
    await desplegar(page, 'Administración').click();
    const rendimiento = page.getByRole('checkbox', { name: 'Rendimiento · rol Administrador', exact: true });
    await expect(rendimiento).toBeEnabled();
    await expect(rendimiento).toBeChecked();
    await rendimiento.uncheck();
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect.poll(() => puts.length).toBe(1);
    const enviadas = (puts[0].postDataJSON() as { funciones: string[] }).funciones;
    expect(enviadas).not.toContain('pagina.admin_rendimiento');
    expect(enviadas).toHaveLength(TODO.length - 1);
  });

  test('AC3: «Marcar todo» en un rol vacío marca todo el árbol (sin opcionales) y nada fuera de él', async ({ page }) => {
    const { puts } = mockPermisos(page);
    await abrir(page);
    await botonRol(page, 'Sin nada').click();
    await page.getByRole('button', { name: 'Marcar todo en el rol Sin nada', exact: true }).click();
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect.poll(() => puts.length).toBe(1);
    const enviadas = (puts[0].postDataJSON() as { funciones: string[] }).funciones;
    const opcionales = ['vehiculos.documento.ver', 'soat.descarga.reintentar'];
    expect([...enviadas].sort()).toEqual(TODO.filter((c) => !opcionales.includes(c)).sort());
    expect(enviadas).toContain('pagina.admin_rendimiento');
  });
});

// ─── AC4: excepciones por usuario en el modal Editar usuario ─────────────────────────────────────
const USUARIO = {
  id: 2, username: 'gestor1', name: 'Gestor Uno', email: null, role: 'gestor_tramites', active: true, allowedPages: [],
  funciones: [{ codigo: 'accion.organismos.ver', efecto: 'conceder' }, { codigo: 'accion.soat.exportar', efecto: 'revocar' }],
  flitoProveedorSoatId: null, organismosCodigos: [] as string[], createdAt: '2026-10-01T00:00:00.000Z',
};

function mockUsuario(page: Page, patch: () => ReturnType<typeof json>) {
  const patches: Request[] = [];
  page.route(/\/api\/permisos\/roles$/, (r) => r.fulfill(json({ roles: ROLES })));
  page.route(/\/api\/permisos\/funciones$/, (r) => r.fulfill(json({ grupos: [] })));
  page.route('**/api/users', (r) => r.fulfill(json([USUARIO])));
  page.route('**/api/users/2/arbol', (r) => {
    const exc = new Map(USUARIO.funciones.map((f) => [f.codigo, f.efecto as 'conceder' | 'revocar']));
    const rolSet = new Set(GESTOR);
    return r.fulfill(json({ userId: 2, rol: 'gestor_tramites', arbol: arbolUsuario(ARBOL, rolSet, exc) }));
  });
  page.route('**/api/users/2', (r) => {
    if (r.request().method() !== 'PATCH') return r.fulfill(json({}, 405));
    patches.push(r.request());
    return r.fulfill(patch());
  });
  return { patches };
}

test.describe('HU #13430 · excepciones por usuario (AC4)', () => {
  test('usuario (AC4/AC5): heredado vs excepción, «Añadido · sin efecto» con el ancestro que falta, agregar en cualquier nivel; 409 en el modal', async ({ page }) => {
    let responder409 = false;
    const { patches } = mockUsuario(page, () => (responder409
      ? json({ error: 'ANTI_BLOQUEO texto crudo', funcion: 'pagina.users', nodo: 'menu.administracion' }, 409)
      : json({ ...USUARIO })));
    await loginAs(page, ADMIN_USER);
    await page.goto('/users');
    await page.getByRole('button', { name: /^editar$/i }).first().click();
    const modal = page.getByRole('dialog');

    await expect(modal.getByRole('heading', { name: 'Permisos de este usuario' })).toBeVisible();
    // HU #13589 (AC2): el modal de excepciones tampoco trae el bloque de permisos sueltos.
    await expect(modal.getByText(TITULO_SUELTOS)).toHaveCount(0);
    await expect(modal.locator('li[data-codigo-fila="__transversales"]')).toHaveCount(0);
    await expect(modal.locator('[data-resumen="excepciones"]')).toHaveText(
      'Lo que trae del rol Gestor de trámites, con 2 excepciones: 1 añadida (1 sin efecto) y 1 quitada.',
    );
    // Los ancestros de cada excepción llegan desplegados.
    await expect(casilla(page, 'accion.organismos.ver')).toBeChecked();
    await expect(casilla(page, 'accion.organismos.ver')).toBeDisabled();
    await expect(fila(page, 'accion.organismos.ver')).toContainText('Añadido · sin efecto');
    await expect(fila(page, 'accion.organismos.ver')).toContainText(fraseSinEfecto('Tránsito'));
    await expect(casilla(page, 'accion.soat.exportar')).not.toBeChecked();
    await expect(fila(page, 'accion.soat.exportar')).toContainText('Quitado');
    await expect(fila(page, 'accion.soat.ver_listado')).toContainText('Del rol');
    await expect(fila(page, 'menu.transito')).toContainText('No lo trae');
    await expect(fila(page, 'menu.gestion')).toContainText('1 excepción');
    await expect(page.getByRole('checkbox', { name: 'Ver el listado · usuario gestor1' })).toBeVisible();

    // Agregar en el nivel 1: sigue sin efecto, ahora le falta el ítem.
    await casilla(page, 'menu.transito').click();
    await expect(fila(page, 'menu.transito')).toContainText('Añadido');
    await expect(fila(page, 'accion.organismos.ver')).toContainText(fraseSinEfecto('Organismos STT'));
    // Y en el nivel 2: deja de estar sin efecto.
    await casilla(page, 'pagina.organismos').check();
    await expect(fila(page, 'accion.organismos.ver')).not.toContainText('sin efecto');
    await expect(casilla(page, 'accion.organismos.ver')).toBeEnabled();
    // Volver a marcar lo del rol borra la excepción (vuelve a «Del rol»).
    await casilla(page, 'accion.soat.exportar').click();
    await expect(fila(page, 'accion.soat.exportar')).toContainText('Del rol');

    // AC5 en el modal: 409 → aviso role=alert con el nodo, modal abierto, sin toast ni texto del API.
    responder409 = true;
    await modal.getByRole('button', { name: /guardar cambios/i }).click();
    const alerta = modal.getByRole('alert');
    await expect(alerta).toContainText('Deja «Administración» a este usuario o dáselo antes a otro usuario activo. Tus cambios siguen aquí, sin guardar.');
    await expect(alerta).toBeFocused();
    await expect(page.getByText(/texto crudo/)).toHaveCount(0);
    await expect(modal).toBeVisible();
    await expect(casilla(page, 'pagina.organismos')).toBeChecked();

    // Guardado OK: el PATCH lleva las excepciones en cualquier nivel.
    responder409 = false;
    await modal.getByRole('button', { name: /guardar cambios/i }).click();
    await expect(page.getByText('Usuario actualizado')).toBeVisible();
    const cuerpo = patches.at(-1)?.postDataJSON() as { funciones: { codigo: string; efecto: string }[] };
    expect(cuerpo.funciones).toEqual(expect.arrayContaining([
      { codigo: 'accion.organismos.ver', efecto: 'conceder' },
      { codigo: 'menu.transito', efecto: 'conceder' },
      { codigo: 'pagina.organismos', efecto: 'conceder' },
    ]));
    expect(cuerpo.funciones).toHaveLength(3);
  });
});
