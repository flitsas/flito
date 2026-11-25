// FLITO Logística — Mi ruta · recogida de LT (HU #14111). Tipos de la lista del mensajero, copy por
// resultado y mapa de errores del API → texto pulido. Nunca se muestra el mensaje crudo del servidor.

import type { ChipTone } from '../../flit/StatusChip';

export interface Candidato {
  tramiteId: string; idFlit: string; companiaNombre: string | null; organismoCodigo: string | null; gestionable: boolean;
  vin?: string | null; organismoNombre?: string | null;
  vehiculo?: { marca: string | null; linea: string | null; modelo: number | null };
}
export type ResultadoEscaneo = 'recogido' | 'novedad' | 'duplicado' | 'sin_match' | 'no_gestionable' | 'elegir_tramite';
export interface RespuestaEscaneo {
  resultado: ResultadoEscaneo; documentoId?: string; placa: string; vin: string; idFlit?: string;
  numeroLicencia?: string; propietarioNombre?: string | null; motivo?: string | null; candidatos?: Candidato[]; pendienteTramite?: boolean;
  /** HU #14161: el servidor ya devuelve organismo y compañía (compañía null en pendientes de trámite). */
  organismoCodigo?: string | null; companiaNombre?: string | null;
}
export interface RespuestaValidacion {
  resultado: 'relacionada' | 'novedad' | 'sin_match' | 'no_gestionable' | 'ya_registrada' | 'elegir_tramite';
  motivo?: string | null; candidatos?: Candidato[]; organismoCodigo?: string | null; companiaNombre?: string | null;
}
export type RespuestaConsulta = { encontrado: false } | { encontrado: true; candidatos: Candidato[] };
export interface RecogidaConfirmada { firmanteId: string; actas: Array<{ actaId: string; companiaId: number; documentos: number }>; pendientesTramite: number }

/** HU #14161: una LT escaneada y registrada cuya acta aún no tiene la firma del funcionario. */
export interface PendienteFirma {
  documentoId: string; placa: string | null; numeroLt: string | null; idFlit: string | null; companiaId: number | null; companiaNombre: string | null;
  organismoCodigo: string; pendienteTramite: boolean; estado: string; fecha: string;
}
export interface RespuestaPendientesFirma { pendientes: PendienteFirma[] }
export interface ResumenRecogidaMia { firmanteId: string; organismoCodigo: string; nombre: string; documentoEnmascarado: string | null; firmadoEn: string; actas: number; pendientesTramite: number; estadoFirma: 'firmada' }
export interface RespuestaMisRecogidas { recogidas: ResumenRecogidaMia[]; pendientesFirma: number }

/** Una pendiente de firma como fila del paso «Confirmar recogida» (reusa el flujo existente). */
export const filaDePendiente = (p: PendienteFirma): FilaLt => ({
  key: p.documentoId, manual: null, rawValue: null, placa: p.placa ?? '', vin: null, propietario: null, numeroLicencia: '', combustible: null,
  numeroLt: p.numeroLt ?? '', estado: p.pendienteTramite ? 'pendiente' : 'lista', motivo: null, candidatos: null,
  organismoCodigo: p.organismoCodigo, companiaNombre: p.companiaNombre, documentoId: p.documentoId, registro: 'registrada',
});

export interface DatosManual { placa: string; numeroLicencia: string; numeroLt: string }

export type EstadoLt = 'validando' | 'lista' | 'novedad' | 'ya_registrada' | 'sin_tramite' | 'no_gestionable' | 'elegir' | 'pendiente' | 'sin_conexion' | 'error';
export type Registro = 'no' | 'registrando' | 'registrada' | 'encolada' | 'error';

/** Una LT de la lista del mensajero. La cédula del funcionario NUNCA vive aquí. */
export interface FilaLt {
  key: string; manual: DatosManual | null; rawValue: string | null;
  placa: string; vin: string | null; propietario: string | null; numeroLicencia: string; combustible: string | null;
  numeroLt: string; estado: EstadoLt; motivo: string | null; candidatos: Candidato[] | null;
  tramiteId?: string; dejarPendiente?: boolean; organismoCodigo: string | null; companiaNombre: string | null;
  documentoId?: string; registro: Registro; firmada?: boolean;
}

export const CHIP: Record<EstadoLt, { tono: ChipTone; texto: string }> = {
  validando: { tono: 'neutral', texto: 'Validando…' },
  lista: { tono: 'success', texto: 'Lista' },
  novedad: { tono: 'warning', texto: 'Con novedad' },
  ya_registrada: { tono: 'neutral', texto: 'Ya registrada' },
  sin_tramite: { tono: 'danger', texto: 'Sin trámite' },
  no_gestionable: { tono: 'neutral', texto: 'No la recoge FLITO' },
  elegir: { tono: 'active', texto: 'Elige trámite' },
  pendiente: { tono: 'warning', texto: 'Pendiente de trámite' },
  sin_conexion: { tono: 'neutral', texto: 'Sin validar' },
  error: { tono: 'danger', texto: 'Error' },
};

