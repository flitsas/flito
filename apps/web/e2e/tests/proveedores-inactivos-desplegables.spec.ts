// HU #13963 (Feature #13940) — los proveedores SOAT inactivos se ven en gris en los desplegables pero
// no se eligen; los eliminados no salen; lo ya asignado se conserva. Backend mockeado.
//
// Los tres desplegables: envío de SOAT (`BarraEnvioSoat`, «Enviar a»), proveedor de SOAT sin trámite
// de la compañía (Clientes, cuadro «SOAT sin trámite · <compañía>») y atadura del usuario (rol
// Proveedor). Los tres leen `GET /flito/parametrizacion/proveedores-soat`, que devuelve activos E
// inactivos con `activo` y ya no devuelve los eliminados (#13957). La regla vive en
// `components/flit/opcionesConEstado.ts` (HU #13950); aquí se mide en cada pantalla.
//
// Lo que hace que los asertos midan algo:
//   · AC1/AC2 se afirman con `disabled` nativo Y con el texto «(Inactivo)» Y con `aria-disabled`
//     (AC5): el gris solo no informa y el texto solo no bloquea nada.
//   · AC3: el mock NO trae al eliminado, y además se comprueba que ninguna pantalla lo reinyecta
//     desde otra fuente (el nombre no aparece en ninguna opción).
//   · AC4 se mide con el VALOR del `<select>` y con las peticiones: si el inactivo asignado se
//     filtrara o se deshabilitara, el campo se vaciaría y guardar quitaría el proveedor.
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';
import { arbolRol, arbolUsuario, codigosDe, elemento, item, type NodoDef } from '../helpers/arbolPermisos';

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
type Fila = Record<string, unknown>;

const ALFA_SEG = 'aaaaaaaa-1111-4111-8111-111111111111';
const PREVISORA = 'bbbbbbbb-2222-4222-8222-222222222222';

/** Tal como responde el API: activos E inactivos. «Borrada Seguros» (eliminada) NO viene. */
const PROVEEDORES = [
  { id: ALFA_SEG, nombre: 'Seguros Alfa', estrategia: 'ocr', umbralOcr: null, slaHoras: null, activo: true },
  { id: PREVISORA, nombre: 'La Previsora', estrategia: 'ocr', umbralOcr: null, slaHoras: null, activo: false },
];
const ELIMINADO = 'Borrada Seguros';

/** AC1/AC2/AC5: la opción inactiva — visible, con «(Inactivo)» en el texto, `disabled` y `aria-disabled`. */
async function esperarInactivaNoElegible(select: Locator) {
  const opcion = select.getByRole('option', { name: 'La Previsora (Inactivo)' });
  await expect(opcion).toHaveCount(1);
  await expect(opcion).toHaveJSProperty('disabled', true);
  await expect(opcion).toHaveAttribute('aria-disabled', 'true');
  // La activa sigue elegible y sin marca.
  const activa = select.getByRole('option', { name: 'Seguros Alfa', exact: true });
  await expect(activa).toHaveJSProperty('disabled', false);
  await expect(activa).not.toHaveAttribute('aria-disabled', /.*/);
  // AC3: el eliminado no sale.
  await expect(select.getByRole('option', { name: new RegExp(ELIMINADO) })).toHaveCount(0);
}

// ─────────────────────────────────── Envío de SOAT ───────────────────────────────────────────────

const SOAT_PENDIENTE = {
  id: 's1', vin: 'VIN0000000000001', placa: 'ABC123', marca: 'Chevrolet', linea: 'Onix',
  cilindraje: '1598', carroceria: 'SEDAN', tipoServicio: 'Particular',
  estado: 'pendiente', esMultiplePropietario: false, companiaNombre: 'Concesionario Norte',
  organismoNombre: 'STT Manizales', proveedorSoatId: null, proveedorSoatNombre: null,
  compradores: [{ nombreCompleto: 'Ana Pérez', numeroDocumento: '10101010', tipoDocumento: 'CC', orden: 0, porcentajeParticipacion: null }],
  tramitesFlit: ['FLIT-1001'], tipoTramite: 'Matricula',
  fechaAprobacion: null, fechaCreacion: '2026-03-28T10:00:00Z',
  enviadoPorNombre: null, enviadoEn: null,
  pagadoEn: null, valorPagado: null, estancado: false, motivoRechazo: null, creadoEn: '2026-04-01T12:00:00Z',
  gestionOperaciones: false,
};

async function montarCola(page: Page) {
  const envios: Fila[] = [];
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat$/, (r) => r.fulfill(json(PROVEEDORES)));
  await page.route(/\/api\/flito\/soat\/facetas/, (r) => r.fulfill(json({ companias: [], organismos: [], proveedores: [] })));
  await page.route(/\/api\/flito\/soat\?/, (r) => r.fulfill(json({ items: [SOAT_PENDIENTE], total: 1, page: 1, pageSize: 50 })));
  await page.route(/\/api\/flito\/soat\/enviar$/, (r) => {
    envios.push(r.request().postDataJSON());
    return r.fulfill(json({ enviados: ['s1'], yaEnviados: [] }));
  });
  await page.goto('/flito/soat');
  await page.getByLabel('Seleccionar ABC123').check();
  return { envios };
}

