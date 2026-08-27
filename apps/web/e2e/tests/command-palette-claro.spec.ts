// Bug #11767 — la CommandPalette (⌘K) en tema CLARO, medida sobre el píxel pintado.
//
// POR QUÉ EXISTE
// El Bug #11720 corrigió la paleta en tema OSCURO y dejó el claro fuera de alcance con criterio
// explícito («deuda previa a este bug, se reporta aparte»). El claro es el tema por defecto y el
// que ve casi todo el mundo, así que ese lado se quedó con dos puntos bajo AA:
//
//   · el `::placeholder` del buscador — 2,98. En claro no lo pintaba ninguna regla: hasta el
//     retrabajo del #11720 el input llevaba `placeholder:flit-shell-muted`, que NO es una utilidad
//     de Tailwind y nunca generó nada, así que lo pintaba el preflight con `currentcolor` al 50 %.
//     La clase muerta ya se quitó, pero el preflight seguía siendo quien decidía el color.
//   · la tecla ↵ del ítem activo — 3,99. El #11720 la dio por buena en 4,49 «sobre el fondo claro
//     que ese kbd tenía», y ese fondo era el `bg-white` que ese mismo bug demostró MUERTO (es una
//     utilidad de Tailwind y `.flit-shell-sunken`, sin capa, se la come). Lo que pinta la tecla es
//     #eaf2ff, no blanco, y ahí --flit-blue no llega.
//
// Los dos fallos comparten causa con los del tema oscuro: dar por supuesto el fondo en vez de
// componerlo. Por eso este spec no reconstruye la cadena de superficies — abre la paleta y lee el
// color que el compositor dejó en pantalla. Es el contrapeso de `scripts/check-contraste-paleta.mjs`,
// que sí modela; si los dos discrepan, manda este archivo.
//
// axe NO puede sustituir a esta medición y por eso el gate propio existe: el `::placeholder` no lo
// mira ninguna de sus reglas, y las teclas de flecha (↑↓ ↵) las descarta con
// `only non-text characters`. Justo los puntos que fallaban.
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

/** Deja la app autenticada, en tema claro y con la paleta abierta. */
async function abrirPaletaEnClaro(page: Page): Promise<void> {
  await loginAs(page, ADMIN_USER);
  await page.route('**/api/flito/tablero', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TABLERO_VACIO) }));
  // `light` EXPLÍCITO, no `system`. El motivo escrito aquí antes —«con `system` el ThemeProvider
  // quita `data-theme`»— dejó de ser cierto con la HU #11899: hoy el atributo se escribe SIEMPRE,
  // resuelto a `light` o `dark`. Lo que sigue en pie es la razón de fondo: en `system` el tema lo
  // decide el `prefers-color-scheme` del runner, así que este spec mediría el tema que le toque a
  // la máquina en vez del que dice medir. Fijarlo antes del goto evita además el parpadeo inicial.
  await page.evaluate(() => localStorage.setItem('aura-theme', 'light'));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  // El atajo lo escucha `Layout`. Esperar a un control suyo evita teclear contra una página que
  // todavía no montó el listener.
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
    `Puntos bajo ${MINIMO}:1 medidos SOBRE EL PÍXEL PINTADO en tema claro — «${ambito}»`,
  ).toEqual([]);
}

test.describe('CommandPalette · tema claro (Bug #11767)', () => {
  test.use({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });

  test('cada texto de la paleta llega a AA sobre el fondo que de verdad tiene debajo', async ({ page }) => {
    await abrirPaletaEnClaro(page);
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
      // El punto que el #11720 dio por bueno midiendo contra un `bg-white` que no pintaba.
      await medir(page, 'ítem activo — tecla ↵', activo.locator('kbd')),
      await medir(page, 'pie — texto «navegar»', dialog.getByText('navegar')),
      await medir(page, 'pie — tecla ↑↓', dialog.locator('kbd', { hasText: '↑↓' })),
      await medir(page, 'pie — tecla ↵', dialog.locator('kbd').filter({ hasText: /^↵$/ }).last()),
      await medir(page, 'pie — recuento de resultados', dialog.getByText(/resultados?$/)),
    ], 'paleta con resultados');
  });

  test('el estado vacío y el ítem que conserva :hover también cumplen AA', async ({ page }) => {
    await abrirPaletaEnClaro(page);
    const dialog = paleta(page);

    // ── :hover sin ser el activo ─────────────────────────────────────────────────────────
    // `onMouseEnter` activa el ítem, así que `.flit-shell-hover:hover` sólo llega a pintarse
    // cuando el puntero se queda quieto sobre un ítem y el teclado mueve el activo a otro.
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
      // otra superficie, otro punto.
      await medir(page, 'vacío — tecla «Esc» de la pista', pista, { fondoDe: pista.locator('kbd') }),
    ], 'paleta vacía y hover');
  });

  test('axe no encuentra violaciones serias con la paleta abierta en claro', async ({ page }) => {
    await abrirPaletaEnClaro(page);
    const violaciones = await correrAxe(page);
    esperarSinViolacionesGraves(violaciones, 'CommandPalette · tema claro');
  });
});
