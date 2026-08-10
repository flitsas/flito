// HU #11295 — cómo se arma el `name` que se le envía a Siigo (Feature #11241).
//
// AC6 pide explícitamente que las DOS ramas queden probadas. No es un formalismo: el error natural
// aquí es aplicarle a una razón social la limpieza pensada para un nombre propio, y el resultado no
// se nota en una prueba manual —«TRANSPORTES M SAS» parece un nombre razonable— sino en la factura
// que sale impresa ante la DIAN.

import { describe, it, expect } from 'vitest';
import {
  armarNombreSiigo, limpiarNombrePersona, nombreListoParaFacturar, proponerParticion,
} from '../../src/modules/siigo/siigo.nombre.js';

/** Atajo: el arreglo `name` de un caso que debe salir bien. */
function nombreDe(entrada: Parameters<typeof armarNombreSiigo>[0]): string[] {
  const r = armarNombreSiigo(entrada);
  if (!r.ok) throw new Error(`esperaba éxito y falló: ${r.motivo}`);
  return r.valor.name;
}

describe('AC1 — compañía: un solo elemento, íntegro', () => {
  it('conserva los dígitos y las siglas de la razón social', () => {
    // El caso que da nombre a toda la HU. Con la limpieza de persona quedaría «TRANSPORTES M SAS».
    expect(nombreDe({ personType: 'Company', name: 'TRANSPORTES 3M S.A.S.' }))
      .toEqual(['TRANSPORTES 3M S.A.S.']);
  });

  it('devuelve UN elemento, no dos', () => {
    expect(nombreDe({ personType: 'Company', name: 'Stark Industries' })).toHaveLength(1);
  });

  it('conserva puntos, comas y el signo &', () => {
    expect(nombreDe({ personType: 'Company', name: 'García, Pérez & Cía. Ltda.' }))
      .toEqual(['García, Pérez & Cía. Ltda.']);
  });

  it('conserva un nombre que es solo dígitos', () => {
    // «3M» existe. Quitarle los dígitos la dejaría vacía y no facturable sin motivo real.
    expect(nombreDe({ personType: 'Company', name: '3M' })).toEqual(['3M']);
  });

  it('solo colapsa los espacios sobrantes', () => {
    expect(nombreDe({ personType: 'Company', name: '  ACME   S.A.S.  ' })).toEqual(['ACME S.A.S.']);
  });

  it('ignora los campos de contacto: no son la razón social', () => {
    expect(nombreDe({
      personType: 'Company', name: 'ACME S.A.S.',
      contactFirstName: 'Ana', contactLastName: 'Ramírez',
    })).toEqual(['ACME S.A.S.']);
  });

  it('una compañía sin razón social se declara, no se rellena (AC4)', () => {
    const r = armarNombreSiigo({ personType: 'Company', name: '   ' });
    expect(r).toMatchObject({ ok: false, motivo: 'razon_social_vacia' });
  });

  it('está lista para facturar sin que nadie confirme nada', () => {
    expect(nombreListoParaFacturar({ personType: 'Company', name: 'ACME S.A.S.' })).toBe(true);
  });
});

describe('AC2 — persona natural: dos elementos y saneada', () => {
  it('separa nombres y apellidos', () => {
    expect(nombreDe({ personType: 'Person', name: 'Marcos Castillo' })).toEqual(['Marcos', 'Castillo']);
  });

  it('con cuatro palabras, los dos últimos son los apellidos', () => {
    expect(nombreDe({ personType: 'Person', name: 'Ana María Ramírez Gómez' }))
      .toEqual(['Ana María', 'Ramírez Gómez']);
  });

  it('elimina los dígitos', () => {
    expect(nombreDe({ personType: 'Person', name: 'Juan2 Pérez3' })).toEqual(['Juan', 'Pérez']);
  });

  it('conserva tildes y ñ: son parte del nombre legal', () => {
    expect(nombreDe({ personType: 'Person', name: 'José Muñoz' })).toEqual(['José', 'Muñoz']);
  });

  it('conserva el guion de un apellido compuesto', () => {
    expect(nombreDe({ personType: 'Person', name: 'Ana García-López' })).toEqual(['Ana', 'García-López']);
  });

  it("conserva el apóstrofo de D'Angelo", () => {
    expect(nombreDe({ personType: 'Person', name: "Marco D'Angelo" })).toEqual(['Marco', "D'Angelo"]);
  });

  it('quita los caracteres que Siigo rechaza', () => {
    expect(nombreDe({ personType: 'Person', name: 'Juan# Pérez@' })).toEqual(['Juan', 'Pérez']);
    expect(limpiarNombrePersona('Juan #Pérez@ (el mayor)')).toBe('Juan Pérez el mayor');
  });

  it('colapsa los espacios múltiples', () => {
    expect(nombreDe({ personType: 'Person', name: '  Ana    Ramírez  ' })).toEqual(['Ana', 'Ramírez']);
  });

  it('la partición capturada MANDA sobre la deducida', () => {
    // Si alguien se tomó el trabajo de separarlos, el sistema no vuelve a adivinar.
    const r = armarNombreSiigo({
      personType: 'Person', name: 'Ana María Ramírez Gómez',
      contactFirstName: 'Ana María', contactLastName: 'Ramírez Gómez',
    });
    expect(r).toMatchObject({ ok: true, valor: { particionPropuesta: false } });
  });

  it('la partición capturada también se sanea', () => {
    expect(nombreDe({
      personType: 'Person', name: 'x',
      contactFirstName: 'Ana2', contactLastName: 'Ramírez9',
    })).toEqual(['Ana', 'Ramírez']);
  });

  it('con solo uno de los dos campos capturados, se vuelve a deducir del nombre completo', () => {
    const r = armarNombreSiigo({
      personType: 'Person', name: 'Ana María Ramírez Gómez', contactFirstName: 'Ana María',
    });
    expect(r).toMatchObject({ ok: true, valor: { name: ['Ana María', 'Ramírez Gómez'], particionPropuesta: true } });
  });
});

