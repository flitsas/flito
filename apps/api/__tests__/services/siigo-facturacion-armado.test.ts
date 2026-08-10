// HU #11325 — cómo se arma la factura que se envía a Siigo (Feature #11242).
//
// El armador es puro, así que estas pruebas cubren el comportamiento entero sin base de datos. Y
// son las que más importan de la Feature: **lo que sale de aquí es un documento ante la DIAN**.
//
// Lo que vigilan por encima de todo es que NINGUNA decisión de negocio abierta esté escrita en el
// código. Cada una entra como dato, y hay una prueba por cada una que falla si alguien la fija.

import { describe, it, expect } from 'vitest';
import {
  agrupadorPorTramite, armarFactura, claveIdempotencia, fechaVencimiento,
  huellaDeTramites, FacturaNoArmableError,
  type EntradaArmado, type MapeoPorConcepto, type TramiteFacturable,
} from '../../src/modules/siigo/facturacion.armado.js';
import type { MapeoConcepto } from '../../src/modules/siigo/mapeo-conceptos.service.js';

/** Un mapeo mínimo pero completo para un concepto. */
function mapeo(cambios: Partial<MapeoConcepto> = {}): MapeoConcepto {
  return {
    id: 'm1', ambiente: 'pruebas', concepto: 'soat', tipoTramite: null,
    codigoProducto: 'P-SOAT', nombreProducto: 'SOAT',
    clasificacionTributaria: 'excluido', impuestos: [],
    unidadMedida: null, ingresoParaTerceros: false,
    facturaLineaPropia: true, lineaPropiaPendiente: false,
    confirmadoContabilidad: true, confirmadoPorId: 1, confirmadoEn: null,
    confirmacionRevertidaEn: null, confirmacionRevertidaPor: null,
    activo: true,
    ...cambios,
  } as MapeoConcepto;
}

const TRAMITE: TramiteFacturable = {
  tramiteId: 't-1', idFlit: 'FLIT-001', placa: 'ABC123', tipoTramite: 'traspaso',
  liquidacion: {
    valorSoat: '150000.00',
    valorImpuesto: null,
    valorDerecho: '50000.00',
    valorTramiteDigital: null,
    valorLogistica: null,
    valorGmf: '600.00',
  },
};

const MAPEO_BASE: MapeoPorConcepto = {
  soat: mapeo({ concepto: 'soat', codigoProducto: 'P-SOAT', nombreProducto: 'SOAT' }),
  derecho_transito: mapeo({ concepto: 'derecho_transito', codigoProducto: 'P-DER', nombreProducto: 'Derecho de tránsito' }),
  gmf: mapeo({ concepto: 'gmf', codigoProducto: 'P-GMF', nombreProducto: 'GMF 4x1000' }),
};

function entrada(cambios: Partial<EntradaArmado> = {}): EntradaArmado {
  return {
    tramites: [TRAMITE],
    tercero: { identificacion: '900123456', sucursal: 0 },
    parametros: {
      documentoTipoCodigo: '24446', vendedorCodigo: '629', formaPagoCodigo: '5636',
      centroCostoCodigo: null, plazoVencimientoDias: 0, moneda: 'COP',
      retencionesEstrategia: 'ninguna', estrategiaNumeracion: 'siigo',
    },
    mapeo: MAPEO_BASE,
    fecha: '2026-08-10',
    ...cambios,
  };
}

