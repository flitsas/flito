// HU #11296 — qué le falta a un cliente para poder facturarse (Feature #11241).
//
// La evaluación por cliente es una función pura sobre la fila, así que se prueba sin base de datos.
// Lo que más importa probar no es que detecte lo que falta —eso es fácil— sino que **nombre el dato
// exacto** (AC1) y que **separe lo que necesita una decisión de lo que necesita capturar un dato**
// (AC3): son dos listas de trabajo distintas, y mezclarlas hace que nadie empiece por ninguna.

import { describe, it, expect } from 'vitest';
import {
  evaluarCliente, type ClienteEvaluable,
} from '../../src/modules/siigo/siigo.validador-cliente.service.js';

/** Un cliente al que no le falta nada. Cada prueba le quita justo una cosa. */
function completo(cambios: Partial<ClienteEvaluable> = {}): ClienteEvaluable {
  return {
    id: 1,
    name: 'TRANSPORTES 3M S.A.S.',
    document: '900123456',
    personType: 'Company',
    idType: '31',
    fiscalResponsibilities: ['R-99-PN'],
    address: 'Calle 10 # 20-30',
    countryCode: 'Co',
    stateCode: '11',
    cityCode: '11001',
    phoneIndicative: '57',
    phoneNumber: '3001234567',
    contactFirstName: 'Ana',
    contactLastName: 'Ramírez',
    facturacionBloqueos: [],
    ...cambios,
  };
}

const motivosDe = (c: ClienteEvaluable) => evaluarCliente(c).faltantes.map((f) => f.motivo);

describe('el cliente completo es facturable', () => {
  it('sin faltantes', () => {
    const v = evaluarCliente(completo());
    expect(v.facturable).toBe(true);
    expect(v.faltantes).toEqual([]);
    expect(v.pendienteClasificacion).toBe(false);
  });

  it('una persona natural con la partición capturada también', () => {
    const v = evaluarCliente(completo({
      personType: 'Person', idType: '13', name: 'Ana María Ramírez Gómez',
      contactFirstName: 'Ana María', contactLastName: 'Ramírez Gómez',
    }));
    expect(v.facturable).toBe(true);
  });
});

describe('AC1 — se nombra el dato exacto que falta', () => {
  const CASOS: { falta: string; cambio: Partial<ClienteEvaluable>; motivo: string; campo?: string }[] = [
    { falta: 'tipo de identificación', cambio: { idType: null }, motivo: 'id_tipo_faltante', campo: 'idType' },
    { falta: 'identificación', cambio: { document: null }, motivo: 'identificacion_faltante', campo: 'document' },
    { falta: 'responsabilidad fiscal', cambio: { fiscalResponsibilities: [] }, motivo: 'responsabilidad_fiscal_faltante' },
    { falta: 'responsabilidad fiscal (null)', cambio: { fiscalResponsibilities: null }, motivo: 'responsabilidad_fiscal_faltante' },
    { falta: 'dirección', cambio: { address: null }, motivo: 'direccion_faltante', campo: 'address' },
    { falta: 'país', cambio: { countryCode: null }, motivo: 'ubicacion_faltante' },
    { falta: 'departamento', cambio: { stateCode: null }, motivo: 'ubicacion_faltante' },
    { falta: 'ciudad', cambio: { cityCode: null }, motivo: 'ubicacion_faltante' },
    { falta: 'indicativo', cambio: { phoneIndicative: null }, motivo: 'telefono_faltante' },
    { falta: 'número de teléfono', cambio: { phoneNumber: null }, motivo: 'telefono_faltante' },
    { falta: 'contacto', cambio: { contactFirstName: null }, motivo: 'contacto_faltante' },
  ];

  for (const { falta, cambio, motivo, campo } of CASOS) {
    it(`sin ${falta} → ${motivo}`, () => {
      const v = evaluarCliente(completo(cambio));
      expect(v.facturable).toBe(false);
      const encontrado = v.faltantes.find((f) => f.motivo === motivo);
      expect(encontrado).toBeDefined();
      // «Datos incompletos» no le dice a nadie qué corregir.
      expect(encontrado!.detalle.length).toBeGreaterThan(10);
      if (campo) expect(encontrado!.campo).toBe(campo);
    });
  }

  it('los espacios en blanco no cuentan como dato', () => {
    expect(motivosDe(completo({ address: '   ' }))).toContain('direccion_faltante');
  });

  it('varios faltantes se enumeran todos, no solo el primero', () => {
    const v = evaluarCliente(completo({ address: null, contactFirstName: null, phoneNumber: null }));
    expect(v.faltantes.map((f) => f.motivo)).toEqual(
      expect.arrayContaining(['direccion_faltante', 'contacto_faltante', 'telefono_faltante']),
    );
  });
});

