// HU #13951 (Feature #13939) — Roles y permisos: las funciones exclusivas del Administrador se ven como
// no asignables. Spec UX: `docs/ux/permisos-exclusivas-admin-13951-slim.md`.
//
// Backend mockeado con `page.route` (patrón de `permisos-arbol.spec.ts`): el árbol se CALCULA de las
// marcas guardadas (`e2e/helpers/arbolPermisos.ts`), con `exclusivaAdmin` como lo manda el API (#13944).
//   TZ=UTC npx playwright test e2e/tests/permisos-exclusivas-admin.spec.ts
//
// Mapa AC → test: AC1 + AC4 → «otro rol»; AC2 → «Administrador»; AC3 → «409»; dato heredado → «heredado».
import type { Page, Request } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER } from '../helpers/auth';
import { accion, arbolRol, codigosDe, elemento, item, type NodoDef } from '../helpers/arbolPermisos';
import { NOTA_EXCLUSIVA_ADMIN, NOTA_EXCLUSIVA_OTRO_ROL } from '../../src/pages/roles-permisos/arbol';

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

const ELIMINAR = 'accion.clientes.eliminar';
const ARBOL: NodoDef[] = [
  elemento('gestion', 'Gestión', [
    item('clientes', 'Clientes', [
      accion('accion.clientes.ver', 'Ver clientes'),
      accion('accion.clientes.crear', 'Crear clientes'),
      { ...accion(ELIMINAR, 'Eliminar clientes', [], 'Borra el cliente y su historial.'), exclusivaAdmin: true },
    ]),
  ]),
  elemento('administracion', 'Administración', [
    item('users', 'Usuarios', [accion('accion.usuarios.ver', 'Ver usuarios')]),
  ]),
  elemento('ayuda', 'Ayuda', [], { derivado: true }),
];
const TODO = codigosDe(ARBOL);
const COORDINADOR = ['menu.gestion', 'pagina.clientes', 'accion.clientes.ver'];

const rol = (codigo: string, nombre: string, usuarios = 0) => ({
  codigo, nombre, descripcion: null, tipoEnlace: 'ninguno', esSistema: codigo === 'admin', activo: true, usuarios,
  borrable: usuarios === 0 && codigo !== 'admin', motivoNoBorrable: usuarios > 0 ? `${usuarios} usuarios tienen este rol` : null,
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
});
const ROLES = [rol('admin', 'Administrador', 2), rol('coordinador', 'Coordinador', 3), rol('heredado', 'Heredado')];

type Respuesta = ReturnType<typeof json>;

function mockPermisos(page: Page, put?: (codigo: string, funciones: string[]) => Respuesta) {
  const cuadros: Record<string, string[]> = {
    admin: [...TODO], coordinador: [...COORDINADOR], heredado: [...COORDINADOR, ELIMINAR],
  };
  const puts: Request[] = [];
  page.route(/\/api\/permisos\/roles$/, (r) => r.fulfill(json({ roles: ROLES })));
  page.route(/\/api\/permisos\/funciones$/, (r) => r.fulfill(json({ grupos: [] })));
  page.route(/\/api\/permisos\/roles\/([^/]+)\/arbol$/, (r) => {
    const codigo = decodeURIComponent(new URL(r.request().url()).pathname.split('/').at(-2) ?? '');
    const datos = ROLES.find((x) => x.codigo === codigo);
    return r.fulfill(json({
      rol: { codigo, nombre: datos?.nombre ?? codigo, tipoEnlace: 'ninguno' },
      arbol: arbolRol(ARBOL, new Set(cuadros[codigo] ?? [])),
    }));
  });
  page.route(/\/api\/permisos\/roles\/([^/]+)\/funciones$/, (r) => {
    const req = r.request();
    const codigo = decodeURIComponent(new URL(req.url()).pathname.split('/').at(-2) ?? '');
    if (req.method() === 'PUT') {
      puts.push(req);
      const enviadas = (req.postDataJSON() as { funciones: string[] }).funciones;
      const respuesta = (put ?? ((c: string, f: string[]) => json({ codigo: c, funciones: f, concedidas: [], revocadas: [], aviso: null })))(codigo, enviadas);
      if (respuesta.status === 200) cuadros[codigo] = enviadas;
      return r.fulfill(respuesta);
    }
    return r.fulfill(json({ codigo, funciones: cuadros[codigo] ?? [] }));
  });
  return { puts };
}

