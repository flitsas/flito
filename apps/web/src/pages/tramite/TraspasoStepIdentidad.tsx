// TRAM-TRASPASO-F2.1 — validación biométrica vendedor + comprador (paridad CEA paso 6).

import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import { mensajePartesTraspasoDuplicadas, partesTraspasoDuplicadas, parteTraspasoRequiereReenvio, resolverValidacionTraspasoParte, type ValidacionTraspasoRow } from '@operaciones/shared-types';

interface Parte { nombre: string; documento: string; email: string }
type Validacion = ValidacionTraspasoRow & {
  nombre?: string; procesandoDesde?: string | null;
  validadoAt?: string | null; expiraAt?: string | null; intentos?: number;
};

interface Props {
  tramiteId: number;
  vendedor: Parte;
  comprador: Parte;
  /** TRAM-F3: notifica al paso 6 cuando ambas biométricas están aprobadas (gate contrato/FUR). */
  onEstadoChange?: (ambasOk: boolean) => void;
}

const CARD = 'rounded-[12px] border p-4';
const cardStyle: React.CSSProperties = { borderColor: 'var(--flit-border-soft)' };

const ESTADO_LABEL: Record<string, { label: string; color: string }> = {
  enviado: { label: 'Correo enviado', color: 'var(--flit-blue)' },
  en_proceso: { label: 'En proceso', color: 'var(--flit-warning)' },
  aprobado: { label: 'Validado', color: 'var(--flit-success)' },
  rechazado: { label: 'Rechazado', color: 'var(--flit-danger)' },
  expirado: { label: 'Expirado', color: 'var(--flit-text-muted)' },
};

