// Los contadores de la cabecera y sus CUATRO estados propios (AC2).
//
// El resumen es de toda la bandeja del ambiente y **no lleva filtros**: es el total contra el que se
// compara lo que un filtro dejó fuera. Por eso el vacío con filtro puesto puede decir «hay 23 casos
// detenidos en total» — y si el resumen no cargó, se calla el número en vez de inventárselo.

import {
  ETIQUETA_RESPONSABLE, SIIGO_BANDEJA_FUENTE_ETIQUETA, SIIGO_BANDEJA_FUENTES,
} from '@operaciones/shared-types';
import type { ResponsableError, SiigoBandejaResumen } from '@operaciones/shared-types';
import { flitBtnSecondarySm, flitBtnSecondaryStyle } from '../../flit/flitPageKit';

const CARD = {
  borderRadius: 'var(--flit-radius-card)',
  border: '1px solid var(--flit-border-soft)',
  boxShadow: 'var(--flit-shadow-card)',
} as const;

function Tarjeta({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="bg-white p-4" style={CARD}>
      <p
        className="text-[11px] font-semibold uppercase tracking-[0.12em]"
        style={{ color: 'var(--flit-text-secondary)' }}
      >
        {rotulo}
      </p>
      <p
        className="mt-2 text-3xl font-bold tabular-nums leading-none"
        style={{ color: 'var(--flit-text-primary)' }}
      >
        {valor}
      </p>
    </div>
  );
}

/** «¿Esto es mío?», respondido de una vez. Solo se nombran los responsables que tienen algo. */
function Responsables({ por }: { por: Record<ResponsableError, number> }) {
  const conCarga = (Object.entries(por) as [ResponsableError, number][])
    .filter(([, n]) => n > 0);
  if (conCarga.length === 0) return null;
  return (
    <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
      Quién lo resuelve:{' '}
      {conCarga.map(([r, n]) => `${n} · ${ETIQUETA_RESPONSABLE[r]}`).join(' — ')}
    </p>
  );
}

export default function ResumenBandeja(
  { resumen, cargando, error, onReintentar }:
  { resumen: SiigoBandejaResumen | null; cargando: boolean; error: string | null;
    onReintentar: () => void },
) {
  if (cargando) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" role="status" aria-busy="true">
        <span className="sr-only">Contando lo que está detenido…</span>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="bg-white p-4" style={CARD}>
            <div className="h-3 w-24 rounded" style={{ background: 'var(--flit-bg-app)' }} />
            <div className="mt-3 h-8 w-16 rounded" style={{ background: 'var(--flit-bg-app)' }} />
          </div>
        ))}
      </div>
    );
  }

  // El fallo del resumen NO tumba la lista: es una consulta accesoria con su propio reintento.
  if (error || !resumen) {
    return (
      <div className="flex flex-wrap items-center gap-3 bg-white p-4" style={CARD}>
        <p role="alert" className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
          No se pudo calcular el resumen: {error ?? 'sin datos'}. La lista de abajo no depende de esto.
        </p>
        <button
          type="button"
          onClick={onReintentar}
          className={flitBtnSecondarySm}
          style={flitBtnSecondaryStyle}
        >
          Volver a calcular el resumen
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tarjeta rotulo="Detenido en total" valor={resumen.total.toLocaleString('es-CO')} />
        {SIIGO_BANDEJA_FUENTES.map((f) => (
          <Tarjeta
            key={f}
            rotulo={SIIGO_BANDEJA_FUENTE_ETIQUETA[f]}
            valor={resumen.porFuente[f].toLocaleString('es-CO')}
          />
        ))}
      </div>
      <Responsables por={resumen.porResponsable} />
    </div>
  );
}
