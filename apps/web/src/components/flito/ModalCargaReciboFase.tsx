// FLITO — Comprobante de la hacienda (liquidación o pago) cargado desde el detalle del impuesto
// (HU #13209, Feature #12955). Spec: docs/ux/flito-impuestos-carga-comprobante-por-fase.md.
//
// Hermano de `ModalReciboCaja`: un archivo, un impuesto, un veredicto, por
// `POST /api/flito/impuestos/:id/recibos` (HU #13208). La única decisión es la FASE, sin valor por
// defecto: adivinarla convertiría un error del operador en un rechazo del lector (`fase_no_coincide`).
// La pantalla decide por `resultado` (200) o por `codigo` (4xx), nunca por el texto, y nunca pinta
// la placa leída del documento ni el error crudo del API.
//
// Durante la carga NI Escape NI la X cierran: la petición no se aborta y cerrar escondería el
// desenlace (calco del vecino).

import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  CodigoErrorCargaPorFase, FASES_RECIBO, type FaseRecibo, type RespuestaCargaPorFase,
} from '@operaciones/shared-types';
import { ApiError, api } from '../../lib/api';
import FlitModal from '../flit/FlitModal';
import FlitUploadBox from '../flit/FlitUploadBox';
import StatusChip from '../flit/StatusChip';
import { flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle } from '../flit/flitPageKit';
import { esReciboCajaValido } from './ModalReciboCaja';
import { pesos, type ImpuestoItem } from './ImpuestoCola';

/** Resultados 200 que guardaron un soporte: solo estos cierran con «Listo» y refrescan. */
export type ResultadoConEscritura = 'liquidado' | 'pagado' | 'en_revision' | 'complemento';
type ConEscritura = Extract<RespuestaCargaPorFase, { resultado: ResultadoConEscritura }>;
type SinEscritura = Extract<RespuestaCargaPorFase, { detalle: string }>;

const OPCIONES: Record<FaseRecibo, { nombre: string; ayuda: string }> = {
  liquidacion: { nombre: 'Liquidación', ayuda: 'El documento que fija el valor a pagar.' },
  pago: { nombre: 'Pago', ayuda: 'El recibo con el sello PAGADO.' },
};

const DOCUMENTOS_TEXTO: Record<NonNullable<ImpuestoItem['documentos']>, string> = {
  liquidacion: 'Solo liquidación', pago: 'Solo pago', ambos: 'Liquidación y pago',
};

type AccionError = 'cerrar' | 'elegir_otro' | 'elegir_fase' | 'reintentar';
type ClaveError = CodigoErrorCargaPorFase | 'permiso' | 'limite' | 'servicio' | 'red';

const ERRORES: Record<ClaveError, { texto: string; accion: AccionError; refrescar?: boolean }> = {
  [CodigoErrorCargaPorFase.ARCHIVO_INVALIDO]: {
    texto: 'El archivo debe ser PDF, JPG o PNG de máximo 15 MB. Elige otro archivo.', accion: 'elegir_otro',
  },
  [CodigoErrorCargaPorFase.FASE_INVALIDA]: {
    texto: 'Falta la fase del comprobante. Elígela y vuelve a cargar.', accion: 'elegir_fase',
  },
  [CodigoErrorCargaPorFase.NO_ENCONTRADO]: {
    texto: 'Este impuesto ya no está disponible para tu usuario. Cierra y actualiza la cola.', accion: 'cerrar', refrescar: true,
  },
  [CodigoErrorCargaPorFase.ESTADO_NO_PERMITIDO]: {
    texto: 'El impuesto ya no está en gestión ni pagado. Cierra y revisa su estado.', accion: 'cerrar', refrescar: true,
  },
  permiso: { texto: 'Tu usuario no tiene la función para cargar comprobantes. Pídela al administrador.', accion: 'cerrar' },
  limite: { texto: 'Hiciste muchas cargas seguidas. Espera unos minutos y reintenta.', accion: 'reintentar' },
  servicio: { texto: 'El lector de comprobantes no respondió. No se guardó nada; reintenta en unos minutos.', accion: 'reintentar' },
  red: { texto: 'No se pudo completar la carga. Revisa tu conexión y reintenta.', accion: 'reintentar' },
};
const ROTULO_ACCION: Record<AccionError, string> = {
  cerrar: 'Cerrar', elegir_otro: 'Elegir otro', elegir_fase: 'Elegir fase', reintentar: 'Reintentar',
};

