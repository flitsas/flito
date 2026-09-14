// FLITO — Servicios adicionales: la página del catálogo de tipos (HU #12542). Backend mockeado.
//
// Cubre AC1–AC7 con la matriz del QA (TC-12542-01..16, comentario 29448971) y sus mutantes:
//
//   · **Las escrituras se afirman sobre las peticiones** (espía `METHOD path` + cuerpos capturados
//     con `toEqual`, no `toMatchObject`): el PATCH parcial, el POST sin `descripcion: ''` y la baja
//     por `POST /:id/baja` no dejan otra huella.
//   · **Tras cada 201/200 la lista se repide al servidor**: el re-GET trae una fila «Zeta» que la web
//     no pudo inventar. Si apareciera solo lo guardado, la web estaría parcheando en local.
//   · **El GET se mide con contador tolerante a StrictMode** y el error se afirma con «falla hasta
//     que se pulsa Reintentar», como en tarifas.
//   · **AC6 se mide con el módulo abortado**: si algo se escapa cae el espía Y cae `NoAccess`.
//   · **La ruta se protege por SU slug** (TC-02): un auditor con `flito_servicios_adicionales`
//     concedido a mano entra; con solo `flito_tarifas` ve `NoAccess`.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER, FINANCIERA_USER, AUDITOR_USER, CLIENTE_USER, funcionesDe } from '../helpers/auth';
import { correrAxe, esperarSinViolacionesGraves } from '../helpers/axe';

const raiz = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');

const CANARIO = '/api/__qa_canary';
const RUTA = '/api/flito/parametrizacion/servicios-adicionales';
const RE_LISTA = /\/api\/flito\/parametrizacion\/servicios-adicionales(\?.*)?$/;
const RE_TIPO = /\/api\/flito\/parametrizacion\/servicios-adicionales\/[^/?]+$/;
const RE_BAJA = /\/api\/flito\/parametrizacion\/servicios-adicionales\/[^/?]+\/baja$/;

interface Tipo {
  id: string; nombre: string; descripcion: string | null; valor: number; activo: boolean;
  dadoDeBajaEn: string | null; dadoDeBajaPorId: number | null; creadoEn: string; creadoPorId: number | null;
  actualizadoEn: string; actualizadoPorId: number | null;
}

const tipo = (id: string, nombre: string, valor: number, descripcion: string | null = null, extra: Partial<Tipo> = {}): Tipo => ({
  id, nombre, descripcion, valor, activo: true, dadoDeBajaEn: null, dadoDeBajaPorId: null,
  creadoEn: '2026-09-01T12:00:00.000Z', creadoPorId: null, actualizadoEn: '2026-09-01T12:00:00.000Z', actualizadoPorId: null,
  ...extra,
});

/** Orden del servidor (nombre plegado): Derecho de petición · Diagnóstico · Diagnóstico express (baja) · Paz y salvo. */
const DIAGNOSTICO = tipo('sa-1', 'Diagnóstico', 85000, 'Revisión inicial');
const EXPRESS_BAJA = tipo('sa-4', 'Diagnóstico express', 30000, 'Solo revisión visual.', {
  activo: false, dadoDeBajaEn: '2026-09-10T15:00:00.000Z', dadoDeBajaPorId: 10,
});
const PAZ_Y_SALVO = tipo('sa-2', 'Paz y salvo de impuestos', 1250000);
const PETICION = tipo('sa-3', 'Derecho de petición', 0, 'Redacción y radicación ante la autoridad de tránsito.');
/** Como lo devuelve `GET ?incluirBajas=1`: intercalado por nombre. Sin el parámetro, solo activos. */
const CATALOGO = [PETICION, DIAGNOSTICO, EXPRESS_BAJA, PAZ_Y_SALVO];

const json = (cuerpo: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(cuerpo) });

interface Escritura { metodo: string; path: string; cuerpo: unknown }
interface Catalogo {
  /** La lista que el servidor tiene AHORA (el spec la muta para simular otros usuarios). */
  lista: Tipo[];
  /** Cuántos GET salieron. */
  veces: () => number;
  /** El query string de cada GET, en orden ('' o '?incluirBajas=1'). */
  consultas: string[];
  /** Cada POST/PATCH con su cuerpo, en orden. */
  escrituras: Escritura[];
}

interface Respuestas {
  crear?: (route: Route, cuerpo: unknown) => Promise<void> | void;
  editar?: (route: Route, id: string, cuerpo: unknown) => Promise<void> | void;
  baja?: (route: Route, id: string) => Promise<void> | void;
  lista?: (route: Route) => Promise<void> | void;
}

const pathDe = (route: Route) => new URL(route.request().url()).pathname;
const idDe = (route: Route) => pathDe(route).replace(`${RUTA}/`, '').replace(/\/baja$/, '');

