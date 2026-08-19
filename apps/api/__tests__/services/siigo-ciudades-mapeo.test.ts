// HU #11294 — proponer a qué ciudad del catálogo corresponde el texto libre del cliente.
//
// Lo que más importa probar aquí NO es que acierte, sino que **no invente**: que una coincidencia
// aproximada nunca se presente como exacta, que un homónimo se declare ambiguo en vez de elegir uno,
// y que un texto que no es una ciudad se quede sin equivalencia en vez de encontrarle un parecido.
// Un municipio equivocado sale impreso en una factura ante la DIAN.

import { describe, it, expect } from 'vitest';
import {
  distanciaEdicion, normalizarParaComparar, proponerCiudad, type CiudadCatalogo,
} from '../../src/modules/siigo/siigo.ciudades-mapeo.service.js';

function ciudad(cityName: string, stateCode: string, stateName: string, cityCode: string): CiudadCatalogo {
  return {
    countryCode: 'Co', stateCode, stateName, cityCode, cityName,
    cityBusqueda: cityName.toLowerCase(),
  };
}

const CATALOGO: CiudadCatalogo[] = [
  ciudad('Bogotá', '11', 'Bogotá D.C', '11001'),
  ciudad('Medellín', '05', 'Antioquia', '05001'),
  ciudad('Cali', '76', 'Valle del Cauca', '76001'),
  ciudad('Barranquilla', '08', 'Atlántico', '08001'),
  // Homónimos reales: el mismo nombre en departamentos distintos.
  ciudad('La Unión', '05', 'Antioquia', '05400'),
  ciudad('La Unión', '76', 'Valle del Cauca', '76400'),
  ciudad('La Unión', '52', 'Nariño', '52399'),
];

describe('AC5 — el texto se normaliza antes de comparar', () => {
  it('las tres formas de escribir Bogotá proponen la misma ciudad', () => {
    for (const texto of ['BOGOTA D.C.', 'bogotá d c', 'Bogotá', '  bogota  ']) {
      const p = proponerCiudad(texto, CATALOGO);
      expect(p.certeza).toBe('exacta');
      expect(p.candidatas[0]!.cityCode).toBe('11001');
    }
  });

  it('ignora tildes, mayúsculas y puntuación', () => {
    expect(normalizarParaComparar('MEDELLÍN, ANT.')).toBe('medellin ant');
    expect(normalizarParaComparar('  Cali  ')).toBe('cali');
  });

  it('quita el sufijo de distrito capital solo al final', () => {
    expect(normalizarParaComparar('Bogota DC')).toBe('bogota');
    expect(normalizarParaComparar('Bogota Distrito Capital')).toBe('bogota');
    // Y no mutila un nombre que legítimamente lo contenga en otra posición.
    expect(normalizarParaComparar('DC Ciudad')).toBe('dc ciudad');
  });
});

describe('AC1 — la propuesta trae la coincidencia y su certeza', () => {
  it('el texto idéntico es una coincidencia exacta', () => {
    const p = proponerCiudad('Medellín', CATALOGO);
    expect(p.certeza).toBe('exacta');
    expect(p.candidatas).toHaveLength(1);
    expect(p.candidatas[0]).toMatchObject({ cityCode: '05001', stateName: 'Antioquia', puntaje: 1 });
  });

  it('la tilde perdida es exacta; el dedazo es APROXIMADA aunque la candidata sea única', () => {
    // «Medellin» sin tilde normaliza igual que «Medellín»: es el mismo texto, no una aproximación.
    expect(proponerCiudad('Medellin', CATALOGO).certeza).toBe('exacta');
    // «Medelin» con una letra de menos ya es otra cosa, y la confirma una persona.
    const q = proponerCiudad('Medelin', CATALOGO);
    expect(q.certeza).toBe('aproximada');
    expect(q.candidatas[0]!.cityCode).toBe('05001');
    expect(q.candidatas[0]!.puntaje).toBeLessThan(1);
  });

  it('conserva el texto de origen tal como venía', () => {
    expect(proponerCiudad('  BOGOTA D.C. ', CATALOGO).textoOrigen).toBe('  BOGOTA D.C. ');
  });
});

describe('AC2 — la ambigüedad se declara, no se resuelve', () => {
  it('un homónimo en tres departamentos devuelve las tres candidatas', () => {
    const p = proponerCiudad('La Unión', CATALOGO);
    expect(p.certeza).toBe('ambigua');
    expect(p.candidatas).toHaveLength(3);
    expect(p.candidatas.map((c) => c.stateName).sort())
      .toEqual(['Antioquia', 'Nariño', 'Valle del Cauca']);
  });

  it('NO elige la primera del catálogo', () => {
    // Cualquier criterio automático —la primera, la más poblada, el departamento más frecuente—
    // es una invención con apariencia de dato.
    const p = proponerCiudad('la union', CATALOGO);
    expect(p.certeza).not.toBe('exacta');
    expect(p.candidatas.length).toBeGreaterThan(1);
  });

  it('varias candidatas aproximadas empatadas también son ambiguas', () => {
    const catalogo = [ciudad('Sabana', '11', 'X', '1'), ciudad('Cabana', '05', 'Y', '2')];
    const p = proponerCiudad('Rabana', catalogo);
    expect(p.certeza).toBe('ambigua');
    expect(p.candidatas).toHaveLength(2);
  });
});

describe('AC3 — lo que no coincide se dice, y se distingue de lo ambiguo', () => {
  const SIN_EQUIVALENCIA = ['', '   ', 'Kilómetro 5 vía Cota', 'ZZZZZZ', 'Sin ciudad'];
  for (const texto of SIN_EQUIVALENCIA) {
    it(`«${texto}» → sin equivalencia`, () => {
      const p = proponerCiudad(texto, CATALOGO);
      expect(p.certeza).toBe('sin_equivalencia');
      expect(p.candidatas).toEqual([]);
    });
  }

  it('null y undefined no revientan', () => {
    expect(proponerCiudad(null, CATALOGO).certeza).toBe('sin_equivalencia');
    expect(proponerCiudad(undefined, CATALOGO).certeza).toBe('sin_equivalencia');
  });

  it('una abreviatura NO se fuerza a la ciudad más parecida', () => {
    // «Bta» está a más de dos ediciones de «bogota»: proponerla sería adivinar.
    expect(proponerCiudad('Bta', CATALOGO).certeza).toBe('sin_equivalencia');
  });

  it('un texto corto que se parece a otro NO se acepta por casualidad', () => {
    // «Cala» está a una edición de «Cali». Es el límite del umbral y por eso se propone como
    // aproximada, para que una persona lo mire, nunca como exacta.
    const p = proponerCiudad('Cala', CATALOGO);
    expect(p.certeza).toBe('aproximada');
  });
});

describe('distancia de edición', () => {
  it('mide lo que tiene que medir', () => {
    expect(distanciaEdicion('cali', 'cali')).toBe(0);
    expect(distanciaEdicion('cali', 'cala')).toBe(1);
    expect(distanciaEdicion('medelin', 'medellin')).toBe(1);
    expect(distanciaEdicion('', 'cali')).toBe(4);
    expect(distanciaEdicion('cali', '')).toBe(4);
  });

  it('corta por lo sano cuando la diferencia de longitud ya supera el umbral', () => {
    // No hace falta recorrer la matriz para saber que «bta» no es «barranquilla».
    expect(distanciaEdicion('bta', 'barranquilla', 2)).toBeGreaterThan(2);
  });
});
