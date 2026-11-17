import { useEffect, useState, useCallback, type ReactNode } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import { Fichas, LineaAvance, PildoraTramite } from '../components/flit/Bloques';
import { EstadoVista } from '../components/flit/Cargador';
import { Icono } from '../components/flit/kit/Icono';

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
/** Recorrido normal del manifiesto; rechazado/anulado salen de él y no pintan la línea. */
const FLUJO = ['borrador', 'listo', 'radicado_rndc', 'aceptado', 'cumplido'];
const TXT = 'text-xs text-[color:var(--color-text-primary)]';

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

  if (loading) return <EstadoVista status="loading" cargando="Cargando..." />;
  if (!m) return <EstadoVista status="empty" emptyMessage="No encontrado" />;

  const editable = ['borrador', 'listo'].includes(m.estado);
  const pasoFlujo = FLUJO.indexOf(m.estado);

  const envioTono = m.estadoEnvio === 'aceptado' ? 'ok' : m.estadoEnvio === 'fallido_definitivo' ? 'danger' : 'warn';

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <PageHeaderCard
        title={m.numero}
        icono="flito-rndc"
        miga={[{ etiqueta: 'Cumplimiento' }, { etiqueta: 'RNDC', to: '/rndc' }, { etiqueta: 'Manifiestos', to: '/rndc/manifiestos' }]}
        actions={
          <div className="flex flex-wrap justify-end gap-2">
            {m.estado === 'borrador' && (
              <GradientButton size="sm" onClick={marcarListo} disabled={busy}>Marcar listo</GradientButton>
            )}
            {(m.estado === 'listo' || m.estado === 'aceptado') && (
              <GradientButton size="sm" variant="success" onClick={cumplir} disabled={busy}>Cumplir</GradientButton>
            )}
            {m.estado !== 'cumplido' && m.estado !== 'anulado' && (
              <GradientButton size="sm" variant="alerta" onClick={anular} disabled={busy}>Anular</GradientButton>
            )}
            {m.estado === 'borrador' && (
              <GradientButton size="sm" variant="alerta" onClick={eliminar} disabled={busy}>Eliminar</GradientButton>
            )}
            <GradientButton size="sm" variant="secondary" onClick={descargarPdf}>
              <Icono nombre="documento" />
              PDF
            </GradientButton>
          </div>
        }
      />

      <section className="card flex flex-col gap-4 p-5">
        {pasoFlujo >= 0 && (
          <LineaAvance pasos={FLUJO.map((e) => ({ etiqueta: e.replace('_', ' ') }))} actual={m.estado === 'cumplido' ? FLUJO.length : pasoFlujo} />
        )}
        <div className="flex flex-wrap items-center gap-2 text-xs text-[color:var(--color-text-tertiary)]">
          <span>Estado:</span> <StatusChip tone={ESTADO_TONE[m.estado] ?? 'neutral'}>{m.estado.replace('_', ' ')}</StatusChip>
        </div>
        {m.consecutivoRndc && <PildoraTramite datos={[{ etiqueta: 'RNDC', valor: m.consecutivoRndc }]} />}
      </section>

      {m.estadoEnvio && m.estadoEnvio !== 'no_aplica' && (
        <div className="kit-alerta" data-tono={envioTono} data-kit="alerta">
          <div className="flex w-full flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold uppercase tracking-[0.03em] text-[color:var(--color-text-secondary)]">Estado envío RNDC</p>
              <p className="mt-1 text-sm font-medium capitalize text-[color:var(--color-text-primary)]">{m.estadoEnvio.replace(/_/g, ' ')}</p>
              {typeof m.intentosEnvio === 'number' && m.intentosEnvio > 0 && (
                <p className="mt-1 text-xs text-[color:var(--color-text-secondary)]">Intentos: {m.intentosEnvio}</p>
              )}
              {m.ultimoError && (
                <p className="mt-1 text-xs text-[color:var(--kit-rojo-texto)]">Último error: {m.ultimoError}</p>
              )}
              {m.proximoIntentoAt && m.estadoEnvio !== 'aceptado' && (
                <p className="mt-1 text-xs text-[color:var(--color-text-tertiary)]">Próximo intento: {m.proximoIntentoAt.slice(0, 16).replace('T', ' ')}</p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {m.estadoEnvio === 'cancelado_pre_envio' ? (
                <GradientButton size="sm" onClick={encolarEnvio} disabled={busy}>Encolar envío</GradientButton>
              ) : (
                <GradientButton size="sm" onClick={reintentarEnvio} disabled={busy}>Reintentar ahora</GradientButton>
              )}
              <GradientButton size="sm" variant="secondary" onClick={verHistorial}>Historial</GradientButton>
            </div>
          </div>
        </div>
      )}

      {editable && (
        <div className="kit-alerta flex-col" data-tono="warn" data-kit="alerta">
          <div className="flex w-full flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-[color:var(--kit-naranja-texto)]">Pre-validación antes de radicar</p>
              <p className="text-xs text-[color:var(--color-text-secondary)]">Verifica conductor apto, documentos vigentes, vinculación cabezote-remolque y remesas asociadas.</p>
            </div>
            <GradientButton size="sm" onClick={validar}>Ejecutar validación</GradientButton>
          </div>
          {validation && (
            <div className="mt-1 w-full space-y-1.5">
              {validation.checks.map((c, i) => (
                <div key={i} className={`flex items-start gap-2 text-xs ${c.ok ? 'text-[color:var(--kit-verde-texto)]' : 'text-[color:var(--kit-rojo-texto)]'}`}>
                  <span className={`mt-0.5 inline-block h-3 w-3 shrink-0 rounded-full ${c.ok ? 'bg-[var(--kit-verde)]' : 'bg-[var(--kit-rojo)]'}`}></span>
                  <div>
                    <p className="font-medium">{c.regla}</p>
                    {c.detalle && <p className="text-[0.75rem]">{c.detalle}</p>}
                  </div>
                </div>
              ))}
              <div className="mt-2 border-t border-[color:var(--color-border)] pt-2 text-xs font-semibold">
                {validation.ok ? <span className="text-[color:var(--kit-verde-texto)]">Listo para radicar</span> : <span className="text-[color:var(--kit-rojo-texto)]">Resuelva los puntos en rojo antes de radicar</span>}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card title="Vehículo y conductor" items={[
          { etiqueta: 'Cabezote ID', valor: m.vehiculoPrincipalId },
          m.vehiculoRemolqueId ? { etiqueta: 'Remolque ID', valor: m.vehiculoRemolqueId } : null,
          { etiqueta: 'Conductor ID', valor: m.conductorId },
          m.tenedorId ? { etiqueta: 'Tenedor ID', valor: m.tenedorId } : null,
        ]} />

        <Card title="Ruta" items={[
          { etiqueta: 'Origen DANE', valor: m.municipioOrigenDane },
          { etiqueta: 'Destino DANE', valor: m.municipioDestinoDane },
          { etiqueta: 'Expedición', valor: m.fechaExpedicion },
          m.fechaPactadaPago ? { etiqueta: 'Pago pactado', valor: m.fechaPactadaPago } : null,
        ]} />

        <Card title="Pago" items={[
          { etiqueta: 'Flete total', valor: `$ ${Number(m.valorFleteTotal).toLocaleString('es-CO')}` },
          { etiqueta: 'Anticipo', valor: `$ ${Number(m.valorAnticipo).toLocaleString('es-CO')}` },
          { etiqueta: 'Retención fuente', valor: `$ ${Number(m.retencionFuente).toLocaleString('es-CO')}` },
          { etiqueta: 'Retención ICA', valor: `$ ${Number(m.retencionIca).toLocaleString('es-CO')}` },
          { etiqueta: 'Titular tipo', valor: m.titularPagoTipo },
          m.titularPagoNombre ? { etiqueta: 'Titular', valor: `${m.titularPagoNombre} (${m.titularPagoDoc})` } : null,
        ]} />

        <Card title="Trazabilidad" items={[
          { etiqueta: 'Creado', valor: m.createdAt?.slice(0, 16).replace('T', ' ') },
          m.radicadoAt ? { etiqueta: 'Radicado RNDC', valor: m.radicadoAt.slice(0, 16).replace('T', ' ') } : null,
          m.aceptadoAt ? { etiqueta: 'Aceptado', valor: m.aceptadoAt.slice(0, 16).replace('T', ' ') } : null,
          m.cumplidoAt ? { etiqueta: 'Cumplido', valor: m.cumplidoAt.slice(0, 16).replace('T', ' ') } : null,
          m.anuladoAt ? { etiqueta: 'Anulado', valor: `${m.anuladoAt.slice(0, 16).replace('T', ' ')} — ${m.anuladoMotivo}` } : null,
          m.qrToken ? { etiqueta: 'Verificación pública', valor: <a href={`/m/${m.qrToken}`} target="_blank" rel="noreferrer" className="text-[color:var(--color-action)] hover:underline">Abrir página QR</a> } : null,
        ]} />
      </div>

      <section className="flex flex-col gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-[0.03em] text-[color:var(--color-text-tertiary)]">Remesas asociadas ({remesas.length})</h3>
        <DataTable
          ariaLabel="Remesas asociadas"
          columnas={COLUMNAS_REMESAS}
          filas={remesas}
          getKey={(r) => String(r.remesaId)}
          emptyMessage="Sin remesas asociadas"
        />
      </section>
    </div>
  );
}

const COLUMNAS_REMESAS: ColumnaTabla<RemesaAsoc>[] = [
  { key: 'orden', header: '#', render: (r) => <span className="text-xs text-[color:var(--color-text-tertiary)]">{r.orden}</span> },
  { key: 'remesa', header: 'Remesa', render: (r) => <Link to={`/rndc/remesas/${r.remesaId}`} className="text-xs font-semibold text-[color:var(--color-action)] hover:underline">{r.numero}</Link> },
  { key: 'estado', header: 'Estado', render: (r) => <span className="text-xs capitalize text-[color:var(--color-text-secondary)]">{r.estado}</span> },
  { key: 'cantidad', header: 'Cantidad', align: 'right', render: (r) => (
    <span className={TXT}>{Number(r.cantidadCargada).toLocaleString('es-CO')}{r.cantidadEntregada && <span className="text-[0.75rem] text-[color:var(--color-text-tertiary)]"> / {Number(r.cantidadEntregada).toLocaleString('es-CO')}</span>}</span>
  ) },
  { key: 'flete', header: 'Flete', align: 'right', render: (r) => <span className={`${TXT} font-medium`}>$ {Number(r.valorFlete).toLocaleString('es-CO')}</span> },
];

type FichaDato = { etiqueta: string; valor: ReactNode } | null;

function Card({ title, items }: { title: string; items: FichaDato[] }) {
  return (
    <section className="card p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.03em] text-[color:var(--color-text-tertiary)]">{title}</h3>
      <Fichas items={items.filter((x): x is NonNullable<FichaDato> => x !== null)} />
    </section>
  );
}
