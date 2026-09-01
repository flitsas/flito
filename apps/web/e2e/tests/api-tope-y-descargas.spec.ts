// FLITO — `src/lib/api.ts`: el tope de tiempo y la entrega de archivos (HU #11652, AC1 y AC2).
//
// Este archivo no cubre una pantalla: cubre el módulo por el que pasan TODAS. Lo conduce desde dos
// páginas cualesquiera —Vehículos y Trámites— porque las dos formas de descargar que quedaban sin
// red (`api.download` y `api.downloadPost`) se usan desde ahí, no porque el asunto sea de ellas.
//
// ── AC1 · el tope tiene que tapar también el CUERPO ────────────────────────────────────────────
//
// `fetch` resuelve en cuanto llegan las CABECERAS; el cuerpo se lee después (`res.json()`,
// `res.blob()`). Con el `clearTimeout` en el `finally` del `fetch`, un servidor que responde 200 y
// luego se queda a medias dejaba la promesa colgada para SIEMPRE: sin abort, sin error, sin los
// cuatro estados de la vista — el spinner girando hasta que alguien recargue.
//
// Por eso el mock de estos dos tests **no es un `route.fulfill`**: un fulfill entrega el cuerpo
// entero de una vez y no puede reproducir el caso. Se levanta un servidor HTTP de verdad que
// escribe cabeceras y un mordisco de cuerpo y nunca llama a `end()`, y se le desvía la petición con
// `route.continue({ url })`. Es la única forma de que el fallo que se persigue exista en el test.
//
// El reloj SÍ se acelera (`acelerarElTope`): el tope real son 90 s y el test dura 30. Lo único
// simulado es cuánto se espera; el abort, el rechazo del stream y su traducción a `ApiError` son los
// de producción. Y se comprueba que la aceleración ocurrió, para que un día en que deje de casar el
// test falle diciéndolo en vez de agotarse en silencio.
//
// ── Por qué se espera el `response` antes de afirmar el mensaje ────────────────────────────────
//
// Un abort esperando CABECERAS y un abort leyendo el CUERPO producen el mismo `ApiError(0, …)` y el
// mismo copy en pantalla: el mensaje solo NO basta para saber cuál de los dos ocurrió. Sin más, la
// capacidad de discriminación del test se apoyaría en un supuesto de tiempo —que 700 ms sea mucho
// más que el ida y vuelta de cabeceras contra `127.0.0.1`—, y en un runner cargado ese supuesto se
// rompe: el corte caería en la fase del `fetch`, el código SIN el arreglo daría exactamente el mismo
// mensaje y el test se pondría verde sin haber ejercido nunca el reloj sobre el cuerpo. Con
// `retries: 2` en CI, un rojo por esa vía se reintenta hasta parecer sano.
//
// Por eso se espera el `response` del recurso estancado ANTES de afirmar el mensaje del tope
// (`cabecerasDelEstancado`). Playwright emite ese evento con el estado y las cabeceras, sin esperar
// al cuerpo — comprobado contra este mismo servidor, que nunca llama a `end()`. Si el evento llegó y
// solo DESPUÉS apareció el error, el corte fue en el cuerpo POR CONSTRUCCIÓN, en cualquier máquina y
// con cualquier reloj.
//
// ── AC2 · liberar el object URL DESPUÉS de la descarga ─────────────────────────────────────────
//
// `download` y `downloadPost` revocaban en la misma vuelta síncrona del `a.click()`. En Chromium
// suele funcionar —la descarga queda registrada durante el despacho del clic— y por eso no se
// notaba: es una carrera, no un fallo. `downloadPostNamed` ya cedía el turno desde la #11561; estos
// dos se migraron a la misma función en la #11652.
//
// Lo que se mide es `revocadosEnElMismoTurno` y NO solo `revocadosEnElClic`: la revocación antigua
// caía en la línea siguiente al clic, ya fuera de su despacho, así que contar solo el despacho deja
// pasar el defecto entero. Ver `helpers/object-urls.ts`, donde está el hallazgo por mutación.
//
// Los datos son SINTÉTICOS.
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER, OPERACIONES_USER } from '../helpers/auth';
import { instrumentarObjectUrls, leerUrls } from '../helpers/object-urls';

/** El copy del tope, tal y como `api.ts` lo entrega a la pantalla. */
const MENSAJE_TOPE = 'La consulta tardó demasiado. Intente de nuevo.';

