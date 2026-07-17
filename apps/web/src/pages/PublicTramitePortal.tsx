// EPIC TRAM-INNOV · A3 — portal público del comprador/vendedor (magic link).
//
// Sin auth. El participante: ve datos mínimos del trámite, acepta el tratamiento
// de datos (Ley 1581, versión fechada) y sube sus documentos. Estilos FLIT.

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import toast, { Toaster } from 'react-hot-toast';

interface PortalView {
  rol: string;
  consentDado: boolean;
  consentVersion: string;
  consentText: string;
  tramite: { estado: string; placa: string | null; vehiculo: { marca?: string; linea?: string } | null };
  pasosPendientes: string[];
}

const DOC_TIPOS = [
  { key: 'compraventa', label: 'Contrato de compraventa' },
  { key: 'soat', label: 'SOAT' },
  { key: 'impronta', label: 'Impronta' },
  { key: 'factura', label: 'Factura' },
  { key: 'otro', label: 'Otro documento' },
];

export default function PublicTramitePortal() {
  const { token = '' } = useParams<{ token: string }>();
  const [view, setView] = useState<PortalView | null>(null);
  const [loading, setLoading] = useState(true);
  const [invalid, setInvalid] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [tipo, setTipo] = useState('compraventa');
  const [subidos, setSubidos] = useState<string[]>([]);
  const [terminado, setTerminado] = useState(false);
  // TRAM-INNOV-B3: firma del contrato (si hay pendiente para el rol del token).
  const [firma, setFirma] = useState<{ url: string | null; proveedor: string; estado: string } | null>(null);
  const [firmando, setFirmando] = useState(false);

  const cargar = useCallback(() => {
    setLoading(true);
    fetch(`/api/tramite-portal/${encodeURIComponent(token)}`)
      .then(async (r) => {
        if (r.status === 404) { setInvalid(true); return; }
        if (!r.ok) throw new Error('No disponible');
        setView(await r.json());
      })
      .catch(() => setInvalid(true))
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => { if (token) cargar(); else { setInvalid(true); setLoading(false); } }, [token, cargar]);

  const cargarFirma = useCallback(() => {
    fetch(`/api/tramite-portal/${encodeURIComponent(token)}/firma/url`)
      .then(async (r) => { setFirma(r.ok ? await r.json() : null); })
      .catch(() => setFirma(null));
  }, [token]);

  useEffect(() => { if (view?.consentDado) cargarFirma(); }, [view?.consentDado, cargarFirma]);

  const firmarMock = async () => {
    setFirmando(true);
    try {
      const r = await fetch(`/api/tramite-portal/${encodeURIComponent(token)}/firma-simulada`, { method: 'POST' });
      if (!r.ok) throw new Error('No se pudo firmar');
      toast.success('Contrato firmado');
      cargarFirma();
    } catch { toast.error('No se pudo completar la firma'); }
    finally { setFirmando(false); }
  };

  const aceptar = async () => {
    setAccepting(true);
    try {
      const r = await fetch(`/api/tramite-portal/${encodeURIComponent(token)}/aceptar-declaracion`, { method: 'POST' });
      if (!r.ok) throw new Error('No se pudo registrar');
      toast.success('Tratamiento de datos aceptado');
      cargar();
    } catch { toast.error('No se pudo registrar el consentimiento'); }
    finally { setAccepting(false); }
  };

  const subir = async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('tipo', tipo);
      const r = await fetch(`/api/tramite-portal/${encodeURIComponent(token)}/documentos`, { method: 'POST', body: fd });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || 'Error al subir'); }
      const d = await r.json();
      setSubidos((p) => [...p, `${DOC_TIPOS.find((x) => x.key === tipo)?.label || tipo}: ${d.originalName || ''}`]);
      toast.success('Documento recibido');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Error al subir'); }
    finally { setUploading(false); }
  };

  const finalizar = async () => {
    try {
      await fetch(`/api/tramite-portal/${encodeURIComponent(token)}/finalizar`, { method: 'POST' });
      setTerminado(true);
    } catch { /* noop */ }
  };

  const Shell = ({ children }: { children: React.ReactNode }) => (
    <div className="min-h-screen bg-[color:var(--flit-bg-app)] py-10 px-4">
      <Toaster position="top-center" />
      <div className="mx-auto max-w-lg overflow-hidden rounded-2xl border bg-white shadow-[0_8px_24px_rgba(22,39,68,0.08)]" style={{ borderColor: 'var(--flit-border-input)' }}>
        <div className="px-6 py-5" style={{ background: 'var(--flit-gradient-primary)' }}>
          <p className="text-xs font-semibold uppercase tracking-wide text-white/80">FLIT · Portal del trámite</p>
          <h1 className="mt-1 text-lg font-bold text-white">Completa tu parte del trámite</h1>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );

  if (loading) return <Shell><p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando…</p></Shell>;
  if (invalid || !view) return <Shell><p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>El enlace no es válido o ha expirado. Solicita uno nuevo al gestor del trámite.</p></Shell>;
  if (terminado) return <Shell><p className="text-sm font-semibold" style={{ color: 'var(--flit-success)' }}>¡Gracias! Tu parte del trámite quedó registrada.</p></Shell>;

  return (
    <Shell>
      <div className="mb-4 grid grid-cols-2 gap-3">
        <div><p className="text-[10px] uppercase" style={{ color: 'var(--flit-text-muted)' }}>Rol</p><p className="text-sm font-semibold capitalize" style={{ color: 'var(--flit-text-primary)' }}>{view.rol}</p></div>
        <div><p className="text-[10px] uppercase" style={{ color: 'var(--flit-text-muted)' }}>Placa</p><p className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{view.tramite.placa || '—'}</p></div>
        <div className="col-span-2"><p className="text-[10px] uppercase" style={{ color: 'var(--flit-text-muted)' }}>Vehículo</p><p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>{[view.tramite.vehiculo?.marca, view.tramite.vehiculo?.linea].filter(Boolean).join(' ') || '—'}</p></div>
      </div>

      {!view.consentDado ? (
        <div>
          <p className="mb-2 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>Tratamiento de datos personales (Ley 1581) · v{view.consentVersion}</p>
          <p className="rounded-[10px] p-3 text-[12px] leading-relaxed" style={{ background: 'var(--flit-bg-app)', color: 'var(--flit-text-secondary)' }}>{view.consentText}</p>
          <button type="button" onClick={aceptar} disabled={accepting}
            className="flit-focus mt-4 inline-flex h-11 w-full items-center justify-center rounded-[999px] px-5 text-sm font-semibold text-white disabled:opacity-60"
            style={{ background: 'var(--flit-gradient-success)' }}>
            {accepting ? 'Registrando…' : 'Acepto el tratamiento de datos y continúo'}
          </button>
        </div>
      ) : (
        <div>
          <p className="mb-2 text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>Sube tus documentos</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <select value={tipo} onChange={(e) => setTipo(e.target.value)}
              className="flit-focus rounded-[10px] border bg-white px-3 py-2.5 text-sm" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}>
              {DOC_TIPOS.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
            </select>
            <label className="flit-focus inline-flex flex-1 cursor-pointer items-center justify-center rounded-[10px] border px-4 py-2.5 text-sm font-semibold" style={{ borderColor: 'var(--flit-blue)', color: 'var(--flit-blue)' }}>
              {uploading ? 'Subiendo…' : 'Elegir archivo'}
              <input type="file" accept="application/pdf,image/*" hidden disabled={uploading}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) subir(f); e.target.value = ''; }} />
            </label>
          </div>

          {subidos.length > 0 && (
            <ul className="mt-3 space-y-1">
              {subidos.map((s, i) => (
                <li key={i} className="flex items-center gap-2 text-xs" style={{ color: 'var(--flit-success)' }}>
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  {s}
                </li>
              ))}
            </ul>
          )}

          {firma && firma.estado !== 'firmada' && (
            <div className="mt-5 rounded-[10px] border p-3" style={{ borderColor: 'var(--flit-blue)', background: 'rgba(79,116,201,0.06)' }}>
              <p className="text-xs font-bold" style={{ color: 'var(--flit-blue-text)' }}>Firma del contrato de compraventa</p>
              <p className="mt-1 text-[12px]" style={{ color: 'var(--flit-text-secondary)' }}>
                Tu firma electrónica es requerida para continuar (Ley 527 de 1999).
              </p>
              {firma.proveedor === 'mock' ? (
                <button type="button" onClick={firmarMock} disabled={firmando}
                  className="flit-focus mt-3 inline-flex h-11 w-full items-center justify-center rounded-[999px] px-5 text-sm font-semibold text-white disabled:opacity-60"
                  style={{ background: 'var(--flit-gradient-success)' }}>
                  {firmando ? 'Firmando…' : 'Firmar contrato (simulado)'}
                </button>
              ) : firma.url ? (
                <a href={firma.url} target="_blank" rel="noopener noreferrer"
                  className="flit-focus mt-3 inline-flex h-11 w-full items-center justify-center rounded-[999px] px-5 text-sm font-semibold text-white"
                  style={{ background: 'var(--flit-gradient-success)' }}>
                  Ir a firmar el contrato
                </a>
              ) : null}
            </div>
          )}
          {firma && firma.estado === 'firmada' && (
            <p className="mt-5 flex items-center gap-2 text-xs font-semibold" style={{ color: 'var(--flit-success)' }}>
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              Contrato de compraventa firmado.
            </p>
          )}

          <button type="button" onClick={finalizar}
            className="flit-focus mt-4 inline-flex h-11 w-full items-center justify-center rounded-[999px] px-5 text-sm font-semibold text-white"
            style={{ background: 'var(--flit-gradient-primary)' }}>
            Finalizar
          </button>
        </div>
      )}
      <p className="mt-4 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>FLIT prepara y orquesta el trámite. La radicación oficial se realiza ante el organismo de tránsito.</p>
    </Shell>
  );
}
