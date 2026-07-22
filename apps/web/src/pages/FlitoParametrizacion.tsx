// FLITO — Parametrización (Fase 6). Porta packages/client/src/paginas/parametrizacion/* al kit flit/.
// Compañías (interruptores de autogestión + tolerancia + carpeta), proveedores SOAT, organismos
// (modalidad con vigencias, no sobrescritura destructiva — CA-04) y reglas de proveedor por ámbito.
// Toda escritura es de Operaciones; Auditoría entra en solo lectura.

import { puedeOperar } from '../lib/permissions';
import { useEffect, useState } from 'react';
import {
  AmbitoReglaProveedor, MODALIDAD_ORGANISMO_LABEL, ModalidadOrganismo,
} from '@operaciones/shared-types';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import FlitModal from '../components/flit/FlitModal';
import StatusChip, { type ChipTone } from '../components/flit/StatusChip';
import {
  FlitCard, FlitTable, FlitTh, FlitTr, FlitField, FlitEmpty, FlitPillGroup, FlitPillButton,
  flitInp, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';

interface Compania {
  id: number; nombre: string; nit: string | null; soatAutogestionable: boolean;
  impuestosAutogestionable: boolean; logisticaAutogestionable: boolean;
  carpetaStorage: string | null; toleranciaValorImpuesto: number;
}
interface Proveedor { id: string; nombre: string; estrategia: string | null; umbralOcr: number | null; slaHoras: number | null; activo: boolean }
interface Organismo {
  codigo: string; nombre: string; alias: string | null; activo: boolean;
  modalidadVigente: ModalidadOrganismo; umbralOcr: number | null; slaHoras: number | null;
  diferenciaValorActiva: boolean; tramitesRetenidos: number;
}
interface Regla {
  id: string; ambito: AmbitoReglaProveedor; companiaId: number | null; companiaNombre: string | null;
  organismoCodigo: string | null; organismoNombre: string | null; proveedorSoatId: string; proveedorSoatNombre: string | null; prioridad: number;
}

type Tab = 'companias' | 'proveedores' | 'organismos' | 'reglas';

const MODALIDAD_TONO: Record<ModalidadOrganismo, ChipTone> = {
  sin_clasificar: 'warning', requiere_gestion: 'active', autogestionado: 'neutral',
};

export default function FlitoParametrizacion() {
  const { user } = useAuth();
  const editable = puedeOperar(user?.role);
  const [tab, setTab] = useState<Tab>('companias');

  return (
    <div className="space-y-4">
      <PageHeaderCard title="Parametrización"
        subtitle="Compañías, proveedores SOAT, organismos y reglas de enrutamiento. Los cambios de modalidad conservan vigencias (no sobrescriben)." />
      {!editable && (
        <FlitCard><p className="text-sm text-blue-800">Solo lectura · Auditoría observa la parametrización, no la modifica.</p></FlitCard>
      )}
      <FlitPillGroup>
        <FlitPillButton active={tab === 'companias'} onClick={() => setTab('companias')}>Compañías</FlitPillButton>
        <FlitPillButton active={tab === 'proveedores'} onClick={() => setTab('proveedores')}>Proveedores SOAT</FlitPillButton>
        <FlitPillButton active={tab === 'organismos'} onClick={() => setTab('organismos')}>Organismos</FlitPillButton>
        <FlitPillButton active={tab === 'reglas'} onClick={() => setTab('reglas')}>Reglas SOAT</FlitPillButton>
      </FlitPillGroup>

      {tab === 'companias' && <TabCompanias editable={editable} />}
      {tab === 'proveedores' && <TabProveedores editable={editable} />}
      {tab === 'organismos' && <TabOrganismos editable={editable} />}
      {tab === 'reglas' && <TabReglas editable={editable} />}
    </div>
  );
}

function useLista<T>(path: string, recarga: number) {
  const [data, setData] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null); setError(null);
    api.get<T[]>(path).then(setData).catch((e) => setError(errorMessage(e)));
  }, [path, recarga]);
  return { data, error };
}

// ───────────────────────────── Compañías ────────────────────────────────────

