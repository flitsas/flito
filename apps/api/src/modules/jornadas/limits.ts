// Decreto 1079/2015 art. 2.2.1.7.1.10 + Resolución 12379/2012 — límites obligatorios.
// Validado por SuperTransporte (radicados 20251340607391, 20241340164191).
//
// PESV-S2 fix 2026-05-07: pausa real es 30min cada 4h continuas (Res. 12379 art. 3),
// no 15min cada 2h como teníamos. Alarma 60h semanal ahora se computa también al cierre
// si el handler provee horasSemanaAcumulada (suma de horas de las últimas jornadas
// del conductor en la misma semana ISO).
//
// Las alarmas persisten valor_limite para trazabilidad histórica (si la norma cambia,
// las alarmas viejas conservan el valor que aplicaba en su momento).

export const JORNADA_LIMITS = {
  // Conducción continua sin pausa: 4 horas máx (Res. 12379 art. 3 inciso 2).
  MAX_CONTINUAS_HORAS: 4,
  // Pausa obligatoria 30min después de 4h continuas (NO 15min cada 2h).
  PAUSA_OBLIGATORIA_MIN: 30,
  PAUSA_INTERVALO_HORAS: 4,
  // Conducción diaria total: 10 horas máx (Decreto 1079 + Res. 12379 art. 3).
  MAX_JORNADA_HORAS: 10,
  // Conducción semanal: 60 horas máx (Decreto 1079).
  MAX_SEMANAL_HORAS: 60,
  // Mensual aproximado: 60h × 4 semanas = 240h (no 60×5=300 que era falso negativo).
  MAX_MENSUAL_HORAS: 240,
  // Descanso entre jornadas: 8 horas mínimo (CST art. 161). Buena práctica: 11h (UE 561/2006).
  MIN_DESCANSO_HORAS: 8,
  // Cierre automático del cron si una jornada queda abierta más de N horas.
  AUTOCLOSE_HORAS: 16,
} as const;

export type JornadaAlarmaTipo = 'mas_4h_continuas' | 'mas_10h_jornada' | 'menos_8h_descanso' | 'mas_60h_semanal' | 'sin_pausa_obligatoria';

export interface AlarmaCandidata {
  tipo: JornadaAlarmaTipo;
  valorObservado: number;
  valorLimite: number;
  unidad: string;
}

/**
 * Computa las alarmas que aplican a una jornada al cerrarla.
 * Toma duración total + horas de descanso previo (calculadas por el handler).
 * Si `horasSemanaAcumulada` viene definido, también evalúa la alarma semanal.
 *
 * Heurística pausa obligatoria: si la jornada >= 4h, debe haber pausa acumulada
 * >= 30min × floor(horas/4). Es conservadora — el cómputo fino exigiría reconstruir
 * tramos entre pausas y validar que cada bloque continuo no exceda 4h.
 */
export function computarAlarmasCierre(opts: {
  horasConduccion: number;
  horasDescansoPre: number | null;
  pausasMinTotales: number;
  horasSemanaAcumulada?: number; // incluye la jornada actual ya cerrada
}): AlarmaCandidata[] {
  const a: AlarmaCandidata[] = [];
  const { horasConduccion, horasDescansoPre, pausasMinTotales, horasSemanaAcumulada } = opts;

  if (horasConduccion > JORNADA_LIMITS.MAX_JORNADA_HORAS) {
    a.push({
      tipo: 'mas_10h_jornada',
      valorObservado: Number(horasConduccion.toFixed(2)),
      valorLimite: JORNADA_LIMITS.MAX_JORNADA_HORAS,
      unidad: 'horas',
    });
  }
  // Conducción >4h sin NINGUNA pausa registrada → alerta inmediata.
  if (horasConduccion > JORNADA_LIMITS.MAX_CONTINUAS_HORAS && pausasMinTotales === 0) {
    a.push({
      tipo: 'mas_4h_continuas',
      valorObservado: Number(horasConduccion.toFixed(2)),
      valorLimite: JORNADA_LIMITS.MAX_CONTINUAS_HORAS,
      unidad: 'horas',
    });
  }
  // Pausa obligatoria: cada 4h de conducción exige al menos 30min de pausa acumulada.
  const pausaEsperada = Math.floor(horasConduccion / JORNADA_LIMITS.PAUSA_INTERVALO_HORAS) * JORNADA_LIMITS.PAUSA_OBLIGATORIA_MIN;
  if (horasConduccion >= JORNADA_LIMITS.PAUSA_INTERVALO_HORAS && pausasMinTotales < pausaEsperada) {
    a.push({
      tipo: 'sin_pausa_obligatoria',
      valorObservado: pausasMinTotales,
      valorLimite: pausaEsperada,
      unidad: 'minutos',
    });
  }
  if (horasDescansoPre !== null && horasDescansoPre < JORNADA_LIMITS.MIN_DESCANSO_HORAS) {
    a.push({
      tipo: 'menos_8h_descanso',
      valorObservado: Number(horasDescansoPre.toFixed(2)),
      valorLimite: JORNADA_LIMITS.MIN_DESCANSO_HORAS,
      unidad: 'horas',
    });
  }
  if (horasSemanaAcumulada !== undefined && horasSemanaAcumulada > JORNADA_LIMITS.MAX_SEMANAL_HORAS) {
    a.push({
      tipo: 'mas_60h_semanal',
      valorObservado: Number(horasSemanaAcumulada.toFixed(2)),
      valorLimite: JORNADA_LIMITS.MAX_SEMANAL_HORAS,
      unidad: 'horas',
    });
  }
  return a;
}
