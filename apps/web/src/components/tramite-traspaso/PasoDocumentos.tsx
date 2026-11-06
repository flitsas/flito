// Paso 6 — organismo, expediente, documentos y firma. Solo se monta con trámite radicado.

import TraspasoStepDocumentos from '../../pages/tramite/TraspasoStepDocumentos';
import TraspasoOrganismoPicker from '../../pages/tramite/TraspasoOrganismoPicker';
import TraspasoExpedientePanel from '../../pages/tramite/TraspasoExpedientePanel';
import type { UseTramiteTraspaso } from './useTramiteTraspaso';

type Props = { tramiteId: number } & Pick<UseTramiteTraspaso,
  'radicado' | 'estado' | 'vehiculo' | 'vendedor' | 'comprador' | 'orgTransito' | 'tipologiaCodigo' | 'checklistEstado' | 'furGenerado'
  | 'busy' | 'gestionCerrada' | 'transicionar' | 'cambiarOrganismo' | 'patchDocumentos' | 'registrarPazSalvoSubido'>;

export default function PasoDocumentos({
  tramiteId, radicado, estado, vehiculo, vendedor, comprador, orgTransito, tipologiaCodigo, checklistEstado, furGenerado,
  busy, gestionCerrada, transicionar, cambiarOrganismo, patchDocumentos, registrarPazSalvoSubido,
}: Props) {
  return (
    <div className="flex flex-col gap-4">
      <TraspasoOrganismoPicker
        org={orgTransito}
        onChange={cambiarOrganismo}
        runtOrganismo={vehiculo?.organismoTransito as string | undefined}
        disabled={busy || gestionCerrada}
      />
      <TraspasoExpedientePanel
        tramiteId={tramiteId}
        radicado={radicado}
        estado={estado}
        vehiculo={vehiculo ?? {}}
        comprador={comprador}
        orgTransito={orgTransito}
        tipologiaCodigo={tipologiaCodigo}
        checklistEstado={checklistEstado}
      />
      <TraspasoStepDocumentos
        tramiteId={tramiteId}
        estado={estado}
        furGenerado={furGenerado}
        sttBusy={busy}
        soloLectura={gestionCerrada}
        onTransicionStt={transicionar}
        tipologiaCodigo={tipologiaCodigo}
        checklistEstado={checklistEstado}
        organismoCodigo={orgTransito.codigo || null}
        org={orgTransito.codigo ? { orgNombre: orgTransito.nombre, orgCiudad: orgTransito.ciudad, orgCodigo: orgTransito.codigo } : undefined}
        vin={(vehiculo?.vin as string) || undefined}
        vendedor={{ nombre: vendedor.nombre, documento: vendedor.documento, email: vendedor.email }}
        comprador={{ nombre: comprador.nombre, documento: comprador.documento, email: comprador.email }}
        docsGenerados={(vehiculo?._docs_generados as { contratoAt?: string; improntasAt?: string; furAt?: string; improntasHash?: string }) || undefined}
        onPatch={patchDocumentos}
        onPazSalvoUploaded={registrarPazSalvoSubido}
      />
    </div>
  );
}