function TabCompanias({ editable }: { editable: boolean }) {
  const [recarga, setRecarga] = useState(0);
  const { data, error } = useLista<Compania>('/flito/parametrizacion/companias', recarga);
  const [editar, setEditar] = useState<Compania | null>(null);

  if (error) return <FlitCard><p className="text-sm text-red-600">{error}</p></FlitCard>;
  if (!data) return <FlitCard><p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando…</p></FlitCard>;
  if (data.length === 0) return <FlitCard><FlitEmpty>No hay compañías.</FlitEmpty></FlitCard>;

  const si = (b: boolean) => <StatusChip tone={b ? 'active' : 'neutral'}>{b ? 'Autogestiona' : 'FLITO'}</StatusChip>;

  return (
    <>
      <FlitCard>
        <FlitTable>
          <thead><FlitTr>
            <FlitTh>Compañía</FlitTh><FlitTh>SOAT</FlitTh><FlitTh>Impuestos</FlitTh><FlitTh>Logística</FlitTh>
            <FlitTh>Tolerancia</FlitTh><FlitTh>Carpeta</FlitTh><FlitTh />
          </FlitTr></thead>
          <tbody>
            {data.map((c) => (
              <FlitTr key={c.id}>
                <td className="px-3 py-2"><div className="font-medium">{c.nombre}</div><div className="text-[11px]" style={{ color: 'var(--flit-text-muted)' }}>{c.nit ?? '—'}</div></td>
                <td className="px-3 py-2">{si(c.soatAutogestionable)}</td>
                <td className="px-3 py-2">{si(c.impuestosAutogestionable)}</td>
                <td className="px-3 py-2">{si(c.logisticaAutogestionable)}</td>
                <td className="px-3 py-2 text-sm tabular-nums">{c.toleranciaValorImpuesto}</td>
                <td className="px-3 py-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>{c.carpetaStorage ?? '—'}</td>
                <td className="px-3 py-2">{editable && <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setEditar(c)}>Editar</button>}</td>
              </FlitTr>
            ))}
          </tbody>
        </FlitTable>
      </FlitCard>
      {editar && <EditarCompania compania={editar} onClose={() => setEditar(null)} onGuardado={() => { setEditar(null); setRecarga((n) => n + 1); }} />}
    </>
  );
}

function EditarCompania({ compania, onClose, onGuardado }: { compania: Compania; onClose: () => void; onGuardado: () => void }) {
  const [soat, setSoat] = useState(compania.soatAutogestionable);
  const [imp, setImp] = useState(compania.impuestosAutogestionable);
  const [log, setLog] = useState(compania.logisticaAutogestionable);
  const [carpeta, setCarpeta] = useState(compania.carpetaStorage ?? '');
  const [tolerancia, setTolerancia] = useState(String(compania.toleranciaValorImpuesto));
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const guardar = async () => {
    setGuardando(true); setError(null);
    try {
      await api.patch(`/flito/parametrizacion/companias/${compania.id}`, {
        soatAutogestionable: soat, impuestosAutogestionable: imp, logisticaAutogestionable: log,
        carpetaStorage: carpeta.trim() || null, toleranciaValorImpuesto: Number(tolerancia) || 0,
      });
      onGuardado();
    } catch (e) { setError(errorMessage(e)); }
    finally { setGuardando(false); }
  };

  return (
    <FlitModal title={compania.nombre} onClose={onClose}>
      <div className="space-y-3">
        <Interruptor label="SOAT autogestionable" checked={soat} onChange={setSoat} />
        <Interruptor label="Impuestos autogestionable" checked={imp} onChange={setImp} />
        <Interruptor label="Logística autogestionable" checked={log} onChange={setLog} />
        <FlitField label="Carpeta de storage"><input className={flitInp} value={carpeta} onChange={(e) => setCarpeta(e.target.value)} /></FlitField>
        <FlitField label="Tolerancia de valor de impuesto"><input className={flitInp} type="number" min="0" value={tolerancia} onChange={(e) => setTolerancia(e.target.value)} /></FlitField>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2">
          <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={guardando} onClick={guardar}>{guardando ? 'Guardando…' : 'Guardar'}</button>
          <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>Cancelar</button>
        </div>
      </div>
    </FlitModal>
  );
}

