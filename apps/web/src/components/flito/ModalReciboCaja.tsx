// FLITO — Recibo de caja puntual desde el detalle del impuesto (HU #12592, Feature #12589).
//
// Un archivo, un impuesto, un veredicto. No reutiliza `CargaRecibos`: la masiva es otra visita
// (tandas, ZIP, tabla de resultados). Cuatro estados —inicial, cargando, resultado, error— y el
// error decide por `codigo` del cuerpo, nunca por el texto (calco de `aResultadoIntento`).
//
// Durante la carga NI Escape NI la X cierran: la petición no se puede abortar y cerrar escondería
// el desenlace (el impuesto podría quedar pagado sin que el operador lo viera).

import { useState, type RefObject } from 'react';
import { CodigoErrorReciboCaja, type ResultadoReciboCaja } from '@operaciones/shared-types';
import { ApiError, api } from '../../lib/api';
import FlitModal from '../flit/FlitModal';
import FlitUploadBox from '../flit/FlitUploadBox';
import StatusChip from '../flit/StatusChip';
import { flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle } from '../flit/flitPageKit';
import { fecha, pesos, type ImpuestoItem } from './ImpuestoCola';

/** Mismo tope que el servidor (`RECIBO_CAJA_MAX_BYTES`): la validación local evita la vuelta al API. */
export const TOPE_RECIBO_CAJA_BYTES = 15 * 1024 * 1024;
const MIME_ADMITIDOS = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const EXTENSION_ADMITIDA = /\.(pdf|jpe?g|png)$/i;

export function esReciboCajaValido(archivo: File): boolean {
  // El MIME lo pone el navegador por extensión y a veces viene vacío; se admite cualquiera de
  // las dos señales. El servidor vuelve a comprobarlo por contenido.
  const tipoOk = MIME_ADMITIDOS.has(archivo.type) || (archivo.type === '' && EXTENSION_ADMITIDA.test(archivo.name));
  return tipoOk && archivo.size <= TOPE_RECIBO_CAJA_BYTES;
}

type AccionError = 'cerrar' | 'elegir_otro' | 'reintentar';
type ClaveError = CodigoErrorReciboCaja | 'permiso' | 'servicio' | 'red';

/** Copy y salida de cada desenlace fallido. Nunca un «Ocurrió un problema» a secas. */
const ERRORES: Record<ClaveError, { texto: string; accion: AccionError; refrescar?: boolean }> = {
  [CodigoErrorReciboCaja.SIN_LIQUIDACION]: {
    texto: 'Este impuesto no tiene liquidación cargada. Súbela primero desde «Cargar recibos (masivo)» con la fase Liquidación.',
    accion: 'cerrar',
  },
  [CodigoErrorReciboCaja.ESTADO_NO_PERMITIDO]: {
    texto: 'El impuesto ya no está en gestión. Cierra y revisa su estado en la cola.',
    accion: 'cerrar', refrescar: true,
  },
  [CodigoErrorReciboCaja.DUPLICADO]: {
    texto: 'Ese archivo ya está registrado como recibo. Elige otro archivo.',
    accion: 'elegir_otro',
  },
  [CodigoErrorReciboCaja.ARCHIVO_INVALIDO]: {
    texto: 'El archivo debe ser PDF, JPG o PNG de máximo 15 MB. Elige otro archivo.',
    accion: 'elegir_otro',
  },
  [CodigoErrorReciboCaja.NO_ENCONTRADO]: {
    texto: 'Este impuesto no está disponible para tu usuario.',
    accion: 'cerrar',
  },
  permiso: {
    texto: 'Tu usuario no tiene la función para cargar recibos de caja. Pídela al administrador.',
    accion: 'cerrar',
  },
  servicio: {
    texto: 'El lector de recibos no respondió. No se guardó nada; reintenta en unos minutos.',
    accion: 'reintentar',
  },
  red: {
    texto: 'No se pudo completar la carga. Revisa tu conexión y reintenta.',
    accion: 'reintentar',
  },
};
const ROTULO_ACCION: Record<AccionError, string> = { cerrar: 'Cerrar', elegir_otro: 'Elegir otro', reintentar: 'Reintentar' };

const CODIGOS = new Set<string>(Object.values(CodigoErrorReciboCaja));

/** Se lee el `codigo` del cuerpo; sin él, el status; sin nada reconocible, «red» (= reintentar). */
function clasificarError(e: unknown): ClaveError {
  if (!(e instanceof ApiError)) return 'red';
  const cuerpo = e.rawDetails as Record<string, unknown> | null;
  const codigo = typeof cuerpo?.codigo === 'string' ? cuerpo.codigo : null;
  if (codigo && CODIGOS.has(codigo)) return codigo as CodigoErrorReciboCaja;
  if (e.status === 403) return 'permiso';
  if (e.status === 503) return 'servicio';
  return 'red';
}

const megas = (bytes: number) => `${(bytes / (1024 * 1024)).toLocaleString('es-CO', { maximumFractionDigits: 1 })} MB`;

type Fase = 'inicial' | 'cargando' | 'resultado' | 'error';

