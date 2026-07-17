import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('PDF local F2', () => {
  beforeAll(() => {
    process.env.PDF_MODE = 'local';
    process.env.CEA_DOCS_PROXY_ENABLED = 'false';
  });

  it('genera improntas con hash', async () => {
    const { generarImprontasPdf } = await import('../../src/modules/tramites/docs/pdf-improntas.js');
    const r = await generarImprontasPdf({ placa: 'ABC123', marca: 'TOYOTA', linea: 'COROLLA', modelo: '2020', numMotor: 'M123', numChasis: 'C456', numSerie: 'VIN78901234567890' });
    expect(r.ok).toBe(true);
    expect(r.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(r.pdf).toMatch(/^data:application\/pdf;base64,/);
  });

  it('genera contrato PDF buffer', async () => {
    const { generarContratoPdf } = await import('../../src/modules/tramites/docs/pdf-contrato.js');
    const buf = await generarContratoPdf({
      vehiculo: { placa: 'ABC123', marca: 'TOYOTA', linea: 'COROLLA', modelo: '2020' },
      vendedor: { nombre: 'Juan Perez', documento: '80123456', tipoDoc: 'CC' },
      comprador: { nombre: 'Maria Lopez', documento: '52987654', tipoDoc: 'CC' },
      valorVenta: 45000000,
      orgNombre: 'STT Medellin', orgCiudad: 'Medellin',
      firmantes: [{ parte: 'VENDEDOR', nombre: 'Juan Perez', documento: '80123456', firma_serie: 'KYV-FEA-TEST-001', firma_hash: 'abc', firma_timestamp: new Date().toISOString() }],
    });
    expect(buf.length).toBeGreaterThan(5000);
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('genera FUR si existe plantilla', async () => {
    const tpl = path.join(process.cwd(), 'apps/api/templates/ftrunt.pdf');
    if (!fs.existsSync(tpl)) return;
    const { generarFurPdf } = await import('../../src/modules/tramites/docs/pdf-fur.js');
    const buf = await generarFurPdf({
      vehiculo: { placa: 'ABC123', marca: 'TOYOTA', linea: 'COROLLA', modelo: '2020', clase: 'AUTOMOVIL', tipoCombustible: 'GASOLINA', numMotor: 'M1', numChasis: 'C1', vin: 'VIN123' },
      comprador: { nombre: 'Maria Lopez Garcia', documento: '52987654', tipoDoc: 'CC', direccion: 'Calle 1', ciudad: 'Medellin', telefono: '3001234567' },
      orgVehiculoNombre: 'STRIA TTEyTTO MEDELLIN', orgVehiculoCiudad: 'Medellin',
      regrabado: { motor: 'NO', chasis: 'NO', serie: 'NO' },
    });
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });
});