function Interruptor({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

// ───────────────────────────── Proveedores SOAT ─────────────────────────────

function TabProveedores({ editable }: { editable: boolean }) {
  const [recarga, setRecarga] = useState(0);
  const { data, error } = useLista<Proveedor>('/flito/parametrizacion/proveedores-soat', recarga);
  const [editar, setEditar] = useState<Proveedor | null>(null);
  const [crear, setCrear] = useState(false);
  const refrescar = () => setRecarga((n) => n + 1);

  if (error) return <FlitCard><p className="text-sm text-red-600">{error}</p></FlitCard>;
  if (!data) return <FlitCard><p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando…</p></FlitCard>;

  return (
    <>
      {editable && <div><button className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={() => setCrear(true)}>Nuevo proveedor</button></div>}
      <FlitCard>
        {data.length === 0 ? <FlitEmpty>No hay proveedores SOAT.</FlitEmpty> : (
          <FlitTable>
            <thead><FlitTr><FlitTh>Nombre</FlitTh><FlitTh>Estrategia</FlitTh><FlitTh>Umbral OCR</FlitTh><FlitTh>SLA (h)</FlitTh><FlitTh>Estado</FlitTh><FlitTh /></FlitTr></thead>
            <tbody>
              {data.map((p) => (
                <FlitTr key={p.id}>
                  <td className="px-3 py-2 font-medium">{p.nombre}</td>
                  <td className="px-3 py-2 text-sm">{p.estrategia ?? '—'}</td>
                  <td className="px-3 py-2 text-sm tabular-nums">{p.umbralOcr ?? '—'}</td>
                  <td className="px-3 py-2 text-sm tabular-nums">{p.slaHoras ?? '—'}</td>
                  <td className="px-3 py-2"><StatusChip tone={p.activo ? 'success' : 'neutral'}>{p.activo ? 'Activo' : 'Inactivo'}</StatusChip></td>
                  <td className="px-3 py-2">{editable && <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setEditar(p)}>Editar</button>}</td>
                </FlitTr>
              ))}
            </tbody>
          </FlitTable>
        )}
      </FlitCard>
      {crear && <FormProveedor onClose={() => setCrear(false)} onGuardado={() => { setCrear(false); refrescar(); }} />}
      {editar && <FormProveedor proveedor={editar} onClose={() => setEditar(null)} onGuardado={() => { setEditar(null); refrescar(); }} />}
    </>
  );
}

function FormProveedor({ proveedor, onClose, onGuardado }: { proveedor?: Proveedor; onClose: () => void; onGuardado: () => void }) {
  const [nombre, setNombre] = useState(proveedor?.nombre ?? '');
  const [estrategia, setEstrategia] = useState(proveedor?.estrategia ?? '');
  const [umbral, setUmbral] = useState(proveedor?.umbralOcr != null ? String(proveedor.umbralOcr) : '');
  const [sla, setSla] = useState(proveedor?.slaHoras != null ? String(proveedor.slaHoras) : '');
  const [activo, setActivo] = useState(proveedor?.activo ?? true);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const guardar = async () => {
    setGuardando(true); setError(null);
    const body: Record<string, unknown> = {
      nombre: nombre.trim(),
      estrategia: estrategia.trim() || undefined,
      umbralOcr: umbral.trim() === '' ? null : Number(umbral),
      slaHoras: sla.trim() === '' ? null : Number(sla),
    };
    try {
      if (proveedor) { body.activo = activo; await api.patch(`/flito/parametrizacion/proveedores-soat/${proveedor.id}`, body); }
      else await api.post('/flito/parametrizacion/proveedores-soat', body);
      onGuardado();
    } catch (e) { setError(errorMessage(e)); }
    finally { setGuardando(false); }
  };

  return (
    <FlitModal title={proveedor ? 'Editar proveedor' : 'Nuevo proveedor SOAT'} onClose={onClose}>
      <div className="space-y-3">
        <FlitField label="Nombre *"><input className={flitInp} value={nombre} onChange={(e) => setNombre(e.target.value)} /></FlitField>
        <FlitField label="Estrategia"><input className={flitInp} value={estrategia} onChange={(e) => setEstrategia(e.target.value)} placeholder="p.ej. portal, correo" /></FlitField>
        <FlitField label="Umbral OCR (0–1)"><input className={flitInp} type="number" step="0.01" min="0" max="1" value={umbral} onChange={(e) => setUmbral(e.target.value)} /></FlitField>
        <FlitField label="SLA en horas"><input className={flitInp} type="number" min="1" value={sla} onChange={(e) => setSla(e.target.value)} /></FlitField>
        {proveedor && <Interruptor label="Activo" checked={activo} onChange={setActivo} />}
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2">
          <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={guardando || !nombre.trim()} onClick={guardar}>{guardando ? 'Guardando…' : 'Guardar'}</button>
          <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>Cancelar</button>
        </div>
      </div>
    </FlitModal>
  );
}

// ───────────────────────────── Organismos ───────────────────────────────────

function TabOrganismos({ editable }: { editable: boolean }) {
  const [recarga, setRecarga] = useState(0);
  const { data, error } = useLista<Organismo>('/flito/parametrizacion/organismos', recarga);
  const [modalidad, setModalidad] = useState<Organismo | null>(null);
  const refrescar = () => setRecarga((n) => n + 1);

  if (error) return <FlitCard><p className="text-sm text-red-600">{error}</p></FlitCard>;
  if (!data) return <FlitCard><p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando…</p></FlitCard>;
  if (data.length === 0) return <FlitCard><FlitEmpty>No hay organismos.</FlitEmpty></FlitCard>;

  return (
    <>
      <FlitCard>
        <FlitTable>
          <thead><FlitTr><FlitTh>Organismo</FlitTh><FlitTh>Modalidad</FlitTh><FlitTh>Retenidos</FlitTh><FlitTh>Umbral OCR</FlitTh><FlitTh>SLA (h)</FlitTh><FlitTh /></FlitTr></thead>
          <tbody>
            {data.map((o) => (
              <FlitTr key={o.codigo}>
                <td className="px-3 py-2"><div className="font-medium">{o.nombre}</div><div className="text-[11px] tabular-nums" style={{ color: 'var(--flit-text-muted)' }}>{o.codigo}</div></td>
                <td className="px-3 py-2">
                  <div className="flex flex-col items-start gap-1">
                    <StatusChip tone={MODALIDAD_TONO[o.modalidadVigente]}>{MODALIDAD_ORGANISMO_LABEL[o.modalidadVigente]}</StatusChip>
                    {o.diferenciaValorActiva && <StatusChip tone="warning">Dif. valor activa</StatusChip>}
                  </div>
                </td>
                <td className="px-3 py-2 text-sm tabular-nums">{o.tramitesRetenidos > 0 ? <StatusChip tone="warning">{o.tramitesRetenidos}</StatusChip> : '0'}</td>
                <td className="px-3 py-2 text-sm tabular-nums">{o.umbralOcr ?? '—'}</td>
                <td className="px-3 py-2 text-sm tabular-nums">{o.slaHoras ?? '—'}</td>
                <td className="px-3 py-2">{editable && <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => setModalidad(o)}>Gestionar</button>}</td>
              </FlitTr>
            ))}
          </tbody>
        </FlitTable>
      </FlitCard>
      {modalidad && <GestionOrganismo organismo={modalidad} onClose={() => setModalidad(null)} onCambio={() => { setModalidad(null); refrescar(); }} />}
    </>
  );
}