/** El catálogo mockeado: GET (con y sin bajas), POST, PATCH y POST /baja, con captura de todo. */
async function mockCatalogo(page: Page, inicial: Tipo[] = CATALOGO, r: Respuestas = {}): Promise<Catalogo> {
  const c: Catalogo = { lista: [...inicial], veces: () => n, consultas: [], escrituras: [] };
  let n = 0;
  await page.route(RE_BAJA, async (route) => {
    const id = idDe(route);
    c.escrituras.push({ metodo: 'POST', path: pathDe(route), cuerpo: null });
    if (r.baja) return r.baja(route, id);
    const t = c.lista.find((x) => x.id === id);
    if (!t) return route.fulfill(json({ error: 'El tipo de servicio adicional no existe o ya está dado de baja' }, 404));
    c.lista = c.lista.map((x) => (x.id === id ? { ...x, activo: false, dadoDeBajaEn: '2026-09-14T15:00:00.000Z' } : x));
    return route.fulfill(json({ ...t, activo: false, dadoDeBajaEn: '2026-09-14T15:00:00.000Z' }));
  });
  await page.route(RE_TIPO, async (route) => {
    const id = idDe(route);
    const cuerpo = route.request().postDataJSON();
    c.escrituras.push({ metodo: route.request().method(), path: pathDe(route), cuerpo });
    if (r.editar) return r.editar(route, id, cuerpo);
    const t = c.lista.find((x) => x.id === id);
    if (!t) return route.fulfill(json({ error: 'El tipo de servicio adicional no existe o ya está dado de baja' }, 404));
    const nuevo = { ...t, ...(cuerpo as object) };
    c.lista = c.lista.map((x) => (x.id === id ? nuevo : x));
    return route.fulfill(json(nuevo));
  });
  await page.route(RE_LISTA, async (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      const cuerpo = req.postDataJSON();
      c.escrituras.push({ metodo: 'POST', path: pathDe(route), cuerpo });
      if (r.crear) return r.crear(route, cuerpo);
      const creado = tipo(`sa-${c.lista.length + 1}`, (cuerpo as Tipo).nombre, (cuerpo as Tipo).valor, (cuerpo as Tipo).descripcion ?? null);
      c.lista = [...c.lista, creado];
      return route.fulfill(json(creado, 201));
    }
    n += 1;
    c.consultas.push(new URL(req.url()).search);
    if (r.lista) return r.lista(route);
    const conBajas = /incluirBajas=(1|true)/.test(req.url());
    return route.fulfill(json(conBajas ? c.lista : c.lista.filter((t) => t.activo)));
  });
  return c;
}

/** Punto de reposo: cuando el canario ha salido, lo que fuera a salir en el montaje ya salió. */
async function reposo(page: Page): Promise<void> {
  const salida = page.waitForRequest((r) => r.url().includes('__qa_canary'), { timeout: 10_000 });
  await page.evaluate((ruta) => { void fetch(ruta).catch(() => {}); }, CANARIO);
  await salida;
}

/** Método + path de cada petición del módulo. Sin query: por ahí se filtraría un dato a un artefacto. */
function espiar(page: Page): string[] {
  const vistas: string[] = [];
  page.on('request', (req) => {
    const { pathname } = new URL(req.url());
    if (pathname.startsWith(RUTA)) vistas.push(`${req.method()} ${pathname}`);
  });
  return vistas;
}

const filaDe = (page: Page, nombre: string) =>
  page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: nombre, exact: true }) });

const nombreDe = (page: Page) => page.getByRole('textbox', { name: 'Nombre' });
const descripcionDe = (page: Page) => page.getByRole('textbox', { name: 'Descripción (opcional)' });
const valorDe = (page: Page) => page.getByRole('textbox', { name: 'Valor en pesos' });
/** Primarias (gradiente de marca) dentro del contenido: la del shell no cuenta. Los modales cuelgan de body. */
const primarias = (page: Page) => page.locator('main button[style*="flit-gradient-primary"], [role="dialog"] button[style*="flit-gradient-primary"]');

async function abrirPagina(page: Page) {
  await page.goto('/flito/servicios-adicionales');
  await expect(page.getByRole('heading', { name: 'Servicios adicionales', level: 1 })).toBeVisible();
}

