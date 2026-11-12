// Reporte de costos — contadores de facturación electrónica y filtro por estado (HU #11337).
//
// Componente propio desde el primer commit (AC7): la pantalla que lo aloja ya tiene 581 líneas y el
// techo del repositorio son 800. Extraer después cuesta un refactor con el trabajo encima.
//
// Los contadores son PASTILLAS y no solo números: el 90 % de las veces que alguien mira «cuántas
// rechazadas hay» lo siguiente que quiere es verlas. Un número que no se puede pulsar obliga a
// buscar el filtro en otro sitio para hacer justo lo que el número acaba de sugerir.

import { SIIGO_ESTADOS_REPORTE, SIIGO_ESTADO_REPORTE_ETIQUETA } from '@operaciones/shared-types';
import type { SiigoEstadoReporte } from '@operaciones/shared-types';
import StatusChip from '../flit/StatusChip';
import { FlitCard } from '../flit/flitPageKit';
import { TONO_CHIP_ESTADO, type ResumenFacturacion } from './tiposFacturacion';

interface Props {
  resumen: ResumenFacturacion | null;
  cargando: boolean;
  error: string | null;
  seleccionado: SiigoEstadoReporte | null;
  onSeleccionar: (estado: SiigoEstadoReporte | null) => void;
  onReintentar: () => void;
}

/**
 * Los cuatro estados del AC2, en el orden en que hay que resolverlos.
 *
 * El error va ANTES que el vacío a propósito: si la carga falló, no se sabe si hay datos o no, y
 * pintar «no hay ninguna factura todavía» sería afirmar algo que nadie ha comprobado. Es la
 * diferencia entre «no hay» y «no lo sé», y en una pantalla de control confundirlas manda a alguien
 * a buscar un problema que no existe — o peor, le hace ignorar uno que sí.
 */
export default function ContadoresFacturacion({
  resumen, cargando, error, seleccionado, onSeleccionar, onReintentar,
}: Props) {
  if (cargando) {
    return (
      <FlitCard className="!p-3">
        <div className="text-sm" style={{ color: 'var(--flit-text-secondary)' }} role="status">
          Consultando el estado de la facturación electrónica…
        </div>
      </FlitCard>
    );
  }

  if (error) {
    return (
      <FlitCard className="!p-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm" style={{ color: 'var(--flit-warning-text)' }} role="alert">
            No se pudo consultar el estado de la facturación: {error}
          </span>
          <button type="button" onClick={onReintentar}
            className="flit-focus inline-flex h-7 items-center rounded-[999px] border bg-flit-card px-3 text-xs font-medium transition-colors hover:bg-[var(--flit-bg-hover)]"
            style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>
            Reintentar
          </button>
        </div>
      </FlitCard>
    );
  }

  if (!resumen || resumen.total === 0) {
    return (
      <FlitCard className="!p-3">
        <div className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          Ningún trámite de este filtro se ha enviado todavía a facturación electrónica. El primer
          paso es liquidarlos: la factura se pide desde ahí.
        </div>
      </FlitCard>
    );
  }

  return (
    <FlitCard className="!p-3">
      {/*
        Rótulo y total en su propio renglón, y las pastillas debajo (Épica #13763): con las nueve en
        la misma línea que el rótulo y el total, a 1366 px la última caía sola a un segundo renglón.
        Así las nueve caben en una línea en escritorio y envuelven limpias en móvil.
        El total se muestra siempre, y no es decorativo: es lo que permite comprobar de un vistazo
        que los grupos cuadran. Un tablero cuyos grupos no suman el total no se nota mirando los
        grupos — se nota cuando alguien concilia y no le cuadra, tres semanas después.
      */}
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-xs font-semibold uppercase tracking-wide"
          style={{ color: 'var(--flit-text-muted)' }}>
          Facturación electrónica
        </span>
        <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          {resumen.total} trámite(s) en el filtro actual
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2">
        {SIIGO_ESTADOS_REPORTE.map((estado) => {
          const cuantos = resumen[estado];
          const activo = seleccionado === estado;
          return (
            <button
              key={estado}
              type="button"
              // Alternar y no solo seleccionar: volver a pulsar la pastilla activa quita el filtro.
              // Sin esto, quien filtra por «rechazado» tiene que ir a buscar «Limpiar filtros» para
              // deshacer lo que hizo con un clic aquí mismo.
              onClick={() => onSeleccionar(activo ? null : estado)}
              aria-pressed={activo}
              title={`${SIIGO_ESTADO_REPORTE_ETIQUETA[estado]}: ${cuantos}`}
              // Fondo de tarjeta y velo de hover del kit, no `white`: en oscuro la pastilla era una
              // mancha blanca y la cifra (tinta del tema, clara) apenas se leía (Épica #13763).
              className={`flit-focus inline-flex items-center gap-1.5 rounded-[999px] border py-0.5 pl-0.5 pr-2.5 text-xs transition-colors hover:bg-[var(--flit-bg-hover)] ${activo ? 'bg-[var(--flit-bg-hover)]' : 'bg-flit-card'}`}
              style={{ borderColor: activo ? 'var(--flit-blue-text)' : 'var(--flit-border-input)' }}
            >
              <StatusChip tone={TONO_CHIP_ESTADO[estado]}>{SIIGO_ESTADO_REPORTE_ETIQUETA[estado]}</StatusChip>
              <span className="font-semibold tabular-nums" style={{ color: 'var(--flit-text-primary)' }}>
                {cuantos}
              </span>
            </button>
          );
        })}
      </div>
    </FlitCard>
  );
}
