// Esqueleto de página del UI Kit 2026 (bloques hover que respiran, quietos con reduced-motion).
// Marcador E2E: data-kit="esqueleto" + role="status" aria-busy="true" (reemplaza a .animate-pulse).
export default function PageContentSkeleton() {
  return (
    <div aria-busy="true" aria-label="Cargando página" role="status" data-kit="esqueleto"
      className="mx-auto flex max-w-[1680px] flex-col gap-4">
      <div className="card">
        <div className="kit-esqueleto h-6 w-56 max-w-full" />
        <div className="kit-esqueleto mt-3 h-3 w-[22rem] max-w-full opacity-60" />
      </div>
      <div className="card">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={`flex items-center gap-4 py-4${i < 3 ? ' border-b border-[color:var(--color-border)]' : ''}`}>
            <div className="kit-esqueleto h-10 w-10 flex-none rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <div className="kit-esqueleto h-3 w-1/3" />
              <div className="kit-esqueleto h-3 w-1/5 opacity-60" />
            </div>
            <div className="kit-esqueleto h-8 w-20 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
