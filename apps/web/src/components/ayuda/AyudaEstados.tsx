// Estados compartidos de Ayuda FLITO (Feature #13691 · HU #13704, diseño slim §7):
// cargando de la ficha, error con Reintentar, vacío sin módulos (P9-3a) y sin coincidencias.
// UI Kit 2026: esqueleto `.kit-esqueleto`, error como aviso naranja del kit (`.kit-alerta`) y vacío del molde
// `.vacio`. No se usan `ErrorVista`/`Vacio` tal cual porque los AC exigen el título como encabezado (`h2`).

import { Link } from 'react-router-dom';
import PageHeaderCard from '../flit/PageHeaderCard';
import GradientButton, { claseBoton } from '../flit/GradientButton';
import { Icono } from '../flit/kit/Icono';
import { FlitCard } from '../flit/flitPageKit';

export function SkeletonFicha() {
  return (
    <div aria-busy="true" aria-label="Cargando ficha" role="status" data-kit="esqueleto">
      <FlitCard>
        <div className="space-y-3">
          <div className="kit-esqueleto h-3 w-[35%]" />
          <div className="kit-esqueleto h-3 w-[90%]" />
          <div className="kit-esqueleto h-3 w-[75%]" />
          <div className="kit-esqueleto h-3 w-[60%]" />
        </div>
      </FlitCard>
    </div>
  );
}

/**
 * Error de carga. El detalle es copy fijo: nunca el mensaje crudo del cliente o del API
 * (principios FLITO; HU #13704 AC8).
 */
export function ErrorAyuda(
  { titulo, onReintentar, volver }: { titulo: string; onReintentar: () => void; volver?: boolean },
) {
  return (
    <div role="alert" className="kit-alerta" data-tono="warn" data-kit="alerta">
      <img src="/kit/aviso-alerta.svg" alt="" aria-hidden="true" className="kit-alerta__icono" />
      <div className="min-w-0 flex-1">
        <h2 className="text-base font-semibold text-[color:var(--kit-naranja-texto)]">{titulo}</h2>
        <p className="mt-2 text-sm text-[color:var(--color-text-secondary)]">
          Revise su conexión y vuelva a intentarlo.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <GradientButton type="button" variant="secondary" onClick={onReintentar}>
            <Icono nombre="reintento" size={16} />
            Reintentar
          </GradientButton>
          {volver && (
            <Link to="/flito/ayuda" className={claseBoton('secondary')} data-variante="secundario">
              Volver al índice
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

/** P9-3a: usuario sin ninguna ficha visible que entra por URL directa (el menú no la muestra). */
export function AyudaSinModulos() {
  return (
    <div className="space-y-4">
      <PageHeaderCard title="Ayuda FLITO" icono="flito-ayuda" miga={[]} />
      <div className="card">
        <div className="kit-vacio" data-kit="vacio">
          <Icono nombre="ayuda" disco size={72} />
          <h2 className="text-base font-semibold text-[color:var(--color-text-primary)]">
            Su usuario aún no tiene módulos con ayuda
          </h2>
          <p className="mx-auto max-w-lg font-normal text-[color:var(--color-text-secondary)]">
            La Ayuda FLITO muestra guías solo de las pantallas que usted puede abrir. Si necesita una, pídale a un administrador que le habilite esa pantalla.
          </p>
          <Link to="/" className={claseBoton('secondary', 'md', 'mt-2')} data-variante="secundario">Volver al inicio</Link>
        </div>
      </div>
    </div>
  );
}

/** Texto del subestado «sin coincidencias». Vive dentro de la región `role="status"` del índice. */
export function AyudaSinResultados({ consulta }: { consulta: string }) {
  return (
    <span className="font-semibold text-[color:var(--color-text-primary)]">
      Ninguna ficha coincide con &quot;{consulta}&quot;
    </span>
  );
}
