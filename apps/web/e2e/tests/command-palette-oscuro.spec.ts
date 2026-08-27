// Bug #11720 — la CommandPalette (⌘K) en tema OSCURO, medida sobre el píxel pintado.
//
// POR QUÉ EXISTE
// El bug original —tinta oscura sobre fondo oscuro, el ítem activo en ratio 1,00— se corrigió con
// un gate estático (`scripts/check-contraste-paleta.mjs`) que recompone la cadena de superficies
// leyendo el CSS. Ese gate salió VERDE sobre una pantalla que incumplía: componía las teclas
// sobre el panel cuando en el DOM las cinco cuelgan de una barra `.flit-shell-sunken`, del ítem
// activo o del panel, y ponía bajo el overlay el fondo oscuro del `body` cuando lo que hay ahí es
// `.flit-app`. Un gate que se equivoca de padre no protege nada, y hasta esta corrección no había
// NINGÚN test que abriera la paleta.
//
// (Aquel `.flit-app` era CLARO en los dos temas cuando se escribió esto. Con la HU #11899 el
// shell invierte y el sustrato bajo el overlay es el par oscuro de `--flit-bg-app`; el gate
// estático se extendió para resolver los tokens POR TEMA en el mismo cambio. El modelo de capas
// no varía —es la misma cadena—, sólo los hex, y por eso este spec sigue midiendo el píxel: es la
// única forma de enterarse si el modelo y la pantalla vuelven a separarse.)
//
// Este spec es el contrapeso: no reconstruye la cadena, la abre de verdad y lee el color que el
// compositor dejó en pantalla. Si el modelo del gate y la pantalla vuelven a separarse, manda
// este archivo.
//
// axe corre igual —es lo que destapó el fallo— pero NO basta por sí solo: dos de las tres teclas
// afectadas llevan glifos de flecha (↑↓ ↵) y axe las descarta con `only non-text characters`, y
// el `::placeholder` no lo mira ninguna regla. Justo lo que se le escapa al motor es lo que aquí
// se mide a mano.
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { loginAs, ADMIN_USER } from '../helpers/auth';
import { correrAxe, esperarSinViolacionesGraves } from '../helpers/axe';
import { aHex, contraste, fondoPintado, tintaEfectiva } from '../helpers/pixeles';

// Mínimo WCAG 2.x AA para texto normal (SC 1.4.3), el mismo del gate y del kit (Bug #11604).
const MINIMO = 4.5;

const TABLERO_VACIO = {
  soat: {}, impuestos: {}, revisionesPendientes: { soat: 0, impuestos: 0 },
  organismosSinClasificar: 0, tramitesRetenidos: 0, estancados: { soat: 0, impuestos: 0 },
  diferenciasDeValor: 0, compuertaHabilitados: 0,
};

/** Deja la app autenticada, en tema oscuro y con la paleta abierta. */
async function abrirPaletaEnOscuro(page: Page): Promise<void> {
  await loginAs(page, ADMIN_USER);
  await page.route('**/api/flito/tablero', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TABLERO_VACIO) }));
  // El tema se persiste en `aura-theme` y el ThemeProvider lo lee al montar: fijarlo ANTES del
  // goto evita medir durante el parpadeo claro→oscuro.
  await page.evaluate(() => localStorage.setItem('aura-theme', 'dark'));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  // El atajo lo escucha `Layout`. Esperar a un control suyo evita teclear contra una página que
  // todavía no montó el listener: sin esto la paleta no abría una de cada tres corridas.
  await expect(page.getByRole('button', { name: /Buscar o ir a secci/ })).toBeVisible();

  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog', { name: 'Paleta de comandos' })).toBeVisible();
  // Las opciones entran con `animate-in`: medir antes deja fondos a medio componer.
  await expect(page.getByRole('option').first()).toBeVisible();
  await page.waitForTimeout(400);
}

const paleta = (page: Page) => page.getByRole('dialog', { name: 'Paleta de comandos' });

interface Punto { nombre: string; ratio: number; detalle: string }

/**
 * Mide un punto de texto sobre el píxel: fondo = color más repetido del recuadro que lo aloja,
 * tinta = `color` calculado ya compuesto sobre ese fondo.
 * `fondoDe` sirve para los textos que no pintan fondo propio (un `span` dentro de una fila) y
 * `pseudo` para el `::placeholder`.
 */
async function medir(
  page: Page,
  nombre: string,
  texto: Locator,
  opciones: { fondoDe?: Locator; pseudo?: string } = {},
): Promise<Punto> {
  const { color: fondo, cobertura } = await fondoPintado(page, opciones.fondoDe ?? texto);
  const tinta = await tintaEfectiva(texto, fondo, opciones.pseudo ?? null);
  const ratio = contraste(tinta, fondo);
  return {
    nombre,
    ratio,
    detalle: `${nombre.padEnd(40)} ${aHex(tinta)} sobre ${aHex(fondo)}`
      + ` (${(cobertura * 100).toFixed(0)} % del recuadro) → ${ratio.toFixed(2)}`,
  };
}

