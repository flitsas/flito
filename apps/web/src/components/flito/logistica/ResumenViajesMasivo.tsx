// Resultado del registro masivo de viajes (HU #14128): qué quedó y qué no, con el motivo de cada rechazo.
// Aviso persistente (role="status" en tarjeta), no toast. Rechazadas arriba; registradas plegadas.

import { forwardRef, useState } from 'react';
import { pesos } from '../../../lib/pesos';
import {
  CODIGOS_CORREGIBLES, plural, textoDeRechazo, type RespuestaMasivo,
} from '../../../lib/viajesMasivo';
import FlitAcordeon from '../../flit/FlitAcordeon';
import {
  FlitCard, FlitTable, FlitTh, FlitTr, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../../flit/flitPageKit';

const MUTED = { color: 'var(--flit-text-muted)' } as const;
const PELIGRO = { color: 'var(--flit-danger-ink)' } as const;

const ResumenViajesMasivo = forwardRef<HTMLHeadingElement, {
  resultado: RespuestaMasivo;
  onCorregir: () => void;
  onNueva: () => void;
}>(function ResumenViajesMasivo({ resultado, onCorregir, onNueva }, ref) {
  const [abierto, setAbierto] = useState(false);
  const { creados, rechazados } = resultado;
  const corregibles = rechazados.filter((r) => CODIGOS_CORREGIBLES.includes(r.codigo)).length;
  const titulo = rechazados.length === 0
    ? `Se registraron ${plural(creados.length, 'viaje', 'viajes')}.`
    : creados.length === 0 ? 'No se registró ningún viaje.' : null;

  return (
    <FlitCard>
      <div role="status" className="space-y-3">
        <h2 ref={ref} tabIndex={-1} className="text-base font-semibold outline-none" style={{ color: 'var(--flit-text-primary)' }}>
          Resultado del registro
        </h2>
        {titulo ? (
          <p className="text-sm font-medium">{titulo}</p>
        ) : (
          <p className="flex flex-wrap gap-x-6 gap-y-1 text-sm font-medium">
            <span>Se registraron {creados.length}</span>
            <span style={PELIGRO}>No se registraron {rechazados.length}</span>
          </p>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {corregibles > 0 && (
          <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={onCorregir}>
            Corregir y reintentar {corregibles}
          </button>
        )}
        <button type="button" onClick={onNueva}
          className={corregibles > 0
            ? 'flit-focus rounded-lg px-2 py-1 text-sm font-medium transition-colors hover:bg-[var(--flit-bg-hover)]'
            : flitBtnSecondary}
          style={corregibles > 0 ? { color: 'var(--flit-blue-text)' } : flitBtnSecondaryStyle}>
          Nueva carga
        </button>
      </div>

      {rechazados.length > 0 && (
        <section className="mt-5" aria-labelledby="mx-rechazadas">
          <h3 id="mx-rechazadas" className="mb-2 text-sm font-semibold">No se registraron</h3>
          <ul className="space-y-2 sm:hidden">
            {rechazados.map((r, i) => (
              <li key={`${r.placa}-${i}`} className="rounded-lg border p-3 text-sm" style={{ borderColor: 'var(--flit-border-soft)' }}>
                <div className="font-bold tabular-nums">{r.placa || '—'}</div>
                <div style={MUTED}>{textoDeRechazo(r)}</div>
              </li>
            ))}
          </ul>
          <div className="hidden sm:block">
            <FlitTable label="Placas no registradas">
              <thead><tr><FlitTh>Placa</FlitTh><FlitTh>Motivo</FlitTh></tr></thead>
              <tbody>
                {rechazados.map((r, i) => (
                  <FlitTr key={`${r.placa}-${i}`}>
                    <td className="px-4 py-2 text-sm font-medium tabular-nums">{r.placa || '—'}</td>
                    <td className="px-4 py-2 text-sm">{textoDeRechazo(r)}</td>
                  </FlitTr>
                ))}
              </tbody>
            </FlitTable>
          </div>
        </section>
      )}

      {creados.length > 0 && (
        <div className="mt-5">
          <FlitAcordeon titulo="Registrados" cantidad={creados.length} abierto={abierto} onToggle={() => setAbierto((a) => !a)} nivel={3}>
            <div className="mt-3">
              <FlitTable label="Viajes registrados">
                <thead><tr><FlitTh>Placa</FlitTh><FlitTh>Trámite</FlitTh><FlitTh>Viaje N.º</FlitTh><FlitTh>Valor</FlitTh></tr></thead>
                <tbody>
                  {creados.map((c) => (
                    <FlitTr key={c.viaje.id}>
                      <td className="px-4 py-2 text-sm font-medium tabular-nums">{c.placa}</td>
                      <td className="px-4 py-2 text-sm tabular-nums">{c.idFlit}</td>
                      <td className="px-4 py-2 text-sm tabular-nums">{c.viaje.numero}</td>
                      <td className="px-4 py-2 text-sm tabular-nums">{pesos(c.viaje.valor)}</td>
                    </FlitTr>
                  ))}
                </tbody>
              </FlitTable>
            </div>
          </FlitAcordeon>
        </div>
      )}
    </FlitCard>
  );
});

export default ResumenViajesMasivo;