/** Frase y salida de los 200 que no guardaron nada. El `detalle` del servidor va de segunda línea. */
const SIN_ESCRITURA: Record<SinEscritura['resultado'], { texto: string; salida: 'elegir_otro' | 'cambiar_fase' }> = {
  duplicado: { texto: 'Este comprobante ya estaba registrado.', salida: 'elegir_otro' },
  fase_no_coincide: {
    texto: 'El documento no corresponde a la fase que elegiste. Revisa si es la liquidación o el pago.', salida: 'cambiar_fase',
  },
  placa_no_coincide: {
    texto: 'El comprobante es de otro vehículo: la placa del documento no es la de este impuesto. Verifica que elegiste el archivo correcto.',
    salida: 'elegir_otro',
  },
};

const CODIGOS = new Set<string>(Object.values(CodigoErrorCargaPorFase));
const POR_STATUS: Record<number, ClaveError> = {
  400: CodigoErrorCargaPorFase.ARCHIVO_INVALIDO, 403: 'permiso', 404: CodigoErrorCargaPorFase.NO_ENCONTRADO,
  409: CodigoErrorCargaPorFase.ESTADO_NO_PERMITIDO, 429: 'limite', 503: 'servicio',
};

/** El `codigo` del cuerpo manda; sin él, el status; sin nada reconocible, «red» (= reintentar). */
function clasificarError(e: unknown): ClaveError {
  if (!(e instanceof ApiError)) return 'red';
  const cuerpo = e.rawDetails as Record<string, unknown> | null;
  const codigo = typeof cuerpo?.codigo === 'string' ? cuerpo.codigo : null;
  if (codigo && CODIGOS.has(codigo)) return codigo as CodigoErrorCargaPorFase;
  return POR_STATUS[e.status] ?? 'red';
}

const megas = (bytes: number) => `${(bytes / (1024 * 1024)).toLocaleString('es-CO', { maximumFractionDigits: 1 })} MB`;
const aNumero = (v: string | null) => (v === null ? null : Number(v));

type Paso = 'inicial' | 'cargando' | 'resultado' | 'error';

