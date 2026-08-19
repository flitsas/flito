// FLITO — Comparendos · visor: accesibilidad (HU #11560, AC7).
//
// El AC7 pide «contraste según el mínimo del proyecto», y el contraste NO se comprueba leyendo el
// DOM: hace falta un motor que calcule el color efectivo de cada texto sobre su fondo real. El repo
// **no tiene `@axe-core/playwright`** y el único precedente (`pesv-diagnostico-a11y.spec.ts`) baja
// `axe.min.js` de un CDN detrás de una variable de entorno, degradando en silencio si no hay red.
// Un chequeo que puede no ejecutarse y aun así dejar el test en verde no certifica nada.
//
// Este archivo cierra ese hueco a medias, que es lo honesto mientras la dependencia no exista:
//   · `QA_AXE_PATH` apuntando a un `axe.min.js` en disco → inyección DETERMINISTA, sin red;
//   · si no, `QA_AXE_CDN=1` → se baja del CDN (reproducible solo con red);
//   · si no hay ninguna de las dos, el test se marca **`skip`** con su motivo. NUNCA verde falso.
//
// Lo que sí es determinista y no depende de nada de esto —etiquetas, recorrido de teclado, foco
// visible, `role="alert"`, `aria-live`— vive en los otros dos specs del módulo.
//
// La HU #11562 añade al final los CUATRO estados del panel de detalle. Es superficie nueva sobre
// `ModalPortal`, es decir colgada de `<body>`: hasta el Bug #11604 —que quitó el prefijo `.flit-app`
// de las reglas de foco justo por eso— sus controles no habrían tenido ni anillo de foco. Los cuatro
// se miden por separado porque los que rompen el contraste son el de ERROR (rojo sobre superficie
// clara) y el de GUARDANDO (controles inhabilitados), y ninguno de los dos está en pantalla cuando
// el panel se pintó bien.
import type { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, OPERACIONES_USER } from '../helpers/auth';

const AXE_PATH = process.env.QA_AXE_PATH;
const AXE_CDN = process.env.QA_AXE_CDN === '1'
  ? 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js'
  : null;

const API_REGISTROS = '**/api/flito/comparendos/registros**';
const CATALOGOS = [
  '**/api/flito/comparendos/municipios',
  '**/api/flito/comparendos/causales',
  '**/api/flito/comparendos/nits',
];

const REGISTRO_ID = '11111111-1111-4111-8111-111111111111';
const CAUSAL_ID = '453cc851-646e-4001-b936-6abe0b7a0570';

const FILA = {
  id: REGISTRO_ID,
  numeroComparendo: '11001000123456',
  nitMonitoreado: '900123456',
  placa: 'ABC123',
  codigoInfraccion: 'C29',
  descripcionInfraccion: 'Estacionar en zona prohibida',
  fechaComparendo: '2026-07-12',
  organismo: 'Secretaría de Movilidad de Medellín',
  municipioFuente: 'ITAGUI',
  monto: '604100.00',
  estadoFuente: 'EN COBRO COACTIVO',
  origenMerge: 'ambos',
  vistoEnSimit: true,
  vistoEnMunicipal: true,
  estado: 'activo',
  primeraVistoEn: '2026-08-17T03:12:00Z',
  ultimoVistoEn: '2026-08-18T08:07:00Z',
  inactivadoEn: null,
  ultimoSyncRunId: null,
  causalId: null,
  observacion: null,
  gestionActualizadaEn: null,
  gestionActualizadaPor: null,
  creadoEn: '2026-08-17T03:12:00Z',
  actualizadoEn: '2026-08-18T08:07:00Z',
};

interface Violacion { id: string; impact: string; nodes: number; help: string }

async function correrAxe(page: Page): Promise<Violacion[]> {
  if (AXE_PATH) await page.addScriptTag({ path: AXE_PATH });
  else if (AXE_CDN) await page.addScriptTag({ url: AXE_CDN });
  return page.evaluate(async () => {
    // @ts-expect-error axe se inyecta en tiempo de ejecución
    const r = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa'] },
    });
    return r.violations.map((v: { id: string; impact: string; nodes: unknown[]; help: string }) => ({
      id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help,
    }));
  });
}

