// HU #12172 (Feature #12072) — Reporte de usuarios por rol: filtro, conteo y descarga del `.xlsx`.
//
// El backend va mockeado con `page.route`, como el resto de la carpeta: estos casos certifican la
// PANTALLA —qué pide, qué pinta y qué se lleva—, no la consulta SQL.
//
// Tres apuntes de método, porque sin ellos hay asertos que pasarían por vacío:
//
//   1. **El filtro se afirma por las DOS puntas.** Que la tabla quede en una fila también es cierto
//      si la pantalla filtra en el cliente y no le pide nada al servidor; lo que mata ese mutante es
//      `expect(pedidos.at(-1)).toContain('rol=compliance')`. Y al revés: comprobar solo la query
//      dejaría verde una pantalla que pide bien y pinta la lista vieja.
//   2. **El conteo se afirma contra `/users/resumen`, con números que NO coinciden con las filas.**
//      El fixture tiene 1 fila admin y el resumen dice 7 admin: si alguien contara el array del
//      listado en vez de leer el resumen, el número saldría distinto y el caso caería. Con números
//      iguales, las dos implementaciones serían indistinguibles.
//   3. **El total filtrado sale de `X-Total-Count`, no de `rows.length`.** El mock responde una
//      sola fila con la cabecera en 4 — que es lo que pasa de verdad al paginar—, así que el «4
//      coinciden» solo puede venir de la cabecera.
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER } from '../helpers/auth';

type Fila = Record<string, unknown>;

/** Un usuario del listado con la forma COMPLETA del contrato: `organismosCodigos` SIEMPRE array. */
function usuario(over: Fila): Fila {
  return {
    id: 2, username: 'u', name: 'Usuario', email: null, role: 'admin', active: true,
    allowedPages: [], transitoCodigo: null, companiaId: null,
    flitoProveedorSoatId: null, organismosCodigos: [],
    createdAt: '2026-01-01T00:00:00.000Z', ...over,
  };
}

const ADMINA = usuario({ id: 1, username: 'admina', name: 'Ada Admin', role: 'admin' });
const CUMPLE = usuario({ id: 2, username: 'cumple', name: 'Carlos Cumplimiento', role: 'compliance' });
const AUDITA = usuario({ id: 3, username: 'audita', name: 'Aura Auditora', role: 'auditor' });

/**
 * Tal como lo sirve `GET /users/resumen`: los DOCE roles presentes, los vacíos en `0`. El fixture
 * los trae todos a propósito —no solo los tres con gente—: es lo que convierte «Conductor no
 * aparece» en un aserto sobre la decisión de no pintar ceros, y no en un aserto sobre una clave que
 * el mock se olvidó de poner.
 */
const RESUMEN = {
  porRol: {
    admin: 7, compliance: 2, auditor: 1, transito: 0, proveedor: 0, lider_pesv: 0,
    supervisor_flota: 0, conductor: 0, gestor_impuestos: 0, mensajero: 0, financiera: 0, cliente: 0,
  },
  activos: 9,
  inactivos: 1,
};

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

/**
 * Mock del listado. Devuelve un ARRAY PLANO y pone el total en `X-Total-Count`, que es el contrato
 * de la HU; `pedidos` guarda cada URL para poder afirmar QUÉ se pidió y no solo qué se pintó.
 *
 * El orden de registro importa: Playwright resuelve la última ruta registrada que casa, así que
 * `/users/resumen` y `/users/export` se registran DESPUÉS del listado.
 */
function mockUsers(page: Page) {
  const pedidos: string[] = [];
  page.route(/\/api\/users(\?.*)?$/, (route) => {
    const url = route.request().url();
    pedidos.push(url);
    const rol = new URL(url).searchParams.get('rol');
    // Una sola fila con la cabecera en 4: el «coinciden» no puede salir de contar el array.
    if (rol === 'compliance') {
      return route.fulfill({ ...json([CUMPLE]), headers: { 'content-type': 'application/json', 'X-Total-Count': '4' } });
    }
    return route.fulfill({ ...json([ADMINA, CUMPLE, AUDITA]), headers: { 'content-type': 'application/json', 'X-Total-Count': '3' } });
  });
  page.route(/\/api\/users\/resumen$/, (route) => route.fulfill(json(RESUMEN)));
  return pedidos;
}

