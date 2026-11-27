import { test, expect, type Page, type Route } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER, AUDITOR_USER, type UsuarioFixture } from '../helpers/auth';

// FLITO — Gestión Trámites: vistas de columnas persistidas (ADR-0045, Épica #14560). El API está
// mockeado: `/api/flito/vistas-columnas/flito-tramites` responde con un estado en memoria que las
// escrituras modifican, como haría el servidor (vista activa = puntero personal → sistema).

const fila = {
  tramiteId: 'bbbbbbbb-0000-0000-0000-000000000001', idFlit: 'FLIT-3001', estado: 'Asignado', asignado: true,
  fuente: 'flit', tipoTramite: 'Matricula', ciudad: 'Manizales', fechaCreacion: null, fechaAprobacion: null,
  derechoTramiteValor: null, empresaExiste: true, empresaNit: '900111', secretariaEmparejada: true,
  transitoNombre: 'STT Manizales', facturaVentaFlitId: null, companiaNombre: 'Concesionario Norte',
  organismoNombre: 'STT Manizales', vehiculo: { vin: 'VIN000000000001', placa: 'PLC001', marca: 'Mazda', linea: '2', tipoVehiculo: null },
  compradorPrincipal: null, compradores: [], soat: null, soatAutogestionado: false, impuesto: null,
  impuestosAutogestionado: false, excepcionesAutogestion: [], vigenciaTramite: 'vigente', listoParaEntregar: false,
};

const CATALOGO = [
  ['tramite', 'Trámite', true], ['fuente', 'Fuente'], ['creado', 'Creado'], ['aprobado', 'Aprobado'],
  ['vehiculo', 'Vehículo'], ['comprador', 'Propietario'], ['correo', 'Correo'], ['empresa_gestora', 'Empresa gestora'],
  ['transito', 'Tránsito'], ['ciudad', 'Ciudad'], ['soat', 'SOAT'], ['impuestos', 'Impuestos'],
  ['logistica', 'Logística'], ['derechos_transito', 'Derechos de tránsito'], ['soportes', 'Soportes'],
].map(([clave, etiqueta, fija]) => ({ clave: clave as string, etiqueta: etiqueta as string, fija: fija === true }));
const SISTEMA = CATALOGO.map((c) => c.clave);

interface Vista { id: number; nombre: string; alcance: 'personal' | 'compartida'; columnas: string[]; version: number }

const json = (route: Route, status: number, body?: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: body === undefined ? '' : JSON.stringify(body) });

async function montar(page: Page, opts: { usuario?: UsuarioFixture; fallaCarga?: boolean; vistas?: Vista[] } = {}) {
  const vistas: Vista[] = [...(opts.vistas ?? [])];
  let puntero: number | null = null;
  let falla = opts.fallaCarga ?? false;
  const escrituras: { metodo: string; url: string; cuerpo: unknown }[] = [];

  await page.route(/\/api\/flito\/tramites\/facetas/, (route) => json(route, 200,
    { estados: ['Asignado'], tramites: ['Matricula'], ciudades: ['Manizales'], transitos: ['STT Manizales'] }));
  await page.route(/\/api\/flito\/tramites\?/, (route) => json(route, 200, { items: [fila], total: 1, page: 1, pageSize: 50 }));
  await page.route(/\/api\/flito\/vistas-columnas\/flito-tramites/, async (route) => {
    const req = route.request();
    const url = new URL(req.url()).pathname;
    if (req.method() === 'GET') {
      if (falla) return json(route, 500, { error: 'detalle interno que no debe verse' });
      const activa = vistas.find((v) => v.id === puntero);
      return json(route, 200, {
        tablaId: 'flito-tramites', columnasDisponibles: CATALOGO,
        vistaActiva: { id: activa?.id ?? null, origen: activa ? 'personal' : 'sistema', columnas: activa?.columnas ?? SISTEMA },
        sistema: { columnas: SISTEMA },
        vistas: vistas.map((v) => ({ id: v.id, nombre: v.nombre, alcance: v.alcance, columnas: v.columnas, esPredeterminada: v.id === puntero, puedeEditar: true, version: v.version })),
        limites: { columnasPorVista: 30, vistasPersonales: 20 },
      });
    }
    const cuerpo = req.postDataJSON() as Record<string, unknown> | null;
    escrituras.push({ metodo: req.method(), url, cuerpo });
    if (req.method() === 'POST' && url.endsWith('/vistas')) {
      const v: Vista = { id: vistas.length + 1, nombre: String(cuerpo?.nombre), alcance: cuerpo?.alcance as Vista['alcance'], columnas: cuerpo?.columnas as string[], version: 1 };
      vistas.push(v);
      return json(route, 201, { id: v.id, version: 1 });
    }
    if (req.method() === 'PUT' && url.endsWith('/predeterminada/personal')) {
      puntero = (cuerpo?.vistaId as number | null) ?? null;
      return json(route, 200, { vistaId: puntero });
    }
    return json(route, 404, { error: 'no mockeado', codigo: 'VISTA_NO_ENCONTRADA' });
  });
  await loginAs(page, opts.usuario ?? OPERACIONES_USER);
  await page.goto('/flito/tramites');
  // Margen para el primer render en frío del dev server (compila la página al pedirla).
  await expect(page.getByText('FLIT-3001')).toBeVisible({ timeout: 20_000 });
  return { escrituras, arreglar: () => { falla = false; } };
}