const CUERPO_XLSX = 'PKFLITO-E2E-XLSX';
const CUERPO_ZIP = 'PKFLITO-E2E-ZIP';
const CT_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ────────────────────── El servidor que responde cabeceras y se queda a medias ──────────────────

let servidor: Server;
let puerto = 0;

test.beforeAll(async () => {
  servidor = createServer((req, res) => {
    // La clase la decide la ruta: `archivo` sale por la rama del blob de `request()`, `json` por la
    // del `res.json()`. Las dos son lecturas de cuerpo y las dos estaban sin reloj.
    const esArchivo = (req.url ?? '').includes('archivo');
    res.writeHead(200, { 'content-type': esArchivo ? 'application/zip' : 'application/json' });
    // Un mordisco de cuerpo y ni un byte más: nunca se llama a `res.end()`.
    res.write(esArchivo ? 'PK' : '{"items"');
  });
  await new Promise<void>((listo) => { servidor.listen(0, '127.0.0.1', listo); });
  puerto = (servidor.address() as AddressInfo).port;
});

test.afterAll(async () => {
  servidor.closeAllConnections();
  await new Promise((cerrado) => { servidor.close(cerrado); });
});

/** La URL a la que se desvía cada clase de cuerpo. Es la que Playwright reporta en el `response`. */
const urlEstancada = (clase: 'json' | 'archivo') => `http://127.0.0.1:${puerto}/${clase}`;

/** Desvía lo que case con `glob` al servidor estancado. La petición es real; el cuerpo no termina. */
const estancar = (page: Page, glob: string, clase: 'json' | 'archivo') => page.route(
  glob,
  (route) => route.continue({ url: urlEstancada(clase) }),
);

/**
 * Resuelve cuando llegan las CABECERAS del recurso estancado — no cuando termina su cuerpo, que en
 * este servidor no termina nunca.
 *
 * Se compara la URL COMPLETA del desvío y no un fragmento del endpoint original: `…/tramites` es
 * prefijo de `…/tramites/facetas`, que sí se sirve entera, y un predicado laxo daría por cumplida la
 * espera con una respuesta que no es la estancada.
 */
const cabecerasDelEstancado = (page: Page, clase: 'json' | 'archivo') => page.waitForResponse(
  (res) => res.url() === urlEstancada(clase),
);

/**
 * Acorta SOLO los temporizadores largos, que en la app son el tope de `api.ts` y ningún otro.
 *
 * Se instala antes de que cargue la app y devuelve el `id` del temporizador real, para que el
 * `clearTimeout` de `request()` siga apagándolo igual que en producción — si no, el test no podría
 * distinguir «no se apaga demasiado pronto» de «no se apaga nunca».
 */
async function acelerarElTope(page: Page, ms = 700) {
  await page.addInitScript((corto) => {
    const w = window as unknown as { __topesAcelerados: number };
    w.__topesAcelerados = 0;
    const original = window.setTimeout;
    window.setTimeout = ((cb: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (typeof delay === 'number' && delay >= 60000) {
        w.__topesAcelerados += 1;
        return original(cb, corto, ...args);
      }
      return original(cb, delay, ...args);
    }) as typeof window.setTimeout;
  }, ms);
}

const topesAcelerados = (page: Page) => page.evaluate(
  () => (window as unknown as { __topesAcelerados: number }).__topesAcelerados,
);

// ─────────────────────────────────────── Fixtures de página ─────────────────────────────────────

const TRAMITE_CON_FACTURA = {
  fechaCreacion: '2026-08-01T12:00:00Z',
  tramiteId: 'aaaaaaaa-0000-0000-0000-000000000002', idFlit: 'FLIT-1002', estado: 'Asignado', asignado: true,
  tipoTramite: 'Traspaso', ciudad: 'Pereira', empresaExiste: true, empresaNit: '900222', secretariaEmparejada: true,
  transitoNombre: 'STT Pereira', facturaVentaFlitId: 'fac-xyz',
  companiaNombre: 'Concesionario Sur', organismoNombre: 'STT Pereira',
  vehiculo: { vin: 'VIN0000000000002', placa: 'XYZ789', marca: 'Renault', linea: 'Kwid' },
  compradorPrincipal: { nombreCompleto: 'Luis Gómez', numeroDocumento: '20202020', correo: null },
  compradores: [{ nombreCompleto: 'Luis Gómez', numeroDocumento: '20202020' }],
  soat: { id: 's2', estado: 'pagado', proveedorSoatNombre: 'Seguros Alfa', valorPagado: 450000 },
  excepcionesAutogestion: [],
  soatAutogestionado: false,
  impuesto: { id: 'i2', estado: 'pagado', tieneFacturaVenta: true, valorPagado: 120000 },
  listoParaEntregar: true,
};