export default function ModalReciboCaja({ imp, restoreFocusRef, onClose, onListo, onRefrescar }: {
  imp: Pick<ImpuestoItem, 'id' | 'placa' | 'vin' | 'organismoNombre' | 'organismoCodigo' | 'valorLiquidado'>;
  /** Cierre sin desenlace (inicial, error). El foco vuelve al botón que abrió el modal. */
  onClose: () => void;
  /** «Listo» tras un resultado (`pagado` | `en_revision`); quien lo recibe decide qué refresca. */
  onListo: (resultado: ResultadoReciboCaja['resultado']) => void;
  /** Respaldo del foco si el botón que abrió el modal ya no existe (tras `pagado`). */
  restoreFocusRef?: RefObject<HTMLElement | null>;
  /** Refrescar la cola sin cerrar el detalle (409 `estado_no_permitido`). */
  onRefrescar: () => void;
}) {
  const [fase, setFase] = useState<Fase>('inicial');
  const [archivo, setArchivo] = useState<File | null>(null);
  const [resultado, setResultado] = useState<ResultadoReciboCaja | null>(null);
  const [clave, setClave] = useState<ClaveError | null>(null);

  const elegir = (f: File) => {
    if (!esReciboCajaValido(f)) {
      setArchivo(null); setClave(CodigoErrorReciboCaja.ARCHIVO_INVALIDO); setFase('error');
      return;
    }
    setArchivo(f); setClave(null); setFase('inicial');
  };

  const cargar = async () => {
    if (!archivo) return;
    setFase('cargando');
    try {
      const r = await api.upload<ResultadoReciboCaja>(`/flito/impuestos/${imp.id}/recibo-caja`, archivo, 'archivo');
      setResultado(r); setFase('resultado');
    } catch (e) {
      setClave(clasificarError(e)); setFase('error');
    }
  };

  const error = clave ? ERRORES[clave] : null;
  const salirDelError = () => {
    if (!error) return;
    if (error.accion === 'elegir_otro') { setArchivo(null); setClave(null); setFase('inicial'); return; }
    // «Reintentar» conserva el archivo elegido: el fallo fue del servicio, no del archivo.
    if (error.accion === 'reintentar') { setClave(null); setFase('inicial'); return; }
    if (error.refrescar) onRefrescar();
    onClose();
  };
  // En «cargando» el cierre es no-op: Escape y la X quedan sin efecto hasta que haya desenlace.
  const cerrar = fase === 'cargando' ? () => {} : onClose;

  return (
    <FlitModal title={`Recibo de caja · ${imp.placa ?? imp.vin}`} onClose={cerrar} restoreFocusRef={restoreFocusRef}>
      <div className="space-y-3 text-sm" aria-busy={fase === 'cargando'}>
        <p style={{ color: 'var(--flit-text-secondary)' }}>
          Placa {imp.placa ?? imp.vin} · Organismo {imp.organismoNombre ?? imp.organismoCodigo} · Valor liquidado {pesos(imp.valorLiquidado)}
        </p>

        {fase === 'resultado' && resultado ? (
          <div className="space-y-2">
            {resultado.resultado === 'pagado' ? (
              <>
                <div className="flex flex-wrap gap-2">
                  <StatusChip tone="success">Pagado</StatusChip>
                  {resultado.marcadoPorDiferencia && <StatusChip tone="warning">Diferencia de valor</StatusChip>}
                </div>
                <p>Valor pagado {pesos(resultado.valorPagado)} · Fecha de pago {fecha(resultado.pagadoEn)}</p>
                {resultado.marcadoPorDiferencia && (
                  <p style={{ color: 'var(--flit-text-secondary)' }}>
                    El valor pagado difiere del liquidado por encima de la tolerancia. Queda marcado para revisión.
                  </p>
                )}
              </>
            ) : (
              <>
                <StatusChip tone="warning">En revisión</StatusChip>
                <p style={{ color: 'var(--flit-text-secondary)' }}>
                  El recibo quedó guardado. La lectura no fue concluyente y pasó a la cola de revisión; el impuesto sigue Solicitado.
                </p>
              </>
            )}
            <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={() => onListo(resultado.resultado)}>Listo</button>
          </div>
        ) : fase === 'error' && error ? (
          <div className="space-y-2">
            <p role="alert" className="text-red-600">{error.texto}</p>
            <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={salirDelError}>{ROTULO_ACCION[error.accion]}</button>
          </div>
        ) : (
          <>
            <FlitUploadBox label="Recibo de caja" hint="PDF, JPG o PNG · máximo 15 MB"
              state={fase === 'cargando' ? 'uploading' : archivo ? 'verified' : 'idle'}
              count={archivo ? 1 : undefined} onFile={elegir} />
            {archivo && (
              <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{archivo.name} · {megas(archivo.size)}</p>
            )}
            <div className="flex gap-2">
              <button className={flitBtnPrimary} style={flitBtnPrimaryStyle}
                disabled={!archivo || fase === 'cargando'} onClick={cargar}>
                {fase === 'cargando' ? 'Cargando…' : 'Cargar'}
              </button>
              <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={fase === 'cargando'} onClick={onClose}>
                Cancelar
              </button>
            </div>
          </>
        )}
      </div>
    </FlitModal>
  );
}
