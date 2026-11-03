// Certificar sin trámite — contenido del PDF del certificado (desarrollo local de pruebas, sin HU/Bug).
// Se infla el flujo del PDF y se decodifican los `Tj` hexadecimales, igual que flito-impuestos.certificado-pdf.test.ts.
import zlib from 'zlib';
import { describe, it, expect } from 'vitest';
import { construirCertificadoDirectoPdf } from '../../src/modules/flito-impuestos/certificado-directo-pdf.js';

function textoDelPdf(pdf: Buffer): string {
  const trozos: string[] = [];
  let i = 0;
  for (;;) {
    const marca = pdf.indexOf(Buffer.from('stream'), i);
    if (marca === -1) break;
    let ini = marca + 6;
    if (pdf[ini] === 0x0d) ini++;
    if (pdf[ini] === 0x0a) ini++;
    const fin = pdf.indexOf(Buffer.from('endstream'), ini);
    if (fin === -1) break;
    const bruto = pdf.subarray(ini, fin);
    let c: string;
    try { c = zlib.inflateSync(bruto).toString('latin1'); } catch { c = bruto.toString('latin1'); }
    for (const [, hex] of c.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) trozos.push(Buffer.from(hex, 'hex').toString('latin1'));
    i = fin + 9;
  }
  return trozos.join('\n');
}

const campos = (['vin', 'marca', 'linea', 'anio', 'color', 'cilindrada'] as const).map((campo) => ({
  campo, resultado: 'coincide' as const, bloqueante: false, valorFactura: 'X', valorRunt: 'X',
}));

describe('PDF del certificado sin trámite', () => {
  it('es un PDF con los datos de FLITO y sin la línea «Compania»', async () => {
    const pdf = await construirCertificadoDirectoPdf({
      placa: 'ABC123', vin: '9ZZTEST0000000001', documento: '900123456', nombrePropietario: 'Empresa Prueba SAS',
      organismo: 'Bogota', campos, registroRunt: {
        clasificacion: null, color: 'BLANCO', cilindraje: '1598', tipoServicio: null, organismoTransito: null,
        estadoAutomotor: null, fechaMatricula: null, numMotor: null, numChasis: null, numSerie: null,
      },
      certificadoPorNombre: 'gestor@flit.io', certificadoEn: new Date('2026-10-30T12:00:00Z'),
      generadoPor: 'gestor@flit.io', generadoEn: new Date('2026-10-30T13:00:00Z'),
    });
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
});
