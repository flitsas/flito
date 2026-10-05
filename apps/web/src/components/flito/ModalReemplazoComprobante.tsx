// FLITO — Reemplazo del comprobante de pago de un impuesto Pagado (HU #13270, Feature #13267).
// Spec: docs/ux/flito-impuestos-envio-flit2-y-reemplazo.md. Contrato: HU #13269
// (`POST /api/flito/impuestos/:id/recibos/reemplazar-pago`).
//
// Hermano de `ModalCargaReciboFase`: un archivo, un impuesto, un veredicto. Decide por `resultado`
// (200) o por `codigo` (4xx), nunca por el texto, y nunca pinta el error crudo ni la placa leída.
// El éxito (`reemplazado`) NO se pinta aquí: cierra y lo anuncia quien lo monta con un toast.
// Durante el envío ni Escape ni la X cierran (calco del vecino: la petición no se aborta).

import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  CodigoErrorReemplazoComprobante, type EnvioComprobanteFlit2, type ReprogramacionEnvioFlit2,
  type RespuestaReemplazoComprobante,
} from '@operaciones/shared-types';
import { ApiError, impuestosApi } from '../../lib/api';
import FlitModal from '../flit/FlitModal';
import FlitUploadBox from '../flit/FlitUploadBox';
import StatusChip from '../flit/StatusChip';
import { flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle } from '../flit/flitPageKit';
import { esReciboCajaValido } from './ModalReciboCaja';
import type { ImpuestoItem } from './ImpuestoCola';

type SinEscritura = Extract<RespuestaReemplazoComprobante, { detalle: string }>;
type AccionError = 'cerrar' | 'elegir_otro' | 'reintentar';
type ClaveError = CodigoErrorReemplazoComprobante | 'permiso' | 'limite' | 'servicio' | 'red';

const ERRORES: Record<ClaveError, { texto: string; accion: AccionError; refrescar?: boolean }> = {
  [CodigoErrorReemplazoComprobante.ARCHIVO_INVALIDO]: {
    texto: 'El archivo debe ser PDF, JPG o PNG de máximo 15 MB. Elige otro archivo.', accion: 'elegir_otro',
  },
  permiso: { texto: 'Tu usuario no tiene la función para reemplazar comprobantes. Pídela al administrador.', accion: 'cerrar' },
  [CodigoErrorReemplazoComprobante.NO_ENCONTRADO]: {
    texto: 'Este impuesto ya no está disponible para tu usuario. Cierra y actualiza la cola.', accion: 'cerrar', refrescar: true,
  },
  [CodigoErrorReemplazoComprobante.SIN_COMPROBANTE_VIGENTE]: {
    texto: 'Este impuesto no tiene un comprobante de pago que reemplazar. Cárgalo con «Cargar comprobante».', accion: 'cerrar', refrescar: true,
  },
  [CodigoErrorReemplazoComprobante.ESTADO_NO_PERMITIDO]: {
    texto: 'Solo se reemplaza el comprobante de un impuesto Pagado, y este ya no lo está. Cierra y revisa su estado.',
    accion: 'cerrar', refrescar: true,
  },
  limite: { texto: 'Hiciste muchos reemplazos seguidos. Espera unos minutos y reintenta.', accion: 'reintentar' },
  servicio: { texto: 'El lector de comprobantes no respondió. No se reemplazó nada; reintenta en unos minutos.', accion: 'reintentar' },
  red: { texto: 'No se pudo completar el reemplazo. Revisa tu conexión y reintenta.', accion: 'reintentar' },
};
const ROTULO_ACCION: Record<AccionError, string> = { cerrar: 'Cerrar', elegir_otro: 'Elegir otro', reintentar: 'Reintentar' };

const SIN_ESCRITURA: Record<SinEscritura['resultado'], string> = {
  duplicado: 'Este archivo ya estaba cargado en FLITO.',
  fase_no_coincide: 'El documento no es un comprobante de pago. Elige el recibo con el sello PAGADO.',
  placa_no_coincide: 'El comprobante es de otro vehículo: la placa del documento no es la de este impuesto. Verifica que elegiste el archivo correcto.',
};

const CODIGOS = new Set<string>(Object.values(CodigoErrorReemplazoComprobante));
const POR_STATUS: Record<number, ClaveError> = {
  400: CodigoErrorReemplazoComprobante.ARCHIVO_INVALIDO, 403: 'permiso', 404: CodigoErrorReemplazoComprobante.NO_ENCONTRADO,
  409: CodigoErrorReemplazoComprobante.ESTADO_NO_PERMITIDO, 429: 'limite', 503: 'servicio',
};

/** El `codigo` del cuerpo manda; sin él, el status; sin nada reconocible, «red» (= reintentar). */
function clasificarError(e: unknown): ClaveError {
  if (!(e instanceof ApiError)) return 'red';
  const cuerpo = e.rawDetails as Record<string, unknown> | null;
  const codigo = typeof cuerpo?.codigo === 'string' ? cuerpo.codigo : null;
  if (codigo && CODIGOS.has(codigo)) return codigo as CodigoErrorReemplazoComprobante;
  return POR_STATUS[e.status] ?? 'red';
}

const megas = (bytes: number) => `${(bytes / (1024 * 1024)).toLocaleString('es-CO', { maximumFractionDigits: 1 })} MB`;
const VIGENTE = 'El comprobante anterior sigue vigente.';
const secundario = { color: 'var(--flit-text-secondary)' };

type Paso = 'inicial' | 'cargando' | 'resultado' | 'error';

