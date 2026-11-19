// HU #13970 (Feature #13939) — Usuarios: las funciones exclusivas del Administrador se ven bloqueadas en
// los permisos individuales de un usuario. Mismo patrón y copy que la HU #13951 (Roles y permisos).
//
// Backend mockeado con `page.route` (patrón de `users-permisos.spec.ts` y `permisos-exclusivas-admin.spec.ts`):
// el árbol del usuario se calcula del cuadro del rol + sus excepciones, con `exclusivaAdmin` como lo
// manda el API (#13944).
//   TZ=UTC npx playwright test e2e/tests/usuarios-exclusivas-admin.spec.ts
//
// Mapa AC → test: AC1 + AC4 → «otro rol»; AC2 → «Administrador»; AC3 → «409»; dato heredado → «heredado».
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER } from '../helpers/auth';
import { accion, arbolRol, arbolUsuario, codigosDe, elemento, item, type NodoDef } from '../helpers/arbolPermisos';
import { NOTA_EXCLUSIVA_USUARIO, NOTA_EXCLUSIVA_USUARIO_ADMIN } from '../../src/pages/roles-permisos/arbol';

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const exclusiva = (codigo: string, nombre: string): NodoDef => ({ ...accion(codigo, nombre), exclusivaAdmin: true });

const EXCLUSIVAS = [
  ['accion.clientes.activar', 'Activar o desactivar clientes'],
  ['accion.clientes.eliminar', 'Eliminar clientes'],
  ['accion.proveedores.activar', 'Activar o desactivar proveedores'],
  ['accion.proveedores.eliminar', 'Eliminar proveedores'],
] as const;
const ELIMINAR = 'accion.clientes.eliminar';

const ARBOL: NodoDef[] = [
  elemento('gestion', 'Gestión', [
    item('clientes', 'Clientes', [accion('accion.clientes.ver', 'Ver clientes'), exclusiva(...EXCLUSIVAS[0]), exclusiva(...EXCLUSIVAS[1])]),
    item('proveedores', 'Proveedores', [accion('accion.proveedores.ver', 'Ver proveedores'), exclusiva(...EXCLUSIVAS[2]), exclusiva(...EXCLUSIVAS[3])]),
  ]),
  elemento('administracion', 'Administración', [item('users', 'Usuarios')]),
];
const CUADROS: Record<string, string[]> = {
  admin: codigosDe(ARBOL),
  coordinador: ['menu.gestion', 'pagina.clientes', 'accion.clientes.ver', 'pagina.proveedores', 'accion.proveedores.ver'],
};

const rolCatalogo = (codigo: string, nombre: string) => ({
  codigo, nombre, descripcion: null, tipoEnlace: 'ninguno', esSistema: true, activo: true, usuarios: 0,
  borrable: false, motivoNoBorrable: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
});
const ROLES = [rolCatalogo('admin', 'Administrador'), rolCatalogo('coordinador', 'Coordinador')];

type Funcion = { codigo: string; efecto: 'conceder' | 'revocar' };
const usuario = (role: string, funciones: Funcion[] = []) => ({
  id: 7, username: 'operador7', name: 'Operador Siete', email: null, role, active: true, allowedPages: [], funciones,
  flitoProveedorSoatId: null, organismosCodigos: [] as string[], createdAt: '2026-01-01T00:00:00.000Z',
});

/** Monta los mocks; `patch` decide la respuesta del `PATCH /users/7`. Devuelve los bodies enviados. */
async function abrir(page: Page, u: ReturnType<typeof usuario>, patch?: () => ReturnType<typeof json>) {
  const patches: Record<string, unknown>[] = [];
  await page.route(/\/api\/users$/, (r) => r.fulfill(json([u])));
  await page.route(/\/api\/users\/7$/, (r) => {
    if (r.request().method() !== 'PATCH') return r.fulfill(json({}, 405));
    patches.push(r.request().postDataJSON() as Record<string, unknown>);
    return r.fulfill(patch ? patch() : json(u));
  });
  await page.route(/\/api\/users\/7\/arbol$/, (r) => r.fulfill(json({
    userId: 7, rol: u.role, transversales: [],
    arbol: arbolUsuario(ARBOL, new Set(CUADROS[u.role]), new Map(u.funciones.map((f) => [f.codigo, f.efecto]))),
  })));
  await page.route(/\/api\/permisos\/roles\/([^/]+)\/arbol$/, (r) => {
    const codigo = decodeURIComponent(new URL(r.request().url()).pathname.split('/').at(-2) ?? '');
    return r.fulfill(json({ rol: { codigo, nombre: codigo, tipoEnlace: 'ninguno' }, arbol: arbolRol(ARBOL, new Set(CUADROS[codigo] ?? [])), transversales: [] }));
  });
  await page.route(/\/api\/permisos\/funciones$/, (r) => r.fulfill(json({ grupos: [] })));
  await page.route(/\/api\/permisos\/roles$/, (r) => r.fulfill(json({ roles: ROLES })));

  await loginAs(page, ADMIN_USER);
  await page.goto('/users');
  await page.getByRole('button', { name: /^editar$/i }).first().click();
  await page.getByRole('button', { name: 'Contenido de Gestión', exact: true }).click();
  await page.getByRole('button', { name: 'Contenido de Clientes', exact: true }).click();
  await page.getByRole('button', { name: 'Contenido de Proveedores', exact: true }).click();
  return { patches };
}