describe('AC3 — la partición se propone, no se impone', () => {
  it('lo deducido viaja marcado como propuesta', () => {
    const r = armarNombreSiigo({ personType: 'Person', name: 'Marcos Castillo' });
    expect(r).toMatchObject({ ok: true, valor: { particionPropuesta: true } });
  });

  it('una propuesta NO deja al cliente listo para facturar', () => {
    // Es una deducción del sistema sobre el nombre legal de una persona, y sale impresa ante la
    // DIAN. Tiene que confirmarla alguien.
    expect(nombreListoParaFacturar({ personType: 'Person', name: 'Marcos Castillo' })).toBe(false);
  });

  it('la partición confirmada sí lo deja listo', () => {
    expect(nombreListoParaFacturar({
      personType: 'Person', name: 'Marcos Castillo',
      contactFirstName: 'Marcos', contactLastName: 'Castillo',
    })).toBe(true);
  });

  it('proponerParticion deja los dos últimos tokens como apellidos', () => {
    expect(proponerParticion('Ana María Ramírez Gómez')).toEqual({ nombres: 'Ana María', apellidos: 'Ramírez Gómez' });
    expect(proponerParticion('Marcos Castillo')).toEqual({ nombres: 'Marcos', apellidos: 'Castillo' });
    expect(proponerParticion('Juan Pérez Gómez')).toEqual({ nombres: 'Juan', apellidos: 'Pérez Gómez' });
  });

  it('proponerParticion no inventa nada con una sola palabra', () => {
    expect(proponerParticion('Madonna')).toBeNull();
  });
});

describe('AC4 — un nombre irrecuperable se declara', () => {
  it('un nombre que queda vacío tras sanear se reporta con su motivo', () => {
    const r = armarNombreSiigo({ personType: 'Person', name: '123 456' });
    expect(r).toMatchObject({ ok: false, motivo: 'nombre_vacio_tras_saneamiento' });
    if (!r.ok) expect(r.detalle).toMatch(/queda vacío/);
  });

  it('una persona con una sola palabra no recibe un apellido inventado', () => {
    // Repetir la palabra sería una afirmación falsa sobre la identidad de alguien.
    const r = armarNombreSiigo({ personType: 'Person', name: 'Madonna' });
    expect(r).toMatchObject({ ok: false, motivo: 'apellidos_faltantes' });
  });

  it('nunca se devuelve un texto de relleno', () => {
    for (const caso of ['', '   ', '999', null, undefined]) {
      const r = armarNombreSiigo({ personType: 'Person', name: caso });
      expect(r.ok).toBe(false);
      // Un «NO REPORTA» enviado a Siigo es una afirmación ante la DIAN que nadie autorizó.
      expect(JSON.stringify(r)).not.toMatch(/NO REPORTA|N\/A|SIN NOMBRE/i);
    }
  });
});

describe('AC5 — el tipo de persona manda', () => {
  for (const tipo of [null, undefined, '', 'Empresa', 'PERSON', 'natural']) {
    it(`tipo ${JSON.stringify(tipo)} → falla explicando que no está clasificado`, () => {
      const r = armarNombreSiigo({ personType: tipo, name: 'ACME S.A.S.' });
      expect(r).toMatchObject({ ok: false, motivo: 'tipo_persona_sin_clasificar' });
    });
  }

  it('NO se asume compañía por ser lo más frecuente', () => {
    // Es el atajo tentador: la mayoría de la cartera son NIT. Asumirlo mandaría la razón social sin
    // sanear de alguien que en realidad es persona natural.
    const r = armarNombreSiigo({ personType: null, name: 'TRANSPORTES 3M S.A.S.' });
    expect(r.ok).toBe(false);
  });

  it('sin clasificar tampoco está listo para facturar', () => {
    expect(nombreListoParaFacturar({ personType: null, name: 'ACME' })).toBe(false);
  });
});

describe('límites', () => {
  it('cada elemento se recorta a 100 caracteres', () => {
    const largo = 'A'.repeat(250);
    expect(nombreDe({ personType: 'Company', name: largo })[0]).toHaveLength(100);
  });

  it('el recorte cuenta caracteres, no bytes', () => {
    const conTildes = 'Á'.repeat(150);
    expect([...nombreDe({ personType: 'Company', name: conTildes })[0]!]).toHaveLength(100);
  });

  it('limpiarNombrePersona no toca lo que ya está limpio', () => {
    expect(limpiarNombrePersona('Ana Ramírez')).toBe('Ana Ramírez');
  });
});
