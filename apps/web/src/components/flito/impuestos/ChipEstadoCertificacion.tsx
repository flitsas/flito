// Chip de estado de «Certificar sin trámite» con su glifo (HU #14665): el MISMO estilo que
// `ChipEstadoImpuesto` —estado por texto e ícono, no solo por color—. Textos y tonos son los de
// siempre de la pantalla; los glifos se registran con el prefijo `certificacion-` para no pisar las
// claves del kit, y el embudo de la pestaña usa las mismas claves.
import StatusChip, { type ChipTone } from '../../flit/StatusChip';
import { registrarEstados } from '../../flit/kit/tonos';
import { IconoEstado } from '../soat/ChipEstadoSoat';

export type EstadoCertificacion = 'radicado' | 'sin_respuesta' | 'sin_vehiculo' | 'sin_coincidencia' | 'certificado';

export const ESTADO_CERTIFICACION: Record<EstadoCertificacion, { texto: string; tono: ChipTone }> = {
  radicado: { texto: 'Guardado', tono: 'draft' },
  sin_respuesta: { texto: 'Sin respuesta', tono: 'warning' },
  sin_vehiculo: { texto: 'Sin vehículo', tono: 'warning' },
  sin_coincidencia: { texto: 'No coincide', tono: 'danger' },
  certificado: { texto: 'Certificado', tono: 'success' },
};

/** Orden del embudo y de la spec (§3). */
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
  return (
    <StatusChip tone={e.tono} icono={<IconoEstado clave={`certificacion-${estado}`} />}>
      {e.texto}
    </StatusChip>
  );
}