async function pantalla(page: Page, body: unknown) {
  await loginAs(page, OPERACIONES_USER);
  for (const ruta of CATALOGOS) {
    await page.route(ruta, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  }
  await page.route(API_REGISTROS, (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(body),
  }));
  await page.goto('/flito/comparendos');
}

const EVENTOS = [
  { id: 'e1', tipo: 'gestion', syncRunId: null, detalle: { motivo: 'gestion_registrada' }, ocurridoEn: '2026-08-18T14:14:00Z' },
  { id: 'e2', tipo: 'inactivacion', syncRunId: null, detalle: { motivo: 'ausente_en_todas_las_fuentes' }, ocurridoEn: '2026-06-12T08:11:00Z' },
  { id: 'e3', tipo: 'primera_llegada', syncRunId: null, detalle: { origen: 'simit' }, ocurridoEn: '2026-05-02T08:12:00Z' },
];

const DETALLE = {
  ...FILA,
  causalId: CAUSAL_ID,
  observacion: 'Se envió copia al cliente.',
  gestionActualizadaEn: '2026-08-18T14:14:00Z',
  gestionActualizadaPor: { id: 7, nombre: 'María Ruiz' },
  eventos: EVENTOS,
};

/** Comprueba y deja constancia. Se imprimen TODAS las violaciones, también las leves. */
async function sinViolacionesGraves(page: Page, etiqueta: string) {
  const violaciones = await correrAxe(page);
  const graves = violaciones.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  console.log(`[QA a11y · ${etiqueta}] ${violaciones.length} violaciones: ${JSON.stringify(violaciones)}`);
  expect(graves, `violaciones serias/críticas en «${etiqueta}»: ${JSON.stringify(graves)}`).toEqual([]);
  expect(violaciones.filter((v) => v.id === 'color-contrast'), `contraste en «${etiqueta}»`).toEqual([]);
}

