// FLITO — Modalidad de organismo (secretaría) reutilizable. Se monta dentro de Tránsito →
// Organismos (/transito/organismos) como columna + modal «Gestionar»; la autogestión de compañías
// vive inline en Clientes. Consume /flito/parametrizacion/organismos/*.

import { useEffect, useState } from 'react';
import { MODALIDAD_ORGANISMO_LABEL, ModalidadOrganismo } from '@operaciones/shared-types';
import { api, errorMessage } from '../../lib/api';
import FlitModal from '../flit/FlitModal';
import StatusChip, { type ChipTone } from '../flit/StatusChip';
import {
  FlitField, flitInp, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../flit/flitPageKit';

export interface Organismo {
  codigo: string; nombre: string; alias: string | null; activo: boolean;
  modalidadVigente: ModalidadOrganismo; umbralOcr: number | null; slaHoras: number | null;
  diferenciaValorActiva: boolean; tramitesRetenidos: number;
}

export const MODALIDAD_TONO: Record<ModalidadOrganismo, ChipTone> = {
  requiere_gestion: 'active', autogestionado: 'neutral',
};

function Interruptor({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

interface Vigencia { id: string; modalidad: ModalidadOrganismo; desde: string; hasta: string | null; motivo: string | null; actorNombre: string | null; creadoEn: string }

// Modal de gestión de modalidad de un organismo: cambio de modalidad (con motivo y vigencias),
// parámetros OCR/SLA y marca de diferencia de valor (D-5).
export function GestionOrganismo({ organismo, editable, onClose, onCambio }: {
  organismo: Organismo; editable: boolean; onClose: () => void; onCambio: () => void;
}) {
  return (
    <FlitModal title={`${organismo.nombre} (${organismo.codigo})`} onClose={onClose} wide>
      <PanelGestionOrganismo organismo={organismo} editable={editable} onCambio={onCambio} />
    </FlitModal>
  );
}

// Panel reutilizable (sin envoltura de modal) de modalidad + OCR/SLA + vigencias de un organismo.
// Se embebe en la acción "Editar" del organismo (fusiona el antiguo botón "Gestionar").
export function PanelGestionOrganismo({ organismo, editable, onCambio }: {
  organismo: Organismo; editable: boolean; onCambio: () => void;
}) {
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
      <div className="space-y-4">
        {!editable && <p className="text-sm text-blue-800">Solo lectura · Auditoría observa la modalidad, no la modifica.</p>}
        <div className="space-y-2">
          <p className="text-sm font-semibold" style={{ color: 'var(--flit-blue-text)' }}>Modalidad de gestión</p>
          <FlitField label="Modalidad">
            <select className={flitInp} value={modalidad} disabled={!editable} onChange={(e) => setModalidad(e.target.value as ModalidadOrganismo)}>
              {(Object.keys(MODALIDAD_ORGANISMO_LABEL) as ModalidadOrganismo[]).map((m) => (
                <option key={m} value={m}>{MODALIDAD_ORGANISMO_LABEL[m]}</option>
              ))}
            </select>
          </FlitField>
          <FlitField label="Motivo del cambio (mín. 5 caracteres)">
            <textarea className={`${flitInp} min-h-[56px]`} value={motivo} disabled={!editable} onChange={(e) => setMotivo(e.target.value)} />
          </FlitField>
          {editable && (
            <button className={flitBtnPrimary} style={flitBtnPrimaryStyle}
              disabled={guardando || modalidad === organismo.modalidadVigente || motivo.trim().length < 5} onClick={cambiarModalidad}>
              Cambiar modalidad
            </button>
          )}
        </div>

        <div className="space-y-2 border-t pt-3" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <p className="text-sm font-semibold" style={{ color: 'var(--flit-blue-text)' }}>Parámetros de OCR / SLA</p>
          <div className="grid grid-cols-2 gap-3">
            <FlitField label="Umbral OCR (0–1)"><input className={flitInp} type="number" step="0.01" min="0" max="1" value={umbral} disabled={!editable} onChange={(e) => setUmbral(e.target.value)} /></FlitField>
            <FlitField label="SLA en horas"><input className={flitInp} type="number" min="1" value={sla} disabled={!editable} onChange={(e) => setSla(e.target.value)} /></FlitField>
          </div>
          <Interruptor label="Marcar diferencia de valor de impuestos (D-5)" checked={diferencia} onChange={editable ? setDiferencia : () => {}} />
          <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
            Al conciliar el recibo, si el valor pagado difiere del liquidado más allá de la tolerancia de la compañía, se marca para revisión (no bloquea el pago). Actívalo solo donde el valor liquidado sea de fuente fiable.
          </p>
          {editable && <button className={flitBtnSecondary} style={flitBtnSecondaryStyle} disabled={guardando} onClick={guardarParams}>Guardar parámetros</button>}
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
  );
}
