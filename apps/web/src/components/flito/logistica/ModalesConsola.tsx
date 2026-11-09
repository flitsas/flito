// FLITO Logística — modales de la consola: detalle del trámite, detalle del acta y motivo de novedad o devolución.
// Salieron de `FlitoLogistica.tsx` (HU #14353). Al proveedor: nombre del propietario solo en el Detalle (H2), sin su
// documento, sin Viajes adicionales, sin Propietario en la tabla del acta, y «—» por actor en la bitácora (ADR §7.2).
import { useState } from 'react';
import { ESTADO_LOGISTICA_SIMPLE_LABEL, simplificarEstadoLogistica } from '@operaciones/shared-types';
import { useAuth } from '../../../lib/auth';
import FlitModal from '../../flit/FlitModal';
import StatusChip from '../../flit/StatusChip';
import { FlitField, FlitTable, FlitTh, FlitTr, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle, flitInp } from '../../flit/flitPageKit';
import LineaTiempoDetalle from './LineaTiempoDetalle';
import ViajesLogistica from './ViajesLogistica';
import { TONO_ACTA, TONO_SIMPLE, fecha, type ActaDetalle, type TramiteDetalle } from './consolaLogistica';
import { rotuloEvento } from './rotuloEvento';

const MUTED = { color: 'var(--flit-text-muted)' } as const;

export function DetalleModal({ doc, onClose }: { doc: TramiteDetalle; onClose: () => void }) {
  const { hasFuncion, tipoEnlace } = useAuth();
  const esProveedor = tipoEnlace === 'proveedor';
  return (
    <FlitModal title={`Licencia · ${doc.placa ?? doc.vin ?? ''}`} onClose={onClose} wide>
      <div className="mb-4 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <div><span className="text-xs" style={MUTED}>Trámite FLIT</span><div>{doc.idFlit}</div></div>
        <div><span className="text-xs" style={MUTED}>Empresa</span><div>{doc.companiaNombre ?? doc.companiaNit ?? '—'}</div></div>
        <div><span className="text-xs" style={MUTED}>Secretaría</span><div>{doc.organismoNombre ?? doc.organismoCodigo ?? '—'}</div></div>
        <div><span className="text-xs" style={MUTED}>Estado</span><div><StatusChip tone={TONO_SIMPLE[doc.estadoSimple]}>{doc.estadoSimpleLabel}</StatusChip></div></div>
        <div><span className="text-xs" style={MUTED}>Propietario</span><div>{doc.propietario ?? '—'}{!esProveedor && doc.propietarioDocumento ? ` · ${doc.propietarioDocumento}` : ''}</div></div>
        <div><span className="text-xs" style={MUTED}>N.º licencia / N.º LT</span><div className="tabular-nums">{doc.numeroLicencia ?? '—'} / {doc.numeroLt ?? '—'}</div></div>
      </div>
      {/* HU #12620: sin `logistica.viajes.ver` la sección no existe ni pide nada al API. Doble cerradura AC4 de HU #14353. */}
      {hasFuncion('logistica.viajes.ver') && !esProveedor && (
        <ViajesLogistica tramiteId={doc.tramiteId} idFlit={doc.idFlit} fecha={fecha}
          puedeRegistrar={hasFuncion('logistica.viajes.registrar')} puedeQuitar={hasFuncion('logistica.viajes.quitar')} />
      )}
      {/* HU #14126: sin `logistica.documento.ver` la sección no existe ni pide nada al API. */}
      {hasFuncion('logistica.documento.ver') && <LineaTiempoDetalle tramiteId={doc.tramiteId} fecha={fecha} />}
    </FlitModal>
  );
}

const PILL_OK = { background: 'rgba(112,207,58,0.14)', color: 'var(--flit-success-text)' } as const;
const PILL_NO = { background: 'rgba(89,103,125,0.14)', color: 'var(--flit-text-secondary)' } as const;