test.describe('HU #13963 · envío de SOAT — selector «Enviar a»', () => {
  test('AC1/AC3/AC5 · el inactivo sale en gris con «(Inactivo)», deshabilitado y con aria-disabled; el eliminado no sale', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montarCola(page);
    const destino = page.getByLabel('Enviar a');
    await expect(destino).toBeVisible();
    await esperarInactivaNoElegible(destino);
  });

  test('AC1 · no se puede elegir el inactivo: el envío solo sale al activo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { envios } = await montarCola(page);
    const destino = page.getByLabel('Enviar a');
    // No elegible = `disabled` nativo (el navegador no deja escogerla). No se usa `selectOption` para
    // «intentarlo»: fija el valor por programa y no simula lo que puede hacer una persona.
    await expect(destino.getByRole('option', { name: 'La Previsora (Inactivo)' })).toHaveJSProperty('disabled', true);
    await expect(destino).toHaveValue('');
    await expect(page.getByRole('button', { name: /Enviar al gestor/ })).toBeDisabled();

    await destino.selectOption(ALFA_SEG);
    await page.getByRole('button', { name: /Enviar al gestor/ }).click();
    await expect.poll(() => envios.length).toBe(1);
    expect(envios[0]).toMatchObject({ proveedorSoatId: ALFA_SEG });
  });
});

// ─────────────────────────────── SOAT sin trámite (Clientes) ─────────────────────────────────────

const ETIQUETA_SIN_TRAMITE = 'Proveedor de SOAT sin trámite';

function cliente(id: number, name: string, gestorSoatSinTramite: { id: string; nombre: string; activo: boolean } | null) {
  return {
    id, name, document: `9001${id}`, documentType: 'NIT', phone: null, email: null,
    address: null, city: 'Medellín',
    soatAutogestionable: false, impuestosAutogestionable: false, logisticaAutogestionable: false,
    logisticaPermiteParcial: false, gestorSoatSinTramite, permisoSinTramiteSinEfecto: false,
  };
}
const NORTE = cliente(1, 'Concesionario Norte', null);
const ALFA = cliente(2, 'Transportes Alfa', { id: PREVISORA, nombre: 'La Previsora', activo: false });

async function montarClientes(page: Page) {
  const patches: Fila[] = [];
  await page.route(/\/api\/clients(\?|$)/, (r) => r.fulfill(json([NORTE, ALFA])));
  await page.route(/\/api\/siigo\/clientes\/validacion\/detalle/, (r) => r.fulfill(json({ data: [] })));
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat$/, (r) => r.fulfill(json(PROVEEDORES)));
  await page.route(/\/api\/flito\/parametrizacion\/companias\/\d+$/, (r) => {
    patches.push(r.request().postDataJSON());
    return r.fulfill(json({ id: 1 }));
  });
  await page.goto('/clients');
  return { patches };
}
const celdaSinTramite = (page: Page, nombre: string, texto: string) =>
  page.getByRole('button', { name: `SOAT sin trámite de ${nombre}: ${texto}` });
const modalSinTramite = (page: Page, nombre: string) =>
  page.getByRole('dialog', { name: `SOAT sin trámite · ${nombre}` });

test.describe('HU #13963 · Clientes — proveedor de SOAT sin trámite', () => {
  test('AC2/AC3/AC5 · el inactivo sale deshabilitado con «(Inactivo)»; el eliminado no sale', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montarClientes(page);
    await celdaSinTramite(page, 'Concesionario Norte', 'Sin proveedor').click();
    const selector = modalSinTramite(page, 'Concesionario Norte').getByLabel(ETIQUETA_SIN_TRAMITE);
    await expect(selector).toBeEnabled();
    await esperarInactivaNoElegible(selector);
    await expect(selector).toHaveValue('');
  });

  test('AC4 · Alfa con P inactivo: el campo muestra P con «(Inactivo)» y se guarda sin cambiarlo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const { patches } = await montarClientes(page);
    await celdaSinTramite(page, 'Transportes Alfa', 'La Previsora (inactivo)').click();
    const modal = modalSinTramite(page, 'Transportes Alfa');
    const selector = modal.getByLabel(ETIQUETA_SIN_TRAMITE);
    await expect(selector).toHaveValue(PREVISORA);
    const asignada = selector.getByRole('option', { name: 'La Previsora (Inactivo)' });
    await expect(asignada).toHaveCount(1);
    // La seleccionada no se deshabilita: el navegador mostraría otra y el guardado la perdería.
    await expect(asignada).toHaveJSProperty('disabled', false);
    await expect(modal.getByRole('button', { name: 'Guardar' })).toBeEnabled();
    await modal.getByRole('button', { name: 'Guardar' }).click();
    await expect(modal).toHaveCount(0);
    expect(patches).toEqual([]); // sin cambio no hay petición: el proveedor no se pierde

    // Cambiar a un activo sí deja la inactiva fuera de alcance.
    await celdaSinTramite(page, 'Transportes Alfa', 'La Previsora (inactivo)').click();
    const otra = modalSinTramite(page, 'Transportes Alfa').getByLabel(ETIQUETA_SIN_TRAMITE);
    await otra.selectOption(ALFA_SEG);
    await expect(otra.getByRole('option', { name: 'La Previsora (Inactivo)' })).toHaveJSProperty('disabled', true);
  });
});

