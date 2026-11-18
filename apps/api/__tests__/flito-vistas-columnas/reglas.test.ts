// ADR-0043: reglas puras de vistas de columnas (resolución, proyección por permiso, validación de claves)
// y catálogo de flito-tramites. Sin base de datos.
import { describe, expect, it } from 'vitest';
import {
  clavesRechazadas, columnasEfectivas, resolverVistaActiva,
} from '../../src/modules/flito-vistas-columnas/flito-vistas-columnas.reglas.js';
import {
  funcionesDeColumnas, obtenerTablaVistas, TABLAS_VISTAS,
} from '../../src/modules/flito-vistas-columnas/flito-vistas-columnas.catalogo.js';
import { crearVistaSchema, predeterminadaSchema } from '../../src/modules/flito-vistas-columnas/flito-vistas-columnas.schemas.js';

const tabla = TABLAS_VISTAS['flito-tramites'];
const SIN_PII = new Set<string>();
const CON_PII = new Set<string>(['tramites.cola.ver']);

describe('catálogo flito-tramites', () => {
  it('lista las 15 columnas en el orden acordado, con tramite como única fija', () => {
    expect(tabla.columnas.map((c) => c.clave)).toEqual([
      'tramite', 'fuente', 'creado', 'aprobado', 'vehiculo', 'comprador', 'correo', 'empresa_gestora',
      'transito', 'ciudad', 'soat', 'impuestos', 'logistica', 'derechos_transito', 'soportes',
    ]);
    expect(tabla.columnas.filter((c) => c.fija).map((c) => c.clave)).toEqual(['tramite']);
  });

  it('marca como PII comprador (etiqueta «Propietario») y correo, ambos con la función de la tabla', () => {
    const pii = tabla.columnas.filter((c) => c.pii).map((c) => c.clave);
    expect(pii).toEqual(['comprador', 'correo']);
    expect(tabla.columnas.find((c) => c.clave === 'comprador')?.etiqueta).toBe('Propietario');
    expect(funcionesDeColumnas(tabla)).toEqual(['tramites.cola.ver']);
  });

  it('la vista del sistema son todas las columnas en el orden de la tabla', () => {
    expect(tabla.columnasSistema).toEqual(tabla.columnas.map((c) => c.clave));
  });

  it('no resuelve claves heredadas del prototipo ni tablas desconocidas', () => {
    expect(obtenerTablaVistas('flito-tramites')).toBe(tabla);
    expect(obtenerTablaVistas('__proto__')).toBeUndefined();
    expect(obtenerTablaVistas('constructor')).toBeUndefined();
    expect(obtenerTablaVistas('otra-tabla')).toBeUndefined();
  });
});

describe('proyección por permiso (RN-VC2, RN-VC4)', () => {
  it('sin permiso de PII, comprador y correo se quitan aunque la vista los guarde', () => {
    const ef = columnasEfectivas(['vehiculo', 'comprador', 'correo', 'fuente'], tabla.columnas, SIN_PII);
    expect(ef).toEqual(['tramite', 'vehiculo', 'fuente']);
  });

  it('con permiso, la columna aparece sin reescribir la vista', () => {
    const ef = columnasEfectivas(['vehiculo', 'comprador', 'correo'], tabla.columnas, CON_PII);
    expect(ef).toEqual(['tramite', 'vehiculo', 'comprador', 'correo']);
  });

  it('la columna fija siempre va primera, aunque la vista no la liste', () => {
    expect(columnasEfectivas(['soat'], tabla.columnas, SIN_PII)).toEqual(['tramite', 'soat']);
  });

  it('elimina duplicados y claves que no existen', () => {
    expect(columnasEfectivas(['fuente', 'fuente', 'inventada'], tabla.columnas, SIN_PII)).toEqual(['tramite', 'fuente']);
  });
});

describe('validación de claves al guardar (RN-VC3)', () => {
  it('separa claves desconocidas de no permitidas', () => {
    const r = clavesRechazadas(['correo', 'no_existe', 'fuente'], tabla.columnas, SIN_PII);
    expect(r.desconocidas).toEqual(['no_existe']);
    expect(r.noPermitidas).toEqual(['correo']);
  });

  it('con permiso no rechaza las PII', () => {
    const r = clavesRechazadas(['correo', 'comprador'], tabla.columnas, CON_PII);
    expect(r).toEqual({ desconocidas: [], noPermitidas: [] });
  });
});

describe('resolución de la vista activa (RN-VC1, RN-VC6)', () => {
  const personales = new Set([10]);
  const compartidas = new Set([20]);

  it('sin punteros rige el sistema', () => {
    expect(resolverVistaActiva(undefined, undefined, personales, compartidas)).toEqual({ origen: 'sistema', vistaId: null });
  });

  it('el puntero personal gana sobre la general', () => {
    expect(resolverVistaActiva({ vistaId: 10 }, { vistaId: 20 }, personales, compartidas))
      .toEqual({ origen: 'personal', vistaId: 10 });
  });

  it('sin personal, rige la general', () => {
    expect(resolverVistaActiva(undefined, { vistaId: 20 }, personales, compartidas))
      .toEqual({ origen: 'general', vistaId: 20 });
  });

  it('«Restablecer» (personal a NULL) gana sobre la general', () => {
    expect(resolverVistaActiva({ vistaId: null }, { vistaId: 20 }, personales, compartidas))
      .toEqual({ origen: 'sistema', vistaId: null });
  });

  it('un puntero personal a una vista que no es suya no se usa (cae a la general)', () => {
    expect(resolverVistaActiva({ vistaId: 99 }, { vistaId: 20 }, personales, compartidas))
      .toEqual({ origen: 'general', vistaId: 20 });
  });

  it('un puntero general a una vista personal no se usa', () => {
    expect(resolverVistaActiva(undefined, { vistaId: 10 }, personales, compartidas))
      .toEqual({ origen: 'sistema', vistaId: null });
  });
});

describe('esquemas Zod (límites ADR-0043)', () => {
  it('acepta hasta 30 columnas y rechaza 31 o repetidas', () => {
    const treinta = Array.from({ length: 30 }, (_, i) => `c${i}`);
    expect(crearVistaSchema.safeParse({ nombre: 'a', alcance: 'personal', columnas: treinta }).success).toBe(true);
    expect(crearVistaSchema.safeParse({ nombre: 'a', alcance: 'personal', columnas: [...treinta, 'x'] }).success).toBe(false);
    expect(crearVistaSchema.safeParse({ nombre: 'a', alcance: 'personal', columnas: ['f', 'f'] }).success).toBe(false);
  });

  it('el nombre va de 1 a 60 caracteres y el alcance es personal o compartida', () => {
    expect(crearVistaSchema.safeParse({ nombre: '', alcance: 'personal', columnas: ['a'] }).success).toBe(false);
    expect(crearVistaSchema.safeParse({ nombre: 'x'.repeat(61), alcance: 'personal', columnas: ['a'] }).success).toBe(false);
    expect(crearVistaSchema.safeParse({ nombre: 'ok', alcance: 'sistema', columnas: ['a'] }).success).toBe(false);
  });

  it('predeterminada admite null (restablecer) y rechaza ids no positivos', () => {
    expect(predeterminadaSchema.safeParse({ vistaId: null }).success).toBe(true);
    expect(predeterminadaSchema.safeParse({ vistaId: 0 }).success).toBe(false);
  });
});