async function abrir(page: Page, nombreRol: string) {
  await loginAs(page, ADMIN_USER, {});
  await page.goto('/roles-permisos');
  await expect(page.getByRole('heading', { name: 'Roles y permisos', level: 1 })).toBeVisible();
  if (nombreRol !== 'Administrador') await page.getByRole('button', { name: new RegExp(`^${nombreRol}`) }).click();
  await expect(page.getByRole('heading', { name: nombreRol, level: 2 })).toBeVisible();
  await page.getByRole('button', { name: 'Contenido de Gestión', exact: true }).click();
  await page.getByRole('button', { name: 'Contenido de Clientes', exact: true }).click();
}

const casilla = (page: Page, codigo: string) => page.locator(`input[type="checkbox"][data-codigo="${codigo}"]`);
const fila = (page: Page, codigo: string) => page.locator(`li[data-codigo-fila="${codigo}"]`);
const funcionesDe = (req: Request) => (req.postDataJSON() as { funciones: string[] }).funciones;

test.describe('HU #13951 · exclusivas del Administrador', () => {
  test('otro rol (AC1/AC4): bloqueada desmarcada con nota en aria-describedby; no cambia; Marcar todo la salta y el PUT no la lleva', async ({ page }) => {
    const { puts } = mockPermisos(page);
    await abrir(page, 'Coordinador');

    const eliminar = casilla(page, ELIMINAR);
    await expect(eliminar).not.toBeChecked();
    await expect(eliminar).toHaveAttribute('aria-disabled', 'true');
    await expect(eliminar).not.toHaveAttribute('disabled', /.*/);
    const nota = fila(page, ELIMINAR).locator('[data-aviso="exclusiva-admin"]');
    await expect(nota).toContainText('Exclusiva del Administrador');
    await expect(nota).toHaveText(NOTA_EXCLUSIVA_OTRO_ROL);
    // AC4: la nota va en el aria-describedby, justo después de la descripción.
    const idNota = await nota.getAttribute('id');
    const describedBy = (await eliminar.getAttribute('aria-describedby'))?.split(' ') ?? [];
    expect(idNota).toBeTruthy();
    expect(describedBy.indexOf(idNota as string)).toBe(1);
    await expect(page.getByRole('checkbox', { name: /Eliminar clientes/ })).toHaveAccessibleDescription(/Borra el cliente y su historial\. Exclusiva del Administrador/);

    // Clic, clic en el nombre y Espacio: no cambia ni aparece la barra «Sin guardar».
    await eliminar.dispatchEvent('click');
    await fila(page, ELIMINAR).locator('label').dispatchEvent('click');
    await eliminar.focus();
    await page.keyboard.press('Space');
    await expect(eliminar).not.toBeChecked();
    await expect(page.getByText(/^Sin guardar/)).toHaveCount(0);

    // La exclusiva no cuenta: «1 de 2», y con «Marcar todo» del elemento llega a «2 de 2» y marcada.
    await expect(fila(page, 'pagina.clientes')).toContainText('1 de 2');
    await page.getByRole('button', { name: 'Marcar todo en Gestión', exact: true }).click();
    await expect(casilla(page, 'accion.clientes.crear')).toBeChecked();
    await expect(eliminar).not.toBeChecked();
    await expect(fila(page, 'pagina.clientes').locator('span[id$="cuenta-pagina_clientes"]')).toHaveText('2 de 2');
    await expect(casilla(page, 'pagina.clientes')).toHaveAttribute('data-estado', 'marcada');
    await expect(casilla(page, 'menu.gestion')).toHaveAttribute('data-estado', 'marcada');

    // «Marcar todo» del rol: tampoco la marca.
    await page.getByRole('button', { name: 'Marcar todo en el rol Coordinador', exact: true }).click();
    await expect(eliminar).not.toBeChecked();
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect.poll(() => puts.length).toBe(1);
    expect(funcionesDe(puts[0])).not.toContain(ELIMINAR);
    expect(funcionesDe(puts[0])).toContain('accion.clientes.crear');
  });

  test('Administrador (AC2): marcadas y bloqueadas; Desmarcar todo no las quita y el PUT siempre las lleva', async ({ page }) => {
    const { puts } = mockPermisos(page);
    await abrir(page, 'Administrador');

    const eliminar = casilla(page, ELIMINAR);
    await expect(eliminar).toBeChecked();
    await expect(eliminar).toHaveAttribute('aria-disabled', 'true');
    await expect(fila(page, ELIMINAR).locator('[data-aviso="exclusiva-admin"]')).toHaveText(NOTA_EXCLUSIVA_ADMIN);
    await eliminar.dispatchEvent('click');
    await expect(eliminar).toBeChecked();
    await expect(page.getByText(/^Sin guardar/)).toHaveCount(0);

    await page.getByRole('button', { name: 'Desmarcar todo en Gestión', exact: true }).click();
    await expect(eliminar).toBeChecked();
    await expect(casilla(page, 'accion.clientes.ver')).not.toBeChecked();
    await page.getByRole('button', { name: 'Desmarcar todo en el rol Administrador', exact: true }).click();
    await expect(eliminar).toBeChecked();
    // Para guardar sin vaciar el rol: vuelve a marcar Administración (el PUT lleva la exclusiva igual).
    await casilla(page, 'menu.administracion').click();
    await expect(casilla(page, 'menu.administracion')).toHaveAttribute('data-estado', 'parcial');
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect.poll(() => puts.length).toBe(1);
    expect(funcionesDe(puts[0])).toContain(ELIMINAR);
  });

  test('409 (AC3): FuncionExclusivaAdmin → aviso en página con el nombre, sin el texto del API, foco y «Mostrar dónde está»; el anti-bloqueo conserva su copy', async ({ page }) => {
    let cuerpo: Record<string, string> = { error: 'EXCLUSIVA texto crudo del API', funcion: ELIMINAR };
    mockPermisos(page, () => json(cuerpo, 409));
    await abrir(page, 'Coordinador');
    await casilla(page, 'accion.clientes.crear').check();
    await page.getByRole('button', { name: 'Guardar cambios' }).click();

    const alerta = page.getByRole('alert');
    await expect(alerta).toHaveText('No se guardó: «Eliminar clientes» es exclusiva del Administrador y no se puede dar a otro rol. Desmárcala y vuelve a guardar. Tus cambios siguen aquí, sin guardar.');
    await expect(page.getByText(/texto crudo/)).toHaveCount(0);
    await expect(alerta).toBeFocused();
    await expect(page.getByText('Sin guardar: 1 marcada')).toBeVisible();
    await expect(casilla(page, 'accion.clientes.crear')).toBeChecked();
    await page.getByRole('button', { name: 'Mostrar dónde está' }).click();
    await expect(casilla(page, ELIMINAR)).toBeFocused();

    // Un 409 cuya `funcion` no es exclusiva sigue siendo el anti-bloqueo de siempre.
    cuerpo = { error: 'ANTI_BLOQUEO texto crudo del API', funcion: 'accion.usuarios.ver' };
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(alerta).toContainText('No se guardó: con este cambio FLITO se quedaría sin ningún usuario activo');
    await expect(alerta).not.toContainText('exclusiva');
    await expect(page.getByText(/texto crudo/)).toHaveCount(0);
  });

  test('409 (AC3) en el Administrador: copy de «no la puede perder»', async ({ page }) => {
    mockPermisos(page, () => json({ error: 'EXCLUSIVA texto crudo', funcion: ELIMINAR }, 409));
    await abrir(page, 'Administrador');
    await casilla(page, 'accion.clientes.crear').uncheck();
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(page.getByRole('alert')).toHaveText('No se guardó: «Eliminar clientes» es exclusiva del Administrador y este rol no la puede perder. Vuelve a marcarla y guarda de nuevo. Tus cambios siguen aquí, sin guardar.');
  });

  test('heredado: un rol que trae la exclusiva marcada la pinta desmarcada y el guardado la quita', async ({ page }) => {
    const { puts } = mockPermisos(page);
    await abrir(page, 'Heredado');
    await expect(casilla(page, ELIMINAR)).not.toBeChecked();
    await expect(page.getByText('Sin guardar: 1 desmarcada')).toBeVisible();
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect.poll(() => puts.length).toBe(1);
    expect(funcionesDe(puts[0])).not.toContain(ELIMINAR);
  });
});