interface Vigencia { id: string; modalidad: ModalidadOrganismo; desde: string; hasta: string | null; motivo: string | null; actorNombre: string | null; creadoEn: string }

function GestionOrganismo({ organismo, onClose, onCambio }: { organismo: Organismo; onClose: () => void; onCambio: () => void }) {
  const [modalidad, setModalidad] = useState<ModalidadOrganismo>(organismo.modalidadVigente);
  const [motivo, setMotivo] = useState('');
  const [umbral, setUmbral] = useState(organismo.umbralOcr != null ? String(organismo.umbralOcr) : '');
  const [sla, setSla] = useState(organismo.slaHoras != null ? String(organismo.slaHoras) : '');
  const [diferencia, setDiferencia] = useState(organismo.diferenciaValorActiva);
  const [vigencias, setVigencias] = useState<Vigencia[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    api.get<Vigencia[]>(`/flito/parametrizacion/organismos/${organismo.codigo}/vigencias`).then(setVigencias).catch(() => setVigencias([]));
  }, [organismo.codigo]);

  const cambiarModalidad = async () => {
    setGuardando(true); setError(null);
    try { await api.post(`/flito/parametrizacion/organismos/${organismo.codigo}/modalidad`, { modalidad, motivo }); onCambio(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setGuardando(false); }
  };
  const guardarParams = async () => {
    setGuardando(true); setError(null);
    try {
      await api.patch(`/flito/parametrizacion/organismos/${organismo.codigo}`, {
        umbralOcr: umbral.trim() === '' ? null : Number(umbral), slaHoras: sla.trim() === '' ? null : Number(sla),
        diferenciaValorActiva: diferencia,
      });
      onCambio();
    } catch (e) { setError(errorMessage(e)); }
    finally { setGuardando(false); }
  };

  return (
    <FlitModal title={`${organismo.nombre} (${organismo.codigo})`} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="space-y-2">
          <p className="text-sm font-semibold" style={{ color: 'var(--flit-blue-text)' }}>Modalidad de gestión</p>
          <FlitField label="Modalidad">
            <select className={flitInp} value={modalidad} onChange={(e) => setModalidad(e.target.value as ModalidadOrganismo)}>
              {(Object.keys(MODALIDAD_ORGANISMO_LABEL) as ModalidadOrganismo[]).map((m) => (
                <option key={m} value={m}>{MODALIDAD_ORGANISMO_LABEL[m]}</option>
              ))}
            </select>
          </FlitField>
          <FlitField label="Motivo del cambio (mín. 5 caracteres)">
            <textarea className={`${flitInp} min-h-[56px]`} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
          </FlitField>
          <button className={flitBtnPrimary} style={flitBtnPrimaryStyle}
            disabled={guardando || modalidad === organismo.modalidadVigente || motivo.trim().length < 5} onClick={cambiarModalidad}>
            Cambiar modalidad
          </button>
        </div>

        <div className="space-y-2 border-t pt-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <p className="text-sm font-semibold" style={{ color: 'var(--flit-blue-text)' }}>Parámetros de OCR / SLA</p>
          <div className="grid grid-cols-2 gap-3">
            <FlitField label="Umbral OCR (0–1)"><input className={flitInp} type="number" step="0.01" min="0" max="1" value={umbral} onChange={(e) => setUmbral(e.target.value)} /></FlitField>
            <FlitField label="SLA en horas"><input className={flitInp} type="number" min="1" value={sla} onChange={(e) => setSla(e.target.value)} /></FlitField>
          </div>
          <Interruptor label="Marcar diferencia de valor de impuestos (D-5)" checked={diferencia} onChange={setDiferencia} />
          <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
            Al conciliar el recibo, si el valor pagado difiere del liquidado más allá de la tolerancia de la compañía, se marca para revisión (no bloquea el pago). Actívalo solo donde el valor liquidado sea de fuente fiable.
          </p>
          <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={guardando} onClick={guardarParams}>Guardar parámetros</button>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="border-t pt-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <p className="mb-1 text-sm font-semibold" style={{ color: 'var(--flit-blue-text)' }}>Historial de vigencias</p>
          {vigencias.length === 0 ? <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Sin vigencias registradas.</p> : (
            <ul className="space-y-1 text-xs">
              {vigencias.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center gap-2">
                  <StatusChip tone={MODALIDAD_TONO[v.modalidad]}>{MODALIDAD_ORGANISMO_LABEL[v.modalidad]}</StatusChip>
                  <span style={{ color: 'var(--flit-text-muted)' }}>
                    {new Date(v.desde).toLocaleDateString('es-CO')} → {v.hasta ? new Date(v.hasta).toLocaleDateString('es-CO') : 'vigente'}
                    {v.actorNombre ? ` · ${v.actorNombre}` : ''}{v.motivo ? ` · ${v.motivo}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </FlitModal>
  );
}

// ───────────────────────────── Reglas ───────────────────────────────────────

function TabReglas({ editable }: { editable: boolean }) {
  const [recarga, setRecarga] = useState(0);
  const { data, error } = useLista<Regla>('/flito/parametrizacion/reglas-proveedor-soat', recarga);
  const [crear, setCrear] = useState(false);
  const refrescar = () => setRecarga((n) => n + 1);

  const eliminar = async (id: string) => {
    try { await api.delete(`/flito/parametrizacion/reglas-proveedor-soat/${id}`); refrescar(); }
    catch { /* el listado se recarga; el error ya se refleja al no cambiar */ }
  };

  if (error) return <FlitCard><p className="text-sm text-red-600">{error}</p></FlitCard>;
  if (!data) return <FlitCard><p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando…</p></FlitCard>;

  return (
    <>
      {editable && <div><button className={flitBtnPrimary} style={flitBtnPrimaryStyle} onClick={() => setCrear(true)}>Nueva regla</button></div>}
      <FlitCard>
        {data.length === 0 ? <FlitEmpty>No hay reglas. El enrutamiento usa la global si existe.</FlitEmpty> : (
          <FlitTable>
            <thead><FlitTr><FlitTh>Ámbito</FlitTh><FlitTh>Aplica a</FlitTh><FlitTh>Proveedor</FlitTh><FlitTh>Prioridad</FlitTh><FlitTh /></FlitTr></thead>
            <tbody>
              {data.map((r) => (
                <FlitTr key={r.id}>
                  <td className="px-3 py-2"><StatusChip tone="active">{r.ambito}</StatusChip></td>
                  <td className="px-3 py-2 text-sm">{r.companiaNombre ?? r.organismoNombre ?? r.organismoCodigo ?? 'Todos (global)'}</td>
                  <td className="px-3 py-2 text-sm">{r.proveedorSoatNombre ?? '—'}</td>
                  <td className="px-3 py-2 text-sm tabular-nums">{r.prioridad}</td>
                  <td className="px-3 py-2">{editable && <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={() => eliminar(r.id)}>Eliminar</button>}</td>
                </FlitTr>
              ))}
            </tbody>
          </FlitTable>
        )}
      </FlitCard>
      {crear && <FormRegla onClose={() => setCrear(false)} onGuardado={() => { setCrear(false); refrescar(); }} />}
    </>
  );
}

function FormRegla({ onClose, onGuardado }: { onClose: () => void; onGuardado: () => void }) {
  const [ambito, setAmbito] = useState<AmbitoReglaProveedor>(AmbitoReglaProveedor.GLOBAL);
  const [companiaId, setCompaniaId] = useState('');
  const [organismoCodigo, setOrganismoCodigo] = useState('');
  const [proveedorSoatId, setProveedorSoatId] = useState('');
  const [companias, setCompanias] = useState<Compania[]>([]);
  const [organismos, setOrganismos] = useState<Organismo[]>([]);
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    api.get<Compania[]>('/flito/parametrizacion/companias').then(setCompanias).catch(() => setCompanias([]));
    api.get<Organismo[]>('/flito/parametrizacion/organismos').then(setOrganismos).catch(() => setOrganismos([]));
    api.get<Proveedor[]>('/flito/parametrizacion/proveedores-soat').then(setProveedores).catch(() => setProveedores([]));
  }, []);

  const guardar = async () => {
    setGuardando(true); setError(null);
    const body: Record<string, unknown> = { ambito, proveedorSoatId };
    if (ambito === AmbitoReglaProveedor.COMPANIA) body.companiaId = Number(companiaId);
    if (ambito === AmbitoReglaProveedor.ORGANISMO) body.organismoCodigo = organismoCodigo;
    try { await api.post('/flito/parametrizacion/reglas-proveedor-soat', body); onGuardado(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setGuardando(false); }
  };

  const faltaAmbito = (ambito === AmbitoReglaProveedor.COMPANIA && !companiaId) || (ambito === AmbitoReglaProveedor.ORGANISMO && !organismoCodigo);

  return (
    <FlitModal title="Nueva regla de proveedor" onClose={onClose}>
      <div className="space-y-3">
        <FlitField label="Ámbito">
          <select className={flitInp} value={ambito} onChange={(e) => setAmbito(e.target.value as AmbitoReglaProveedor)}>
            <option value={AmbitoReglaProveedor.GLOBAL}>Global (una sola)</option>
            <option value={AmbitoReglaProveedor.ORGANISMO}>Por organismo</option>
            <option value={AmbitoReglaProveedor.COMPANIA}>Por compañía</option>
          </select>
        </FlitField>
        {ambito === AmbitoReglaProveedor.COMPANIA && (
          <FlitField label="Compañía">
            <select className={flitInp} value={companiaId} onChange={(e) => setCompaniaId(e.target.value)}>
              <option value="">Selecciona…</option>
              {companias.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
            </select>
          </FlitField>
        )}
        {ambito === AmbitoReglaProveedor.ORGANISMO && (
          <FlitField label="Organismo">
            <select className={flitInp} value={organismoCodigo} onChange={(e) => setOrganismoCodigo(e.target.value)}>
              <option value="">Selecciona…</option>
              {organismos.map((o) => <option key={o.codigo} value={o.codigo}>{o.nombre}</option>)}
            </select>
          </FlitField>
        )}
        <FlitField label="Proveedor SOAT">
          <select className={flitInp} value={proveedorSoatId} onChange={(e) => setProveedorSoatId(e.target.value)}>
            <option value="">Selecciona…</option>
            {proveedores.filter((p) => p.activo).map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
          </select>
        </FlitField>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2">
          <button className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled={guardando || !proveedorSoatId || faltaAmbito} onClick={guardar}>{guardando ? 'Guardando…' : 'Crear'}</button>
          <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onClose}>Cancelar</button>
        </div>
      </div>
    </FlitModal>
  );
}
