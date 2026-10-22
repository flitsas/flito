// FLITO sync — «solo se escribe lo que cambió» (HU #13629, AC6; diseño §D6). Solo lo usa FLIT 1.
//
// Comparaciones puras entre lo guardado y lo que trae el reporte, para que una lectura cada 2 minutos de
// una ventana que casi no cambia no reescriba trámites, vehículos ni compradores idénticos (ni mueva su
// `updated_at`). FLIT 2 no pasa por aquí: sigue escribiendo como antes.
//
// Reglas:
//   - Vehículo: se compara SOLO lo que `setVehiculoDesdeFlit` ya decidió escribir (spreads condicionales),
//     así que la placa vacía sigue sin borrar (Bug #13585): ni siquiera entra al parche.
//   - Trámite: todas las columnas de `valores` salvo `sincronizadoEn`. Fechas por instante, el numérico
//     por valor (`'1000.00'` = `1000`), el jsonb por igualdad profunda sin importar el orden de claves.
//   - Compradores: mismos `orden` y, en cada uno, mismos campos exactos y mismo porcentaje.

/** Columnas que NO cuentan como cambio del trámite. */
const IGNORADAS_TRAMITE = new Set(['sincronizadoEn', 'updatedAt']);

const esNulo = (v: unknown): boolean => v === null || v === undefined;

/** Igualdad profunda de JSON: objetos sin importar el orden de claves, arrays en orden. */
export function jsonIgual(a: unknown, b: unknown): boolean {
  if (esNulo(a) || esNulo(b)) return esNulo(a) && esNulo(b);
  if (typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => jsonIgual(x, b[i]));
  }
  const oa = a as Record<string, unknown>;
  const ob = b as Record<string, unknown>;
  // Una clave con `undefined` no viaja en JSON: se ignora en ambos lados.
  const ka = Object.keys(oa).filter((k) => oa[k] !== undefined);
  const kb = Object.keys(ob).filter((k) => ob[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(ob, k) && jsonIgual(oa[k], ob[k]));
}

function instante(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') { const t = new Date(v).getTime(); return Number.isNaN(t) ? null : t; }
  return null;
}

function numero(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isNaN(n) ? null : n; }
  return null;
}

/** ¿Mismo valor de columna? Normaliza fecha, numérico y jsonb; el resto, igualdad estricta. */
export function mismoValor(campo: string, guardado: unknown, nuevo: unknown): boolean {
  if (esNulo(guardado) || esNulo(nuevo)) return esNulo(guardado) && esNulo(nuevo);
  if (guardado instanceof Date || nuevo instanceof Date) {
    const a = instante(guardado);
    return a !== null && a === instante(nuevo);
  }
  if (campo === 'valorImpuestoLiquidado') {
    const a = numero(guardado);
    return a !== null && a === numero(nuevo);
  }
  if (typeof guardado === 'object' || typeof nuevo === 'object') return jsonIgual(guardado, nuevo);
  return guardado === nuevo;
}

/** ¿El trámite cambia respecto de lo guardado? Solo mira las claves que la fuente escribe (`valores`). */
export function tramiteCambia(guardado: Record<string, unknown>, valores: Record<string, unknown>): boolean {
  return Object.keys(valores).some((k) => !IGNORADAS_TRAMITE.has(k) && !mismoValor(k, guardado[k], valores[k]));
}

/** Claves del `SET` del vehículo cuyo valor difiere del guardado. Vacío = no hay que escribir. */
export function parcheVehiculo<T extends Record<string, unknown>>(guardado: Record<string, unknown>, set: T): Partial<T> {
  const parche: Partial<T> = {};
  for (const k of Object.keys(set) as (keyof T & string)[]) {
    if (!mismoValor(k, guardado[k], set[k])) parche[k] = set[k];
  }
  return parche;
}

interface CompradorComparableEstricto {
  orden: number; nombreCompleto: string; numeroDocumento: string;
  correo: string | null; celular: string | null; direccion: string | null;
  porcentajeParticipacion: string | number | null;
}

/** ¿Los compradores guardados son exactamente los nuevos (por `orden`, campos y porcentaje)? */
export function compradoresIguales(guardados: CompradorComparableEstricto[], nuevos: CompradorComparableEstricto[]): boolean {
  if (guardados.length !== nuevos.length) return false;
  const porOrden = new Map(guardados.map((c) => [c.orden, c]));
  if (porOrden.size !== guardados.length) return false;
  return nuevos.every((n) => {
    const g = porOrden.get(n.orden);
    if (!g) return false;
    return g.nombreCompleto === n.nombreCompleto && g.numeroDocumento === n.numeroDocumento
      && (g.correo ?? null) === (n.correo ?? null) && (g.celular ?? null) === (n.celular ?? null)
      && (g.direccion ?? null) === (n.direccion ?? null)
      && numero(g.porcentajeParticipacion) === numero(n.porcentajeParticipacion);
  });
}