const cabecera = (page: Page, nombre: string) => page.getByRole('columnheader', { name: nombre, exact: true });
const panel = (page: Page) => page.getByRole('dialog', { name: 'Columnas de la tabla' });
const abrir = async (page: Page) => {
  await page.getByRole('button', { name: /^Columnas/ }).click();
  await expect(panel(page)).toBeVisible();
};

test.describe('FLITO — Gestión Trámites: vistas de columnas (ADR-0045)', () => {
  test('abrir el panel, ocultar una columna (cabecera y celda), Escape cierra y devuelve el foco', async ({ page }) => {
    await montar(page);
    await abrir(page);
    const p = panel(page);
    await expect(p.getByLabel('Vista')).toHaveValue('');
    await expect(p.getByRole('checkbox', { name: /Trámite/ })).toBeDisabled();
    await expect(p.getByRole('checkbox', { name: /Trámite/ })).toBeChecked();
    await expect(page.getByText('Concesionario Norte')).toBeVisible();

    await p.getByRole('checkbox', { name: 'Empresa gestora' }).uncheck();
    await expect(cabecera(page, 'Empresa gestora')).toHaveCount(0);
    await expect(page.getByText('Concesionario Norte')).toHaveCount(0);
    await expect(p.getByText(/Cambios sin guardar/)).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Columnas/ })).toBeFocused();
  });

  test('guardar como nueva vista la deja elegida (sin fijarla); restablecer vuelve a la vista del sistema', async ({ page }) => {
    const { escrituras } = await montar(page);
    await abrir(page);
    const p = panel(page);
    await p.getByRole('checkbox', { name: 'Correo' }).uncheck();
    await p.getByRole('button', { name: 'Guardar como nueva vista' }).click();

    // Nombre vacío: error en el campo, sin llamar al API.
    await p.getByRole('button', { name: 'Guardar', exact: true }).click();
    await expect(p.getByText('Escriba un nombre de 1 a 60 caracteres.')).toBeVisible();
    expect(escrituras).toHaveLength(0);

    await p.getByLabel('Nombre de la vista').fill('Sin correo');
    await p.getByRole('button', { name: 'Guardar', exact: true }).click();
    await expect(page.getByText('Vista guardada.')).toBeVisible();
    const post = escrituras.find((e) => e.metodo === 'POST');
    expect(post?.cuerpo).toEqual({ nombre: 'Sin correo', alcance: 'personal', columnas: SISTEMA.filter((c) => c !== 'correo') });
    // Guardar no la hace predeterminada: eso es «Usar como predeterminada».
    expect(escrituras.filter((e) => e.url.endsWith('/predeterminada/personal'))).toHaveLength(0);
    await expect(p.getByLabel('Vista')).toHaveValue('1');
    await expect(p.getByRole('option', { name: 'Sin correo', exact: true })).toBeAttached();
    await expect(cabecera(page, 'Correo')).toHaveCount(0);

    await p.getByRole('button', { name: 'Restablecer' }).click();
    await expect(page.getByText('Volvió a la vista del sistema.')).toBeVisible();
    expect(escrituras.at(-1)).toMatchObject({ metodo: 'PUT', cuerpo: { vistaId: null } });
    await expect(cabecera(page, 'Correo')).toBeVisible();
    await expect(p.getByLabel('Vista')).toHaveValue('');
  });

  test('elegir una vista solo aplica sus columnas en la sesión; «Usar como predeterminada» la fija', async ({ page }) => {
    const { escrituras } = await montar(page, {
      vistas: [{ id: 7, nombre: 'Despacho', alcance: 'personal', columnas: SISTEMA.filter((c) => c !== 'ciudad'), version: 3 }],
    });
    await abrir(page);
    const p = panel(page);
    await expect(p.getByRole('option', { name: 'Vista del sistema (predeterminada)' })).toBeAttached();

    await p.getByLabel('Vista').selectOption('7');
    await expect(cabecera(page, 'Ciudad')).toHaveCount(0);
    await expect(p.getByRole('checkbox', { name: 'Ciudad' })).not.toBeChecked();
    expect(escrituras).toHaveLength(0); // elegir no escribe nada

    await p.getByRole('button', { name: 'Usar como predeterminada' }).click();
    await expect(page.getByText('Ahora es su vista predeterminada.')).toBeVisible();
    expect(escrituras).toEqual([expect.objectContaining({ metodo: 'PUT', cuerpo: { vistaId: 7 } })]);
    expect(escrituras[0].url).toMatch(/\/predeterminada\/personal$/);
    await expect(p.getByRole('option', { name: 'Despacho (predeterminada)' })).toBeAttached();
    await expect(p.getByRole('button', { name: 'Usar como predeterminada' })).toHaveCount(0);

    // Volver a la del sistema en el selector tampoco escribe.
    await p.getByLabel('Vista').selectOption('');
    await expect(cabecera(page, 'Ciudad')).toBeVisible();
    expect(escrituras).toHaveLength(1);
  });

  test('si falla la carga: tabla con la vista del sistema, aviso de página sin el error crudo y reintento', async ({ page }) => {
    const { arreglar } = await montar(page, { fallaCarga: true });
    const aviso = page.getByText('No pudimos cargar sus vistas de columnas. La tabla se muestra con la vista del sistema.');
    await expect(aviso).toBeVisible();
    await expect(page.getByText('detalle interno que no debe verse')).toHaveCount(0);
    await expect(cabecera(page, 'Correo')).toBeVisible();

    await abrir(page);
    await expect(panel(page).getByText(/No se pudieron cargar sus vistas/)).toBeVisible();
    arreglar();
    await page.getByRole('button', { name: 'Reintentar' }).first().click();
    await expect(aviso).toHaveCount(0);
    await expect(panel(page).getByRole('checkbox', { name: 'Correo' })).toBeChecked();
  });

  test('admin ve «Vista para todos» al guardar', async ({ page }) => {
    await montar(page);
    await abrir(page);
    await panel(page).getByRole('button', { name: 'Guardar como nueva vista' }).click();
    await expect(panel(page).getByRole('checkbox', { name: 'Vista para todos' })).toBeVisible();
  });

  test('un no-admin (Auditoría) no ve «Vista para todos»', async ({ page }) => {
    await montar(page, { usuario: AUDITOR_USER });
    await abrir(page);
    await panel(page).getByRole('button', { name: 'Guardar como nueva vista' }).click();
    await expect(panel(page).getByLabel('Nombre de la vista')).toBeVisible();
    await expect(panel(page).getByText('Vista para todos')).toHaveCount(0);
  });
});
