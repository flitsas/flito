/**
 * Gráficos del UI Kit 2026 («Uso de gráficos»): dona de 132 px con total y leyenda en lista, y barras agrupadas con
 * guías punteadas, ejes y leyenda. Colores de la paleta del manual vía `SERIE_KIT` (tokens), nunca hex en páginas.
 */
export const SERIE_KIT = {
  azul: 'var(--kit-azul)', turquesa: 'var(--kit-turquesa)', amarillo: 'var(--kit-amarillo)', verde: 'var(--kit-verde)',
  naranja: 'var(--kit-naranja)', rojo: 'var(--kit-rojo)', gris: 'var(--kit-gris)', tinta: 'var(--color-text-primary)',
} as const;

export interface ParteDona { t: string; v: number; c: string }

export function Dona({ partes, etiqueta, pie = 'total', vacio = 'Sin datos en el periodo' }: {
  partes: ParteDona[]; etiqueta: string; pie?: string; vacio?: string;
}) {
  const con = partes.filter((x) => x.v > 0);
  const total = con.reduce((a, x) => a + x.v, 0);
  if (!total) return <p className="grafico-vacio">{vacio}</p>;
  const C = 2 * Math.PI * 42;
  let ido = 0;
  return (
    <div className="dona" data-kit="dona">
      <svg viewBox="0 0 120 120" role="img" aria-label={`${etiqueta}: ${con.map((x) => `${x.t} ${x.v}`).join(', ')}`}>
        {con.map((x) => {
          const largo = (C * x.v) / total;
          const arco = (
            <circle key={x.t} cx="60" cy="60" r="42" fill="none" stroke={x.c} strokeWidth="18"
              strokeDasharray={`${largo.toFixed(2)} ${(C - largo).toFixed(2)}`} strokeDashoffset={(-ido).toFixed(2)} transform="rotate(-90 60 60)" />
          );
          ido += largo;
          return arco;
        })}
        <text x="60" y="59" textAnchor="middle" className="dona__total">{total.toLocaleString('es-CO')}</text>
        <text x="60" y="73" textAnchor="middle" className="dona__pie">{pie}</text>
      </svg>
      <ul className="leyenda leyenda--lista">
        {con.map((x) => <li key={x.t}><i style={{ background: x.c }} />{x.t}<strong>{x.v.toLocaleString('es-CO')}</strong></li>)}
      </ul>
    </div>
  );
}

export interface SerieBarras { t: string; c: string; v: number[] }

export function BarrasGrupo({ etiquetas, series, titulo }: { etiquetas: string[]; series: SerieBarras[]; titulo: string }) {
  const max = Math.max(1, ...series.flatMap((s) => s.v));
  const paso = max <= 10 ? 2 : max <= 25 ? 5 : max <= 100 ? 10 : Math.pow(10, Math.floor(Math.log10(max)));
  const tope = Math.ceil(max / paso) * paso;
  const W = 560, y0 = 214, alto = 190, x0 = 34;
  const grupo = (W - x0 - 8) / Math.max(1, etiquetas.length);
  const bw = Math.min(46, (grupo - 24) / Math.max(1, series.length));
  const guias: number[] = [];
  for (let t = 0; t <= tope; t += paso) guias.push(t);
  return (
    <div className="grafico" data-kit="barras">
      <svg viewBox={`0 0 ${W} 250`} role="img" aria-label={titulo}>
        {guias.map((t) => {
          const y = y0 - (alto * t) / tope;
          return (
            <g key={t}>
              <line x1={x0} x2={W} y1={y} y2={y} className="grafico__guia" />
              <text x={x0 - 8} y={y + 4} textAnchor="end" className="grafico__eje">{t}</text>
            </g>
          );
        })}
        {etiquetas.map((e, i) => {
          const ini = x0 + grupo * i + (grupo - bw * series.length - 3 * (series.length - 1)) / 2;
          return (
            <g key={e}>
              {series.map((s, j) => {
                const h = (alto * (s.v[i] ?? 0)) / tope;
                return <rect key={s.t} x={ini + j * (bw + 3)} y={y0 - h} width={bw} height={h} rx="3" fill={s.c}><title>{`${s.t}, ${e}: ${s.v[i] ?? 0}`}</title></rect>;
              })}
              <text x={x0 + grupo * i + grupo / 2} y={y0 + 18} textAnchor="middle" className="grafico__eje">{e}</text>
            </g>
          );
        })}
      </svg>
      <ul className="leyenda">{series.map((s) => <li key={s.t}><i style={{ background: s.c }} />{s.t}</li>)}</ul>
    </div>
  );
}
