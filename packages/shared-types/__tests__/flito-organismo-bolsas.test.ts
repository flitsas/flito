// Nivel y deuda de la bolsa del organismo (HU #11161, AC5–AC7).
//
// Son funciones puras y compartidas con la web a propósito: el tablero tiene que pintar exactamente
// el nivel que calcula la API. Probarlas aquí las fija para los dos lados a la vez.

import { describe, it, expect } from 'vitest';
import {
  deudaConOrganismo, NivelBolsaOrganismo, nivelBolsaOrganismoDe,
} from '../src/flito-organismo-bolsas.js';

describe('nivelBolsaOrganismoDe — AC7: alerta de saldo bajo', () => {
  const CARGA = 10_000_000;

  it('por encima del 30 % de la última carga es normal', () => {
    expect(nivelBolsaOrganismoDe(5_000_000, CARGA)).toBe(NivelBolsaOrganismo.NORMAL);
    // Justo por encima del umbral: 30,01 %.
    expect(nivelBolsaOrganismoDe(3_001_000, CARGA)).toBe(NivelBolsaOrganismo.NORMAL);
  });

  it('al 30 % o menos es saldo bajo', () => {
    // El umbral es inclusivo: exactamente 3.000.000 sobre una carga de 10.000.000 ya alerta.
    expect(nivelBolsaOrganismoDe(3_000_000, CARGA)).toBe(NivelBolsaOrganismo.BAJO);
    expect(nivelBolsaOrganismoDe(2_000_000, CARGA)).toBe(NivelBolsaOrganismo.BAJO);
  });

  it('al 10 % o menos es crítico', () => {
    expect(nivelBolsaOrganismoDe(1_000_000, CARGA)).toBe(NivelBolsaOrganismo.CRITICO);
    expect(nivelBolsaOrganismoDe(500_000, CARGA)).toBe(NivelBolsaOrganismo.CRITICO);
  });

  it('en cero es agotada, no crítica', () => {
    // Distinguirlas importa en el tablero: «no queda nada» pide una acción distinta a «queda poco».
    expect(nivelBolsaOrganismoDe(0, CARGA)).toBe(NivelBolsaOrganismo.AGOTADA);
  });

  it('en negativo es préstamo — AC5', () => {
    // El caso que separa esta bolsa de la del cliente: el organismo siguió emitiendo derechos
    // después de agotar el saldo y ese gasto ya ocurrió.
    expect(nivelBolsaOrganismoDe(-4_000_000, CARGA)).toBe(NivelBolsaOrganismo.EN_PRESTAMO);
  });

  it('sin cargas previas no hay porcentaje que calcular', () => {
    expect(nivelBolsaOrganismoDe(0, null)).toBe(NivelBolsaOrganismo.SIN_CARGAS);
    // Una carga en cero tampoco sirve de base: evita además la división por cero.
    expect(nivelBolsaOrganismoDe(0, 0)).toBe(NivelBolsaOrganismo.SIN_CARGAS);
  });

  it('el préstamo se detecta aunque no haya base', () => {
    // Puede pasar mientras el backfill del histórico (HU #11163) asienta consumo antes que cargas:
    // un saldo negativo es un préstamo aunque nadie haya cargado nunca.
    expect(nivelBolsaOrganismoDe(-1, null)).toBe(NivelBolsaOrganismo.EN_PRESTAMO);
  });
});

describe('deudaConOrganismo', () => {
  it('la deuda es el saldo negativo en positivo', () => {
    // No hay tabla ni columna de deuda: ES el saldo. Esta función solo le cambia el signo para que
    // la pantalla pueda decir «se le deben 4.000.000» sin invertirlo cada vez.
    expect(deudaConOrganismo(-4_000_000)).toBe(4_000_000);
  });

  it('sin saldo negativo no se debe nada', () => {
    expect(deudaConOrganismo(0)).toBe(0);
    expect(deudaConOrganismo(6_000_000)).toBe(0);
  });
});

describe('AC6 — la siguiente carga neta la deuda', () => {
  it('el ejemplo del refinamiento cuadra por aritmética', () => {
    // Saldo de 8.000.000 y derechos por 12.000.000 → −4.000.000 (AC5). Otra carga de 10.000.000 deja
    // 6.000.000 y el organismo queda en paz y salvo, sin ningún estado especial de por medio.
    const saldoTrasConsumo = 8_000_000 - 12_000_000;
    expect(saldoTrasConsumo).toBe(-4_000_000);
    expect(deudaConOrganismo(saldoTrasConsumo)).toBe(4_000_000);

    const saldoTrasRecargar = saldoTrasConsumo + 10_000_000;
    expect(saldoTrasRecargar).toBe(6_000_000);
    expect(deudaConOrganismo(saldoTrasRecargar)).toBe(0);
    expect(nivelBolsaOrganismoDe(saldoTrasRecargar, 10_000_000)).toBe(NivelBolsaOrganismo.NORMAL);
  });
});
