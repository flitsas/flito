// Chip de una solicitud que pasó el ANS de gestión (HU #11024).
//
// Antes decía «SLA vencido», que no dice nada accionable: ni cuánto lleva parado ni desde cuándo.
// Ahora dice el tiempo transcurrido, que es lo que decide si esto se reclama hoy o puede esperar.
//
// El umbral no se comprueba aquí: quien decide si una solicitud está sin gestión es el backend, que
// aplica ANS_OPERATIVO.SIN_GESTION_HORAS en SQL. Este componente solo lo cuenta.

import StatusChip, { type ChipTone } from './StatusChip';

/** Cuánto lleva sin moverse, en el nivel de detalle que se usa para reclamar. */
function transcurrido(desde: string): string {
  const horas = (Date.now() - new Date(desde).getTime()) / 3_600_000;
  if (horas < 48) return '1 día';
  const dias = Math.floor(horas / 24);
  return `${dias} días`;
}

export default function ChipSinGestion({ desde, tone = 'warning' }: { desde: string | null; tone?: ChipTone }) {
  // Sin fecha de envío no hay nada que contar, y un chip sin cifra sería el «vencido» de antes.
  if (!desde) return <StatusChip tone={tone}>Sin gestión</StatusChip>;
  return <StatusChip tone={tone}>{transcurrido(desde)} sin gestión</StatusChip>;
}
