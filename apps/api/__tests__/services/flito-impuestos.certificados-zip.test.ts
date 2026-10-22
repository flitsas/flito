// ZIP de certificados RUNT — lo PURO (HU #13205): quién entra, cómo se llama, quién queda fuera y
// por qué, y la forma exacta de `omitidos.csv`. La frontera HTTP va en
// flito-impuestos.certificados-zip.routes.test.ts.

import { describe, it, expect } from 'vitest';
import { CausaCertificadoOmitido } from '@operaciones/shared-types';
import {
  csvOmitidos, planificarZipCertificados,
} from '../../src/modules/flito-impuestos/certificados-zip.js';
import type { CertificacionConRegistro, CertificacionLoteItem } from '../../src/modules/flito-impuestos/certificacion.service.js';

const cert = (impuestoId: string): CertificacionConRegistro => ({
  id: `c-${impuestoId}`, impuestoId, placaConsultada: 'X', documentoConsultado: '1', vinConsultado: null,
  tipoDocPropietario: 'C', propietarioNombre: 'N', campos: [], certificadoPorNombre: 'g', createdAt: '2026-09-01T00:00:00.000Z',
  registroRunt: {
    clasificacion: null, color: null, cilindraje: null, tipoServicio: null, organismoTransito: null,
    estadoAutomotor: null, fechaMatricula: null, numMotor: null, numChasis: null, numSerie: null,
  },
});

const item = (impuestoId: string, placa: string | null, conCert = true, idFlit = `F-${impuestoId}`): CertificacionLoteItem => ({
  impuestoId, placa, idFlit, createdAt: new Date('2026-09-01T00:00:00Z'), cert: conCert ? cert(impuestoId) : null,
});

const U1 = '00000000-0000-4000-8000-000000000001';
const U2 = '00000000-0000-4000-8000-000000000002';
const U3 = '00000000-0000-4000-8000-000000000003';
const U9 = '00000000-0000-4000-8000-000000000009';
const U8 = '00000000-0000-4000-8000-000000000008';

describe('AC1 — nombres de las entradas', () => {
  it('placas repetidas llevan sufijo -2 y -3 en orden de servidor', () => {
    const plan = planificarZipCertificados([U1, U2, U3], [item(U1, 'abc123'), item(U2, 'ABC123'), item(U3, 'ABC-123')]);
    expect(plan.incluidos.map((i) => i.nombre)).toEqual(['ABC123.pdf', 'ABC123-2.pdf', 'ABC123-3.pdf']);
    expect(plan.omitidos).toEqual([]);
  });

  it('el orden de los ids en la petición no cambia los nombres (manda el orden de servidor)', () => {
    const lote = [item(U1, 'ABC123'), item(U2, 'ABC123')];
    const a = planificarZipCertificados([U1, U2], lote);
    const b = planificarZipCertificados([U2, U1], lote);
    expect(b.incluidos.map((i) => [i.impuestoId, i.nombre])).toEqual(a.incluidos.map((i) => [i.impuestoId, i.nombre]));
    expect(a.incluidos.find((i) => i.impuestoId === U2)?.nombre).toBe('ABC123-2.pdf');
  });

  it('un registro sin placa se INCLUYE como SIN-PLACA-<idFlit>.pdf (no se omite)', () => {
    const plan = planificarZipCertificados([U1], [item(U1, null, true, 'FL-777')]);
    expect(plan.incluidos.map((i) => i.nombre)).toEqual(['SIN-PLACA-FL-777.pdf']);
    expect(plan.omitidos).toEqual([]);
  });

  it('el idFlit sale limpio de / y .. en el nombre de fichero', () => {
    const plan = planificarZipCertificados([U1], [item(U1, '', true, '../a/b c')]);
    expect(plan.incluidos[0].nombre).toBe('SIN-PLACA-abc.pdf');
  });
});

describe('AC2 — omitidos con su causa', () => {
  it('autorizado sin certificación → sin_certificacion_vigente con la placa', () => {
    const plan = planificarZipCertificados([U1, U2], [item(U1, 'QIU744', false), item(U2, 'ABC123')]);
    expect(plan.omitidos).toEqual([{ identificador: 'QIU744', causa: CausaCertificadoOmitido.SIN_CERTIFICACION_VIGENTE }]);
    expect(plan.incluidos.map((i) => i.nombre)).toEqual(['ABC123.pdf']);
  });

  it('autorizado sin certificación y sin placa → el idFlit', () => {
    const plan = planificarZipCertificados([U1], [item(U1, null, false, 'FL-9')]);
    expect(plan.omitidos).toEqual([{ identificador: 'FL-9', causa: CausaCertificadoOmitido.SIN_CERTIFICACION_VIGENTE }]);
  });

  it('pedido y no devuelto por la frontera → no_disponible con el uuid enviado, ordenados', () => {
    const plan = planificarZipCertificados([U9, U1, U8], [item(U1, 'ABC123')]);
    expect(plan.omitidos).toEqual([
      { identificador: U8, causa: CausaCertificadoOmitido.NO_DISPONIBLE },
      { identificador: U9, causa: CausaCertificadoOmitido.NO_DISPONIBLE },
    ]);
  });

  it('ids duplicados en la petición cuentan una sola vez', () => {
    const plan = planificarZipCertificados([U9, U9, U1, U1], [item(U1, 'ABC123')]);
    expect(plan.omitidos).toHaveLength(1);
    expect(plan.incluidos).toHaveLength(1);
  });
});

describe('omitidos.csv', () => {
  it('UTF-8 con BOM, cabecera, separador ; y fin de línea CRLF', () => {
    const buf = csvOmitidos([{ identificador: 'QIU744', causa: CausaCertificadoOmitido.SIN_CERTIFICACION_VIGENTE }]);
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(buf.subarray(3).toString('utf8')).toBe('Identificador;Causa\r\nQIU744;sin certificación vigente\r\n');
  });

  it('un valor con ; o comillas va entrecomillado y con las comillas duplicadas', () => {
    const txt = csvOmitidos([{ identificador: 'a;b"c', causa: CausaCertificadoOmitido.NO_DISPONIBLE }]).toString('utf8');
    expect(txt).toContain('\r\n"a;b""c";no disponible\r\n');
  });

  it('un valor que empieza por = se neutraliza con apóstrofo (inyección de fórmulas)', () => {
    const txt = csvOmitidos([{ identificador: '=CMD', causa: CausaCertificadoOmitido.NO_DISPONIBLE }]).toString('utf8');
    expect(txt).toContain("\r\n'=CMD;no disponible\r\n");
  });
});
