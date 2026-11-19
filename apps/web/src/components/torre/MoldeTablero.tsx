// Torre de Control (Épica #14590) — molde de los tableros (spec UX §7): UNA petición por tablero
// (`POST /flito/torre/tableros/<area>` con `{ filtro }`) y sus 4 estados a nivel de página. Cada bloque dice en su
// subtítulo qué filtro de la barra ignora (`filtrosIgnorados` del contrato).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { FiltroTorre, MetaBloqueTorre, SeveridadTorre } from '@operaciones/shared-types';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { FiltrosTorre } from '../../lib/torreFiltros';
import { ErrorVista, Vacio } from '../flit/Cargador';
import GradientButton from '../flit/GradientButton';
import { Icono } from '../flit/kit/Icono';
import { toastError, toastOk } from '../flit/ToastFlito';
import { etiquetaKit, ETIQUETA_PUNTO_CLS, type TonoKit } from '../flit/kit/tonos';
import { aFiltroTorre } from './formatoTorre';
import { REJILLA_2, REJILLA_KPI } from './PaginaTorre';

export type AreaTablero = 'ejecutivo' | 'comercial' | 'operativa' | 'financiera';
export type EstadoTablero<T> = { tipo: 'cargando' } | { tipo: 'error' } | { tipo: 'listo'; datos: T };

/** `activo = false` no pide (una subvista que no es el tablero, spec §6.1); al volver a `true`, pide. */
export function useTablero<T>(area: AreaTablero, filtros: FiltrosTorre, activo = true) {
  const [estado, setEstado] = useState<EstadoTablero<T>>({ tipo: 'cargando' });
  const [intento, setIntento] = useState(0);
  const ultima = useRef(0);
  const filtro: FiltroTorre = aFiltroTorre(filtros);
  const clave = JSON.stringify(filtro);
  useEffect(() => {
    if (!activo) return;
    const id = ++ultima.current;
    setEstado({ tipo: 'cargando' });
    api.post<T>(`/flito/torre/tableros/${area}`, { filtro: JSON.parse(clave) as FiltroTorre })
      .then((datos) => { if (id === ultima.current) setEstado({ tipo: 'listo', datos }); })
      .catch(() => { if (id === ultima.current) setEstado({ tipo: 'error' }); });
  }, [area, clave, intento, activo]);
  return { estado, reintentar: () => setIntento((n) => n + 1) };
}

/** Función que habilita la exportación de los tableros (sin ella, el tablero no tiene primaria). */
export const FUNCION_TORRE_EXPORTAR = 'torre.metricas.exportar';

/**
 * Primaria de un tablero: «Exportar a Excel» (`POST /flito/torre/tableros/<area>/exportar` con `{ filtro }`, xlsx),
 * por el mismo `downloadPostNamed` y el mismo toast cerrable del Explorador. Solo con la función de exportar;
 * deshabilitado mientras el tablero carga, está vacío o falló.
 */
export function ExportarTablero<T>({ area, filtros, estado, esVacio }: {
  area: AreaTablero;
  filtros: FiltrosTorre;
  estado: EstadoTablero<T>;
  esVacio: (datos: T) => boolean;
}) {
  const { hasFuncion } = useAuth();
  const [ocupado, setOcupado] = useState(false);
  if (!hasFuncion(FUNCION_TORRE_EXPORTAR)) return null;
  const habilitado = estado.tipo === 'listo' && !esVacio(estado.datos);
  const ejecutar = async (): Promise<void> => {
    try {
      await api.downloadPostNamed(`/flito/torre/tableros/${area}/exportar`, `torre-${area}.xlsx`, { filtro: aFiltroTorre(filtros) });
      toastOk('Listo: descargamos el Excel de este tablero.', { id: 'torre-exportar' });
    } catch {
      toastError('No pudimos generar el Excel. Intente de nuevo en un momento.', () => { void ejecutar(); }, { id: 'torre-exportar' });
    }
  };
  return (
    <GradientButton type="button" ocupado={ocupado} disabled={!habilitado} data-torre="exportar-tablero"
      onClick={() => { setOcupado(true); void ejecutar().finally(() => setOcupado(false)); }}>
      <Icono nombre="nube-bajar" size={18} />
      Exportar a Excel
    </GradientButton>
  );
}

/** Subtítulo de un bloque según los filtros que ignora. */
export function notaFiltros(meta: MetaBloqueTorre, base?: string): string | undefined {
  const partes = [
    ...(base ? [base] : []),
    ...(meta.filtrosIgnorados.includes('rango') ? ['No depende del periodo elegido.'] : []),
    ...(meta.filtrosIgnorados.includes('companiaIds') ? ['No depende de la compañía elegida.'] : []),
  ];
  return partes.length ? partes.join(' ') : undefined;
}

const TONO_SEVERIDAD: Record<SeveridadTorre, TonoKit> = { ok: 'ok', atencion: 'warn', critico: 'danger' };
const TEXTO_SEVERIDAD: Record<SeveridadTorre, string> = { ok: 'En orden', atencion: 'Atención', critico: 'Crítico' };

/** Semáforo con texto (el color nunca va solo). */
export function Semaforo({ severidad, children }: { severidad: SeveridadTorre; children?: ReactNode }) {
  return (
    <span {...etiquetaKit(TONO_SEVERIDAD[severidad])} data-severidad={severidad}>
      <span className={ETIQUETA_PUNTO_CLS} aria-hidden="true" />
      {children ?? TEXTO_SEVERIDAD[severidad]}
    </span>
  );
}

/** Etiqueta con tono libre del kit (venta cruzada, variaciones). */
export function Etiqueta({ tono, children }: { tono: TonoKit; children: ReactNode }) {
  return <span {...etiquetaKit(tono)}><span className={ETIQUETA_PUNTO_CLS} aria-hidden="true" />{children}</span>;
}

export function EsqueletoTablero() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-busy="true" data-torre="tablero" data-estado="cargando">
      <span className="sr-only">Cargando el tablero</span>
      <div className={REJILLA_KPI}>{[0, 1, 2, 3].map((i) => <div key={i} className="kit-esqueleto h-[104px]" aria-hidden="true" />)}</div>
      <div className={REJILLA_2}>{[0, 1, 2, 3].map((i) => <div key={i} className="kit-esqueleto h-[260px]" aria-hidden="true" />)}</div>
    </div>
  );
}

export default function MoldeTablero<T>({ estado, nombre, esVacio, onReintentar, onLimpiar, children }: {
  estado: EstadoTablero<T>;
  /** «Comercial», «Operativo», «Financiero»… para el copy de error. */
  nombre: string;
  esVacio: (datos: T) => boolean;
  onReintentar: () => void;
  onLimpiar: () => void;
  children: (datos: T) => ReactNode;
}) {
  if (estado.tipo === 'cargando') return <EsqueletoTablero />;
  if (estado.tipo === 'error') {
    return (
      <section className="card" data-torre="tablero" data-estado="error">
        <ErrorVista texto={`No pudimos cargar el tablero ${nombre}. Intente de nuevo.`} onReintentar={onReintentar} />
      </section>
    );
  }
  if (esVacio(estado.datos)) {
    return (
      <section className="card" data-torre="tablero" data-estado="vacio">
        <Vacio texto="No hay trámites en este periodo con los filtros puestos." detalle="Amplíe el periodo o quite filtros para ver el tablero."
          accion={<GradientButton variant="secondary" size="sm" onClick={onLimpiar}>Limpiar filtros</GradientButton>} />
      </section>
    );
  }
  return <div className="flex flex-col gap-4" data-torre="tablero" data-estado="lleno">{children(estado.datos)}</div>;
}
