// LAFT — contrapartes y capacitaciones cuando el backend falla (Bug #11768).
//
// Hermano de `laft-unusual-error.spec.ts`. Aquel cubría solo `/laft/unusual` porque era la vista
// que nombraba el AC4 de la HU #11275, pero el defecto era IDÉNTICO en otras dos: el `catch` del
// listado se contaba con un `toast.error` que se desvanece y dejaba `data` vacío, así que el estado
// PERSISTENTE de la pantalla afirmaba que no hay registros. Corregir una sola vista habría dejado
// el Bug medio cerrado, y sin este archivo las otras dos quedarían sin red: `ci.yml` no corre e2e y
// el único sitio donde Playwright se ejecuta es el smoke nocturno, que lleva lista FIJA de specs
// (por eso este archivo se añade también a `test:e2e:smoke` en `apps/web/package.json`).
//
// ── Por qué cada test lleva un sensor antes del aserto central ─────────────────────────────────
//
// El fixture base instala un catch-all que responde `200 []` a todo `/api/**`. Eso significa que un
// glob mal escrito NO rompe el test: la vista recibiría lista vacía, pintaría su estado vacío, y el
// aserto «no debe decir "sin registros"» fallaría por el motivo equivocado —o peor, un aserto mal
// planteado pasaría creyendo que probó algo—. Por eso cada test afirma primero, contra el
// `pathname` REAL de las peticiones, que el 500 salió de verdad. Ese aserto es el que separa
// «falla el sensor» de «falla la pantalla».
//
// ── Las dos direcciones ────────────────────────────────────────────────────────────────────────
//
// El tercer test de cada vista no es relleno: la corrección tocó justo la condición del estado
// vacío (`!loading && data.length === 0` pasó a `!loading && !error && data.length === 0`). Sin un
// test que exija que una respuesta 200 legítimamente vacía SIGA diciendo «Sin … registradas», la
// forma más fácil de poner en verde los otros dos es borrar el estado vacío, y nadie lo notaría.
//
// Los datos son SINTÉTICOS y se ven como tales (documentos 9000000xx, correos `example.invalid`).
// Ni un dato personal real entra en un spec — AGENTS.md, Ley 1581.
import { test, expect } from '../helpers/fixtures';
import { loginAs } from '../helpers/auth';
import { COMPLIANCE_LAFT_USER, VISTAS_LAFT, type VistaLaft } from '../helpers/laft-fixtures';

/**
 * Las dos vistas que el Bug #11768 corrige además de inusuales. Se toman de `VISTAS_LAFT` en vez de
 * repetir rutas y payloads aquí: el día que `/laft/trainings` deje de devolver un array pelado, se
 * arregla en el fixture y estos tests siguen diciendo la verdad.
 */
const LISTADOS: VistaLaft[] = ['laft', 'laft_trainings'].map(
  (slug) => VISTAS_LAFT.find((v) => v.slug === slug)!,
);

/** Frase del estado de error, tal como la pinta cada página. */
const TEXTO_ERROR = /no se pudo cargar/i;

/**
 * Afirmación de CONTEO de la cabecera — el agujero que tenía este spec y que encontró el gate.
 *
 * El aserto contra `vista.textoVacio` (`/Sin contrapartes registradas/`) exige el prefijo «Sin»,
 * así que **«0 total» lo atraviesa sin hacer ruido diciendo exactamente lo mismo**: el contador
 * vive en la cabecera, fuera del `<tbody>`, y bajo un 500 seguía afirmando cero a unos píxeles del
 * cartel de error. Un guardián que solo mira el cuerpo de la tabla no cubre el defecto que nombra.
 *
 * `null` en las vistas sin contador: la cabecera de capacitaciones es solo título y botón
 * (verificado en `LaftTrainings.tsx`), así que ahí no hay nada que afirmar de más.
 */
const CONTEO_CABECERA: Record<string, RegExp | null> = {
  laft: /^\d+\s+total$/,
  laft_trainings: null,
};