test.describe('FLITO — Servicios adicionales · acceso (AC1, AC6)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const usuario of [FINANCIERA_USER, ADMIN_USER]) {
    test(`TC-01 ${usuario.role}: llega por el menú (tras Tarifas), por ⌘K y por URL; un solo GET al montar`, async ({ page }) => {
      await loginAs(page, usuario);
      const vistas = espiar(page);
      const catalogo = await mockCatalogo(page);

      await page.goto('/flito/tarifas');
      const nav = page.getByRole('navigation', { name: 'Navegación principal' });
      await nav.getByRole('button', { name: 'Finanzas', exact: true }).click();
      const enlace = nav.getByRole('link', { name: 'Servicios adicionales', exact: true });
      await expect(enlace).toHaveAttribute('href', '/flito/servicios-adicionales');
      const etiquetas = await nav.getByRole('link').allInnerTexts();
      expect(etiquetas.indexOf('Servicios adicionales')).toBe(etiquetas.indexOf('Tarifas') + 1);
      await enlace.click();
      await expect(page).toHaveURL(/\/flito\/servicios-adicionales$/);
      await expect(page.getByRole('heading', { name: 'Servicios adicionales', level: 1 })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Nuevo tipo' })).toBeVisible();
      await expect(primarias(page)).toHaveCount(1);
      await reposo(page);
      const gets = vistas.filter((v) => v === `GET ${RUTA}`).length;
      expect(gets).toBeGreaterThanOrEqual(1);
      expect(gets).toBeLessThanOrEqual(2);
      await reposo(page);
      expect(vistas.filter((v) => v === `GET ${RUTA}`).length).toBe(gets);
      expect(catalogo.consultas.every((q) => q === '')).toBe(true);

      await page.goto('/flito/tarifas');
      await expect(page.getByRole('heading', { name: 'Tarifas', level: 1 })).toBeVisible();
      await page.keyboard.press('Control+k');
      await page.getByPlaceholder('Buscar o ir a…').fill('paz y salvo');
      const opcion = page.getByRole('option', { name: /Servicios adicionales/ });
      await expect(opcion).toBeVisible();
      await opcion.click();
      await expect(page).toHaveURL(/\/flito\/servicios-adicionales$/);
      await expect(page.getByRole('heading', { name: 'Servicios adicionales', level: 1 })).toBeVisible();
    });
  }

  test('TC-02 la ruta se protege por SU slug: con flito_servicios_adicionales entra; con solo flito_tarifas, NoAccess', async ({ page }) => {
    await loginAs(page, { ...AUDITOR_USER, allowedPages: ['flito_servicios_adicionales'] });
    await mockCatalogo(page, []);
    await abrirPagina(page);
    await expect(page.getByText('Aún no hay tipos de servicio adicional.')).toBeVisible();
  });

  test('TC-02b con solo flito_tarifas concedido, la página propia sigue cerrada', async ({ page }) => {
    await loginAs(page, { ...AUDITOR_USER, allowedPages: ['flito_tarifas'] });
    const vistas = espiar(page);
    await page.route('**/api/flito/parametrizacion/**', (route) => route.abort('failed'));
    await page.goto('/flito/servicios-adicionales');
    await expect(page.getByRole('heading', { name: 'No tienes acceso a Finanzas — Servicios adicionales' })).toBeVisible();
    await reposo(page);
    expect(vistas).toEqual([]);
  });

  for (const usuario of [AUDITOR_USER, CLIENTE_USER]) {
    test(`TC-14 ${usuario.role}: sin entrada en el menú ni en ⌘K, y por URL NoAccess sin ninguna petición`, async ({ page }) => {
      await loginAs(page, usuario);
      const vistas = espiar(page);
      await page.route('**/api/flito/parametrizacion/**', (route) => route.abort('failed'));

      await page.goto('/flito/servicios-adicionales');
      await expect(page.getByRole('heading', { name: /no tienes acceso a .*servicios adicionales/i })).toBeVisible();
      await reposo(page);
      expect(vistas).toEqual([]);

      const nav = page.getByRole('navigation', { name: 'Navegación principal' });
      const finanzas = nav.getByRole('button', { name: 'Finanzas', exact: true });
      if (await finanzas.count()) await finanzas.click();
      await expect(nav.getByRole('link', { name: 'Servicios adicionales', exact: true })).toHaveCount(0);

      await page.keyboard.press('Control+k');
      await page.getByPlaceholder('Buscar o ir a…').fill('servicio');
      await expect(page.getByRole('option', { name: /Servicios adicionales/ })).toHaveCount(0);
      await expect(page.getByRole('option', { name: /paz y salvo/i })).toHaveCount(0);
    });
  }

  test('TC-15 con la página pero 403 en el GET: NoAccess, no el error genérico', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockCatalogo(page, CATALOGO, { lista: (route) => route.fulfill(json({ error: 'No tiene permiso' }, 403)) });
    await page.goto('/flito/servicios-adicionales');
    await expect(page.getByRole('heading', { name: 'No tienes acceso a Finanzas — Servicios adicionales' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Nuevo tipo' })).toHaveCount(0);
  });

  test('sin la función de crear o de dar de baja, ese botón no existe (ni apagado)', async ({ page }) => {
    const sin = (codigo: string) => funcionesDe(FINANCIERA_USER).filter((f) => f !== codigo);
    await loginAs(page, FINANCIERA_USER, { funciones: sin('parametrizacion.servicios_adicionales.dar_de_baja') });
    await mockCatalogo(page);
    await abrirPagina(page);
    await expect(page.getByRole('button', { name: /^Editar ·/ })).toHaveCount(3);
    await expect(page.getByRole('button', { name: /^Dar de baja ·/ })).toHaveCount(0);

    await loginAs(page, FINANCIERA_USER, { funciones: sin('parametrizacion.servicios_adicionales.crear') });
    await abrirPagina(page);
    await expect(page.getByRole('button', { name: 'Nuevo tipo' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Dar de baja ·/ })).toHaveCount(3);
  });
});

test.describe('FLITO — Servicios adicionales · cuatro estados (AC2)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('TC-03 cargando: indicador accesible, sin botones de fila, «Nuevo tipo» habilitado', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    let soltar: () => void = () => {};
    const espera = new Promise<void>((r) => { soltar = r; });
    await mockCatalogo(page, CATALOGO, {
      lista: async (route) => { await espera; return route.fulfill(json(CATALOGO.filter((t) => t.activo))); },
    });

    await abrirPagina(page);
    const cargando = page.getByRole('status', { name: 'Cargando tipos de servicio adicional' });
    await expect(cargando).toBeVisible();
    await expect(cargando).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('button', { name: /Editar ·|Dar de baja ·/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Nuevo tipo' })).toBeEnabled();
    await expect(page.getByRole('checkbox', { name: 'Mostrar dados de baja' })).toBeDisabled();
    soltar();
    await expect(page.getByRole('rowheader')).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'Editar · Diagnóstico' })).toBeEnabled();
  });

  test('TC-04 vacío: mensaje y «Nuevo tipo» secundario, sin filas, sin alert, sin Reintentar', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockCatalogo(page, []);
    await abrirPagina(page);
    await expect(page.getByText('Aún no hay tipos de servicio adicional.')).toBeVisible();
    await expect(page.getByText('Crea el primero: un nombre, una descripción si hace falta y su valor en pesos.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Nuevo tipo' })).toHaveCount(2);
    await expect(primarias(page)).toHaveCount(1);
    await expect(page.getByRole('rowheader')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText('Reintentar')).toHaveCount(0);

    await page.getByRole('checkbox', { name: 'Mostrar dados de baja' }).check();
    await expect(page.getByText('Ningún tipo, ni activo ni dado de baja.')).toBeVisible();
  });

  test('TC-05 500: mensaje con Reintentar que repite exactamente un GET; la red caída cae igual', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    let reintentado = false;
    const catalogo = await mockCatalogo(page, CATALOGO, {
      lista: (route) => route.fulfill(reintentado ? json(CATALOGO.filter((t) => t.activo)) : json({ error: 'Error del servidor' }, 500)),
    });

    await abrirPagina(page);
    await expect(page.getByRole('alert')).toContainText('No se pudo cargar el catálogo de servicios adicionales.');
    await expect(page.getByText('Error del servidor')).toBeVisible();
    await expect(page.getByRole('rowheader')).toHaveCount(0);
    await expect(page.getByText('Aún no hay tipos')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Nuevo tipo' })).toBeEnabled();
    await reposo(page);
    const antes = catalogo.veces();
    reintentado = true;
    await page.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByRole('rowheader')).toHaveCount(3);
    expect(catalogo.veces()).toBe(antes + 1);

    await page.unroute(RE_LISTA);
    await page.route(RE_LISTA, (route) => route.abort('failed'));
    await abrirPagina(page);
    await expect(page.getByRole('alert')).toContainText('No se pudo cargar el catálogo de servicios adicionales.');
    await expect(page.getByRole('rowheader')).toHaveCount(0);
  });

  test('TC-06 con datos: columnas, «$ 85.000» con espacio, «$ 0» con «Por tarifar», «—» sin descripción y el orden del servidor', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockCatalogo(page);
    await abrirPagina(page);

    const tabla = page.getByRole('region', { name: 'Tipos de servicio adicional' });
    for (const col of ['Nombre', 'Descripción', 'Valor', 'Estado', 'Acciones']) {
      await expect(tabla.getByRole('columnheader', { name: col, exact: true })).toHaveCount(1);
    }
    await expect(page.getByRole('heading', { name: 'Tipos (3)', level: 2 })).toBeVisible();
    await expect(filaDe(page, 'Diagnóstico')).toContainText('$ 85.000');
    await expect(filaDe(page, 'Diagnóstico')).toContainText('Revisión inicial');
    await expect(filaDe(page, 'Paz y salvo de impuestos')).toContainText('$ 1.250.000');
    await expect(filaDe(page, 'Paz y salvo de impuestos').getByLabel('Sin descripción')).toHaveCount(1);
    await expect(filaDe(page, 'Derecho de petición')).toContainText('$ 0');
    await expect(filaDe(page, 'Derecho de petición')).toContainText('Por tarifar');
    await expect(filaDe(page, 'Diagnóstico')).not.toContainText('Por tarifar');
    await expect(page.getByText('Sin configurar')).toHaveCount(0);
    await expect(page.getByText('null')).toHaveCount(0);
    await expect(page.getByText('1 tipo está a $ 0. Edítalo para ponerle valor.')).toBeVisible();

    const filas = page.getByRole('rowheader');
    await expect(filas).toHaveText(['Derecho de petición', 'Diagnóstico', 'Paz y salvo de impuestos']);
    for (const nombre of ['Derecho de petición', 'Diagnóstico', 'Paz y salvo de impuestos']) {
      await expect(filaDe(page, nombre)).toContainText('Activo');
      await expect(filaDe(page, nombre).getByRole('button', { name: `Editar · ${nombre}` })).toBeVisible();
      await expect(filaDe(page, nombre).getByRole('button', { name: `Dar de baja · ${nombre}` })).toBeVisible();
    }
    await expect(page.getByText(/eliminar|borrar|desactivar|inactiv|reactivar/i)).toHaveCount(0);
  });
});

