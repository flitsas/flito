// HU #12097 (AC3 y AC5) — accesibilidad de las dos superficies que esta HU estrena en la cola de
// SOAT: los chips de vigencia con su línea de antigüedad dentro de la celda «Estado», y el `select`
// «Vigencia» de la barra de filtros.
//
// ── Por qué en su propio archivo ────────────────────────────────────────────────────────────────
//
// El repo no tiene `@axe-core/playwright`: `helpers/axe.ts` inyecta `axe.min.js` desde disco
// (`QA_AXE_PATH`) o desde un CDN (`QA_AXE_CDN=1`), y **lanza a propósito** si no hay ninguno de los
// dos (HU #11650). Dentro de `flito-soat.spec.ts` ese rojo de ENTORNO contaminaría el gate
// funcional del módulo y nadie podría distinguir «la pantalla incumple» de «axe no estaba».
//
//   QA_AXE_CDN=1 npx playwright test e2e/tests/flito-soat-vigencia-a11y.spec.ts
//
// Lo que este archivo NO puede acreditar: el CONTRASTE de los cuatro chips. axe mide el color
// calculado de lo que hay en pantalla, así que sí entra en `color-contrast`, pero `check:contraste`
// solo mide la ⌘K y los gradientes y ningún gate cubre estas etiquetas. Los ratios están escritos y
// medidos en `docs/ux/flito-soat-vigencia-en-la-cola.md` §3.3.
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';
import { correrAxe, esperarSinViolacionesGraves } from '../helpers/axe';

test.use({ viewport: { width: 1440, height: 900 } });

/** 02:00 en Bogotá del 7 de septiembre de 2026, igual que en el spec funcional. */
const AHORA = new Date('2026-09-07T07:00:00Z');

const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

/** Una fila de la cola, con el bloque de vigencia que se le pase. */
function fila(id: string, placa: string, estado: string, vigencia: unknown) {
  return {
    id, vin: `VIN000000000${id}`, placa, marca: 'Mazda', linea: 'CX-30',
    cilindraje: '1598', carroceria: 'SUV', tipoServicio: 'Particular',
    estado, esMultiplePropietario: false, companiaNombre: 'Concesionario Sur',
    organismoNombre: 'STT Pereira', proveedorSoatId: 'p1', proveedorSoatNombre: 'Seguros Alfa',
    gestionOperaciones: false, compradores: [], tramitesFlit: [], tipoTramite: 'Traspaso',
    fechaAprobacion: '2026-09-01T12:00:00Z', fechaCreacion: '2026-09-01T10:00:00Z',
    enviadoPorNombre: 'Operaciones E2E', enviadoEn: '2026-09-02T12:00:00Z',
    pagadoEn: '2026-09-03T12:00:00Z', valorPagado: 740800, estancado: false, motivoRechazo: null,
    creadoEn: '2026-09-01T12:00:00Z', vigencia,
  };
}

/** Las CUATRO superficies a la vez, más la fila que no entra en la verificación. */
const FILAS = [
  fila('a1', 'VIG001', 'pagado', { estado: 'vigente', verificadaEn: '2026-09-07T05:10:00Z', venceEl: '2027-03-12' }),
  fila('a2', 'VEN002', 'pagado', { estado: 'vencido', verificadaEn: '2026-09-06T08:10:00Z', venceEl: '2026-03-12' }),
  fila('a3', 'REG003', 'pagado', { estado: 'sin_registro', verificadaEn: '2026-09-04T05:10:00Z', venceEl: null }),
  fila('a4', 'NOC004', 'pagado', { estado: 'no_verificado', verificadaEn: '2026-09-04T05:10:00Z', venceEl: null }),
  fila('a5', 'NUL005', 'pagado', { estado: 'no_verificado', verificadaEn: null, venceEl: null }),
  fila('a6', 'PEN006', 'pendiente', null),
];

async function montarCola(page: Page) {
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat/, (route) =>
    json(route, [{ id: 'p1', nombre: 'Seguros Alfa', activo: true }]));
  await page.route(/\/api\/flito\/soat\/facetas/, (route) =>
    json(route, { companias: [{ id: 2, nombre: 'Concesionario Sur' }], organismos: [], proveedores: [{ id: 'p1', nombre: 'Seguros Alfa' }] }));
  await page.route(/\/api\/flito\/soat\?/, (route) =>
    json(route, { items: FILAS, total: FILAS.length, page: 1, pageSize: 50 }));
  await page.clock.setFixedTime(AHORA);
  await page.goto('/flito/soat');
  await expect(page.getByRole('region', { name: 'Pólizas SOAT' })).toBeVisible();
}

