// Feature #14324 — Proveedores con varios servicios: formulario (HU #14336) y lista (HU #14337). ADR-0039 §7.1.
// Contrato en `packages/shared-types/src/flito-proveedores.ts`; las respuestas del API están simuladas.
import type { Page, Route } from '@playwright/test';
import type { ImpactoProveedorDto, ProveedorDetalleDto, ProveedorListaItemDto } from '@operaciones/shared-types';
import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER } from '../helpers/auth';

const F = 'parametrizacion.proveedores';
const TODAS = ['listar', 'crear', 'editar', 'estado', 'eliminar'].map((f) => `${F}.${f}`);
const login = (page: Page, funciones = TODAS) => loginAs(page, ADMIN_USER, { funciones: [...funciones] });

const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const ANDINA = ID(1); const SUR = ID(2); const RED = ID(3); const LIBRE = ID(4);

const RAIZ = /\/api\/flito\/parametrizacion\/proveedores$/;
const UNO = /\/api\/flito\/parametrizacion\/proveedores\/([0-9a-f-]{36})$/;
const IMPACTO = /\/api\/flito\/parametrizacion\/proveedores\/([0-9a-f-]{36})\/impacto$/;
const ESTADO = /\/api\/flito\/parametrizacion\/proveedores\/([0-9a-f-]{36})\/estado$/;

const LISTA: ProveedorListaItemDto[] = [
  { id: ANDINA, nombre: 'Seguros Andina', nit: null, servicios: ['soat'], activo: true, companiasPorServicio: { soat: 2 }, datosCompletos: false, umbralOcr: 0.85, slaHoras: 24, version: 4 },
  { id: SUR, nombre: 'Envíos del Sur', nit: '900123456-7', servicios: ['logistica'], activo: true, companiasPorServicio: { logistica: 3 }, datosCompletos: true, umbralOcr: null, slaHoras: null, version: 2 },
  { id: RED, nombre: 'Red Integral', nit: '800987654-3', servicios: ['soat', 'logistica'], activo: false, companiasPorServicio: { soat: 2, logistica: 3 }, datosCompletos: true, umbralOcr: 0.9, slaHoras: 48, version: 7 },
  { id: LIBRE, nombre: 'Libre SAS', nit: '800111222-1', servicios: ['logistica'], activo: false, companiasPorServicio: { logistica: 0 }, datosCompletos: true, umbralOcr: null, slaHoras: null, version: 1 },
];

const personales = { telefono: '300 000 0000', correo: 'contacto@empresa.com', direccion: 'Calle 00 # 00-00', ciudad: 'Bogotá', contacto: 'Área de operaciones' };
const DETALLE: Record<string, ProveedorDetalleDto> = {
  [ANDINA]: { ...LISTA[0]!, telefono: null, correo: null, direccion: null, ciudad: null, contacto: null, soat: { estrategia: 'portal', umbralOcr: 0.85, slaHoras: 24 } },
  [SUR]: { ...LISTA[1]!, ...personales, soat: null },
  [RED]: { ...LISTA[2]!, ...personales, soat: { estrategia: 'correo', umbralOcr: 0.9, slaHoras: 48 } },
  [LIBRE]: { ...LISTA[3]!, ...personales, soat: null },
};

const impactoBase = (p: Partial<ImpactoProveedorDto> = {}): ImpactoProveedorDto => ({
  activo: true, version: 1, bloqueosPorServicio: {}, sesionesAfectadas: 0, puedeInactivar: true, motivoNoInactivable: null, puedeEliminar: true, motivoNoEliminable: null, ...p,
});

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

type Respuesta = { status: number; body: unknown } | 'abort';
interface Montaje {
  lista?: ProveedorListaItemDto[];
  listaFalla?: () => boolean;
  listaEspera?: Promise<void>;
  detalle?: () => Respuesta | undefined;
  impacto?: (id: string) => ImpactoProveedorDto;
  crear?: () => Respuesta;
  editar?: () => Respuesta;
  estado?: () => Respuesta;
  eliminar?: () => Respuesta;
}

