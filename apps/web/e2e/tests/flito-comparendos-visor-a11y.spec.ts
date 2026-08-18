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

const FILA = {
  id: '11111111-1111-4111-8111-111111111111',
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
