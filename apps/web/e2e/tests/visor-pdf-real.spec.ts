// HU #11774 — el primer E2E del repositorio que abre un PDF DE VERDAD.
//
// ── Qué agujero tapa ──────────────────────────────────────────────────────────────────────────
//
// El visor de soportes (`components/flit/VisorPdf.tsx`) rasteriza cada página con pdf.js y la pinta
// como PNG en un `<img>`. Hasta esta HU, la cobertura E2E de ese camino era CERO, y está medido: no
// existía `e2e/fixtures/`, ningún spec rasterizaba nada y de los diez que mockean `application/pdf`
// ninguno servía un cuerpo parseable —ocho mandan cadenas como `'%PDF-1.4 fake'` y dos solo declaran
// el content-type en un JSON, sin cuerpo—. El que más se acercaba (`flito-soat.spec.ts`) mockea la
// lista de soportes con `url: '/api/files?key=a'`, NUNCA mockea `/api/files` y solo comprueba el
// nombre del fichero en un botón: pasa en verde con el visor en estado de error. Es decir, el visor
// podía dejar de renderizar por completo sin que ninguna prueba se enterara.
//
// Este spec sirve el fixture como CUERPO de la respuesta y comprueba el resultado observable:
// tantos `<img>` como páginas tiene el documento, cada uno con bitmap decodificado
// (`naturalWidth > 0`) y con la geometría de la página real. No hay capa de texto ni miniaturas que
// mirar —el visor no las tiene—, así que el PNG rasterizado es LA evidencia.
//
// ── Por qué importa más allá de este spec ─────────────────────────────────────────────────────
//
// Es la primera pieza de la cadena #11774 → #11775 (worker con hash en el nombre) → #11289 (salto a
// pdfjs v6). El `workerSrc` del visor apunta a `/pdf.worker.min.js`, una ruta fija en `public/`: el
// día que ese fichero se sirva con hash, o cambie de sitio, o el major lo renombre, lo único capaz
// de ver el fallo es un test que cargue un PDF real y mire el bitmap. Comprobado por mutación (AC2):
// apuntando `GlobalWorkerOptions.workerSrc` a una ruta inexistente, este spec se pone rojo.
//
// ── Por qué se entra por Derechos de tránsito ─────────────────────────────────────────────────
//
// `VisorPdf` se abre desde cinco pantallas a través de `VisorSoportes`; se elige la de derechos por
// ser la de menor superficie de mock (listado + facetas) — lo que se mide aquí es el visor, no la
// pantalla que lo hospeda. Todos los datos son sintéticos: sin cédula, sin NIT, sin placa real y sin
// nombres de persona (Ley 1581 / AGENTS.md §14).
import { fileURLToPath } from 'node:url';
import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';

/** PDF sintético de dos páginas con fuente embebida. Se regenera con `fixtures/*.ps` (ver cabecera). */
const FIXTURE_PDF = fileURLToPath(new URL('../fixtures/soporte-dos-paginas.pdf', import.meta.url));

/** Ruta del soporte. Es la que sirve el PDF, y la que ningún spec anterior llegó a mockear. */
const URL_SOPORTE = '/api/files?key=e2e-soporte-dos-paginas';

const DERECHO = {
  id: 'd-e2e-1', tramiteId: 't-e2e-1', idFlit: 'FLIT-9001', placa: 'TST001', organismoCodigo: '05001',
  empresa: 'Concesionario de pruebas', valor: '236700.00', fechaPago: '2026-05-23',
  numeroRadicado: '9000000001', tipoTramiteRecibo: 'MATRICULA INICIAL', origen: 'manual',
  advertencias: null, soporteId: 'sop-e2e-1', createdAt: '2026-05-23T10:00:00Z',
  archivoOrigen: 'soporte-dos-paginas.pdf', paginas: null, procesamientoId: null, procesamientoArchivo: null,
};

const SOPORTES = [{
  id: 'sop-e2e-1', origen: 'derecho', tipo: 'derecho_tramite',
  nombreArchivo: 'soporte-dos-paginas.pdf', url: URL_SOPORTE, subidoEn: '2026-05-23T10:00:00Z',
}];

/** Listado + facetas: lo mínimo para que la fila con el botón «Ver todos» exista. */
async function mockPagina(page: import('@playwright/test').Page) {
  await page.route(/\/api\/flito\/derechos\/facetas/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ organismos: ['05001'], origenes: ['manual'] }),
  }));
  await page.route(/\/api\/flito\/derechos\?/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ items: [DERECHO], total: 1, page: 1, pageSize: 50 }),
  }));
  await page.route(/\/api\/finanzas\/tramites\/.*\/soportes/, (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(SOPORTES),
  }));
}

