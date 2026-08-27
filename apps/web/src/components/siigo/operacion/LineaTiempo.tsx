// AC6 — la línea de tiempo: los hitos en orden, con fecha, resultado y origen.
//
// **Y un trámite sin facturación iniciada LO DICE**, en vez de mostrarse vacío. Son dos vacíos
// distintos y no pueden compartir mensaje: uno es un trámite que nunca empezó y el otro es una
// laguna del registro. Confundirlos hace que nadie mire la laguna.
//
// Este panel tiene sus PROPIOS cuatro estados. Si falla, el resto del detalle sigue en pie y las
// acciones siguen disponibles: no saber el historial no impide reintentar.
//
// **Dos formas del contrato que no están en `@operaciones/shared-types` y por eso se declaran aquí:**
// el DTO de la línea de tiempo y la lista de hitos que no son llamadas viven en
// `apps/api/src/modules/siigo/siigo.linea-tiempo.service.ts`, que la web no puede importar. Queda
// anotado para backend: son tipos puros con dos consumidores, exactamente el criterio con el que
// `GuiaErrorSiigo` se mudó a tipos compartidos en la HU #11340.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, errorMessage } from '../../../lib/api';
import { flitBtnSecondarySm, flitBtnSecondaryStyle } from '../../flit/flitPageKit';
import { fecha } from '../estilos';

type FuenteHito = 'liquidacion' | 'siigo' | 'dian';

interface HitoLineaTiempo {
  fuente: FuenteHito;
  tipo: string;
  detalle: string | null;
  resultado: 'ok' | 'error' | 'informativo';
  ocurridoEn: string;
  usuarioId: number | null;
}

interface LineaTiempoTramite {
  tramiteId: string;
  facturacionIniciada: boolean;
  facturaId: string | null;
  hitos: HitoLineaTiempo[];
}

/**
 * Hitos que la bitácora escribe SIN que haya salido ninguna petición.
 *
 * Pintarlos como «Siigo» diría que salió una llamada que no salió, justo en el relato que existe
 * para reconstruir qué pasó de verdad. Como el DTO no expone el método HTTP, la web lo deduce del
 * tipo. Es una copia de `HITOS_SIN_LLAMADA` del servidor y está señalada como tal.
 */
const HITOS_SIN_LLAMADA = new Set([
  'encolada', 'marcada_fallido_definitivo', 'reenvio_solicitado', 'correccion_registrada',
]);

/** El tope del servidor. Si llegan exactamente tantos, hay historial que no se está viendo. */
const TOPE_HITOS = 200;

const RESULTADO: Record<HitoLineaTiempo['resultado'], { simbolo: string; color: string }> = {
  // Símbolo Y color, nunca color solo.
  ok: { simbolo: '✓', color: 'var(--flit-success-ink)' },
  error: { simbolo: '✕', color: 'var(--flit-danger-ink)' },
  informativo: { simbolo: '•', color: 'var(--flit-text-secondary)' },
};

const ORIGEN: Record<FuenteHito, string> = {
  liquidacion: 'Liquidación',
  siigo: 'Siigo',
  dian: 'DIAN',
};

function origenDe(hito: HitoLineaTiempo): string {
  if (hito.fuente === 'siigo' && HITOS_SIN_LLAMADA.has(hito.tipo)) return 'FLITO';
  return ORIGEN[hito.fuente];
}

export default function LineaTiempo({ tramiteId }: { tramiteId: string | null }) {
  const [datos, setDatos] = useState<LineaTiempoTramite | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    if (!tramiteId) { setCargando(false); return undefined; }
    let vivo = true;
    setCargando(true);
    setError(null);
    api.get<LineaTiempoTramite>(`/siigo/linea-tiempo/${tramiteId}`).then((d) => {
      if (!vivo) return;
      setDatos(d);
      setCargando(false);
    }).catch((e) => {
      if (!vivo) return;
      setError(errorMessage(e));
      setDatos(null);
      setCargando(false);
    });
    return () => { vivo = false; };
  }, [tramiteId, recarga]);

  const reintentar = useCallback(() => setRecarga((n) => n + 1), []);

  if (!tramiteId) {
    return (
      <Nota>
        Este caso no tiene ningún trámite asociado, así que no hay línea de tiempo que reconstruir.
      </Nota>
    );
  }
  if (cargando) return <p role="status" className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>Reconstruyendo lo que pasó…</p>;
  if (error || !datos) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p role="alert" className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
          No se pudo cargar la línea de tiempo: {error ?? 'sin datos'}.
        </p>
        <button type="button" onClick={reintentar} className={flitBtnSecondarySm} style={flitBtnSecondaryStyle}>
          Volver a cargar la línea de tiempo
        </button>
      </div>
    );
  }

  // AC6, la mitad que importa: un trámite sin facturación iniciada lo DICE.
  if (!datos.facturacionIniciada) {
    return (
      <Nota>
        Este trámite nunca se envió a facturación electrónica. No hay nada que haya fallado: todavía
        no ha empezado. Se envía desde el reporte de costos.
      </Nota>
    );
  }

  // El otro vacío, y con OTRA frase: hay factura pero no quedó ni un hito.
  if (datos.hitos.length === 0) {
    return (
      <Nota>
        Hay una factura asociada pero no se registró ningún hito. Es un dato incompleto del registro,
        no un trámite sin actividad.
      </Nota>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {datos.hitos.length >= TOPE_HITOS && (
        <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          Se muestran {TOPE_HITOS} hitos de un historial más largo.
        </p>
      )}
      <ol className="flex flex-col gap-2">
        {datos.hitos.map((hito, i) => {
          const r = RESULTADO[hito.resultado];
          return (
            <li
              key={`${hito.ocurridoEn}-${hito.tipo}-${i}`}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-l-2 pl-3"
              style={{ borderColor: 'var(--flit-border-soft)' }}
            >
              <span className="text-xs tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>
                {fecha(hito.ocurridoEn)}
              </span>
              <span className="text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
                {origenDe(hito)}
              </span>
              <span className="text-sm font-semibold" style={{ color: r.color }}>
                {r.simbolo} {hito.resultado === 'ok' ? 'Correcto' : hito.resultado === 'error' ? 'Con error' : 'Informativo'}
              </span>
              <span className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
                {hito.detalle ?? hito.tipo}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Nota({ children }: { children: ReactNode }) {
  return (
    <p
      className="rounded-[10px] px-4 py-3 text-sm"
      style={{ background: 'var(--flit-bg-app)', color: 'var(--flit-text-primary)' }}
    >
      {children}
    </p>
  );
}
