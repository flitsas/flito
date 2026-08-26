// LAFT — el listado de inusuales cuando el backend falla (HU #11275, AC4; Bug #11768).
//
// Estos dos tests nacieron ROJOS A PROPÓSITO —con `test.fail()`— para documentar un defecto vivo:
// `LaftUnusual.tsx` atrapaba el fallo del listado así…
//
//     } catch (e) { toast.error(e instanceof Error ? e.message : 'Error'); }
//     finally { setLoading(false); }
//
// …y `data` se quedaba en `[]`, así que la tabla entraba en su rama de VACÍO y escribía,
// literalmente, «Sin operaciones registradas». El toast duraba unos segundos y se iba; el cartel se
// quedaba. En un módulo de reporte a la UIAF eso es lo peor que puede decir una pantalla: «no hay
// operaciones inusuales» y «no pude leer las operaciones inusuales» son conclusiones OPUESTAS —una
// cierra un trimestre sin ROS, la otra obliga a reintentar— y se veían idénticas.
//
// El Bug #11768 lo corrigió (estado de error en el cuerpo + «Reintentar», ver `LaftUnusual.tsx`), y
// con él se les quitó el `test.fail()`: desde entonces son guardianes normales y en verde. Si
// alguien vuelve a dejar que un 500 se pinte como vacío, se ponen rojos y dicen por qué.
//
// El mismo defecto estaba en `Laft.tsx` (contrapartes) y `LaftTrainings.tsx` (capacitaciones) y se
// corrigió a la vez; sus regresiones viven en `laft-listados-error.spec.ts`. Las otras cuatro
// vistas ya tenían estado de error y siguen SIN reintento: eso no lo cubre nadie (ver HANDOFF).
import { test, expect } from '../helpers/fixtures';
import { loginAs } from '../helpers/auth';
import { COMPLIANCE_LAFT_USER, VISTAS_LAFT } from '../helpers/laft-fixtures';

const INUSUALES = VISTAS_LAFT.find((v) => v.slug === 'laft_unusual')!;

/**
 * El contador de la cabecera («N operaciones registradas», en la barra de filtros de
 * `LaftUnusual.tsx`). Vive FUERA del `<tbody>`, así que ningún aserto sobre la tabla lo alcanza, y
 * su forma en cero —«0 operaciones registradas»— esquiva el aserto de estado vacío, que exige el
 * prefijo «Sin». Se afirma en las dos direcciones: ausente bajo el 500, presente tras el reintento.
 */
const CONTEO_CABECERA = /^\d+\s+operaciones registradas$/;

test.describe('LAFT — inusuales: el 500 no puede leerse como «no hay» (HU #11275 AC4 · Bug #11768)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('AC4 — un 500 muestra estado de ERROR, no el vacío', async ({ page }) => {
    await loginAs(page, COMPLIANCE_LAFT_USER);
    const peticiones: string[] = [];
    await page.route(INUSUALES.endpoint, async (route) => {
      peticiones.push(new URL(route.request().url()).pathname);
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Fallo sintético del listado de inusuales' }),
      });
    });

    await page.goto(INUSUALES.ruta);
    await expect(page.getByRole('heading', { level: 1, name: INUSUALES.titulo, exact: true })).toBeVisible();
    // El 500 salió de verdad: si el glob fallara, el catch-all respondería `200 []` y el vacío de
    // abajo sería legítimo. Este aserto es el que separa «falla el sensor» de «falla la pantalla».
    //
    // Va con `expect.poll` y no con un `expect` pelado por la misma razón que su gemelo de
    // `laft-listados-error.spec.ts`: `PageHeaderCard` pinta el `<h1>` FUERA de todo condicional de
    // carga, así que «encabezado visible» sucede ANTES de que la petición llegue a interceptarse.
    // Con el aserto instantáneo esto falla ~1 de cada 8 corridas con `Received array: []` (medido
    // allí con `--repeat-each=8`). En CI el `retries: 2` del config lo enmascaraba: el guardián
    // mentía por temporización, no por el estado de la pantalla, y el reintento lo tapaba.
    await expect.poll(
      () => peticiones,
      { message: 'el mock del 500 no llegó a interceptar nada' },
    ).toContain(INUSUALES.ruta_api);
    await expect(page.getByText(/^Cargando\.\.\.$/)).toHaveCount(0);

    // 1 · La afirmación central: un backend caído NO puede decir «no hay operaciones inusuales».
    await expect(
      page.getByText('Sin operaciones registradas'),
      'un 500 se está pintando como estado VACÍO: «no hay señales» y «no pude leer las señales» son conclusiones opuestas',
    ).toHaveCount(0);

    // 2 · Y lo que sí tiene que haber: el cuarto estado, con su mensaje y su salida.
    await expect(page.getByRole('alert')).toContainText(/no se pudo cargar/i);
    await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible();

    // 3 · Y la cabecera tampoco puede seguir contando. El aserto 1 mira `Sin operaciones
    //     registradas`, con «Sin» obligatorio, así que **«0 operaciones registradas» —lo que
    //     pintaba el contador del filtro bajo un 500— lo atravesaba sin hacer ruido**: la misma
    //     afirmación que este Bug corrige, dicha fuera del `<tbody>`. Su control positivo está en
    //     el test siguiente, que exige el conteo VISIBLE tras el reintento con éxito.
    await expect(
      page.getByText(CONTEO_CABECERA),
      'la cabecera sigue afirmando un conteo bajo un 500: es el defecto del Bug, dicho fuera de la tabla',
    ).toHaveCount(0);
  });

  test('AC4 — «Reintentar» vuelve a consultar y recupera la vista', async ({ page }) => {
    await loginAs(page, COMPLIANCE_LAFT_USER);
    // Falla la PRIMERA vez y responde bien a partir de la segunda: es el escenario real de un
    // backend que se cayó un momento, y el único que prueba que el reintento sirve para algo.
    let intentos = 0;
    await page.route(INUSUALES.endpoint, async (route) => {
      intentos += 1;
      if (intentos === 1) {
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Fallo sintético"}' });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(INUSUALES.cuerpo) });
    });

    await page.goto(INUSUALES.ruta);
    const reintentar = page.getByRole('button', { name: 'Reintentar' });
    await expect(reintentar).toBeVisible();

    await reintentar.click();

    // El reintento consulta de nuevo (no repinta desde memoria)…
    await expect.poll(() => intentos).toBeGreaterThan(1);
    // …y la vista queda CARGADA: el error desaparece y el dato del fixture está.
    await expect(page.getByText(INUSUALES.textoCargado).first()).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(reintentar).toHaveCount(0);
    // Control positivo del aserto de conteo del test anterior: un `toHaveCount(0)` pasa igual de
    // bien si el selector nunca acertó. Con la carga buena el contador SÍ tiene que estar.
    await expect(page.getByText(CONTEO_CABECERA)).toBeVisible();
  });
});
