// EPIC TRAM-INNOV · A2 — página pública de verificación del expediente (QR).
//
// Sin auth. Lee ?t=<token> y consulta GET /api/public/tramite-verificar.
// Muestra integridad (estado + últimos eventos con hash) SIN PII completa.

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import LayoutPublico from '../components/flit/LayoutPublico';
import { Cargador } from '../components/flit/Cargador';
import { ActividadLinea, Fichas } from '../components/flit/Bloques';

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
      <LayoutPublico ancho={640}>
        <Cargador texto="Verificando…" className="mx-auto my-12" />
      </LayoutPublico>
    );
  }

  const ok = data?.valido;

  return (
    <LayoutPublico ancho={640}>
      <section className="card seg">
        <div className="seg__cab">
          <img src={ok ? '/kit/aviso-ok.svg' : '/kit/aviso-error.svg'} alt="" aria-hidden="true" className="h-12 w-12 shrink-0" />
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-tertiary)]">FLIT · Verificación de expediente</p>
            <h1 className={`mt-1 text-xl font-bold ${ok ? 'text-[var(--kit-verde-texto)]' : 'text-[var(--kit-rojo-texto)]'}`}>{ok ? 'Expediente verificado' : 'Verificación no válida'}</h1>
          </div>
        </div>

        {ok ? (
          <div>
            <Fichas items={[
              { etiqueta: 'Estado', valor: <span className="font-semibold">{data?.estado}</span> },
              { etiqueta: 'Placa', valor: <span className="font-semibold">{data?.placa || '—'}</span> },
              { etiqueta: 'VIN', valor: <span className="mono">{data?.vinMasked || '—'}</span> },
              { etiqueta: 'Tipología', valor: data?.tipologia || '—' },
            ]} />

            <h2 className="mb-2 mt-5 text-sm font-semibold text-[var(--color-text-secondary)]">Últimos eventos</h2>
            <ActividadLinea eventos={(data?.eventos || []).map((e, i) => ({
              id: String(i),
              cuando: fmt(e.createdAt),
              fechaIso: e.createdAt,
              texto: (
                <>
                  <strong className="block text-[var(--color-text-primary)]">{TIPO_LABEL[e.tipo] || e.tipo}</strong>
                  {e.docHash && <span className="mono mt-0.5 block break-all text-xs text-[var(--color-text-tertiary)]">sha256: {e.docHash}</span>}
                </>
              ),
            }))} />
            <p className="nota mt-5 text-[var(--color-text-tertiary)]">
              FLIT es preparador y orquestador del trámite. La inscripción oficial se realiza ante el organismo de tránsito / RUNT.
            </p>
          </div>
        ) : (
          <div className="seg__bloque text-center">
            <p className="text-sm text-[var(--color-text-secondary)]">El enlace de verificación no es válido o ha expirado.</p>
          </div>
        )}
      </section>
    </LayoutPublico>
  );
}
