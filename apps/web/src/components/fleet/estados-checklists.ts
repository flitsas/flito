/*
 * Estados de dominio de checklists, plan de emergencias y capacitaciones (S4, Épica #14560) sobre el registro
 * ESTADO→{tono, glifo|icono} del UI Kit 2026. Se registra al importar este módulo; las páginas lo importan por
 * efecto y pintan con <EtiquetaEstado estado="…">. Un ícono por estado; el color lo pone el kit por data-tono.
 */
import { registrarEstados, type EstadoKit } from '../flit/kit/tonos';

export const ESTADOS_CHECKLISTS: Record<string, EstadoKit> = {
  // Decisión del checklist preoperacional (las claves son los valores del API).
  apto: { tono: 'ok', glifo: 'check' },
  condicional: { tono: 'warn', glifo: 'exclamacion' },
  no_apto: { tono: 'danger', glifo: 'alerta' },
  // Vigencia del registro y chip «Todos» del filtro.
  'checklist-vigente': { tono: 'ok', glifo: 'encendido' },
  'checklist-anulado': { tono: 'anulado', icono: 'anulado' },
  'checklist-todos': { tono: 'neutro', glifo: 'todos' },
  // Capacitaciones y simulacros.
  programada: { tono: 'info', glifo: 'calendario' },
  realizada: { tono: 'ok', glifo: 'finalizado' },
  vencida: { tono: 'danger', glifo: 'vencido' },
  'capacitacion-pendiente': { tono: 'warn', glifo: 'espera' },
  // Ítems del checklist: marcas de obligatorio y crítico.
  'item-obligatorio': { tono: 'danger', glifo: 'asterisco' },
  'item-critico': { tono: 'warn', glifo: 'exclamacion' },
};

registrarEstados(ESTADOS_CHECKLISTS);