function exigirAA(puntos: Punto[], ambito: string): void {
  console.log(`[contraste · ${ambito}]\n` + puntos.map((p) => '  ' + p.detalle).join('\n'));
  expect(
    puntos.filter((p) => p.ratio < MINIMO).map((p) => p.detalle),
    `Puntos bajo ${MINIMO}:1 medidos SOBRE EL PÍXEL PINTADO en tema oscuro — «${ambito}»`,
  ).toEqual([]);
}

test.describe('CommandPalette · tema oscuro (Bug #11720)', () => {
  test.use({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });

  test('cada texto de la paleta llega a AA sobre el fondo que de verdad tiene debajo', async ({ page }) => {
    await abrirPaletaEnOscuro(page);
    const dialog = paleta(page);
    const buscador = dialog.getByRole('combobox');
    const fila = dialog.locator('kbd', { hasText: 'esc' }).locator('..');

    // El placeholder se mide ANTES de escribir: con texto dentro deja de pintarse.
    const placeholder = await medir(page, 'fila de búsqueda — placeholder', buscador, {
      fondoDe: fila,
      pseudo: '::placeholder',
    });
    // El ícono de la lupa es un trazo `currentColor`, no texto: su fondo es el de la fila.
    const lupa = await medir(page, 'fila de búsqueda — icono de lupa', fila.locator('svg'), {
      fondoDe: fila,
    });

    await buscador.fill('a');
    await expect(page.getByRole('option').first()).toBeVisible();
    const activo = page.getByRole('option', { selected: true });
    const noActivo = page.getByRole('option', { selected: false }).first();

    exigirAA([
      await medir(page, 'fila de búsqueda — texto tecleado', buscador, { fondoDe: fila }),
      lupa,
      placeholder,
      await medir(page, 'fila de búsqueda — tecla «esc»', dialog.locator('kbd', { hasText: 'esc' })),
      await medir(page, 'cabecera de sección', dialog.locator('[role="group"] > p').first()),
      await medir(page, 'ítem no activo', noActivo),
      await medir(page, 'ítem ACTIVO', activo),
      await medir(page, 'ítem activo — tecla ↵', activo.locator('kbd')),
      await medir(page, 'pie — texto «navegar»', dialog.getByText('navegar')),
      await medir(page, 'pie — tecla ↑↓', dialog.locator('kbd', { hasText: '↑↓' })),
      await medir(page, 'pie — tecla ↵', dialog.locator('kbd').filter({ hasText: /^↵$/ }).last()),
      await medir(page, 'pie — recuento de resultados', dialog.getByText(/resultados?$/)),
    ], 'paleta con resultados');
  });

  test('el estado vacío y el ítem que conserva :hover también cumplen AA', async ({ page }) => {
    await abrirPaletaEnOscuro(page);
    const dialog = paleta(page);

    // ── :hover sin ser el activo ─────────────────────────────────────────────────────────
    // `onMouseEnter` activa el ítem, así que `.flit-shell-hover:hover` sólo llega a pintarse
    // cuando el puntero se queda quieto sobre un ítem y el teclado mueve el activo a otro. Es
    // el único estado en el que esa superficie existe, y el gate la daba por tinta primaria
    // cuando lo que se pinta es la secundaria.
    const primero = page.getByRole('option').first();
    await primero.hover();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(primero).toHaveAttribute('aria-selected', 'false');
    const hover = await medir(page, 'ítem con :hover pero no activo', primero);

    // ── Estado vacío ─────────────────────────────────────────────────────────────────────
    await dialog.getByRole('combobox').fill('zzzzzzzz');
    await expect(dialog.getByText('Sin resultados para')).toBeVisible();
    const vacio = dialog.getByText('Sin resultados para');
    const pista = dialog.getByText(/haz click fuera para cerrar/);

    exigirAA([
      hover,
      await medir(page, 'vacío — «Sin resultados»', vacio),
      await medir(page, 'vacío — la consulta buscada', vacio.locator('span')),
      await medir(page, 'vacío — pista de cierre', pista),
      // El `Esc` de la pista hereda la tinta del párrafo pero pinta su propio fondo de tecla:
      // otra superficie, otro punto. La lista del gate no lo tenía.
      await medir(page, 'vacío — tecla «Esc» de la pista', pista, { fondoDe: pista.locator('kbd') }),
    ], 'paleta vacía y hover');
  });

  test('axe no encuentra violaciones serias con la paleta abierta en oscuro', async ({ page }) => {
    await abrirPaletaEnOscuro(page);
    const violaciones = await correrAxe(page);
    esperarSinViolacionesGraves(violaciones, 'CommandPalette · tema oscuro');
  });
});
