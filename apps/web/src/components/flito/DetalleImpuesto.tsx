// FLITO — Detalle de un impuesto de la cola (modal). Sale de `pages/FlitoImpuestos.tsx` en la HU
// #12592: la página rozaba `max-lines` y el detalle gana aquí el chip de documentos, el dato
// «Liquidado el», el botón «Cargar recibo de caja» y su modal.

import { useRef, useState } from 'react';
import { ESTADO_IMPUESTO_LABEL, EstadoImpuesto } from '@operaciones/shared-types';
import { api, errorMessage } from '../../lib/api';
import FlitModal from '../flit/FlitModal';
import HistorialEstados from '../flit/HistorialEstados';
import StatusChip from '../flit/StatusChip';
import ChipSinGestion from '../flit/ChipSinGestion';
import VisorSoportes from '../flit/VisorSoportes';
import ModalFacturaVenta, { esNombrePlacaOrganismo, nombreFacturaVenta } from '../flit/ModalFacturaVenta';
import { documentoConTipo } from '../flit/columnasComunes';
import { FlitField, flitInp, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle } from '../flit/flitPageKit';
import ModalReciboCaja from './ModalReciboCaja';
import { ChipDocumentos, TONO_IMPUESTO, fecha, pesos, type ImpuestoItem } from './ImpuestoCola';
import { SeccionValidacion } from './ValidacionRunt';

const ESTADOS_OPERACIONES: EstadoImpuesto[] = [
  EstadoImpuesto.PENDIENTE, EstadoImpuesto.SOLICITADO, EstadoImpuesto.CON_NOVEDAD, EstadoImpuesto.PAGADO,
];

type Accion = 'idle' | 'rechazar' | 'reactivar' | 'reversar' | 'asumir' | 'devolver';

