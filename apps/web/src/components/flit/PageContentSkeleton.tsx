// SPRINT-PERF-UX-NAV-2026 (FIONA + MIMI) — placeholder del ÁREA DE CONTENIDO
// mientras carga un chunk lazy. Va dentro del <Outlet/> de Layout, así el sidebar
// FLIT permanece visible y la navegación no se siente como «pantalla congelada».
//
// Deliberadamente SIN `h-screen`: ocupa solo el contenido. `aria-busy` + label
// para que el lector de pantalla anuncie el estado de carga sin spamear texto.

const cardStyle: React.CSSProperties = {
  background: 'var(--flit-bg-card)',
  border: '1px solid var(--flit-border-soft)',
  borderRadius: 'var(--flit-radius-card)',
};
const bar = (w: string, extra?: React.CSSProperties): React.CSSProperties => ({
  background: 'var(--flit-border-soft)',
  borderRadius: 8,
  width: w,
  ...extra,
});

export default function PageContentSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Cargando página"
      role="status"
      className="mx-auto flex max-w-[1600px] animate-pulse flex-col gap-5 motion-reduce:animate-none lg:gap-6"
    >
      {/* Header card (alias de PageHeaderCard) */}
      <div className="p-6" style={cardStyle}>
        <div className="h-6" style={bar('14rem')} />
        <div className="mt-3 h-3" style={bar('22rem', { opacity: 0.55 })} />
      </div>

      {/* Filas de contenido (lista/tabla genérica) */}
      <div className="p-6" style={cardStyle}>
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="flex items-center gap-4 py-4"
            style={i < 3 ? { borderBottom: '1px solid var(--flit-border-soft)' } : undefined}
          >
            <div className="h-10 w-10 flex-shrink-0" style={bar('2.5rem', { borderRadius: 10 })} />
            <div className="flex flex-1 flex-col gap-2">
              <div className="h-3" style={bar('33%')} />
              <div className="h-3" style={bar('22%', { opacity: 0.55 })} />
            </div>
            <div className="h-8" style={bar('5rem', { borderRadius: 999 })} />
          </div>
        ))}
      </div>
    </div>
  );
}