describe('AC2 — una línea por concepto que aplica, y nulo no es cero', () => {
  it('el concepto en nulo NO genera línea', () => {
    const f = armarFactura(entrada());
    // `valorImpuesto`, `valorTramiteDigital` y `valorLogistica` son null: no aplican al trámite.
    expect(f.items.map((i) => i.code).sort()).toEqual(['P-DER', 'P-GMF', 'P-SOAT']);
  });

  it('el concepto en CERO sí genera su línea', () => {
    // Es la distinción que sostiene toda la Feature: cero significa «aplica y vale cero», y que la
    // contabilidad vea un cero explícito no es lo mismo que no ver nada.
    const t = { ...TRAMITE, liquidacion: { ...TRAMITE.liquidacion, valorImpuesto: '0.00' } };
    const f = armarFactura(entrada({
      tramites: [t],
      mapeo: { ...MAPEO_BASE, impuesto_vehicular: mapeo({ concepto: 'impuesto_vehicular', codigoProducto: 'P-IMP' }) },
    }));
    const linea = f.items.find((i) => i.code === 'P-IMP');
    expect(linea).toBeDefined();
    expect(linea!.price).toBe(0);
  });

  it('el valor sale de la liquidación, sin recalcular nada', () => {
    const f = armarFactura(entrada());
    expect(f.items.find((i) => i.code === 'P-SOAT')!.price).toBe(150000);
    expect(f.items.find((i) => i.code === 'P-DER')!.price).toBe(50000);
  });

  it('un importe negativo se rechaza aunque venga de una liquidación sellada', () => {
    const t = { ...TRAMITE, liquidacion: { ...TRAMITE.liquidacion, valorSoat: '-1.00' } };
    expect(() => armarFactura(entrada({ tramites: [t] })))
      .toThrow(expect.objectContaining({ motivo: 'importe_negativo' }));
  });
});

describe('AC3 — producto e impuestos salen del mapeo, nunca del código', () => {
  it('cada línea toma su código y su nombre del mapeo', () => {
    const f = armarFactura(entrada());
    expect(f.items.find((i) => i.code === 'P-GMF')!.description).toBe('GMF 4x1000');
  });

  it('los impuestos del mapeo viajan como ids', () => {
    const f = armarFactura(entrada({
      mapeo: {
        ...MAPEO_BASE,
        soat: mapeo({ concepto: 'soat', codigoProducto: 'P-SOAT', impuestos: [{ id: 13156 }] }),
      },
    }));
    expect(f.items.find((i) => i.code === 'P-SOAT')!.taxes).toEqual([{ id: 13156 }]);
  });

  it('sin impuestos configurados no se envía el campo', () => {
    // Un arreglo vacío y la ausencia del campo no significan lo mismo para Siigo.
    expect(armarFactura(entrada()).items[0]!.taxes).toBeUndefined();
  });

  it('un concepto que aplica pero no está mapeado detiene el armado', () => {
    expect(() => armarFactura(entrada({ mapeo: { soat: MAPEO_BASE.soat } })))
      .toThrow(expect.objectContaining({ motivo: 'concepto_sin_mapeo' }));
  });

  it('un concepto mapeado pero sin código de producto también', () => {
    expect(() => armarFactura(entrada({
      mapeo: { ...MAPEO_BASE, derecho_transito: mapeo({ concepto: 'derecho_transito', codigoProducto: null }) },
    }))).toThrow(expect.objectContaining({ motivo: 'concepto_sin_producto' }));
  });
});

describe('AC4 — el GMF se decide en el mapeo, no en el código', () => {
  it('con línea propia marcada, aparece como línea', () => {
    expect(armarFactura(entrada()).items.map((i) => i.code)).toContain('P-GMF');
  });

  it('sin línea propia, no aparece', () => {
    const f = armarFactura(entrada({
      mapeo: {
        ...MAPEO_BASE,
        gmf: mapeo({ concepto: 'gmf', codigoProducto: 'P-GMF', facturaLineaPropia: false }),
      },
    }));
    expect(f.items.map((i) => i.code)).not.toContain('P-GMF');
  });

  it('la regla es del indicador, no del concepto: vale igual para cualquier otro', () => {
    // Si hubiera un `if (concepto === "gmf")` escondido, esta prueba lo delata.
    const f = armarFactura(entrada({
      mapeo: {
        ...MAPEO_BASE,
        soat: mapeo({ concepto: 'soat', codigoProducto: 'P-SOAT', facturaLineaPropia: false }),
      },
    }));
    expect(f.items.map((i) => i.code)).not.toContain('P-SOAT');
    expect(f.items.map((i) => i.code)).toContain('P-GMF');
  });
});

