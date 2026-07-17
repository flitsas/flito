// EPIC TRAM-INNOV · B1 — Pasaporte vehicular (historial encadenado por VIN).
//
// Timeline de eventos del VIN + verificación de integridad de la cadena de hashes
// + descarga del Certificado FLIT (PDF). Reusa el patrón visual de
// ExpedienteTimeline (A2). Estilos: solo tokens/clases FLIT.

import { useEffect, useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import toast from 'react-hot-toast';

interface Evento { id: number; eventoTipo: string; payload: unknown; hashSelf: string; createdAt: string }
interface Historial {
  vin: string;
  eventos: Evento[];
  integridad: { valido: boolean; rotoEnId: number | null };
  ultimoHash: string | null;
  desde: string | null;
  hasta: string | null;
}

const TIPO_LABEL: Record<string, string> = {
  tramite_creado: 'Trámite iniciado',
  tramite_enviado_transito: 'Enviado a tránsito',
  tramite_placa_asignada: 'Placa asignada',
  documento_registrado: 'Documento registrado',
  soat_vigente: 'SOAT vigente',
  pesv_incidente: 'Incidente PESV',
  transferencia_registrada: 'Transferencia registrada',
  vehiculo_registrado: 'Vehículo registrado en FLIT',
};
const TIPO_COLOR: Record<string, string> = {
  tramite_creado: 'var(--flit-blue)',
  tramite_enviado_transito: 'var(--flit-cyan)',
  tramite_placa_asignada: 'var(--flit-success)',
  soat_vigente: 'var(--flit-success)',
  pesv_incidente: 'var(--flit-danger)',
};

function fmt(iso: string): string {
  try { return new Date(iso).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return iso; }
}

export default function PasaporteVehiculo({ vin }: { vin: string }) {
  const [data, setData] = useState<Historial | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.get<Historial>(`/vehicles/${encodeURIComponent(vin)}/historial`)
      .then((d) => { if (alive) setData(d); })
      .catch(() => { if (alive) setData(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [vin]);

  const descargarCertificado = async () => {
    try { await api.download(`/vehicles/${encodeURIComponent(vin)}/certificado`, `pasaporte_${vin}.pdf`); }
    catch (err) { toast.error(errorMessage(err)); }
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>Pasaporte del vehículo</h4>
          <p className="font-mono text-xs" style={{ color: 'var(--flit-text-muted)' }}>{vin}</p>
        </div>
        <div className="flex items-center gap-2">
          {data && data.eventos.length > 0 && (
            <span className="rounded-full px-3 py-1 text-xs font-bold" style={data.integridad.valido ? { background: 'rgba(112,207,58,0.15)', color: 'var(--flit-success)' } : { background: 'rgba(228,61,48,0.15)', color: 'var(--flit-danger)' }}>
              {data.integridad.valido ? 'Cadena íntegra' : 'Cadena alterada'}
            </span>
          )}
          {data && data.eventos.length > 0 && (
            <button type="button" onClick={descargarCertificado}
              className="flit-focus rounded-[999px] border px-3.5 py-1.5 text-xs font-semibold" style={{ borderColor: 'var(--flit-blue)', color: 'var(--flit-blue)' }}>
              Certificado FLIT
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Cargando pasaporte…</p>
      ) : !data || data.eventos.length === 0 ? (
        <div className="space-y-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          <p>Sin eventos en el pasaporte todavía.</p>
          <p>Se registran al crear trámites, asignar placa, verificar SOAT o al importar datos ya existentes en el sistema.</p>
          <button
            type="button"
            className="flit-focus rounded-[999px] border px-3 py-1.5 font-semibold"
            style={{ borderColor: 'var(--flit-blue)', color: 'var(--flit-blue)' }}
            onClick={() => {
              setLoading(true);
              api.post<Historial>(`/vehicles/${encodeURIComponent(vin)}/historial/sync`, {})
                .then((d) => { setData(d); toast.success('Historial actualizado'); })
                .catch((err) => toast.error(errorMessage(err)))
                .finally(() => setLoading(false));
            }}
          >
            Importar desde trámites y SOAT
          </button>
        </div>
      ) : (
        <ol className="relative space-y-3 border-l pl-4" style={{ borderColor: 'var(--flit-border-soft)' }}>
          {data.eventos.map((e) => (
            <li key={e.id} className="relative">
              <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full" style={{ background: TIPO_COLOR[e.eventoTipo] || 'var(--flit-text-muted)' }} aria-hidden />
              <p className="text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{TIPO_LABEL[e.eventoTipo] || e.eventoTipo}</p>
              <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{fmt(e.createdAt)}</p>
              <p className="mt-0.5 break-all font-mono text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>sha256: {e.hashSelf.slice(0, 24)}…</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
