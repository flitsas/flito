import { test, expect, type Page, type Route } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';

// FLITO — Gestión Trámites: el panel «Columnas» del listado activa «Gestor» y «Correo del gestor» (Bug #14722, R4).
// API mockeado: la fila trae nombreGestor / correoGestor; el catálogo incluye las dos columnas nuevas y la vista
// del sistema NO las muestra por defecto, así que el test las activa desde el panel y comprueba cabecera y celdas.

const CATALOGO = [
  ['tramite', 'Trámite', true], ['fuente', 'Fuente'], ['creado', 'Creado'], ['aprobado', 'Aprobado'],
  ['vehiculo', 'Vehículo'], ['comprador', 'Propietario'], ['correo', 'Correo'],
  ['nombre_gestor', 'Gestor'], ['correo_gestor', 'Correo del gestor'], ['empresa_gestora', 'Empresa gestora'],
  ['transito', 'Tránsito'], ['ciudad', 'Ciudad'], ['soat', 'SOAT'], ['impuestos', 'Impuestos'],
  ['logistica', 'Logística'], ['derechos_transito', 'Derechos de tránsito'], ['soportes', 'Soportes'],
].map(([clave, etiqueta, fija]) => ({ clave: clave as string, etiqueta: etiqueta as string, fija: fija === true }));
const SISTEMA = CATALOGO.map((c) => c.clave).filter((c) => c !== 'nombre_gestor' && c !== 'correo_gestor');

const fila = {
  tramiteId: 'dddddddd-0000-0000-0000-000000000001', idFlit: 'FLIT-4701', estado: 'Asignado', asignado: true,
  fuente: 'flit', tipoTramite: 'Matricula', ciudad: 'Manizales', fechaCreacion: null, fechaAprobacion: null,
  derechoTramiteValor: null, empresaExiste: true, empresaNit: '900111', secretariaEmparejada: true,
  transitoNombre: 'STT Manizales', facturaVentaFlitId: null, companiaNombre: 'Concesionario Norte',
  organismoNombre: 'STT Manizales', vehiculo: { vin: 'VIN000000000047', placa: 'PLC047', marca: 'Mazda', linea: '2', tipoVehiculo: null },
  compradorPrincipal: null, compradores: [], soat: null, soatAutogestionado: false, impuesto: null,
  impuestosAutogestionado: false, excepcionesAutogestion: [], vigenciaTramite: 'vigente', listoParaEntregar: false,
  nombreGestor: 'Laura Gestora', correoGestor: 'laura.gestora@demo.test',
};

const json = (route: Route, status: number, body?: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: body === undefined ? '' : JSON.stringify(body) });

async function montar(page: Page) {
  await page.route(/\/api\/flito\/tramites\/facetas/, (route) => json(route, 200,
    { estados: ['Asignado'], tramites: ['Matricula'], ciudades: ['Manizales'], transitos: ['STT Manizales'] }));
  await page.route(/\/api\/flito\/tramites\?/, (route) => json(route, 200, { items: [fila], total: 1, page: 1, pageSize: 50 }));
  await page.route(/\/api\/flito\/vistas-columnas\/flito-tramites/, (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      return json(route, 200, {
        tablaId: 'flito-tramites', columnasDisponibles: CATALOGO,
        vistaActiva: { id: null, origen: 'sistema', columnas: SISTEMA },
        sistema: { columnas: SISTEMA },
        vistas: [], limites: { columnasPorVista: 30, vistasPersonales: 20 },
      });
    }
    return json(route, 404, { error: 'no mockeado', codigo: 'VISTA_NO_ENCONTRADA' });
  });
  await loginAs(page, OPERACIONES_USER);
  await page.goto('/flito/tramites');
  await expect(page.getByText('FLIT-4701')).toBeVisible({ timeout: 20_000 });
}

const cabecera = (page: Page, nombre: string) => page.getByRole('columnheader', { name: nombre, exact: true });
const panel = (page: Page) => page.getByRole('dialog', { name: 'Columnas de la tabla' });

test.describe('FLITO — Gestión Trámites: panel Columnas activa Gestor y Correo del gestor (Bug #14722, R4)', () => {
  test('activar «Gestor» y «Correo del gestor» en el panel muestra cabeceras y las celdas con el valor', async ({ page }) => {
    await montar(page);
    // Vista del sistema: ninguna de las dos columnas aparece hasta que el usuario las activa.
    await expect(cabecera(page, 'Gestor')).toHaveCount(0);
    await expect(cabecera(page, 'Correo del gestor')).toHaveCount(0);

    await page.getByRole('button', { name: /^Columnas/ }).click();
    const p = panel(page);
    await expect(p).toBeVisible();
    await p.getByRole('checkbox', { name: 'Gestor', exact: true }).check();
    await p.getByRole('checkbox', { name: 'Correo del gestor', exact: true }).check();

    await expect(cabecera(page, 'Gestor')).toBeVisible();
    await expect(cabecera(page, 'Correo del gestor')).toBeVisible();

    const fila4701 = page.getByRole('row').filter({ hasText: 'FLIT-4701' });
    await expect(fila4701.getByRole('cell', { name: 'Laura Gestora', exact: true })).toBeVisible();
    await expect(fila4701.getByRole('link', { name: 'laura.gestora@demo.test' })).toHaveAttribute('href', 'mailto:laura.gestora@demo.test');
  });
});