describe('AC5 — exactamente una forma de pago, con su vencimiento', () => {
  it('siempre una sola: Siigo no admite más de una con vencimiento', () => {
    expect(armarFactura(entrada()).payments).toHaveLength(1);
  });

  it('con plazo cero NO lleva vencimiento: eso significa de contado', () => {
    // Enviar `due_date` igual a la fecha del documento diría otra cosa.
    expect(armarFactura(entrada()).payments[0]!.due_date).toBeUndefined();
  });

  it('con plazo, el vencimiento es la fecha más el plazo', () => {
    const f = armarFactura(entrada({
      parametros: { ...entrada().parametros, plazoVencimientoDias: 30 },
    }));
    expect(f.payments[0]!.due_date).toBe('2026-09-09');
  });

  it('el valor del pago es el total de la factura', () => {
    const f = armarFactura(entrada());
    expect(f.payments[0]!.value).toBe(200600);
  });

  it('el cálculo del vencimiento cruza fin de mes y de año', () => {
    expect(fechaVencimiento('2026-01-31', 1)).toBe('2026-02-01');
    expect(fechaVencimiento('2026-12-31', 1)).toBe('2027-01-01');
    expect(fechaVencimiento('2026-08-10', 0)).toBe('2026-08-10');
  });
});

describe('AC6 — la clave de idempotencia es estable y cumple el contrato', () => {
  it('calcularla dos veces sobre el mismo lote da lo mismo', () => {
    const a = claveIdempotencia('pruebas', 'huella-x');
    expect(claveIdempotencia('pruebas', 'huella-x')).toBe(a);
  });

  it('es alfanumérica y no pasa de 30: un UUID crudo no cumpliría', () => {
    const clave = claveIdempotencia('produccion', 'huella-y');
    expect(clave).toMatch(/^[A-Za-z0-9]{1,30}$/);
    expect(clave.length).toBeLessThanOrEqual(30);
  });

  it('cambia con el ambiente: pruebas y producción son empresas distintas', () => {
    expect(claveIdempotencia('pruebas', 'h')).not.toBe(claveIdempotencia('produccion', 'h'));
  });

  it('la huella NO depende del orden en que se seleccionaron los trámites', () => {
    // Si dependiera, el mismo conjunto produciría dos lotes y DOS FACTURAS DIAN, provocado
    // simplemente por dónde hizo clic quien factura.
    expect(huellaDeTramites(['a', 'b', 'c'])).toBe(huellaDeTramites(['c', 'a', 'b']));
  });

  it('pero sí distingue conjuntos distintos', () => {
    expect(huellaDeTramites(['a', 'b'])).not.toBe(huellaDeTramites(['a', 'b', 'c']));
  });
});

describe('AC7 — trazabilidad y validación de sanidad', () => {
  it('las observaciones llevan identificador FLIT, placa y tipo de trámite', () => {
    const o = armarFactura(entrada()).observations;
    expect(o).toContain('FLIT-001');
    expect(o).toContain('ABC123');
    expect(o).toContain('traspaso');
  });

  it('un trámite sin placa no rompe las observaciones', () => {
    const t = { ...TRAMITE, placa: null, tipoTramite: null };
    expect(armarFactura(entrada({ tramites: [t] })).observations).toContain('FLIT-001');
  });

  it('las observaciones se recortan al tope de Siigo', () => {
    const muchos = Array.from({ length: 500 }, (_, i) => ({ ...TRAMITE, tramiteId: `t${i}`, idFlit: `FLIT-${i}` }));
    expect(armarFactura(entrada({ tramites: muchos })).observations.length).toBeLessThanOrEqual(4000);
  });

  it('un total que no es mayor que cero se rechaza', () => {
    const t = {
      ...TRAMITE,
      liquidacion: { ...TRAMITE.liquidacion, valorSoat: '0.00', valorDerecho: '0.00', valorGmf: '0.00' },
    };
    expect(() => armarFactura(entrada({ tramites: [t] })))
      .toThrow(expect.objectContaining({ motivo: 'total_no_positivo' }));
  });

  it('un grupo sin líneas se rechaza', () => {
    const t = {
      ...TRAMITE,
      liquidacion: {
        valorSoat: null, valorImpuesto: null, valorDerecho: null,
        valorTramiteDigital: null, valorLogistica: null, valorGmf: null,
      },
    };
    expect(() => armarFactura(entrada({ tramites: [t] })))
      .toThrow(expect.objectContaining({ motivo: 'sin_lineas' }));
  });

  it('un grupo vacío se rechaza', () => {
    expect(() => armarFactura(entrada({ tramites: [] })))
      .toThrow(expect.objectContaining({ motivo: 'grupo_vacio' }));
  });

  it('un parámetro que debería ser numérico y no lo es se rechaza', () => {
    expect(() => armarFactura(entrada({
      parametros: { ...entrada().parametros, vendedorCodigo: 'Ana Ramírez' },
    }))).toThrow(expect.objectContaining({ motivo: 'parametro_no_numerico' }));
  });

  it('el error lleva el motivo, para que la bandeja de fallidos sepa qué decir', () => {
    try {
      armarFactura(entrada({ tramites: [] }));
      expect.unreachable('debía lanzar');
    } catch (e) {
      expect(e).toBeInstanceOf(FacturaNoArmableError);
    }
  });
});