for (const vista of LISTADOS) {
  test.describe(`LAFT — ${vista.titulo}: un 500 no puede leerse como «no hay» (Bug #11768)`, () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('un 500 muestra estado de ERROR, no el vacío', async ({ page }) => {
      await loginAs(page, COMPLIANCE_LAFT_USER);
      const peticiones: string[] = [];
      await page.route(vista.endpoint, async (route) => {
        peticiones.push(new URL(route.request().url()).pathname);
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: `Fallo sintético del listado (${vista.slug})` }),
        });
      });

      await page.goto(vista.ruta);
      await expect(page.getByRole('heading', { level: 1, name: vista.titulo, exact: true })).toBeVisible();
      // Sensor: si el glob fallara, el catch-all respondería `200 []` y el vacío sería legítimo.
      // Va con `expect.poll` y no con un `expect` pelado a propósito: el `<h1>` lo pinta
      // `PageHeaderCard` FUERA de todo condicional de carga, así que «encabezado visible» sucede
      // antes de que la petición llegue a interceptarse. Con el aserto instantáneo esto falla
      // ~1 de cada 8 corridas con `Received array: []` (medido con `--repeat-each`), que es un
      // guardián que miente por temporización, no por el estado de la pantalla.
      await expect.poll(
        () => peticiones,
        { message: 'el mock del 500 no llegó a interceptar nada' },
      ).toContain(vista.ruta_api);
      await expect(page.getByText(/^Cargando\.\.\.$/)).toHaveCount(0);

      // 1 · La afirmación central: un backend caído NO puede afirmar que no hay registros.
      await expect(
        page.getByText(vista.textoVacio),
        'un 500 se está pintando como estado VACÍO: «no hay» y «no pude leer» son conclusiones opuestas',
      ).toHaveCount(0);

      // 2 · Y lo que sí tiene que haber: el cuarto estado, con su mensaje y su salida.
      await expect(page.getByRole('alert')).toContainText(TEXTO_ERROR);
      await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible();

      // 3 · Y la cabecera tampoco puede seguir contando. Ver `CONTEO_CABECERA`: sin esto, quitar el
      //     `!error` del contador deja la pantalla diciendo «0 total» bajo el cartel de error y
      //     ninguno de los asertos de arriba se entera.
      const conteo = CONTEO_CABECERA[vista.slug];
      if (conteo) {
        await expect(
          page.getByText(conteo),
          'la cabecera sigue afirmando un conteo bajo un 500: es el defecto del Bug, dicho fuera de la tabla',
        ).toHaveCount(0);
      }
    });

    test('«Reintentar» vuelve a consultar y recupera la vista', async ({ page }) => {
      await loginAs(page, COMPLIANCE_LAFT_USER);
      // Falla la PRIMERA vez y responde bien a partir de la segunda: es el escenario real de un
      // backend que se cayó un momento, y el único que prueba que el reintento sirve para algo.
      let intentos = 0;
      await page.route(vista.endpoint, async (route) => {
        intentos += 1;
        if (intentos === 1) {
          await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Fallo sintético"}' });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(vista.cuerpo),
        });
      });

      await page.goto(vista.ruta);
      const reintentar = page.getByRole('button', { name: 'Reintentar' });
      await expect(reintentar).toBeVisible();

      await reintentar.click();

      // El reintento consulta de nuevo (no repinta desde memoria)…
      await expect.poll(() => intentos).toBeGreaterThan(1);
      // …y la vista queda CARGADA: el error desaparece y el dato del fixture está.
      await expect(page.getByText(vista.textoCargado).first()).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(reintentar).toHaveCount(0);
    });

    test('una respuesta vacía LEGÍTIMA sigue mostrando el estado vacío, no un error', async ({ page }) => {
      await loginAs(page, COMPLIANCE_LAFT_USER);
      const peticiones: string[] = [];
      await page.route(vista.endpoint, async (route) => {
        peticiones.push(new URL(route.request().url()).pathname);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(vista.cuerpoVacio),
        });
      });

      await page.goto(vista.ruta);
      await expect(page.getByRole('heading', { level: 1, name: vista.titulo, exact: true })).toBeVisible();
      await expect.poll(
        () => peticiones,
        { message: 'el mock del 200 vacío no llegó a interceptar nada' },
      ).toContain(vista.ruta_api);
      await expect(page.getByText(/^Cargando\.\.\.$/)).toHaveCount(0);

      // La otra dirección: separar error de vacío no puede haberse llevado por delante el vacío.
      await expect(page.getByText(vista.textoVacio)).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);

      // Control positivo del aserto de conteo del test del 500: allí se exige que NO esté, y un
      // `toHaveCount(0)` pasa igual de bien si el selector nunca acertó. Aquí se exige que SÍ esté
      // —un cero legítimo es un dato, y el contador debe seguir dándolo—, así que el día que el
      // microcopy cambie («0 total» → «0 contrapartes») este test se cae y delata al otro.
      const conteo = CONTEO_CABECERA[vista.slug];
      if (conteo) await expect(page.getByText(conteo)).toBeVisible();
    });
  });
}