const VEHICULO = {
  id: 501, vin: 'VIN00DESCARGA0001', plate: 'DES001', ownerName: 'Propietario Descarga E2E',
  ownerDocument: '80012345', brand: 'Renault', model: 'Kangoo', year: 2022, vehicleClass: 'AUTOMOVIL',
  stage: 'soat_pendiente', clientId: null, taxPaid: true, soatStatus: 'pendiente', policyNumber: null,
  insurer: null, expiryDate: null, multasEstado: 'no_consultado' as const, multasTotal: null,
  multasCount: null, multasConsultadoAt: null, createdAt: '2026-06-01T12:00:00Z',
};

/** Los tres endpoints que pinta la página de Trámites. El listado se sirve salvo que se estanque. */
async function mockTramites(page: Page) {
  await page.route(/\/api\/flito\/parametrizacion\/proveedores-soat/, (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '[]',
  }));
  await page.route(/\/api\/flito\/tramites\/facetas/, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ estados: ['Asignado'], tramites: ['Traspaso'], ciudades: ['Pereira'], transitos: ['STT Pereira'] }),
  }));
  await page.route(/\/api\/flito\/tramites\?/, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ items: [TRAMITE_CON_FACTURA], total: 1, page: 1, pageSize: 50 }),
  }));
}

async function mockVehiculos(page: Page) {
  await page.route('**/api/vehicles**', (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname.endsWith('/api/vehicles')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([VEHICULO]) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}

// ════════════════ AC1 — el tope tapa la lectura del cuerpo, no solo las cabeceras ═══════════════

test.describe('api.ts — el tope de tiempo cubre el CUERPO de la respuesta (HU #11652, AC1)', () => {
  test('AC1 — un cuerpo JSON que se estanca acaba en el error del tope, no en un spinner eterno', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await acelerarElTope(page);
    await mockTramites(page);
    // Después del mock del listado: Playwright evalúa las rutas en orden inverso al de registro, así
    // que esta gana y es la que se estanca.
    await estancar(page, /\/api\/flito\/tramites\?/, 'json');

    // Las cabeceras del listado estancado tienen que haber llegado ANTES de mirar la pantalla: es lo
    // que fija que el corte que se afirma abajo ocurrió leyendo el CUERPO y no esperando el 200.
    await Promise.all([
      cabecerasDelEstancado(page, 'json'),
      page.goto('/flito/tramites'),
    ]);

    // El guardián va ANTES de la aserción de visibilidad: si el tope de `api.ts` deja de casar con el
    // acelerador, el test tiene que fallar diciendo eso y no con un «waiting for getByText».
    expect(await topesAcelerados(page), 'el tope de api.ts dejó de casar con el acelerador').toBeGreaterThan(0);
    // Con el `clearTimeout` en el `finally` del `fetch`, este texto no llega NUNCA: el 200 ya se
    // recibió, el reloj ya se apagó y `res.json()` espera un cuerpo que no va a terminar.
    await expect(page.getByText(MENSAJE_TOPE)).toBeVisible();
  });

  test('AC1 — un cuerpo de ARCHIVO que se estanca también corta, y lo dice en la pantalla', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await acelerarElTope(page);
    await mockTramites(page);
    // La HU #11910 retiró «Descargar facturas (zip)» y su endpoint; el ZIP de esta pantalla es ahora
    // `/flito/tramites/soportes/zip`, servido por `downloadPostNamed`. Lo que este caso mide —que el
    // tope tape la lectura del CUERPO de un archivo— no cambia de sujeto: cambia de ruta.
    await estancar(page, '**/api/flito/tramites/soportes/zip', 'archivo');

    await page.goto('/flito/tramites');
    await page.getByLabel('Seleccionar XYZ789').check();
    await page.getByRole('button', { name: 'Descargar soportes (1)' }).click();
    await Promise.all([
      cabecerasDelEstancado(page, 'archivo'),
      page.getByRole('dialog').getByRole('button', { name: 'Descargar', exact: true }).click(),
    ]);

    expect(await topesAcelerados(page), 'el tope de api.ts dejó de casar con el acelerador').toBeGreaterThan(0);
    // La rama del blob es la MÁS expuesta: un ZIP puede tardar minutos en el servidor, así que es
    // donde más probable es que las cabeceras salgan mucho antes que el último byte. Y aquí ya se
    // sabe que salieron: el `response` de arriba llegó con el zip a medio escribir.
    //
    // El copy es el de `avisoDeError` para `status === 0`, que la #11910 reutiliza tal cual: el
    // `ApiError(0, …)` que produce el tope es el mismo objeto, solo que lo viste otra banda.
    await expect(page.getByText('El archivo tardó demasiado en generarse. Vuelve a intentarlo con un filtro más estrecho.')).toBeVisible();
  });
});

