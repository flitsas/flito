// Certificación sin trámite: los seis campos deben coincidir. Valores inventados.
import { describe, expect, it } from 'vitest';
import { compararFacturaConRunt } from '../../src/modules/flito-impuestos/flito-impuestos.comparacion-factura-runt.js';
import {
  clasificarFalloRunt, extraccionDesdeDiligenciado, seisCoinciden,
} from '../../src/modules/flito-impuestos/flito-impuestos.certificacion-directa.reglas.js';
import { lineasDatoFlito } from '../../src/modules/flito-impuestos/certificado-directo-pdf.js';

const AHORA = new Date('2026-10-29T15:00:00Z');

function campos(factura: Parameters<typeof extraccionDesdeDiligenciado>[0], runt: {
  vin: string | null; marca: string | null; linea: string | null; modelo: string | null;
  color: string | null; cilindraje: string | null;
}) {
  return compararFacturaConRunt(extraccionDesdeDiligenciado(factura), runt, AHORA).comparacion.campos;
}

const factura = {
  vin: '9ZZTEST0000000001', marca: 'KIA', linea: 'K3', anio: '2024', color: 'BLANCO', cilindrada: '1598',
};

describe('seis campos para certificar', () => {
  it('1598 contra 1600 coincide y los seis juntos alcanzan', () => {
    const c = campos(factura, {
      vin: factura.vin, marca: 'KIA', linea: 'K3', modelo: '2024', color: 'BLANCO', cilindraje: '1600',
    });
    expect(c.find((x) => x.campo === 'cilindrada')?.resultado).toBe('coincide');
    expect(seisCoinciden(c)).toBe(true);
  });

  it('un dato que el RUNT no trae no alcanza, aunque el semáforo de la cola no lo bloquee igual', () => {
    const c = campos(factura, {
      vin: factura.vin, marca: 'KIA', linea: 'K3', modelo: '2024', color: null, cilindraje: '1598',
    });
    expect(c.find((x) => x.campo === 'color')?.resultado).toBe('no_verificable');
    expect(seisCoinciden(c)).toBe(false);
  });

  it('eléctrico: cilindraje 0 contra vacío del RUNT coincide', () => {
    const c = campos(
      { ...factura, cilindrada: '0' },
      { vin: factura.vin, marca: 'KIA', linea: 'K3', modelo: '2024', color: 'BLANCO', cilindraje: '' },
    );
    expect(c.find((x) => x.campo === 'cilindrada')?.resultado).toBe('coincide');
    expect(seisCoinciden(c)).toBe(true);
  });
});

describe('fallo del RUNT', () => {
  it('distingue vehículo ausente de falta de respuesta', () => {
    expect(clasificarFalloRunt('El vehiculo no se encuentra')).toBe('sin_vehiculo');
    expect(clasificarFalloRunt('no existe registro')).toBe('sin_vehiculo');
    expect(clasificarFalloRunt('tiempo de espera agotado')).toBe('sin_respuesta');
  });

  it('el rechazo por propietario (documento que no corresponde) no se reporta como «el RUNT no responde»', () => {
    expect(clasificarFalloRunt('Los datos no corresponden con los propietarios activos del vehículo')).toBe('sin_vehiculo');
  });

  it('un rechazo con HTTP 200 es que el RUNT respondió, aunque el texto no lo diga', () => {
    expect(clasificarFalloRunt('Consulta rechazada', 200)).toBe('sin_vehiculo');
  });

  it('sin HTTP 200 y con un texto desconocido sigue siendo falta de respuesta', () => {
    expect(clasificarFalloRunt('Error comunicando con servicio RUNT', 502)).toBe('sin_respuesta');
    expect(clasificarFalloRunt('Timeout 90s')).toBe('sin_respuesta');
  });
});

describe('PDF', () => {
  it('el documento del propietario queda como dato de FLITO', () => {
    for (const modalidadConsulta of ['vin', 'placa_documento'] as const) {
      const lineas = lineasDatoFlito({
        nombrePropietario: 'Ana Prueba', documento: '100', vin: '9ZZTEST0000000001',
        placa: 'TST001', organismo: '11001', modalidadConsulta,
      });
      const texto = lineas.map((l) => l.join(' ')).join('\n');
      expect(texto).toContain('Documento (dato de FLITO)');
      expect(texto.toLowerCase()).not.toContain('validado');
    }
  });

  it('solo una línea dice qué se consultó, y es la de la modalidad usada', () => {
    const rotulos = (modalidadConsulta: 'vin' | 'placa_documento') => lineasDatoFlito({
      nombrePropietario: null, documento: null, vin: 'V', placa: 'P', organismo: 'O', modalidadConsulta,
    }).map(([k]) => k);
    expect(rotulos('vin')).toEqual(['VIN consultado', 'Placa (dato de FLITO)', 'Organismo (dato de FLITO)']);
    expect(rotulos('placa_documento')).toEqual(['VIN (dato de FLITO)', 'Placa consultada', 'Organismo (dato de FLITO)']);
  });
});
