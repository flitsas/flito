import { useEffect, useState, useCallback, FormEvent } from 'react';
import toast from 'react-hot-toast';
import { api, ApiError, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useEscape } from '../lib/hooks';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import GradientButton from '../components/flit/GradientButton';
import FlitModal from '../components/flit/FlitModal';
import DataTable, { type ColumnaTabla } from '../components/flit/DataTable';
import InlineAlert from '../components/flit/InlineAlert';
import { EtiquetaEstado } from '../components/flit/Bloques';
import { flitInp, FlitField } from '../components/flit/flitPageKit';
import { estadoAlcohol } from '../components/fleet/estados-conductores';

interface AlcoholTest {
  id: number; conductorId: number; conductorName: string | null;
  fechaHora: string; tipo: string; valorMg: string;
  gradoAlcohol: number; resultado: string; accionTomada: string | null;
}
interface Driver { id: number; name: string; }

const MIGA = [{ etiqueta: 'PESV', to: '/pesv' }];

export default function AlcoholTests() {
  const { hasFuncion } = useAuth();
  const isAdmin = hasFuncion('drivers.alcoholimetria.administrar');
  const [items, setItems] = useState<AlcoholTest[]>([]);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    try { const r = await api.get<{ data: AlcoholTest[] }>('/drivers/alcohol-tests'); setItems(r.data); }
    catch (err) { toast.error(errorMessage(err)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const columnas: ColumnaTabla<AlcoholTest>[] = [
    { key: 'fecha', header: 'Fecha', etiqueta: 'Fecha', render: (t) => <span className="text-xs tabular-nums text-[color:var(--color-text-secondary)]">{(t.fechaHora as string).slice(0, 16).replace('T', ' ')}</span> },
    { key: 'conductor', header: 'Conductor', etiqueta: 'Conductor', render: (t) => <span className="font-medium text-[color:var(--color-text-primary)]">{t.conductorName}</span> },
    { key: 'tipo', header: 'Tipo', etiqueta: 'Tipo', render: (t) => <span className="text-xs capitalize text-[color:var(--color-text-secondary)]">{t.tipo.replace('_', ' ')}</span> },
    { key: 'valor', header: 'Valor (mg/L)', etiqueta: 'Valor (mg/L)', render: (t) => <span className="tabular-nums text-[color:var(--color-text-secondary)]">{Number(t.valorMg).toFixed(2)}</span> },
    { key: 'grado', header: 'Grado', etiqueta: 'Grado', render: (t) => <span className="tabular-nums text-[color:var(--color-text-secondary)]">{t.gradoAlcohol}</span> },
    { key: 'resultado', header: 'Resultado', etiqueta: 'Resultado', render: (t) => <EtiquetaEstado estado={estadoAlcohol(t.resultado)}>{t.resultado}</EtiquetaEstado> },
    { key: 'accion', header: 'Acción', etiqueta: 'Acción', render: (t) => <span className="text-xs text-[color:var(--color-text-secondary)]">{t.accionTomada || '—'}</span> },
  ];

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 lg:gap-6">
      <PageHeaderCard
        title="Pruebas de alcoholimetría"
        subtitle="Política cero alcohol. Resultado positivo suspende automáticamente al conductor."
        icono="flito-alcoholimetria"
        miga={MIGA}
        actions={isAdmin ? (
          <GradientButton type="button" onClick={() => setShowCreate(true)}>Registrar prueba</GradientButton>
        ) : undefined}
      />

      <DataTable
        ariaLabel="Pruebas de alcoholimetría"
        columnas={columnas}
        filas={items}
        getKey={(t) => String(t.id)}
        emptyMessage="Sin pruebas registradas"
      />

      {showCreate && <CreateAlcoholModal onClose={() => setShowCreate(false)} onSaved={() => { setShowCreate(false); load(); }} />}
    </div>
  );
}

function CreateAlcoholModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [driversError, setDriversError] = useState<string | null>(null);
  const [conductorId, setConductorId] = useState('');
  type AlcoholTipo = 'preoperacional' | 'aleatoria' | 'post_incidente' | 'periodica';
  const [tipo, setTipo] = useState<AlcoholTipo>('aleatoria');
  const [valorMg, setValorMg] = useState('0.00');
  const [equipoSerial, setEquipoSerial] = useState('');
  const [accionTomada, setAccionTomada] = useState('');
  const [submitting, setSubmitting] = useState(false);
  useEscape(onClose, !submitting);

  useEffect(() => {
    // HU #13421: `/drivers` cuelga del ítem «Conductores»; sin él responde 403. Antes el error se
    // tragaba y el selector quedaba vacío sin explicación: ahora se dice por qué.
    api.get<{ data: Driver[] }>('/drivers').then((r) => setDrivers(r.data))
      .catch((err) => setDriversError(err instanceof ApiError && err.status === 403
        ? 'No tienes acceso a la lista de conductores; pide el permiso de Conductores para registrar la prueba.'
        : 'No se pudo cargar la lista de conductores.'));
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
    <FlitModal title="Registrar prueba de alcoholimetría" onClose={onClose} icono="biometria">
      <form onSubmit={submit} className="space-y-3">
        <FlitField label="Conductor *">
          <select value={conductorId} onChange={(e) => setConductorId(e.target.value)} className={flitInp} disabled={driversError !== null} aria-describedby={driversError ? 'alcohol-conductores-aviso' : undefined}>
            <option value="">— seleccione —</option>
            {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          {driversError && <p id="alcohol-conductores-aviso" role="status" className="mt-1 text-xs text-[color:var(--kit-rojo-texto)]">{driversError}</p>}
        </FlitField>
        <FlitField label="Tipo">
          <select value={tipo} onChange={(e) => setTipo(e.target.value as AlcoholTipo)} className={flitInp}>
            <option value="preoperacional">Preoperacional</option>
            <option value="aleatoria">Aleatoria</option>
            <option value="post_incidente">Post-incidente</option>
            <option value="periodica">Periódica</option>
          </select>
        </FlitField>
        <FlitField label="Valor (mg/L) *">
          <input
            type="number"
            step="0.01"
            min="0"
            max="9.99"
            value={valorMg}
            onChange={(e) => setValorMg(e.target.value)}
            className={seraPositivo ? `${flitInp} !border-[color:var(--kit-rojo)]` : flitInp}
          />
        </FlitField>
        {seraPositivo && (
          <InlineAlert tono="danger">
            <strong>Atención:</strong> cualquier valor &gt; 0 mg/L es POSITIVO según política cero alcohol. El conductor será suspendido automáticamente.
          </InlineAlert>
        )}
        <FlitField label="Equipo (serial)"><input value={equipoSerial} onChange={(e) => setEquipoSerial(e.target.value)} maxLength={60} className={flitInp} /></FlitField>
        <FlitField label="Acción tomada"><textarea value={accionTomada} onChange={(e) => setAccionTomada(e.target.value)} maxLength={2000} rows={2} className={flitInp} /></FlitField>
        <div className="mt-2 flex flex-wrap justify-end gap-2 border-t border-[color:var(--color-border)] pt-4">
          <GradientButton type="button" variant="secondary" onClick={onClose}>Cancelar</GradientButton>
          <GradientButton type="submit" variant={seraPositivo ? 'alerta' : 'primary'} disabled={submitting}>{submitting ? 'Registrando…' : 'Registrar'}</GradientButton>
        </div>
      </form>
    </FlitModal>
  );
}