// ═════════════ AC2 — `download` y `downloadPost` liberan el object URL DESPUÉS ══════════════════

test.describe('api.ts — la entrega de archivos libera el object URL después (HU #11652, AC2)', () => {
  test('AC2 — `api.download`: el archivo llega entero y nada se revoca dentro del clic', async ({ page }) => {
    await loginAs(page, ADMIN_USER);
    await instrumentarObjectUrls(page);
    await mockVehiculos(page);
    await page.route('**/api/vehicles/export**', (route) => route.fulfill({
      status: 200,
      contentType: CT_XLSX,
      body: CUERPO_XLSX,
    }));

    await page.goto('/vehicles');
    const [descarga] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Exportar', exact: true }).click(),
    ]);

    // El nombre lo pone el llamador en esta forma de descargar (a diferencia de `downloadPostNamed`).
    expect(descarga.suggestedFilename()).toBe('vehiculos.xlsx');
    // Que el contenido llegue es lo que prueba que liberar no dejó al blob sin origen: un revoke
    // demasiado pronto da un archivo vacío o una descarga fallida, no un error visible.
    expect(await readFile(await descarga.path(), 'utf8')).toBe(CUERPO_XLSX);

    // `expect.poll` y no un assert inmediato: la liberación es deliberadamente de la vuelta
    // siguiente, y exigirla ya empujaría a devolverla al despacho del clic — la carrera a cerrar.
    await expect.poll(async () => (await leerUrls(page)).revocados.length).toBe(1);
    const urls = await leerUrls(page);
    expect(urls.creados).toHaveLength(1);
    expect(urls.revocados).toEqual(urls.creados);
    expect(urls.revocadosEnElClic, 'se revocó en el mismo despacho del clic').toBe(0);
    expect(urls.revocadosEnElMismoTurno, 'se revocó en la misma vuelta síncrona del clic').toBe(0);
  });

  /**
   * **Cambió de sujeto con la HU #11910 y hay que decirlo:** hasta esa HU este caso entraba por
   * `api.downloadPost` —el viejo «Descargar facturas (zip)»— y desde ella entra por
   * `downloadPostNamed`, que es lo que consume el ZIP de soportes. Lo que se mide no se ha movido:
   * las tres formas de descargar comparten `entregarArchivo`, y la carrera del `revokeObjectURL` vive
   * ahí. **Deuda declarada:** `api.downloadPost` conserva dos llamadores (los expedientes de
   * traspaso) y esta suite ya no los ejercita; recuperar esa entrada es alcance de otra HU.
   */
  test('AC2 — `api.downloadPostNamed`: mismo trato para el zip de soportes', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await instrumentarObjectUrls(page);
    await mockTramites(page);
    await page.route('**/api/flito/tramites/soportes/zip', (route) => route.fulfill({
      status: 200,
      contentType: 'application/zip',
      body: CUERPO_ZIP,
    }));

    await page.goto('/flito/tramites');
    await page.getByLabel('Seleccionar XYZ789').check();
    await page.getByRole('button', { name: 'Descargar soportes (1)' }).click();
    const [descarga] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('dialog').getByRole('button', { name: 'Descargar', exact: true }).click(),
    ]);

    // Sin `Content-Disposition` en el mock, el nombre es el RESPALDO del cliente: nunca uno inventado
    // con la hora del equipo de quien descarga.
    expect(descarga.suggestedFilename()).toBe('soportes.zip');
    expect(await readFile(await descarga.path(), 'utf8')).toBe(CUERPO_ZIP);

    await expect.poll(async () => (await leerUrls(page)).revocados.length).toBe(1);
    const urls = await leerUrls(page);
    expect(urls.creados).toHaveLength(1);
    expect(urls.revocados).toEqual(urls.creados);
    expect(urls.revocadosEnElClic, 'se revocó en el mismo despacho del clic').toBe(0);
    expect(urls.revocadosEnElMismoTurno, 'se revocó en la misma vuelta síncrona del clic').toBe(0);
  });
});
