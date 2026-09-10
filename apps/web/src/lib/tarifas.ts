// FLITO — Tarifas como vigencias (HU #12375, Feature #12365).
//
// El contrato de `GET /flito/parametrizacion/tarifas/companias/:id` y de su historial, tal como lo
// devuelve `flito-tarifas.service.ts` (HU #12373), más los tres helpers que la pantalla necesita y
// que no existían con esa forma en `lib/bolsas.ts`:
//
//   · `pesosTarifa` — dos decimales cuando los hay. `pesos()` de bolsas redondea a cero y
//     «$1.500,50» se leería «$ 1.501».
//   · `fechaCorta` — «1 sep 2026». Con `Intl` en `es-CO` el mes sale «sept», y el AC2 dice «sep».
//   · `validarValorTarifa` — la validación en cliente del AC6, con el mismo tope y la misma regla
//     de decimales que `valorTarifaValido` de shared-types, pero sobre el TEXTO escrito: es el
//     texto lo que puede traer letras, un signo o tres decimales.

import {
  LLAVES_TARIFA, TARIFA_VALOR_MAX, TIPO_TRAMITE_TARIFA_LABEL,
  type ConceptoTarifa, type TipoTramiteTarifa,
} from '@operaciones/shared-types';

export interface UsuarioRef { id: number; nombre: string | null }

export interface FilaVistaTarifa {
  concepto: ConceptoTarifa;
  tipoTramite: TipoTramiteTarifa | null;
  vigenciaId: string | null;
  /** null = «Sin configurar». Nunca 0 por defecto. */
  valor: number | null;
  vigenteDesde: string | null;
  fijadoPor: UsuarioRef | null;
  /** Solo en la fila de logística. */
  flitoGestionaLogistica?: boolean;
}

export interface VistaTarifasCompania {
  companiaId: number;
  companiaNombre: string;
  tarifas: FilaVistaTarifa[];
  capacidades: { editar: boolean; verHistorial: boolean };
}

export interface VigenciaHistorial {
  id: string;
  concepto: ConceptoTarifa;
  tipoTramite: TipoTramiteTarifa | null;
  valor: number;
  vigenteDesde: string;
  vigenteHasta: string | null;
  fijadoPor: UsuarioRef | null;
  fijadoEn: string;
  cerradoPor: UsuarioRef | null;
  cerradoEn: string | null;
}

/** Lo que `PATCH /tarifas/:id` devuelve además de la vigencia: las dos cifras leídas en la transacción. */
export interface ResultadoCambioTarifa {
  id: string;
  valorAnterior: number;
  valorNuevo: number | null;
}

/** Una vigencia abierta de `GET /tarifas` (sin `companiaId`): lo justo para contar faltantes. */
export interface TarifaAbierta { id: string; companiaId: number }

export const RUTA_TARIFAS = '/flito/parametrizacion/tarifas';

export type LlaveTarifa = (typeof LLAVES_TARIFA)[number];

/** «Matrícula», «Traspaso», «Otros», «Logística»: de los catálogos, nunca escrito a mano. */
export function etiquetaLlave(k: { concepto: ConceptoTarifa; tipoTramite: TipoTramiteTarifa | null }): string {
  return k.concepto === 'logistica' ? 'Logística' : TIPO_TRAMITE_TARIFA_LABEL[k.tipoTramite ?? 'OTROS'];
}

/** Clave estable de una llave para `key` y para comparar pills. */
export const claveLlave = (k: { concepto: ConceptoTarifa; tipoTramite: TipoTramiteTarifa | null }): string =>
  `${k.concepto}:${k.tipoTramite ?? ''}`;

const FORMATO_PESOS = new Intl.NumberFormat('es-CO', {
  style: 'currency', currency: 'COP', minimumFractionDigits: 0, maximumFractionDigits: 2,
});

/** «$270.000» y «$1.500,50». Sin el espacio que `toLocaleString` mete en algunos motores. */
export const pesosTarifa = (n: number): string => FORMATO_PESOS.format(n).replace(/\s/g, '');

const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** Instante ISO → «1 sep 2026», en la zona local. */
export function fechaCorta(iso: string | null): string {
  if (!iso) return '—';
  const f = new Date(iso);
  if (Number.isNaN(f.getTime())) return '—';
  return `${f.getDate()} ${MESES_CORTOS[f.getMonth()]} ${f.getFullYear()}`;
}

/** Día 'yyyy-mm-dd' → «1 ago 2026», sin pasar por `Date` (medianoche UTC retrocede un día en Colombia). */
export function diaCorto(dia: string): string {
  const [y, m, d] = dia.split('-').map(Number);
  if (!y || !m || !d) return dia;
  return `${d} ${MESES_CORTOS[m - 1]} ${y}`;
}

/** Instante ISO → «3 sep 2026, 4:02 p. m.». La hora la pone `Intl`; el día se arma a mano. */
export function fechaHoraCorta(iso: string | null): string {
  if (!iso) return '—';
  const f = new Date(iso);
  if (Number.isNaN(f.getTime())) return '—';
  const hora = f.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit' });
  return `${fechaCorta(iso)}, ${hora}`;
}

/** El nombre que se pinta: nunca el id. */
export function nombreUsuario(u: UsuarioRef | null): string {
  if (u === null) return 'Sistema';
  return u.nombre ?? 'Usuario retirado';
}

export type ValidacionValor = { ok: true; valor: number } | { ok: false; mensaje: string };

/**
 * AC6: negativo, vacío, letras o tres decimales se rechazan ANTES de cualquier petición.
 * Acepta coma o punto como separador decimal (teclado colombiano) y lo normaliza a punto.
 * `vigente` es el valor que ya rige: guardar el mismo se rechaza aquí y se dice por qué.
 */
export function validarValorTarifa(texto: string, vigente: number | null): ValidacionValor {
  const limpio = texto.trim().replace(',', '.');
  if (limpio === '') return { ok: false, mensaje: 'Escribe el valor.' };
  if (limpio.startsWith('-')) return { ok: false, mensaje: 'El valor no puede ser negativo.' };
  if (!/^\d+(\.\d+)?$/.test(limpio)) return { ok: false, mensaje: 'Solo números, con hasta dos decimales.' };
  const decimales = limpio.split('.')[1] ?? '';
  if (decimales.length > 2) return { ok: false, mensaje: 'Hasta dos decimales.' };
  const valor = Number(limpio);
  if (valor > TARIFA_VALOR_MAX) return { ok: false, mensaje: 'El valor supera el máximo admitido.' };
  if (vigente !== null && valor === vigente) return { ok: false, mensaje: 'Es el mismo valor que ya rige.' };
  return { ok: true, valor };
}

/** «Faltan n» por cliente = las cuatro llaves menos las vigencias abiertas que tiene. */
export function faltantesPorCompania(abiertas: TarifaAbierta[]): Map<number, number> {
  const cuenta = new Map<number, number>();
  for (const t of abiertas) cuenta.set(t.companiaId, (cuenta.get(t.companiaId) ?? 0) + 1);
  const faltan = new Map<number, number>();
  for (const [id, n] of cuenta) faltan.set(id, Math.max(0, LLAVES_TARIFA.length - n));
  return faltan;
}

/** Cuántos valores le faltan a un cliente; sin entrada en el mapa, le faltan los cuatro. */
export const faltantesDe = (faltan: Map<number, number>, companiaId: number): number =>
  faltan.get(companiaId) ?? LLAVES_TARIFA.length;

/** Compara nombres sin tildes ni mayúsculas, para la búsqueda en cliente. */
export const normalizaTexto = (s: string): string =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
