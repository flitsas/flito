// LAFT — la ÚNICA descarga que el módulo tiene hoy: el PDF del Manual SARLAFT (HU #11275).
//
// ██ LEER ANTES DE DAR EL AC2 POR CUBIERTO ██
//
// El AC2 dice: «Dado un usuario en el **dashboard** LAFT … cuando ejecuta la **exportación
// regulatoria** disponible». Eso, hoy, no existe:
//
//   · `LaftDashboard.tsx` es de solo lectura: cuatro tarjetas de indicadores, sin un control de
//     exportación. Tampoco lo tiene `Laft.tsx` ni ninguna de las otras cinco vistas.
//   · La exportación regulatoria DE VERDAD sí existe, pero solo en el API:
//     `apps/api/src/modules/laft/sirel/ros-export.routes.ts` publica `POST /:id/export`,
//     `GET /:id/export/pdf` y `GET /:id/export/csv` (el ROS al SIREL de la UIAF). Ninguna página del
//     frontend la consume: el único rastro del ROS en la web es una palabra clave del buscador
//     (`components/shell/navItems.ts:121`). No hay pantalla que disparar.
//   · La única `api.download` del módulo entero es `LaftManual.tsx:44`, y es la que se prueba aquí.
//
// Así que **el AC2 tal y como está escrito queda SIN CUBRIR**, y no se cubre inventando un botón:
// añadir una exportación al tablero es código de producción nuevo y una decisión de alcance del
// humano. Lo que este archivo aporta es la cobertura de la descarga que sí existe, que además es
// documento regulatorio (el manual vigente es la referencia oficial del SARLAFT).
//
// Un límite más, y conviene decirlo: en el camino feliz **la UI no confirma nada**. `descargarPdf`
// solo avisa cuando FALLA; si va bien, la única señal es la descarga del navegador. La mitad
// «la UI confirma el resultado» del AC2 solo se cumple, hoy, en el caso de error.
import { test, expect } from '../helpers/fixtures';
import { loginAs } from '../helpers/auth';
import { instrumentarObjectUrls, leerUrls } from '../helpers/object-urls';
import { COMPLIANCE_LAFT_USER, VISTAS_LAFT, mockVista } from '../helpers/laft-fixtures';

const MANUAL = VISTAS_LAFT.find((v) => v.slug === 'laft_manual')!;
/** El id y la versión del fixture: el nombre del archivo se compone con la VERSIÓN, no con el id. */
const MANUAL_ID = 9301;
const MANUAL_VERSION = 7;
const PDF_URL = `**/api/laft/manual/${MANUAL_ID}/pdf`;
const PDF_PATH = `/api/laft/manual/${MANUAL_ID}/pdf`;
/** `%PDF-` es lo que hace que `request()` devuelva un blob y no intente parsear JSON… junto al CT. */
const CUERPO_PDF = '%PDF-1.4 fixture sintético HU 11275';

test.describe('LAFT — descarga del Manual SARLAFT (HU #11275, AC2 parcial)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('AC2 (desplazado) — el PDF del manual se descarga con el nombre de SU versión', async ({ page }) => {
    await loginAs(page, COMPLIANCE_LAFT_USER);
    await instrumentarObjectUrls(page);
    await mockVista(page, MANUAL);

    const peticiones: string[] = [];
    await page.route(PDF_URL, async (route) => {
      peticiones.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      await route.fulfill({ status: 200, contentType: 'application/pdf', body: CUERPO_PDF });
    });

    await page.goto(MANUAL.ruta);
    await expect(page.getByRole('heading', { level: 1, name: MANUAL.titulo, exact: true })).toBeVisible();

    const [descarga] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'PDF' }).click(),
    ]);

    // 1 · Se pidió el PDF de ESA versión, por su id. Un botón cableado a la fila equivocada
    //     entregaría un manual que no es el vigente, y eso en una inspección es un hallazgo.
    expect(peticiones).toEqual([`GET ${PDF_PATH}`]);
    // 2 · El nombre del archivo lo compone el cliente con la VERSIÓN (no con el id): es lo que
    //     distingue «manual-sarlaft-v7.pdf» de «manual-sarlaft-v9301.pdf».
    expect(descarga.suggestedFilename()).toBe(`manual-sarlaft-v${MANUAL_VERSION}.pdf`);

    // 3 · Y la mecánica de entrega es la sana: se creó un object URL y se revocó CEDIENDO el turno,
    //     no en la misma vuelta síncrona del clic (HU #11652). Revocar antes de que la descarga
    //     haya leído el blob la deja sin origen; es una carrera, no un fallo determinista, así que
    //     solo se caza midiéndola.
    const urls = await leerUrls(page);
    expect(urls.creados).toHaveLength(1);
    expect(urls.revocadosEnElMismoTurno, 'el object URL se revocó en la misma vuelta del clic').toBe(0);
    await expect.poll(() => leerUrls(page).then((u) => u.revocados.length)).toBe(1);
  });

  test('AC2 (desplazado) — si el PDF falla, la UI lo dice y NO entrega archivo', async ({ page }) => {
    await loginAs(page, COMPLIANCE_LAFT_USER);
    await instrumentarObjectUrls(page);
    await mockVista(page, MANUAL);
    await page.route(PDF_URL, (route) => route.fulfill({
      status: 500, contentType: 'application/json', body: '{"error":"Fallo sintético al generar el PDF"}',
    }));

    await page.goto(MANUAL.ruta);
    await page.getByRole('button', { name: 'PDF' }).click();

    // Esta es la ÚNICA confirmación de resultado que la pantalla da hoy: la del fallo.
    await expect(page.getByText('Fallo sintético al generar el PDF')).toBeVisible();
    // Y sobre todo: no se entrega un archivo con un JSON de error dentro y extensión `.pdf`.
    expect((await leerUrls(page)).creados).toEqual([]);
  });
});
