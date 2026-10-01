// FLITO sync — pulso de la lectura automática de FLIT 2 en memoria del proceso (HU #13188,
// Feature #13060, Épica #12736). Diseño: `docs/diseno/hu-13188-pulso-lectura-flit2.md`.
//
// ── Reglas de negocio ────────────────────────────────────────────────────────────────────────────
//
// RN-01  Estado de ESTE proceso: el cron (`flito-sync.cron.ts`) lo enciende/apaga y registra cada
//        tick; `leerConCandado` marca la lectura en curso; el estado (`flit2-estado.service.ts`) lo lee.
//        Este módulo no importa nada del módulo (sin ciclos). Nace apagado.
// RN-02  Apagado: `activa=false`, `intervaloMs=null`, `proximaEn=null`. Encendido:
//        `proximaEn = ahora + intervaloMs`, y cada tick (lea o se lo salte) la adelanta desde ese tick.
// RN-03  `enCurso` = hay una lectura con el candado tomado en este proceso. Contador, nunca negativo.

export interface EstadoPrograma {
  activa: boolean;
  intervaloMs: number | null;
  proximaEn: Date | null;
  enCurso: boolean;
}

let activa = false;
let intervaloMs: number | null = null;
let proximaEn: Date | null = null;
let lecturas = 0;

/** El cron quedó armado: la próxima corrida sale a `ahora + intervalo`. */
export function marcarProgramaEncendido(intervalo: number, ahora: Date): void {
  activa = true;
  intervaloMs = intervalo;
  proximaEn = new Date(ahora.getTime() + intervalo);
}

/** `FLIT2_SYNC_CRON=false` o `stopFlitSync`: no hay programa (RN-02). */
export function marcarProgramaApagado(): void {
  activa = false;
  intervaloMs = null;
  proximaEn = null;
}

/** Cada disparo del timer, antes de decidir si lee o se salta (RN-02). Sin programa: no-op. */
export function registrarTick(ahora: Date): void {
  if (!activa || intervaloMs === null) return;
  proximaEn = new Date(ahora.getTime() + intervaloMs);
}

/** Dentro de `leerConCandado`, ya con el candado tomado (RN-03). */
export function marcarLecturaIniciada(): void {
  lecturas += 1;
}

export function marcarLecturaTerminada(): void {
  lecturas = Math.max(0, lecturas - 1);
}

/** Foto inmutable para el estado. */
export function leerPrograma(): EstadoPrograma {
  return {
    activa,
    intervaloMs,
    proximaEn: proximaEn ? new Date(proximaEn.getTime()) : null,
    enCurso: lecturas > 0,
  };
}

/** Solo tests: vuelve al estado de arranque. */
export function reiniciarProgramaParaTest(): void {
  marcarProgramaApagado();
  lecturas = 0;
}
