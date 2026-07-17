// TRAM-TRASPASO-F3 — paso 5 «Datos comerciales» con paridad CEA:
// Fasecolda (valor oficial) + MercadoLibre (precio mercado) + impuesto/derechos/total
// + forma de pago. Fórmula idéntica a TransitoTraspasoWizard:
//   valorImpuesto = round(valorVenta * tasaImpuesto/100)
//   total         = valorTramite (derechos) + valorImpuesto

import { useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import GradientButton from '../../components/flit/GradientButton';

const METODOS_PAGO = ['Efectivo', 'Transferencia', 'Tarjeta débito', 'Tarjeta crédito', 'Datafono', 'Cheque'];

export interface ComercialData {
  valorVenta: number; tasaImpuesto: number; valorTramite: number; metodoPago: string;
  causal: string; observaciones: string; valorImpuesto: number; total: number; fasecoldaCodigo?: string;
}

interface Props {
  vehiculo: Record<string, any>;
  inicial?: Partial<ComercialData>;
  busy: boolean;
  /** Paso cerrado o gestión enviada a STT → solo consulta. */
  readOnly?: boolean;
  onGuardar: (d: ComercialData) => void;
}

const inputCls = 'flit-focus mt-1 w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-3 py-2 text-sm text-[color:var(--flit-text-primary)] outline-none';
const fmtCOP = (n: number) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);

