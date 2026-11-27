// Gestión Trámites — panel de Filtros (Épica #14707, bloque 4; UX §5.4). Los filtros viven en un acordeón:
// fila del encabezado [Filtros (n)] [buscador] [Vistas rápidas] y, desplegado, la rejilla de 10 `CampoFiltro`
// y el pie con los aplicados y «Limpiar filtros». Ya no hay filtros en las cabeceras de la tabla (R11).
import { expect, type Locator, type Page } from '@playwright/test';

export const panelFiltros = (page: Page): Locator => page.getByRole('region', { name: 'Búsqueda y filtros' });
export const botonFiltros = (page: Page): Locator => panelFiltros(page).getByRole('button', { name: /^Filtros/ });

/** Despliega el panel si está plegado (idempotente). */
export async function abrirFiltros(page: Page): Promise<void> {
  const b = botonFiltros(page);
  // `toPass`: durante la carga inicial la página se vuelve a montar (sesión y permisos) y un panel abierto
  // antes se plegaría con ella; se reintenta hasta que el botón DIGA que está abierto.
  await expect(async () => {
    if ((await b.getAttribute('aria-expanded')) !== 'true') await b.click();
    await expect(b).toHaveAttribute('aria-expanded', 'true', { timeout: 1_000 });
  }).toPass();
}

/** Control de elección única con nombre «Filtrar por fuente: …» / «Filtrar por autogestión: …». */
export const controlUnica = (page: Page, prefijo: 'fuente' | 'autogestión'): Locator =>
  panelFiltros(page).getByRole('button', { name: new RegExp(`^Filtrar por ${prefijo}`) });

/** Elige una opción de Fuente o Autogestión (abre el panel y el menú). */
export async function elegirUnica(page: Page, prefijo: 'fuente' | 'autogestión', opcion: string): Promise<void> {
  await abrirFiltros(page);
  await controlUnica(page, prefijo).click();
  await panelFiltros(page).getByRole('radio', { name: opcion, exact: true }).click();
}

/** Control multiselección por su rótulo («SOAT», «Trámite», «Tránsito»…): nombre = rótulo + valor. */
export const controlMulti = (page: Page, rotulo: string): Locator =>
  panelFiltros(page).getByRole('button', { name: new RegExp(`^${rotulo} `) });

/** Marca (o desmarca) una opción de un filtro multiselección y cierra el menú con Escape. */
export async function alternarMulti(page: Page, rotulo: string, opcion: string): Promise<void> {
  await abrirFiltros(page);
  const control = controlMulti(page, rotulo);
  if ((await control.getAttribute('aria-expanded')) !== 'true') await control.click();
  await panelFiltros(page).getByRole('checkbox', { name: opcion, exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(control).toHaveAttribute('aria-expanded', 'false');
}
