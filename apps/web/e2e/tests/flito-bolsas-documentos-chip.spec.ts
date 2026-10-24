import { test, expect } from '../helpers/fixtures';
import type { Page, Route } from '@playwright/test';
import { loginAs, FINANCIERA_USER } from '../helpers/auth';

// HU #13893 — Bolsas: chip de estado documental en la tabla de Compañías (Feature #13888).
// Spec UX: docs/ux/flito-bolsas-expediente-documental.md (Pantalla 2). Contrato: E6
// `POST /api/flito/bolsas-documentos/estado-lote` con `{ companiaIds }` en el body. Red mockeada.

const BOLSA = ['bolsas.bolsa.ver', 'bolsas.bolsa.listar', 'bolsas.movimientos.ver', 'bolsas.cierres.ver'];
const VER = 'bolsas.documentos.ver';

const resumen = (o: Record<string, unknown>) => ({
  alcance: 'compania', companiaNombre: o.nombre, conceptos: ['soat'], cobertura: [],
  ultimaEntradaValor: 5000000, ultimaEntradaEn: '2026-10-02T10:00:00.000Z', porcentaje: 62, ...o,
});
const ANDINOS = resumen({ id: 'b-1', nombre: 'TRANSPORTES ANDINOS', companiaId: 1, activa: true, saldo: 4250000, nivel: 'normal' });
const RENTACAR = resumen({ id: 'b-3', nombre: 'RENTACAR NORTE', companiaId: 3, activa: false, saldo: -85000, nivel: 'agotada' });
const VALLE = resumen({ id: 'b-4', nombre: 'LOGISTICA DEL VALLE', companiaId: 4, activa: true, saldo: 920000, nivel: 'bajo' });
const TRANSITO = {
  id: 'ob-1', nombre: 'Bolsa Bogotá', saldo: 0, ultimaCargaValor: null, ultimaCargaEn: null,
  nivel: 'sin_cargas', porcentaje: null, deuda: 0, totalCargado: 0, totalConsumido: 0,
  cobertura: [{ organismoCodigo: '11001', organismoNombre: 'Bogotá', concepto: 'impuesto' }],
};

type Estado = 'pendiente' | 'valido' | 'vencido' | 'no_validado' | 'validando';
const estados = (e: Partial<Record<'camara_comercio' | 'rut' | 'cedula_representante' | 'certificado_bancario', Estado>>) => ({
  camara_comercio: 'valido', rut: 'valido', cedula_representante: 'valido', certificado_bancario: 'valido', ...e,
});

/** Respuesta por compañía; `completo` lo calcula el servidor sobre los 4 principales (el adicional no cuenta). */
const LOTE: Record<number, { completo: boolean; estados: ReturnType<typeof estados> }> = {
  1: { completo: true, estados: estados({}) },
  3: { completo: false, estados: estados({ rut: 'vencido' }) },
  4: { completo: false, estados: estados({ certificado_bancario: 'validando', cedula_representante: 'no_validado' }) },
};

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

interface Opts {
  /** Status de error de E6, o una función que el test cambia para el reintento. */
  e6?: number | (() => number | null);
  e6Retraso?: number;
  filas?: unknown[];
}

async function mock(page: Page, o: Opts = {}) {
  const peticiones = { e6: [] as number[][], buscar: 0 };
  await page.route(/\/api\/flito\/bolsas\/consolidado/, (r) => json(r, { clientes: 3, saldoTotal: 5085000 }));
  await page.route(/\/api\/flito\/bolsas\/alertas/, (r) => json(r, {
    saldo: [], conciliacion: { soportesSinTramite: 0, movimientosSinSoporte: 0, boletasSinComprobante: 0 },
  }));
  await page.route(/\/api\/flito\/bolsas\/transito$/, (r) => json(r, [TRANSITO]));
  await page.route(/\/api\/flito\/bolsas\/buscar/, (r) => { peticiones.buscar += 1; return json(r, o.filas ?? [ANDINOS, RENTACAR, VALLE]); });
  await page.route(/\/api\/flito\/bolsas-documentos\/estado-lote$/, async (r) => {
    expect(r.request().method()).toBe('POST');
    const { companiaIds } = r.request().postDataJSON() as { companiaIds: number[] };
    peticiones.e6.push(companiaIds);
    if (o.e6Retraso) await new Promise((res) => setTimeout(res, o.e6Retraso));
    const fallo = typeof o.e6 === 'function' ? o.e6() : o.e6;
    if (fallo) return json(r, { error: 'falla interna' }, fallo);
    return json(r, {
      estados: companiaIds.map((id) => ({ companiaId: id, ...(LOTE[id] ?? { completo: false, estados: estados({ rut: 'pendiente' }) }) })),
    });
  });
  return peticiones;
}

const tabla = (page: Page) => page.getByRole('region', { name: 'Bolsas de compañías' });

async function abrir(page: Page) {
  await page.goto('/flito/bolsas');
  await tabla(page).getByText('TRANSPORTES ANDINOS').waitFor();
}

