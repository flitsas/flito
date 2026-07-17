import { useEffect, useState, useCallback, type ReactNode } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';

interface Manifiesto {
  id: number; numero: string; consecutivoRndc: string | null; estado: string;
  vehiculoPrincipalId: number; vehiculoRemolqueId: number | null;
  conductorId: number; tenedorId: number | null;
  municipioOrigenDane: string; municipioDestinoDane: string;
  fechaExpedicion: string; fechaPactadaPago: string | null;
  valorFleteTotal: string; valorAnticipo: string;
  retencionFuente: string; retencionIca: string;
  titularPagoTipo: string; titularPagoDoc: string | null;
  titularPagoNombre: string | null; titularPagoCuenta: string | null;
  observaciones: string | null;
  qrToken: string | null;
  estadoEnvio?: string; intentosEnvio?: number; ultimoError?: string | null;
  ultimoIntentoAt?: string | null; proximoIntentoAt?: string | null;
  radicadoAt: string | null; aceptadoAt: string | null;
  cumplidoAt: string | null; anuladoAt: string | null; anuladoMotivo: string | null;
  createdAt: string;
}
interface OperacionLog {
  id: number; tipoOp: string; intento: number; modo: string;
  resultado: string; codigoResultado: string | null;
  consecutivoRndc: string | null; mensaje: string | null; duracionMs: number | null;
  createdAt: string;
}
interface RemesaAsoc {
  remesaId: number; orden: number; numero: string;
  estado: string; cantidadCargada: string; cantidadEntregada: string | null;
  valorFlete: string; cumplidoAt: string | null;
}

interface ValidationCheck { regla: string; ok: boolean; detalle?: string; }
interface ValidationResult { ok: boolean; checks: ValidationCheck[]; }

const ESTADO_TONE: Record<string, ChipTone> = {
  borrador: 'neutral', listo: 'active', radicado_rndc: 'active',
  aceptado: 'success', rechazado: 'danger', cumplido: 'success', anulado: 'neutral',
};
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

