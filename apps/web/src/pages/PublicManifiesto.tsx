import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

interface PublicData {
  valido: boolean;
  numero?: string;
  consecutivoRndc?: string | null;
  estado?: string;
  fechaExpedicion?: string;
  placa?: string | null;
  origen?: string | null;
  destino?: string | null;
  razonSocialEmpresa?: string;
}

export default function PublicManifiesto() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<PublicData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) { setError('Token inválido'); setLoading(false); return; }
    fetch(`/api/rndc/public/manifiestos/qr/${encodeURIComponent(token)}`)
      .then(async (r) => {
        if (r.status === 404) { setData({ valido: false }); return; }
        if (!r.ok) throw new Error('No disponible');
        const json = await r.json();
        setData(json);
      })
      .catch(() => setError('No se pudo verificar'))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[color:var(--flit-bg-app)] text-[color:var(--flit-text-primary)] flex items-center justify-center">
        <div className="text-[color:var(--flit-text-muted)]">Verificando...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[color:var(--flit-bg-app)] text-[color:var(--flit-text-primary)] py-10 px-4">
      <div className="max-w-xl mx-auto bg-white rounded-2xl shadow-[0_8px_24px_rgba(22,39,68,0.08)] border border-[color:var(--flit-border-input)] overflow-hidden">
        <div className="bg-[color:var(--flit-blue-dark)] px-6 py-5">
          <div className="text-[10px] uppercase tracking-[0.4em] text-[color:var(--flit-text-muted)] font-semibold">Verificación pública</div>
          <div className="text-lg font-semibold mt-2 text-white">Manifiesto electrónico de carga</div>
          <div className="text-xs text-[color:var(--flit-text-muted)] mt-1">FLIT SAS — Sistema de Operaciones</div>
        </div>

        <div className="p-6">
          {error && <div className="text-[color:var(--flit-danger)] text-sm">{error}</div>}

          {!error && data && !data.valido && (
            <div className="flex items-center gap-3 p-4 rounded-xl bg-[rgba(228,61,48,0.12)] border border-[rgba(228,61,48,0.30)]">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="text-[color:var(--flit-danger)]">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
              <div>
                <div className="font-semibold text-[color:var(--flit-danger)]">Manifiesto no válido</div>
                <div className="text-xs text-[color:var(--flit-text-secondary)]">El documento no existe, fue anulado o ha sido eliminado.</div>
              </div>
            </div>
          )}

          {!error && data && data.valido && (
            <>
              <div className="flex items-center gap-3 p-4 rounded-xl bg-[rgba(112,207,58,0.12)] border border-[rgba(112,207,58,0.30)] mb-5">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="text-[color:var(--flit-success)]">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <div>
                  <div className="font-semibold text-[color:var(--flit-success)]">Manifiesto vigente</div>
                  <div className="text-xs text-[color:var(--flit-text-secondary)]">Estado: {data.estado}</div>
                </div>
              </div>

              <dl className="space-y-3 text-sm">
                <Row label="Número interno" value={data.numero ?? '—'} />
                <Row label="Consecutivo RNDC" value={data.consecutivoRndc ?? 'En proceso de radicación'} />
                {data.razonSocialEmpresa && <Row label="Empresa transportadora" value={data.razonSocialEmpresa} />}
                <Row label="Fecha expedición" value={data.fechaExpedicion ?? '—'} />
                <Row label="Placa cabezote" value={data.placa ?? '—'} mono />
                <Row label="Origen" value={data.origen ?? '—'} />
                <Row label="Destino" value={data.destino ?? '—'} />
              </dl>
            </>
          )}
        </div>

        <div className="px-6 py-3 bg-[color:var(--flit-bg-app)] border-t border-[color:var(--flit-border-soft)] text-[11px] text-[color:var(--flit-text-muted)] flex justify-between">
          <span>Verificación pública · sin datos personales</span>
          <span>operaciones.flitsas.com</span>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between border-b border-[color:var(--flit-border-soft)] pb-2">
      <dt className="text-[color:var(--flit-text-muted)]">{label}</dt>
      <dd className={`text-[color:var(--flit-text-primary)] font-medium ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}
