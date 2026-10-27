// FLITO — Tarifas · los dos precios de logística del cliente (HU #14107): «Entrega a cliente» y «Entrega a FLIT».
// Dos paneles en rejilla (una columna en móvil) con valor, desde/quién y las mismas acciones que una fila de
// trámite. La edición en sitio y el guardado viven en `MatrizTarifas`; aquí solo se pinta.

import { useId, type KeyboardEvent, type RefObject } from 'react';
import { etiquetaLlave, fechaCorta, nombreUsuario, pesosTarifa, validarValorTarifa, type FilaVistaTarifa } from '../../lib/tarifas';
import StatusChip from '../../components/flit/StatusChip';
import {
  flitInp, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle, flitBtnSecondarySm,
} from '../../components/flit/flitPageKit';

export const SIN_CONFIGURAR = 'Sin configurar';
const AVISO_FALTA = 'Sin este precio no se puede registrar un viaje con este destino.';

export interface Edicion {
  clave: string;
  texto: string;
  /** Mensaje de validación o del 400 del servidor; se pinta bajo el campo. */
  error: string | null;
  fallo: string | null;
  /** Solo se enseña el error de validación tras intentar guardar o perder el foco. */
  tocado: boolean;
  guardando: boolean;
}

export interface PanelProps {
  fila: FilaVistaTarifa;
  sujeto: string;
  editar: boolean;
  verHistorial: boolean;
  enEdicion: Edicion | null;
  validacion: string | null;
  bloqueado: boolean;
  inputRef: RefObject<HTMLInputElement>;
  registrarBoton: (el: HTMLButtonElement | null) => void;
  registrarCabecera: (el: HTMLElement | null) => void;
  onTexto: (t: string) => void;
  onTocado: () => void;
  onGuardar: () => void;
  onCancelar: () => void;
  onAbrir: () => void;
  onHistorial: () => void;
  onDejarDeCobrar: () => void;
}

export function GrupoLogistica({ gestionaFlito, paneles }: { gestionaFlito: boolean; paneles: PanelProps[] }) {
  return (
    <div className="mt-5">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Logística</h3>
        <StatusChip tone={gestionaFlito ? 'active' : 'neutral'}>
          {gestionaFlito ? 'Gestiona FLITO' : 'Autogestiona el cliente'}
        </StatusChip>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {paneles.map((p) => <PanelPrecio key={p.fila.concepto} {...p} />)}
      </div>
    </div>
  );
}

function PanelPrecio(p: PanelProps) {
  const { fila, sujeto, enEdicion, validacion } = p;
  const idBase = useId();
  const idMensaje = `${idBase}-msg`;
  const idTitulo = `${idBase}-titulo`;
  const etiqueta = etiquetaLlave(fila);
  const tieneValor = fila.valor !== null;
  const guardable = !!enEdicion && !enEdicion.guardando && validarValorTarifa(enEdicion.texto, fila.valor).ok;
  const mensaje = enEdicion?.fallo ?? validacion;

  const teclas = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); if (guardable) p.onGuardar(); else p.onTocado(); }
    if (e.key === 'Escape') { e.preventDefault(); p.onCancelar(); }
  };

  return (
    <section
      aria-labelledby={idTitulo}
      ref={p.registrarCabecera}
      tabIndex={-1}
      data-vigencia={fila.vigenciaId ?? undefined}
      className="flit-focus flex min-w-0 flex-col gap-3 rounded-xl border p-4"
      style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-card)' }}
    >
      <h4 id={idTitulo} className="text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>{etiqueta}</h4>

      {enEdicion ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${idBase}-valor`} className="sr-only">Valor de {sujeto}</label>
          <div className="flex items-center gap-1">
            <span aria-hidden="true">$</span>
            <input
              id={`${idBase}-valor`}
              ref={p.inputRef}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              className={`${flitInp} w-full sm:w-40`}
              value={enEdicion.texto}
              aria-invalid={mensaje ? true : undefined}
              aria-describedby={mensaje ? idMensaje : undefined}
              disabled={enEdicion.guardando}
              onChange={(e) => p.onTexto(e.target.value)}
              onBlur={p.onTocado}
              onKeyDown={teclas}
            />
          </div>
          {tieneValor && (
            <span className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>Antes: {pesosTarifa(fila.valor as number)}</span>
          )}
          {mensaje && (
            <p id={idMensaje} role="alert" className="text-xs font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>{mensaje}</p>
          )}
        </div>
      ) : tieneValor ? (
        <div>
          <p className="text-xl font-semibold tabular-nums" style={{ color: 'var(--flit-text-primary)' }}>{pesosTarifa(fila.valor as number)}</p>
          <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
            Desde {fechaCorta(fila.vigenteDesde)} · {nombreUsuario(fila.fijadoPor)}
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold" style={{ color: 'var(--flit-warning-ink)' }}>
            {SIN_CONFIGURAR}
            <StatusChip tone="warning">Falta</StatusChip>
          </p>
          <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{AVISO_FALTA}</p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {enEdicion ? (
          <>
            <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={!guardable}
              aria-label={`Guardar · ${sujeto}`} onClick={p.onGuardar}>
              {enEdicion.guardando ? 'Guardando…' : 'Guardar'}
            </button>
            <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={enEdicion.guardando}
              aria-label={`Cancelar · ${sujeto}`} onClick={p.onCancelar}>
              Cancelar
            </button>
          </>
        ) : (
          <>
            {p.editar && (
              <button type="button" ref={p.registrarBoton} className={flitBtnSecondarySm} style={flitBtnSecondaryStyle}
                disabled={p.bloqueado} aria-label={`${tieneValor ? 'Cambiar' : 'Fijar valor'} · ${sujeto}`} onClick={p.onAbrir}>
                {tieneValor ? 'Cambiar' : 'Fijar valor'}
              </button>
            )}
            {p.verHistorial && (
              <button type="button" className={flitBtnSecondarySm} style={flitBtnSecondaryStyle}
                disabled={p.bloqueado} aria-label={`Historial · ${sujeto}`} onClick={p.onHistorial}>
                Historial
              </button>
            )}
            {p.editar && (
              <button type="button" className={flitBtnSecondarySm}
                style={{ ...flitBtnSecondaryStyle, color: tieneValor ? 'var(--flit-danger-ink)' : undefined }}
                disabled={p.bloqueado || !tieneValor}
                aria-label={tieneValor ? `Dejar de cobrar · ${sujeto}` : `Dejar de cobrar · ${sujeto} (disponible cuando haya un valor)`}
                onClick={p.onDejarDeCobrar}>
                Dejar de cobrar
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
