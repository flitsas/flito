import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';

// FLITO — Impuestos · HU #12830: semáforo factura ↔ RUNT y estado del análisis en la cola.
// Backend mockeado, mismo patrón que `flito-impuestos.spec.ts`. El modal comparativo es de la HU
// #12831: aquí solo se prueba que el icono existe, se nombra y es un botón enfocable.

const BASE = {
  tramiteId: 't', vin: 'VIN0000000000000', marca: 'Renault', linea: 'Logan', tipoTramite: 'Traspaso',
  fechaAprobacion: null, fechaCreacion: '2026-09-01T12:00:00Z',
  compradorNombre: 'Ana Pérez', compradorDocumento: '10101010', compradorTipoDocumento: 'CC',
  companiaNombre: 'Concesionario Norte', organismoCodigo: 'STT-MZL', organismoNombre: 'STT Manizales',
  valorLiquidado: 120000, valorPagado: null, marcadoPorDiferencia: false, tieneFacturaVenta: true,
  enviadoPorNombre: 'Operaciones E2E', enviadoEn: '2026-09-02T12:00:00Z', pagadoEn: null, estancado: false,
  motivoRechazo: null, creadoEn: '2026-09-01T12:00:00Z', gestionOperaciones: false,
  certificacion: null, liquidadoEn: null, documentos: null,
};

type Fila = Record<string, unknown> & { id: string; semaforo: string | null };
const fila = (id: string, placa: string, extra: Partial<Fila>): Fila => ({
  ...BASE, id, idFlit: `FLIT-${id}`, placa, estado: 'solicitado',
  analisisEstado: null, semaforo: null, motivoSemaforo: null, ...extra,
});

const FILAS: Fila[] = [
  fila('p1', 'PEN001', { estado: 'pendiente', enviadoEn: null }),
  fila('a1', 'ANA001', { analisisEstado: 'en_curso', semaforo: 'verde' }),
  fila('v1', 'VER001', { analisisEstado: 'completado', semaforo: 'verde' }),
  fila('n1', 'NAR001', { analisisEstado: 'completado', semaforo: 'naranja' }),
  fila('r1', 'ROJ001', { analisisEstado: 'completado', semaforo: 'rojo', motivoSemaforo: 'runt_sin_respuesta' }),
  fila('r2', 'ROJ002', { analisisEstado: 'completado', semaforo: 'rojo', motivoSemaforo: 'error_lectura_factura' }),
  fila('e1', 'ERR001', { analisisEstado: 'error_analisis' }),
];

const consultas: string[] = [];

async function mock(page: import('@playwright/test').Page) {
  consultas.length = 0;
  await page.route(/\/api\/flito\/impuestos\/facetas/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ companias: [], organismos: [] }) }));
  await page.route(/\/api\/flito\/impuestos\?/, (route) => {
    const url = new URL(route.request().url());
    consultas.push(url.search);
    const semaforo = url.searchParams.get('semaforo');
    let items = FILAS;
    if (semaforo) items = items.filter((f) => f.semaforo !== null && semaforo.split(',').includes(f.semaforo));
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ items, total: items.length, page: 1, pageSize: 50 }),
    });
  });
}

/** La fila de la tabla que contiene la placa. */
const filaDe = (page: import('@playwright/test').Page, placa: string) =>
  page.getByRole('row').filter({ hasText: placa });