test.describe('FLITO — Comparendos · AC7 accesibilidad (HU #11560)', () => {
  test.use({ viewport: { width: 1600, height: 900 } });

  test.beforeEach(() => {
    test.skip(
      !AXE_PATH && !AXE_CDN,
      'axe no disponible: exporta QA_AXE_PATH=/ruta/axe.min.js (determinista) o QA_AXE_CDN=1. '
      + 'Se prefiere SALTAR antes que dar por certificado el contraste sin haberlo medido.',
    );
  });

  // Tres estados y no solo el feliz: el contraste que se rompe casi siempre es el del texto de
  // error (rojo sobre fondo claro) o el del control inhabilitado, y ninguno de los dos está en
  // pantalla cuando la tabla se pintó bien.
  const ESTADOS: { nombre: string; body: unknown; preparar?: (page: Page) => Promise<void> }[] = [
    { nombre: 'con datos', body: { items: [FILA], nextCursor: 'CURSOR-1' } },
    { nombre: 'vacío', body: { items: [], nextCursor: null } },
  ];

  for (const estado of ESTADOS) {
    test(`AC7/TC53 — axe sin violaciones serias ni críticas: ${estado.nombre}`, async ({ page }) => {
      await pantalla(page, estado.body);
      await expect(page.getByRole('button', { name: 'Buscar', exact: true })).toBeVisible();
      await estado.preparar?.(page);

      const violaciones = await correrAxe(page);
      const graves = violaciones.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      // Se imprimen TODAS —también las moderadas y menores— para que queden en la evidencia y no
      // se conviertan en deuda invisible.
      console.log(`[QA a11y · ${estado.nombre}] ${violaciones.length} violaciones: `
        + JSON.stringify(violaciones));
      expect(graves, `violaciones serias/críticas en «${estado.nombre}»: ${JSON.stringify(graves)}`)
        .toEqual([]);
      // El contraste se afirma aparte: es el que el AC7 nombra y el que un `impact` moderado
      // podría dejar pasar sin que nadie lo lea.
      expect(violaciones.filter((v) => v.id === 'color-contrast'), 'contraste del AC7').toEqual([]);
    });
  }

  test('AC7/TC53 — axe sobre el estado de ERROR, que es el que nadie mira', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    for (const ruta of CATALOGOS) {
      await page.route(ruta, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    }
    await page.route(API_REGISTROS, (r) => r.fulfill({
      status: 500, contentType: 'application/json', body: '{"error":"boom"}',
    }));
    await page.goto('/flito/comparendos');
    await expect(page.getByRole('alert')).toBeVisible();

    const violaciones = await correrAxe(page);
    const graves = violaciones.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    console.log(`[QA a11y · error] ${violaciones.length} violaciones: ${JSON.stringify(violaciones)}`);
    expect(graves, `violaciones serias/críticas en el estado de error: ${JSON.stringify(graves)}`).toEqual([]);
    expect(violaciones.filter((v) => v.id === 'color-contrast'), 'contraste del texto de error').toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// HU #11562 — los cuatro estados del PANEL de detalle.
//
// El panel cuelga de <body> por `ModalPortal`, así que axe lo ve entero sin nada especial. Lo que
// hace falta es MONTARLO en cada uno de sus cuatro estados, y para tres de ellos eso significa
// retener o romper una respuesta a propósito: cargando y guardando no duran lo suficiente con un
// mock instantáneo como para medirlos.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

const API_DETALLE = `**/api/flito/comparendos/registros/${REGISTRO_ID}`;
const API_GESTION = `**/api/flito/comparendos/registros/${REGISTRO_ID}/gestion`;

/** Deja la lista pintada con su fila y devuelve el botón que abre el panel. */
async function conLista(page: Page) {
  await pantalla(page, { items: [FILA], nextCursor: null });
  const abrir = page.getByRole('button', { name: `Ver el comparendo ${FILA.numeroComparendo}` });
  await expect(abrir).toBeVisible();
  return abrir;
}

test.describe('FLITO — Comparendos · panel de detalle: accesibilidad (HU #11562, AC8)', () => {
  test.use({ viewport: { width: 1600, height: 900 } });

  test.beforeEach(() => {
    test.skip(
      !AXE_PATH && !AXE_CDN,
      'axe no disponible: exporta QA_AXE_PATH=/ruta/axe.min.js (determinista) o QA_AXE_CDN=1. '
      + 'Se prefiere SALTAR antes que dar por certificado el contraste sin haberlo medido.',
    );
  });

  test('AC8/TC — panel CARGANDO: el esqueleto se anuncia y no rompe contraste', async ({ page }) => {
    let soltar = () => {};
    const retenido = new Promise<void>((r) => { soltar = r; });
    const abrir = await conLista(page);
    await page.route(API_DETALLE, async (r) => {
      await retenido;
      await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DETALLE) });
    });

    await abrir.click();
    await expect(page.getByRole('dialog').getByRole('status')).toHaveAttribute('aria-busy', 'true');
    await sinViolacionesGraves(page, 'panel cargando');
    soltar();
  });

  test('AC8/TC — panel con DATOS: el estado que todo el mundo mira', async ({ page }) => {
    const abrir = await conLista(page);
    await page.route(API_DETALLE, (r) => r.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(DETALLE),
    }));

    await abrir.click();
    await expect(page.getByRole('dialog')).toContainText('EN COBRO COACTIVO');
    await sinViolacionesGraves(page, 'panel con datos');
  });

  test('AC8/TC — panel en ERROR: rojo sobre superficie clara, que es donde se pierde el 4,5:1', async ({ page }) => {
    const abrir = await conLista(page);
    await page.route(API_DETALLE, (r) => r.fulfill({
      status: 500, contentType: 'application/json', body: '{"error":"boom"}',
    }));

    await abrir.click();
    await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
    await sinViolacionesGraves(page, 'panel en error');
  });

  test('AC8/TC — panel GUARDANDO: los controles inhabilitados también tienen que leerse', async ({ page }) => {
    let soltar = () => {};
    const retenido = new Promise<void>((r) => { soltar = r; });
    const abrir = await conLista(page);
    await page.route(API_DETALLE, (r) => r.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(DETALLE),
    }));
    await page.route(API_GESTION, async (r) => {
      await retenido;
      await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DETALLE) });
    });

    await abrir.click();
    const panel = page.getByRole('dialog');
    await expect(panel).toContainText('EN COBRO COACTIVO');
    await panel.getByLabel('Observación').fill('Otra cosa.');
    await panel.getByRole('button', { name: 'Guardar gestión' }).click();

    await expect(panel.getByRole('button', { name: 'Guardando…' })).toBeVisible();
    await expect(panel.getByLabel('Observación')).toBeDisabled();
    await sinViolacionesGraves(page, 'panel guardando');
    soltar();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// HU #11561 — las superficies NUEVAS: los selectores de filtro y la banda del export.
