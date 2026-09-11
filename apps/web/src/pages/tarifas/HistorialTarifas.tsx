// FLITO — Tarifas · historial de vigencias (HU #12375). Diseño: `docs/ux/flito-configurador-tarifas.md` §6.9.
//
// UNA sola tabla para AC9 (por valor) y AC10 (por cliente con rango): son la misma consulta con un
// filtro distinto. Se pide SOLO al abrir el acordeón y se repide tras cada escritura mientras esté
// abierto. El rango se llama «Fijadas entre» porque el servidor filtra por `vigente_desde`: un
// «dejar de cobrar» dentro del rango cierra sin abrir y no aparece (R2 de la ficha).

import { useEffect, useState, type RefObject } from 'react';
import { LLAVES_TARIFA } from '@operaciones/shared-types';
import { api, errorMessage } from '../../lib/api';
import {
  RUTA_TARIFAS, claveLlave, diaCorto, etiquetaLlave, fechaHoraCorta, nombreUsuario, pesosTarifa,
  type LlaveTarifa, type VigenciaHistorial,
} from '../../lib/tarifas';
import FlitAcordeon from '../../components/flit/FlitAcordeon';
import RangoFechas, { type Rango } from '../../components/flit/RangoFechas';
import StatusChip from '../../components/flit/StatusChip';
import {
  FlitEmpty, FlitPillButton, FlitPillGroup, FlitTable, FlitTh, FlitTr, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../../components/flit/flitPageKit';

export type FiltroHistorial = LlaveTarifa | 'todos';

interface Props {
  companiaId: number;
  companiaNombre: string;
  abierto: boolean;
  onToggle: () => void;
  filtro: FiltroHistorial;
  onFiltro: (f: FiltroHistorial) => void;
  /** Cambia tras cada escritura: si el acordeón está abierto, se repide. */
  version: number;
  /** El título del acordeón, para llevarle el foco al abrir desde una fila. */
  tituloRef: RefObject<HTMLElement | null>;
}

const SIN_RANGO: Rango = { desde: '', hasta: '' };

function consulta(companiaId: number, filtro: FiltroHistorial, rango: Rango): string {
  const q = new URLSearchParams();
  if (filtro !== 'todos') {
    q.set('concepto', filtro.concepto);
    if (filtro.tipoTramite) q.set('tipoTramite', filtro.tipoTramite);
  }
  if (rango.desde) q.set('desde', rango.desde);
  if (rango.hasta) q.set('hasta', rango.hasta);
  const s = q.toString();
  return `${RUTA_TARIFAS}/companias/${companiaId}/historial${s ? `?${s}` : ''}`;
}

const celda = 'px-4 py-3 text-sm align-top';

export default function HistorialTarifas({ companiaId, companiaNombre, abierto, onToggle, filtro, onFiltro, version, tituloRef }: Props) {
  const [rango, setRango] = useState<Rango>(SIN_RANGO);
  const [filas, setFilas] = useState<VigenciaHistorial[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reintento, setReintento] = useState(0);

  // El filtro no sobrevive al cambio de cliente (§6.9): vuelve a «Todos» y sin rango.
  useEffect(() => { setRango(SIN_RANGO); setFilas(null); setError(null); }, [companiaId]);

  useEffect(() => {
    if (!abierto) return;
    let vigente = true;
    setFilas(null); setError(null);
    api.get<VigenciaHistorial[]>(consulta(companiaId, filtro, rango))
      .then((r) => { if (vigente) setFilas(r); })
      .catch((e) => { if (vigente) setError(errorMessage(e)); });
    return () => { vigente = false; };
  }, [abierto, companiaId, filtro, rango, version, reintento]);

  const conTodos = filtro === 'todos';
  const etiquetaFiltro = conTodos ? 'todas las llaves' : etiquetaLlave(filtro);
  const hayFiltro = !conTodos || !!rango.desde;

  return (
    <div>
      <FlitAcordeon
        titulo="Historial de vigencias"
        descripcion="Cada cambio, del más reciente al más antiguo"
        abierto={abierto}
        onToggle={onToggle}
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <FlitPillGroup label="Trámite del historial">
              <FlitPillButton active={conTodos} pressed={conTodos} onClick={() => onFiltro('todos')}>Todos</FlitPillButton>
              {LLAVES_TARIFA.map((k) => {
                const puesta = !conTodos && claveLlave(filtro) === claveLlave(k);
                return (
                  <FlitPillButton key={claveLlave(k)} active={puesta} pressed={puesta} onClick={() => onFiltro(k)}>
                    {etiquetaLlave(k)}
                  </FlitPillButton>
                );
              })}
            </FlitPillGroup>
            <RangoFechas etiqueta="Fijadas entre" valor={rango} onCambio={setRango} />
          </div>
          {/* Foco al abrir desde una fila: el título del acordeón es el `<button>` del kit; se apunta al bloque. */}
          <span ref={tituloRef as RefObject<HTMLSpanElement>} tabIndex={-1} className="sr-only">
            Historial de {etiquetaFiltro} de {companiaNombre}
          </span>

          {error ? (
            <div className="flex flex-wrap items-center gap-3">
              <p role="alert" className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>No se pudo cargar el historial. {error}</p>
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setReintento((n) => n + 1)}>Reintentar</button>
            </div>
          ) : filas === null ? (
            <div role="status" aria-busy="true" aria-label="Cargando el historial" className="space-y-2">
              {[0, 1, 2].map((i) => <div key={i} className="h-8 animate-pulse rounded" style={{ background: 'var(--flit-bg-table-header)' }} />)}
            </div>
          ) : filas.length === 0 ? (
            <FlitEmpty>
              {hayFiltro ? (
                <div className="space-y-3">
                  <p>
                    Ninguna vigencia de {etiquetaFiltro}
                    {rango.desde ? ` fijada entre el ${diaCorto(rango.desde)} y el ${rango.hasta ? diaCorto(rango.hasta) : 'día de hoy'}` : ''}.
                  </p>
                  <div className="flex flex-wrap justify-center gap-2">
                    {rango.desde && (
                      <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setRango(SIN_RANGO)}>Quitar el rango</button>
                    )}
                    {!conTodos && (
                      <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => onFiltro('todos')}>Ver todos los trámites</button>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  <p style={{ color: 'var(--flit-text-primary)' }}>Este cliente todavía no tiene ninguna vigencia.</p>
                  <p className="mt-1">Cuando se fije un valor, aquí quedará cada cambio con quién lo hizo y cuándo.</p>
                </>
              )}
            </FlitEmpty>
          ) : (
            <FlitTable label={`Historial de ${etiquetaFiltro} de ${companiaNombre}`}>
              <thead>
                <FlitTr>
                  {conTodos && <FlitTh>Trámite</FlitTh>}
                  <FlitTh>Valor</FlitTh>
                  <FlitTh>Desde</FlitTh>
                  <FlitTh>Hasta</FlitTh>
                  <FlitTh>Fijado por</FlitTh>
                  <FlitTh>Cerrado por</FlitTh>
                </FlitTr>
              </thead>
              <tbody>
                {filas.map((v) => (
                  <FlitTr key={v.id}>
                    {conTodos && <td className={`${celda} font-medium`} style={{ color: 'var(--flit-text-primary)' }}>{etiquetaLlave(v)}</td>}
                    <td className={`${celda} tabular-nums`} style={{ color: 'var(--flit-text-primary)' }}>{pesosTarifa(v.valor)}</td>
                    <td className={celda} style={{ color: 'var(--flit-text-secondary)' }}>{fechaHoraCorta(v.vigenteDesde)}</td>
                    <td className={celda} style={{ color: 'var(--flit-text-secondary)' }}>
                      {v.vigenteHasta === null ? <StatusChip tone="success">Vigente</StatusChip> : fechaHoraCorta(v.vigenteHasta)}
                    </td>
                    <td className={celda}>
                      <Persona ref_={v.fijadoPor} cuando={v.fijadoEn} />
                    </td>
                    <td className={celda}>
                      {v.cerradoPor === null && v.cerradoEn === null
                        ? <span style={{ color: 'var(--flit-text-muted)' }}>—</span>
                        : <Persona ref_={v.cerradoPor} cuando={v.cerradoEn} />}
                    </td>
                  </FlitTr>
                ))}
              </tbody>
            </FlitTable>
          )}
        </div>
      </FlitAcordeon>
    </div>
  );
}

/** Nombre + instante en dos líneas. `nombre: null` = usuario retirado; `ref_: null` = Sistema. */
function Persona({ ref_, cuando }: { ref_: VigenciaHistorial['fijadoPor']; cuando: string | null }) {
  const retirado = ref_ !== null && ref_.nombre === null;
  return (
    <div className="flex flex-col">
      <span style={{ color: retirado ? 'var(--flit-text-muted)' : 'var(--flit-text-primary)' }}>{nombreUsuario(ref_)}</span>
      <span className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{fechaHoraCorta(cuando)}</span>
    </div>
  );
}
