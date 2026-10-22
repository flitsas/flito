// HU #13188 (Feature #13060) — pulso de la lectura automática de FLIT 2 en memoria del proceso.
// Unidad pura: fechas explícitas, sin timers.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  leerPrograma, marcarLecturaIniciada, marcarLecturaTerminada, marcarProgramaApagado,
  marcarProgramaEncendido, registrarTick, reiniciarProgramaParaTest,
} from '../../src/modules/flito-sync/flit2-programa.js';

const T0 = new Date('2026-09-29T15:00:00Z');
const MIN5 = 300_000;

beforeEach(() => reiniciarProgramaParaTest());

describe('HU #13188 · flit2-programa', () => {
  it('nace apagado: inactivo, sin intervalo ni próxima y sin lectura en curso (AC3)', () => {
    expect(leerPrograma()).toEqual({ activa: false, intervaloMs: null, proximaEn: null, enCurso: false });
  });

  it('encendido: próxima = ahora + intervalo (AC1)', () => {
    marcarProgramaEncendido(MIN5, T0);
    expect(leerPrograma()).toEqual({
      activa: true, intervaloMs: MIN5, proximaEn: new Date('2026-09-29T15:05:00Z'), enCurso: false,
    });
  });

  it('cada tick adelanta la próxima un intervalo desde el tick (AC2)', () => {
    marcarProgramaEncendido(MIN5, T0);
    registrarTick(new Date('2026-09-29T15:05:00.020Z'));
    expect(leerPrograma().proximaEn?.toISOString()).toBe('2026-09-29T15:10:00.020Z');
  });

  it('un tick con el programa apagado no lo enciende (AC3)', () => {
    registrarTick(T0);
    expect(leerPrograma()).toEqual({ activa: false, intervaloMs: null, proximaEn: null, enCurso: false });
  });

  it('apagar tras encender borra intervalo y próxima (AC3)', () => {
    marcarProgramaEncendido(MIN5, T0);
    marcarProgramaApagado();
    expect(leerPrograma()).toEqual({ activa: false, intervaloMs: null, proximaEn: null, enCurso: false });
  });

  it('enCurso true entre iniciada y terminada, y false al terminar (AC4)', () => {
    marcarLecturaIniciada();
    expect(leerPrograma().enCurso).toBe(true);
    marcarLecturaTerminada();
    expect(leerPrograma().enCurso).toBe(false);
  });

  it('terminada sin iniciada no deja el contador negativo: la siguiente iniciada vuelve a marcar en curso (AC4)', () => {
    marcarLecturaTerminada();
    marcarLecturaTerminada();
    expect(leerPrograma().enCurso).toBe(false);
    marcarLecturaIniciada();
    expect(leerPrograma().enCurso).toBe(true);
  });

  it('enCurso habla de la lectura, no del programa: se marca aunque el programa esté apagado', () => {
    marcarLecturaIniciada();
    expect(leerPrograma()).toMatchObject({ activa: false, enCurso: true });
  });

  it('leerPrograma devuelve una copia: mutar la foto no cambia el estado', () => {
    marcarProgramaEncendido(MIN5, T0);
    const foto = leerPrograma();
    foto.proximaEn!.setTime(0);
    foto.activa = false;
    expect(leerPrograma()).toMatchObject({ activa: true, proximaEn: new Date('2026-09-29T15:05:00Z') });
  });
});
