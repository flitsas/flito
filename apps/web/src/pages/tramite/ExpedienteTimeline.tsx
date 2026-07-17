// EPIC TRAM-INNOV · A2 — línea de tiempo del expediente + QR de verificación.
//
// Lista cronológica de eventos inmutables (GET /tramites/:id/timeline) y botón
// para generar el QR público de verificación (POST /tramites/:id/verify-token,
// TTL 7d, revocable). Estilos: solo tokens/clases FLIT.

import { useEffect, useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import toast from 'react-hot-toast';

interface Evento {
  id: number;
  tipo: string;
  actorRole: string | null;
  docHash: string | null;
  createdAt: string;
}
interface VerifyToken { token: string; url: string; expires: string; qrPng: string }

const TIPO_LABEL: Record<string, string> = {
  creado: 'Trámite creado',
  documento_subido: 'Documento subido',
  mandato_subido: 'Mandato / poder subido',
  cambio_estado: 'Cambio de estado',
  cambio_paso: 'Avance de paso',
  enviado_transito: 'Enviado a tránsito',
  recibido_transito: 'Recibido por tránsito',
  placa_asignada: 'Placa asignada',
  rechazado_ot: 'Rechazado por el organismo',
  acceso_portal: 'Acceso al portal externo',
  verify_token_generado: 'QR de verificación generado',
  expediente_pdf_generado: 'Expediente PDF descargado',
};

const TIPO_COLOR: Record<string, string> = {
  creado: 'var(--flit-blue)',
  documento_subido: 'var(--flit-blue)',
  mandato_subido: 'var(--flit-blue)',
  enviado_transito: 'var(--flit-cyan)',
  recibido_transito: 'var(--flit-cyan)',
  placa_asignada: 'var(--flit-success)',
  rechazado_ot: 'var(--flit-danger)',
  acceso_portal: 'var(--flit-warning)',
  verify_token_generado: 'var(--flit-text-muted)',
};

const CARD = 'bg-white rounded-[18px] border border-[color:var(--flit-border-soft)] shadow-[0_8px_24px_rgba(22,39,68,0.08)] p-5';

function fmt(iso: string): string {
  try { return new Date(iso).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return iso; }
}

export default function ExpedienteTimeline({ tramiteId }: { tramiteId: number }) {
  const [eventos, setEventos] = useState<Evento[]>([]);
  const [loading, setLoading] = useState(true);
  const [qr, setQr] = useState<VerifyToken | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.get<{ eventos: Evento[] }>(`/tramites/${tramiteId}/timeline`)
      .then((d) => { if (alive) setEventos(Array.isArray(d?.eventos) ? d.eventos : []); })
      .catch(() => { if (alive) setEventos([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tramiteId]);

  const generarQr = async () => {
    setQrLoading(true);
    try {
      const t = await api.post<VerifyToken>(`/tramites/${tramiteId}/verify-token`, {});
      setQr(t);
      toast.success('QR de verificación generado (válido 7 días)');
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setQrLoading(false); }
  };

  const descargarPdf = async () => {
    if (eventos.length === 0) {
      toast.error('El expediente aún no tiene eventos registrados');
      return;
    }
    setPdfLoading(true);
    try {
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      await api.download(`/tramites/${tramiteId}/expediente.pdf`, `expediente-${tramiteId}-${stamp}.pdf`);
      toast.success('Expediente PDF descargado');
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setPdfLoading(false); }
  };

  return (
    <div className={`${CARD} mt-4`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>Expediente</h4>
          <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Trazabilidad cronológica e integridad (Res. 17145)</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={descargarPdf}
            disabled={pdfLoading || loading}
            className="flit-focus rounded-[999px] px-3.5 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60"
            style={{ background: 'rgba(79,116,201,0.12)', color: 'var(--flit-blue)' }}
          >
            {pdfLoading ? 'Generando…' : 'Descargar expediente PDF'}
          </button>
          <button
            type="button"
            onClick={generarQr}
            disabled={qrLoading}
            className="flit-focus rounded-[999px] border px-3.5 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60"
            style={{ borderColor: 'var(--flit-blue)', color: 'var(--flit-blue)' }}
          >
            {qrLoading ? 'Generando…' : 'Generar QR de verificación'}
          </button>
        </div>
      </div>

      {qr && (
        <div className="mb-4 flex flex-col items-start gap-3 rounded-[12px] p-3 sm:flex-row sm:items-center" style={{ background: 'var(--flit-bg-app)' }}>
          <img src={qr.qrPng} alt="QR de verificación del expediente" width={120} height={120} className="rounded-[8px] bg-white p-1" />
          <div className="min-w-0">
            <p className="text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>Verificación pública</p>
            <p className="mt-0.5 break-all text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{qr.url}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" onClick={() => { navigator.clipboard?.writeText(qr.url); toast.success('Enlace copiado'); }}
                className="flit-focus rounded-[999px] px-3 py-1 text-[11px] font-bold" style={{ background: 'rgba(79,116,201,0.12)', color: 'var(--flit-blue)' }}>
                Copiar enlace
              </button>
              <a href={qr.qrPng} download={`expediente-${tramiteId}-qr.png`}
                className="flit-focus rounded-[999px] px-3 py-1 text-[11px] font-bold" style={{ background: 'rgba(112,207,58,0.15)', color: 'var(--flit-success)' }}>
                Descargar PNG
              </a>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Cargando expediente…</p>
      ) : eventos.length === 0 ? (
        <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Sin eventos registrados todavía.</p>
      ) : (
        <ol className="relative space-y-3 border-l pl-4" style={{ borderColor: 'var(--flit-border-soft)' }}>
          {eventos.map((e) => (
            <li key={e.id} className="relative">
              <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full" style={{ background: TIPO_COLOR[e.tipo] || 'var(--flit-text-muted)' }} aria-hidden />
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{TIPO_LABEL[e.tipo] || e.tipo}</span>
                {e.actorRole && <span className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase" style={{ background: 'rgba(79,116,201,0.10)', color: 'var(--flit-blue)' }}>{e.actorRole}</span>}
              </div>
              <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{fmt(e.createdAt)}</p>
              {e.docHash && <p className="mt-0.5 break-all font-mono text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>sha256: {e.docHash.slice(0, 24)}…</p>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
