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
    ? { border: '1px solid rgba(240,90,53,0.35)', background: 'rgba(240,90,53,0.08)' }
    : { border: '1px solid rgba(79,116,201,0.30)', background: 'rgba(79,116,201,0.08)' };
  const titleColor = tono === 'warn' ? 'var(--flit-warning)' : 'var(--flit-blue-text)';

  return (
    <div className={`rounded-[12px] p-3 ${className}`} style={boxStyle} role="note">
      <p className="text-xs font-bold" style={{ color: titleColor }}>
        {compliance?.titulo ?? journey?.nombre ?? codigo}
      </p>
      {compliance && (
        <p className="mt-1 text-[11px] leading-relaxed" style={{ color: 'var(--flit-text-secondary)' }}>
          {compliance.cuerpo}
        </p>
      )}
      {nota && (
        <p className="mt-1.5 text-[11px] leading-relaxed" style={{ color: 'var(--flit-text-muted)' }}>
          {nota}
        </p>
      )}
    </div>
  );
}
