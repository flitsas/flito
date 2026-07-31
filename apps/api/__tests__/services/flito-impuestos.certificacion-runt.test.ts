// Certificación de impuestos contra el RUNT — motor de comparación (HU #11164).
//
// El motor es puro a propósito, así que estos tests no montan servidor, no tocan BD y no llaman al
// RUNT: le pasan dos juegos de datos y comprueban el veredicto. Es la única forma de cubrir estas
// reglas en CI, donde el RUNT no es invocable (captcha de pago en modo directo, 90 s de timeout).
//
// Un caso por AC de la HU.

import { describe, it, expect } from 'vitest';
import { CampoCertificacion, ResultadoCampo, type DatosVehiculoFlito } from '@operaciones/shared-types';
import {
  compararConRunt,
  esTraspasoEnSincronizacion,
  extraerVehiculoRunt,
  normalizarIdentificador,
  normalizarTexto,
} from '../../src/modules/flito-impuestos/certificacion-runt.js';

const FLITO: DatosVehiculoFlito = {
  placa: 'QIU744',
  vin: '9BWZZZ377VT004251',
  marca: 'CHEVROLET',
  linea: 'SPARK GT',
  modelo: '2018',
  clase: 'AUTOMOVIL',
};

/** Respuesta RUNT que coincide en todo, con la forma real `{ vehiculo, tipoDocPropietario, … }`. */
const runtOk = (over: Record<string, unknown> = {}) => ({
  vehiculo: {
    placa: 'QIU744',
    vin: '9BWZZZ377VT004251',
    marca: 'CHEVROLET',
    linea: 'SPARK GT',
    modelo: '2018',
    claseVehiculo: 'AUTOMOVIL',
    ...over,
  },
  tipoDocPropietario: 'C',
});

const campo = (v: ReturnType<typeof compararConRunt>, c: CampoCertificacion) =>
  v.campos.find((x) => x.campo === c)!;

describe('AC1 — coincidencia en los campos comparables', () => {
  it('certifica cuando placa y VIN coinciden', () => {
    const v = compararConRunt(FLITO, extraerVehiculoRunt(runtOk()));

    expect(v.certificable).toBe(true);
    expect(v.diferenciasBloqueantes).toEqual([]);
    expect(campo(v, CampoCertificacion.PLACA).resultado).toBe(ResultadoCampo.COINCIDE);
    expect(campo(v, CampoCertificacion.VIN).resultado).toBe(ResultadoCampo.COINCIDE);
  });

  it('marca como bloqueantes solo placa y VIN', () => {
    const v = compararConRunt(FLITO, extraerVehiculoRunt(runtOk()));
    const bloqueantes = v.campos.filter((c) => c.bloqueante).map((c) => c.campo);

    expect(bloqueantes).toEqual([CampoCertificacion.PLACA, CampoCertificacion.VIN]);
  });
});

describe('AC2 — campo bloqueante distinto', () => {
  it('no certifica y señala el campo con ambos valores', () => {
    const v = compararConRunt(FLITO, extraerVehiculoRunt(runtOk({ placa: 'XYZ999' })));

    expect(v.certificable).toBe(false);
    expect(v.diferenciasBloqueantes).toHaveLength(1);

    const placa = v.diferenciasBloqueantes[0];
    expect(placa.campo).toBe(CampoCertificacion.PLACA);
    expect(placa.valorFlito).toBe('QIU744');
    expect(placa.valorRunt).toBe('XYZ999');
  });

  it('un VIN distinto también impide certificar', () => {
    const v = compararConRunt(FLITO, extraerVehiculoRunt(runtOk({ vin: '1HGBH41JXMN109186' })));

    expect(v.certificable).toBe(false);
    expect(campo(v, CampoCertificacion.VIN).resultado).toBe(ResultadoCampo.DIFIERE);
  });
});

describe('AC3 — normalización antes de comparar', () => {
  it('ignora guiones, espacios y minúsculas en la placa', () => {
    const flito = { ...FLITO, placa: 'qiu-744' };
    const v = compararConRunt(flito, extraerVehiculoRunt(runtOk({ placa: ' QIU 744 ' })));

    expect(campo(v, CampoCertificacion.PLACA).resultado).toBe(ResultadoCampo.COINCIDE);
    expect(v.certificable).toBe(true);
  });

  it('conserva el valor legible en el detalle, no el normalizado', () => {
    const flito = { ...FLITO, placa: 'qiu-744' };
    const v = compararConRunt(flito, extraerVehiculoRunt(runtOk({ placa: ' QIU 744 ' })));

    // El detalle es para que una persona lea qué había a cada lado; guardar el normalizado
    // escondería justamente la diferencia de formato que puede estar explicando un problema.
    // El lado FLITO va tal cual sale de la base; el del RUNT llega recortado de la extracción,
    // porque el espaciado de borde de su payload es ruido y no dice nada de los datos.
    expect(campo(v, CampoCertificacion.PLACA).valorFlito).toBe('qiu-744');
    expect(campo(v, CampoCertificacion.PLACA).valorRunt).toBe('QIU 744');
  });

  it('normalizarIdentificador y normalizarTexto tratan las tildes distinto', () => {
    expect(normalizarIdentificador('abc-123')).toBe('ABC123');
    expect(normalizarIdentificador('   ')).toBeNull();
    expect(normalizarTexto('  Automóvil   familiar ')).toBe('AUTOMOVIL FAMILIAR');
    expect(normalizarTexto(null)).toBeNull();
  });
});

