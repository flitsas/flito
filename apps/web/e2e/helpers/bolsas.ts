import type { Page } from '@playwright/test';

// HU #13901 — el listado de bolsas de compañía sale de `POST /buscar` y el detalle de
// `GET /bolsa/:bolsaId` (contrato de la HU #13900). Los specs anteriores mockeaban `/riesgo` y la
// rejilla de tarjetas; este helper les añade las dos rutas nuevas a partir de su bolsa de siempre.

/** Funciones de bolsas de un operador de Financiera con el catálogo completo (HU #13900). */
export const FUNCIONES_BOLSAS = [
  'bolsas.bolsa.ver', 'bolsas.bolsa.listar', 'bolsas.bolsa.crear', 'bolsas.bolsa.editar',
  'bolsas.bolsa.inactivar', 'bolsas.transito.crear', 'bolsas.movimientos.ver', 'bolsas.cierres.ver',
  'bolsas.recarga.registrar', 'bolsas.cierre.crear', 'bolsas.movimiento.registrar', 'bolsas.movimiento.corregir',
] as const;

interface BolsaLegacy {
  id: string; companiaId: number; companiaNombre: string; saldo: number; nivel: string;
  porcentaje: number | null; ultimaRecargaValor: number | null; ultimaRecargaEn: string | null;
}

export function resumenDe(b: BolsaLegacy, extra: Record<string, unknown> = {}) {
  return {
    id: b.id, alcance: 'compania', nombre: b.companiaNombre, companiaId: b.companiaId,
    companiaNombre: b.companiaNombre, activa: true, conceptos: ['soat', 'derecho'], cobertura: [],
    saldo: b.saldo, ultimaEntradaValor: b.ultimaRecargaValor, ultimaEntradaEn: b.ultimaRecargaEn,
    nivel: b.nivel, porcentaje: b.porcentaje, ...extra,
  };
}

export function detalleDe(b: BolsaLegacy, extra: Record<string, unknown> = {}) {
  return {
    ...resumenDe(b), inactivadaEn: null, inactivadaPorNombre: null, motivoInactivacion: null,
    conceptosAutogestionados: [], ...extra,
  };
}

/** `/buscar` devuelve `bolsas` y `/bolsa/:id` el detalle de cada una. */
export async function mockCatalogoBolsas(page: Page, bolsas: BolsaLegacy[]) {
  await page.route(/\/api\/flito\/bolsas\/buscar/, (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(bolsas.map((b) => resumenDe(b))),
  }));
  await page.route(/\/api\/flito\/bolsas\/bolsa\/[^/]+$/, (route) => {
    const id = route.request().url().split('/').pop();
    const b = bolsas.find((x) => x.id === id);
    return b
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detalleDe(b)) })
      : route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'La bolsa no existe' }) });
  });
}

/** Abre el detalle desde la fila de la tabla de Compañías. */
export async function abrirDetalleDesdeTabla(page: Page, nombre: string) {
  await page.getByRole('button', { name: `Ver el detalle de la bolsa de ${nombre} (compañía)` }).click();
}