export function ActaDetalleModal({ detalle, onClose, onPdf }: { detalle: ActaDetalle; onClose: () => void; onPdf?: () => void }) {
  const { tipoEnlace } = useAuth();
  const esProveedor = tipoEnlace === 'proveedor';
  const { acta, documentos, bitacora, firmaEntrega, firmaRecibe, entregaNombre } = detalle;
  return (
    <FlitModal title={`Acta · ${acta.companiaNombre ?? ''}`} onClose={onClose} wide>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          <StatusChip tone={TONO_ACTA[acta.estado] ?? 'neutral'}>{acta.estadoLabel}</StatusChip>
          <span className="ml-2" style={MUTED}>
            {acta.documentos} licencia(s) · {acta.mensajeroNombre ? `Mensajero: ${acta.mensajeroNombre}` : acta.estado === 'generada' ? 'Sin despachar' : 'Mensajero: —'}
          </span>
        </div>
        {onPdf && <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onPdf}>Descargar PDF</button>}
      </div>

      <div className="mb-4 flex flex-wrap gap-2 text-xs">
        <span className="rounded-full px-2 py-1" style={firmaEntrega ? PILL_OK : PILL_NO}>
          {firmaEntrega ? `✓ Entrega${entregaNombre ? ` · ${entregaNombre}` : ''}` : 'Entrega sin firmar'}
        </span>
        <span className="rounded-full px-2 py-1" style={firmaRecibe ? PILL_OK : PILL_NO}>
          {firmaRecibe ? `✓ Recibe${acta.receptorNombre ? ` · ${acta.receptorNombre}` : ''}` : 'Recibe sin firmar'}
        </span>
      </div>

      <h3 className="mb-2 text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>Licencias</h3>
      <div className="mb-4">
        <FlitTable label="Licencias del acta">
          <thead>
            <FlitTr><FlitTh>Placa</FlitTh><FlitTh>Secretaría</FlitTh>{!esProveedor && <FlitTh>Propietario</FlitTh>}<FlitTh>N.º licencia</FlitTh><FlitTh>N.º LT</FlitTh><FlitTh>Estado</FlitTh></FlitTr>
          </thead>
          <tbody>
            {documentos.map((d) => {
              const simple = simplificarEstadoLogistica(d.estado);
              return (
                <FlitTr key={d.id}>
                  <td className="px-4 py-2 text-sm tabular-nums">{d.placa ?? '—'}</td>
                  <td className="px-4 py-2 text-sm">{d.secretaria ?? '—'}</td>
                  {!esProveedor && <td className="px-4 py-2 text-sm">{d.propietario ?? '—'}</td>}
                  <td className="px-4 py-2 text-sm tabular-nums">{d.numeroLicencia ?? '—'}</td>
                  <td className="px-4 py-2 text-sm tabular-nums">{d.numeroLt ?? '—'}</td>
                  <td className="px-4 py-2"><StatusChip tone={TONO_SIMPLE[simple]}>{ESTADO_LOGISTICA_SIMPLE_LABEL[simple]}</StatusChip></td>
                </FlitTr>
              );
            })}
          </tbody>
        </FlitTable>
      </div>

      <h3 className="mb-2 text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>Bitácora del despacho</h3>
      <ol className="space-y-2">
        {bitacora.map((e) => (
          <li key={e.id} className="text-sm">
            <span className="tabular-nums">{e.placa ?? '—'}</span>
            <span className="ml-1 font-medium">{rotuloEvento(e)}</span>
            <span style={MUTED}> · {fecha(e.creadoEn)} · {e.actorNombre ?? (!esProveedor && e.origen === 'api' ? 'sistema' : '—')}</span>
            {e.motivo && <div className="text-xs" style={{ color: 'var(--flit-danger-text)' }}>{e.motivo}</div>}
          </li>
        ))}
      </ol>
    </FlitModal>
  );
}

export function MotivoModal({ tipo, busy, error, onClose, onConfirmar }: { tipo: 'novedad' | 'devolucion'; busy: boolean; error: string | null; onClose: () => void; onConfirmar: (motivo: string) => void }) {
  const [motivo, setMotivo] = useState('');
  const titulo = tipo === 'novedad' ? 'Reportar novedad' : 'Registrar devolución';
  return (
    <FlitModal title={titulo} onClose={onClose}>
      <FlitField label="Motivo (obligatorio)">
        <textarea className={flitInp} rows={3} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder={tipo === 'novedad' ? 'Dañada o inconsistente…' : 'Receptor ausente o rechazó…'} />
      </FlitField>
      {error && <p role="alert" className="mt-3 text-sm" style={{ color: 'var(--flit-danger-text)' }}>{error}</p>}
      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" className={`${flitBtnSecondary} w-full justify-center sm:w-auto`} style={flitBtnSecondaryStyle} onClick={onClose}>Cancelar</button>
        <button type="button" className={`${flitBtnPrimary} w-full justify-center sm:w-auto`} style={flitBtnPrimaryStyle} disabled={busy || !motivo.trim()} onClick={() => onConfirmar(motivo.trim())}>Confirmar</button>
      </div>
    </FlitModal>
  );
}
