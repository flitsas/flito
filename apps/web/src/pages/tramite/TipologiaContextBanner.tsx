// TRAM-TIPO-02 UX — banner contextual por tipología (MIMI + FLIT).
// Consume la matriz de journeys (shared-types); sin lógica de negocio propia.

import { getJourney, getPasoTipologia, getTipologiaCompliance } from '@operaciones/shared-types';

interface Props {
  codigo: string | null;
  /** Paso del wizard (1–5) para nota contextual de la matriz. */
  paso: number;
  className?: string;
}

export default function TipologiaContextBanner({ codigo, paso, className = '' }: Props) {
  if (!codigo) return null;
  const compliance = getTipologiaCompliance(codigo); // FUENTE ÚNICA: matriz journeys
  const pasoCtx = getPasoTipologia(codigo, paso);
  const journey = getJourney(codigo);
  const nota = pasoCtx?.nota;
  if (!compliance && !nota) return null;

  const tono = compliance?.tono ?? 'info';
  const boxStyle = tono === 'warn'
    ? { border: '1px solid color-mix(in srgb, var(--kit-naranja) 35%, transparent)', background: 'color-mix(in srgb, var(--kit-naranja) 8%, transparent)' }
    : { border: '1px solid color-mix(in srgb, var(--kit-azul) 30%, transparent)', background: 'color-mix(in srgb, var(--kit-azul) 8%, transparent)' };
  const titleColor = tono === 'warn' ? 'var(--kit-naranja)' : 'var(--color-action)';

  return (
    <div className={`rounded-[9px] p-3 ${className}`} style={boxStyle} role="note">
      <p className="text-xs font-bold" style={{ color: titleColor }}>
        {compliance?.titulo ?? journey?.nombre ?? codigo}
      </p>
      {compliance && (
        <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
          {compliance.cuerpo}
        </p>
      )}
      {nota && (
        <p className="mt-1.5 text-xs leading-relaxed" style={{ color: 'var(--color-text-tertiary)' }}>
          {nota}
        </p>
      )}
    </div>
  );
}
