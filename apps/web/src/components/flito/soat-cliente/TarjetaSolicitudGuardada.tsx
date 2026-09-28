// FLITO — canal Cliente: la confirmación de una solicitud guardada con el RUNT caído (HU #12996, AC8).
//
// Spec: docs/ux/flito-soat-solicitud-incompleta-runt.md §2.3 (copy literal). Es un **aviso de
// página** y no un toast: es un estado que sigue siendo cierto y lo más importante de la visita. Un
// toast de 4 s se pierde y el Cliente creería que la solicitud llegó al gestor.
//
// La última frase del cuerpo depende del permiso de reintentar, que llega con la HU #12998: aquí va
// la variante SIN permiso. El VIN se pinta en mono y **nunca** entra a un `aria-label` ni a la URL.

import { useEffect, useRef } from 'react';
import { ArrowRight, RotateCw, ShieldQuestion } from 'lucide-react';
import {
  FlitCard, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../../flit/flitPageKit';

export const TITULO_GUARDADA = 'Su solicitud quedó guardada, pendiente de validar';

export default function TarjetaSolicitudGuardada(
  { vin, onIrACola, onSolicitarOtro }: { vin: string; onIrACola: () => void; onSolicitarOtro: () => void },
) {
  const tituloRef = useRef<HTMLHeadingElement>(null);
  // El foco va al título al montar (AC8): el lector anuncia qué pasó antes que cualquier botón.
  useEffect(() => { tituloRef.current?.focus(); }, []);

  return (
    <FlitCard>
      <div role="status" className="space-y-4">
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
            style={{ background: 'var(--flit-chip-warning-bg)', color: 'var(--flit-warning-ink)' }}
          >
            <ShieldQuestion size={18} />
          </span>
          <h2
            ref={tituloRef} tabIndex={-1}
            className="flit-focus rounded text-base font-semibold"
            style={{ color: 'var(--flit-text-primary)' }}
          >
            {TITULO_GUARDADA}
          </h2>
        </div>
        <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          El RUNT no respondió, así que todavía no la enviamos al gestor. Guardamos el VIN, la factura y
          los datos del propietario: no tiene que volver a escribirlos. FLITO volverá a consultar el RUNT
          y usted verá el cambio de estado en «Mis SOAT».
        </p>
        <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          VIN{' '}
          <span className="break-all font-mono font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{vin}</span>
        </p>
        {/* A 375 px se apilan a ancho completo con la PRIMARIA arriba (UX §7). */}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" className={`${flitBtnSecondary} w-full justify-center sm:w-auto`} style={flitBtnSecondaryStyle}
            onClick={onSolicitarOtro}>
            <RotateCw size={16} aria-hidden="true" className="shrink-0" />
            Solicitar otro SOAT
          </button>
          <button type="button" className={`${flitBtnPrimary} w-full justify-center sm:w-auto`} style={flitBtnPrimaryStyle}
            onClick={onIrACola}>
            Ir a mis SOAT
            <ArrowRight size={16} aria-hidden="true" className="shrink-0" />
          </button>
        </div>
      </div>
    </FlitCard>
  );
}