const casilla = (page: Page, codigo: string) => page.locator(`input[type="checkbox"][data-codigo="${codigo}"]`);
const fila = (page: Page, codigo: string) => page.locator(`li[data-codigo-fila="${codigo}"]`);
const guardar = (page: Page) => page.getByRole('button', { name: 'Guardar cambios' }).click();

test.describe('HU #13970 · Usuarios: exclusivas del Administrador', () => {
  test('otro rol (AC1/AC4): las cuatro exclusivas desmarcadas, bloqueadas, enfocables y con la nota en aria-describedby; no se añaden', async ({ page }) => {
    const { patches } = await abrir(page, usuario('coordinador'));

    for (const [codigo, nombre] of EXCLUSIVAS) {
      const c = casilla(page, codigo);
      await expect(c).not.toBeChecked();
      await expect(c).toHaveAttribute('aria-disabled', 'true');
      await expect(c).not.toHaveAttribute('disabled', /.*/);
      const nota = fila(page, codigo).locator('[data-aviso="exclusiva-admin"]');
      await expect(nota).toHaveText(NOTA_EXCLUSIVA_USUARIO);
      await expect(nota).toContainText('Exclusiva del Administrador');
      const idNota = await nota.getAttribute('id');
      expect(idNota).toBeTruthy();
      expect((await c.getAttribute('aria-describedby'))?.split(' ')).toContain(idNota);
      await expect(page.getByRole('checkbox', { name: new RegExp(`^${nombre}`) })).toHaveAccessibleDescription(/Exclusiva del Administrador/);
    }

    // AC4: enfocable; clic, clic en el nombre y Espacio no la añaden como excepción.
    const eliminar = casilla(page, ELIMINAR);
    await eliminar.dispatchEvent('click');
    await fila(page, ELIMINAR).locator('label').dispatchEvent('click');
    await eliminar.focus();
    await expect(eliminar).toBeFocused();
    await page.keyboard.press('Space');
    await expect(eliminar).not.toBeChecked();
    await expect(fila(page, ELIMINAR)).not.toContainText('Añadido');
    await expect(page.getByRole('button', { name: 'Quitar las excepciones' })).toHaveCount(0);

    // Un cambio real sí viaja, y sin ninguna exclusiva.
    await casilla(page, 'accion.clientes.ver').click();
    await guardar(page);
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0].funciones).toEqual([{ codigo: 'accion.clientes.ver', efecto: 'revocar' }]);
  });

  test('heredado: una excepción guardada sobre una exclusiva no se pinta ni se reenvía', async ({ page }) => {
    const { patches } = await abrir(page, usuario('coordinador', [{ codigo: ELIMINAR, efecto: 'conceder' }]));
    await expect(casilla(page, ELIMINAR)).not.toBeChecked();
    await expect(fila(page, ELIMINAR)).not.toContainText('Añadido');
    await casilla(page, 'accion.proveedores.ver').click();
    await guardar(page);
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0].funciones).toEqual([{ codigo: 'accion.proveedores.ver', efecto: 'revocar' }]);
  });

  test('Administrador (AC2): concedidas por el rol, bloqueadas y no se pueden quitar', async ({ page }) => {
    await abrir(page, usuario('admin'));
    for (const [codigo] of EXCLUSIVAS) {
      const c = casilla(page, codigo);
      await expect(c).toBeChecked();
      await expect(c).toHaveAttribute('aria-disabled', 'true');
      await expect(fila(page, codigo).locator('[data-aviso="exclusiva-admin"]')).toHaveText(NOTA_EXCLUSIVA_USUARIO_ADMIN);
      await expect(fila(page, codigo)).toContainText('Del rol');
    }
    const eliminar = casilla(page, ELIMINAR);
    await eliminar.dispatchEvent('click');
    await eliminar.focus();
    await page.keyboard.press('Space');
    await expect(eliminar).toBeChecked();
    await expect(fila(page, ELIMINAR)).not.toContainText('Quitado');
  });

  test('409 (AC3): FuncionExclusivaAdmin → aviso pulido en el modal, sin el texto del API; el formulario se conserva', async ({ page }) => {
    await abrir(page, usuario('coordinador'), () => json({ error: 'FuncionExclusivaAdmin texto crudo del API', funcion: ELIMINAR }, 409));
    const nombre = page.getByLabel('Nombre completo');
    await nombre.fill('Operador Siete Editado');
    await casilla(page, 'accion.clientes.ver').click();
    await guardar(page);

    const alerta = page.getByRole('alert');
    await expect(alerta).toHaveText('No se guardó: «Eliminar clientes» es exclusiva del Administrador y no se puede dar a este usuario. Cierra y vuelve a abrir el usuario para ver sus permisos al día. Tus cambios siguen aquí, sin guardar.');
    await expect(alerta).toBeFocused();
    await expect(page.getByText(/texto crudo/)).toHaveCount(0);
    await expect(nombre).toHaveValue('Operador Siete Editado');
    await expect(casilla(page, 'accion.clientes.ver')).not.toBeChecked();
    await expect(fila(page, 'accion.clientes.ver')).toContainText('Quitado');
    await page.getByRole('button', { name: 'Mostrar dónde está' }).click();
    await expect(casilla(page, ELIMINAR)).toBeFocused();
  });
});
