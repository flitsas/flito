// FLITO — canal Cliente del SOAT: el selector «Tipo de SOAT» (HU #14019, docs/ux/flito-soat-cliente-tipo-renovacion-slim.md §3–§4, §9).
//
// Un `radiogroup` de radios REALES con su `<label>` (flechas y foco nativos). **Sin valor por defecto**
// (AC1): hasta que el Cliente elija, la página no pinta bloques ni barra.
//
// Cambiar de tipo con datos escritos o consultados pide confirmación (AC6): el modal vive aquí y la
// página solo recibe el cambio ya decidido. El cambio PROGRAMÁTICO («Renovar» del 409) no pasa por
// este componente: lo hace la página sin preguntar.

import { useRef, useState } from 'react';
import { ClipboardList } from 'lucide-react';
import { TipoSoat } from '@operaciones/shared-types';
import FlitModal from '../../flit/FlitModal';
import { flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';
import {
  ANUNCIO_TIPO, TEXTO_CAMBIAR_TIPO, TITULO_CAMBIAR_TIPO,
} from '../../../lib/mensajesTipoSoat';
import { Seccion } from './bloques';

const OPCIONES: { tipo: TipoSoat; titulo: string; texto: string }[] = [
  {
    tipo: TipoSoat.INICIAL, titulo: 'SOAT inicial',
    texto: 'Vehículo nuevo o que nunca ha tenido SOAT. Se consulta por el VIN.',
  },
  {
    tipo: TipoSoat.RENOVACION, titulo: 'Renovación',
    texto: 'El vehículo ya tuvo SOAT. Se consulta por placa y documento del propietario.',
  },
];

export default function SelectorTipoSoat({ valor, hayDatos, onCambiar, error }: {
  valor: TipoSoat | null;
  /** Hay algo escrito o consultado que el cambio borraría. */
  hayDatos: boolean;
  onCambiar: (t: TipoSoat) => void;
  /** «Elija el tipo de SOAT antes de consultar.» si algún camino intentara consultar sin tipo. */
  error?: string;
}) {
  const [pendiente, setPendiente] = useState<TipoSoat | null>(null);
  const [anuncio, setAnuncio] = useState('');
  const radios = useRef<Partial<Record<TipoSoat, HTMLInputElement | null>>>({});

  const elegir = (t: TipoSoat) => {
    if (t === valor) return;
    if (valor !== null && hayDatos) { setPendiente(t); return; }
    aplicar(t);
  };
  const aplicar = (t: TipoSoat) => {
    onCambiar(t);
    setAnuncio(ANUNCIO_TIPO[t]);
    // Tras el cambio manual el foco queda en la tarjeta de tipo (UX §4).
    requestAnimationFrame(() => radios.current[t]?.focus());
  };

  return (
    <>
      <Seccion titulo="Tipo de SOAT" icono={<ClipboardList size={18} aria-hidden="true" className="shrink-0" />}>
        <div role="radiogroup" aria-label="Tipo de SOAT" aria-describedby={error ? 'sol-tipo-error' : undefined} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {OPCIONES.map((o) => {
            const marcada = valor === o.tipo;
            const idDesc = `tipo-soat-${o.tipo}-desc`;
            return (
              // El nombre accesible del radio es SOLO el título; la descripción va por `aria-describedby`.
              // El `<label>` se estira (`after:inset-0`) para que toda la tarjeta sea objetivo táctil.
              <div
                key={o.tipo}
                className="relative flex min-h-[44px] items-start gap-3 rounded-[10px] p-4 transition-colors hover:bg-[var(--flit-bg-hover)] has-[:focus-visible]:shadow-[0_0_0_3px_var(--flit-border-focus)]"
                style={{
                  border: marcada ? '2px solid var(--flit-blue-text)' : '1px solid var(--flit-border-soft)',
                  background: marcada ? 'var(--flit-bg-app)' : undefined,
                  padding: marcada ? 'calc(1rem - 1px)' : undefined,
                }}
              >
                <input
                  ref={(el) => { radios.current[o.tipo] = el; }}
                  id={`tipo-soat-${o.tipo}`} type="radio" name="tipo-soat" value={o.tipo} checked={marcada}
                  aria-describedby={idDesc} onChange={() => elegir(o.tipo)}
                  className="relative z-10 mt-1 h-4 w-4 shrink-0 cursor-pointer accent-[var(--flit-blue-text)] outline-none"
                />
                <div className="min-w-0 space-y-1">
                  <label
                    htmlFor={`tipo-soat-${o.tipo}`}
                    className="block cursor-pointer text-sm font-semibold after:absolute after:inset-0 after:content-['']"
                    style={{ color: 'var(--flit-text-primary)' }}
                  >
                    {o.titulo}
                  </label>
                  <p id={idDesc} className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{o.texto}</p>
                </div>
              </div>
            );
          })}
        </div>
        {error && (
          <p id="sol-tipo-error" role="alert" className="mt-2 text-xs font-semibold" style={{ color: 'var(--flit-danger-text)' }}>{error}</p>
        )}
        <p aria-live="polite" className="sr-only">{anuncio}</p>
      </Seccion>

      {pendiente && (
        <FlitModal
          title={TITULO_CAMBIAR_TIPO} onClose={() => setPendiente(null)}
          restoreFocusRef={{ current: valor ? radios.current[valor] ?? null : null }}
        >
          <div className="space-y-3 text-sm">
            <p>{TEXTO_CAMBIAR_TIPO}</p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
              <button type="button" className={`${flitBtnSecondary} justify-center`} style={flitBtnSecondaryStyle}
                onClick={() => setPendiente(null)}>Mantener</button>
              <button type="button" className={`${flitBtnPrimary} justify-center`} style={flitBtnPrimaryStyle}
                onClick={() => { const t = pendiente; setPendiente(null); aplicar(t); }}>Cambiar el tipo</button>
            </div>
          </div>
        </FlitModal>
      )}
    </>
  );
}

