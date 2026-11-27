// Placa del vehículo por tipo (Épica #14707, bloque 4; UX `docs/ux/flito-tramites-rediseno.md` §7 y diseño
// `docs/diseno/epica-14707-bloque4-rediseno-tramites.md` §2).
//
// `vehicles.tipo_servicio` es TEXTO LIBRE (migración 0166: «Particular», «Publico», a veces con tilde desde
// FLIT 2) y la API lo expone en crudo. Este es el ÚNICO punto que lo interpreta: lo llama el componente
// `Placa` de web, y ninguna pantalla compara strings. Si mañana la API necesita el valor normalizado (filtro,
// export), importa la misma función. No es PII.

export type TipoServicioVehiculo = 'particular' | 'publico' | 'oficial' | 'diplomatico' | 'otro';

/** Minúsculas, sin tildes y con los espacios colapsados. */
function plano(texto: string): string {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * null/vacío → null. «Público», «PUBLICO», «Servicio público» → 'publico'. Un valor desconocido no vacío →
 * 'otro' (la columna es texto precisamente para que un valor nuevo no aborte el sync).
 */
export function normalizarTipoServicio(crudo: string | null | undefined): TipoServicioVehiculo | null {
  if (crudo == null) return null;
  const t = plano(crudo).replace(/^servicio\s+/, '');
  if (!t) return null;
  if (t === 'publico') return 'publico';
  if (t === 'particular') return 'particular';
  if (t === 'oficial') return 'oficial';
  if (t === 'diplomatico') return 'diplomatico';
  return 'otro';
}

/**
 * Placa de moto colombiana: tres letras, dos dígitos y una letra (MNB22F), sin espacios ni guiones. El formato
 * viejo de moto `AAA45` NO entra: sigue con la placa por defecto (UX §7.1).
 */
export function esPlacaMoto(placa: string | null | undefined): boolean {
  if (!placa) return false;
  return /^[A-Z]{3}\d{2}[A-Z]$/.test(placa.toUpperCase().replace(/[\s-]/g, ''));
}

export type VariantePlaca = 'particular' | 'moto' | 'publico' | 'moto-publico';

/**
 * Variante visual de la placa. Solo 'publico' cambia el color (blanca); oficial, diplomático y otro quedan con
 * la amarilla por defecto, como la particular. En una moto pública manda el servicio (blanca) y se conserva la
 * señal de moto: 'moto-publico'.
 */
export function variantePlaca(placa: string | null | undefined, tipoServicio: string | null | undefined): VariantePlaca {
  const moto = esPlacaMoto(placa);
  const publico = normalizarTipoServicio(tipoServicio) === 'publico';
  if (moto && publico) return 'moto-publico';
  if (publico) return 'publico';
  if (moto) return 'moto';
  return 'particular';
}
