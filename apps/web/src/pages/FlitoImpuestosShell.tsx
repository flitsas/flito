// Módulo Impuestos con pestañas: la cola (/flito/impuestos) y «Certificar sin trámite»
// (/flito/impuestos/certificar). La pestaña de certificar solo existe con su función del catálogo.
// UI Kit 2026 (molde `#usuarios`/`#compania`): UNA cabecera de módulo aquí y `Pestanas` (enlaces)
// debajo; cada vista pinta su contenido sin cabecera propia. Sin PII en la URL.
import { lazy, Suspense } from 'react';
import PageContentSkeleton from '../components/flit/PageContentSkeleton';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import Pestanas from '../components/flit/Pestanas';
import { useAuth } from '../lib/auth';

const FlitoImpuestos = lazy(() => import('./FlitoImpuestos'));
const FlitoImpuestosCertificar = lazy(() => import('./FlitoImpuestosCertificar'));

type Vista = 'cola' | 'certificar';
export const FUNCION_CERTIFICAR = 'impuestos.certificacion_directa.gestionar';

export default function FlitoImpuestosShell({ vista }: { vista: Vista }) {
  const { hasFuncion } = useAuth();
  const tabs = [
    { id: 'cola', etiqueta: 'Impuestos', to: '/flito/impuestos' },
    ...(hasFuncion(FUNCION_CERTIFICAR)
      ? [{ id: 'certificar', etiqueta: 'Certificar sin trámite', to: '/flito/impuestos/certificar' }]
      : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeaderCard
        title="Impuestos"
        subtitle="Gestión del impuesto vehicular por organismo. La factura de venta es precondición del envío; el pago deriva del recibo validado."
        icono="flito-impuestos"
      />
      {tabs.length > 1 && <Pestanas etiqueta="Secciones de Impuestos" pestanas={tabs} activa={vista} />}
      <div id="imp-panel">
        <Suspense fallback={<PageContentSkeleton />}>
          {vista === 'certificar' ? <FlitoImpuestosCertificar /> : <FlitoImpuestos />}
        </Suspense>
      </div>
    </div>
  );
}
