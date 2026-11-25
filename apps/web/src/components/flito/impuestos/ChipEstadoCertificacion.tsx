// Chip de estado de «Certificar sin trámite» (Épica #14163).
import StatusChip, { type ChipTone } from '../../flit/StatusChip';
import { Icono } from '../../flit/kit/Icono';
import { estadoKit, registrarEstados } from '../../flit/kit/tonos';

export type EstadoCertificacion = 'radicado' | 'sin_respuesta' | 'sin_vehiculo' | 'sin_coincidencia' | 'certificado';

export const ESTADO_CERTIFICACION: Record<EstadoCertificacion, { texto: string; tono: ChipTone }> = {
  radicado: { texto: 'Guardado', tono: 'draft' },
  sin_respuesta: { texto: 'Sin respuesta', tono: 'warning' },
  sin_vehiculo: { texto: 'Sin vehículo', tono: 'warning' },
  sin_coincidencia: { texto: 'No coincide', tono: 'danger' },
  certificado: { texto: 'Certificado', tono: 'success' },
};

export const ESTADOS_CERTIFICACION: EstadoCertificacion[] = [
  'radicado', 'sin_respuesta', 'sin_vehiculo', 'sin_coincidencia', 'certificado',
];

registrarEstados({
  'certificacion-radicado': { tono: 'neutro', glifo: 'pausa' },
  'certificacion-sin_respuesta': { tono: 'warn', glifo: 'reloj' },
  'certificacion-sin_vehiculo': { tono: 'warn', glifo: 'alerta' },
  'certificacion-sin_coincidencia': { tono: 'danger', glifo: 'alerta' },
  'certificacion-certificado': { tono: 'ok', glifo: 'doble-check' },
});

export default function ChipEstadoCertificacion({ estado }: { estado: EstadoCertificacion }) {
  const e = ESTADO_CERTIFICACION[estado];
  const k = estadoKit(`certificacion-${estado}`);
  return (
    <StatusChip tone={e.tono} icono={k.glifo ? <Icono nombre={k.glifo} size={14} /> : undefined}>
      {e.texto}
    </StatusChip>
  );
}