export default function RndcManifiestoDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [m, setM] = useState<Manifiesto | null>(null);
  const [remesas, setRemesas] = useState<RemesaAsoc[]>([]);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get<{ data: Manifiesto; remesas: RemesaAsoc[] }>(`/rndc/manifiestos/${id}`);
      setM(r.data); setRemesas(r.remesas);
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const validar = async () => {
    try {
      const r = await api.get<ValidationResult>(`/rndc/manifiestos/${id}/validar`);
      setValidation(r);
    } catch (err) { toast.error(errorMessage(err)); }
  };

  const marcarListo = async () => {
    setBusy(true);
    try {
      await api.post(`/rndc/manifiestos/${id}/marcar-listo`, {});
      toast.success('Manifiesto marcado como listo');
      await load();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setBusy(false); }
  };

  const cumplir = async () => {
    if (!confirm('¿Marcar manifiesto como cumplido?')) return;
    setBusy(true);
    try {
      await api.post(`/rndc/manifiestos/${id}/cumplir`, {});
      toast.success('Manifiesto cumplido');
      await load();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setBusy(false); }
  };

  const anular = async () => {
    const motivo = prompt('Motivo de anulación (mínimo 5 caracteres):');
    if (!motivo || motivo.length < 5) return;
    setBusy(true);
    try {
      await api.post(`/rndc/manifiestos/${id}/anular`, { motivo });
      toast.success('Manifiesto anulado');
      await load();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setBusy(false); }
  };

  const eliminar = async () => {
    if (!confirm('¿Eliminar este borrador?')) return;
    setBusy(true);
    try {
      await api.delete(`/rndc/manifiestos/${id}`);
      toast.success('Borrador eliminado');
      nav('/rndc/manifiestos');
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setBusy(false); }
  };

  const reintentarEnvio = async () => {
    if (!confirm('¿Reintentar envío RNDC ahora?')) return;
    setBusy(true);
    try {
      const r = await api.post<{ ok: boolean; estadoFinal: string; mensaje: string }>(`/rndc/manifiestos/${id}/reintentar-envio`, {});
      if (r.ok) toast.success(`Aceptado RNDC: ${r.mensaje}`);
      else toast.error(`${r.estadoFinal}: ${r.mensaje}`);
      await load();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setBusy(false); }
  };

  const encolarEnvio = async () => {
    setBusy(true);
    try {
      await api.post(`/rndc/manifiestos/${id}/encolar-envio`, {});
      toast.success('Encolado para envío RNDC');
      await load();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setBusy(false); }
  };

  const verHistorial = async () => {
    try {
      const r = await api.get<{ data: OperacionLog[] }>(`/rndc/manifiestos/${id}/operaciones`);
      const lines = r.data.map((o) =>
        `[${o.createdAt.slice(0, 16).replace('T', ' ')}] #${o.intento} ${o.tipoOp} ${o.modo} → ${o.resultado}` +
        (o.codigoResultado ? ` (${o.codigoResultado})` : '') +
        (o.consecutivoRndc ? ` cons=${o.consecutivoRndc}` : '') +
        (o.mensaje ? `\n  ${o.mensaje}` : '') +
        (o.duracionMs ? ` [${o.duracionMs}ms]` : '')
      ).join('\n');
      alert(lines || 'Sin operaciones registradas');
    } catch (err) { toast.error(errorMessage(err)); }
  };

  const descargarPdf = () => {
    window.open(`/api/rndc/manifiestos/${id}/pdf`, '_blank');
  };

  if (loading) return <div className="p-8" style={{ color: 'var(--flit-text-muted)' }}>Cargando...</div>;
  if (!m) return <div className="p-8" style={{ color: 'var(--flit-text-muted)' }}>No encontrado</div>;

  const editable = ['borrador', 'listo'].includes(m.estado);

  const envioStyle =
    m.estadoEnvio === 'aceptado' ? { background: 'rgba(112,207,58,0.10)', border: '1px solid rgba(112,207,58,0.30)' }
    : m.estadoEnvio === 'fallido_definitivo' ? { background: 'rgba(228,61,48,0.10)', border: '1px solid rgba(228,61,48,0.30)' }
    : { background: 'rgba(240,90,53,0.10)', border: '1px solid rgba(240,90,53,0.30)' };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4 bg-white px-6 py-5" style={CARD}>
        <div className="flex flex-col gap-1">
          <Link to="/rndc/manifiestos" className="text-xs font-semibold hover:underline" style={{ color: 'var(--flit-blue)' }}>← Manifiestos</Link>
          <h1 className="mt-1 text-xl font-bold tracking-tight" style={{ color: 'var(--flit-blue-text)' }}>{m.numero}</h1>
          <p className="flex items-center gap-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
            <span>Estado:</span> <StatusChip tone={ESTADO_TONE[m.estado] ?? 'neutral'}>{m.estado.replace('_', ' ')}</StatusChip>
            {m.consecutivoRndc && <span style={{ color: 'var(--flit-success)' }}>RNDC {m.consecutivoRndc}</span>}
          </p>
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          {m.estado === 'borrador' && (
            <button onClick={marcarListo} disabled={busy} className="flit-focus inline-flex h-9 items-center rounded-[999px] px-4 text-xs font-semibold text-white disabled:opacity-50" style={{ background: 'var(--flit-gradient-primary)' }}>Marcar listo</button>
          )}
          {(m.estado === 'listo' || m.estado === 'aceptado') && (
            <button onClick={cumplir} disabled={busy} className="flit-focus inline-flex h-9 items-center rounded-[999px] px-4 text-xs font-semibold text-white disabled:opacity-50" style={{ background: 'var(--flit-gradient-success)' }}>Cumplir</button>
          )}
          {m.estado !== 'cumplido' && m.estado !== 'anulado' && (
            <button onClick={anular} disabled={busy} className="flit-focus inline-flex h-9 items-center rounded-[999px] px-4 text-xs font-semibold text-white disabled:opacity-50" style={{ background: 'var(--flit-gradient-danger)' }}>Anular</button>
          )}
          {m.estado === 'borrador' && (
            <button onClick={eliminar} disabled={busy} className="flit-focus inline-flex h-9 items-center rounded-[999px] border px-4 text-xs font-semibold" style={{ borderColor: 'rgba(228,61,48,0.40)', color: 'var(--flit-danger)' }}>Eliminar</button>
          )}
          <button onClick={descargarPdf} className="flit-focus inline-flex h-9 items-center gap-1.5 rounded-[999px] border bg-white px-4 text-xs font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
            </svg>
            PDF
          </button>
        </div>
      </div>

      {m.estadoEnvio && m.estadoEnvio !== 'no_aplica' && (
        <div className="rounded-[18px] p-4" style={{ ...envioStyle, boxShadow: 'var(--flit-shadow-card)' }}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <p className="text-[10px] font-semibold uppercase tracking-[0.3em]" style={{ color: 'var(--flit-text-secondary)' }}>Estado envío RNDC</p>
              <p className="mt-1 text-sm font-medium capitalize" style={{ color: 'var(--flit-text-primary)' }}>{m.estadoEnvio.replace(/_/g, ' ')}</p>
              {typeof m.intentosEnvio === 'number' && m.intentosEnvio > 0 && (
                <p className="mt-1 text-[11px]" style={{ color: 'var(--flit-text-secondary)' }}>Intentos: {m.intentosEnvio}</p>
              )}
              {m.ultimoError && (
                <p className="mt-1 text-[11px]" style={{ color: 'var(--flit-danger)' }}>Último error: {m.ultimoError}</p>
              )}
              {m.proximoIntentoAt && m.estadoEnvio !== 'aceptado' && (
                <p className="mt-1 text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>Próximo intento: {m.proximoIntentoAt.slice(0, 16).replace('T', ' ')}</p>
              )}
            </div>
            <div className="flex gap-2">
              {m.estadoEnvio === 'cancelado_pre_envio' ? (
                <button onClick={encolarEnvio} disabled={busy} className="flit-focus inline-flex h-9 items-center rounded-[999px] px-3 text-xs font-semibold text-white disabled:opacity-50" style={{ background: 'var(--flit-gradient-primary)' }}>Encolar envío</button>
              ) : (
                <button onClick={reintentarEnvio} disabled={busy} className="flit-focus inline-flex h-9 items-center rounded-[999px] px-3 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50" style={{ background: 'var(--flit-text-primary)' }}>Reintentar ahora</button>
              )}
              <button onClick={verHistorial} className="flit-focus inline-flex h-9 items-center rounded-[999px] border bg-white px-3 text-xs font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-primary)' }}>Historial</button>
            </div>
          </div>
        </div>
      )}

      {editable && (
        <div className="rounded-[18px] p-4" style={{ background: 'rgba(240,90,53,0.10)', border: '1px solid rgba(240,90,53,0.30)', boxShadow: 'var(--flit-shadow-card)' }}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold" style={{ color: 'var(--flit-warning)' }}>Pre-validación antes de radicar</p>
              <p className="text-[11px]" style={{ color: 'var(--flit-text-secondary)' }}>Verifica conductor apto, documentos vigentes, vinculación cabezote-remolque y remesas asociadas.</p>
            </div>
            <button onClick={validar} className="flit-focus inline-flex h-9 items-center rounded-[999px] px-3 text-xs font-semibold text-white transition-opacity hover:opacity-90" style={{ background: 'var(--flit-warning)' }}>Ejecutar validación</button>
          </div>
          {validation && (
            <div className="mt-3 space-y-1.5">
              {validation.checks.map((c, i) => (
                <div key={i} className="flex items-start gap-2 text-xs" style={{ color: c.ok ? 'var(--flit-success)' : 'var(--flit-danger)' }}>
                  <span className="mt-0.5 inline-block h-3 w-3 rounded-full" style={{ background: c.ok ? 'var(--flit-success)' : 'var(--flit-danger)' }}></span>
                  <div>
                    <p className="font-medium">{c.regla}</p>
                    {c.detalle && <p className="text-[10px] opacity-80">{c.detalle}</p>}
                  </div>
                </div>
              ))}
              <div className="mt-2 border-t pt-2 text-xs font-semibold" style={{ borderColor: 'rgba(240,90,53,0.20)' }}>
                {validation.ok ? <span style={{ color: 'var(--flit-success)' }}>Listo para radicar</span> : <span style={{ color: 'var(--flit-danger)' }}>Resuelva los puntos en rojo antes de radicar</span>}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card title="Vehículo y conductor">
          <Row label="Cabezote ID">{m.vehiculoPrincipalId}</Row>
          {m.vehiculoRemolqueId && <Row label="Remolque ID">{m.vehiculoRemolqueId}</Row>}
          <Row label="Conductor ID">{m.conductorId}</Row>
          {m.tenedorId && <Row label="Tenedor ID">{m.tenedorId}</Row>}
        </Card>

        <Card title="Ruta">
          <Row label="Origen DANE">{m.municipioOrigenDane}</Row>
          <Row label="Destino DANE">{m.municipioDestinoDane}</Row>
          <Row label="Expedición">{m.fechaExpedicion}</Row>
          {m.fechaPactadaPago && <Row label="Pago pactado">{m.fechaPactadaPago}</Row>}
        </Card>

        <Card title="Pago">
          <Row label="Flete total">$ {Number(m.valorFleteTotal).toLocaleString('es-CO')}</Row>
          <Row label="Anticipo">$ {Number(m.valorAnticipo).toLocaleString('es-CO')}</Row>
          <Row label="Retención fuente">$ {Number(m.retencionFuente).toLocaleString('es-CO')}</Row>
          <Row label="Retención ICA">$ {Number(m.retencionIca).toLocaleString('es-CO')}</Row>
          <Row label="Titular tipo">{m.titularPagoTipo}</Row>
          {m.titularPagoNombre && <Row label="Titular">{m.titularPagoNombre} ({m.titularPagoDoc})</Row>}
        </Card>

        <Card title="Trazabilidad">
          <Row label="Creado">{m.createdAt?.slice(0, 16).replace('T', ' ')}</Row>
          {m.radicadoAt && <Row label="Radicado RNDC">{m.radicadoAt.slice(0, 16).replace('T', ' ')}</Row>}
          {m.aceptadoAt && <Row label="Aceptado">{m.aceptadoAt.slice(0, 16).replace('T', ' ')}</Row>}
          {m.cumplidoAt && <Row label="Cumplido">{m.cumplidoAt.slice(0, 16).replace('T', ' ')}</Row>}
          {m.anuladoAt && <Row label="Anulado">{m.anuladoAt.slice(0, 16).replace('T', ' ')} — {m.anuladoMotivo}</Row>}
          {m.qrToken && <Row label="Verificación pública"><a href={`/m/${m.qrToken}`} target="_blank" rel="noreferrer" className="hover:underline" style={{ color: 'var(--flit-blue)' }}>Abrir página QR</a></Row>}
        </Card>
      </div>

      <div className="overflow-hidden bg-white" style={CARD}>
        <div className="border-b px-4 py-3" style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-table-header)' }}>
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.3em]" style={{ color: 'var(--flit-text-muted)' }}>Remesas asociadas ({remesas.length})</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr>
              <Th>#</Th><Th>Remesa</Th><Th>Estado</Th><Th className="text-right">Cantidad</Th><Th className="text-right">Flete</Th>
            </tr></thead>
            <tbody>
              {remesas.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-xs" style={{ color: 'var(--flit-text-muted)' }}>Sin remesas asociadas</td></tr>}
              {remesas.map((r) => (
                <tr key={r.remesaId} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-muted)' }}>{r.orden}</td>
                  <td className="px-4 py-3 text-xs"><Link to={`/rndc/remesas/${r.remesaId}`} className="font-semibold hover:underline" style={{ color: 'var(--flit-blue)' }}>{r.numero}</Link></td>
                  <td className="px-4 py-3 text-xs capitalize" style={{ color: 'var(--flit-text-secondary)' }}>{r.estado}</td>
                  <td className="px-4 py-3 text-right text-xs" style={{ color: 'var(--flit-text-primary)' }}>{Number(r.cantidadCargada).toLocaleString('es-CO')}{r.cantidadEntregada && <span className="text-[10px]" style={{ color: 'var(--flit-text-muted)' }}> / {Number(r.cantidadEntregada).toLocaleString('es-CO')}</span>}</td>
                  <td className="px-4 py-3 text-right text-xs font-medium" style={{ color: 'var(--flit-text-primary)' }}>$ {Number(r.valorFlete).toLocaleString('es-CO')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Th({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <th scope="col" className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide ${className}`} style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{children}</th>;
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="bg-white p-4" style={CARD}>
      <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-[0.3em]" style={{ color: 'var(--flit-text-muted)' }}>{title}</h3>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span style={{ color: 'var(--flit-text-muted)' }}>{label}</span>
      <span className="text-right font-medium" style={{ color: 'var(--flit-text-primary)' }}>{children}</span>
    </div>
  );
}