export default function ModalReemplazoComprobante({ imp, envioActual, restoreFocusRef, onClose, onReemplazado, onRefrescar }: {
  imp: Pick<ImpuestoItem, 'id' | 'placa' | 'vin' | 'organismoNombre' | 'organismoCodigo'>;
  /** Estado del envío a FLIT 2 que ya trae el detalle: con `ya_cargado_gestor` se avisa antes. */
  envioActual: EnvioComprobanteFlit2 | null | undefined;
  /** Respaldo del foco si el botón que abrió el modal ya no existe tras el refresco. */
  restoreFocusRef?: RefObject<HTMLElement | null>;
  /** Cierre sin escritura (inicial, error, rechazo). */
  onClose: () => void;
  /** 200 `reemplazado`: quien lo monta cierra, avisa con toast y refresca. */
  onReemplazado: (envio: ReprogramacionEnvioFlit2 | undefined) => void;
  /** Refrescar sin cerrar el detalle (404 / 409). */
  onRefrescar: () => void;
}) {
  const [paso, setPaso] = useState<Paso>('inicial');
  const [archivo, setArchivo] = useState<File | null>(null);
  const [rechazo, setRechazo] = useState<SinEscritura | null>(null);
  const [clave, setClave] = useState<ClaveError | null>(null);
  const primariaRef = useRef<HTMLButtonElement>(null);

  const cargando = paso === 'cargando';
  const idFalta = `reemplazo-falta-${imp.id}`;
  const idAviso = `reemplazo-aviso-${imp.id}`;

  useEffect(() => { if (paso === 'resultado' || paso === 'error') primariaRef.current?.focus(); }, [paso]);

  const volverAlFormulario = (limpiarArchivo: boolean) => {
    if (limpiarArchivo) setArchivo(null);
    setClave(null); setRechazo(null); setPaso('inicial');
  };

  const elegir = (f: File) => {
    if (!esReciboCajaValido(f)) {
      setArchivo(null); setClave(CodigoErrorReemplazoComprobante.ARCHIVO_INVALIDO); setPaso('error');
      return;
    }
    setArchivo(f); setClave(null); setPaso('inicial');
  };

  const reemplazar = async () => {
    if (!archivo) return;
    setPaso('cargando');
    try {
      const r = await impuestosApi.reemplazarComprobantePago(imp.id, archivo);
      if (r.resultado === 'reemplazado') { onReemplazado(r.envioFlit2); return; }
      setRechazo(r); setPaso('resultado');
    } catch (e) {
      setClave(clasificarError(e)); setPaso('error');
    }
  };

  const error = clave ? ERRORES[clave] : null;
  const salirDelError = () => {
    if (!error) return;
    if (error.accion === 'elegir_otro') return volverAlFormulario(true);
    // «Reintentar» conserva el archivo: el fallo fue del servicio, no de lo elegido.
    if (error.accion === 'reintentar') return volverAlFormulario(false);
    if (error.refrescar) onRefrescar();
    onClose();
  };

  return (
    <FlitModal title={`Reemplazar comprobante de pago · ${imp.placa ?? imp.vin}`} onClose={onClose} cierreBloqueado={cargando}
      restoreFocusRef={restoreFocusRef}>
      <div className="space-y-3 text-sm" aria-busy={cargando}>
        <p style={secundario}>Organismo {imp.organismoNombre ?? imp.organismoCodigo}</p>

        {paso === 'resultado' && rechazo ? (
          <div className="space-y-2">
            <div role="status" className="space-y-2">
              <StatusChip tone="warning">No se reemplazó</StatusChip>
              <p>{SIN_ESCRITURA[rechazo.resultado]}</p>
              {rechazo.detalle && <p style={secundario}>{rechazo.detalle}</p>}
              <p style={secundario}>{VIGENTE}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button ref={primariaRef} type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
                onClick={() => volverAlFormulario(true)}>Elegir otro archivo</button>
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>Cerrar</button>
            </div>
          </div>
        ) : paso === 'error' && error ? (
          <div className="space-y-2">
            <p role="alert" style={{ color: 'var(--flit-danger-text)' }}>{error.texto}</p>
            <p style={secundario}>{VIGENTE}</p>
            <button ref={primariaRef} type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={salirDelError}>
              {ROTULO_ACCION[error.accion]}
            </button>
          </div>
        ) : (
          <>
            <div id={idAviso} className="space-y-1 rounded-md border p-3"
              style={{ borderColor: 'var(--flit-warning)', color: 'var(--flit-text-primary)' }}>
              <p>El comprobante de pago actual se descarta y queda el nuevo. El valor pagado y la fecha de pago no cambian.</p>
              {envioActual?.estado === 'ya_cargado_gestor' && (
                <p>El gestor ya cargó su comprobante en FLIT 2: el nuevo queda solo en FLITO.</p>
              )}
            </div>
            <FlitUploadBox label="Nuevo comprobante de pago" required hint="PDF, JPG o PNG · máximo 15 MB"
              state={cargando ? 'uploading' : archivo ? 'verified' : 'idle'} describedBy={idAviso}
              count={archivo ? 1 : undefined} onFile={elegir} />
            {archivo && (
              <p className="break-all text-xs" style={secundario}>{archivo.name} · {megas(archivo.size)}</p>
            )}
            <div className="flex flex-wrap gap-2">
              <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
                disabled={!archivo || cargando} aria-describedby={!archivo ? idFalta : undefined} onClick={reemplazar}>
                {cargando ? 'Validando el comprobante…' : 'Reemplazar comprobante'}
              </button>
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={cargando} onClick={onClose}>
                Cancelar
              </button>
            </div>
            {!archivo && (
              <p id={idFalta} className="text-xs" style={secundario}>Elige el archivo del nuevo comprobante.</p>
            )}
          </>
        )}
      </div>
    </FlitModal>
  );
}
