import { useEffect, useState, useCallback, FormEvent, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useEscape } from '../lib/hooks';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import FlitModal from '../components/flit/FlitModal';

interface AlcoholTest {
  id: number; conductorId: number; conductorName: string | null;
  fechaHora: string; tipo: string; valorMg: string;
  gradoAlcohol: number; resultado: string; accionTomada: string | null;
}
interface Driver { id: number; name: string; }

const inputCls = 'flit-focus w-full rounded-[10px] border border-[color:var(--flit-border-input)] bg-white px-4 py-2.5 text-sm text-[color:var(--flit-text-primary)] placeholder:text-[color:var(--flit-text-muted)] outline-none transition-shadow';
const CARD = { borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' } as const;

export default function AlcoholTests() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [items, setItems] = useState<AlcoholTest[]>([]);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    try { const r = await api.get<{ data: AlcoholTest[] }>('/drivers/alcohol-tests'); setItems(r.data); }
    catch (err) { toast.error(errorMessage(err)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Pruebas de alcoholimetría"
        subtitle="Política cero alcohol. Resultado positivo suspende automáticamente al conductor."
        actions={isAdmin ? (
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="flit-focus inline-flex items-center justify-center gap-2 rounded-[999px] px-6 text-sm font-semibold text-white transition-transform motion-safe:active:scale-[0.99]"
            style={{ height: '44px', background: 'var(--flit-gradient-danger)', boxShadow: 'var(--flit-shadow-button)' }}
          >
            Registrar prueba
          </button>
        ) : undefined}
      />

      <div className="overflow-hidden bg-white" style={CARD}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr>
              <Th>Fecha</Th><Th>Conductor</Th><Th>Tipo</Th><Th>Valor (mg/L)</Th><Th>Grado</Th><Th>Resultado</Th><Th>Acción</Th>
            </tr></thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={7} className="py-10 text-center text-sm" style={{ color: 'var(--flit-text-muted)' }}>Sin pruebas registradas</td></tr>}
              {items.map((t) => (
                <tr key={t.id} className="border-t transition-colors hover:bg-[color:var(--flit-bg-app)]" style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{(t.fechaHora as string).slice(0, 16).replace('T', ' ')}</td>
                  <td className="px-4 py-3 font-medium" style={{ color: 'var(--flit-text-primary)' }}>{t.conductorName}</td>
                  <td className="px-4 py-3 text-xs capitalize" style={{ color: 'var(--flit-text-secondary)' }}>{t.tipo.replace('_', ' ')}</td>
                  <td className="px-4 py-3 tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>{Number(t.valorMg).toFixed(2)}</td>
                  <td className="px-4 py-3 tabular-nums" style={{ color: 'var(--flit-text-secondary)' }}>{t.gradoAlcohol}</td>
                  <td className="px-4 py-3"><ResultadoPill r={t.resultado} /></td>
                  <td className="px-4 py-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{t.accionTomada || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showCreate && <CreateAlcoholModal onClose={() => setShowCreate(false)} onSaved={() => { setShowCreate(false); load(); }} />}
    </div>
  );
}

function Th({ children }: { children?: ReactNode }) {
  return <th scope="col" className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide" style={{ background: 'var(--flit-bg-table-header)', color: 'var(--flit-text-secondary)' }}>{children}</th>;
}

function ResultadoPill({ r }: { r: string }) {
  const tone: Record<string, ChipTone> = { negativo: 'success', positivo: 'danger', inconcluso: 'warning' };
  return <StatusChip tone={tone[r] ?? 'neutral'}>{r}</StatusChip>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="mb-1.5 block text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{label}</span>{children}</label>;
}

function CreateAlcoholModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [conductorId, setConductorId] = useState('');
  type AlcoholTipo = 'preoperacional' | 'aleatoria' | 'post_incidente' | 'periodica';
  const [tipo, setTipo] = useState<AlcoholTipo>('aleatoria');
  const [valorMg, setValorMg] = useState('0.00');
  const [equipoSerial, setEquipoSerial] = useState('');
  const [accionTomada, setAccionTomada] = useState('');
  const [submitting, setSubmitting] = useState(false);
  useEscape(onClose, !submitting);

  useEffect(() => {
    api.get<{ data: Driver[] }>('/drivers').then((r) => setDrivers(r.data)).catch(() => {});
  }, []);

  const valor = parseFloat(valorMg);
  const seraPositivo = Number.isFinite(valor) && valor > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!conductorId) { toast.error('Seleccione conductor'); return; }
    if (!Number.isFinite(valor) || valor < 0 || valor >= 10) { toast.error('Valor inválido'); return; }
    if (seraPositivo && !confirm('Valor > 0 mg/L → el conductor será SUSPENDIDO automáticamente. ¿Confirmar?')) return;

    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        conductorId: parseInt(conductorId, 10),
        tipo,
        valorMg: valor,
      };
      if (equipoSerial.trim()) body.equipoSerial = equipoSerial.trim();
      if (accionTomada.trim()) body.accionTomada = accionTomada.trim();
      const r = await api.post<{ suspendido: boolean }>('/drivers/alcohol-tests', body);
      if (r.suspendido) toast.error('Conductor SUSPENDIDO por alcoholimetría positiva');
      else toast.success('Prueba negativa registrada');
      onSaved();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setSubmitting(false); }
  };

  return (
    <FlitModal title="Registrar prueba de alcoholimetría" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Conductor *">
          <select value={conductorId} onChange={(e) => setConductorId(e.target.value)} className={inputCls}>
            <option value="">— seleccione —</option>
            {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
        <Field label="Tipo">
          <select value={tipo} onChange={(e) => setTipo(e.target.value as AlcoholTipo)} className={inputCls}>
            <option value="preoperacional">Preoperacional</option>
            <option value="aleatoria">Aleatoria</option>
            <option value="post_incidente">Post-incidente</option>
            <option value="periodica">Periódica</option>
          </select>
        </Field>
        <Field label="Valor (mg/L) *">
          <input
            type="number"
            step="0.01"
            min="0"
            max="9.99"
            value={valorMg}
            onChange={(e) => setValorMg(e.target.value)}
            className={inputCls}
            style={seraPositivo ? { borderColor: 'var(--flit-danger)', background: 'rgba(228,61,48,0.08)' } : undefined}
          />
        </Field>
        {seraPositivo && (
          <div className="rounded-[12px] p-3 text-xs" style={{ background: 'rgba(228,61,48,0.10)', border: '1px solid rgba(228,61,48,0.30)', color: 'var(--flit-danger)' }}>
            <strong>Atención:</strong> cualquier valor &gt; 0 mg/L es POSITIVO según política cero alcohol. El conductor será suspendido automáticamente.
          </div>
        )}
        <Field label="Equipo (serial)"><input value={equipoSerial} onChange={(e) => setEquipoSerial(e.target.value)} maxLength={60} className={inputCls} /></Field>
        <Field label="Acción tomada"><textarea value={accionTomada} onChange={(e) => setAccionTomada(e.target.value)} maxLength={2000} rows={2} className={inputCls} /></Field>
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="flit-focus inline-flex h-11 items-center rounded-[999px] border bg-white px-5 text-sm font-medium" style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>Cancelar</button>
          {seraPositivo ? (
            <button
              type="submit"
              disabled={submitting}
              className="flit-focus inline-flex items-center justify-center gap-2 rounded-[999px] px-6 text-sm font-semibold text-white transition-transform motion-safe:active:scale-[0.99] disabled:opacity-55"
              style={{ height: '44px', background: 'var(--flit-gradient-danger)', boxShadow: 'var(--flit-shadow-button)' }}
            >
              {submitting ? 'Registrando…' : 'Registrar'}
            </button>
          ) : (
            <GradientButton type="submit" disabled={submitting}>{submitting ? 'Registrando…' : 'Registrar'}</GradientButton>
          )}
        </div>
      </form>
    </FlitModal>
  );
}
