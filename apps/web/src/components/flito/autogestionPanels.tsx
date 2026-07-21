// FLITO — Paneles de autogestión reutilizables (§correcciones-UX P2.3b).
// Antes vivían como tabs de la Parametrización; ahora se montan donde vive su entidad:
//  · FlitoCompaniasPanel        → Clientes (/clients): interruptores de autogestión + tolerancia + carpeta.
//  · FlitoOrganismosModalidadPanel → Tránsito (/transito/organismos): modalidad con vigencias + OCR/SLA.
// Consumen los mismos endpoints /flito/parametrizacion/*; la Parametrización conserva Proveedores y Reglas.

import { useEffect, useState } from 'react';
import { MODALIDAD_ORGANISMO_LABEL, ModalidadOrganismo } from '@operaciones/shared-types';
import { api, errorMessage } from '../../lib/api';
import FlitModal from '../flit/FlitModal';
import StatusChip, { type ChipTone } from '../flit/StatusChip';
import {
  FlitCard, FlitTable, FlitTh, FlitTr, FlitField, FlitEmpty,
  flitInp, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../flit/flitPageKit';

export interface Compania {
  id: number; nombre: string; nit: string | null; soatAutogestionable: boolean;
  impuestosAutogestionable: boolean; logisticaAutogestionable: boolean;
  carpetaStorage: string | null; toleranciaValorImpuesto: number;
}
export interface Organismo {
  codigo: string; nombre: string; alias: string | null; activo: boolean;
  modalidadVigente: ModalidadOrganismo; umbralOcr: number | null; slaHoras: number | null;
  diferenciaValorActiva: boolean; tramitesRetenidos: number;
}

const MODALIDAD_TONO: Record<ModalidadOrganismo, ChipTone> = {
  sin_clasificar: 'warning', requiere_gestion: 'active', autogestionado: 'neutral',
};

function useLista<T>(path: string, recarga: number) {
  const [data, setData] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null); setError(null);
    api.get<T[]>(path).then(setData).catch((e) => setError(errorMessage(e)));
  }, [path, recarga]);
  return { data, error };
}

function Interruptor({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

// ───────────────────────────── Compañías (Clientes) ─────────────────────────

export function FlitoCompaniasPanel({ editable }: { editable: boolean }) {
  const [recarga, setRecarga] = useState(0);
  const { data, error } = useLista<Compania>('/flito/parametrizacion/companias', recarga);
  const [editar, setEditar] = useState<Compania | null>(null);

  if (error) return <FlitCard><p className="text-sm text-red-600">{error}</p></FlitCard>;
  if (!data) return <FlitCard><p className="text-sm" style={{ color: 'var(--flit-text-muted)' }}>Cargando…</p></FlitCard>;
  if (data.length === 0) return <FlitCard><FlitEmpty>No hay compañías con parametrización FLITO.</FlitEmpty></FlitCard>;

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

// ─────────────────────── Organismos · modalidad (Tránsito) ───────────────────

export function FlitoOrganismosModalidadPanel({ editable }: { editable: boolean }) {
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
