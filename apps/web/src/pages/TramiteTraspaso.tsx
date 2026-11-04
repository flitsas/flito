// TRAM-TRASPASO-F1.5 — wizard de TRASPASO alineado a CEA (TransitoTraspasoWizard).
// 6 pasos: Vehículo → Validación legal → Vendedor → Comprador → Comercial → Documentos.
// NO redirige al wizard VIN-first de matrícula inicial. Reusa RUNT, pre-vuelo,
// firma B3 y radicado/STT de F1.
// HU #13988: esta página solo orquesta; estado y efectos en useTramiteTraspaso, cada paso en su componente.

import PageHeaderCard from '../components/flit/PageHeaderCard';
import { ultimaNotaSubsanacion } from '@operaciones/shared-types';
import { cardStyle, PASOS } from '../components/tramite-traspaso/constantes';
import { GestionCerradaBanner, PasoEditableBanner, SubsanacionBanner } from '../components/tramite-traspaso/TraspasoBanners';
import PasoComercial from '../components/tramite-traspaso/PasoComercial';
import PasoComprador from '../components/tramite-traspaso/PasoComprador';
import PasoDocumentos from '../components/tramite-traspaso/PasoDocumentos';
import PasoValidacionLegal from '../components/tramite-traspaso/PasoValidacionLegal';
import PasoVehiculo from '../components/tramite-traspaso/PasoVehiculo';
import PasoVendedor from '../components/tramite-traspaso/PasoVendedor';
import ProgresoTraspasoPills from '../components/tramite-traspaso/ProgresoTraspasoPills';
import TraspasoPasosNav from '../components/tramite-traspaso/TraspasoPasosNav';
import { useTramiteTraspaso } from '../components/tramite-traspaso/useTramiteTraspaso';

export default function TramiteTraspaso() {
  const t = useTramiteTraspaso();
  const { step, tramiteId, radicado, estado, workflow, maxPaso, gestionCerrada, isTransito, pasoSoloLectura, pasoNavHabilitado, irPaso } = t;

  return (
    <div className="mx-auto grid max-w-4xl gap-5 lg:grid-cols-[200px_1fr] lg:gap-6">
      <div className="lg:col-span-2">
        <PageHeaderCard title="Traspaso de vehículo" subtitle={radicado ? `Radicado ${radicado}` : 'Trámite de traspaso por placa (Res. 12379/2012)'} />
      </div>

      {tramiteId && estado === 'subsanacion' && <SubsanacionBanner nota={ultimaNotaSubsanacion(workflow)} />}
      {tramiteId && gestionCerrada && <GestionCerradaBanner estado={estado} isTransito={isTransito} />}
      {tramiteId && (
        <ProgresoTraspasoPills
          step={step}
          pasoActivo={maxPaso}
          pasoSoloLectura={pasoSoloLectura}
          pasoNavHabilitado={pasoNavHabilitado}
          onIrPaso={irPaso}
        />
      )}

      {/* Sidebar de pasos (FLIT) */}
      <TraspasoPasosNav step={step} maxPaso={maxPaso} radicado={radicado} estado={estado} pasoSoloLectura={pasoSoloLectura} pasoNavHabilitado={pasoNavHabilitado} irPaso={irPaso} />

      <section className="bg-white p-6" style={cardStyle} aria-label={`Paso ${step}: ${PASOS[step - 1]}`}>
        {tramiteId && step === maxPaso && !pasoSoloLectura(step) && step < 6 && <PasoEditableBanner paso={step} />}
        {step === 1 && (
          <PasoVehiculo
            tramiteId={tramiteId} placa={t.placa} setPlaca={t.setPlaca} docPropietario={t.docPropietario} setDocPropietario={t.setDocPropietario}
            vehiculo={t.vehiculo} busy={t.busy} pasoSoloLectura={pasoSoloLectura} consultar={t.consultar} radicar={t.radicar}
          />
        )}

        {step === 2 && (
          <PasoValidacionLegal
            preflight={t.preflight} preflightLoading={t.preflightLoading} preflightError={t.preflightError} preflightBloquea={t.preflightBloquea}
            impuestoUnknown={t.impuestoUnknown} pazSalvoOk={t.pazSalvoOk} pazSalvoImpuesto={t.pazSalvoImpuesto} impuestoConsulta={t.impuestoConsulta}
            forzarActivo={t.forzarActivo} isAdmin={t.isAdmin} busy={t.busy} gateCtx={t.gateCtx} pasoSoloLectura={pasoSoloLectura}
            ejecutarPreflight={t.ejecutarPreflight} reintentarPreflight={t.reintentarPreflight}
            activarForzarContinuar={t.activarForzarContinuar} desactivarForzarContinuar={t.desactivarForzarContinuar}
            consultarImpuesto={t.consultarImpuesto} confirmarPazSalvoManual={t.confirmarPazSalvoManual} continuarDesdePaso={t.continuarDesdePaso}
          />
        )}

        {step === 3 && (
          <PasoVendedor vendedor={t.vendedor} setVendedor={t.setVendedor} guardarVendedor={t.guardarVendedor} busy={t.busy} vehiculo={t.vehiculo} pasoSoloLectura={pasoSoloLectura} />
        )}
        {step === 4 && (
          <PasoComprador
            comprador={t.comprador} setComprador={t.setComprador} guardarComprador={t.guardarComprador} busy={t.busy} vehiculo={t.vehiculo}
            isAdmin={t.isAdmin} forzarActivo={t.forzarActivo} activarForzarContinuar={t.activarForzarContinuar} pasoSoloLectura={pasoSoloLectura}
          />
        )}

        {step === 5 && (
          <PasoComercial
            vehiculo={t.vehiculo} valorVenta={t.valorVenta} causal={t.causal} observaciones={t.observaciones}
            busy={t.busy} pasoSoloLectura={pasoSoloLectura} guardarComercial={t.guardarComercial}
          />
        )}

        {step === 6 && tramiteId && (
          <PasoDocumentos
            tramiteId={tramiteId} radicado={radicado} estado={estado} vehiculo={t.vehiculo} vendedor={t.vendedor} comprador={t.comprador}
            orgTransito={t.orgTransito} tipologiaCodigo={t.tipologiaCodigo} checklistEstado={t.checklistEstado} furGenerado={t.furGenerado}
            busy={t.busy} gestionCerrada={gestionCerrada} transicionar={t.transicionar} cambiarOrganismo={t.cambiarOrganismo}
            patchDocumentos={t.patchDocumentos} registrarPazSalvoSubido={t.registrarPazSalvoSubido}
          />
        )}
      </section>
    </div>
  );
}
