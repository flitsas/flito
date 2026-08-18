// FLITO — Comparendos: los cuatro estados del cascarón (HU #11559, AC5).
//
// El cascarón de esta HU no trae barra de filtros ni paginación: el vacío B («el filtro no arroja
// nada»), el reintento «con los mismos filtros» y el copy de `cursor_invalido` son de la HU del
// visor (#11560) y aquí no tienen sujeto. Lo que sí se prueba entero es el orden de resolución —el
// error ANTES que el vacío— y que el error del API se pinta sin exponer detalles internos, que es
// la mitad del AC5 que se rompe sin que nadie lo note.
//
// Los datos son SINTÉTICOS: el NIT «900123456» y la placa «ABC123» son de ejemplo. Ni un dato real
// entra en un spec, ni siquiera en un fixture (Ley 1581).
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';

const API_REGISTROS = '**/api/flito/comparendos/registros**';

const FILA = {
  id: '11111111-1111-4111-8111-111111111111',
  numeroComparendo: '11001000123456',
  nitMonitoreado: '900123456',
  placa: 'ABC123',
  codigoInfraccion: 'C29',
  descripcionInfraccion: 'Estacionar en zona prohibida',
  fechaComparendo: '2026-07-12',
  organismo: 'Secretaría de Movilidad de Medellín',
  municipioFuente: 'MEDELLIN',
  monto: '604100.00',
  estadoFuente: 'EN COBRO COACTIVO',
  origenMerge: 'ambos',
  vistoEnSimit: true,
  vistoEnMunicipal: true,
  estado: 'activo',
  primeraVistoEn: '2026-07-02T03:12:00Z',
  ultimoVistoEn: '2026-08-14T03:07:00Z',
  inactivadoEn: null,
  ultimoSyncRunId: null,
  causalId: null,
  observacion: null,
  gestionActualizadaEn: null,
  gestionActualizadaPor: null,
  creadoEn: '2026-07-02T03:12:00Z',
  actualizadoEn: '2026-08-14T03:07:00Z',
};

// Una segunda fila sin fecha y sin placa: `null` es información (hay fuentes que no las traen) y
// tiene que pintarse «—» sin romper la fila.
const FILA_SIN_FECHA = {
  ...FILA,
  id: '22222222-2222-4222-8222-222222222222',
  numeroComparendo: '05001000998877',
  placa: null,
  fechaComparendo: null,
  municipioFuente: null,
  estado: 'inactivo',
};

interface Respuesta { status: number; body: unknown }

/**
 * Mock por VALOR MUTABLE, no por cola de respuestas.
 *
 * En desarrollo React monta en `StrictMode` y el efecto corre dos veces, así que una cola
 * «primero 500, después 200» serviría el 200 a la segunda invocación del montaje y el test miraría
 * un estado que el usuario nunca ve. Con un valor mutable, todas las consultas de un mismo momento
 * responden lo mismo y es el test quien decide cuándo cambia.
 */
async function mockRegistros(page: Page, inicial: Respuesta) {
  const estado = { respuesta: inicial, llamadas: 0 };
  await page.route(API_REGISTROS, (route: Route) => {
    estado.llamadas += 1;
    return route.fulfill({
      status: estado.respuesta.status,
      contentType: 'application/json',
      body: JSON.stringify(estado.respuesta.body),
    });
  });
  return estado;
}

const PAGINA = { items: [FILA, FILA_SIN_FECHA], nextCursor: null };