// ──────────────────────────────── Atadura del usuario ────────────────────────────────────────────

const rol = (codigo: string, nombre: string, tipoEnlace = 'ninguno'): Fila => ({
  codigo, nombre, descripcion: null, tipoEnlace, esSistema: true, activo: true, usuarios: 0, borrable: false,
  motivoNoBorrable: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
});
const ROLES = [rol('admin', 'Administrador'), rol('proveedor', 'Proveedor', 'proveedor')];
const ARBOL: NodoDef[] = [elemento('general', 'General', [item('dashboard', 'Entrar al tablero')])];
const CUADRO = new Set(codigosDe(ARBOL));

function usuario(over: Fila): Fila {
  return {
    id: 2, username: 'u', name: 'Usuario', email: null, role: 'admin', active: true,
    allowedPages: [], funciones: [], transitoCodigo: null, companiaId: null,
    flitoProveedorSoatId: null, organismosCodigos: [],
    createdAt: '2026-01-01T00:00:00.000Z', ...over,
  };
}

async function mockUsuarios(page: Page, filas: Fila[]) {
  const patches: Fila[] = [];
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat$/, (r) => r.fulfill(json(PROVEEDORES)));
  await page.route(/\/api\/flito\/parametrizacion\/organismos$/, (r) => r.fulfill(json([])));
  await page.route(/\/api\/flito\/parametrizacion\/companias$/, (r) => r.fulfill(json([])));
  await page.route(/\/api\/permisos\/roles$/, (r) => r.fulfill(json({ roles: ROLES })));
  await page.route(/\/api\/permisos\/funciones$/, (r) => r.fulfill(json({ grupos: [] })));
  await page.route(/\/api\/permisos\/roles\/[^/]+\/funciones$/, (r) => r.fulfill(json({ codigo: 'x', funciones: [] })));
  await page.route(/\/api\/permisos\/roles\/[^/]+\/arbol$/, (r) => {
    const codigo = decodeURIComponent(new URL(r.request().url()).pathname.split('/').at(-2) ?? '');
    const enlace = ROLES.find((x) => x.codigo === codigo)?.tipoEnlace ?? 'ninguno';
    return r.fulfill(json({ rol: { codigo, nombre: codigo, tipoEnlace: enlace }, arbol: arbolRol(ARBOL, CUADRO), transversales: [] }));
  });
  await page.route(/\/api\/users\/(\d+)\/arbol$/, (r) =>
    r.fulfill(json({ userId: 5, rol: 'x', arbol: arbolUsuario(ARBOL, CUADRO, new Map()), transversales: [] })));
  await page.route(/\/api\/users$/, (r) => r.fulfill(json(filas)));
  await page.route(/\/api\/users\/\d+$/, (r) => {
    if (r.request().method() === 'PATCH') {
      patches.push(r.request().postDataJSON());
      return r.fulfill(json(filas[0]));
    }
    return r.fulfill(json({}, 405));
  });
  return { patches };
}

test.describe('HU #13963 · usuarios — atadura al proveedor', () => {
  test('AC2/AC3/AC5 · en el alta, el inactivo sale deshabilitado con «(Inactivo)»; el eliminado no sale', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockUsuarios(page, []);
    await page.goto('/users');
    await page.getByRole('button', { name: 'Nuevo usuario' }).click();
    const rolBase = page.getByLabel('Rol base');
    await expect(rolBase).toBeEnabled();
    await rolBase.selectOption('proveedor');

    const select = page.getByLabel('Proveedor', { exact: true });
    await expect(select).toBeEnabled();
    await esperarInactivaNoElegible(select);
  });

  test('AC4 · el usuario atado a P inactivo lo conserva y se guarda sin cambiarlo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const atado = usuario({ id: 5, username: 'gestor.previsora', name: 'Atado', role: 'proveedor', flitoProveedorSoatId: PREVISORA });
    const { patches } = await mockUsuarios(page, [atado]);
    await page.goto('/users');
    await page.getByRole('button', { name: 'Editar' }).first().click();

    const select = page.getByLabel('Proveedor', { exact: true });
    await expect(select).toHaveValue(PREVISORA);
    await expect(select.getByRole('option', { name: 'La Previsora (Inactivo)' })).toHaveJSProperty('disabled', false);

    await page.getByLabel('Nombre completo').fill('Atado editado');
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).toEqual({ name: 'Atado editado' }); // la atadura no viaja: no cambió
  });
});
