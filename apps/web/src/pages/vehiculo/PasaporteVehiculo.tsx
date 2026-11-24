// EPIC TRAM-INNOV · B1 — Pasaporte vehicular (historial encadenado por VIN).
//
// Timeline de eventos del VIN + verificación de integridad de la cadena de hashes
// + descarga del Certificado FLIT (PDF). Reusa el patrón visual de
// ExpedienteTimeline (A2). Estilos: UI Kit 2026 (ActividadLinea, EtiquetaEstado, Vacio).

import { useEffect, useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import toast from 'react-hot-toast';
import GradientButton from '../../components/flit/GradientButton';
import { Cargador, Vacio } from '../../components/flit/Cargador';
import { ActividadLinea, EtiquetaEstado } from '../../components/flit/Bloques';
import { ESTADO_FLOTA } from '../../components/fleet/estados-flota';

interface Evento { id: number; eventoTipo: string; payload: unknown; hashSelf: string; createdAt: string }
interface Historial {
  vin: string;
  eventos: Evento[];
  integridad: { valido: boolean; rotoEnId: number | null };
  ultimoHash: string | null;
  desde: string | null;
  hasta: string | null;
}

const TIPO_LABEL: Record<string, string> = {
  tramite_creado: 'Trámite iniciado',
  tramite_enviado_transito: 'Enviado a tránsito',
  tramite_placa_asignada: 'Placa asignada',
  documento_registrado: 'Documento registrado',
  soat_vigente: 'SOAT vigente',
  pesv_incidente: 'Incidente PESV',
  transferencia_registrada: 'Transferencia registrada',
  vehiculo_registrado: 'Vehículo registrado en FLIT',
};

function fmt(iso: string): string {
  try { return new Date(iso).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return iso; }
}

export default function PasaporteVehiculo({ vin }: { vin: string }) {
  const [data, setData] = useState<Historial | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.get<Historial>(`/vehicles/${encodeURIComponent(vin)}/historial`)
      .then((d) => { if (alive) setData(d); })
      .catch(() => { if (alive) setData(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [vin]);

  const descargarCertificado = async () => {
    try { await api.download(`/vehicles/${encodeURIComponent(vin)}/certificado`, `pasaporte_${vin}.pdf`); }
    catch (err) { toast.error(errorMessage(err)); }
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-bold text-[color:var(--color-action)]">Pasaporte del vehículo</h4>
          <p className="break-all text-xs text-[color:var(--color-text-tertiary)]">{vin}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {data && data.eventos.length > 0 && (
            <EtiquetaEstado estado={data.integridad.valido ? ESTADO_FLOTA.cadenaIntegra : ESTADO_FLOTA.cadenaAlterada}>
              {data.integridad.valido ? 'Cadena íntegra' : 'Cadena alterada'}
            </EtiquetaEstado>
          )}
          {data && data.eventos.length > 0 && (
            <GradientButton type="button" variant="secondary" size="sm" onClick={descargarCertificado}>
              Certificado FLIT
            </GradientButton>
          )}
        </div>
      </div>

      {loading ? (
        <Cargador texto="Cargando pasaporte…" />
      ) : !data || data.eventos.length === 0 ? (
        <Vacio
          icono="historial-placa"
          texto="Sin eventos en el pasaporte todavía."
          detalle="Se registran al crear trámites, asignar placa, verificar SOAT o al importar datos ya existentes en el sistema."
          accion={(
            <GradientButton
              type="button"
              size="sm"
              onClick={() => {
                setLoading(true);
                api.post<Historial>(`/vehicles/${encodeURIComponent(vin)}/historial/sync`, {})
                  .then((d) => { setData(d); toast.success('Historial actualizado'); })
                  .catch((err) => toast.error(errorMessage(err)))
                  .finally(() => setLoading(false));
              }}
            >
              Importar desde trámites y SOAT
            </GradientButton>
          )}
        />
      ) : (
        <ActividadLinea
          eventos={data.eventos.map((e) => ({
            id: String(e.id),
            cuando: fmt(e.createdAt),
            fechaIso: e.createdAt,
            texto: (
              <>
                <strong className="block text-[color:var(--color-text-primary)]">{TIPO_LABEL[e.eventoTipo] || e.eventoTipo}</strong>
                <span className="mt-0.5 block break-all text-xs text-[color:var(--color-text-tertiary)]">sha256: {e.hashSelf.slice(0, 24)}…</span>
              </>
            ),
          }))}
        />
      )}
    </div>
  );
}