export const TEXTO_ESTADO: Partial<Record<EstadoLt, string>> = {
  novedad: 'El VIN no coincide con el del vehículo. Se registra igual y Operaciones la revisa.',
  ya_registrada: 'Esta LT ya fue recogida. No se incluye de nuevo.',
  no_gestionable: 'Este trámite lo gestiona el cliente. No se recoge.',
  pendiente: 'Operaciones elegirá el trámite. La LT queda firmada igualmente.',
  sin_conexion: 'Sin señal: no se pudo validar. Se registrará al continuar.',
};

/** El mensajero ve un texto propio por motivo; el del servidor solo se usa para clasificar. */
export function textoSinTramite(motivo: string | null): string {
  if (motivo && /pendiente de LT/i.test(motivo)) return 'El vehículo no tiene un trámite aprobado pendiente de LT.';
  return 'No encontramos este vehículo en FLITO. Revisa la placa o avisa a Operaciones.';
}

/** Cuenta para el botón «Continuar»: lo que se confirmará (no duplicadas, sin trámite ni no gestionables). */
export const entra = (f: FilaLt): boolean => ['lista', 'novedad', 'pendiente', 'sin_conexion'].includes(f.estado);

export const estadoDeEscaneo = (r: RespuestaEscaneo): EstadoLt => {
  switch (r.resultado) {
    case 'recogido': return r.pendienteTramite ? 'pendiente' : 'lista';
    case 'novedad': return r.pendienteTramite ? 'pendiente' : 'novedad';
    case 'duplicado': return 'ya_registrada';
    case 'sin_match': return 'sin_tramite';
    case 'no_gestionable': return 'no_gestionable';
    default: return 'elegir';
  }
};
export const estadoDeValidacion = (r: RespuestaValidacion): EstadoLt => {
  switch (r.resultado) {
    case 'relacionada': return 'lista';
    case 'novedad': return 'novedad';
    case 'ya_registrada': return 'ya_registrada';
    case 'sin_match': return 'sin_tramite';
    case 'no_gestionable': return 'no_gestionable';
    default: return 'elegir';
  }
};

// ── Errores ──────────────────────────────────────────────────────────────────

const statusDe = (e: unknown): number => (e && typeof e === 'object' && 'status' in e ? Number((e as { status: unknown }).status) : 0);
export const codigoDe = (e: unknown): string | null => {
  const d = e && typeof e === 'object' && 'rawDetails' in e ? (e as { rawDetails?: unknown }).rawDetails : null;
  const c = d && typeof d === 'object' ? (d as { codigo?: unknown; detalle?: { code?: unknown } }) : null;
  const v = c?.codigo ?? c?.detalle?.code;
  return typeof v === 'string' ? v : null;
};

export function mensajeConsulta(e: unknown): string {
  if (statusDe(e) === 429) return 'Demasiadas consultas seguidas. Espera un minuto e inténtalo de nuevo.';
  if (statusDe(e) === 403) return 'Tu usuario no puede consultar vehículos.';
  return 'No pudimos consultar la placa. Revisa la señal e inténtalo de nuevo.';
}
export function mensajeEscanear(e: unknown): string {
  const s = statusDe(e);
  if (s === 403) return 'Tu usuario no puede registrar LT. Pide a Operaciones que lo habilite.';
  if (s === 422 || s === 400) return 'Revisa los datos de la LT: el N.º de sustrato empieza por LT.';
  if (s === 429) return 'Demasiados intentos seguidos. Espera un momento y reintenta.';
  return 'No pudimos registrar la LT. Revisa la señal e inténtalo de nuevo.';
}
export function mensajeConfirmar(e: unknown): string {
  const s = statusDe(e); const c = codigoDe(e);
  if (c === 'LT_ESTADO_NO_CONFIRMABLE') return 'Algunas LT no se pueden confirmar porque ya tienen otro estado. Quítalas de la lista y vuelve a intentar.';
  if (c === 'LT_YA_EN_ACTA_ORGANISMO') return 'Una de estas LT ya está en un acta de recogida. Quítala y confirma las demás.';
  if (s === 403) return 'Tu usuario no puede confirmar recogidas. Pide a Operaciones que lo haga.';
  if (s === 422) return 'La firma no se pudo guardar. Bórrala y firma de nuevo.';
  if (s === 429) return 'Demasiados intentos seguidos. Espera un momento y reintenta.';
  return 'No pudimos confirmar la recogida. Revisa la señal e inténtalo de nuevo. Lo que escribiste se conserva.';
}

export const nuevaKey = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
