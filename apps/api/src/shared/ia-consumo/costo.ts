// Contrato `ia-consumo` v1, regla 9 (ADR-0045) — costo estimado en USD de una llamada.
//
//   costo = (entrada·p_entrada + salida·p_salida + cache_lectura·p_lectura + cache_escritura·p_escritura) / 1e6
//
// con la tarifa vigente (la más reciente con `vigente_desde <= fecha_inicio`) de (proveedor, modelo), donde el
// modelo es `modelo_respondido` o, si falta, `modelo_solicitado`. Primero el id exacto; si no hay, el id sin
// sufijo de fecha (`claude-haiku-4-5-20251001` → `claude-haiku-4-5`). Sin tarifa ⇒ NULL, nunca 0.
// Las tarifas se cachean 10 min en memoria; si la BD falla se sigue con la caché anterior (o sin tarifas).

export interface TarifaIa {
  proveedor: string;
  modelo: string;
  /** `yyyy-mm-dd`. */
  vigenteDesde: string;
  entrada: number;
  salida: number;
  cacheLectura: number;
  cacheEscritura: number;
}

export interface ConsumoParaCosto {
  proveedor: string;
  modeloSolicitado?: string | null;
  modeloRespondido?: string | null;
  fechaInicio: Date;
  tokensEntrada?: number;
  tokensSalida?: number;
  tokensCacheLectura?: number;
  tokensCacheEscritura?: number;
}

export const TTL_TARIFAS_MS = 10 * 60_000;

/** `claude-haiku-4-5-20251001` → `claude-haiku-4-5`. Sin sufijo de fecha devuelve el mismo id. */
export function modeloSinFecha(modelo: string): string {
  return modelo.replace(/-\d{8}$/, '');
}

function tarifaVigente(tarifas: readonly TarifaIa[], proveedor: string, modelo: string, dia: string): TarifaIa | null {
  let mejor: TarifaIa | null = null;
  for (const t of tarifas) {
    if (t.proveedor !== proveedor || t.modelo !== modelo || t.vigenteDesde > dia) continue;
    if (!mejor || t.vigenteDesde > mejor.vigenteDesde) mejor = t;
  }
  return mejor;
}

/** Costo como texto con 6 decimales (columna `numeric(12,6)`) o `null` si no hay tarifa. */
export function calcularCostoIa(tarifas: readonly TarifaIa[], c: ConsumoParaCosto): string | null {
  const modelo = c.modeloRespondido || c.modeloSolicitado;
  if (!modelo) return null;
  const dia = c.fechaInicio.toISOString().slice(0, 10);
  const t = tarifaVigente(tarifas, c.proveedor, modelo, dia)
    ?? (modeloSinFecha(modelo) !== modelo ? tarifaVigente(tarifas, c.proveedor, modeloSinFecha(modelo), dia) : null);
  if (!t) return null;
  const usd = ((c.tokensEntrada ?? 0) * t.entrada + (c.tokensSalida ?? 0) * t.salida
    + (c.tokensCacheLectura ?? 0) * t.cacheLectura + (c.tokensCacheEscritura ?? 0) * t.cacheEscritura) / 1e6;
  return Number.isFinite(usd) ? usd.toFixed(6) : null;
}

/** Caché de tarifas con recarga perezosa. `cargar` es inyectable para los tests. */
export function crearCacheTarifas(cargar: () => Promise<TarifaIa[]>, ttlMs = TTL_TARIFAS_MS, reloj: () => number = Date.now) {
  let tarifas: TarifaIa[] = [];
  let cargadasEn = -Infinity;
  let enVuelo: Promise<TarifaIa[]> | null = null;
  return {
    async obtener(): Promise<TarifaIa[]> {
      if (reloj() - cargadasEn < ttlMs) return tarifas;
      if (!enVuelo) {
        enVuelo = cargar()
          .then((t) => { tarifas = t; cargadasEn = reloj(); return t; })
          // Sin tarifas no hay costo (NULL), pero el registro sigue. Se reintenta en el siguiente lote.
          .catch(() => tarifas)
          .finally(() => { enVuelo = null; });
      }
      return enVuelo;
    },
    invalidar(): void { cargadasEn = -Infinity; },
  };
}
