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
  creado: 'var(--kit-azul)',
  documento_subido: 'var(--kit-azul)',
  mandato_subido: 'var(--kit-azul)',
  enviado_transito: 'var(--kit-turquesa)',
  recibido_transito: 'var(--kit-turquesa)',
  placa_asignada: 'var(--kit-verde)',
  rechazado_ot: 'var(--kit-rojo)',
  acceso_portal: 'var(--kit-naranja)',
  verify_token_generado: 'var(--color-text-tertiary)',
};

const CARD = 'bg-[var(--color-surface-elevated)] rounded-[9px] border border-[color:var(--color-border)] p-5';

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
          <h4 className="text-sm font-bold" style={{ color: 'var(--color-action)' }}>Expediente</h4>
          <p className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>Trazabilidad cronológica e integridad (Res. 17145)</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={descargarPdf}
            disabled={pdfLoading || loading}
            className="flit-focus rounded-[999px] px-3.5 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60"
            style={{ background: 'color-mix(in srgb, var(--kit-azul) 12%, transparent)', color: 'var(--color-action)' }}
          >
            {pdfLoading ? 'Generando…' : 'Descargar expediente PDF'}
          </button>
          <button
            type="button"
            onClick={generarQr}
            disabled={qrLoading}
            className="flit-focus rounded-[999px] border px-3.5 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60"
            style={{ borderColor: 'var(--kit-azul)', color: 'var(--color-action)' }}
          >
            {qrLoading ? 'Generando…' : 'Generar QR de verificación'}
          </button>
        </div>
      </div>

      {qr && (
        <div className="mb-4 flex flex-col items-start gap-3 rounded-[9px] p-3 sm:flex-row sm:items-center" style={{ background: 'var(--color-surface)' }}>
          <img src={qr.qrPng} alt="QR de verificación del expediente" width={120} height={120} className="rounded-[9px] bg-[var(--color-surface-elevated)] p-1" />
          <div className="min-w-0">
            <p className="text-xs font-semibold" style={{ color: 'var(--color-text-primary)' }}>Verificación pública</p>
            <p className="mt-0.5 break-all text-xs" style={{ color: 'var(--color-text-tertiary)' }}>{qr.url}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" onClick={() => { navigator.clipboard?.writeText(qr.url); toast.success('Enlace copiado'); }}
                className="flit-focus rounded-[999px] px-3 py-1 text-xs font-bold" style={{ background: 'color-mix(in srgb, var(--kit-azul) 12%, transparent)', color: 'var(--color-action)' }}>
                Copiar enlace
              </button>
              <a href={qr.qrPng} download={`expediente-${tramiteId}-qr.png`}
                className="flit-focus rounded-[999px] px-3 py-1 text-xs font-bold" style={{ background: 'color-mix(in srgb, var(--kit-verde) 15%, transparent)', color: 'var(--kit-verde-texto)' }}>
                Descargar PNG
              </a>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>Cargando expediente…</p>
      ) : eventos.length === 0 ? (
        <p className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>Sin eventos registrados todavía.</p>
      ) : (
        <ol className="relative space-y-3 border-l pl-4" style={{ borderColor: 'var(--color-border)' }}>
          {eventos.map((e) => (
            <li key={e.id} className="relative">
              <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full" style={{ background: TIPO_COLOR[e.tipo] || 'var(--color-text-tertiary)' }} aria-hidden />
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-semibold" style={{ color: 'var(--color-text-primary)' }}>{TIPO_LABEL[e.tipo] || e.tipo}</span>
                {e.actorRole && <span className="rounded px-1.5 py-0.5 text-xs font-bold uppercase" style={{ background: 'color-mix(in srgb, var(--kit-azul) 10%, transparent)', color: 'var(--color-action)' }}>{e.actorRole}</span>}
              </div>
              <p className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>{fmt(e.createdAt)}</p>
              {e.docHash && <p className="mt-0.5 break-all font-mono text-xs" style={{ color: 'var(--color-text-tertiary)' }}>sha256: {e.docHash.slice(0, 24)}…</p>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