test.describe('Usuarios — filtro por rol, conteo y descarga (HU #12172)', () => {
  test('TC-12172-01: filtrar por rol reduce las filas Y viaja en la query', async ({ page }) => {
    const pedidos = mockUsers(page);
    await loginAs(page, ADMIN_USER);
    await page.goto('/users');

    const filas = page.locator('tbody tr');
    await expect(filas).toHaveCount(3);
    await expect(page.getByText('Ada Admin')).toBeVisible();

    await page.getByLabel('Rol', { exact: true }).selectOption('compliance');

    await expect(filas).toHaveCount(1);
    await expect(page.getByText('Carlos Cumplimiento')).toBeVisible();
    await expect(page.getByText('Ada Admin')).toHaveCount(0);
    // La otra punta: el recorte lo pidió el SERVIDOR, no un `.filter()` en el cliente.
    expect(pedidos.at(-1)).toContain('rol=compliance');
    // Y sin filtro la ruta es `/users` a secas: no se manda un `rol=` vacío.
    expect(pedidos[0]).not.toContain('rol=');
    // El total sale de `X-Total-Count` (4), no de la fila que se pintó.
    await expect(page.getByText(/4 coinciden con el filtro/)).toBeVisible();
  });

  test('TC-12172-02: el conteo por rol se pinta con los números de /users/resumen', async ({ page }) => {
    mockUsers(page);
    await loginAs(page, ADMIN_USER);
    await page.goto('/users');

    const conteo = page.getByLabel('Usuarios por rol');
    // 7 admin frente a 1 fila admin en el listado: el número solo puede venir del resumen.
    await expect(conteo.getByText(/Administrador.*:\s*7/)).toBeVisible();
    await expect(conteo.getByText(/9 activos · 1 inactivos/)).toBeVisible();
    // Un rol sin usuarios en `porRol` NO se pinta con cero.
    await expect(conteo.getByText(/Conductor/)).toHaveCount(0);
  });

  test('TC-12172-03: la descarga pide /users/export con el filtro puesto', async ({ page }) => {
    mockUsers(page);
    const exports: string[] = [];
    await page.route(/\/api\/users\/export(\?.*)?$/, (route) => {
      exports.push(route.request().url());
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        body: 'xlsx-de-mentira',
      });
    });

    await loginAs(page, ADMIN_USER);
    await page.goto('/users');

    await page.getByLabel('Rol', { exact: true }).selectOption('compliance');
    await expect(page.locator('tbody tr')).toHaveCount(1);

    const descarga = page.waitForEvent('download');
    await page.getByRole('button', { name: /descargar excel/i }).click();
    expect((await descarga).suggestedFilename()).toBe('usuarios.xlsx');

    // El archivo lleva el MISMO FILTRO que el listado. No las mismas filas: `GET /users/export`
    // ignora la paginación y baja todas las coincidencias, y eso es lo que dice el texto del botón.
    expect(exports).toHaveLength(1);
    expect(exports[0]).toContain('rol=compliance');
  });

  test('TC-12172-04: el listado en error pinta el cuarto estado y el reintento recarga', async ({ page }) => {
    let falla = true;
    const pedidos: string[] = [];
    await page.route(/\/api\/users(\?.*)?$/, (route) => {
      pedidos.push(route.request().url());
      if (falla) return route.fulfill(json({ error: 'Error del servidor' }, 500));
      return route.fulfill({ ...json([ADMINA]), headers: { 'content-type': 'application/json', 'X-Total-Count': '1' } });
    });
    await page.route(/\/api\/users\/resumen$/, (route) => route.fulfill(json(RESUMEN)));

    await loginAs(page, ADMIN_USER);
    await page.goto('/users');

    await expect(page.getByText('No se pudo cargar la lista de usuarios')).toBeVisible();
    // El mutante que este aserto mata: dejar la rama vacía atendiendo también el fallo. Un error
    // que se lea «Sin usuarios» es un dato falso.
    await expect(page.getByText('Sin usuarios')).toHaveCount(0);

    falla = false;
    await page.getByRole('button', { name: /reintentar/i }).click();

    await expect(page.getByText('Ada Admin')).toBeVisible();
    await expect(page.getByText('No se pudo cargar la lista de usuarios')).toHaveCount(0);
    expect(pedidos.length).toBeGreaterThanOrEqual(2);
  });

  /**
   * La guarda `esResumen` comprueba la forma que consume el ÁRBOL de componentes, no solo la que lee
   * `Users.tsx`: `ConteoPorRol` desreferencia `activos` e `inactivos`.
   *
   * El mutante que este caso mata es quitarle esas dos comprobaciones. Con la guarda a medias, el
   * resumen de abajo la supera y la barra pinta «Administrador: 7» junto a «activos · inactivos»
   * SIN número: incompleto, sin error y sin aviso. Con la guarda entera el conteo no se pinta —es
   * información secundaria— y la tabla, que sí cargó, sigue sirviendo.
   */
  test('TC-12172-05: un resumen sin activos/inactivos no supera la guarda y no pinta el conteo', async ({ page }) => {
    await page.route(/\/api\/users(\?.*)?$/, (route) => route.fulfill({
      ...json([ADMINA]), headers: { 'content-type': 'application/json', 'X-Total-Count': '1' },
    }));
    // La forma exacta de la sonda: `porRol` bien, los otros dos campos del contrato ausentes.
    await page.route(/\/api\/users\/resumen$/, (route) => route.fulfill(json({ porRol: { admin: 7 } })));

    await loginAs(page, ADMIN_USER);
    await page.goto('/users');

    // La pantalla no se cae por el resumen malo: la lista está.
    await expect(page.getByText('Ada Admin')).toBeVisible();
    // Y el bloque del conteo no existe: ni el número que sí venía ni las etiquetas huérfanas.
    await expect(page.getByLabel('Usuarios por rol')).toHaveCount(0);
    await expect(page.getByText(/Administrador:\s*7/)).toHaveCount(0);
    await expect(page.getByText(/activos · inactivos/)).toHaveCount(0);
  });
});
