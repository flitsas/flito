// FLITO Revisiones OCR — buscador de trámite (BUG #14569, punto 8).
//
// `POST /flito/revisiones/:id/candidatos/buscar` con las llaves (texto, placa, VIN) en el BODY: la
// placa es cuasi-PII y nunca va en la URL (AGENTS.md §14). El hook aplaza la consulta 300 ms, descarta
// la respuesta que llega tarde (la última consulta gana) y conserva el `registroActual` para que el
// campo siga mostrando el trámite asociado aunque no esté entre los resultados.

import { useEffect, useRef, useState } from 'react';
import {
  CANDIDATOS_REVISION_PLACA_MAX, CANDIDATOS_REVISION_TEXTO_MAX, CANDIDATOS_REVISION_TEXTO_MIN,
  CANDIDATOS_REVISION_VIN_MAX,
  type BuscarCandidatosRevisionBody, type CandidatoRevisionDto, type CandidatosRevisionRespuesta,
} from '@operaciones/shared-types';
import { api, ApiError } from './api';
import { useDebounce } from './useDebounce';

export function buscarCandidatosRevision(revisionId: string, body: BuscarCandidatosRevisionBody) {
  return api.post<CandidatosRevisionRespuesta>(
    `/flito/revisiones/${encodeURIComponent(revisionId)}/candidatos/buscar`, body);
}

/** Igual que `norm()` de la página y que el servidor: mayúsculas, sin espacios ni guiones. */
export const normLlave = (v: string | null | undefined): string => (v ?? '').toUpperCase().replace(/[\s-]/g, '');

/** Texto libre que de verdad se busca: con menos de 3 caracteres cuenta como ausente (manda el auto-filtro). */
export function textoEfectivo(texto: string): string {
  const t = texto.trim();
  return t.length >= CANDIDATOS_REVISION_TEXTO_MIN ? t.slice(0, CANDIDATOS_REVISION_TEXTO_MAX) : '';
}

/**
 * `pista`: no hay nada que buscar (ni texto ni placa ni VIN). `inactivo`: no se busca (solo lectura).
 * `lista` puede venir con `items` vacío: es el «sin resultados».
 */
export type EstadoCandidatos = 'inactivo' | 'pista' | 'cargando' | 'error' | 'lista';

interface Consulta { texto: string; placa: string; vin: string }
type Resultado =
  | { clave: string; estado: 'lista'; data: CandidatosRevisionRespuesta; seq: number }
  | { clave: string; estado: 'error' };

export interface CandidatosRevision {
  estado: EstadoCandidatos;
  /** La consulta a la que corresponde `items` (texto efectivo y llaves normalizadas). */
  consulta: Consulta;
  /** Cambia con cada respuesta nueva: la página la usa para reevaluar la auto-selección una sola vez. */
  claveRespuesta: string | null;
  items: CandidatoRevisionDto[];
  total: number;
  truncado: boolean;
  registroActual: CandidatoRevisionDto | null;
  reintentar: () => void;
}

export function useCandidatosRevision(revisionId: string, { texto, placa, vin, habilitado, conRegistro }: {
  texto: string; placa: string; vin: string; habilitado: boolean;
  /** La revisión ya trae `registroId`: aunque no haya llaves, se consulta para obtener `registroActual`. */
  conRegistro: boolean;
}): CandidatosRevision {
  const actual: Consulta = {
    texto: textoEfectivo(texto),
    placa: normLlave(placa).slice(0, CANDIDATOS_REVISION_PLACA_MAX),
    vin: normLlave(vin).slice(0, CANDIDATOS_REVISION_VIN_MAX),
  };
  const clave = JSON.stringify([actual.texto, actual.placa, actual.vin]);
  const diferida = useDebounce(clave, 300);
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [registroActual, setRegistroActual] = useState<CandidatoRevisionDto | null>(null);
  const [intento, setIntento] = useState(0);
  const peticion = useRef(0);

  useEffect(() => {
    if (!habilitado) return;
    const [t, p, v] = JSON.parse(diferida) as [string, string, string];
    if (!t && !p && !v && !conRegistro) return;
    const n = ++peticion.current;
    const body: BuscarCandidatosRevisionBody = {};
    if (t) body.texto = t;
    if (p) body.placa = p;
    if (v) body.vin = v;
    buscarCandidatosRevision(revisionId, body)
      .then((data) => {
        if (n !== peticion.current) return;
        setResultado({ clave: diferida, estado: 'lista', data, seq: n });
        if (data.registroActual) setRegistroActual(data.registroActual);
      })
      .catch(() => { if (n === peticion.current) setResultado({ clave: diferida, estado: 'error' }); });
  }, [revisionId, diferida, habilitado, conRegistro, intento]);

  const sinLlaves = !actual.texto && !actual.placa && !actual.vin;
  const vigente = resultado && resultado.clave === clave ? resultado : null;
  const estado: EstadoCandidatos = !habilitado ? 'inactivo'
    : sinLlaves ? 'pista'
    : !vigente ? 'cargando'
    : vigente.estado;
  const data = vigente?.estado === 'lista' && !sinLlaves ? vigente.data : null;

  return {
    estado,
    consulta: actual,
    claveRespuesta: vigente?.estado === 'lista' ? `${vigente.clave}#${vigente.seq}` : null,
    items: data?.items ?? [],
    total: data?.total ?? 0,
    truncado: data?.truncado ?? false,
    registroActual,
    reintentar: () => { setResultado(null); setIntento((i) => i + 1); },
  };
}

// ---------------------------------------------------------------------------
// Reintentar lectura (BUG #14569, punto 9). `POST /flito/revisiones/:id/reintentar-lectura` SIN body:
// el servidor vuelve a leer el soporte guardado y devuelve la revisión con la extracción nueva. No
// resuelve nada: la persona sigue teniendo que confirmar.

export interface ReintentoLecturaRespuesta<R> { revision: R; sinLectura: boolean; camposLeidos: number }

export function reintentarLecturaRevision<R>(revisionId: string) {
  return api.post<ReintentoLecturaRespuesta<R>>(`/flito/revisiones/${encodeURIComponent(revisionId)}/reintentar-lectura`);
}

export const COPY_REINTENTO = {
  red: 'No pudimos reintentar la lectura. Intenta de nuevo.',
  confirmar: 'Se reemplazarán los campos que corregiste con la nueva lectura.',
  actualizada: (n: number) => `Lectura actualizada: ${n} ${n === 1 ? 'campo leído' : 'campos leídos'}. Revisa los campos y el trámite antes de confirmar.`,
  sinLectura: 'El documento se volvió a leer, pero no se obtuvo ningún campo. La revisión no cambió.',
};

/**
 * Los 403/404/409/429/503 de esta ruta traen copy pulido del servidor (`{ error }`) y se muestran tal
 * cual. Cualquier otra cosa (red caída, tope de tiempo, 500 sin copy) cae en el genérico: nunca el
 * texto crudo de la red.
 */
export function mensajeReintento(e: unknown): string {
  if (e instanceof ApiError && [403, 404, 409, 429, 503].includes(e.status) && e.message) return e.message;
  return COPY_REINTENTO.red;
}
