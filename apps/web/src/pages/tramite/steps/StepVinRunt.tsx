// TRAM-ARCH-01 · Paso 1 — Consulta VIN, pre-vuelo y checklist tipología.

import VehiculoRuntCard from '../VehiculoRuntCard';
import ChecklistTipologia from '../ChecklistTipologia';
import PreflightPanel, { type PreflightSnapshot } from '../PreflightPanel';
import {
  FLIT_CARD, FLIT_PRIMARY, FLIT_STEP_TITLE, FLIT_STEP_TITLE_STYLE,
  FLIT_STEP_SUB, FLIT_STEP_SUB_STYLE, FLIT_INPUT,
} from '../wizard/flitStepKit';

export interface StepVinRuntProps {
  vin: string;
  onVinChange: (vin: string) => void;
  vinLoading: boolean;
  onConsultarVin: () => void;
  vehiculo: Record<string, unknown> | null;
  runtData: Record<string, unknown> | null;
  preflight: PreflightSnapshot | null;
  preflightLoading: boolean;
  onRunPreflight: () => void;
  riesgoAceptado: boolean;
  onToggleRiesgo: (v: boolean) => void;
  tipologiaCodigo: string | null;
  checklistEstado: Record<string, boolean>;
  docTipos: string[];
  onChangeTipologia: (codigo: string) => void;
  onToggleChecklistItem: (itemId: string, checked: boolean) => void;
  readOnlyChecklist: boolean;
  tramiteId: number | null;
  organismoCodigo?: string | null;
  onGuardar: () => void;
  onGoToStep?: (step: number) => void;
  onCtaClick?: (checkKey: string, ctaId: string) => void;
}

export default function StepVinRunt({
  vin, onVinChange, vinLoading, onConsultarVin,
  vehiculo, runtData, preflight, preflightLoading, onRunPreflight,
  riesgoAceptado, onToggleRiesgo,
  tipologiaCodigo, checklistEstado, docTipos,
  onChangeTipologia, onToggleChecklistItem, readOnlyChecklist, tramiteId, organismoCodigo,
  onGuardar, onGoToStep, onCtaClick,
}: StepVinRuntProps) {
  return (
    <div className={FLIT_CARD}>
      <h3 className={FLIT_STEP_TITLE} style={FLIT_STEP_TITLE_STYLE}>Consulta de vehículo</h3>
      <p className={FLIT_STEP_SUB} style={FLIT_STEP_SUB_STYLE}>Ingresa el VIN para consultar los datos del vehículo en el RUNT</p>
      <div className="flex gap-2 mb-5">
        <input
          value={vin}
          onChange={(e) => onVinChange(e.target.value.toUpperCase())}
          placeholder="Numero VIN..."
          className={`flex-1 font-mono ${FLIT_INPUT}`}
        />
        <button
          type="button"
          onClick={onConsultarVin}
          disabled={vinLoading}
          className={`${FLIT_PRIMARY} disabled:opacity-55`}
          style={{ background: 'var(--flit-gradient-primary)' }}
        >
          {vinLoading ? 'Consultando...' : 'Consultar RUNT'}
        </button>
      </div>
      {vehiculo && <VehiculoRuntCard vehiculo={vehiculo as any} runtData={runtData as any} />}
      {vehiculo && (
        <PreflightPanel
          snapshot={preflight}
          loading={preflightLoading}
          onRun={onRunPreflight}
          riesgoAceptado={riesgoAceptado}
          onToggleRiesgo={onToggleRiesgo}
          onGoToStep={onGoToStep}
          onCtaClick={onCtaClick}
        />
      )}
      {vehiculo && (
        <ChecklistTipologia
          tipologiaCodigo={tipologiaCodigo}
          checklistEstado={checklistEstado}
          docTipos={docTipos}
          onChangeTipologia={onChangeTipologia}
          onToggleItem={onToggleChecklistItem}
          readOnly={readOnlyChecklist}
          tramiteId={tramiteId}
          organismoCodigo={organismoCodigo}
        />
      )}
      {vehiculo && (
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onGuardar}
            className={FLIT_PRIMARY}
            style={{ background: 'var(--flit-gradient-primary)' }}
          >
            Guardar y continuar
          </button>
        </div>
      )}
    </div>
  );
}