export default function DetalleImpuesto({
  imp, esOperaciones, esGestor, soloLectura, puedeCargarCaja, onClose, onCambio, onTraspaso,
}: {
  imp: ImpuestoItem; esOperaciones: boolean; esGestor: boolean; soloLectura: boolean;
  /** `hasFuncion('impuestos.recibos.cargar_caja')`: sin ella el botón no se pinta (ni en gris). */
  puedeCargarCaja: boolean;
  onClose: () => void; onCambio: () => void; onTraspaso: () => void;
}) {
  const [accion, setAccion] = useState<Accion>('idle');
  const [motivo, setMotivo] = useState('');
  const [estadoDestino, setEstadoDestino] = useState<EstadoImpuesto>(EstadoImpuesto.PENDIENTE);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  // Visor de los recibos de ESTE impuesto, encima del detalle.
  const [verSoportes, setVerSoportes] = useState(false);
  // Visor de la factura de venta (modal): blob url + nombre para descargar.
  const [factura, setFactura] = useState<{ url: string; nombre: string } | null>(null);
  // Recibo de caja puntual (HU #12592), encima del detalle.
  const [reciboCaja, setReciboCaja] = useState(false);
  // Tras un `pagado` el detalle NO se cierra (AC6): se refresca a Pagado. Pero entre el «Listo» y la
  // fila nueva hay una petición en vuelo, y en ese hueco el impuesto de las props sigue Solicitado:
  // esta marca apaga el botón en el mismo commit en que se cierra el modal, para que el foco no
  // vuelva a un botón que va a desaparecer un tick después, sino a «Ver soporte».
  const [pagadoDesdeCaja, setPagadoDesdeCaja] = useState(false);
  const verSoporteRef = useRef<HTMLButtonElement>(null);

  const enGestion = imp.estado === EstadoImpuesto.SOLICITADO;
  const rechazado = imp.estado === EstadoImpuesto.CON_NOVEDAD;
  // El traspaso de gestión solo tiene sentido mientras el impuesto está en gestión y sin pagar:
  // sobre uno Pagado no queda nada que gestionar, y uno Pendiente aún no se ha enviado a nadie.
  const traspasable = enGestion || rechazado;
  // El botón existe solo con la función Y en gestión; sin liquidación sigue en el DOM (alcanzable
  // con Tab) pero `aria-disabled` y con el motivo visible: es «primero haz esto», no «no puedes».
  const ofreceCaja = puedeCargarCaja && enGestion && !pagadoDesdeCaja;
  const sinLiquidacion = imp.liquidadoEn === null;

  const ejecutar = async (fn: () => Promise<unknown>) => {
    setEnviando(true); setError(null);
    try { await fn(); onCambio(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setEnviando(false); }
  };

  /**
   * El traspaso de gestión no cierra el detalle: quien lo asume suele querer seguir en el mismo
   * impuesto, y ver ahí mismo que ya lo gestiona Operaciones es la confirmación de que funcionó.
   * Si el traspaso lo saca de la vista filtrada, la fila desaparece y el detalle se cierra solo.
   */
  const traspasar = async (ruta: string) => {
    setEnviando(true); setError(null);
    try {
      await api.post(`/flito/impuestos/${imp.id}/${ruta}`, { motivo });
      setAccion('idle'); setMotivo(''); onTraspaso();
    }
    catch (e) { setError(errorMessage(e)); }
    finally { setEnviando(false); }
  };

  /**
   * Factura de venta: viene de FLIT y la sirve la API. Integración FLIT (Fase 8).
   *
   * Antes se abría con `window.open(URL.createObjectURL(blob))`. Una URL `blob:` no lleva nombre,
   * así que el navegador guardaba el archivo con un identificador interno y SIN extensión: no abría
   * con doble clic y había que renombrarlo a mano. Ahora se muestra en el visor, que descarga con
   * un nombre de verdad y en `.pdf`.
   */
  // El nombre lo pone el SERVIDOR desde la HU #11910 (AC5): `PLACA-ORGANISMO.<ext>`, el mismo con el
  // que sale dentro del ZIP, para que las dos descargas se puedan emparejar en la misma carpeta. El
  // cliente valida la forma y cae al respaldo si no encaja.
  const verFactura = async () => {
    setError(null);
    try {
      const { blob, nombre } = await api.getBlobNamed(
        `/flito/impuestos/${imp.id}/factura-venta`,
        nombreFacturaVenta(imp.idFlit),
        esNombrePlacaOrganismo,
      );
      setFactura({ url: URL.createObjectURL(blob), nombre });
    } catch (e) { setError(errorMessage(e)); }
  };
  const cerrarFactura = () => { if (factura) URL.revokeObjectURL(factura.url); setFactura(null); };

  /**
   * Los dos desenlaces refrescan la cola SIN cerrar el detalle (`onTraspaso`), que se pinta desde
   * la fila nueva: con `pagado` pasa a Pagado y el botón desaparece; con `en_revision` el impuesto
   * sigue Solicitado y el chip de documentos pasa a «Ambos». El foco vuelve al botón que abrió el
   * modal o, cuando ese botón ya no existe, a «Ver soporte» (respaldo del focus trap).
   */
  const listoReciboCaja = (resultado: 'pagado' | 'en_revision') => {
    if (resultado === 'pagado') setPagadoDesdeCaja(true);
    setReciboCaja(false);
    onTraspaso();
  };

  return (
    <FlitModal title={`Impuesto · ${imp.placa ?? imp.vin}`} onClose={onClose} wide>
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone={TONO_IMPUESTO[imp.estado]}>{ESTADO_IMPUESTO_LABEL[imp.estado]}</StatusChip>
          {imp.estancado && <ChipSinGestion desde={imp.enviadoEn} />}
          {imp.marcadoPorDiferencia && <StatusChip tone="warning">Diferencia de valor</StatusChip>}
          <ChipDocumentos imp={imp} />
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
          <Dato k="VIN" v={imp.vin} /><Dato k="Trámite FLIT" v={imp.idFlit} />
          <Dato k="Compañía" v={imp.companiaNombre} /><Dato k="Organismo" v={imp.organismoNombre ?? imp.organismoCodigo} />
          <Dato k="Gestiona" v={imp.gestionOperaciones ? 'Operaciones (contingencia)' : 'Gestor del organismo'} />
          <Dato k="Comprador" v={imp.compradorNombre ?? '—'} /><Dato k="Documento" v={documentoConTipo(imp.compradorTipoDocumento, imp.compradorDocumento)} />
          <Dato k="Valor liquidado" v={pesos(imp.valorLiquidado)} /><Dato k="Liquidado el" v={fecha(imp.liquidadoEn)} />
          <Dato k="Valor pagado" v={pesos(imp.valorPagado)} />
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Factura de venta</dt>
            <dd className="text-sm">
              {imp.tieneFacturaVenta
                ? <button className="font-semibold underline" style={{ color: 'var(--flit-blue-text)' }} onClick={verFactura}>En FLIT · Ver / descargar</button>
                : <span style={{ color: 'var(--flit-warning)' }}>Sin factura en FLIT</span>}
            </dd>
          </div>
          {/* El recibo del organismo se carga desde esta pantalla, pero para verlo había que irse
              al reporte de costos, en el que el gestor del organismo no entra. Es la evidencia del
              pago: se mira desde donde se gestiona. El recibo de caja va al lado de la evidencia,
              no en la fila de acciones de gestión (Rechazar/Asumir/Reversar): es otra visita. */}
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Soporte</dt>
            <dd className="text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <button ref={verSoporteRef} type="button" className="font-semibold underline" style={{ color: 'var(--flit-blue-text)' }}
                  onClick={() => setVerSoportes(true)}>Ver soporte</button>
                {ofreceCaja && (
                  <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                    aria-disabled={sinLiquidacion || undefined}
                    aria-describedby={sinLiquidacion ? 'recibo-caja-motivo' : undefined}
                    onClick={() => { if (!sinLiquidacion) setReciboCaja(true); }}>
                    Cargar recibo de caja
                  </button>
                )}
              </div>
              {ofreceCaja && sinLiquidacion && (
                <p id="recibo-caja-motivo" className="mt-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
                  Este impuesto no tiene liquidación cargada; el recibo de caja se carga sobre una liquidación
                </p>
              )}
            </dd>
          </div>
          <Dato k="Enviado por" v={imp.enviadoPorNombre ?? '—'} /><Dato k="Enviado" v={fecha(imp.enviadoEn)} />
        </dl>

        {/* HU #12831 (AC2): entre el <dl> y el historial. «Reintentar validación» llega con la #12832. */}
        <SeccionValidacion imp={imp} />

        {verSoportes && (
          <VisorSoportes ruta={`/flito/impuestos/${imp.id}/soportes`} titulo={`Impuesto ${imp.placa ?? imp.vin}`}
            vacio="Este impuesto no tiene ningún recibo cargado todavía."
            onClose={() => setVerSoportes(false)} />
        )}

        {factura && <ModalFacturaVenta url={factura.url} nombre={factura.nombre} onCerrar={cerrarFactura} />}

        {reciboCaja && (
          <ModalReciboCaja imp={imp} restoreFocusRef={verSoporteRef}
            onClose={() => setReciboCaja(false)} onListo={listoReciboCaja} onRefrescar={onTraspaso} />
        )}

        <HistorialEstados concepto="impuesto" registroId={imp.id} />

        {imp.motivoRechazo && <p className="rounded-md bg-red-50 p-2 text-red-700">Motivo de rechazo: {imp.motivoRechazo}</p>}
        {soloLectura && <div className="rounded-md bg-blue-50 p-2 text-blue-800">Solo lectura · Auditoría observa, no ejecuta acciones.</div>}
        {error && <p className="text-sm text-red-600">{error}</p>}

        {!soloLectura && accion === 'idle' && (
          <div className="flex flex-wrap gap-2 pt-1">
            {enGestion && (esOperaciones || esGestor) && (
              <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('rechazar')}>Rechazar</button>
            )}
            {rechazado && esOperaciones && (
              <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('reactivar')}>Reactivar</button>
            )}
            {esOperaciones && traspasable && !imp.gestionOperaciones && (
              <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('asumir')}>Asumir en Operaciones</button>
            )}
            {esOperaciones && traspasable && imp.gestionOperaciones && (
              <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('devolver')}>Devolver al gestor</button>
            )}
            {esOperaciones && (
              <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setAccion('reversar')}>Reversar</button>
            )}
          </div>
        )}

        {/* Devolver no pide destinatario: el gestor sale del organismo del trámite, que no cambia. */}
        {(accion === 'asumir' || accion === 'devolver') && (
          <FormMotivo etiqueta={accion === 'asumir'
            ? 'Motivo para asumirlo en Operaciones (mín. 5 caracteres)'
            : 'Motivo de la devolución al gestor (mín. 5 caracteres)'}
            motivo={motivo} setMotivo={setMotivo} enviando={enviando} minLen={5}
            onCancelar={() => { setAccion('idle'); setMotivo(''); }}
            onConfirmar={() => traspasar(accion === 'asumir' ? 'asumir-operaciones' : 'devolver-gestor')} />
        )}

        {(accion === 'rechazar' || accion === 'reactivar') && (
          <FormMotivo etiqueta={accion === 'rechazar' ? 'Motivo del rechazo' : 'Motivo de la corrección'}
            motivo={motivo} setMotivo={setMotivo} enviando={enviando} onCancelar={() => { setAccion('idle'); setMotivo(''); }}
            onConfirmar={() => ejecutar(() => api.post(`/flito/impuestos/${imp.id}/${accion}`, { motivo }))} />
        )}

        {accion === 'reversar' && (
          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
            <FlitField label="Estado destino">
              <select className={flitInp} value={estadoDestino} onChange={(e) => setEstadoDestino(e.target.value as EstadoImpuesto)}>
                {ESTADOS_OPERACIONES.map((e) => <option key={e} value={e}>{ESTADO_IMPUESTO_LABEL[e]}</option>)}
              </select>
            </FlitField>
            <FormMotivo etiqueta="Motivo de la reversa (mín. 5 caracteres)" motivo={motivo} setMotivo={setMotivo}
              enviando={enviando} minLen={5} onCancelar={() => { setAccion('idle'); setMotivo(''); }}
              onConfirmar={() => ejecutar(() => api.post(`/flito/impuestos/${imp.id}/reversar`, { estadoDestino, motivo }))} />
          </div>
        )}
      </div>
    </FlitModal>
  );
}

function Dato({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[11px] uppercase" style={{ color: 'var(--flit-text-muted)' }}>{k}</dt>
      <dd className="font-medium">{v}</dd>
    </div>
  );
}

function FormMotivo({ etiqueta, motivo, setMotivo, enviando, minLen = 1, onConfirmar, onCancelar }: {
  etiqueta: string; motivo: string; setMotivo: (v: string) => void; enviando: boolean; minLen?: number;
  onConfirmar: () => void; onCancelar: () => void;
}) {
  return (
    <div className="mt-2 space-y-2">
      <FlitField label={etiqueta}>
        <textarea className={`${flitInp} min-h-[64px]`} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
      </FlitField>
      <div className="flex gap-2">
        <button className={flitBtnPrimary} style={flitBtnPrimaryStyle}
          disabled={enviando || motivo.trim().length < minLen} onClick={onConfirmar}>
          {enviando ? 'Enviando…' : 'Confirmar'}
        </button>
        <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onCancelar}>Cancelar</button>
      </div>
    </div>
  );
}
