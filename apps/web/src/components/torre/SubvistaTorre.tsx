// Torre de Control (Épica #14590, B4) — los 4 estados de una subvista de área (Logística › Traslados/Entregas,
// Financiera › Facturación/Bolsas) con el copy propio de cada una, y la frase guía que abre la pestaña.
import type { ReactNode } from 'react';
import type { DestinoCifra } from '@operaciones/shared-types';
import { ErrorVista, Vacio } from '../flit/Cargador';
import GradientButton from '../flit/GradientButton';
import type { OrigenPantallaTorre } from '../../lib/torreDetalle';
import type { EstadoTablero } from './MoldeTablero';
import { REJILLA_KPI } from './PaginaTorre';
import { EnlaceDestino } from './KpiExplicable';

export function EsqueletoSubvista({ kpis, bloques = 1, nombre }: { kpis: number; bloques?: number; nombre: string }) {
  return (
    <div className="flex flex-col gap-4" role="status" aria-busy="true" data-torre="tablero" data-estado="cargando">
      <span className="sr-only">Cargando {nombre}</span>
      <div className="kit-esqueleto h-5 w-2/3" aria-hidden="true" />
      <div className={REJILLA_KPI}>{Array.from({ length: kpis }, (_, i) => <div key={i} className="kit-esqueleto h-[104px]" aria-hidden="true" />)}</div>
      {Array.from({ length: bloques }, (_, i) => <div key={i} className="kit-esqueleto h-[220px]" aria-hidden="true" />)}
    </div>
  );
}

/**
 * Cargando / error / vacío / lleno de una subvista. `vacio` decide si el dato está vacío; `alVacio` puede añadir lo
 * que sigue visible aunque no haya datos (las boletas de Bolsas).
 */
export function EstadosSubvista<T>({ estado, kpis, bloques, nombre, error, vacio, onReintentar, onLimpiar, alVacio, children }: {
  estado: EstadoTablero<T>;
  kpis: number;
  bloques?: number;
  /** Para el lector de pantalla: «los traslados». */
  nombre: string;
  error: string;
  vacio: { es: (d: T) => boolean; texto: string; detalle: string } | null;
  onReintentar: () => void;
  onLimpiar: () => void;
  alVacio?: (d: T) => ReactNode;
  children: (d: T) => ReactNode;
}) {
  if (estado.tipo === 'cargando') return <EsqueletoSubvista kpis={kpis} bloques={bloques} nombre={nombre} />;
  if (estado.tipo === 'error') {
    return (
      <section className="card" data-torre="tablero" data-estado="error">
        <ErrorVista texto={error} onReintentar={onReintentar} />
      </section>
    );
  }
  const d = estado.datos;
  if (vacio?.es(d)) {
    return (
      <div className="flex flex-col gap-4" data-torre="tablero" data-estado="vacio">
        <section className="card">
          <Vacio texto={vacio.texto} detalle={vacio.detalle}
            accion={<GradientButton variant="secondary" size="sm" onClick={onLimpiar}>Limpiar filtros</GradientButton>} />
        </section>
        {alVacio?.(d)}
      </div>
    );
  }
  return <div className="flex flex-col gap-4" data-torre="tablero" data-estado="lleno">{children(d)}</div>;
}

/** Frase guía de la pestaña (informa, no pide acción); con destino, su «Ver los N» al final (envuelve en móvil). */
export function FraseGuia({ texto, destino, cantidad, volver, vista, nombre, femenino = false }: {
  texto: string; destino?: DestinoCifra; cantidad?: number; volver: OrigenPantallaTorre; vista?: string; nombre?: string; femenino?: boolean;
}) {
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-base" data-torre="frase-guia">
      <span>{texto}</span>
      {destino && cantidad !== undefined && (
        <EnlaceDestino destino={destino} cantidad={cantidad} volver={volver} vista={vista} nombre={nombre ?? texto}
          texto={`Ver ${femenino ? 'las' : 'los'} ${cantidad.toLocaleString('es-CO')}`} />
      )}
    </p>
  );
}