describe('AC4 — VIN ausente en la respuesta RUNT', () => {
  it('lo marca no verificable y NO bloquea la certificación', () => {
    const sinVin = runtOk();
    delete (sinVin.vehiculo as Record<string, unknown>).vin;

    const v = compararConRunt(FLITO, extraerVehiculoRunt(sinVin));

    expect(campo(v, CampoCertificacion.VIN).resultado).toBe(ResultadoCampo.NO_VERIFICABLE);
    expect(campo(v, CampoCertificacion.VIN).valorRunt).toBeNull();
    expect(v.certificable).toBe(true);
  });

  it('lo rescata de datosTecnicos si no viene en vehiculo', () => {
    const sinVin = runtOk() as Record<string, unknown>;
    delete (sinVin.vehiculo as Record<string, unknown>).vin;
    sinVin.datosTecnicos = { numeroSerie: '9BWZZZ377VT004251' };

    const v = compararConRunt(FLITO, extraerVehiculoRunt(sinVin));

    expect(campo(v, CampoCertificacion.VIN).resultado).toBe(ResultadoCampo.COINCIDE);
  });

  it('un "null" de texto del RUNT cuenta como ausente, no como valor', () => {
    const v = compararConRunt(FLITO, extraerVehiculoRunt(runtOk({ vin: 'null' })));

    expect(campo(v, CampoCertificacion.VIN).resultado).toBe(ResultadoCampo.NO_VERIFICABLE);
    expect(v.certificable).toBe(true);
  });

  it('si FLITO no tiene VIN, se distingue de que no lo reporte el RUNT', () => {
    const v = compararConRunt({ ...FLITO, vin: null }, extraerVehiculoRunt(runtOk()));

    expect(campo(v, CampoCertificacion.VIN).resultado).toBe(ResultadoCampo.SIN_DATO_FLITO);
    expect(v.certificable).toBe(true);
  });
});

describe('AC5 — campos informativos no bloquean', () => {
  it('certifica aunque la marca difiera', () => {
    const v = compararConRunt(FLITO, extraerVehiculoRunt(runtOk({ marca: 'CHEVROLET (GM)' })));

    expect(v.certificable).toBe(true);
    expect(campo(v, CampoCertificacion.MARCA).resultado).toBe(ResultadoCampo.DIFIERE);
    expect(campo(v, CampoCertificacion.MARCA).bloqueante).toBe(false);
    expect(v.diferenciasBloqueantes).toEqual([]);
  });

  it('la diferencia informativa queda registrada para el certificado', () => {
    const v = compararConRunt(FLITO, extraerVehiculoRunt(runtOk({ marca: 'CHEVROLET (GM)' })));
    const marca = campo(v, CampoCertificacion.MARCA);

    expect(marca.valorFlito).toBe('CHEVROLET');
    expect(marca.valorRunt).toBe('CHEVROLET (GM)');
  });

  it('la clase se lee tanto de claseVehiculo como de clase', () => {
    const conAlias = { vehiculo: { ...runtOk().vehiculo, claseVehiculo: undefined, clase: 'AUTOMOVIL' } };
    const v = compararConRunt(FLITO, extraerVehiculoRunt(conAlias));

    expect(campo(v, CampoCertificacion.CLASE).resultado).toBe(ResultadoCampo.COINCIDE);
  });
});

describe('extracción de la respuesta cruda', () => {
  it('acepta la placa por su alias noPlaca', () => {
    const alias = { vehiculo: { ...runtOk().vehiculo, placa: undefined, noPlaca: 'QIU744' } };

    expect(extraerVehiculoRunt(alias).placa).toBe('QIU744');
  });

  it('no revienta con una respuesta vacía o nula', () => {
    expect(extraerVehiculoRunt(undefined).placa).toBeNull();
    expect(extraerVehiculoRunt({}).vin).toBeNull();
    expect(extraerVehiculoRunt({ vehiculo: null }).marca).toBeNull();
  });

  it('con una respuesta vacía nada es verificable y por tanto nada bloquea', () => {
    const v = compararConRunt(FLITO, extraerVehiculoRunt({}));

    expect(v.campos.every((c) => c.resultado === ResultadoCampo.NO_VERIFICABLE)).toBe(true);
    // Ojo: no certifica "porque sí" — el servicio solo llega aquí si el RUNT respondió OK, que es
    // la prueba de propiedad (RN-02). Una respuesta OK pero vacía deja constancia de que no se pudo
    // verificar ningún campo, y eso es lo que el certificado debe mostrar.
    expect(v.certificable).toBe(true);
  });
});

describe('RN-08 — traspaso reciente en sincronización', () => {
  it('reconoce el rechazo del RUNT por propietario', () => {
    expect(esTraspasoEnSincronizacion('El documento no corresponde al propietario del vehículo')).toBe(true);
    expect(esTraspasoEnSincronizacion('PROPIETARIO NO COINCIDE')).toBe(true);
  });

  it('no confunde un fallo genérico con un traspaso en sincronización', () => {
    expect(esTraspasoEnSincronizacion('Error comunicando con servicio RUNT')).toBe(false);
    expect(esTraspasoEnSincronizacion('Timeout 90s')).toBe(false);
    expect(esTraspasoEnSincronizacion(null)).toBe(false);
    expect(esTraspasoEnSincronizacion(undefined)).toBe(false);
  });
});