//
// Ninguna de las dos está en pantalla en el estado feliz que miden los bloques de arriba, y las dos
// son justo las que rompen contraste: el mensaje de un catálogo caído es texto en tinta de error, y
// un `<select disabled>` es el control apagado que el kit nunca había tenido. El estado OCUPADO del
// export añade el tercero, un botón inhabilitado con `aria-busy`.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

const API_EXPORT_A11Y = '**/api/flito/comparendos/registros/export**';

test.describe('FLITO — Comparendos · filtros y export: accesibilidad (HU #11561, AC7)', () => {
  test.use({ viewport: { width: 1600, height: 900 } });

  test.beforeEach(() => {
    test.skip(
      !AXE_PATH && !AXE_CDN,
      'axe no disponible: exporta QA_AXE_PATH=/ruta/axe.min.js (determinista) o QA_AXE_CDN=1. '
      + 'Se prefiere SALTAR antes que dar por certificado el contraste sin haberlo medido.',
    );
  });

  test('AC7 — los selectores con su catálogo CAÍDO: inhabilitados, en tinta de error y con salida', async ({ page }) => {
    await loginAs(page, OPERACIONES_USER);
    await page.route('**/api/flito/comparendos/municipios', (r) => r.fulfill({
      status: 500, contentType: 'application/json', body: '{"error":"boom"}',
    }));
    for (const ruta of ['**/api/flito/comparendos/causales', '**/api/flito/comparendos/nits']) {
      await page.route(ruta, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    }
    await page.route(API_REGISTROS, (r) => r.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ items: [FILA], nextCursor: null }),
    }));
    await page.goto('/flito/comparendos');

    await expect(page.getByLabel('Municipio', { exact: true })).toBeDisabled();
    await expect(page.getByText(/No se pudo cargar el catálogo de municipios/)).toBeVisible();
    await sinViolacionesGraves(page, 'filtros con el catálogo caído');
  });

  test('AC7 — la banda de ERROR del export: rojo sobre blanco, que es donde se pierde el 4,5:1', async ({ page }) => {
    await pantalla(page, { items: [FILA], nextCursor: null });
    await page.route(API_EXPORT_A11Y, (r) => r.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'El filtro aplicado supera las 5.000 filas que admite un export.',
        codigo: 'export_demasiado_grande',
      }),
    }));

    await page.getByRole('button', { name: 'Exportar a Excel', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('supera las 5.000 filas');
    await sinViolacionesGraves(page, 'banda de error del export');
  });

  test('AC7 — el export OCUPADO: un botón inhabilitado también tiene que leerse', async ({ page }) => {
    let soltar = () => {};
    const retenido = new Promise<void>((r) => { soltar = r; });
    await pantalla(page, { items: [FILA], nextCursor: null });
    await page.route(API_EXPORT_A11Y, async (r) => {
      await retenido;
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.getByRole('button', { name: 'Exportar a Excel', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Preparando el archivo…' })).toBeDisabled();
    await sinViolacionesGraves(page, 'export ocupado');
    soltar();
  });
});
