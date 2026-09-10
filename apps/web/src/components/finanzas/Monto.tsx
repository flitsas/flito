// Un valor en pesos, o el MOTIVO de que no lo haya. Compartido por el detalle, sus totales y el
// consolidado del reporte de costos para que un hueco se diga igual en los tres sitios.

import { pesos, TEXTO_FALTA, type Falta } from './tiposReporteCostos';

export default function Monto({ v, falta, negrita, title }: {
  v: number | null; falta?: Falta; negrita?: boolean;
  /** Qué conceptos faltan, para el subtotal en null (RN-02): `Falta: SOAT, Impuesto`. */
  title?: string;
}) {
  if (v === null) {
    return (
      <span className="text-xs italic" style={{ color: 'var(--flit-text-muted)' }} title={title}>
        {falta ? TEXTO_FALTA[falta] : '—'}
      </span>
    );
  }
  return <span className={negrita ? 'font-semibold' : undefined}>{pesos(v)}</span>;
}