test.describe('FLITO — Servicios adicionales · crear (AC3)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('TC-07 validación en línea: nada sale al servidor, el foco va al primer inválido', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    const catalogo = await mockCatalogo(page);
    await abrirPagina(page);

    await page.getByRole('button', { name: 'Nuevo tipo' }).click();
    const dialogo = page.getByRole('dialog', { name: 'Nuevo tipo de servicio adicional' });
    await expect(dialogo).toBeVisible();
    await expect(nombreDe(page)).toBeFocused();
    await expect(nombreDe(page)).toHaveAttribute('maxlength', '120');
    await expect(valorDe(page)).toHaveAttribute('type', 'text');
    await expect(primarias(page)).toHaveCount(2);

    await valorDe(page).fill('85000');
    await page.getByRole('button', { name: 'Crear tipo' }).click();
    await expect(dialogo.getByRole('alert')).toHaveText('Escribe el nombre.');
    await expect(nombreDe(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(nombreDe(page)).toBeFocused();

    await nombreDe(page).fill('Peritaje');
    for (const [texto, mensaje] of [
      ['-1', 'El valor no puede ser negativo.'], ['abc', 'Solo números, con hasta dos decimales.'],
      ['1.234', 'Hasta dos decimales.'], ['', 'Escribe el valor.'],
    ]) {
      await valorDe(page).fill(texto);
      await page.getByRole('button', { name: 'Crear tipo' }).click();
      await expect(dialogo.getByRole('alert')).toHaveText(mensaje);
      await expect(valorDe(page)).toHaveAttribute('aria-invalid', 'true');
      await expect(valorDe(page)).toBeFocused();
    }
    await expect(nombreDe(page)).not.toHaveAttribute('aria-invalid', 'true');

    await nombreDe(page).fill('x'.repeat(130));
    await expect(nombreDe(page)).toHaveValue('x'.repeat(120));

    await reposo(page);
    expect(catalogo.escrituras).toEqual([]);
    await expect(dialogo).toBeVisible();
  });

  test('TC-08 crear: POST sin descripción vacía, cierre, «Tipo creado.», y la lista se repide al servidor', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    const catalogo = await mockCatalogo(page);
    await abrirPagina(page);
    await reposo(page);
    const antes = catalogo.veces();

    await page.getByRole('button', { name: 'Nuevo tipo' }).click();
    await nombreDe(page).fill('Peritaje');
    await valorDe(page).fill('85000');
    // Otro usuario creó «Zeta» mientras tanto: solo un re-GET la trae.
    catalogo.lista = [...catalogo.lista, tipo('sa-9', 'Zeta', 1)];
    await page.getByRole('button', { name: 'Crear tipo' }).click();

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('Tipo creado.')).toBeVisible();
    expect(catalogo.escrituras).toEqual([{ metodo: 'POST', path: RUTA, cuerpo: { nombre: 'Peritaje', valor: 85000 } }]);
    await expect(filaDe(page, 'Peritaje')).toContainText('$ 85.000');
    await expect(filaDe(page, 'Zeta')).toBeVisible();
    expect(catalogo.veces()).toBe(antes + 1);
    await expect(page.getByRole('button', { name: 'Nuevo tipo' })).toBeFocused();

    // Borde: $ 0 es válido y se envía sin confirmación; la descripción escrita sí viaja.
    await page.getByRole('button', { name: 'Nuevo tipo' }).click();
    await nombreDe(page).fill('Trámite en sede');
    await descripcionDe(page).fill('Acompañamiento presencial.');
    await valorDe(page).fill('0');
    await page.getByRole('button', { name: 'Crear tipo' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(catalogo.escrituras[1]).toEqual({
      metodo: 'POST', path: RUTA, cuerpo: { nombre: 'Trámite en sede', descripcion: 'Acompañamiento presencial.', valor: 0 },
    });
    await expect(filaDe(page, 'Trámite en sede')).toContainText('$ 0');
    await expect(filaDe(page, 'Trámite en sede')).toContainText('Por tarifar');
    await expect(page.getByText('2 tipos están a $ 0. Edítalos para ponerles valor.')).toBeVisible();
  });

  test('TC-09 409 NOMBRE_DUPLICADO: bajo Nombre, con «Está registrado como», formulario abierto con lo escrito', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    const duplicado = (nombre: string) => json({ error: 'Ya existe un tipo activo con ese nombre', codigo: 'NOMBRE_DUPLICADO', choca: { id: 'sa-1', nombre } }, 409);
    let choca = 'Diagnóstico';
    const catalogo = await mockCatalogo(page, CATALOGO, {
      crear: (route) => route.fulfill(duplicado(choca)),
      editar: (route) => route.fulfill(duplicado(choca)),
    });
    await abrirPagina(page);
    await reposo(page);
    const antes = catalogo.veces();

    await page.getByRole('button', { name: 'Nuevo tipo' }).click();
    const dialogo = page.getByRole('dialog', { name: 'Nuevo tipo de servicio adicional' });
    await nombreDe(page).fill('diagnostico');
    await valorDe(page).fill('1000');
    await page.getByRole('button', { name: 'Crear tipo' }).click();
    await expect(dialogo.getByRole('alert')).toHaveText('Ya existe un tipo activo con ese nombre. Está registrado como «Diagnóstico».');
    await expect(nombreDe(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(valorDe(page)).not.toHaveAttribute('aria-invalid', 'true');
    await expect(nombreDe(page)).toBeFocused();
    await expect(dialogo).toBeVisible();
    await expect(nombreDe(page)).toHaveValue('diagnostico');
    await expect(valorDe(page)).toHaveValue('1000');
    await expect(page.getByText('Tipo creado.')).toHaveCount(0);
    expect(catalogo.veces()).toBe(antes);

    // Escrito igual que el que existe: solo la primera frase.
    choca = 'diagnostico';
    await page.getByRole('button', { name: 'Crear tipo' }).click();
    await expect(dialogo.getByRole('alert')).toHaveText('Ya existe un tipo activo con ese nombre.');
    await page.keyboard.press('Escape');
    await expect(dialogo).toHaveCount(0);

    // El mismo 409 al editar se comporta igual.
    choca = 'Paz y salvo de impuestos';
    await page.getByRole('button', { name: 'Editar · Diagnóstico' }).click();
    const editar = page.getByRole('dialog', { name: 'Editar tipo' });
    await nombreDe(page).fill('paz y salvo de impuestos');
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(editar.getByRole('alert')).toHaveText('Ya existe un tipo activo con ese nombre. Está registrado como «Paz y salvo de impuestos».');
    await expect(editar).toBeVisible();
    await expect(nombreDe(page)).toHaveValue('paz y salvo de impuestos');
    expect(catalogo.escrituras.map((e) => e.metodo)).toEqual(['POST', 'POST', 'PATCH']);
    expect(catalogo.escrituras[2].cuerpo).toEqual({ nombre: 'paz y salvo de impuestos' });
  });

  test('500 al crear: alerta encima de los botones, lo escrito sigue y el botón reintenta', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    let falla = true;
    const catalogo = await mockCatalogo(page, CATALOGO, {
      crear: (route, cuerpo) => (falla
        ? route.fulfill(json({ error: 'Error del servidor' }, 500))
        : route.fulfill(json(tipo('sa-9', (cuerpo as Tipo).nombre, (cuerpo as Tipo).valor), 201))),
    });
    await abrirPagina(page);
    await page.getByRole('button', { name: 'Nuevo tipo' }).click();
    const dialogo = page.getByRole('dialog', { name: 'Nuevo tipo de servicio adicional' });
    await nombreDe(page).fill('Peritaje');
    await valorDe(page).fill('85000');
    await page.getByRole('button', { name: 'Crear tipo' }).click();
    await expect(dialogo.getByRole('alert')).toContainText('No se pudo guardar. Los datos siguen aquí; vuelve a intentarlo.');
    await expect(dialogo.getByRole('alert')).toContainText('Error del servidor');
    await expect(nombreDe(page)).toHaveValue('Peritaje');
    await expect(nombreDe(page)).not.toHaveAttribute('aria-invalid', 'true');
    falla = false;
    await page.getByRole('button', { name: 'Crear tipo' }).click();
    await expect(dialogo).toHaveCount(0);
    expect(catalogo.escrituras).toHaveLength(2);
  });
});

