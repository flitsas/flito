// Chip de estado del SOAT (HU 12819). Tono + ícono por estado (§11 de la spec): el estado deja de
// depender solo del color. El ícono es decorativo (`aria-hidden`): el texto del chip ya dice el
// estado, así que el nombre accesible no cambia. UI Kit 2026: etiqueta con punta y un glifo por
// estado, registrados en el registro de estados del kit (`registrarEstados`).

import { ESTADO_SOAT_LABEL, EstadoSoat, type EstadoSolicitudIncompletaSoat } from '@operaciones/shared-types';
import StatusChip, { type ChipTone } from '../../flit/StatusChip';
import { Icono } from '../../flit/kit/Icono';
import { estadoKit, registrarEstados } from '../../flit/kit/tonos';
import { ESTADO_INCOMPLETA_LABEL } from './tipos';

// Cuatro estados y cuatro tonos. Aquí hubo dos entradas más —`pendiente_revision` y `rechazada`, del
// canal Cliente— que la HU 12079 dejó sin escritor y que la 12080 retira del enum y del tipo de
// Postgres (migración 0176, que aborta si queda alguna fila en ellos). No hace falta conservarles un
// tono «por si llega una fila antigua»: no puede llegar ninguna.
export const TONO: Record<EstadoSoat, ChipTone> = {
  pendiente: 'draft', solicitado: 'active', con_novedad: 'danger', pagado: 'success',
  descartado: 'neutral', // Épica #14707: su trámite murió en FLIT (la presentación final llega en el Bloque 3).
};

// Un glifo por estado (regla del kit). Claves con prefijo del módulo para no pisar las del kit.
registrarEstados({
  'soat-pendiente': { tono: 'neutro', glifo: 'pausa' },
  'soat-solicitado': { tono: 'info', glifo: 'reloj' },
  'soat-con_novedad': { tono: 'danger', glifo: 'alerta' },
  'soat-pagado': { tono: 'ok', glifo: 'doble-check' },
  'soat-incompleta': { tono: 'warn', glifo: 'espera' },
  'soat-descartada': { tono: 'neutro', glifo: 'menos' },
  'soat-completada': { tono: 'ok', glifo: 'finalizado' },
});

/** Glifo del estado en su disco de color, como la `EtiquetaEstado` del kit. Lo usa también Impuestos. */
export function IconoEstado({ clave }: { clave: string }) {
  const e = estadoKit(clave);
  return (
    <span aria-hidden="true" className="kit-disco kit-etiqueta__icono !bg-[var(--c)] !text-[color:var(--kit-sobre-relleno)]">
      <Icono nombre={e.glifo ?? 'punto'} />
    </span>
  );
}

export default function ChipEstadoSoat({ estado }: { estado: EstadoSoat }) {
  return <StatusChip tone={TONO[estado]} icono={<IconoEstado clave={`soat-${estado}`} />}>{ESTADO_SOAT_LABEL[estado]}</StatusChip>;
}

/**
 * Chip de la solicitud aparcada porque el RUNT no respondió (HU 12997, UX §3.1). Tono `warning`
 * para «Por validar» (la única con trabajo pendiente) y `draft` —el neutro del kit— para
 * «Descartada», que es un cierre. La marca no depende del color: texto e ícono.
 */
const TONO_INCOMPLETA: Record<EstadoSolicitudIncompletaSoat, ChipTone> = {
  incompleta: 'warning', descartada: 'draft', completada: 'success',
};

export function ChipIncompletaSoat({ estado }: { estado: EstadoSolicitudIncompletaSoat }) {
  return (
    <StatusChip tone={TONO_INCOMPLETA[estado]} icono={<IconoEstado clave={`soat-${estado}`} />}>
      {ESTADO_INCOMPLETA_LABEL[estado]}
    </StatusChip>
  );
}
