// EPIC TRAM-INNOV · A2 — página pública de verificación del expediente (QR).
//
// Sin auth. Lee ?t=<token> y consulta GET /api/public/tramite-verificar.
// Muestra integridad (estado + últimos eventos con hash) SIN PII completa.

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

interface Evento { tipo: string; docHash: string | null; createdAt: string }
interface VerifyData {
  valido: boolean;
  estado?: string;
  placa?: string | null;
  vinMasked?: string | null;
  tipologia?: string | null;
  eventos?: Evento[];
}

const TIPO_LABEL: Record<string, string> = {
  creado: 'Trámite creado',
  documento_subido: 'Documento subido',
  mandato_subido: 'Mandato / poder subido',
  cambio_estado: 'Cambio de estado',
  enviado_transito: 'Enviado a tránsito',
  recibido_transito: 'Recibido por tránsito',
  placa_asignada: 'Placa asignada',
  rechazado_ot: 'Rechazado por el organismo',
  acceso_portal: 'Acceso al portal externo',
  verify_token_generado: 'QR de verificación generado',
};

function fmt(iso: string): string {
  try { return new Date(iso).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return iso; }
}

export default function PublicTramiteVerify() {
  const [params] = useSearchParams();
  const token = params.get('t') || '';
  const [data, setData] = useState<VerifyData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) { setData({ valido: false }); setLoading(false); return; }
    fetch(`/api/public/tramite-verificar?t=${encodeURIComponent(token)}`)
      .then(async (r) => {
        if (r.status === 404) { setData({ valido: false }); return; }
        if (!r.ok) throw new Error('No disponible');
        setData(await r.json());
      })
      .catch(() => setData({ valido: false }))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[color:var(--flit-bg-app)] flex items-center justify-center">
        <div className="text-[color:var(--flit-text-muted)]">Verificando…</div>
      </div>
    );
  }

  const ok = data?.valido;

  return (
    <div className="min-h-screen bg-[color:var(--flit-bg-app)] py-10 px-4">
      <div className="mx-auto max-w-xl overflow-hidden rounded-2xl border bg-white shadow-[0_8px_24px_rgba(22,39,68,0.08)]" style={{ borderColor: 'var(--flit-border-input)' }}>
        <div className="px-6 py-5" style={{ background: ok ? 'var(--flit-gradient-success)' : 'linear-gradient(90deg,#E43D30,#F05A35)' }}>
          <p className="text-xs font-semibold uppercase tracking-wide text-white/80">FLIT · Verificación de expediente</p>
          <h1 className="mt-1 text-lg font-bold text-white">{ok ? 'Expediente verificado' : 'Verificación no válida'}</h1>
        </div>

        {ok ? (
          <div className="px-6 py-5">
            <div className="grid grid-cols-2 gap-4">
              <div><p className="text-[10px] uppercase" style={{ color: 'var(--flit-text-muted)' }}>Estado</p><p className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{data?.estado}</p></div>
              <div><p className="text-[10px] uppercase" style={{ color: 'var(--flit-text-muted)' }}>Placa</p><p className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{data?.placa || '—'}</p></div>
              <div><p className="text-[10px] uppercase" style={{ color: 'var(--flit-text-muted)' }}>VIN</p><p className="font-mono text-sm" style={{ color: 'var(--flit-text-primary)' }}>{data?.vinMasked || '—'}</p></div>
              <div><p className="text-[10px] uppercase" style={{ color: 'var(--flit-text-muted)' }}>Tipología</p><p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>{data?.tipologia || '—'}</p></div>
            </div>

            <p className="mt-5 mb-2 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>Últimos eventos</p>
            <ol className="space-y-2">
              {(data?.eventos || []).map((e, i) => (
                <li key={i} className="rounded-[10px] border p-2.5" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <p className="text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{TIPO_LABEL[e.tipo] || e.tipo}</p>
                  <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{fmt(e.createdAt)}</p>
                  {e.docHash && <p className="mt-0.5 break-all font-mono text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>sha256: {e.docHash}</p>}
                </li>
              ))}
            </ol>
            <p className="mt-5 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
              FLIT es preparador y orquestador del trámite. La inscripción oficial se realiza ante el organismo de tránsito / RUNT.
            </p>
          </div>
        ) : (
          <div className="px-6 py-8 text-center">
            <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>El enlace de verificación no es válido o ha expirado.</p>
          </div>
        )}
      </div>
    </div>
  );
}