describe('AC2 — el nombre se valida según el tipo de persona', () => {
  it('compañía sin razón social → nombre no utilizable', () => {
    const v = evaluarCliente(completo({ name: '   ' }));
    const f = v.faltantes.find((x) => x.motivo === 'nombre_no_utilizable');
    expect(f).toBeDefined();
    // El motivo DISTINGUE los dos casos: aquí habla de razón social.
    expect(f!.detalle).toMatch(/razón social/i);
  });

  it('persona cuyo nombre queda vacío al sanearlo → nombre no utilizable, con otro motivo', () => {
    const v = evaluarCliente(completo({ personType: 'Person', idType: '13', name: '123 456', contactFirstName: null, contactLastName: null }));
    const f = v.faltantes.find((x) => x.motivo === 'nombre_no_utilizable');
    expect(f).toBeDefined();
    expect(f!.detalle).toMatch(/vacío/i);
  });

  it('una razón social con dígitos y siglas NO es un problema', () => {
    // Es el corazón de la HU #11295: aplicarle la limpieza de persona la destruiría.
    expect(motivosDe(completo({ name: 'TRANSPORTES 3M S.A.S.' }))).not.toContain('nombre_no_utilizable');
  });

  it('el nombre no se evalúa si el tipo de persona está sin clasificar', () => {
    // Si no, el fallo del nombre sería siempre el mismo y taparía el motivo real.
    const motivos = motivosDe(completo({ personType: null }));
    expect(motivos).toContain('tipo_persona_sin_clasificar');
    expect(motivos).not.toContain('nombre_no_utilizable');
  });
});

describe('AC3 — lo que necesita una decisión se separa de lo que necesita un dato', () => {
  it('sin tipo de persona → pendiente de clasificación', () => {
    const v = evaluarCliente(completo({ personType: null }));
    expect(v.pendienteClasificacion).toBe(true);
    expect(v.faltantes.map((f) => f.motivo)).toContain('tipo_persona_sin_clasificar');
  });

  it('identificación duplicada → pendiente de clasificación', () => {
    // Solo una persona puede decidir si son el mismo tercero o sucursales distintas.
    const v = evaluarCliente(completo({ facturacionBloqueos: ['identificacion_duplicada'] }));
    expect(v.pendienteClasificacion).toBe(true);
    expect(v.facturable).toBe(false);
  });

  it('partición del nombre sin confirmar → pendiente de clasificación, no dato faltante', () => {
    const v = evaluarCliente(completo({
      personType: 'Person', idType: '13', name: 'Ana María Ramírez Gómez',
      contactFirstName: null, contactLastName: null,
    }));
    expect(v.faltantes.map((f) => f.motivo)).toContain('nombre_particion_sin_confirmar');
    expect(v.pendienteClasificacion).toBe(true);
  });

  it('a quien solo le falta capturar datos NO se le marca como pendiente de clasificación', () => {
    const v = evaluarCliente(completo({ address: null, phoneNumber: null }));
    expect(v.facturable).toBe(false);
    expect(v.pendienteClasificacion).toBe(false);
  });

  it('los bloqueos que dejó la migración se arrastran, no se recalculan', () => {
    // `identificacion_duplicada` necesita mirar a los demás clientes: se confía en el hallazgo de
    // la 0132 en vez de repetir el trabajo por fila.
    expect(motivosDe(completo({ facturacionBloqueos: ['identificacion_duplicada'] })))
      .toContain('identificacion_duplicada');
    expect(motivosDe(completo({ facturacionBloqueos: [] })))
      .not.toContain('identificacion_duplicada');
  });

  it('un bloqueo desconocido de la migración no rompe la evaluación', () => {
    const v = evaluarCliente(completo({ facturacionBloqueos: ['algo_que_no_conocemos'] }));
    expect(v.facturable).toBe(true);
  });
});

describe('el teléfono de siempre no sirve para Siigo', () => {
  it('tener el teléfono viejo lleno no exime del indicativo y el número', () => {
    // `clients.phone` es texto libre: «310 555 1234 ext 2» no tiene una lectura única, así que no
    // se puede partir de forma confiable y no cuenta como dato.
    expect(motivosDe(completo({ phoneIndicative: null, phoneNumber: null })))
      .toContain('telefono_faltante');
  });

  it('con uno solo de los dos tampoco basta', () => {
    expect(motivosDe(completo({ phoneIndicative: '57', phoneNumber: null })))
      .toContain('telefono_faltante');
  });
});

describe('el cliente vacío del todo', () => {
  it('acumula todos los motivos aplicables sin reventar', () => {
    const v = evaluarCliente({
      id: 9, name: null, document: null, personType: null, idType: null,
      fiscalResponsibilities: null, address: null, countryCode: null, stateCode: null,
      cityCode: null, phoneIndicative: null, phoneNumber: null,
      contactFirstName: null, contactLastName: null, facturacionBloqueos: null,
    });
    expect(v.facturable).toBe(false);
    expect(v.pendienteClasificacion).toBe(true);
    expect(v.faltantes.map((f) => f.motivo)).toEqual(expect.arrayContaining([
      'tipo_persona_sin_clasificar', 'id_tipo_faltante', 'identificacion_faltante',
      'responsabilidad_fiscal_faltante', 'direccion_faltante', 'ubicacion_faltante',
      'telefono_faltante', 'contacto_faltante',
    ]));
    // Cada motivo aparece UNA vez: una lista con repetidos no se puede leer.
    const motivos = v.faltantes.map((f) => f.motivo);
    expect(new Set(motivos).size).toBe(motivos.length);
  });
});
