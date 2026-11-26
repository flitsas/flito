// FLITO avisos por usuario (Épica #14707, ADR-0049 §7, diseño §3.3). Módulo PURO: lo consumen API y web.
//
// Hoy un único tipo: `solicitud_retirada` — se descartó un SOAT o un impuesto que el usuario había SOLICITADO
// porque su trámite murió en FLIT (D6; decisión cerrada 7: solo a quien envió la solicitud). El aviso guarda solo
// referencias: la placa y el radicado se resuelven con JOIN al leer (Ley 1581).
//
// API (`/api/flito/avisos`, `authMiddleware`, sin `requireRole`, solo los del usuario del token):
//   GET  /         → `AvisosUsuarioRespuesta` con los NO vistos (máx. `MAX_AVISOS_USUARIO`, del más reciente al
//                    más antiguo) y el conteo total de no vistos. Sin query string: ni placa ni filtro en la URL.
//   POST /visto    → body `MarcarAvisosVistosBody` con la lista EXACTA de ids mostrados (no «todos»: un retiro que
//                    llegó después de pintar el aviso no se oculta). Idempotente; ids ajenos o inexistentes se
//                    ignoran sin pistas. 200 `MarcarAvisosVistosRespuesta`.
import type { MotivoDescarte } from './flito-tramite-vigencia.js';

export const TIPOS_AVISO_USUARIO = ['solicitud_retirada'] as const;
export type TipoAvisoUsuario = (typeof TIPOS_AVISO_USUARIO)[number];

export const CONCEPTOS_AVISO_USUARIO = ['soat', 'impuesto'] as const;
export type ConceptoAvisoUsuario = (typeof CONCEPTOS_AVISO_USUARIO)[number];

/** Tope de avisos por respuesta (el conteo `noVistos` es el total real). */
export const MAX_AVISOS_USUARIO = 50;
/** Tope de ids por llamada a «marcar visto». */
export const MAX_IDS_AVISOS_VISTOS = 200;

export interface AvisoUsuarioDto {
  /** Id opaco (uuid) del aviso. */
  id: string;
  tipo: TipoAvisoUsuario;
  concepto: ConceptoAvisoUsuario;
  motivo: MotivoDescarte;
  /** Radicado FLIT del trámite (JOIN a `flito_tramites`). */
  idFlit: string | null;
  /** Placa del vehículo (JOIN al leer; no se persiste en el aviso). */
  placa: string | null;
  /** ISO 8601. */
  creadoEn: string;
  vistoEn: string | null;
}

export interface AvisosUsuarioRespuesta {
  avisos: AvisoUsuarioDto[];
  noVistos: number;
}

export interface MarcarAvisosVistosBody {
  ids: string[];
}

export interface MarcarAvisosVistosRespuesta {
  /** Avisos propios que pasaron de no visto a visto en esta llamada (los ya vistos y los ajenos no cuentan). */
  marcados: number;
}