test.describe('FLITO — Servicios adicionales · editar (AC4)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('TC-10 editar: prellenado, PATCH solo con lo cambiado, y sin cambios el botón está apagado', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    const catalogo = await mockCatalogo(page);
    await abrirPagina(page);

    await page.getByRole('button', { name: 'Editar · Diagnóstico' }).click();
    const dialogo = page.getByRole('dialog', { name: 'Editar tipo' });
    await expect(dialogo).toBeVisible();
    await expect(nombreDe(page)).toHaveValue('Diagnóstico');
    await expect(descripcionDe(page)).toHaveValue('Revisión inicial');
    await expect(valorDe(page)).toHaveValue('85000');
    await expect(nombreDe(page)).toBeFocused();

    // Sin cambios: apagado, dicho, y cero peticiones.
    const guardar = page.getByRole('button', { name: 'Guardar cambios' });
    await expect(guardar).toBeDisabled();
    await expect(dialogo.getByText('No has cambiado nada.')).toBeVisible();
    await valorDe(page).press('Enter');
    await reposo(page);
    expect(catalogo.escrituras).toEqual([]);

    await valorDe(page).fill('90000');
    await expect(dialogo.getByText('No has cambiado nada.')).toHaveCount(0);
    await guardar.click();
    await expect(dialogo).toHaveCount(0);
    await expect(page.getByText('Cambios guardados.')).toBeVisible();
    expect(catalogo.escrituras).toEqual([{ metodo: 'PATCH', path: `${RUTA}/sa-1`, cuerpo: { valor: 90000 } }]);
    await expect(filaDe(page, 'Diagnóstico')).toContainText('$ 90.000');
    await expect(page.getByRole('button', { name: 'Editar · Diagnóstico' })).toBeFocused();

    // Vaciar la descripción viaja como null, no como ''.
    await page.getByRole('button', { name: 'Editar · Diagnóstico' }).click();
    await descripcionDe(page).fill('');
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(catalogo.escrituras[1]).toEqual({ metodo: 'PATCH', path: `${RUTA}/sa-1`, cuerpo: { descripcion: null } });
    await expect(filaDe(page, 'Diagnóstico').getByLabel('Sin descripción')).toHaveCount(1);
  });

  test('TC-11 404 al editar: cierra, «El tipo ya no está disponible», y la lista se repide sin la fila', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    const catalogo = await mockCatalogo(page, CATALOGO, {
      editar: (route) => route.fulfill(json({ error: 'El tipo de servicio adicional no existe o ya está dado de baja' }, 404)),
    });
    await abrirPagina(page);
    await reposo(page);
    const antes = catalogo.veces();

    await page.getByRole('button', { name: 'Editar · Diagnóstico' }).click();
    await valorDe(page).fill('90000');
    catalogo.lista = catalogo.lista.filter((t) => t.id !== 'sa-1');
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('El tipo ya no está disponible. La lista se actualizó.')).toBeVisible();
    await expect(filaDe(page, 'Diagnóstico')).toHaveCount(0);
    await expect(page.getByRole('rowheader')).toHaveCount(2);
    expect(catalogo.veces()).toBe(antes + 1);
  });
});

