// EPIC TRAM-INNOV · A3 — portal público del comprador/vendedor (magic link).
//
// Sin auth. El participante: ve datos mínimos del trámite, acepta el tratamiento
// de datos (Ley 1581, versión fechada) y sube sus documentos. Estilos FLIT.

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import toast, { Toaster } from 'react-hot-toast';
import LayoutPublico from '../components/flit/LayoutPublico';
import InlineAlert from '../components/flit/InlineAlert';
import GradientButton, { claseBoton } from '../components/flit/GradientButton';
import { Cargador } from '../components/flit/Cargador';
import { Fichas } from '../components/flit/Bloques';
import { flitInp } from '../components/flit/flitPageKit';
import { Icono, IconoModulo } from '../components/flit/kit/Icono';

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
    <LayoutPublico ancho={640}>
      <Toaster position="top-center" />
      <section className="card seg">
        <div className="seg__cab">
          <IconoModulo clave="flito-tramites" disco size={48} className="shrink-0" />
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-tertiary)]">FLIT · Portal del trámite</p>
            <h1 className="mt-1 text-xl font-bold text-[var(--color-action)]">Completa tu parte del trámite</h1>
          </div>
        </div>
        <div>{children}</div>
      </section>
    </LayoutPublico>
  );

  if (loading) return <Shell><Cargador texto="Cargando…" /></Shell>;
  if (invalid || !view) return <Shell><div className="seg__bloque"><p className="text-sm text-[var(--color-text-secondary)]">El enlace no es válido o ha expirado. Solicita uno nuevo al gestor del trámite.</p></div></Shell>;
  if (terminado) return <Shell><InlineAlert tono="ok"><span className="font-semibold">¡Gracias! Tu parte del trámite quedó registrada.</span></InlineAlert></Shell>;

  return (
    <Shell>
      <div className="mb-4">
        <Fichas items={[
          { etiqueta: 'Rol', valor: <span className="font-semibold capitalize">{view.rol}</span> },
          { etiqueta: 'Placa', valor: <span className="font-semibold">{view.tramite.placa || '—'}</span> },
          { etiqueta: 'Vehículo', valor: [view.tramite.vehiculo?.marca, view.tramite.vehiculo?.linea].filter(Boolean).join(' ') || '—' },
        ]} />
      </div>

      {!view.consentDado ? (
        <div className="seg__bloque">
          <h2 className="mb-2 text-sm font-semibold text-[var(--color-text-secondary)]">Tratamiento de datos personales (Ley 1581) · v{view.consentVersion}</h2>
          <p className="rounded-[9px] bg-[var(--color-surface)] p-3 text-xs leading-relaxed text-[var(--color-text-secondary)]">{view.consentText}</p>
          <GradientButton type="button" variant="success" onClick={aceptar} disabled={accepting} className="mt-4 w-full">
            {accepting ? 'Registrando…' : 'Acepto el tratamiento de datos y continúo'}
          </GradientButton>
        </div>
      ) : (
        <div>
          <h2 className="mb-2 text-sm font-semibold text-[var(--color-text-secondary)]">Sube tus documentos</h2>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
            <select value={tipo} onChange={(e) => setTipo(e.target.value)} className={`${flitInp} sm:w-auto`}>
              {DOC_TIPOS.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
            </select>
            <label data-kit="carga" data-estado={uploading ? 'uploading' : 'idle'}
              className={`carga kit-carga flex-1 cursor-pointer focus-within:outline focus-within:outline-2 focus-within:outline-[var(--kit-azul)]${uploading ? ' opacity-60' : ''}`}>
              <Icono nombre={uploading ? 'girador' : 'nube-subir'} size={28} className={uploading ? 'animate-spin motion-reduce:animate-none' : ''} />
              <span className="text-sm font-semibold text-[var(--color-action)]">{uploading ? 'Subiendo…' : 'Elegir archivo'}</span>
              <input type="file" accept="application/pdf,image/*" hidden disabled={uploading}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) subir(f); e.target.value = ''; }} />
            </label>
          </div>

          {subidos.length > 0 && (
            <ul className="mt-3 space-y-1">
              {subidos.map((s, i) => (
                <li key={i} className="flex items-center gap-2 text-xs text-[var(--kit-verde-texto)]">
                  <Icono nombre="check" size={16} />
                  {s}
                </li>
              ))}
            </ul>
          )}

          {firma && firma.estado !== 'firmada' && (
            <div className="barra-accion mt-5 !block">
              <p className="text-xs font-bold text-[var(--color-action)]">Firma del contrato de compraventa</p>
              <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                Tu firma electrónica es requerida para continuar (Ley 527 de 1999).
              </p>
              {firma.proveedor === 'mock' ? (
                <GradientButton type="button" variant="success" onClick={firmarMock} disabled={firmando} className="mt-3 w-full">
                  {firmando ? 'Firmando…' : 'Firmar contrato (simulado)'}
                </GradientButton>
              ) : firma.url ? (
                <a href={firma.url} target="_blank" rel="noopener noreferrer" data-variante="confirmar"
                  className={claseBoton('success', 'md', 'mt-3 w-full')}>
                  Ir a firmar el contrato
                </a>
              ) : null}
            </div>
          )}
          {firma && firma.estado === 'firmada' && (
            <p className="mt-5 flex items-center gap-2 text-xs font-semibold text-[var(--kit-verde-texto)]">
              <Icono nombre="check" size={16} />
              Contrato de compraventa firmado.
            </p>
          )}

          <GradientButton type="button" onClick={finalizar} className="mt-4 w-full">
            Finalizar
          </GradientButton>
        </div>
      )}
      <p className="nota mt-4 text-[var(--color-text-tertiary)]">FLIT prepara y orquesta el trámite. La radicación oficial se realiza ante el organismo de tránsito.</p>
    </Shell>
  );
}