async function montar(page: Page, m: Montaje = {}) {
  const lista = [...(m.lista ?? LISTA)];
  const posts: Record<string, unknown>[] = [];
  const patches: Record<string, unknown>[] = [];
  const estados: Record<string, unknown>[] = [];
  const borrados: string[] = [];
  let listados = 0;
  const responder = (route: Route, r: Respuesta) => (r === 'abort' ? route.abort('failed') : json(route, r.status, r.body));
  await page.route(/\/api\/clients(\?|$)/, (r) => json(r, 200, []));
  await page.route(/\/api\/siigo\/clientes\/validacion\/detalle/, (r) => json(r, 200, { data: [] }));
  await page.route(RAIZ, async (route) => {
    if (route.request().method() === 'POST') {
      posts.push(route.request().postDataJSON() as Record<string, unknown>);
      return responder(route, m.crear?.() ?? { status: 201, body: LISTA[0] });
    }
    listados += 1;
    if (m.listaEspera) await m.listaEspera;
    return m.listaFalla?.() ? json(route, 500, { error: 'boom interno' }) : json(route, 200, lista);
  });
  await page.route(UNO, (route) => {
    const metodo = route.request().method();
    const id = UNO.exec(route.request().url())?.[1] ?? '';
    if (metodo === 'GET') return responder(route, m.detalle?.() ?? { status: 200, body: DETALLE[id] });
    if (metodo === 'PATCH') {
      patches.push(route.request().postDataJSON() as Record<string, unknown>);
      return responder(route, m.editar?.() ?? { status: 200, body: LISTA[0] });
    }
    borrados.push(id);
    const r = m.eliminar?.() ?? { status: 200, body: { id, eliminado: true } };
    if (r !== 'abort' && r.status === 200) { const i = lista.findIndex((x) => x.id === id); if (i >= 0) lista.splice(i, 1); }
    return responder(route, r);
  });
  await page.route(IMPACTO, (route) => {
    const id = IMPACTO.exec(route.request().url())?.[1] ?? '';
    return json(route, 200, m.impacto?.(id) ?? impactoBase());
  });
  await page.route(ESTADO, (route) => {
    estados.push(route.request().postDataJSON() as Record<string, unknown>);
    return responder(route, m.estado?.() ?? { status: 200, body: LISTA[0] });
  });
  await page.goto('/clients');
  await page.getByRole('button', { name: 'Proveedores', exact: true }).click();
  return { posts, patches, estados, borrados, listados: () => listados };
}

const filas = (page: Page) => page.getByRole('table').locator('tbody tr');
const fila = (page: Page, nombre: string) => filas(page).filter({ hasText: nombre });
const dialogo = (page: Page) => page.getByRole('dialog');
const servicio = (page: Page, nombre: string) => dialogo(page).getByRole('checkbox', { name: nombre });
const nuevo = async (page: Page) => { await page.getByRole('button', { name: 'Nuevo proveedor' }).click(); };
const editar = async (page: Page, nombre: string) => { await page.getByRole('button', { name: `Editar ${nombre}` }).click(); };
const guardar = (page: Page) => dialogo(page).getByRole('button', { name: /^(Guardar cambios|Crear proveedor)$/ });

const GENERALES = {
  nombre: 'Mensajería Uno', nit: '900.123.456-7', telefono: '3000000000', correo: 'contacto@empresa.com',
  direccion: 'Calle 00 # 00-00', ciudad: 'Bogotá', contacto: 'Área de operaciones',
};
const ETIQUETAS: Record<keyof typeof GENERALES, RegExp> = {
  nombre: /^Nombre de la empresa/, nit: /^NIT/, telefono: /^Teléfono/, correo: /^Correo/,
  direccion: /^Dirección/, ciudad: /^Ciudad/, contacto: /^Persona de contacto/,
};
const llenarGenerales = async (page: Page) => {
  for (const k of Object.keys(GENERALES) as (keyof typeof GENERALES)[]) await dialogo(page).getByLabel(ETIQUETAS[k]).fill(GENERALES[k]);
};

