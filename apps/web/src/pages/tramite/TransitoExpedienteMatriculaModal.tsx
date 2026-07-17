// Modal de revisión de expediente de MATRÍCULA INICIAL para Tránsito.
// Reúsa ExpedienteVisor (vehículo, comprador, documentos, identidad, FUR, cert)
// y agrega "Descargar expediente PDF". Carga el trámite completo + documentos.

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import FlitModal from '../../components/flit/FlitModal';
import ExpedienteVisor from '../../components/ExpedienteVisor';
import type { ArchivoData } from './wizard/types';

interface FullTramite {
  vin?: string | null;
  // Tipos sueltos: ExpedienteVisor define sus propias interfaces (no exportadas);
  // sus props son estructuralmente compatibles con el JSON del trámite.
  vehiculo?: Record<string, any> | null;
  comprador?: Record<string, any> | null;
}

export default function TransitoExpedienteMatriculaModal({ tramiteId, onClose }: { tramiteId: number; onClose: () => void }) {
  const [data, setData] = useState<FullTramite | null>(null);
  const [archivos, setArchivos] = useState<ArchivoData[]>([]);
  const [loading, setLoading] = useState(true);
  const [descargando, setDescargando] = useState(false);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const [full, docs] = await Promise.all([
          api.get<FullTramite>(`/tramites/${tramiteId}`),
          api.get<ArchivoData[]>(`/tramites/${tramiteId}/documentos`).catch(() => [] as ArchivoData[]),
        ]);
        if (cancel) return;
        setData(full);
        setArchivos(Array.isArray(docs) ? docs : []);
      } catch (e) { if (!cancel) toast.error(errorMessage(e)); }
      finally { if (!cancel) setLoading(false); }
    })();
    return () => { cancel = true; };
  }, [tramiteId]);

  const descargarExpediente = async () => {
    setDescargando(true);
    try {
      await api.download(`/tramites/${tramiteId}/expediente.pdf`, `expediente-MI-${String(tramiteId).padStart(4, '0')}.pdf`);
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setDescargando(false); }
  };

  const veh = (data?.vehiculo || {}) as Record<string, any>;
  const orgT = (veh._orgTransito as { nombre: string; ciudad: string; codigo: string } | undefined)
    || { nombre: '', ciudad: '', codigo: '' };

  return (
    <FlitModal title={`Expediente MI-${String(tramiteId).padStart(4, '0')}`} onClose={onClose}>
      {loading || !data ? (
        <div className="py-8 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando expediente…</div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex justify-end">
            <button
              type="button"
              onClick={descargarExpediente}
              disabled={descargando}
              className="flit-focus inline-flex h-10 items-center rounded-[999px] border bg-white px-4 text-sm font-medium disabled:opacity-50"
              style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}
            >
              {descargando ? 'Descargando…' : 'Descargar expediente PDF'}
            </button>
          </div>
          <ExpedienteVisor
            tramiteId={tramiteId}
            vehiculo={veh}
            comprador={data.comprador || {}}
            vin={data.vin || ''}
            archivos={archivos}
            validationStatus={null}
            emailSent={false}
            orgTransito={orgT}
            variant="matricula"
          />
        </div>
      )}
    </FlitModal>
  );
}