test.describe('FLITO — Servicios adicionales · dar de baja (AC5)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('TC-12 diálogo: cancelar y Esc no envían; confirmar hace POST /:id/baja, la fila sale y el foco va al título', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    const vistas = espiar(page);
    const catalogo = await mockCatalogo(page);
    await abrirPagina(page);

    await page.getByRole('button', { name: 'Dar de baja · Diagnóstico' }).click();
    const dialogo = page.getByRole('dialog', { name: 'Dar de baja «Diagnóstico»' });
    await expect(dialogo).toBeVisible();
    await expect(dialogo).toBeFocused();
    await expect(dialogo).toContainText('«Diagnóstico» dejará de ofrecerse como servicio adicional desde ahora.');
    await expect(dialogo).toContainText(/no se puede reactivar/i);
    // El copy dice «No se puede reactivar»: lo prohibido es una ACCIÓN de reactivar, no la palabra.
    await expect(dialogo.getByText(/eliminar|borrar|desactivar|inactiv/i)).toHaveCount(0);
    await expect(dialogo.getByRole('button', { name: /eliminar|borrar|desactivar|reactivar/i })).toHaveCount(0);
    await expect(primarias(page)).toHaveCount(1);

    await dialogo.getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialogo).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Dar de baja · Diagnóstico' })).toBeFocused();
    await page.getByRole('button', { name: 'Dar de baja · Diagnóstico' }).click();
    await page.keyboard.press('Escape');
    await expect(dialogo).toHaveCount(0);
    await reposo(page);
    expect(catalogo.escrituras).toEqual([]);
    expect(vistas.filter((v) => !v.startsWith('GET'))).toEqual([]);
    await expect(filaDe(page, 'Diagnóstico')).toBeVisible();

    await page.getByRole('button', { name: 'Dar de baja · Diagnóstico' }).click();
    await dialogo.getByRole('button', { name: 'Dar de baja' }).click();
    await expect(dialogo).toHaveCount(0);
    await expect(page.getByText('«Diagnóstico» dado de baja.')).toBeVisible();
    await expect(filaDe(page, 'Diagnóstico')).toHaveCount(0);
    await expect(page.getByRole('rowheader')).toHaveCount(2);
    expect(vistas.filter((v) => !v.startsWith('GET'))).toEqual([`POST ${RUTA}/sa-1/baja`]);
    await expect(page.getByRole('heading', { name: 'Tipos (2)', level: 2 })).toBeFocused();
  });

  test('TC-13 «Mostrar dados de baja»: incluirBajas=1 al servidor, fila de solo lectura con fecha, y vuelta a activos', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    const catalogo = await mockCatalogo(page);
    await abrirPagina(page);
    await expect(page.getByRole('rowheader')).toHaveCount(3);
    await expect(filaDe(page, 'Diagnóstico express')).toHaveCount(0);
    expect(catalogo.consultas.at(-1)).toBe('');

    const control = page.getByRole('checkbox', { name: 'Mostrar dados de baja' });
    await control.check();
    const baja = filaDe(page, 'Diagnóstico express');
    await expect(baja).toBeVisible();
    expect(catalogo.consultas.at(-1)).toBe('?incluirBajas=1');
    await expect(page.getByRole('heading', { name: 'Tipos (4 · 1 dado de baja)', level: 2 })).toBeVisible();
    await expect(baja).toContainText('Dado de baja');
    await expect(baja).toContainText('10 sep 2026');
    await expect(baja).toContainText('$ 30.000');
    await expect(baja).not.toContainText('Por tarifar');
    await expect(baja.getByRole('button')).toHaveCount(0);
    await expect(filaDe(page, 'Diagnóstico').getByRole('button')).toHaveCount(2);
    await expect(page.getByRole('rowheader')).toHaveText(['Derecho de petición', 'Diagnóstico', 'Diagnóstico express', 'Paz y salvo de impuestos']);

    await control.uncheck();
    await expect(filaDe(page, 'Diagnóstico express')).toHaveCount(0);
    await expect(page.getByRole('rowheader')).toHaveCount(3);
    expect(catalogo.consultas.at(-1)).toBe('');
  });

  test('404 al dar de baja: cierra, avisa y repide la lista', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    const catalogo = await mockCatalogo(page, CATALOGO, {
      baja: (route) => route.fulfill(json({ error: 'El tipo de servicio adicional no existe o ya está dado de baja' }, 404)),
    });
    await abrirPagina(page);
    await reposo(page);
    const antes = catalogo.veces();
    await page.getByRole('button', { name: 'Dar de baja · Diagnóstico' }).click();
    catalogo.lista = catalogo.lista.filter((t) => t.id !== 'sa-1');
    await page.getByRole('dialog').getByRole('button', { name: 'Dar de baja' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('El tipo ya no está disponible. La lista se actualizó.')).toBeVisible();
    await expect(filaDe(page, 'Diagnóstico')).toHaveCount(0);
    expect(catalogo.veces()).toBe(antes + 1);
  });
});