test.describe('HU #14337 · Lista con servicios, filtro y acciones', () => {
  test('AC1 — una etiqueta por servicio, en orden', async ({ page }) => {
    await login(page);
    await montar(page);
    await expect(fila(page, 'Seguros Andina').locator('td').nth(1)).toHaveText('SOAT');
    await expect(fila(page, 'Envíos del Sur').locator('td').nth(1)).toHaveText('Logística');
    await expect(fila(page, 'Red Integral').locator('td').nth(1)).toHaveText('SOATLogística');
    await expect(fila(page, 'Red Integral').locator('td').nth(3)).toHaveText('2 SOAT · 3 Logística');
    await expect(fila(page, 'Envíos del Sur').locator('td').nth(3)).toHaveText('3');
  });

  test('AC2 — filtrar por Logística incluye a los de ambos servicios y retira las columnas de SOAT', async ({ page }) => {
    await login(page);
    const m = await montar(page);
    const antes = m.listados();
    await expect(page.getByRole('columnheader', { name: 'Umbral OCR' })).toBeVisible();
    await page.getByRole('group', { name: 'Servicio' }).getByRole('button', { name: 'Logística', exact: true }).click();
    await expect(filas(page)).toHaveCount(3);
    await expect(fila(page, 'Seguros Andina')).toHaveCount(0);
    await expect(fila(page, 'Red Integral')).toHaveCount(1);
    await expect(page.getByRole('columnheader', { name: 'Umbral OCR' })).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: 'ANS pactado' })).toHaveCount(0);
    await expect(page.getByText('Mostrando 3 de 4')).toBeVisible();
    await page.getByRole('group', { name: 'Servicio' }).getByRole('button', { name: 'SOAT', exact: true }).click();
    await expect(filas(page)).toHaveCount(2);
    expect(m.listados()).toBe(antes);
  });

  test('AC3 — sin SOAT las columnas muestran «—»; con SOAT, coma decimal y horas', async ({ page }) => {
    await login(page);
    await montar(page);
    const sur = fila(page, 'Envíos del Sur').locator('td');
    await expect(sur.nth(4)).toHaveText('—');
    await expect(sur.nth(5)).toHaveText('—');
    const andina = fila(page, 'Seguros Andina').locator('td');
    await expect(andina.nth(4)).toHaveText('0,85');
    await expect(andina.nth(5)).toHaveText('24 h');
    await expect(fila(page, 'Red Integral').locator('td').nth(4)).toHaveText('0,90');
  });

  test('AC4 — sin datos personales en la pantalla; columnas en el orden decidido', async ({ page }) => {
    await login(page);
    await montar(page);
    await expect(page.getByRole('columnheader')).toHaveText(['Nombre', 'Servicios', 'NIT', 'Compañías asignadas', 'Umbral OCR', 'ANS pactado', 'Estado', '']);
    const tabla = page.getByRole('table');
    for (const v of Object.values(personales)) await expect(tabla.getByText(v)).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: /Contacto/ })).toHaveCount(0);
  });

  test('AC5 — datos incompletos: se indica y puede seguir operándose', async ({ page }) => {
    await login(page);
    await montar(page);
    await expect(fila(page, 'Seguros Andina').getByText('Datos por completar')).toBeVisible();
    await expect(fila(page, 'Envíos del Sur').getByText('Datos por completar')).toHaveCount(0);
    await expect(fila(page, 'Seguros Andina').getByRole('button', { name: 'Editar Seguros Andina' })).toBeEnabled();
    await expect(fila(page, 'Seguros Andina').getByRole('button', { name: 'Acciones de Seguros Andina' })).toBeEnabled();
  });

  test('AC6 — cargando y error con reintento', async ({ page }) => {
    await login(page);
    let soltar: () => void = () => {};
    const espera = new Promise<void>((r) => { soltar = r; });
    let falla = false;
    await montar(page, { listaEspera: espera, listaFalla: () => falla });
    await expect(page.getByText('Cargando proveedores…')).toBeVisible();
    falla = true;
    soltar();
    await expect(page.getByRole('alert').filter({ hasText: 'No pudimos cargar los proveedores.' })).toBeVisible();
    await expect(page.getByText('boom interno')).toHaveCount(0);
    falla = false;
    await page.getByRole('button', { name: 'Reintentar' }).click();
    await expect(filas(page)).toHaveCount(4);
  });

  test('AC6 — sin proveedores: vacío con el siguiente paso y sin filtros', async ({ page }) => {
    await login(page);
    await montar(page, { lista: [] });
    await expect(page.getByText('No hay proveedores. Cree el primero con «Nuevo proveedor».')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Servicio' })).toHaveCount(0);
  });

  test('AC6 — filtro sin resultados: «Ver todos» limpia Estado y Servicio', async ({ page }) => {
    await login(page);
    await montar(page, { lista: [LISTA[1]!] });
    await page.getByRole('group', { name: 'Servicio' }).getByRole('button', { name: 'SOAT', exact: true }).click();
    await expect(page.getByText('No hay registros con este filtro.')).toBeVisible();
    await expect(page.getByText('Mostrando 0 de 1')).toBeVisible();
    await page.getByRole('button', { name: 'Ver todos' }).click();
    await expect(filas(page)).toHaveCount(1);
  });

  test('AC7 — con compañías de Logística ve el motivo y la cantidad, y sigue activo', async ({ page }) => {
    await login(page);
    const motivo = 'No se puede inactivar: está asignado a 3 compañías (Alfa, Beta, Gama). Asigna otro proveedor primero.';
    const m = await montar(page, { impacto: () => impactoBase({ puedeInactivar: false, motivoNoInactivable: motivo }) });
    await page.getByRole('button', { name: 'Acciones de Envíos del Sur' }).click();
    await page.getByRole('menuitem', { name: 'Desactivar' }).click();
    const modal = page.getByRole('dialog', { name: 'No se puede inactivar' });
    await expect(modal.getByRole('alert')).toHaveText(motivo);
    await modal.getByRole('button', { name: 'Entendido' }).click();
    expect(m.estados).toEqual([]);
    await expect(fila(page, 'Envíos del Sur').getByText('Activo', { exact: true })).toBeVisible();
  });

  test('AC7 — sin bloqueo: ve el impacto, confirma y el PATCH lleva la versión', async ({ page }) => {
    await login(page);
    const m = await montar(page, {
      impacto: () => impactoBase({
        sesionesAfectadas: 2,
        bloqueosPorServicio: { soat: [{ motivo: 'companias', cantidad: 2, texto: '2 compañías asignadas' }, { motivo: 'soat_en_curso', cantidad: 3, texto: '3 SOAT en curso' }] },
      }),
    });
    await page.getByRole('button', { name: 'Acciones de Seguros Andina' }).click();
    await page.getByRole('menuitem', { name: 'Desactivar' }).click();
    const modal = page.getByRole('dialog', { name: 'Desactivar «Seguros Andina»' });
    await expect(modal.getByText('2 compañías asignadas, 3 SOAT en curso.')).toBeVisible();
    await expect(modal.getByText('Se cerrará la sesión de sus 2 usuarios.')).toBeVisible();
    await modal.getByRole('button', { name: 'Desactivar' }).click();
    await expect(page.getByText('Proveedor desactivado.')).toBeVisible();
    expect(m.estados).toEqual([{ activo: false, versionEsperada: 4 }]);
  });

  test('AC7 — otro usuario cambió el proveedor: toast propio y recarga', async ({ page }) => {
    await login(page);
    const m = await montar(page, { estado: () => ({ status: 409, body: { error: 'Otro usuario cambió este proveedor. Recarga para ver sus datos', code: 'PROVEEDOR_EDITADO_POR_OTRO' } }) });
    const antes = m.listados();
    await page.getByRole('button', { name: 'Acciones de Seguros Andina' }).click();
    await page.getByRole('menuitem', { name: 'Desactivar' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Desactivar' }).click();
    await expect(page.getByText('Otro usuario cambió este proveedor. Recargamos la lista.')).toBeVisible();
    await expect.poll(m.listados).toBeGreaterThan(antes);
  });

  test('AC8 — inactivo sin bloqueos: lo elimina, confirma y desaparece', async ({ page }) => {
    await login(page);
    const m = await montar(page);
    await page.getByRole('button', { name: 'Acciones de Libre SAS' }).click();
    const op = page.getByRole('menuitem', { name: 'Eliminar', exact: true });
    await expect(op).not.toHaveAttribute('aria-disabled', 'true');
    await op.click();
    await page.getByRole('dialog').getByRole('button', { name: 'Eliminar' }).click();
    await expect(page.getByText('Proveedor eliminado.')).toBeVisible();
    await expect(fila(page, 'Libre SAS')).toHaveCount(0);
    expect(m.borrados).toEqual([LIBRE]);
  });

  test('AC8 — con bloqueos ve el motivo y no se elimina; activo pide desactivar primero', async ({ page }) => {
    await login(page);
    const motivo = 'No se puede eliminar. Logística: 3 compañías asignadas.';
    const m = await montar(page, { impacto: () => impactoBase({ activo: false, puedeEliminar: false, motivoNoEliminable: motivo }) });
    await page.getByRole('button', { name: 'Acciones de Red Integral' }).click();
    const op = page.getByRole('menuitem', { name: 'Eliminar', exact: true });
    await expect(op).toHaveAttribute('aria-disabled', 'true');
    await expect(op).toHaveAccessibleDescription(motivo);
    await op.click({ force: true });
    await expect(dialogo(page)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Acciones de Envíos del Sur' }).click();
    await expect(page.getByRole('menuitem', { name: 'Eliminar', exact: true })).toHaveAccessibleDescription('Primero debe desactivarlo.');
    expect(m.borrados).toEqual([]);
  });

  test('AC8 — bloqueo que aparece al confirmar: el motivo en el diálogo, sin reintento', async ({ page }) => {
    await login(page);
    const motivo = 'No se puede eliminar. Logística: 1 gestión abierta.';
    await montar(page, { eliminar: () => ({ status: 409, body: { error: motivo } }) });
    await page.getByRole('button', { name: 'Acciones de Libre SAS' }).click();
    await page.getByRole('menuitem', { name: 'Eliminar', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Eliminar' }).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveText(new RegExp(motivo));
    await expect(fila(page, 'Libre SAS')).toHaveCount(1);
  });

  test('AC9 — sin cambiar estado ni eliminar no se ofrecen esas acciones', async ({ page }) => {
    await login(page, [`${F}.listar`, `${F}.editar`]);
    await montar(page);
    await expect(page.getByRole('button', { name: /^Acciones de / })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Editar Red Integral' })).toBeVisible();
  });
});

test.describe('HU #14336 · Formulario con selector de servicios', () => {
  test('AC1 — selector múltiple al crear y al editar; sin selector de persona ni «Activo»', async ({ page }) => {
    await login(page);
    await montar(page);
    await nuevo(page);
    await expect(servicio(page, 'SOAT')).toBeChecked();
    await servicio(page, 'Logística').check();
    await expect(servicio(page, 'SOAT')).toBeChecked();
    await expect(servicio(page, 'Logística')).toBeChecked();
    await expect(dialogo(page).getByText(/Los proveedores de FLITO son empresas/)).toBeVisible();
    await expect(dialogo(page).getByRole('switch')).toHaveCount(0);
    await dialogo(page).getByRole('button', { name: 'Cancelar' }).click();
    await editar(page, 'Red Integral');
    await expect(servicio(page, 'SOAT')).toBeChecked();
    await expect(servicio(page, 'Logística')).toBeChecked();
  });

  test('AC2 — sin servicio: el mensaje exacto, foco en la primera casilla y nada se envía', async ({ page }) => {
    await login(page);
    const m = await montar(page);
    await nuevo(page);
    await llenarGenerales(page);
    await servicio(page, 'SOAT').uncheck();
    await guardar(page).click();
    await expect(dialogo(page).getByText('Marque al menos un servicio')).toBeVisible();
    await expect(servicio(page, 'SOAT')).toBeFocused();
    expect(m.posts).toEqual([]);
  });

  test('AC3 — datos de SOAT solo con SOAT: desmarcado no se envían y lo escrito sigue ahí', async ({ page }) => {
    await login(page);
    const m = await montar(page);
    await nuevo(page);
    await llenarGenerales(page);
    await dialogo(page).getByLabel('Estrategia').fill('portal');
    await dialogo(page).getByLabel('Umbral OCR (0–1)').fill('0.8');
    await dialogo(page).getByLabel('ANS pactado (horas)').fill('24');
    await servicio(page, 'Logística').check();
    await servicio(page, 'SOAT').uncheck();
    await expect(dialogo(page).getByLabel('Estrategia')).toHaveCount(0);
    await expect(dialogo(page).getByLabel('Umbral OCR (0–1)')).toHaveCount(0);
    await servicio(page, 'SOAT').check();
    await expect(dialogo(page).getByLabel('Estrategia')).toHaveValue('portal');
    await servicio(page, 'SOAT').uncheck();
    await guardar(page).click();
    await expect(dialogo(page)).toHaveCount(0);
    await expect(page.getByText('Proveedor creado.')).toBeVisible();
    expect(m.posts).toEqual([{
      generales: { ...GENERALES, nit: '900123456-7' }, servicios: ['logistica'],
    }]);
  });

  test('AC3 — con SOAT marcado sus datos viajan en `soat`', async ({ page }) => {
    await login(page);
    const m = await montar(page);
    await nuevo(page);
    await llenarGenerales(page);
    await dialogo(page).getByLabel('Estrategia').fill('portal');
    await dialogo(page).getByLabel('Umbral OCR (0–1)').fill('0.8');
    await dialogo(page).getByLabel('ANS pactado (horas)').fill('24');
    await guardar(page).click();
    await expect(dialogo(page)).toHaveCount(0);
    expect(m.posts[0]).toMatchObject({ servicios: ['soat'], soat: { estrategia: 'portal', umbralOcr: 0.8, slaHoras: 24 } });
  });

  test('AC3 — los datos de SOAT son opcionales: vacíos no se envían ni se exigen', async ({ page }) => {
    await login(page);
    const m = await montar(page);
    await nuevo(page);
    await llenarGenerales(page);
    await guardar(page).click();
    await expect(dialogo(page)).toHaveCount(0);
    expect(m.posts[0]).toEqual({ generales: { ...GENERALES, nit: '900123456-7' }, servicios: ['soat'] });
  });

  test('AC4 — alta sin datos generales: error asociado a cada etiqueta y no se crea', async ({ page }) => {
    await login(page);
    const m = await montar(page);
    await nuevo(page);
    await guardar(page).click();
    for (const k of Object.keys(ETIQUETAS) as (keyof typeof ETIQUETAS)[]) {
      const campo = dialogo(page).getByLabel(ETIQUETAS[k]);
      await expect(campo).toHaveAttribute('aria-invalid', 'true');
      await expect(campo).toHaveAccessibleDescription('Este dato es obligatorio.');
    }
    await expect(dialogo(page).getByLabel(ETIQUETAS.nombre)).toBeFocused();
    await dialogo(page).getByLabel(ETIQUETAS.correo).fill('no-es-correo');
    await guardar(page).click();
    await expect(dialogo(page).getByLabel(ETIQUETAS.correo)).toHaveAccessibleDescription(/Escriba un correo válido/);
    expect(m.posts).toEqual([]);
  });

  test('AC5 — NIT repetido: texto exacto junto al NIT y conserva lo escrito', async ({ page }) => {
    await login(page);
    const texto = 'Ya existe un proveedor con ese NIT: Mensajería Uno';
    await montar(page, { crear: () => ({ status: 409, body: { error: texto, campo: 'nit' } }) });
    await nuevo(page);
    await llenarGenerales(page);
    await guardar(page).click();
    const nit = dialogo(page).getByLabel(ETIQUETAS.nit);
    await expect(nit).toHaveAccessibleDescription(texto);
    await expect(nit).toBeFocused();
    await expect(nit).toHaveValue(GENERALES.nit);
    await expect(dialogo(page).getByLabel(ETIQUETAS.nombre)).toHaveValue(GENERALES.nombre);
  });

  test('nombre repetido: texto exacto bajo el nombre', async ({ page }) => {
    await login(page);
    const texto = 'Ya existe un proveedor con ese nombre: Envíos del Sur';
    await montar(page, { crear: () => ({ status: 409, body: { error: texto, campo: 'nombre' } }) });
    await nuevo(page);
    await llenarGenerales(page);
    await guardar(page).click();
    await expect(dialogo(page).getByLabel(ETIQUETAS.nombre)).toHaveAccessibleDescription(texto);
  });

  test('AC6 — antiguo sin datos: cambiar SOAT guarda sin pedirlos ni enviarlos', async ({ page }) => {
    await login(page);
    const m = await montar(page);
    await editar(page, 'Seguros Andina');
    await expect(dialogo(page).getByText(/Faltan datos de esta empresa/)).toBeVisible();
    await expect(dialogo(page).getByLabel('NIT', { exact: true })).toBeVisible();
    await dialogo(page).getByLabel('Umbral OCR (0–1)').fill('0.7');
    await guardar(page).click();
    await expect(dialogo(page)).toHaveCount(0);
    await expect(page.getByText('Cambios guardados.')).toBeVisible();
    expect(m.patches).toEqual([{ versionEsperada: 4, soat: { umbralOcr: 0.7 } }]);
  });

  test('vaciar la estrategia se envía como cadena vacía, para que «Cambios guardados.» sea cierto', async ({ page }) => {
    await login(page);
    const m = await montar(page);
    await editar(page, 'Seguros Andina');
    await dialogo(page).getByLabel('Estrategia').fill('');
    await guardar(page).click();
    await expect(page.getByText('Cambios guardados.')).toBeVisible();
    expect(m.patches).toEqual([{ versionEsperada: 4, soat: { estrategia: '' } }]);
  });

  test('AC6 — al editar un dato general se pide el bloque; deshacerlo vuelve a no pedirlo', async ({ page }) => {
    await login(page);
    const m = await montar(page);
    await editar(page, 'Seguros Andina');
    const nombre = dialogo(page).getByLabel(ETIQUETAS.nombre);
    await nombre.fill('Seguros Andina Nueva');
    await expect(dialogo(page).getByLabel('NIT *')).toBeVisible();
    await expect(dialogo(page).getByText('Como editó los datos, complete todos los campos marcados con *.')).toBeVisible();
    await guardar(page).click();
    await expect(dialogo(page).getByLabel('NIT *')).toHaveAccessibleDescription('Este dato es obligatorio.');
    expect(m.patches).toEqual([]);
    await nombre.fill('Seguros Andina');
    await expect(dialogo(page).getByLabel('NIT', { exact: true })).toBeVisible();
    await expect(dialogo(page).getByText(/Faltan datos de esta empresa/)).toBeVisible();
  });

  test('AC6 — agregar un servicio cuenta como editar: exige el bloque y lo envía con los servicios', async ({ page }) => {
    await login(page);
    const m = await montar(page);
    await editar(page, 'Seguros Andina');
    await servicio(page, 'Logística').check();
    await expect(dialogo(page).getByLabel('NIT *')).toBeVisible();
    await guardar(page).click();
    await expect(dialogo(page).getByLabel('NIT *')).toHaveAccessibleDescription('Este dato es obligatorio.');
    expect(m.patches).toEqual([]);
    await llenarGenerales(page);
    await guardar(page).click();
    await expect(dialogo(page)).toHaveCount(0);
    expect(m.patches).toEqual([{ versionEsperada: 4, generales: { ...GENERALES, nit: '900123456-7' }, servicios: ['soat', 'logistica'] }]);
  });

  test('proveedor con datos completos: solo viajan los cambios', async ({ page }) => {
    await login(page);
    const m = await montar(page);
    await editar(page, 'Envíos del Sur');
    await expect(dialogo(page).getByLabel('NIT *')).toHaveValue('900123456-7');
    await expect(dialogo(page).getByText('Asignado a 3 compañías.')).toBeVisible();
    await servicio(page, 'SOAT').check();
    await dialogo(page).getByLabel('Estrategia').fill('portal');
    await dialogo(page).getByLabel('Umbral OCR (0–1)').fill('0.8');
    await dialogo(page).getByLabel('ANS pactado (horas)').fill('24');
    await guardar(page).click();
    await expect(dialogo(page)).toHaveCount(0);
    expect(m.patches).toEqual([{ versionEsperada: 2, servicios: ['soat', 'logistica'], soat: { estrategia: 'portal', umbralOcr: 0.8, slaHoras: 24 } }]);
  });

  test('AC6 — quitar un servicio a un antiguo no pide los datos generales', async ({ page }) => {
    await login(page);
    const pendiente = { ...DETALLE[RED]!, datosCompletos: false, nit: null, telefono: null };
    const m = await montar(page, { detalle: () => ({ status: 200, body: pendiente }) });
    await editar(page, 'Red Integral');
    await servicio(page, 'Logística').uncheck();
    await expect(dialogo(page).getByLabel('NIT', { exact: true })).toBeVisible();
    await guardar(page).click();
    await expect(dialogo(page)).toHaveCount(0);
    expect(m.patches).toEqual([{ versionEsperada: 7, servicios: ['soat'] }]);
  });

  test('AC7 — quitar un servicio bloqueado: mensaje exacto y la casilla sigue marcada', async ({ page }) => {
    await login(page);
    const texto = 'No puede quitar SOAT: 2 compañías asignadas, 3 SOAT en curso';
    const m = await montar(page, { editar: () => ({ status: 409, body: { error: texto, servicio: 'soat', bloqueos: [] } }) });
    await editar(page, 'Red Integral');
    await servicio(page, 'SOAT').uncheck();
    await guardar(page).click();
    await expect(dialogo(page).getByRole('alert').filter({ hasText: texto })).toBeVisible();
    await expect(servicio(page, 'SOAT')).toBeChecked();
    await expect(dialogo(page).getByLabel('Estrategia')).toHaveValue('correo');
    expect(m.patches[0]).toEqual({ versionEsperada: 7, servicios: ['logistica'] });
  });

  test('AC8 — edición simultánea: aviso, lo escrito sigue, guardar apagado y recargar trae lo actual', async ({ page }) => {
    await login(page);
    let conflicto = true;
    const actual = { ...DETALLE[SUR]!, nombre: 'Envíos del Sur Cambiado', version: 3 };
    const m = await montar(page, {
      detalle: () => (conflicto ? undefined : { status: 200, body: actual }),
      editar: () => ({ status: 409, body: { error: 'Otro usuario cambió este proveedor. Recarga para ver sus datos', code: 'PROVEEDOR_EDITADO_POR_OTRO' } }),
    });
    await editar(page, 'Envíos del Sur');
    const nombre = dialogo(page).getByLabel(ETIQUETAS.nombre);
    await nombre.fill('Lo que escribí');
    await guardar(page).click();
    await expect(dialogo(page).getByRole('alert').filter({ hasText: 'Otro usuario cambió este proveedor mientras usted editaba.' })).toBeVisible();
    await expect(nombre).toHaveValue('Lo que escribí');
    await expect(guardar(page)).toBeDisabled();
    const recargar = dialogo(page).getByRole('button', { name: 'Recargar datos' });
    await expect(recargar).toBeFocused();
    expect(m.patches).toHaveLength(1);
    conflicto = false;
    await recargar.click();
    await expect(nombre).toHaveValue('Envíos del Sur Cambiado');
    await expect(guardar(page)).toBeEnabled();
    await expect(dialogo(page).getByRole('alert')).toHaveCount(0);
    await expect(servicio(page, 'SOAT')).toBeFocused();
  });

  test('AC9 — sin crear ni editar no se ofrece el formulario', async ({ page }) => {
    await login(page, [`${F}.listar`]);
    await montar(page);
    await expect(page.getByRole('button', { name: 'Nuevo proveedor' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Editar / })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Ver detalle de Red Integral' })).toBeVisible();
    await expect(page.getByText('No hay proveedores')).toHaveCount(0);
  });

  test('AC9 — al editar: cargando y error con reintento si falla el detalle', async ({ page }) => {
    await login(page);
    let falla = true;
    let soltar: () => void = () => {};
    const espera = new Promise<void>((r) => { soltar = r; });
    await montar(page, { detalle: () => (falla ? { status: 500, body: { error: 'boom interno' } } : undefined) });
    await page.route(UNO, async (route) => { await espera; return route.fallback(); });
    await editar(page, 'Envíos del Sur');
    await expect(dialogo(page).getByText('Cargando proveedor…')).toBeVisible();
    soltar();
    await expect(dialogo(page).getByRole('alert')).toHaveText('No pudimos cargar el proveedor.');
    await expect(page.getByText('boom interno')).toHaveCount(0);
    falla = false;
    await dialogo(page).getByRole('button', { name: 'Reintentar' }).click();
    await expect(dialogo(page).getByLabel('NIT *')).toHaveValue('900123456-7');
  });

  test('detalle: solo lectura, chips, sin asteriscos y «—» en los vacíos', async ({ page }) => {
    await login(page);
    await montar(page);
    await page.getByRole('button', { name: 'Ver detalle de Seguros Andina' }).click();
    const modal = page.getByRole('dialog', { name: 'Detalle de Seguros Andina' });
    await expect(modal.getByRole('checkbox')).toHaveCount(0);
    await expect(modal.getByText('*', { exact: false })).toHaveCount(0);
    await expect(modal.getByLabel('NIT', { exact: true })).toHaveValue('—');
    await expect(modal.getByLabel('Umbral OCR (0–1)')).toHaveValue('0,85');
    await expect(modal.getByRole('button', { name: /Guardar/ })).toHaveCount(0);
    await expect(modal.getByText(/Faltan datos/)).toHaveCount(0);
  });

  test('otro fallo al guardar: frase propia, nunca el texto del API', async ({ page }) => {
    await login(page);
    await montar(page, { editar: () => ({ status: 500, body: { error: 'boom interno' } }) });
    await editar(page, 'Envíos del Sur');
    await guardar(page).click();
    await expect(dialogo(page).getByText('No pudimos guardar el proveedor. Inténtelo de nuevo.')).toBeVisible();
    await expect(page.getByText('boom interno')).toHaveCount(0);
  });
});
