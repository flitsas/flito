// TRAM-OPS-01/02 — tarjeta FLIT reutilizable en embudo y lista.

import StatusChip, { type ChipTone } from '../../components/flit/StatusChip';
import MotivoRechazoChip from './MotivoRechazoChip';
import { canRechazarOt } from './rechazoOt';
import { STEPS } from '../../constants/tramite';
import { ESTADO_STT_LABEL, type TramiteEstadoStt } from '@operaciones/shared-types';

const ESTADO_CHIP: Record<string, ChipTone> = {
  borrador: 'draft', en_validacion: 'active', aprobado: 'success', rechazado: 'danger',
  enviado_transito: 'active', recibido_transito: 'active', placa_preasignada: 'success',
  solicitud_soat: 'success', soat_comprado: 'success', soat_verificado: 'success', completado: 'success',
};

function estadoLabel(estado: string, modalidad?: string | null): string {
  if (modalidad === 'traspaso' && estado in ESTADO_STT_LABEL) {
    return ESTADO_STT_LABEL[estado as TramiteEstadoStt];
  }
  if (estado === 'enviado_transito') return 'Enviado a Tránsito';
  if (estado === 'en_validacion') return 'En Validación';
  return estado.charAt(0).toUpperCase() + estado.slice(1).replace(/_/g, ' ');
}

export interface TramiteEmbudoCardData {
  id: number;
  vin: string | null;
  placa?: string | null;
  estado: string;
  paso: number;
  tipologiaCodigo?: string | null;
  motivoRechazoCodigo?: string | null;
  vehiculo?: { marca?: string; linea?: string } | null;
  comprador?: { nombre?: string; documento?: string } | null;
  // TRAM-TRASPASO-F1.5: para enrutar al wizard correcto al abrir desde lista/embudo.
  modalidadEntrada?: string | null;
  numeroRadicado?: string | null;
}

interface Props {
  tramite: TramiteEmbudoCardData;
  onOpen: () => void;
  onRechazar?: () => void;
  compact?: boolean;
}

export default function TramiteEmbudoCard({ tramite: t, onOpen, onRechazar, compact }: Props) {
  const v = t.vehiculo || {};
  const showRechazo = onRechazar && canRechazarOt(t.estado);

  return (
    <div
      className="bg-white p-4 transition-shadow hover:shadow-[0_12px_30px_rgba(22,39,68,0.12)]"
      style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}
    >
      <button type="button" onClick={onOpen} className="flit-focus w-full text-left">
        <div className="flex flex-wrap items-start gap-2">
          <p className="font-mono text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            {t.modalidadEntrada === 'traspaso' ? (t.numeroRadicado || t.placa || '—') : (t.vin || '—')}
          </p>
          {t.modalidadEntrada === 'traspaso' ? (
            t.placa && <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>{t.placa}</span>
          ) : t.placa ? (
            <span className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>{t.placa}</span>
          ) : null}
          {t.modalidadEntrada === 'traspaso' && (
            <StatusChip tone="active">Traspaso</StatusChip>
          )}
        </div>
        {!compact && (
          <p className="mt-1 truncate text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            {[v.marca, v.linea].filter(Boolean).join(' ') || '—'}
          </p>
        )}
        {t.comprador?.nombre && (
          <p className="mt-1 truncate text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
            {t.comprador.nombre}
            {t.comprador.documento && (
              <span className="ml-1 font-mono text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>· {t.comprador.documento}</span>
            )}
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <StatusChip tone={ESTADO_CHIP[t.estado] ?? 'neutral'}>{estadoLabel(t.estado, t.modalidadEntrada)}</StatusChip>
          {t.tipologiaCodigo && (
            <StatusChip tone="neutral">{t.tipologiaCodigo.replace(/_/g, ' ')}</StatusChip>
          )}
          <MotivoRechazoChip codigo={t.motivoRechazoCodigo} />
        </div>
        <p className="mt-2 text-[10px] uppercase" style={{ color: 'var(--flit-text-muted)' }}>
          Paso {t.paso}/{t.modalidadEntrada === 'traspaso' ? 6 : 5} — {t.modalidadEntrada === 'traspaso' ? 'Traspaso' : (STEPS[t.paso - 1] ?? '—')}
        </p>
      </button>
      {showRechazo && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRechazar(); }}
          className="flit-focus mt-3 w-full rounded-[999px] border px-3 py-2 text-xs font-medium"
          style={{ borderColor: 'var(--flit-danger)', color: 'var(--flit-danger)' }}
        >
          Registrar rechazo OT
        </button>
      )}
    </div>
  );
}
