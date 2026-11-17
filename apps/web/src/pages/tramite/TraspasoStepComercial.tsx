// TRAM-TRASPASO-F3 — paso 5 «Datos comerciales» con paridad CEA:
// Fasecolda (valor oficial) + MercadoLibre (precio mercado) + impuesto/derechos/total
// + forma de pago. Fórmula idéntica a TransitoTraspasoWizard:
//   valorImpuesto = round(valorVenta * tasaImpuesto/100)
//   total         = valorTramite (derechos) + valorImpuesto

import { useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../../lib/api';
import GradientButton from '../../components/flit/GradientButton';
import { flitInp } from '../../components/flit/flitPageKit';

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

const inputCls = `mt-1 ${flitInp}`;
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
    ? { background: 'var(--kit-hover)', color: 'var(--color-text-secondary)' }
    : undefined;

  return (
    <div>
      <p className="m-0 mb-3 text-base font-bold" style={{ color: 'var(--color-action)' }}>5. Datos comerciales</p>

      {/* Fasecolda + MercadoLibre (solo en edición) */}
      {!readOnly && (
      <div className="mb-4 grid gap-3 lg:grid-cols-2">
        <section aria-label="Valor Fasecolda" className="rounded-[9px] border p-3" style={{ borderColor: 'var(--color-border)' }}>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-bold" style={{ color: 'var(--kit-verde-texto)' }}>Valor Fasecolda (oficial)</p>
            <GradientButton type="button" variant="secondary" size="sm" onClick={consultarFasecolda} disabled={fasecoldaLoading}>
              {fasecoldaLoading ? 'Consultando…' : 'Traer valor'}
            </GradientButton>
          </div>
          {fasecolda?.mejorMatch ? (
            <div className="text-xs" style={{ color: 'var(--color-text-primary)' }}>
              <p className="text-sm font-bold" style={{ color: 'var(--color-text-primary)' }}>{fmtCOP(fasecolda.mejorMatch.valorCOP)}</p>
              <p className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>Código {fasecolda.mejorMatch.codigo} · {fasecolda.mejorMatch.descripcion}</p>
            </div>
          ) : fasecoldaError ? (
            <p className="text-xs font-semibold" style={{ color: 'var(--kit-rojo-texto)' }} role="alert">{fasecoldaError}</p>
          ) : <p className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>Trae el valor comercial oficial del vehículo desde Fasecolda.</p>}
        </section>

        <section aria-label="Precio MercadoLibre" className="rounded-[9px] border p-3" style={{ borderColor: 'var(--color-border)' }}>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-bold" style={{ color: 'var(--kit-naranja-texto)' }}>Precio mercado (MercadoLibre)</p>
            <GradientButton type="button" variant="secondary" size="sm" onClick={consultarML} disabled={mlLoading}
              aria-label="Consultar MercadoLibre">
              {mlLoading ? 'Consultando…' : 'Consultar MercadoLibre'}
            </GradientButton>
          </div>
          {ml?.ok ? (
            <div className="text-xs" style={{ color: 'var(--color-text-primary)' }}>
              <div className="flex flex-wrap justify-between gap-2">
                <span>Mín {fmtCOP(ml.precioMin)}</span>
                <strong style={{ color: 'var(--kit-naranja-texto)' }}>Prom {fmtCOP(ml.precioPromedio)}</strong>
                <span>Máx {fmtCOP(ml.precioMax)}</span>
              </div>
              <p className="mt-1 text-xs" style={{ color: 'var(--color-text-tertiary)' }}>{ml.total} publicaciones analizadas</p>
              <GradientButton type="button" variant="secondary" size="sm" className="mt-2 w-full justify-center" onClick={() => setValorVenta(String(ml.precioPromedio))}>
                Usar precio promedio
              </GradientButton>
            </div>
          ) : mlError ? (
            <p className="text-xs font-semibold" style={{ color: 'var(--kit-rojo-texto)' }} role="alert">{mlError}</p>
          ) : <p className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>Compara contra el precio real de mercado.</p>}
        </section>
      </div>
      )}

      {/* Campos comerciales */}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-semibold" style={{ color: 'var(--color-text-primary)' }}>
          Valor de venta (COP)
          <input value={valorVenta} onChange={(e) => setValorVenta(e.target.value)} readOnly={readOnly} type="number" min={0} className={inputCls} style={roStyle} aria-label="Valor de venta" />
        </label>
        <label className="block text-xs font-semibold" style={{ color: 'var(--color-text-primary)' }}>
          Causal
          <select value={causal} onChange={(e) => setCausal(e.target.value)} disabled={readOnly} className={inputCls} style={roStyle}>
            <option value="COMPRAVENTA">Compraventa</option>
            <option value="DONACION">Donación</option>
            <option value="DACION_EN_PAGO">Dación en pago</option>
            <option value="ADJUDICACION">Adjudicación</option>
          </select>
        </label>
        <label className="block text-xs font-semibold" style={{ color: 'var(--color-text-primary)' }}>
          Tasa impuesto traspaso (%)
          <input value={tasaImpuesto} onChange={(e) => setTasaImpuesto(e.target.value)} readOnly={readOnly} type="number" step={0.1} min={0} className={inputCls} style={roStyle} aria-label="Tasa impuesto" aria-describedby="comercial-tasa-hint" />
          <p id="comercial-tasa-hint" className="mt-1 text-xs font-normal" style={{ color: 'var(--color-text-tertiary)' }}>
            Verifica la tasa vigente del departamento de matrícula (por defecto 1%).
          </p>
        </label>
        <label className="block text-xs font-semibold" style={{ color: 'var(--color-text-primary)' }}>
          Derechos del trámite (COP)
          <input value={valorTramite} onChange={(e) => setValorTramite(e.target.value)} readOnly={readOnly} type="number" min={0} className={inputCls} style={roStyle} aria-label="Derechos del trámite" />
        </label>
        <label className="block text-xs font-semibold" style={{ color: 'var(--color-text-primary)' }}>
          Forma de pago
          <select value={metodoPago} onChange={(e) => setMetodoPago(e.target.value)} disabled={readOnly} className={inputCls} style={roStyle} aria-label="Forma de pago">
            {METODOS_PAGO.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
      </div>
      <label className="mt-3 block text-xs font-semibold" style={{ color: 'var(--color-text-primary)' }}>
        Observaciones
        <textarea value={observaciones} onChange={(e) => setObservaciones(e.target.value)} readOnly={readOnly} rows={2} maxLength={500} className={`${inputCls} resize-none`} style={roStyle} />
      </label>

      {/* Cálculo total (paridad CEA) */}
      <section aria-label="Cálculo total" aria-live="polite" aria-atomic="true" className="mt-4 rounded-[9px] border p-3" style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
        <div className="flex justify-between border-b border-dashed py-1 text-xs" style={{ borderColor: 'var(--color-border)' }}>
          <span>Impuesto traspaso ({tasa}% del valor de venta)</span><strong>{fmtCOP(valorImpuesto)}</strong>
        </div>
        <div className="flex justify-between border-b border-dashed py-1 text-xs" style={{ borderColor: 'var(--color-border)' }}>
          <span>Derechos del trámite</span><strong>{fmtCOP(derechos)}</strong>
        </div>
        <div className="flex justify-between py-1.5 text-sm font-bold" style={{ color: 'var(--color-action)' }}>
          <span>Total a cobrar</span><span data-testid="comercial-total">{fmtCOP(total)}</span>
        </div>
      </section>

      <p className="mt-4 rounded-[9px] border px-3 py-2 text-xs" style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}>
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
