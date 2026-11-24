// Módulo Impuestos con pestañas: la cola (/flito/impuestos) y «Certificar sin trámite»
// (/flito/impuestos/certificar). La pestaña de certificar solo existe con su función del catálogo.
// UI Kit 2026 (molde `#usuarios`/`#compania`): UNA cabecera de módulo aquí y las pestañas del kit
// (`.kit-pestanas`) debajo; cada vista pinta su contenido sin cabecera propia. Sin PII en la URL.
// Las pestañas conservan su semántica previa (tablist/tab/tabpanel, flechas, Inicio/Fin): el
// rediseño solo cambia la piel, no el patrón de teclado ni los aria.
// Épica #14560 (ronda 2): la cabecera es la MISMA que la del SOAT —miga del grupo del dock y las
// acciones de la cola dentro, a la derecha—. Las acciones las pinta la cola en el hueco que deja
// aquí (`AccionesCabecera`), porque dependen de su estado. Desde la HU #14665 «Certificar sin trámite»
// usa el mismo hueco y la cabecera cambia el subtítulo con la pestaña.
import { lazy, Suspense, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import PageContentSkeleton from '../components/flit/PageContentSkeleton';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import { useAuth } from '../lib/auth';
import { ProveedorHuecoCabecera } from '../components/flito/impuestos/AccionesCabecera';

const FlitoImpuestos = lazy(() => import('./FlitoImpuestos'));
const FlitoImpuestosCertificar = lazy(() => import('./FlitoImpuestosCertificar'));

type Vista = 'cola' | 'certificar';
/** Misma miga que la cola SOAT: el grupo del dock. */
const MIGA_IMPUESTOS = [{ etiqueta: 'Impuestos y SOAT' }];
export const FUNCION_CERTIFICAR = 'impuestos.certificacion_directa.gestionar';
/** El subtítulo de la cabecera cambia con la pestaña (HU #14665). */
const SUBTITULO: Record<Vista, string> = {
  cola: 'Cola de pago del impuesto vehicular: de Pendiente a Pagado.',
  certificar: 'Certifica ante el RUNT los vehículos que no tienen trámite en FLITO.',
};

export default function FlitoImpuestosShell({ vista }: { vista: Vista }) {
  const { hasFuncion } = useAuth();
  const navigate = useNavigate();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const [hueco, setHueco] = useState<HTMLElement | null>(null);
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

  // `space-y-4` y no `flex gap-4`, como el SOAT: así los márgenes del kit (`.page-header`, la
  // paginación) colapsan igual y las dos colas quedan con el mismo aire entre bloques.
  return (
    <div className="space-y-4">
      <PageHeaderCard
        title="Impuestos"
        subtitle={SUBTITULO[vista]}
        icono="flito-impuestos"
        miga={MIGA_IMPUESTOS}
        // Las dos pestañas pintan sus acciones aquí (HU #14665: «Nueva certificación» / «Volver al listado»).
        actions={<div ref={setHueco} className="contents" data-hueco="acciones-cabecera" />}
      />
      {tabs.length > 1 && (
        <div role="tablist" aria-label="Secciones de Impuestos" className="kit-pestanas" data-kit="pestanas">
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
                className="kit-pestana transition-colors"
              >
                {t.etiqueta}
              </button>
            );
          })}
        </div>
      )}
      <div role="tabpanel" id="imp-panel" aria-labelledby={`imp-tab-${vista}`}>
        <ProveedorHuecoCabecera value={hueco}>
          <Suspense fallback={<PageContentSkeleton />}>
            {vista === 'certificar' ? <FlitoImpuestosCertificar /> : <FlitoImpuestos />}
          </Suspense>
        </ProveedorHuecoCabecera>
      </div>
    </div>
  );
}
