// HU #12401 — la regla que comparten el alta del canal Cliente, el recorrido de vigencia del SOAT y
// (HU #12402) la certificación de Impuestos: qué va a `vehicles.num_motor` / `num_serie` y qué no.
//
// Se prueba la función PURA a pelo, con un logger falso inyectado: aquí se mide la política («un
// vacío no borra», recorte a la columna, aviso sin PII); que cada recorrido la APLIQUE se mide en
// su propia suite sobre el `set()` / `values()` real (`espia-drizzle`).

import { describe, it, expect, vi } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { vehicles } from '../../src/db/schema.js';
import {
  MAX_MOTOR_SERIE,
  motorYSerieParaVehiculo,
} from '../../src/modules/runt/vehiculo-motor-serie.js';

const log = () => ({ warn: vi.fn() });

describe('AC2 — un vacío no borra: la clave AUSENTE, ni null ni cadena vacía', () => {
  it('con los dos presentes viajan los dos, recortados de espacios', () => {
    expect(motorYSerieParaVehiculo({ numMotor: ' MTR-123 ', numSerie: 'SER-456' }, log()))
      .toEqual({ numMotor: 'MTR-123', numSerie: 'SER-456' });
  });

  it('sin motor ni serie el payload es `{}`: ninguna clave, ni siquiera con null', () => {
    const p = motorYSerieParaVehiculo({ numMotor: null, numSerie: null }, log());
    // MUTANTE — `salida.numMotor = motor ?? null`: `toEqual` ignora claves con `undefined`, así que
    // se afirma sobre las CLAVES y no sobre la igualdad del objeto.
    expect(Object.keys(p)).toEqual([]);
  });

  it('un motor en blanco tampoco viaja, y no arrastra a la serie', () => {
    const p = motorYSerieParaVehiculo({ numMotor: '   ', numSerie: 'SER-456' }, log());
    expect(Object.keys(p)).toEqual(['numSerie']);
  });
});

describe('AC6 — más largo que la columna: se guardan los primeros 50 y se avisa sin el valor', () => {
  const MOTOR_60 = 'M'.repeat(60);

  it('recorta a 50 exactos', () => {
    const p = motorYSerieParaVehiculo({ numMotor: MOTOR_60, numSerie: null }, log());
    expect(p.numMotor).toHaveLength(50);
    expect(p.numMotor).toBe(MOTOR_60.slice(0, 50));
  });

  it('el aviso lleva campo y longitud recibida; NO el valor', () => {
    const l = log();
    motorYSerieParaVehiculo({ numMotor: MOTOR_60, numSerie: null }, l);

    expect(l.warn).toHaveBeenCalledTimes(1);
    const [ctx, msg] = l.warn.mock.calls[0]! as [Record<string, unknown>, string];
    expect(ctx).toEqual({ campo: 'numMotor', longitud: 60, max: 50 });
    // Ni en el contexto ni en el mensaje: el valor no sale por ningún lado.
    expect(JSON.stringify(ctx)).not.toContain('MMMMM');
    expect(msg).not.toContain('MMMMM');
  });

  it('a 50 exactos no recorta ni avisa', () => {
    const l = log();
    const p = motorYSerieParaVehiculo({ numMotor: null, numSerie: 'S'.repeat(50) }, l);
    expect(p.numSerie).toHaveLength(50);
    expect(l.warn).not.toHaveBeenCalled();
  });

  it('el tope es el ANCHO REAL de las dos columnas en el esquema', () => {
    // Un guardián que se separa de su columna no protege de nada (mismo test que MAX_DATOS_VEHICULO).
    const cols = getTableConfig(vehicles).columns;
    const ancho = (nombre: string) => (cols.find((c) => c.name === nombre)!.getSQLType());
    expect(ancho('num_motor')).toBe(`varchar(${MAX_MOTOR_SERIE})`);
    expect(ancho('num_serie')).toBe(`varchar(${MAX_MOTOR_SERIE})`);
  });
});