export default function ModalCargaReciboFase({ imp, restoreFocusRef, onClose, onListo, onRefrescar }: {
  imp: Pick<ImpuestoItem, 'id' | 'placa' | 'vin' | 'organismoNombre' | 'organismoCodigo' | 'documentos'>;
  /** Cierre sin escritura (inicial, error, resultado que no guardó). */
  onClose: () => void;
  /** «Listo» tras un resultado con escritura: quien lo recibe refresca estado y soportes. */
  onListo: (resultado: ResultadoConEscritura, fase: FaseRecibo) => void;
  /** Respaldo del foco si el botón que abrió el modal ya no existe tras el refresco. */
  restoreFocusRef?: RefObject<HTMLElement | null>;
  /** Refrescar la cola sin cerrar el detalle (404 / 409). */
  onRefrescar: () => void;
}) {
  const [paso, setPaso] = useState<Paso>('inicial');
  const [fase, setFase] = useState<FaseRecibo | null>(null);
  const [archivo, setArchivo] = useState<File | null>(null);
  const [respuesta, setRespuesta] = useState<RespuestaCargaPorFase | null>(null);
  const [clave, setClave] = useState<ClaveError | null>(null);
  const primariaRef = useRef<HTMLButtonElement>(null);
  const radiosRef = useRef<Partial<Record<FaseRecibo, HTMLInputElement | null>>>({});
  const [focoEnFase, setFocoEnFase] = useState(false);

  const yaCargada = (f: FaseRecibo) => imp.documentos === f || imp.documentos === 'ambos';
  const cargando = paso === 'cargando';
  const falta = !fase || !archivo;
  const idFalta = `carga-fase-falta-${imp.id}`;

  // Al llegar al desenlace, el foco va a su primaria (el texto se anuncia por status/alert).
  useEffect(() => { if (paso === 'resultado' || paso === 'error') primariaRef.current?.focus(); }, [paso]);
  // «Cambiar fase» / «Elegir fase»: el foco al primer radio habilitado cuando el formulario ya está.
  useEffect(() => {
    if (!focoEnFase || paso !== 'inicial') return;
    const primera = FASES_RECIBO.find((f) => imp.documentos !== f && imp.documentos !== 'ambos');
    if (primera) radiosRef.current[primera]?.focus();
    setFocoEnFase(false);
  }, [focoEnFase, paso, imp.documentos]);

  const volverAlFormulario = (cambios: { limpiarArchivo?: boolean; limpiarFase?: boolean }) => {
    if (cambios.limpiarArchivo) setArchivo(null);
    if (cambios.limpiarFase) { setFase(null); setFocoEnFase(true); }
    setClave(null); setRespuesta(null); setPaso('inicial');
  };

  const elegir = (f: File) => {
    if (!esReciboCajaValido(f)) {
      setArchivo(null); setClave(CodigoErrorCargaPorFase.ARCHIVO_INVALIDO); setPaso('error');
      return;
    }
    setArchivo(f); setClave(null); setPaso('inicial');
  };

  const cargar = async () => {
    if (!archivo || !fase) return;
    setPaso('cargando');
    try {
      const r = await api.upload<RespuestaCargaPorFase>(`/flito/impuestos/${imp.id}/recibos`, archivo, 'archivo', { fase });
      setRespuesta(r); setPaso('resultado');
    } catch (e) {
      setClave(clasificarError(e)); setPaso('error');
    }
  };

  const error = clave ? ERRORES[clave] : null;
  const salirDelError = () => {
    if (!error) return;
    if (error.accion === 'elegir_otro') return volverAlFormulario({ limpiarArchivo: true });
    if (error.accion === 'elegir_fase') return volverAlFormulario({ limpiarFase: true });
    // «Reintentar» conserva fase y archivo: el fallo fue del servicio, no de lo elegido.
    if (error.accion === 'reintentar') return volverAlFormulario({});
    if (error.refrescar) onRefrescar();
    onClose();
  };

  return (
    <FlitModal title={`Cargar comprobante · ${imp.placa ?? imp.vin}`} onClose={onClose} cierreBloqueado={cargando}
      restoreFocusRef={restoreFocusRef}>
      <div className="space-y-3 text-sm" aria-busy={cargando}>
        <p style={{ color: 'var(--flit-text-secondary)' }}>
          Organismo {imp.organismoNombre ?? imp.organismoCodigo} · Documentos: {imp.documentos ? DOCUMENTOS_TEXTO[imp.documentos] : 'Sin documentos cargados'}
        </p>

        {paso === 'resultado' && respuesta ? (
          'detalle' in respuesta ? (
            <div className="space-y-2">
              <div role="status" className="space-y-2">
                <StatusChip tone="warning">No se guardó</StatusChip>
                <p>{SIN_ESCRITURA[respuesta.resultado].texto}</p>
                {respuesta.detalle && <p style={{ color: 'var(--flit-text-secondary)' }}>{respuesta.detalle}</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                {SIN_ESCRITURA[respuesta.resultado].salida === 'cambiar_fase' ? (
                  <button ref={primariaRef} type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
                    onClick={() => volverAlFormulario({ limpiarFase: true })}>Cambiar fase</button>
                ) : (
                  <button ref={primariaRef} type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
                    onClick={() => volverAlFormulario({ limpiarArchivo: true })}>Elegir otro archivo</button>
                )}
                <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>Cerrar</button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <ResultadoGuardado r={respuesta} />
              <button ref={primariaRef} type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
                onClick={() => onListo(respuesta.resultado, fase!)}>Listo</button>
            </div>
          )
        ) : paso === 'error' && error ? (
          <div className="space-y-2">
            <p role="alert" style={{ color: 'var(--flit-danger-text)' }}>{error.texto}</p>
            <button ref={primariaRef} type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={salirDelError}>
              {ROTULO_ACCION[error.accion]}
            </button>
          </div>
        ) : (
          <>
            <fieldset disabled={cargando} className="space-y-1">
              <legend className="mb-1 text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Fase del comprobante *</legend>
              {FASES_RECIBO.map((f) => {
                const cargada = yaCargada(f);
                return (
                  <label key={f}
                    className={`flex items-start gap-2 rounded-md p-2 transition-colors ${cargada ? 'cursor-default' : 'cursor-pointer hover:bg-[var(--flit-bg-hover)]'}`}>
                    <input ref={(el) => { radiosRef.current[f] = el; }} type="radio" name={`fase-comprobante-${imp.id}`}
                      value={f} checked={fase === f} disabled={cargada} required onChange={() => setFase(f)}
                      className="flit-focus mt-0.5" style={{ accentColor: 'var(--flit-blue)' }} />
                    <span style={{ color: cargada ? 'var(--flit-text-muted)' : undefined }}>
                      <span className="font-semibold">{OPCIONES[f].nombre}</span>
                      <span className="block text-xs" style={{ color: cargada ? 'var(--flit-text-muted)' : 'var(--flit-text-secondary)' }}>
                        {cargada ? 'Ya cargada' : OPCIONES[f].ayuda}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
            <FlitUploadBox label="Archivo" required hint="PDF, JPG o PNG · máximo 15 MB"
              state={cargando ? 'uploading' : archivo ? 'verified' : 'idle'}
              count={archivo ? 1 : undefined} onFile={elegir} />
            {archivo && (
              <p className="break-all text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{archivo.name} · {megas(archivo.size)}</p>
            )}
            <div className="flex flex-wrap gap-2">
              <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
                disabled={falta || cargando} aria-describedby={falta ? idFalta : undefined} onClick={cargar}>
                {cargando ? 'Leyendo el comprobante…' : 'Cargar'}
              </button>
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={cargando} onClick={onClose}>
                Cancelar
              </button>
            </div>
            {falta && (
              <p id={idFalta} className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>Elige la fase y el archivo para cargar.</p>
            )}
          </>
        )}
      </div>
    </FlitModal>
  );
}

function ResultadoGuardado({ r }: { r: ConEscritura }) {
  const segunda = (t: string) => <p style={{ color: 'var(--flit-text-secondary)' }}>{t}</p>;
  return (
    <div role="status" className="space-y-2">
      {r.resultado === 'liquidado' && (
        <>
          <StatusChip tone="success">Liquidación cargada</StatusChip>
          <p>{r.valorLiquidado === null
            ? 'La liquidación quedó guardada, pero el valor no se leyó con claridad y no se registró. Revísalo en «Ver soporte».'
            : `Valor liquidado ${pesos(aNumero(r.valorLiquidado))}. El impuesto sigue Solicitado; falta el pago.`}</p>
        </>
      )}
      {r.resultado === 'pagado' && (
        <>
          <div className="flex flex-wrap gap-2">
            <StatusChip tone="success">Pagado</StatusChip>
            {r.marcadoPorDiferencia && <StatusChip tone="warning">Diferencia de valor</StatusChip>}
          </div>
          <p>Valor pagado {pesos(aNumero(r.valorPagado))}. El impuesto pasó a Pagado.</p>
          {r.marcadoPorDiferencia && segunda('El valor pagado difiere del liquidado por encima de la tolerancia. Queda marcado para revisión.')}
        </>
      )}
      {r.resultado === 'en_revision' && (
        <>
          <StatusChip tone="warning">En revisión</StatusChip>
          {segunda('El pago quedó guardado, pero el sello PAGADO o el valor no se leyó con claridad. Pasó a la cola de revisión; el impuesto sigue Solicitado hasta que se apruebe.')}
        </>
      )}
      {r.resultado === 'complemento' && (
        <>
          <StatusChip tone="success">Comprobante agregado</StatusChip>
          <p>Quedó guardado junto a los soportes. El impuesto sigue Pagado.</p>
        </>
      )}
    </div>
  );
}