/** Abre el visor del trámite del fixture. Deja la pantalla en el estado que se va a medir. */
async function abrirVisor(page: import('@playwright/test').Page) {
  await page.goto('/flito/derechos');
  await page.getByRole('row', { name: /FLIT-9001/ }).getByRole('button', { name: 'Ver todos' }).click();
  await expect(page.getByText('Documentos de FLIT-9001')).toBeVisible();
}

/** Los `<img>` que pinta el visor. El `alt` es `«<nombre> — página N de M»`; nada más en la app lo lleva. */
const paginasPintadas = (page: import('@playwright/test').Page) => page.locator('img[alt*=" — página "]');

test.describe('Visor de PDF — rasterización de un documento real', () => {
  test('un PDF de dos páginas se rasteriza en dos imágenes con bitmap', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockPagina(page);

    // EL PUNTO DE LA HU: el fichero viaja como CUERPO de la respuesta, no como un content-type
    // declarado sobre una cadena que no es un PDF. `path` hace que Playwright lea el fixture del
    // disco en cada petición.
    let pdfsServidos = 0;
    await page.route(URL_SOPORTE, (route) => {
      pdfsServidos += 1;
      return route.fulfill({ status: 200, contentType: 'application/pdf', path: FIXTURE_PDF });
    });

    await abrirVisor(page);

    const paginas = paginasPintadas(page);
    await expect(paginas).toHaveCount(2);
    await expect(paginas.nth(0)).toHaveAttribute('alt', /página 1 de 2$/);
    await expect(paginas.nth(1)).toHaveAttribute('alt', /página 2 de 2$/);

    // `toHaveCount` solo dice que el `<img>` está en el DOM. Que el bitmap DECODIFIQUE es otra
    // afirmación: un data URL truncado, un canvas en blanco de 0×0 o un `src` vacío pasan lo
    // anterior y mueren aquí.
    await expect.poll(
      () => paginas.evaluateAll((els) => els.filter((e) => (e as HTMLImageElement).naturalWidth > 0).length),
      { message: 'las dos páginas deben decodificar a un bitmap con ancho real' },
    ).toBe(2);

    const medidas = await paginas.evaluateAll((els) => els.map((e) => {
      const img = e as HTMLImageElement;
      return { w: img.naturalWidth, h: img.naturalHeight, esPng: img.src.startsWith('data:image/png') };
    }));

    for (const [i, m] of medidas.entries()) {
      // Rasterizado por nosotros, no el PDF servido en crudo a un `<object>`: el `src` es el
      // `canvas.toDataURL('image/png')`. Si el visor volviera al visor nativo del navegador —el que
      // ejecuta el `/OpenAction … this.print()` de las facturas de SOAT— esto se cae.
      expect(m.esPng, `página ${i + 1}: el src debe ser un PNG rasterizado`).toBe(true);
      expect(m.w, `página ${i + 1}: ancho`).toBeGreaterThan(0);
      expect(m.h, `página ${i + 1}: alto`).toBeGreaterThan(0);
      // Geometría de la página real (612×792 pt, vertical). Un placeholder cuadrado o apaisado no
      // salió de este documento.
      expect(m.h, `página ${i + 1}: debe ser vertical como el documento`).toBeGreaterThan(m.w);
    }

    // Ninguno de los estados de error del visor está a la vista.
    await expect(page.getByText(/No se pudo (abrir|descargar) el documento/)).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Abrir en una pestaña nueva' })).toHaveCount(0);

    // El PDF se pidió de verdad. Si un día el visor cachea o deja de descargar, el conteo lo dice.
    expect(pdfsServidos).toBeGreaterThan(0);
  });

  test('un cuerpo que no es un PDF cae en el estado de error, no en una página en blanco', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockPagina(page);

    // La forma exacta que usan hoy los otros diez specs: content-type correcto, cuerpo que no es un
    // PDF. Se mantiene aquí a propósito, como control negativo del test anterior: demuestra que la
    // ausencia de error que aquel comprueba es una afirmación con contenido, y no algo que se cumple
    // porque la pantalla nunca enseña errores.
    await page.route(URL_SOPORTE, (route) =>
      route.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-1.4 fake' }));

    await abrirVisor(page);

    // pdf.js rechaza el documento; el visor enseña el motivo y la salida de emergencia.
    await expect(page.getByRole('link', { name: 'Abrir en una pestaña nueva' })).toBeVisible();
    await expect(paginasPintadas(page)).toHaveCount(0);
  });
});
