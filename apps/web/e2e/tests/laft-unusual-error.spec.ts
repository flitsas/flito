// LAFT — el listado de inusuales cuando el backend falla (HU #11275, AC4).
//
// ██ ESTOS DOS TESTS FALLAN A PROPÓSITO. NO SE ROMPIERON: DOCUMENTAN UN DEFECTO (Bug #11768). ██
//
// Los dos llevan `test.fail()`, así que el runner los cuenta como ÉXITO mientras el defecto siga
// vivo y CI queda en verde. Siguen siendo guardianes en las dos direcciones: el día que alguien
// corrija el defecto y olvide quitar la anotación, se pondrán ROJOS y lo dirán.
//
// Describen lo que el AC4 exige y lo que la pantalla NO hace hoy. No se corrigió aquí porque es
// cambio de código de producción, y esa decisión es del humano. El parche propuesto (estado de
// error + reintento en `LaftUnusual.tsx`, calcado del patrón que ya usan `LaftAuditPlan` /
// `LaftManual` / `LaftOfficer`) se entregó por separado en el Bug #11768; aplicándolo, los dos
// tests pasan por sí solos y hay que quitarles el `test.fail()`. Comprobado en ambos sentidos.
//
// ── El defecto, con su nombre ─────────────────────────────────────────────────────────────────
//
// `LaftUnusual.tsx` atrapa el fallo del listado así:
//
//     } catch (e) { toast.error(e instanceof Error ? e.message : 'Error'); }
//     finally { setLoading(false); }
//
// `data` se queda en `[]`, así que la tabla entra en su rama de VACÍO y escribe, literalmente,
// **«Sin operaciones registradas»**. El toast dura unos segundos y se va; el cartel se queda.
//
// En un módulo de reporte a la UIAF eso es lo peor que puede decir una pantalla: «no hay
// operaciones inusuales» y «no pude leer las operaciones inusuales» son conclusiones OPUESTAS
// —una cierra un trimestre sin ROS, la otra obliga a reintentar— y hoy se ven idénticas. No hay
// camino de vuelta salvo recargar el navegador: no existe botón de reintento en NINGUNA de las 7
// vistas del módulo.
//
// El mismo patrón está en `Laft.tsx` (contrapartes) y en `LaftTrainings.tsx` (capacitaciones), y
// las otras cuatro vistas sí tienen estado de error pero tampoco tienen reintento. Aquí solo se
// cubre `/laft/unusual` porque es la vista que el AC4 nombra; el alcance real («¿1 vista o las 7?»)
// está declarado como ambigüedad en el HANDOFF, y el humano lo acotó a esta vista el 2026-08-22.
import { test, expect } from '../helpers/fixtures';
import { loginAs } from '../helpers/auth';
import { COMPLIANCE_LAFT_USER, VISTAS_LAFT } from '../helpers/laft-fixtures';

const INUSUALES = VISTAS_LAFT.find((v) => v.slug === 'laft_unusual')!;

test.describe('LAFT — inusuales: el 500 no puede leerse como «no hay» (HU #11275, AC4)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('AC4 [ROJO A PROPÓSITO] — un 500 muestra estado de ERROR, no el vacío', async ({ page }) => {
    // Rojo esperado: documenta el defecto (Bug radicado aparte). `test.fail()` mantiene el CI
    // en verde y sigue siendo guardián: se pondrá ROJO el día que se corrija y no se quite esto.
    test.fail();
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
    expect(peticiones, 'el mock del 500 no llegó a interceptar nada').toContain(INUSUALES.ruta_api);
    await expect(page.getByText(/^Cargando\.\.\.$/)).toHaveCount(0);

    // 1 · La afirmación central: un backend caído NO puede decir «no hay operaciones inusuales».
    await expect(
      page.getByText('Sin operaciones registradas'),
      'un 500 se está pintando como estado VACÍO: «no hay señales» y «no pude leer las señales» son conclusiones opuestas',
    ).toHaveCount(0);

    // 2 · Y lo que sí tiene que haber: el cuarto estado, con su mensaje y su salida.
    await expect(page.getByRole('alert')).toContainText(/no se pudo cargar/i);
    await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible();
  });

  test('AC4 [ROJO A PROPÓSITO] — «Reintentar» vuelve a consultar y recupera la vista', async ({ page }) => {
    // Rojo esperado: documenta el defecto (Bug radicado aparte). `test.fail()` mantiene el CI
    // en verde y sigue siendo guardián: se pondrá ROJO el día que se corrija y no se quite esto.
    test.fail();
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
  });
});
