// Línea de tendencia del kit (gráficos: colores de la paleta, trazo azul).
interface SparklineProps {
  data: number[];
  className?: string;
  stroke?: string;
}

export default function Sparkline({ data, className = '', stroke = 'var(--kit-azul)' }: SparklineProps) {
  if (data.length < 2) return null;
  const w = 120;
  const h = 36;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const points = data.map((v, i) => [(i / (data.length - 1)) * w, h - ((v - min) / range) * (h - 4) - 2] as const);
  const path = points.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(' ');
  const area = `${path} L${w},${h} L0,${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={className} preserveAspectRatio="none" aria-hidden="true">
      <path d={area} fill={stroke} fillOpacity="0.1" />
      <path d={path} fill="none" stroke={stroke} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
