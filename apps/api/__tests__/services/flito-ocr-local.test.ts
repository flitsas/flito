// FLITO OCR — fallback local. Prueba los PATRONES (función pura camposDesdeTexto) con texto que imita la
// maquetación REAL (lo que devuelve pdftotext -layout): FUAST del SOAT (fechas en orden, valores en
// columnas bajo el encabezado) y "declaración sugerida de impuesto". No toca poppler ni Tesseract.

import { describe, it, expect } from 'vitest';
import { camposDesdeTexto } from '../../src/modules/flito-ocr/flito-ocr-local.js';
import { CampoSoat, CampoImpuesto } from '@operaciones/shared-types';

// SOAT FUAST: 3 fechas del bloque superior en orden (exp, desde, hasta); TOTAL A PAGAR con el monto unas
// filas abajo (por las 2 columnas); "PRIMA SOAT" es un parcial que NO debe confundirse con el total.
const SOAT_TXT = `
FECHA DE EXPEDICION      VIGENCIA
2026-06-01               DESDE 2026-06-02      HASTA 2027-06-01
No. DE POLIZA            PLACA No.             No. VIN
1508006953810000         QTR191                LRWYGCFJ4TC577842
Es obligatorio portar la poliza del SOAT ... La Previsora S.A.
TARIFA   PRIMA SOAT $ 468000   CONTRIBUCION FOSYGA $ 270400
TOTAL A PAGAR                   B. GASTOS DE TRANSPORTE
                               Y MOVILIZACION DE VICTIMAS  8,77
$ 740800                        C. INCAPACIDAD PERMANENTE
`;

// Impuesto: "13 TOTAL A PAGAR $ 634.900" (mismo renglón); ojo "TOTAL A CARGO" (609.000) NO es el total.
const IMP_TXT = `
FORMULARIO No 317093451                 PLACA: PWV046
A.2 FRACCION AÑO
2026
6. TOTAL A CARGO $ 609.000
13 TOTAL A PAGAR $ 634.900
I.2 VALOR PAGADO $ 634.900
FECHA LIMITE PAGO: 07.07.2026
`;

describe('camposDesdeTexto — patrones del fallback local (maquetación real)', () => {
  it('SOAT FUAST: llave, póliza, valor (no la prima) y fechas en orden exp/desde/hasta', () => {
    const campos = [
      CampoSoat.PLACA, CampoSoat.VIN, CampoSoat.NUMERO_POLIZA, CampoSoat.VALOR_TOTAL,
      CampoSoat.ASEGURADORA, CampoSoat.FECHA_EXPEDICION, CampoSoat.VIGENCIA_DESDE, CampoSoat.VIGENCIA_HASTA,
    ];
    const r = camposDesdeTexto(SOAT_TXT, campos);
    expect(r.placa).toMatchObject({ valor: 'QTR191', confianza: 'alta' });
    expect(r.vin).toMatchObject({ valor: 'LRWYGCFJ4TC577842', confianza: 'alta' });
    expect(r.numeroPoliza).toMatchObject({ valor: '1508006953810000', confianza: 'alta' });
    expect(r.valorTotal.valor).toContain('740800'); // TOTAL A PAGAR, no la PRIMA (468000)
    expect(r.valorTotal.valor).not.toContain('468000');
    expect(r.aseguradora.valor).toBe('LA PREVISORA');
    expect(r.fechaExpedicion.valor).toBe('2026-06-01');
    expect(r.vigenciaDesde.valor).toBe('2026-06-02');
    expect(r.vigenciaHasta.valor).toBe('2027-06-01');
  });

  it('Impuesto: placa, TOTAL A PAGAR (no TOTAL A CARGO), formulario, año y fecha con puntos', () => {
    const campos = [
      CampoImpuesto.PLACA, CampoImpuesto.VALOR_TOTAL, CampoImpuesto.NUMERO_RECIBO,
      CampoImpuesto.ANIO_GRAVABLE, CampoImpuesto.FECHA_PAGO,
    ];
    const r = camposDesdeTexto(IMP_TXT, campos);
    expect(r.placa.valor).toBe('PWV046');
    expect(r.valorTotal.valor).toContain('634.900'); // total a pagar
    expect(r.valorTotal.valor).not.toContain('609'); // no el "total a cargo"
    expect(r.numeroRecibo.valor).toBe('317093451');
    expect(r.anioGravable.valor).toBe('2026');
    expect(r.fechaPago.valor).toBe('07.07.2026'); // dd.mm.yyyy (lo normaliza el service)
  });

  it('no inventa: texto sin datos → campos null (a revisión, nunca a un valor quemado)', () => {
    const r = camposDesdeTexto('documento cualquiera sin campos reconocibles', [CampoSoat.PLACA, CampoSoat.VIN, CampoSoat.VALOR_TOTAL]);
    expect(r.placa.valor).toBeNull();
    expect(r.vin.valor).toBeNull();
    expect(r.valorTotal.valor).toBeNull();
  });

  it('placa sin etiqueta pero única → confianza media (no pasa el umbral → revisión)', () => {
    const r = camposDesdeTexto('vehiculo QOX858 registrado', [CampoSoat.PLACA]);
    expect(r.placa).toMatchObject({ valor: 'QOX858', confianza: 'media' });
  });
});