test.describe('FLITO — Comparendos · cascarón (AC5)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('cargando: filas fantasma anunciadas, sin error y sin vacío', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    // Respuesta retenida: el estado de carga es observable porque nadie la suelta hasta el final.
    let soltar: (() => void) | null = null;
    const retenida = new Promise<void>((resolve) => { soltar = resolve; });
    await page.route(API_REGISTROS, async (route) => {
      await retenida;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PAGINA) });
    });

    await page.goto('/flito/comparendos');

    const cargando = page.getByRole('status', { name: 'Cargando comparendos' });
    await expect(cargando).toBeVisible();
    await expect(cargando).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText(/Todavía no hay comparendos registrados/)).toHaveCount(0);

    soltar?.();
    await expect(page.getByText('11001000123456')).toBeVisible();
    await expect(cargando).toHaveCount(0);
  });

  test('lleno: la tabla se pinta, los nulos son «—» y el contador no inventa un total', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockRegistros(page, { status: 200, body: PAGINA });

    await page.goto('/flito/comparendos');

    await expect(page.getByText('11001000123456')).toBeVisible();
    await expect(page.getByText('05001000998877')).toBeVisible();
    // El estado se lee por su etiqueta, no por el color del punto.
    await expect(page.getByText('Activo', { exact: true })).toBeVisible();
    await expect(page.getByText('Inactivo', { exact: true })).toBeVisible();
    await expect(page.getByText('—', { exact: true })).toBeVisible();

    // El API pagina por cursor y NO devuelve total: el contador no puede decir «de N».
    const contador = page.getByText(/comparendos en esta página/);
    await expect(contador).toBeVisible();
    await expect(contador).not.toContainText(/\bde \d/);
  });

  test('vacío: explica por qué no hay nada todavía y no ofrece una acción que no existe', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockRegistros(page, { status: 200, body: { items: [], nextCursor: null } });

    await page.goto('/flito/comparendos');

    await expect(page.getByText(/Todavía no hay comparendos registrados/)).toBeVisible();
    await expect(page.getByText(/sincronización con SIMIT/)).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    // Sin botón: la pantalla de sincronización todavía no existe en apps/web y un enlace a ninguna
    // parte es peor que ninguno.
    await expect(page.getByRole('button', { name: /sincroniz/i })).toHaveCount(0);
  });

  test('error 500: banda con reintento, y el reintento vuelve a consultar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const estado = await mockRegistros(page, {
      status: 500, body: { error: 'Error interno del módulo de comparendos' },
    });

    await page.goto('/flito/comparendos');

    const alerta = page.getByRole('alert');
    await expect(alerta).toContainText('No se pudieron cargar los comparendos');
    await expect(page.getByRole('status', { name: 'Cargando comparendos' })).toHaveCount(0);

    const antes = estado.llamadas;
    estado.respuesta = { status: 200, body: PAGINA };
    await page.getByRole('button', { name: 'Reintentar' }).click();

    await expect(page.getByText('11001000123456')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(estado.llamadas).toBeGreaterThan(antes);
  });

  test('el error borra la tabla anterior: no se afirma que unos datos viejos siguen valiendo', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    const estado = await mockRegistros(page, { status: 200, body: PAGINA });

    await page.goto('/flito/comparendos');
    await expect(page.getByText('11001000123456')).toBeVisible();

    estado.respuesta = { status: 500, body: { error: 'Error interno del módulo de comparendos' } };
    await page.reload();

    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByText('11001000123456')).toHaveCount(0);
  });

  test('el error se resuelve ANTES que el vacío: 500 con lista vacía es un error, no «no hay nada»', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockRegistros(page, { status: 500, body: { items: [], nextCursor: null } });

    await page.goto('/flito/comparendos');

    await expect(page.getByRole('alert')).toBeVisible();
    // Decir «no hay comparendos» tras una consulta fallida sería afirmar algo que nadie comprobó.
    await expect(page.getByText(/Todavía no hay comparendos registrados/)).toHaveCount(0);
  });

  test('403: el copy manda hablar con un administrador y NO ofrece reintentar', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockRegistros(page, { status: 403, body: { error: 'Sin permisos para esta operación' } });

    await page.goto('/flito/comparendos');

    await expect(page.getByRole('alert')).toContainText(/ya no tiene acceso a los comparendos/);
    // Reintentar un permiso que no se tiene es pedir que se repita algo que va a fallar igual.
    await expect(page.getByRole('button', { name: 'Reintentar' })).toHaveCount(0);
  });

  test('429: el copy explica el límite y el botón de reintentar sigue ahí', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await mockRegistros(page, { status: 429, body: { error: 'Demasiadas solicitudes' } });

    await page.goto('/flito/comparendos');

    await expect(page.getByRole('alert')).toContainText(/demasiadas consultas seguidas/i);
    // Esconderlo obligaría a recargar la página entera, que es otra petición.
    await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible();
  });

  // «Sin exponer detalles internos» (AC5) se prueba por lo que la pantalla NO dice, así que la
  // lista de cuerpos tiene que incluir los formatos que un filtro ingenuo deja pasar. Los tres
  // primeros son diagnóstico de máquina; los cuatro últimos son el caso que la spec de UX marca
  // como «a vigilar»: un identificador dentro del mensaje del servidor. Con separadores de miles y
  // dígito de verificación, que es como los escriben SIMIT y los organismos — y como NO los ve un
  // `\d{4,}`. Todos los valores son SINTÉTICOS (Ley 1581): ni un NIT, ni una cédula, ni una placa
  // reales entran en un spec.
  const CUERPOS_QUE_NO_SE_PINTAN: { caso: string; error: string; rastros: string[] }[] = [
    {
      caso: 'traza y nombre de tabla',
      error: 'error: relation "flito_comparendos_registros" does not exist\n'
        + '    at Parser.parseErrorMessage (/app/node_modules/pg-protocol/dist/parser.js:369:69)',
      rastros: ['flito_comparendos_registros', 'node_modules', 'pg-protocol', 'parser.js'],
    },
    {
      caso: 'host interno',
      error: 'Error de conexión a db-prod.interno.flitsas.io',
      rastros: ['db-prod', 'flitsas.io'],
    },
    {
      caso: 'IP de la red privada',
      error: 'connect ECONNREFUSED 10.8.0.5:80',
      rastros: ['ECONNREFUSED', '10.8.0.5'],
    },
    {
      caso: 'NIT sin formato',
      error: 'No se pudo consultar los comparendos del NIT 900123456',
      rastros: ['900123456'],
    },
    {
      caso: 'NIT con puntos y dígito de verificación',
      error: 'No se encontró el NIT 900.123.456-7',
      rastros: ['900.123.456', '900.123.456-7'],
    },
    {
      caso: 'cédula con separadores de miles',
      error: 'Sin resultados para la cédula 1.020.304.050',
      rastros: ['1.020.304.050'],
    },
    {
      caso: 'placa',
      error: 'Sin resultados para la placa ABC123',
      rastros: ['ABC123'],
    },
  ];

  for (const { caso, error, rastros } of CUERPOS_QUE_NO_SE_PINTAN) {
    test(`el 500 no hace eco del cuerpo del servidor — ${caso}`, async ({ page }) => {
      await loginAs(page, OPERACIONES_USER);
      await mockRegistros(page, {
        status: 500,
        body: { error, details: { stack: 'Error: boom\n at query (/app/src/db/client.ts:12:3)' } },
      });

      await page.goto('/flito/comparendos');

      // Se ve un error accionable…
      const alerta = page.getByRole('alert');
      await expect(alerta).toBeVisible();
      await expect(alerta).toContainText('No se pudieron cargar los comparendos');
      await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible();

      // …y nada de lo que dijo el servidor. Se mira el documento ENTERO, no solo la banda: un
      // atributo `title`, un `sr-only` o un tooltip contarían igual como fuga.
      const cuerpo = await page.locator('body').innerText();
      const html = await page.content();
      for (const rastro of rastros) {
        expect(cuerpo, `«${rastro}» visible en pantalla`).not.toContain(rastro);
        expect(html, `«${rastro}» presente en el DOM`).not.toContain(rastro);
      }
      expect(cuerpo).not.toContain('client.ts');
      // Y tampoco viaja en la dirección del navegador (AGENTS.md §14).
      for (const rastro of rastros) expect(page.url()).not.toContain(rastro);
    });
  }
});
