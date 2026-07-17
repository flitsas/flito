// TRAM-ARCH-01d — shell del wizard: layout FLIT (sidebar de pasos) + outlet de
// los 5 pasos + overlay de captura de cédula. Es presentacional: toda la lógica
// vive en useTramiteWizard; aquí solo se cablean los pasos al estado del hook.

import { getAdquirente, vendedorRequerido } from '@operaciones/shared-types';
import { STEPS } from '../../constants/tramite';
import FlitModal from '../../components/flit/FlitModal';
import GradientButton from '../../components/flit/GradientButton';
import FlitWizardSidebar from '../../components/flit/FlitWizardSidebar';
import CedulaCaptureOverlay from '../../components/identidad/CedulaCaptureOverlay';
import { FLIT_CARD } from './wizard/flitStepKit';
import StepVinRunt from './steps/StepVinRunt';
import StepDocumentos from './steps/StepDocumentos';
import StepComprador from './steps/StepComprador';
import StepIdentidad from './steps/StepIdentidad';
import StepExpediente from './steps/StepExpediente';
import type { TramiteWizardApi } from './useTramiteWizard';

export default function TramiteWizardShell({ w }: { w: TramiteWizardApi }) {
  const { step } = w;
  return (
    <div className="flex flex-col gap-5 lg:flex-row lg:gap-6">
      {/* Sidebar lateral de pasos (FlitWizardSidebar) */}
      <aside className="shrink-0 lg:w-60">
        {/* Offset sticky = topbar + FlitNavBar + 1rem de margen (antes top-20 = 64px + 16px). */}
        <div className={`${FLIT_CARD} lg:sticky lg:top-[calc(var(--flit-topbar-height)_+_var(--flit-navbar-height)_+_1rem)]`}>
          <button onClick={w.closeWizard} aria-label="Volver a la lista" className="flit-focus mb-4 inline-flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--flit-text-secondary)' }}>
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}><path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" /></svg>
            Volver
          </button>
          <FlitWizardSidebar steps={STEPS} current={step} />
        </div>
      </aside>

      {/* Contenido del paso actual */}
      <div className="min-w-0 flex-1">
        {step === 1 && (
          <StepVinRunt
            vin={w.vin}
            onVinChange={w.setVin}
            vinLoading={w.vinLoading}
            onConsultarVin={w.consultarVin}
            vehiculo={w.vehiculo}
            runtData={w.runtData}
            preflight={w.preflight}
            preflightLoading={w.preflightLoading}
            onRunPreflight={() => w.ejecutarPreflight()}
            riesgoAceptado={w.riesgoAceptado}
            onToggleRiesgo={w.setRiesgoAceptado}
            tipologiaCodigo={w.tipologiaCodigo}
            checklistEstado={w.checklistEstado}
            docTipos={w.archivos.map((a) => a.tipo)}
            onChangeTipologia={w.cambiarTipologia}
            onToggleChecklistItem={w.toggleChecklistItem}
            readOnlyChecklist={!['borrador', 'aprobado'].includes(w.estadoTramite)}
            tramiteId={w.tramiteId}
            organismoCodigo={w.orgTransito?.codigo || null}
            onGuardar={w.guardarPaso1}
            onGoToStep={w.irAPaso}
            onCtaClick={w.registrarPreflightCta}
          />
        )}

        {step === 2 && (
          <StepDocumentos
            archivos={w.archivos}
            uploading={w.uploading}
            ocrResults={w.ocrResults}
            onSubirDoc={w.subirDoc}
            onAtras={() => w.setStep(1)}
            onContinuar={w.guardarPaso2}
          />
        )}

        {step === 3 && (
          <StepComprador
            comprador={w.comprador}
            setComprador={w.setComprador}
            onConsultarComprador={w.consultarComprador}
            compradorLoading={w.compradorLoading}
            onLeerCedula={w.leerCedula}
            cedulaOverlayOpen={w.cedulaOverlayOpen}
            compradorRunt={w.compradorRunt}
            showCiudades={w.showCiudades}
            setShowCiudades={w.setShowCiudades}
            setCiudadFilter={w.setCiudadFilter}
            filteredCiudades={w.filteredCiudades}
            onAtras={() => w.setStep(2)}
            onGuardar={w.guardarPaso3}
            adquirenteLabel={getAdquirente(w.tipologiaCodigo).label}
            tipologiaCodigo={w.tipologiaCodigo}
            vendedorRequerido={vendedorRequerido(w.tipologiaCodigo)}
            vendedor={w.vendedor}
            setVendedor={w.setVendedor}
            onConsultarVendedor={w.consultarVendedor}
            vendedorLoading={w.vendedorLoading}
            vendedorRunt={w.vendedorRunt}
          />
        )}

        {step === 4 && (
          <StepIdentidad
            comprador={w.comprador}
            enlaceManual={w.enlaceManual}
            emailSent={w.emailSent}
            validationStatus={w.validationStatus}
            onEnviarEmail={w.enviarEmailValidacion}
            emailSending={w.emailSending}
            tramiteId={w.tramiteId}
            onReenviar={w.reenviarValidacion}
            onAtras={() => { w.stopPolling(); w.setStep(3); }}
            onContinuar={() => { w.stopPolling(); w.setStep(5); }}
          />
        )}

        {step === 5 && w.tramiteId && (
          <StepExpediente
            tramiteId={w.tramiteId}
            vehiculo={w.vehiculo}
            comprador={w.comprador}
            vin={w.vin}
            archivos={w.archivos}
            ocrResults={w.ocrResults}
            validationStatus={w.validationStatus}
            emailSent={w.emailSent}
            estadoTramite={w.estadoTramite}
            tipologiaCodigo={w.tipologiaCodigo}
            checklistEstado={w.checklistEstado}
            orgTransito={w.orgTransito}
            setOrgTransito={w.setOrgTransito}
            showOrgModal={w.showOrgModal}
            setShowOrgModal={w.setShowOrgModal}
            onConfirmarOrg={w.confirmarOrg}
            setStep={w.setStep}
            setOcrResults={w.setOcrResults}
            onClose={w.closeWizard}
            onGuardarBorrador={w.guardarBorrador}
            onEnviarTransito={w.enviarATransito}
          />
        )}
      </div>

      <CedulaCaptureOverlay
        open={w.cedulaOverlayOpen}
        onClose={() => w.setCedulaOverlayOpen(false)}
        onCaptured={w.handleCedulaCaptured}
      />

      {w.duplicateConflict && (
        <FlitModal
          title={w.duplicateConflict.code === 'TRAMITE_MATRICULA_COMPLETADA'
            ? 'Matrícula ya registrada'
            : 'Trámite ya existe'}
          onClose={w.cerrarConflictoDuplicado}
        >
          <div className="space-y-4 px-6 py-5">
            <p className="text-sm leading-relaxed" style={{ color: 'var(--flit-text-secondary)' }}>
              {w.duplicateConflict.message}
            </p>
            <dl className="grid grid-cols-2 gap-3 rounded-xl border px-4 py-3 text-sm" style={{ borderColor: 'var(--flit-border-soft)' }}>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Placa</dt>
                <dd className="font-semibold" style={{ color: 'var(--flit-blue-text)' }}>
                  {w.duplicateConflict.existingTramite.placa || '—'}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Estado</dt>
                <dd className="font-semibold capitalize" style={{ color: 'var(--flit-blue-text)' }}>
                  {w.duplicateConflict.existingTramite.estado.replace(/_/g, ' ')}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>Paso</dt>
                <dd className="font-semibold" style={{ color: 'var(--flit-blue-text)' }}>
                  {w.duplicateConflict.existingTramite.paso}/5
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>ID trámite</dt>
                <dd className="font-semibold" style={{ color: 'var(--flit-blue-text)' }}>
                  #{w.duplicateConflict.existingTramite.id}
                </dd>
              </div>
            </dl>
            <div className="flex flex-wrap justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={w.cerrarConflictoDuplicado}
                className="flit-focus inline-flex h-10 items-center rounded-[999px] border px-4 text-sm font-medium"
                style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}
              >
                Cerrar
              </button>
              {w.duplicateConflict.code === 'TRAMITE_DUPLICADO' && (
                <GradientButton type="button" onClick={w.abrirTramiteExistente}>
                  Abrir trámite existente
                </GradientButton>
              )}
            </div>
          </div>
        </FlitModal>
      )}
    </div>
  );
}
