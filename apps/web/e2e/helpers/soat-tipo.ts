// HU #14019 — la solicitud de SOAT ya no tiene tipo por defecto: hay que elegirlo antes de ver el
// bloque 1. Estos helpers lo hacen en un paso para los specs que prueban el flujo Inicial/Renovación.
import type { Page } from '@playwright/test';

/** Elige «SOAT inicial» y espera a que aparezca el campo VIN (el bloque 1 de Inicial). */
export async function elegirTipoInicial(page: Page): Promise<void> {
  await page.getByRole('radio', { name: /SOAT inicial/ }).check();
  await page.getByLabel(/^VIN \(número de chasis\)/).waitFor();
}

/** Elige «Renovación» y espera a que aparezca el campo «Placa». */
export async function elegirTipoRenovacion(page: Page): Promise<void> {
  await page.getByRole('radio', { name: /Renovación/ }).check();
  await page.getByLabel(/^Placa/).waitFor();
}