test.describe('FLITO — Bolsas · chip de expediente en el listado (HU #13893)', () => {
  test('AC1 + AC2 + AC3: verde con los 4 válidos, naranja si falta, vence, no valida o valida', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: [...BOLSA, VER] });
    await mock(page);
    await abrir(page);
    await expect(tabla(page).getByRole('columnheader', { name: 'Expediente documental' })).toBeVisible();
    await expect(page.getByTestId('chip-expediente-1')).toHaveText('Docs completos');
    await expect(page.getByTestId('chip-expediente-3')).toHaveText('Docs pendientes');
    await expect(page.getByTestId('chip-expediente-4')).toHaveText('Docs pendientes');
    await expect(page.getByTestId('chip-expediente-3')).toHaveAttribute('title', 'Revisa el expediente en el detalle de la bolsa.');
    // El chip es un dato, no un control.
    await expect(tabla(page).getByRole('button', { name: /Docs/ })).toHaveCount(0);
  });

  test('AC4: las bolsas de tránsito no llevan chip', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: [...BOLSA, VER] });
    await mock(page);
    await abrir(page);
    const tarjeta = page.getByTestId('tarjeta-bolsa-transito-ob-1');
    await expect(tarjeta).toBeVisible();
    await expect(page.getByRole('region', { name: 'Bolsas de tránsito' }).getByText(/Docs (completos|pendientes)|Expediente/)).toHaveCount(0);
    await expect(page.getByTestId('chip-expediente-1')).toBeVisible();
  });

  test('AC5: un solo POST por carga del listado, con todos los ids en el body', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: [...BOLSA, VER] });
    const peticiones = await mock(page);
    await abrir(page);
    await expect(page.getByTestId('chip-expediente-1')).toBeVisible();
    // Un lote por listado pintado, nunca uno por fila: cada POST lleva TODAS las compañías.
    // (StrictMode en dev monta dos veces: como mucho 2 lotes, nunca más que lecturas de `/buscar`.)
    expect(peticiones.e6.length).toBeGreaterThan(0);
    expect(peticiones.e6.length).toBeLessThanOrEqual(Math.min(2, peticiones.buscar));
    for (const ids of peticiones.e6) expect(ids).toEqual([1, 3, 4]);
    expect(page.url()).not.toMatch(/companiaIds|\b[134]\b.*estado/);
  });

  test('AC5: con más de 200 compañías el lote se parte en trozos de 200', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: [...BOLSA, VER] });
    const filas = Array.from({ length: 205 }, (_, i) => resumen({
      id: `b-${i + 1}`, nombre: i === 0 ? 'TRANSPORTES ANDINOS' : `COMPANIA ${i + 1}`, companiaId: i + 1,
      activa: true, saldo: 1000, nivel: 'normal',
    }));
    const peticiones = await mock(page, { filas });
    await abrir(page);
    await expect(page.getByTestId('chip-expediente-205')).toBeVisible();
    const tamanos = peticiones.e6.map((ids) => ids.length).slice(0, 2).sort((a, b) => b - a);
    expect(tamanos).toEqual([200, 5]);
  });

  test('AC6: la tabla se pinta sin esperar el lote; si falla, «—», aviso discreto y «Reintentar»', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: [...BOLSA, VER] });
    let falla: number | null = 500;
    await mock(page, { e6: () => falla, e6Retraso: 600 });
    await abrir(page);
    // Cargando: la fila ya está y la celda muestra el esqueleto.
    await expect(page.getByTestId('chip-expediente-cargando-1')).toBeVisible();
    const aviso = page.getByTestId('aviso-expediente-lote');
    await expect(aviso).toHaveText(/No pudimos cargar el estado de los documentos\./);
    await expect(aviso).toHaveAttribute('role', 'status');
    await expect(page.getByTestId('chip-expediente-sin-dato-1')).toHaveText('—');
    await expect(tabla(page).getByText('RENTACAR NORTE')).toBeVisible();
    await expect(page.getByText('falla interna')).toHaveCount(0);
    falla = null;
    await aviso.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByTestId('chip-expediente-1')).toHaveText('Docs completos');
    await expect(aviso).toHaveCount(0);
  });

  test('AC7: sin «ver» no hay columna ni petición a E6', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: BOLSA });
    const peticiones = await mock(page);
    await abrir(page);
    await expect(tabla(page).getByRole('columnheader', { name: /Expediente/ })).toHaveCount(0);
    await expect(tabla(page).getByRole('cell', { name: 'Sin dato' })).toHaveCount(0);
    expect(peticiones.e6).toHaveLength(0);
  });

  test('AC7: un 403 de E6 aunque se crea tener «ver» oculta la columna, sin aviso', async ({ page }) => {
    await loginAs(page, FINANCIERA_USER, { funciones: [...BOLSA, VER] });
    const peticiones = await mock(page, { e6: 403 });
    await abrir(page);
    await expect.poll(() => peticiones.e6.length).toBeGreaterThan(0);
    await expect(tabla(page).getByRole('columnheader', { name: /Expediente/ })).toHaveCount(0);
    await expect(page.getByTestId('aviso-expediente-lote')).toHaveCount(0);
    await expect(tabla(page).getByText('TRANSPORTES ANDINOS')).toBeVisible();
  });
});