test.describe('HU #12097 · AC3 y AC5 — accesibilidad de la vigencia en la cola', () => {
  test('la tabla con las cuatro superficies: axe sin violaciones graves y ninguna parada de tabulador nueva', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montarCola(page);

    // Las cuatro pintadas a la vez, que es la condición de la medida: axe solo mide lo que existe.
    // Acotado a la TABLA porque dos de esos textos son además rótulos de opción del filtro —lo que
    // es deliberado (§5.1 del UX): la opción dice lo mismo que el chip para no obligar a traducir.
    const tabla = page.getByRole('region', { name: 'Pólizas SOAT' });
    await expect(tabla.getByText('Vigente hasta 12/03/27')).toBeVisible();
    await expect(tabla.getByText('Venció el 12/03/26')).toBeVisible();
    await expect(tabla.getByText('Sin SOAT en el RUNT')).toBeVisible();
    await expect(tabla.getByText('No se pudo consultar')).toBeVisible();
    await expect(tabla.getByText('Sin verificar')).toBeVisible();

    // ── 1 · Cero paradas de tabulador nuevas en la fila ───────────────────────────────────────
    // El chip es un `<span>` y la antigüedad es texto: las únicas paradas por fila siguen siendo la
    // casilla y «Ver». Un `<button>` o un `tabIndex` colado aquí —para un tooltip, por ejemplo— haría
    // que recorrer la cola con teclado costara el doble.
    const celdaEstado = page.getByRole('row').filter({ hasText: 'NOC004' })
      .getByRole('cell').filter({ hasText: 'Pagado' });
    await expect(celdaEstado.locator('a, button, input, select, textarea, [tabindex]')).toHaveCount(0);

    // ── 2 · Nada oculto en `title` ni en un `aria-label` que diga otra cosa ───────────────────
    // El AC1 dice que la fila MUESTRA la fecha, y un `title` no lo ve quien navega con teclado ni
    // quien está en una tableta. Es además donde acabaría la placa si alguien quisiera «que el test
    // la encuentre»: los selectores de axe arrastran los valores de atributo al informe.
    await expect(celdaEstado.locator('[title], [aria-label]')).toHaveCount(0);

    // ── 3 · El criterio no depende del color: está entero en el TEXTO ─────────────────────────
    // El puntito del `StatusChip` es `aria-hidden` y redundante por diseño del kit, así que lo que
    // llega a un lector de pantalla es la etiqueta y su línea. Esta es la comprobación del AC3 que
    // sobreviviría a cambiar la paleta entera.
    expect((await celdaEstado.innerText()).replace(/\s+/g, ' '))
      .toContain('No se pudo consultar Último dato: hace 3 días (4/09/26)');

    // ── 4 · axe sobre la tabla llena ──────────────────────────────────────────────────────────
    esperarSinViolacionesGraves(await correrAxe(page), 'cola de SOAT · vigencia frente al RUNT');
  });

  test('el filtro «Vigencia»: nombre accesible visible, foco visible y axe con el filtro puesto', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await montarCola(page);

    // El nombre accesible ES el rótulo visible, con el `<label>` envolvente del de «Gestiona»: sin
    // eso, `getByLabel('Vigencia')` no encontraría nada y un lector de pantalla anunciaría un
    // combo mudo. `toHaveCount(1)` impide además el empate con otro control del mismo nombre.
    const filtro = page.getByLabel('Vigencia');
    await expect(filtro).toHaveCount(1);

    // El foco tiene que producir una diferencia VISIBLE, no usar un token concreto.
    const estilo = () => filtro.evaluate((el) => {
      const s = getComputedStyle(el);
      return `${s.outlineStyle}|${s.outlineWidth}|${s.outlineColor}|${s.boxShadow}|${s.borderColor}`;
    });
    const sinFoco = await estilo();
    await filtro.focus();
    await expect(filtro).toBeFocused();
    expect(await estilo(), 'el foco del filtro de vigencia no produce ninguna diferencia visible')
      .not.toEqual(sinFoco);

    await filtro.selectOption('no_verificado');
    esperarSinViolacionesGraves(await correrAxe(page), 'cola de SOAT · filtro «Vigencia» aplicado');
  });
});
