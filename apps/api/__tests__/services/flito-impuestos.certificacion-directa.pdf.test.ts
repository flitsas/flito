// Certificar sin trámite — contenido del PDF del certificado.
// Se infla el flujo del PDF y se decodifican los `Tj` hexadecimales, igual que flito-impuestos.certificado-pdf.test.ts.
import { describe, it, expect } from 'vitest';
import {
  construirCertificadoDirectoPdf, type CertificadoDirectoPdfDatos,
} from '../../src/modules/flito-impuestos/certificado-directo-pdf.js';
import { textoDelPdf } from '../helpers/texto-pdf.js';

const campos = (['vin', 'marca', 'linea', 'anio', 'color', 'cilindrada'] as const).map((campo) => ({
  campo, resultado: 'coincide' as const, bloqueante: false, valorFactura: 'X', valorRunt: 'X',
}));

const base: CertificadoDirectoPdfDatos = {
  placa: 'ABC123', vin: '9ZZTEST0000000001', documento: '900123456', nombrePropietario: 'Empresa Prueba SAS',
  modalidadConsulta: 'vin', organismo: 'Bogota', campos, registroRunt: {
    clasificacion: null, color: 'BLANCO', cilindraje: '1598', tipoServicio: null, organismoTransito: null,
    estadoAutomotor: null, fechaMatricula: null, numMotor: null, numChasis: null, numSerie: null,
  },
  certificadoPorNombre: 'gestor@flit.io', certificadoEn: new Date('2026-10-30T12:00:00Z'),
  generadoPor: 'gestor@flit.io', generadoEn: new Date('2026-10-30T13:00:00Z'),
};

describe('PDF del certificado sin trámite', () => {
  it('es un PDF con los datos de FLITO y sin la línea «Compania»', async () => {
    const pdf = await construirCertificadoDirectoPdf(base);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    const t = textoDelPdf(pdf);
    expect(t).toContain('FLITO');
    expect(t).toContain('Nombre (dato de FLITO): Empresa Prueba SAS');
    expect(t).toContain('Documento (dato de FLITO): 900123456');
    expect(t).toContain('VIN consultado: 9ZZTEST0000000001');
    expect(t).toContain('Placa (dato de FLITO): ABC123');
    expect(t).toContain('Organismo (dato de FLITO): Bogota');
    expect(t).toContain('Color: BLANCO');
    expect(t).not.toMatch(/compa[nñ]ia/i);
  });

  it('sin documento ni nombre omite las dos líneas, sin dejar rótulos vacíos ni «null»', async () => {
    const t = textoDelPdf(await construirCertificadoDirectoPdf({ ...base, documento: null, nombrePropietario: null }));
    expect(t).not.toContain('Nombre (dato de FLITO)');
    expect(t).not.toContain('Documento (dato de FLITO)');
    expect(t).not.toContain('null');
    expect(t).toContain('VIN consultado: 9ZZTEST0000000001');
    expect(t).toContain('Placa (dato de FLITO): ABC123');
  });

  it('nombre sin documento omite solo el documento', async () => {
    const t = textoDelPdf(await construirCertificadoDirectoPdf({ ...base, documento: null }));
    expect(t).toContain('Nombre (dato de FLITO): Empresa Prueba SAS');
    expect(t).not.toContain('Documento (dato de FLITO)');
  });

  it('consultado por placa y documento: no afirma que la consulta fue por VIN y el documento sigue como dato de FLITO', async () => {
    const t = textoDelPdf(await construirCertificadoDirectoPdf({ ...base, modalidadConsulta: 'placa_documento' }));
    expect(t).toContain('Placa consultada: ABC123');
    expect(t).toContain('VIN (dato de FLITO): 9ZZTEST0000000001');
    expect(t).toContain('Documento (dato de FLITO): 900123456');
    expect(t).not.toContain('VIN consultado');
    expect(t).not.toContain('Placa (dato de FLITO)');
  });
});
