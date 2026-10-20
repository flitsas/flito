// Estados compartidos de Ayuda FLITO (Feature #13691 · HU #13704, diseño slim §7):
// cargando de la ficha, error con Reintentar, vacío sin módulos (P9-3a) y sin coincidencias.

import { Link } from 'react-router-dom';
import PageHeaderCard from '../flit/PageHeaderCard';
import {
  FlitCard, FlitEmpty, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../flit/flitPageKit';

export function SkeletonFicha() {
  const bar = (w: string) => ({ background: 'var(--flit-border-soft)', borderRadius: 8, width: w, height: 12 });
  return (
    <div aria-busy="true" aria-label="Cargando ficha" role="status" className="animate-pulse motion-reduce:animate-none">
      <FlitCard>
        <div className="space-y-3">
          <div style={bar('35%')} />
          <div style={bar('90%')} />
          <div style={bar('75%')} />
          <div style={bar('60%')} />
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
    <FlitCard>
      <div role="alert">
        <h2 className="text-base font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>{titulo}</h2>
        <p className="mt-2 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          Revise su conexión y vuelva a intentarlo.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onReintentar}>
            Reintentar
          </button>
          {volver && (
            <Link to="/flito/ayuda" className={flitBtnSecondary} style={flitBtnSecondaryStyle}>
              Volver al índice
            </Link>
          )}
        </div>
      </div>
    </FlitCard>
  );
}

/** P9-3a: usuario sin ninguna ficha visible que entra por URL directa (el menú no la muestra). */
export function AyudaSinModulos() {
  return (
    <div className="space-y-4">
      <PageHeaderCard title="Ayuda FLITO" />
      <FlitEmpty>
        <h2 className="text-base font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
          Su usuario aún no tiene módulos con ayuda
        </h2>
        <p className="mx-auto mt-2 max-w-lg" style={{ color: 'var(--flit-text-secondary)' }}>
          La Ayuda FLITO muestra guías solo de las pantallas que usted puede abrir. Si necesita una, pídale a un administrador que le habilite esa pantalla.
        </p>
        <Link to="/" className={`${flitBtnSecondary} mt-4`} style={flitBtnSecondaryStyle}>Volver al inicio</Link>
      </FlitEmpty>
    </div>
  );
}

/** Texto del subestado «sin coincidencias». Vive dentro de la región `role="status"` del índice. */
export function AyudaSinResultados({ consulta }: { consulta: string }) {
  return (
    <span className="font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
      Ninguna ficha coincide con &quot;{consulta}&quot;
    </span>
  );
}
