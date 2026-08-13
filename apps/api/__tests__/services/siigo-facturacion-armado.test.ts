// HU #11325 — cómo se arma la factura que se envía a Siigo (Feature #11242).
//
// El armador es puro, así que estas pruebas cubren el comportamiento entero sin base de datos. Y
// son las que más importan de la Feature: **lo que sale de aquí es un documento ante la DIAN**.
//
// Lo que vigilan por encima de todo es que NINGUNA decisión de negocio abierta esté escrita en el
// código. Cada una entra como dato, y hay una prueba por cada una que falla si alguien la fija.

import { describe, it, expect } from 'vitest';
import {
  agrupadorPorTramite, armarFactura, claveIdempotencia,
  emisionVacia, huellaDeLote, huellaDeTramites, FacturaNoArmableError, SIN_EMISION_ELEGIDA,
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
      centroCostoCodigo: null,
      // Por omisión se arma como en producción. Los casos de A6 los pide cada prueba.
      timbrarEnDian: true, enviarCorreoAlCliente: true,
    },
    // Vacío = «todos los aplicables», que es lo que el armador hacía antes de A1. Las pruebas de
    // este archivo describen esa conducta; la selección tiene su propio bloque al final.
    conceptos: [],
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

  it('A7 — los impuestos NO viajan, ni siquiera si el mapeo los tiene', () => {
    // `items[].taxes[].id` es opcional en el contrato, y omitirlo hace que Siigo aplique los del
    // propio producto — que es donde contabilidad los mantiene y de donde `GET /v1/products` los
    // publica. Mandarlos desde aquí obligaba a FLITO a guardar una copia del tratamiento tributario
    // y a que alguien la firmara concepto por concepto.
    const f = armarFactura(entrada({
      mapeo: {
        ...MAPEO_BASE,
        soat: mapeo({ concepto: 'soat', codigoProducto: 'P-SOAT', impuestos: [{ id: 13156 }] }),
      },
    }));
    expect(f.items.find((i) => i.code === 'P-SOAT')!.taxes).toBeUndefined();
  });

  it('ninguna línea lleva el campo, con mapeo o sin él', () => {
    // Un arreglo vacío y la ausencia del campo no significan lo mismo para Siigo: `taxes: []` diría
    // «esta línea no tiene impuestos», que es una afirmación tributaria. La ausencia no dice nada.
    expect(armarFactura(entrada()).items.every((i) => i.taxes === undefined)).toBe(true);
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

describe('AC5 — exactamente una forma de pago, siempre de contado', () => {
  it('siempre una sola: Siigo no admite más de una con vencimiento', () => {
    expect(armarFactura(entrada()).payments).toHaveLength(1);
  });

  it('NUNCA lleva vencimiento: FLITO no factura a crédito', () => {
    // No hay plazo que configurar (decisión del 2026-08-13), así que no hay rama que probar: el
    // campo no sale nunca. Inventar una fecha diría un vencimiento que nadie acordó, y las formas
    // de pago que lo exigen se filtran al elegir, no aquí.
    expect(armarFactura(entrada()).payments[0]).not.toHaveProperty('due_date');
  });

  it('el valor del pago es el total de la factura', () => {
    const f = armarFactura(entrada());
    expect(f.payments[0]!.value).toBe(200600);
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

  it('no se envía la moneda: `currency` es para moneda EXTRANJERA', () => {
    // Pregunta 15, respondida: se factura en COP. En COP la respuesta correcta no es mandar
    // `{ code: 'COP' }` sino no mandar nada — el campo describe una divisa distinta a la local.
    expect(armarFactura(entrada())).not.toHaveProperty('currency');
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

describe('A6 — el timbre y el correo entran como dato, y ausentes significan «solo créala»', () => {
  it('con los dos en falso no viaja ni stamp ni mail', () => {
    // Los valores por defecto de Siigo son `false` en ambos, así que OMITIRLOS es pedir que la
    // factura solo se cree. Es el mismo criterio que `retentions[]` y `number` del AC8.
    const f = armarFactura(entrada({
      parametros: { ...entrada().parametros, timbrarEnDian: false, enviarCorreoAlCliente: false },
    }));
    expect(f).not.toHaveProperty('stamp');
    expect(f).not.toHaveProperty('mail');
  });

  it('no se envía `false`: se omite la clave entera', () => {
    // La diferencia importa aunque Siigo trate igual las dos formas. `{ stamp: { send: false } }`
    // afirma algo sobre el documento; la ausencia no afirma nada. Y si algún día Siigo distingue
    // una de otra, esta prueba es la que avisa.
    const f = armarFactura(entrada({
      parametros: { ...entrada().parametros, timbrarEnDian: false, enviarCorreoAlCliente: false },
    }));
    expect(Object.keys(f)).not.toContain('stamp');
    expect(Object.keys(f)).not.toContain('mail');
  });

  it('con los dos en verdadero viajan como antes', () => {
    const f = armarFactura(entrada());
    expect(f.stamp).toEqual({ send: true });
    expect(f.mail).toBe(true);
  });

  it('son independientes: se puede timbrar sin mandar correo', () => {
    // No es un caso de hoy —el ambiente decide los dos a la vez— pero el armador no tiene por qué
    // saberlo, y atarlos aquí obligaría a rehacerlo el día que se separen.
    const f = armarFactura(entrada({
      parametros: { ...entrada().parametros, timbrarEnDian: true, enviarCorreoAlCliente: false },
    }));
    expect(f.stamp).toEqual({ send: true });
    expect(f).not.toHaveProperty('mail');
  });

  it('omitirlos no toca nada más del documento', () => {
    // Lo que se deja de enviar es lo que Siigo debe HACER con la factura, no lo que la factura dice.
    const conTodo = armarFactura(entrada());
    const soloCrear = armarFactura(entrada({
      parametros: { ...entrada().parametros, timbrarEnDian: false, enviarCorreoAlCliente: false },
    }));
    const { stamp: _s, mail: _m, ...restoConTodo } = conTodo;
    expect(soloCrear).toEqual(restoConTodo);
  });
});

describe('A1 — qué conceptos van en la factura se ELIGE, no se deduce', () => {
  it('solo se factura lo elegido, aunque el trámite tenga más liquidado', () => {
    // El caso real: a la empresa se le gestiona todo y solo se le factura el trámite digital; el
    // resto se recupera por reintegro, que está fuera de este alcance.
    const t = {
      ...TRAMITE,
      liquidacion: { ...TRAMITE.liquidacion, valorTramiteDigital: '200000.00' },
    };
    const f = armarFactura(entrada({
      tramites: [t],
      conceptos: ['tramite_digital'],
      mapeo: { ...MAPEO_BASE, tramite_digital: mapeo({ concepto: 'tramite_digital', codigoProducto: 'P-NUBE', nombreProducto: 'Servicio en la Nube' }) },
    }));

    expect(f.items.map((i) => i.code)).toEqual(['P-NUBE']);
    expect(f.payments[0]!.value).toBe(200000);
  });

  it('C1 — un concepto NO elegido y sin mapear ya no tumba la factura', () => {
    // Era el fallo: el SOAT sin producto de Siigo hacía fallar una factura en la que el SOAT no
    // aparece. Y el SOAT no lleva producto porque se cobra por reintegro, no por factura.
    const t = {
      ...TRAMITE,
      liquidacion: { ...TRAMITE.liquidacion, valorTramiteDigital: '200000.00' },
    };
    const f = armarFactura(entrada({
      tramites: [t],
      conceptos: ['tramite_digital'],
      mapeo: { tramite_digital: mapeo({ concepto: 'tramite_digital', codigoProducto: 'P-NUBE' }) },
    }));
    expect(f.items).toHaveLength(1);
  });

  it('elegir un concepto que el trámite no liquidó no lo inventa', () => {
    // `valorLogistica` es null en TRAMITE: no aplica. Elegirlo no puede crear una línea de la nada.
    const f = armarFactura(entrada({
      conceptos: ['soat', 'logistica'],
      mapeo: { ...MAPEO_BASE, logistica: mapeo({ concepto: 'logistica', codigoProducto: 'P-LOG' }) },
    }));
    expect(f.items.map((i) => i.code)).toEqual(['P-SOAT']);
  });

  it('sin ningún concepto elegido que aplique, no hay factura que armar', () => {
    expect(() => armarFactura(entrada({ conceptos: ['logistica'] })))
      .toThrow(expect.objectContaining({ motivo: 'sin_lineas' }));
  });

  it('la lista vacía sigue significando «todos los aplicables»', () => {
    // Es lo que permite emitir los lotes que ya estaban en cola cuando A1 entró. Si esto cambiara,
    // aquellas facturas saldrían sin líneas.
    expect(armarFactura(entrada({ conceptos: [] })).items.map((i) => i.code).sort())
      .toEqual(['P-DER', 'P-GMF', 'P-SOAT']);
  });
});

describe('C3 — la identidad del lote incluye QUÉ se factura', () => {
  it('los mismos trámites con conceptos distintos son lotes DISTINTOS', () => {
    // Sin esto, el segundo envío recuperaba el lote del primero y no emitía nada, informando «ya en
    // cola». Sin error y sin rastro: el peor fallo posible en algo que mueve dinero.
    const a = huellaDeLote(['t-1', 't-2'], ['tramite_digital']);
    const b = huellaDeLote(['t-1', 't-2'], ['logistica']);
    expect(a).not.toBe(b);
  });

  it('el orden no cambia la identidad, ni el de los trámites ni el de los conceptos', () => {
    expect(huellaDeLote(['t-2', 't-1'], ['logistica', 'soat']))
      .toBe(huellaDeLote(['t-1', 't-2'], ['soat', 'logistica']));
  });

  it('sin conceptos, la huella es EXACTAMENTE la de antes de A1', () => {
    // Compatibilidad con lo que ya está encolado. Si esto se rompe, el trabajador no reconocería
    // aquellos lotes, crearía uno nuevo y reservaría otra clave: una SEGUNDA factura ante la DIAN.
    expect(huellaDeLote(['t-1', 't-2'], [])).toBe(huellaDeTramites(['t-1', 't-2']));
  });

  it('un concepto de más no se cuela por duplicado', () => {
    expect(huellaDeLote(['t-1'], ['soat', 'soat'])).toBe(huellaDeLote(['t-1'], ['soat']));
  });
});

describe('A2 — la emisión elegida también identifica al lote', () => {
  const EMISION = {
    documentoTipoCodigo: '24446',
    vendedorCodigo: '629',
    formaPagoCodigo: '5636',
    centroCostoCodigo: null,
  };

  it('los mismos trámites y conceptos con distinto vendedor son lotes DISTINTOS', () => {
    // Sin esto, reenviar con otro vendedor devolvería «ya en cola» y emitiría con el vendedor
    // viejo, en silencio. Con esto, el reenvío choca contra el índice de D-5 con un error que se
    // lee: ruidoso y correcto es mejor que silencioso y equivocado.
    const a = huellaDeLote(['t-1'], ['tramite_digital'], EMISION);
    const b = huellaDeLote(['t-1'], ['tramite_digital'], { ...EMISION, vendedorCodigo: '777' });
    expect(a).not.toBe(b);
  });

  it('sin emisión elegida, la huella no cambia respecto de A1', () => {
    // Compatibilidad con lo que ya está encolado, igual que la degradación de A1. Un lote anterior
    // a A2 no puede cambiar de identidad por haber añadido columnas.
    expect(huellaDeLote(['t-1'], ['tramite_digital'], null))
      .toBe(huellaDeLote(['t-1'], ['tramite_digital']));
  });

  it('una emisión con los cuatro campos nulos cuenta como «no elegida»', () => {
    // Es lo que devuelve `emisionDelLote` para un lote anterior a A2: cuatro nulos, no ausencia.
    // Si esto contara como elección, aquellos lotes cambiarían de huella y se emitirían dos veces.
    expect(emisionVacia(SIN_EMISION_ELEGIDA)).toBe(true);
    expect(huellaDeLote(['t-1'], ['tramite_digital'], SIN_EMISION_ELEGIDA))
      .toBe(huellaDeLote(['t-1'], ['tramite_digital']));
  });

  it('un solo campo elegido ya la hace distinta', () => {
    expect(emisionVacia({ ...SIN_EMISION_ELEGIDA, vendedorCodigo: '629' })).toBe(false);
    expect(huellaDeLote(['t-1'], ['soat'], { ...SIN_EMISION_ELEGIDA, vendedorCodigo: '629' }))
      .not.toBe(huellaDeLote(['t-1'], ['soat']));
  });

  it('el centro de costo nulo y el centro de costo puesto no son el mismo lote', () => {
    expect(huellaDeLote(['t-1'], ['soat'], EMISION))
      .not.toBe(huellaDeLote(['t-1'], ['soat'], { ...EMISION, centroCostoCodigo: '25732' }));
  });
});