test.describe('FLITO — Servicios adicionales · ficha de ayuda (AC7)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('TC-16 financiera la ve en Finanzas y la abre; el auditor no la ve; el .md sigue la plantilla', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await page.goto('/flito/ayuda');
    await expect(page.getByRole('link', { name: 'Abrir ficha de Servicios adicionales' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ficha pendiente de Servicios adicionales' })).toHaveCount(0);
    await page.goto('/flito/ayuda/flito_servicios_adicionales');
    const articulo = page.getByRole('article', { name: 'Servicios adicionales' });
    await expect(articulo).toBeVisible();
    await expect(page.getByText('Esta ficha está pendiente.')).toHaveCount(0);
    for (const h of ['Qué es', 'Para quién', 'Cómo se entra', 'Pasos', 'Estados', 'Qué no hace']) {
      await expect(articulo.getByRole('heading', { name: h, exact: true })).toBeVisible();
    }
    await expect(page.getByRole('link', { name: 'Ir a la pantalla Servicios adicionales' })).toHaveAttribute('href', '/flito/servicios-adicionales');

    await loginAs(page, AUDITOR_USER);
    await page.goto('/flito/ayuda');
    await expect(page.getByRole('link', { name: /Servicios adicionales/ })).toHaveCount(0);

    const path = resolve(raiz, 'apps/web/src/content/ayuda/flito_servicios_adicionales.md');
    expect(existsSync(path), path).toBe(true);
    const md = readFileSync(path, 'utf8');
    for (const h of ['Qué es', 'Para quién', 'Cómo se entra', 'Pasos', 'Estados', 'Qué no hace']) expect(md).toContain(`## ${h}`);
    expect(md).toMatch(/\busted\b/i);
    expect(md).not.toMatch(/\btú\b/);
    expect(md).toContain('Dado de baja');
    expect(md).toMatch(/Nuevo tipo/);
    expect(md).toMatch(/Editar/);
    expect(md).toMatch(/Dar de baja/);
    expect(md).toMatch(/Administrador y Financiera/);
    expect(md).not.toMatch(/!\[[^\]]*\]\(/);
    expect(md).not.toMatch(/\/api\//);
    expect(md).not.toMatch(/\b(CREATE TABLE|FROM public\.|pg_)/i);
  });
});

test.describe('FLITO — Servicios adicionales · accesibilidad (axe)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('TC-18 la tabla llena, el formulario y el diálogo de baja no tienen violaciones serias', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER);
    await mockCatalogo(page);
    await abrirPagina(page);
    await expect(filaDe(page, 'Diagnóstico')).toContainText('$ 85.000');
    esperarSinViolacionesGraves(await correrAxe(page), 'servicios adicionales · tabla llena');

    await page.getByRole('button', { name: 'Editar · Diagnóstico' }).click();
    await expect(page.getByRole('dialog', { name: 'Editar tipo' })).toBeVisible();
    esperarSinViolacionesGraves(await correrAxe(page), 'servicios adicionales · formulario');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Dar de baja · Diagnóstico' }).click();
    await expect(page.getByRole('dialog', { name: 'Dar de baja «Diagnóstico»' })).toBeVisible();
    esperarSinViolacionesGraves(await correrAxe(page), 'servicios adicionales · diálogo de baja');
  });
});