test.describe('FLITO — Impuestos · semáforo de la cola (HU #12830)', () => {
  test('AC1 · «Analizando» con indicador sutil; la fila sigue interactiva y no pinta el semáforo viejo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/impuestos');

    const f = filaDe(page, 'ANA001');
    await expect(f.getByTestId('validacion-analizando')).toHaveText('Analizando');
    await expect(f.locator('svg.animate-spin')).toHaveCount(1);
    await expect(f.locator('svg.animate-spin')).toHaveClass(/motion-reduce:animate-none/);
    // En curso manda sobre el color: el verde viejo no se pinta.
    await expect(f.locator('[data-semaforo]')).toHaveCount(0);
    // «Analizando» no es botón y no bloquea: la casilla y «Ver» siguen activos.
    await expect(f.getByRole('button', { name: 'Analizando' })).toHaveCount(0);
    await f.getByLabel('Seleccionar ANA001').check();
    await expect(page.getByText('1 seleccionado(s)')).toBeVisible();
    await expect(f.getByRole('button', { name: 'Ver' })).toBeEnabled();
  });

  test('AC2 · cada color con su icono, aria-label y tooltip; en rojo, el motivo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/impuestos');

    const casos: Array<[string, string, string]> = [
      ['VER001', 'verde', 'Coincide con el RUNT. Ver comparación'],
      ['NAR001', 'naranja', 'Con diferencias frente al RUNT. Ver comparación'],
      ['ROJ001', 'rojo', 'Sin validar: El RUNT no respondió o no tiene registro del vehículo'],
      ['ROJ002', 'rojo', 'Sin validar: No se pudo leer la factura'],
      ['ERR001', 'error_analisis', 'Sin validar: la validación no terminó. Ver opciones'],
    ];
    for (const [placa, clave, texto] of casos) {
      const icono = filaDe(page, placa).getByRole('button', { name: texto, exact: true });
      await expect(icono).toBeVisible();
      await expect(icono).toHaveAttribute('title', texto);
      await expect(icono).toHaveAttribute('data-semaforo', clave);
      await expect(icono).toHaveClass(/flit-focus/);
      await expect(icono).toHaveClass(/hover:bg-\[var\(--flit-bg-hover\)\]/);
    }
    // Nunca analizado: nada, ni guion.
    await expect(filaDe(page, 'PEN001').locator('[data-semaforo], [data-testid="validacion-analizando"]')).toHaveCount(0);

    // Enfocable con teclado.
    const verde = filaDe(page, 'VER001').getByRole('button', { name: /Coincide con el RUNT/ });
    await verde.focus();
    await expect(verde).toBeFocused();
  });

  test('AC3 · tras enviar en bloque aparece el aviso cerrable con cuántos quedan en análisis', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.route(/\/api\/flito\/impuestos\/enviar$/, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enviados: ['p1'], yaEnviados: [] }) }));
    await page.goto('/flito/impuestos');

    await expect(page.getByTestId('aviso-analisis')).toHaveCount(0);
    await filaDe(page, 'PEN001').getByLabel('Seleccionar PEN001').check();
    const antes = consultas.length;
    await page.getByRole('button', { name: /Enviar al gestor/ }).click();

    const aviso = page.getByTestId('aviso-analisis');
    await expect(aviso).toHaveAttribute('role', 'status');
    await expect(aviso).toContainText('1 impuesto enviado al gestor. 1 queda en análisis contra el RUNT');
    // La cola se refrescó tras el envío.
    await expect.poll(() => consultas.length).toBeGreaterThan(antes);

    // «Actualizar la cola» vuelve a pedir la cola.
    const n = consultas.length;
    await aviso.getByRole('button', { name: 'Actualizar la cola' }).click();
    await expect.poll(() => consultas.length).toBeGreaterThan(n);

    await aviso.getByRole('button', { name: 'Cerrar aviso' }).click();
    await expect(page.getByTestId('aviso-analisis')).toHaveCount(0);
  });

  test('AC3 · el preset «Con alertas» pide semaforo=naranja,rojo y deja solo esas filas', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mock(page);
    await page.goto('/flito/impuestos');
    await expect(filaDe(page, 'VER001')).toBeVisible();

    await page.getByLabel('Filtros inteligentes').click();
    await page.getByRole('button', { name: /Con alertas/ }).click();

    await expect.poll(() => consultas.at(-1)).toContain('semaforo=naranja%2Crojo');
    await expect(filaDe(page, 'NAR001')).toBeVisible();
    await expect(filaDe(page, 'ROJ001')).toBeVisible();
    await expect(filaDe(page, 'ROJ002')).toBeVisible();
    await expect(filaDe(page, 'VER001')).toHaveCount(0);
    await expect(filaDe(page, 'ERR001')).toHaveCount(0); // error_analisis sin semáforo no entra
    await expect(filaDe(page, 'ANA001')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Limpiar filtros' })).toBeVisible();
  });
});