export default function TraspasoStepComercial({ vehiculo, inicial, busy, readOnly, onGuardar }: Props) {
  const [valorVenta, setValorVenta] = useState(String(inicial?.valorVenta ?? ''));
  const [tasaImpuesto, setTasaImpuesto] = useState(String(inicial?.tasaImpuesto ?? 1.0));
  const [valorTramite, setValorTramite] = useState(String(inicial?.valorTramite ?? ''));
  const [metodoPago, setMetodoPago] = useState(inicial?.metodoPago || 'Efectivo');
  const [causal, setCausal] = useState(inicial?.causal || 'COMPRAVENTA');
  const [observaciones, setObservaciones] = useState(inicial?.observaciones || '');

  const [fasecolda, setFasecolda] = useState<any>(null);
  const [fasecoldaLoading, setFasecoldaLoading] = useState(false);
  const [fasecoldaError, setFasecoldaError] = useState<string | null>(null);
  const [ml, setMl] = useState<any>(null);
  const [mlLoading, setMlLoading] = useState(false);
  const [mlError, setMlError] = useState<string | null>(null);
  const vehLabel = [vehiculo.marca, vehiculo.linea, vehiculo.modelo || vehiculo.anio].filter(Boolean).join(' ');

  const vv = Number(valorVenta) || 0;
  const tasa = Number(tasaImpuesto) || 0;
  const derechos = Number(valorTramite) || 0;
  const valorImpuesto = Math.round(vv * (tasa / 100));
  const total = derechos + valorImpuesto;

  const consultarFasecolda = async () => {
    if (fasecoldaLoading) return;
    setFasecoldaLoading(true); setFasecolda(null); setFasecoldaError(null);
    try {
      const qs = new URLSearchParams();
      qs.set('marca', String(vehiculo.marca || '')); qs.set('anio', String(vehiculo.modelo || vehiculo.anio || ''));
      if (vehiculo.linea) qs.set('linea', String(vehiculo.linea));
      if (vehiculo.cilindraje) qs.set('cilindraje', String(vehiculo.cilindraje));
      if (vehiculo.combustible) qs.set('combustible', String(vehiculo.combustible));
      if (vehiculo.numPuertas || vehiculo.puertas) qs.set('puertas', String(vehiculo.numPuertas || vehiculo.puertas));
      if (vehiculo.clase) qs.set('clase', String(vehiculo.clase));
      const r = await api.get<any>(`/fasecolda/buscar?${qs.toString()}`);
      if (r.ok && r.mejorMatch) {
        setFasecolda(r);
        setValorVenta(String(r.mejorMatch.valorCOP || ''));
        setFasecoldaError(null);
        toast.success(`Fasecolda ${r.mejorMatch.codigo}: ${fmtCOP(r.mejorMatch.valorCOP)}`);
      } else {
        const msg = r.message || `Sin valor Fasecolda para ${vehLabel || 'el vehículo'} — ingresa el valor de venta manualmente.`;
        setFasecoldaError(msg);
        toast.error(msg);
      }
    } catch (e) {
      const msg = errorMessage(e);
      setFasecoldaError(msg);
      toast.error(msg);
    }
    finally { setFasecoldaLoading(false); }
  };

  const consultarML = async () => {
    if (mlLoading) return;
    setMlLoading(true); setMl(null); setMlError(null);
    try {
      const qs = new URLSearchParams();
      qs.set('marca', String(vehiculo.marca || ''));
      if (vehiculo.linea) qs.set('linea', String(vehiculo.linea));
      if (vehiculo.modelo || vehiculo.anio) qs.set('anio', String(vehiculo.modelo || vehiculo.anio));
      const r = await api.get<any>(`/mercadolibre/precio?${qs.toString()}`);
      setMl(r);
      if (!r.ok) {
        const msg = r.message || `Sin resultados en MercadoLibre para ${vehLabel || 'el vehículo'}.`;
        setMlError(msg);
        toast.error(msg);
      } else {
        setMlError(null);
      }
    } catch (e) {
      const msg = errorMessage(e);
      setMlError(msg);
      toast.error(msg);
    }
    finally { setMlLoading(false); }
  };

  const guardar = () => {
    if (vv <= 0) {
      toast.error('Ingresa un valor de venta mayor a cero');
      return;
    }
    onGuardar({ valorVenta: vv, tasaImpuesto: tasa, valorTramite: derechos, metodoPago, causal, observaciones, valorImpuesto, total, fasecoldaCodigo: fasecolda?.mejorMatch?.codigo });
  };

  const roStyle: React.CSSProperties | undefined = readOnly
    ? { background: 'var(--flit-bg-app)', color: 'var(--flit-text-secondary)' }
    : undefined;

  return (
    <div>
      <p className="mb-3 text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>5. Datos comerciales</p>

      {/* Fasecolda + MercadoLibre (solo en edición) */}
      {!readOnly && (
      <div className="mb-4 grid gap-3 lg:grid-cols-2">
        <section aria-label="Valor Fasecolda" className="rounded-[12px] border p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-bold" style={{ color: 'var(--flit-success)' }}>Valor Fasecolda (oficial)</p>
            <button type="button" onClick={consultarFasecolda} disabled={fasecoldaLoading}
              className="flit-focus rounded-[999px] px-3 py-1 text-[11px] font-semibold disabled:opacity-50"
              style={{ color: 'white', background: 'linear-gradient(135deg,#059669,#0d9488)' }}>
              {fasecoldaLoading ? 'Consultando…' : 'Traer valor'}
            </button>
          </div>
          {fasecolda?.mejorMatch ? (
            <div className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
              <p className="text-sm font-bold" style={{ color: 'var(--flit-text-primary)' }}>{fmtCOP(fasecolda.mejorMatch.valorCOP)}</p>
              <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>Código {fasecolda.mejorMatch.codigo} · {fasecolda.mejorMatch.descripcion}</p>
            </div>
          ) : fasecoldaError ? (
            <p className="text-[11px] font-semibold" style={{ color: 'var(--flit-danger)' }} role="alert">{fasecoldaError}</p>
          ) : <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>Trae el valor comercial oficial del vehículo desde Fasecolda.</p>}
        </section>

        <section aria-label="Precio MercadoLibre" className="rounded-[12px] border p-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-bold" style={{ color: '#d97706' }}>Precio mercado (MercadoLibre)</p>
            <button type="button" onClick={consultarML} disabled={mlLoading}
              aria-label="Consultar MercadoLibre"
              className="flit-focus rounded-[999px] px-3 py-1 text-[11px] font-semibold disabled:opacity-50"
              style={{ color: '#d97706', background: 'rgba(217,119,6,.12)', border: '1px solid rgba(217,119,6,.4)' }}>
              {mlLoading ? 'Consultando…' : 'Consultar MercadoLibre'}
            </button>
          </div>
          {ml?.ok ? (
            <div className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
              <div className="flex justify-between gap-2">
                <span>Mín {fmtCOP(ml.precioMin)}</span>
                <strong style={{ color: '#d97706' }}>Prom {fmtCOP(ml.precioPromedio)}</strong>
                <span>Máx {fmtCOP(ml.precioMax)}</span>
              </div>
              <p className="mt-1 text-[10px]" style={{ color: 'var(--flit-text-muted)' }}>{ml.total} publicaciones analizadas</p>
              <button type="button" onClick={() => setValorVenta(String(ml.precioPromedio))}
                className="flit-focus mt-1 w-full rounded-[8px] px-2 py-1 text-[10px] font-bold"
                style={{ color: '#d97706', background: 'rgba(217,119,6,.12)', border: '1px solid rgba(217,119,6,.4)' }}>
                Usar precio promedio
              </button>
            </div>
          ) : mlError ? (
            <p className="text-[11px] font-semibold" style={{ color: 'var(--flit-danger)' }} role="alert">{mlError}</p>
          ) : <p className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>Compara contra el precio real de mercado.</p>}
        </section>
      </div>
      )}

      {/* Campos comerciales */}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
          Valor de venta (COP)
          <input value={valorVenta} onChange={(e) => setValorVenta(e.target.value)} readOnly={readOnly} type="number" min={0} className={inputCls} style={roStyle} aria-label="Valor de venta" />
        </label>
        <label className="block text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
          Causal
          <select value={causal} onChange={(e) => setCausal(e.target.value)} disabled={readOnly} className={inputCls} style={roStyle}>
            <option value="COMPRAVENTA">Compraventa</option>
            <option value="DONACION">Donación</option>
            <option value="DACION_EN_PAGO">Dación en pago</option>
            <option value="ADJUDICACION">Adjudicación</option>
          </select>
        </label>
        <label className="block text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
          Tasa impuesto traspaso (%)
          <input value={tasaImpuesto} onChange={(e) => setTasaImpuesto(e.target.value)} readOnly={readOnly} type="number" step={0.1} min={0} className={inputCls} style={roStyle} aria-label="Tasa impuesto" aria-describedby="comercial-tasa-hint" />
          <p id="comercial-tasa-hint" className="mt-1 text-[10px] font-normal" style={{ color: 'var(--flit-text-muted)' }}>
            Verifica la tasa vigente del departamento de matrícula (por defecto 1%).
          </p>
        </label>
        <label className="block text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
          Derechos del trámite (COP)
          <input value={valorTramite} onChange={(e) => setValorTramite(e.target.value)} readOnly={readOnly} type="number" min={0} className={inputCls} style={roStyle} aria-label="Derechos del trámite" />
        </label>
        <label className="block text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
          Forma de pago
          <select value={metodoPago} onChange={(e) => setMetodoPago(e.target.value)} disabled={readOnly} className={inputCls} style={roStyle} aria-label="Forma de pago">
            {METODOS_PAGO.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
      </div>
      <label className="mt-3 block text-xs font-semibold" style={{ color: 'var(--flit-text-secondary)' }}>
        Observaciones
        <textarea value={observaciones} onChange={(e) => setObservaciones(e.target.value)} readOnly={readOnly} rows={2} maxLength={500} className={`${inputCls} resize-none`} style={roStyle} />
      </label>

      {/* Cálculo total (paridad CEA) */}
      <section aria-label="Cálculo total" aria-live="polite" aria-atomic="true" className="mt-4 rounded-[12px] border p-3" style={{ borderColor: 'var(--flit-border-soft)', background: 'var(--flit-bg-app)' }}>
        <div className="flex justify-between border-b border-dashed py-1 text-xs" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <span>Impuesto traspaso ({tasa}% del valor de venta)</span><strong>{fmtCOP(valorImpuesto)}</strong>
        </div>
        <div className="flex justify-between border-b border-dashed py-1 text-xs" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <span>Derechos del trámite</span><strong>{fmtCOP(derechos)}</strong>
        </div>
        <div className="flex justify-between py-1.5 text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>
          <span>Total a cobrar</span><span data-testid="comercial-total">{fmtCOP(total)}</span>
        </div>
      </section>

      <p className="mt-4 rounded-[10px] border px-3 py-2 text-[11px]" style={{ borderColor: 'var(--flit-border-soft)', color: 'var(--flit-text-secondary)' }}>
        El <strong>contrato de compraventa</strong> no se genera aquí. Al continuar, en el paso <strong>6. Documentos y firma</strong> usa el botón <strong>Generar Contrato de compraventa</strong> (queda guardado en el expediente y puedes verlo o descargarlo).
      </p>

      {!readOnly && (
        <div className="mt-4 flex justify-end">
          <GradientButton type="button" onClick={guardar} disabled={busy}>Guardar y continuar</GradientButton>
        </div>
      )}
    </div>
  );
}