export default function TraspasoStepIdentidad({ tramiteId, vendedor, comprador, onEstadoChange }: Props) {
  const [validaciones, setValidaciones] = useState<Validacion[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [links, setLinks] = useState<{ parte: string; email: string; link?: string }[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const cargarEstado = useCallback(async () => {
    try {
      const r = await api.get<{ validaciones: Validacion[] }>(`/validacion-identidad/estado/${tramiteId}`);
      setValidaciones(r.validaciones || []);
    } catch { setValidaciones([]); }
  }, [tramiteId]);

  useEffect(() => {
    cargarEstado();
    pollRef.current = setInterval(cargarEstado, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [cargarEstado]);

  const iniciar = async () => {
    setEnviando(true);
    try {
      const r = await api.post<{ ok: boolean; message?: string; partes: { parte: string; email: string; link?: string; emailEnviado?: boolean }[] }>(
        '/validacion-identidad/iniciar-partes', { tramiteId },
      );
      setLinks(r.partes || []);
      if (r.message && (!r.partes || r.partes.length === 0)) {
        toast(r.message, { icon: 'ℹ️' });
      } else {
        toast.success(r.partes?.length === 1
          ? `Enlace enviado al ${r.partes[0].parte === 'vendedor' ? 'vendedor' : 'comprador'}`
          : 'Enlaces de validación enviados');
      }
      await cargarEstado();
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setEnviando(false); }
  };

  const valVendedor = resolverValidacionTraspasoParte(validaciones, { parte: 'vendedor', documento: vendedor.documento });
  const valComprador = resolverValidacionTraspasoParte(validaciones, { parte: 'comprador', documento: comprador.documento });
  // Email efectivo: dato del wizard (pasos 3/4) o, si el JSONB vehiculo lo perdió,
  // el registrado en la última validación biométrica (mismo fallback del backend).
  const emailVendedor = vendedor.email?.trim() || valVendedor?.email?.trim() || '';
  const emailComprador = comprador.email?.trim() || valComprador?.email?.trim() || '';
  const emailRecuperado = (!vendedor.email?.trim() && Boolean(emailVendedor)) || (!comprador.email?.trim() && Boolean(emailComprador));
  const faltaEmail = !emailVendedor || !emailComprador;
  const conflictoPartes = mensajePartesTraspasoDuplicadas(partesTraspasoDuplicadas(
    { documento: vendedor.documento, email: emailVendedor },
    { documento: comprador.documento, email: emailComprador },
  ));
  const venNecesitaEnvio = parteTraspasoRequiereReenvio(valVendedor);
  const comNecesitaEnvio = parteTraspasoRequiereReenvio(valComprador);
  const puedeEnviar = venNecesitaEnvio || comNecesitaEnvio;
  const ambasOk = valVendedor?.estado === 'aprobado' && valComprador?.estado === 'aprobado';
  const algunaEnviada = [valVendedor, valComprador].some((v) => v?.estado === 'enviado' || v?.estado === 'en_proceso');
  const algunaPendiente = !valVendedor || !valComprador || valVendedor.estado === 'enviado' || valComprador.estado === 'enviado';

  const labelBotonEnvio = (() => {
    if (enviando) return 'Enviando…';
    if (!puedeEnviar) return 'Enlaces activos — esperando validación';
    if (venNecesitaEnvio && comNecesitaEnvio) {
      return validaciones.length === 0 ? 'Enviar validación a ambas partes' : 'Reenviar validación a partes pendientes';
    }
    if (venNecesitaEnvio) return 'Reenviar validación al vendedor';
    return 'Reenviar validación al comprador';
  })();

  useEffect(() => { onEstadoChange?.(ambasOk); }, [ambasOk, onEstadoChange]);

  const hintEnProceso = (val?: Validacion) => {
    if (val?.estado !== 'en_proceso') return null;
    const desde = val.procesandoDesde ? new Date(val.procesandoDesde).getTime() : Date.now();
    const min = Math.floor((Date.now() - desde) / 60_000);
    if (min < 2) {
      return 'Análisis biométrico en curso en el dispositivo del participante (hasta 2 min). No cierres esta pantalla.';
    }
    return 'Lleva varios minutos en proceso. Pide al participante que recargue el enlace del correo y pulse Reintentar si no avanza.';
  };

  const tarjeta = (titulo: string, parte: Parte, val?: Validacion) => {
    const st = ESTADO_LABEL[val?.estado || ''] || { label: 'Pendiente', color: 'var(--flit-text-muted)' };
    const hint = hintEnProceso(val);
    return (
      <div className="rounded-[10px] border p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
        <p className="text-[10px] font-bold uppercase" style={{ color: 'var(--flit-text-muted)' }}>{titulo}</p>
        <p className="text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{parte.nombre || '—'}</p>
        <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{parte.documento} · {parte.email || 'sin email'}</p>
        <p className="mt-2 text-xs font-bold" style={{ color: st.color }}>{st.label}{val?.score ? ` (${val.score})` : ''}</p>
        {hint && (
          <p className="mt-2 text-[10px] leading-snug" style={{ color: 'var(--flit-warning)' }}>{hint}</p>
        )}
      </div>
    );
  };

  return (
    <section id="traspaso-identidad-biometrica" aria-label="Validación de identidad" className={`${CARD} scroll-mt-24`} style={cardStyle}>
      <p className="mb-1 text-xs font-bold" style={{ color: 'var(--flit-blue-text)' }}>Validación de identidad (vendedor y comprador)</p>
      <p className="mb-3 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
        Se envía un enlace seguro por correo para validar identidad con selfie y cédula (Ley 1581). Igual que CEA Tránsito.
      </p>
      {faltaEmail && (
        <p className="mb-3 rounded-[10px] border p-2 text-[11px] font-semibold" style={{ borderColor: 'rgba(240,90,53,0.35)', color: 'var(--flit-warning)', background: 'rgba(240,90,53,0.08)' }}>
          Completa el email del vendedor y comprador en los pasos 3 y 4 antes de enviar.
        </p>
      )}
      {conflictoPartes && (
        <p className="mb-3 rounded-[10px] border p-2 text-[11px] font-semibold" role="alert"
          style={{ borderColor: 'rgba(228,61,48,0.35)', color: 'var(--flit-danger)', background: 'rgba(228,61,48,0.08)' }}>
          {conflictoPartes} Corrige los datos en los pasos 3 y 4 del wizard.
        </p>
      )}
      {emailRecuperado && !faltaEmail && !conflictoPartes && (
        <p className="mb-3 rounded-[10px] border p-2 text-[11px]" role="status"
          style={{ borderColor: 'rgba(79,116,201,0.35)', color: 'var(--flit-blue-text)', background: 'rgba(79,116,201,0.08)' }}>
          El correo se recuperó de la validación biométrica previa. Verifica los datos del vendedor y comprador en los pasos 3 y 4.
        </p>
      )}
      {!ambasOk && algunaEnviada && (
        <p className="mb-3 rounded-[10px] border p-2.5 text-[11px]" role="status"
          style={{ borderColor: 'rgba(79,116,201,0.35)', color: 'var(--flit-blue-text)', background: 'rgba(79,116,201,0.08)' }}>
          <strong>Correo enviado ≠ validado.</strong> Cada parte debe abrir el enlace del correo y completar selfie + cédula.
          Cuando ambas tarjetas digan <strong>Validado</strong>, podrás generar el FUR. Mientras tanto, baja a <strong>Contrato / FUR</strong> y genera el contrato.
        </p>
      )}
      {!ambasOk && !algunaEnviada && algunaPendiente && validaciones.length === 0 && (
        <p className="mb-3 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>
          Pulsa el botón azul para enviar los enlaces de validación a vendedor y comprador.
        </p>
      )}
      <div className="mb-3 grid gap-3 sm:grid-cols-2">
        {tarjeta('Vendedor (titular saliente)', { ...vendedor, email: emailVendedor }, valVendedor)}
        {tarjeta('Comprador (adquirente)', { ...comprador, email: emailComprador }, valComprador)}
      </div>
      <button type="button" onClick={iniciar} disabled={enviando || faltaEmail || Boolean(conflictoPartes) || !puedeEnviar}
        className="flit-focus w-full rounded-[999px] px-4 py-2.5 text-xs font-bold text-white disabled:opacity-50"
        style={{ background: 'var(--flit-gradient-primary)', boxShadow: 'var(--flit-shadow-button)' }}>
        {labelBotonEnvio}
      </button>
      {links.length > 0 && (
        <ul className="mt-3 space-y-1 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>
          {links.filter((l) => l.link).map((l) => (
            <li key={l.parte}>{l.parte}: enlace manual disponible si el correo no llegó.</li>
          ))}
        </ul>
      )}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {ambasOk ? 'Ambas identidades biométricas validadas.' : ''}
      </p>
      {ambasOk && (
        <p className="mt-3 text-xs font-semibold" style={{ color: 'var(--flit-success)' }}>✓ Ambas identidades validadas.</p>
      )}
    </section>
  );
}
