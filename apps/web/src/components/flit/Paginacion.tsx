// Paginación con contador de total.
//
// Vivía dentro de FinanzasReporteCostos.tsx; se extrae porque las colas de SOAT e impuestos pasaron
// a paginar en servidor (HU #10984). El contador no es decorativo: es la única forma de saber que
// un filtro dejó fuera lo que se estaba buscando.

export default function Paginacion({
  total, page, totalPaginas, onPrev, onNext, sustantivo = 'registros',
}: {
  total: number; page: number; totalPaginas: number;
  onPrev: () => void; onNext: () => void;
  /** Qué se está contando: «trámites», «SOAT», «impuestos». */
  sustantivo?: string;
}) {
  const btn = 'rounded-lg border px-3 py-1.5 text-sm font-semibold disabled:opacity-40';
  const btnStyle = { borderColor: 'var(--flit-border-input)', color: 'var(--flit-blue-text)' } as const;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
        <strong style={{ color: 'var(--flit-text-primary)' }}>{total.toLocaleString('es-CO')}</strong> {sustantivo} · página {page} de {totalPaginas}
      </span>
      <div className="flex gap-2">
        <button className={btn} style={btnStyle} disabled={page <= 1} onClick={onPrev}>← Anterior</button>
        <button className={btn} style={btnStyle} disabled={page >= totalPaginas} onClick={onNext}>Siguiente →</button>
      </div>
    </div>
  );
}
