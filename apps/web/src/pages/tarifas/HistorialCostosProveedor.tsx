// FLITO — Tarifas › Proveedores · historial de vigencias del proveedor (Épica #13763, ADR-0041 §6).
// Diseño: `docs/ux/flito-tarifas-proveedores.md` «Historial». Mismo acordeón que Clientes (`HistorialTarifas`),
// con «Hasta» y «Cerró». Se pide solo al abrirlo y se repide tras cada escritura mientras esté abierto.
//
// Vigencia LATENTE (abierta, pero el proveedor ya no presta su servicio: `servicioAsignado: false`) → en
// «Hasta» dice «Sin servicio asignado», no «Vigente». Sin rojo en ningún estado.

import { useEffect, useState, type RefObject } from 'react';
import type { ConceptoCostoProveedor, VigenciaCostoProveedor } from '@operaciones/shared-types';
import { fechaCorta, nombreUsuario, pesosTarifa } from '../../lib/tarifas';
import { etiquetaConcepto, tarifasProveedorApi } from '../../lib/tarifas-proveedor';
import FlitAcordeon from '../../components/flit/FlitAcordeon';
import StatusChip from '../../components/flit/StatusChip';
import {
  FlitEmpty, FlitPillButton, FlitPillGroup, FlitTable, FlitTh, FlitTr, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../../components/flit/flitPageKit';
import { AvisoTonal, useEsEscritorio } from './CostosProveedor';

export type FiltroHistorialProveedor = ConceptoCostoProveedor | 'todos';

interface Props {
  proveedorId: string;
  proveedorNombre: string;
  /** Conceptos de los servicios que tiene HOY: son las únicas pills. */
  conceptos: ConceptoCostoProveedor[];
  abierto: boolean;
  onToggle: () => void;
  filtro: FiltroHistorialProveedor;
  onFiltro: (f: FiltroHistorialProveedor) => void;
  version: number;
  tituloRef: RefObject<HTMLElement | null>;
}

const celda = 'px-4 py-3 text-sm align-top';
const SIN_SERVICIO = 'Sin servicio asignado';

function Hasta({ v }: { v: VigenciaCostoProveedor }) {
  if (v.vigenteHasta !== null) return <>{fechaCorta(v.vigenteHasta)}</>;
  if (!v.servicioAsignado) return <span style={{ color: 'var(--flit-text-secondary)' }}>{SIN_SERVICIO}</span>;
  return <StatusChip tone="active">Vigente</StatusChip>;
}

export default function HistorialCostosProveedor({
  proveedorId, proveedorNombre, conceptos, abierto, onToggle, filtro, onFiltro, version, tituloRef,
}: Props) {
  const escritorio = useEsEscritorio();
  const [filas, setFilas] = useState<VigenciaCostoProveedor[] | null>(null);
  const [error, setError] = useState(false);
  const [reintento, setReintento] = useState(0);

  useEffect(() => { setFilas(null); setError(false); }, [proveedorId]);

  useEffect(() => {
    if (!abierto) return;
    let vigente = true;
    setFilas(null); setError(false);
    tarifasProveedorApi.historial(proveedorId, filtro === 'todos' ? null : filtro)
      .then((r) => { if (vigente) setFilas(r); })
      .catch(() => { if (vigente) setError(true); });
    return () => { vigente = false; };
  }, [abierto, proveedorId, filtro, version, reintento]);

  const conTodos = filtro === 'todos';
  const reintentar = () => setReintento((n) => n + 1);

  return (
    <FlitAcordeon titulo={`Historial de ${proveedorNombre}`} descripcion="Cada cambio, del más reciente al más antiguo"
      abierto={abierto} onToggle={onToggle}>
      <div className="space-y-4">
        <FlitPillGroup label="Servicio del historial">
          <FlitPillButton active={conTodos} pressed={conTodos} onClick={() => onFiltro('todos')}>Todos</FlitPillButton>
          {conceptos.map((c) => (
            <FlitPillButton key={c} active={filtro === c} pressed={filtro === c} onClick={() => onFiltro(c)}>
              {etiquetaConcepto(c)}
            </FlitPillButton>
          ))}
        </FlitPillGroup>
        <span ref={tituloRef as RefObject<HTMLSpanElement>} tabIndex={-1} className="sr-only">
          Historial de {conTodos ? 'todos los servicios' : etiquetaConcepto(filtro)} de {proveedorNombre}
        </span>

        {error ? (
          <AvisoTonal tono="activo" rol="alert" icono="!"
            accion={<button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={reintentar}>Reintentar</button>}>
            <p className="font-semibold">No se pudo cargar el historial.</p>
          </AvisoTonal>
        ) : filas === null ? (
          <div role="status" aria-busy="true" aria-label="Cargando el historial"
            className={escritorio ? 'space-y-2' : 'grid grid-cols-1 gap-3 md:grid-cols-2'}>
            {[0, 1, 2].map((i) => (
              <div key={i} className={`${escritorio ? 'h-8' : 'h-24'} animate-pulse rounded`} style={{ background: 'var(--flit-bg-table-header)' }} />
            ))}
          </div>
        ) : filas.length === 0 ? (
          <FlitEmpty>
            {conTodos ? (
              <>
                <p style={{ color: 'var(--flit-text-primary)' }}>Todavía no hay valores fijados para {proveedorNombre}.</p>
                <p className="mt-1">Cuando fijes el primero, aquí queda con su fecha y quién lo fijó.</p>
              </>
            ) : (
              <>
                <p style={{ color: 'var(--flit-text-primary)' }}>Este servicio todavía no tiene valores fijados.</p>
                <button type="button" className={`${flitBtnSecondary} mt-3`} style={flitBtnSecondaryStyle} onClick={() => onFiltro('todos')}>Ver todos</button>
              </>
            )}
          </FlitEmpty>
        ) : escritorio ? (
          <FlitTable label={`Historial de ${proveedorNombre}`}>
            <thead>
              <FlitTr>
                {conTodos && <FlitTh>Servicio</FlitTh>}
                <FlitTh>Valor</FlitTh>
                <FlitTh>Desde</FlitTh>
                <FlitTh>Hasta</FlitTh>
                <FlitTh>Fijó</FlitTh>
                <FlitTh>Cerró</FlitTh>
              </FlitTr>
            </thead>
            <tbody>
              {filas.map((v) => (
                <FlitTr key={v.id}>
                  {conTodos && <td className={`${celda} font-medium`} style={{ color: 'var(--flit-text-primary)' }}>{etiquetaConcepto(v.concepto)}</td>}
                  <td className={`${celda} tabular-nums`} style={{ color: 'var(--flit-text-primary)' }}>{pesosTarifa(v.valor)}</td>
                  <td className={celda} style={{ color: 'var(--flit-text-secondary)' }}>{fechaCorta(v.vigenteDesde)}</td>
                  <td className={celda} style={{ color: 'var(--flit-text-secondary)' }}><Hasta v={v} /></td>
                  <td className={celda} style={{ color: 'var(--flit-text-primary)' }}>{nombreUsuario(v.fijadoPor)}</td>
                  <td className={celda} style={{ color: v.cerradoEn ? 'var(--flit-text-primary)' : 'var(--flit-text-muted)' }}>
                    {v.cerradoEn ? nombreUsuario(v.cerradoPor) : '—'}
                  </td>
                </FlitTr>
              ))}
            </tbody>
          </FlitTable>
        ) : (
          <ul aria-label={`Historial de ${proveedorNombre}`} className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {filas.map((v) => (
              <li key={v.id} className="min-w-0 rounded-xl border p-4" style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-card)' }}>
                {conTodos && <p className="break-words text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{etiquetaConcepto(v.concepto)}</p>}
                <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xl font-bold tabular-nums" style={{ color: 'var(--flit-text-primary)' }}>{pesosTarifa(v.valor)}</span>
                  {v.vigenteHasta === null && v.servicioAsignado && <StatusChip tone="active">Vigente</StatusChip>}
                </div>
                <p className="mt-1 break-words text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
                  {fechaCorta(v.vigenteDesde)} → {v.vigenteHasta !== null ? fechaCorta(v.vigenteHasta) : v.servicioAsignado ? 'Vigente' : SIN_SERVICIO}
                </p>
                <p className="mt-0.5 break-words text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
                  Fijó {nombreUsuario(v.fijadoPor)}{v.cerradoEn ? ` · Cerró ${nombreUsuario(v.cerradoPor)}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </FlitAcordeon>
  );
}
