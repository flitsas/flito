// TRAM-TRASPASO-F4 — vista expediente post-radicado (regenerar docs, validaciones, visor).

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import ExpedienteVisor from '../../components/ExpedienteVisor';
import StatusChip from '../../components/flit/StatusChip';
import type { ArchivoData, CompradorData, OrgTransito, ValidationStatus, VehiculoData } from './wizard/types';
import { extractPartesTraspasoFromTramite, resolverValidacionTraspasoParte } from '@operaciones/shared-types';

interface Props {
  tramiteId: number;
  radicado: string | null;
  estado: string;
  vehiculo: VehiculoData;
  comprador: CompradorData;
  orgTransito: OrgTransito;
  tipologiaCodigo: string | null;
  checklistEstado: Record<string, boolean>;
}

export default function TraspasoExpedientePanel({
  tramiteId, radicado, estado, vehiculo, comprador, orgTransito, tipologiaCodigo, checklistEstado,
}: Props) {
  const [open, setOpen] = useState(false);
  const [archivos, setArchivos] = useState<ArchivoData[]>([]);
  const [validationStatus, setValidationStatus] = useState<ValidationStatus | null>(null);
  const [checklistPct, setChecklistPct] = useState<number | null>(null);

  const cargar = useCallback(async () => {
    try {
      const [docs, val, chk] = await Promise.all([
        api.get<ArchivoData[]>(`/tramites/${tramiteId}/documentos`),
        api.get<{ validaciones?: { id: number; estado: string; documento?: string | null; parte?: string | null; score?: number | null }[] }>(`/validacion-identidad/estado/${tramiteId}`).catch(() => null),
        tipologiaCodigo
          ? api.get<{ checklist: { satisfechos: number; total: number } | null }>(`/tramites/${tramiteId}/checklist`)
          : Promise.resolve(null),
      ]);
      setArchivos(docs);
      // Resolver por documento+rol (no por recencia): vendedor y comprador vigentes.
      const vals = val?.validaciones ?? [];
      const partes = extractPartesTraspasoFromTramite({ vehiculo, comprador });
      const valV = resolverValidacionTraspasoParte(vals, { parte: 'vendedor', documento: partes.vendedor.documento });
      const valC = resolverValidacionTraspasoParte(vals, { parte: 'comprador', documento: partes.comprador.documento });
      const allApproved = valV?.estado === 'aprobado' && valC?.estado === 'aprobado';
      const vigente = valC ?? valV;
      setValidationStatus(allApproved ? { estado: 'aprobado' } : vigente ? { estado: vigente.estado } : null);
      const chkData = chk?.checklist;
      setChecklistPct(chkData && chkData.total > 0 ? Math.round((chkData.satisfechos / chkData.total) * 100) : null);
    } catch {
      setArchivos([]);
    }
  }, [tramiteId, tipologiaCodigo, vehiculo, comprador]);

  useEffect(() => { if (open) cargar(); }, [open, cargar]);

  const vin = (vehiculo.vin as string) || '';
  const docsCount = archivos.length;
  const checklistDone = Object.values(checklistEstado).filter(Boolean).length;
  const checklistTotal = Object.keys(checklistEstado).length;

  return (
    <section aria-label="Expediente del traspaso" className="rounded-[12px] border" style={{ borderColor: 'var(--flit-border-soft)' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flit-focus flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <div>
          <p className="text-xs font-bold" style={{ color: 'var(--flit-blue-text)' }}>Expediente del traspaso</p>
          <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
            {radicado ? `Radicado ${radicado}` : 'Sin radicado'} · {docsCount} documento(s)
            {checklistTotal > 0 ? ` · checklist ${checklistDone}/${checklistTotal}` : ''}
          </p>
        </div>
        <StatusChip tone={estado === 'rechazado' || estado === 'anulado' ? 'danger' : 'active'}>{estado.replace(/_/g, ' ')}</StatusChip>
      </button>

      {open && (
        <div className="border-t px-4 pb-4 pt-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <div className="mb-3 flex flex-wrap gap-2 text-[11px]" style={{ color: 'var(--flit-text-secondary)' }}>
            {checklistPct != null && <span>Checklist {checklistPct}%</span>}
            {validationStatus?.estado && <span>Identidad: {validationStatus.estado}</span>}
            {orgTransito.nombre && <span>Org: {orgTransito.ciudad}</span>}
          </div>
          <ExpedienteVisor
            tramiteId={tramiteId}
            vehiculo={vehiculo}
            comprador={comprador}
            vin={vin}
            archivos={archivos}
            validationStatus={validationStatus}
            emailSent={false}
            orgTransito={orgTransito.nombre ? orgTransito : undefined}
          />
          <button
            type="button"
            onClick={() => cargar()}
            className="flit-focus mt-3 rounded-[999px] px-3 py-1.5 text-[11px] font-semibold"
            style={{ color: 'var(--flit-blue)', background: 'rgba(79,116,201,0.12)' }}
          >
            Actualizar expediente
          </button>
        </div>
      )}
    </section>
  );
}
