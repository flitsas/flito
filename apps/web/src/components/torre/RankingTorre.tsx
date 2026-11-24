// Torre de Control (Épica #14590) — ranking de participación: `AvanceBarra` del kit repetido (spec UX §9.3).
// Escritorio: nombre · barra · cifra en una fila. Teléfono: el nombre arriba y la barra con su cifra EN LA MISMA
// LÍNEA debajo (pedido del humano: la cifra no cae bajo la barra como en la maqueta).
import { AvanceBarra } from '../flit/Bloques';

export interface FilaRanking { id: string; etiqueta: string; pct: number; valor: string }

export default function RankingTorre({ filas, etiqueta }: { filas: FilaRanking[]; etiqueta: string }) {
  return (
    <ul className="m-0 grid list-none gap-3 p-0" aria-label={etiqueta} data-torre="ranking">
      {filas.map((f) => (
        <li key={f.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-sm sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto]">
          <span className="col-span-2 truncate sm:col-span-1" title={f.etiqueta}>{f.etiqueta}</span>
          <div className="min-w-0"><AvanceBarra valor={f.pct} etiqueta={`${f.etiqueta}: ${Math.round(f.pct)} %`} /></div>
          <strong className="whitespace-nowrap text-right tabular-nums">{f.valor}</strong>
        </li>
      ))}
    </ul>
  );
}