describe('AC8 — lo que no está decidido NO se envía', () => {
  it('no se envían retenciones mientras la estrategia sea ninguna', () => {
    // Pregunta 7, abierta. Un arreglo vacío no es lo mismo que la ausencia del campo.
    expect(armarFactura(entrada())).not.toHaveProperty('retentions');
  });

  it('no se envía el consecutivo: lo asigna Siigo', () => {
    // Pregunta 12. Enviarlo exigiría además que no exista ya en Nube.
    expect(armarFactura(entrada())).not.toHaveProperty('number');
  });

  it('la moneda es la configurada, no un literal del código', () => {
    const f = armarFactura(entrada({ parametros: { ...entrada().parametros, moneda: 'USD' } }));
    expect(f.currency.code).toBe('USD');
  });

  it('la sucursal sale del tercero, nunca de un cero escrito a mano', () => {
    const f = armarFactura(entrada({ tercero: { identificacion: '900123456', sucursal: 7 } }));
    expect(f.customer.branch_office).toBe(7);
  });

  it('el centro de costo solo viaja si está configurado', () => {
    expect(armarFactura(entrada())).not.toHaveProperty('cost_center');
    const f = armarFactura(entrada({
      parametros: { ...entrada().parametros, centroCostoCodigo: '25732' },
    }));
    expect(f.cost_center).toBe(25732);
  });

  it('el armador no lee el reloj: la fecha se recibe', () => {
    expect(armarFactura(entrada({ fecha: '2020-01-01' })).date).toBe('2020-01-01');
  });
});

describe('AC1 — agrupar y armar son dos pasos separados', () => {
  it('el agrupador de hoy produce un grupo por trámite', () => {
    const t2 = { ...TRAMITE, tramiteId: 't-2', idFlit: 'FLIT-002' };
    expect(agrupadorPorTramite([TRAMITE, t2])).toEqual([[TRAMITE], [t2]]);
  });

  it('el armador funciona igual con un grupo de varios, sin condicionales sobre la cantidad', () => {
    // Es lo que permitirá habilitar la consolidación añadiendo un agrupador y nada más.
    const t2 = { ...TRAMITE, tramiteId: 't-2', idFlit: 'FLIT-002' };
    const f = armarFactura(entrada({ tramites: [TRAMITE, t2] }));
    expect(f.items).toHaveLength(6);
    expect(f.payments[0]!.value).toBe(401200);
    expect(f.observations).toContain('FLIT-001');
    expect(f.observations).toContain('FLIT-002');
  });

  it('la factura de un grupo de uno y la de un grupo de varios tienen la misma forma', () => {
    const uno = armarFactura(entrada());
    const varios = armarFactura(entrada({ tramites: [TRAMITE, { ...TRAMITE, tramiteId: 't-2' }] }));
    expect(Object.keys(uno).sort()).toEqual(Object.keys(varios).sort());
  });
});
