// Módulo Impuestos con pestañas: la cola (/flito/impuestos) y «Certificar sin trámite»
// (/flito/impuestos/certificar). La pestaña de certificar solo existe con su función del catálogo.
// Cada vista conserva su cabecera; aquí solo vive la navegación. Sin PII en la URL.
import { lazy, Suspense, useRef, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import PageContentSkeleton from '../components/flit/PageContentSkeleton';
import { useAuth } from '../lib/auth';

const FlitoImpuestos = lazy(() => import('./FlitoImpuestos'));
const FlitoImpuestosCertificar = lazy(() => import('./FlitoImpuestosCertificar'));

type Vista = 'cola' | 'certificar';
export const FUNCION_CERTIFICAR = 'impuestos.certificacion_directa.gestionar';

const TAB = 'flit-focus rounded-lg px-4 h-10 text-sm font-medium transition-colors border border-transparent';

export default function FlitoImpuestosShell({ vista }: { vista: Vista }) {
  const { hasFuncion } = useAuth();
  const navigate = useNavigate();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const tabs: { id: Vista; etiqueta: string; to: string }[] = [
    { id: 'cola', etiqueta: 'Impuestos', to: '/flito/impuestos' },
    ...(hasFuncion(FUNCION_CERTIFICAR)
      ? [{ id: 'certificar' as const, etiqueta: 'Certificar sin trámite', to: '/flito/impuestos/certificar' }]
      : []),
  ];

  function onKey(e: KeyboardEvent, i: number) {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + d + tabs.length) % tabs.length;
    navigate(tabs[j].to);
    refs.current[j]?.focus();
  }

  return (
    <div className="flex flex-col gap-4">
      {tabs.length > 1 && (
        <div role="tablist" aria-label="Secciones de Impuestos" className="flex flex-wrap gap-2">
          {tabs.map((t, i) => {
            const activa = t.id === vista;
            return (
              <button
                key={t.id}
                ref={(el) => { refs.current[i] = el; }}
                type="button"
                role="tab"
                id={`imp-tab-${t.id}`}
                aria-selected={activa}
                aria-controls="imp-panel"
                tabIndex={activa ? 0 : -1}
                onClick={() => navigate(t.to)}
                onKeyDown={(e) => onKey(e, i)}
                className={`${TAB} ${activa ? 'bg-flit-card' : 'hover:bg-flit-card'}`}
                style={activa
                  ? { color: 'var(--flit-text-primary)', borderColor: 'var(--flit-border-soft)' }
                  : { color: 'var(--flit-text-secondary)' }}
              >
                {t.etiqueta}
              </button>
            );
          })}
        </div>
      )}
      <div role="tabpanel" id="imp-panel" aria-labelledby={`imp-tab-${vista}`}>
        <Suspense fallback={<PageContentSkeleton />}>
          {vista === 'certificar' ? <FlitoImpuestosCertificar /> : <FlitoImpuestos />}
        </Suspense>
      </div>
    </div>
  );
}
