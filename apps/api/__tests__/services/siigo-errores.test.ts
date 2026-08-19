// HU #11250 — traducción de los errores de Siigo al dominio (Feature #11239).
//
// La pregunta que responde este módulo es una sola y muy concreta: ¿esto se reintenta o hay que
// llamar a alguien? Equivocarse hacia el lado del reintento es caro — Siigo bloquea el usuario API
// si durante 7 días más del 80 % de las peticiones son errores.

import { describe, it, expect } from 'vitest';
import {
  traducirErrorSiigo, esReintentable, SiigoApiError, CODIGO_RESPUESTA_INESPERADA,
} from '../../src/modules/siigo/siigo.errors.js';

/** Cuerpo de error con la forma que documenta Siigo. */
function cuerpo(code: string, extra: Record<string, unknown> = {}) {
  return {
    Status: 400,
    Errors: [{
      Code: code,
      Message: `The field ${code} failed`,
      Params: ['code'],
      Detail: 'Check the API documentation',
      ...extra,
    }],
  };
}

describe('AC1 — el error llega estructurado', () => {
  it('conserva estado, código, mensaje, parámetros y detalle', () => {
    const e = traducirErrorSiigo(400, cuerpo('parameter_required'));

    expect(e).toBeInstanceOf(SiigoApiError);
    expect(e.status).toBe(400);
    expect(e.code).toBe('parameter_required');
    expect(e.message).toBe('The field parameter_required failed');
    expect(e.params).toEqual(['code']);
    expect(e.detail).toBe('Check the API documentation');
  });

  it('es un Error de verdad: se puede lanzar y capturar', () => {
    const e = traducirErrorSiigo(400, cuerpo('invalid_date'));
    expect(e).toBeInstanceOf(Error);
    expect(() => { throw e; }).toThrow(/invalid_date failed/);
  });

  it('conserva TODOS los errores devueltos, no solo el primero', () => {
    const e = traducirErrorSiigo(400, {
      Status: 400,
      Errors: [
        { Code: 'parameter_required', Message: 'falta code', Params: ['code'] },
        { Code: 'invalid_date', Message: 'fecha mala', Params: ['date'] },
      ],
    });

    expect(e.errores).toHaveLength(2);
    expect(e.errores.map((x) => x.code)).toEqual(['parameter_required', 'invalid_date']);
    // El principal es el primero, que es el que se muestra.
    expect(e.code).toBe('parameter_required');
  });

  it('prefiere el Status del cuerpo cuando difiere del HTTP', () => {
    const e = traducirErrorSiigo(500, { Status: 400, Errors: [{ Code: 'invalid_value' }] });
    expect(e.status).toBe(400);
  });

  it('tolera un error sin Params ni Detail', () => {
    const e = traducirErrorSiigo(400, { Status: 400, Errors: [{ Code: 'not_found' }] });
    expect(e.params).toEqual([]);
    expect(e.detail).toBeNull();
    expect(e.message).toMatch(/no describió el error/);
  });
});

describe('AC2 — los errores transitorios se marcan reintentables', () => {
  it.each([
    'requests_limit',
    'service_unavailable',
    'request_timeout',
    'documents_service',
    'payment_types_service',
  ])('%s es reintentable', (code) => {
    expect(traducirErrorSiigo(503, cuerpo(code)).reintentable).toBe(true);
  });

  it.each([408, 429, 502, 503, 504])(
    'un %i sin código en el cuerpo se considera transitorio', (status) => {
      expect(esReintentable(null, status)).toBe(true);
    },
  );
});

describe('AC3 — los errores de datos se marcan definitivos', () => {
  it.each([
    'parameter_required',
    'invalid_value',
    'invalid_identification',
    'duplicated_document',
    'invalid_date',
    'invalid_total_payments',
    'invalid_dian_resolution',
    'already_exists',
  ])('%s NO es reintentable', (code) => {
    expect(traducirErrorSiigo(400, cuerpo(code)).reintentable).toBe(false);
  });

  it('un código desconocido NO se reintenta: el defecto seguro es parar', () => {
    const e = traducirErrorSiigo(400, cuerpo('codigo_que_no_existe_todavia'));
    expect(e.reintentable).toBe(false);
    expect(e.code).toBe('codigo_que_no_existe_todavia');
  });

  it('un error de datos con estado 503 sigue sin reintentarse: manda el código', () => {
    // El estado dice «transitorio» pero el código dice «te falta un campo». Reintentar no lo arregla.
    const e = traducirErrorSiigo(503, cuerpo('parameter_required'));
    expect(e.reintentable).toBe(false);
  });

  it('si un solo error del lote no es reintentable, el conjunto no lo es', () => {
    const e = traducirErrorSiigo(429, {
      Status: 429,
      Errors: [
        { Code: 'requests_limit', Message: 'demasiadas' },
        { Code: 'invalid_date', Message: 'fecha mala' },
      ],
    });
    expect(e.reintentable).toBe(false);
  });

  it('si todos son transitorios, el conjunto sí se reintenta', () => {
    const e = traducirErrorSiigo(503, {
      Status: 503,
      Errors: [
        { Code: 'service_unavailable', Message: 'caído' },
        { Code: 'request_timeout', Message: 'lento' },
      ],
    });
    expect(e.reintentable).toBe(true);
  });

  it('un 500 sin código NO se reintenta: suele repetirse con el mismo cuerpo', () => {
    expect(esReintentable(null, 500)).toBe(false);
  });
});

describe('AC4 — mensaje entendible para quien opera', () => {
  it('traduce el código a lenguaje operativo', () => {
    const e = traducirErrorSiigo(400, cuerpo('invalid_dian_resolution'));
    expect(e.descripcionOperativa).toMatch(/resolución DIAN/i);
  });

  it('señala el campo concreto cuando Siigo lo indica', () => {
    const e = traducirErrorSiigo(400, {
      Status: 400,
      Errors: [{ Code: 'parameter_required', Message: 'x', Params: ['customer.identification'] }],
    });
    expect(e.descripcionOperativa).toContain('Campo: customer.identification');
  });

  it('lista varios campos cuando el error afecta a más de uno', () => {
    const e = traducirErrorSiigo(400, {
      Status: 400,
      Errors: [{ Code: 'parameter_required', Message: 'x', Params: ['date', 'seller'] }],
    });
    expect(e.descripcionOperativa).toContain('Campo: date, seller');
  });

  it('sin campos no inventa un sufijo vacío', () => {
    const e = traducirErrorSiigo(400, { Status: 400, Errors: [{ Code: 'not_found' }] });
    expect(e.descripcionOperativa).not.toContain('Campo:');
  });

  it('un código sin traducción cae a un texto genérico que igual nombra el código', () => {
    const e = traducirErrorSiigo(400, cuerpo('codigo_nuevo_de_siigo'));
    expect(e.descripcionOperativa).toContain('codigo_nuevo_de_siigo');
  });

  it('el aviso del límite de peticiones dice que se reintenta solo', () => {
    const e = traducirErrorSiigo(429, cuerpo('requests_limit'));
    expect(e.descripcionOperativa).toMatch(/reintenta autom/i);
  });
});

describe('AC5 — respuesta inesperada', () => {
  it('una página HTML no revienta: produce un error genérico', () => {
    const e = traducirErrorSiigo(502, '<html><body>Bad Gateway</body></html>');
    expect(e.code).toBe(CODIGO_RESPUESTA_INESPERADA);
    expect(e.cuerpoCrudo).toContain('Bad Gateway');
  });

  it('un cuerpo nulo tampoco revienta', () => {
    const e = traducirErrorSiigo(500, null);
    expect(e.code).toBe(CODIGO_RESPUESTA_INESPERADA);
    expect(e.cuerpoCrudo).toBeNull();
  });

  it('un objeto sin el arreglo Errors se trata como inesperado', () => {
    const e = traducirErrorSiigo(400, { mensaje: 'algo raro' });
    expect(e.code).toBe(CODIGO_RESPUESTA_INESPERADA);
    expect(e.cuerpoCrudo).toContain('algo raro');
  });

  it('un arreglo Errors vacío también', () => {
    const e = traducirErrorSiigo(400, { Status: 400, Errors: [] });
    expect(e.code).toBe(CODIGO_RESPUESTA_INESPERADA);
  });

  it('el cuerpo crudo se recorta para no llenar la bitácora con una página entera', () => {
    const e = traducirErrorSiigo(502, 'x'.repeat(10_000));
    expect(e.cuerpoCrudo).toHaveLength(2000);
  });

  it('un cuerpo con referencias circulares no rompe la traducción', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const e = traducirErrorSiigo(500, circular);
    expect(e.code).toBe(CODIGO_RESPUESTA_INESPERADA);
    expect(e.cuerpoCrudo).toBeTruthy();
  });

  it('la clasificación de una respuesta inesperada usa el estado HTTP', () => {
    expect(traducirErrorSiigo(503, 'texto suelto').reintentable).toBe(true);
    expect(traducirErrorSiigo(400, 'texto suelto').reintentable).toBe(false);
  });
});

describe('AC6 — los errores no filtran secretos', () => {
  it('el error solo contiene lo que Siigo devolvió, nunca lo que se envió', () => {
    const e = traducirErrorSiigo(400, cuerpo('invalid_value'));
    const serializado = JSON.stringify(e);

    // El traductor solo ve la RESPUESTA: el cuerpo de la petición, con el access_key, jamás llega.
    expect(serializado).not.toMatch(/access_key|Authorization|Bearer/i);
  });

  it('toJSON expone una forma estable y acotada', () => {
    const e = traducirErrorSiigo(400, cuerpo('parameter_required'));
    const plano = JSON.parse(JSON.stringify(e)) as Record<string, unknown>;

    // `accionSugerida`, `responsable`, `responsableEtiqueta` y `textoOperativo` los añadió la
    // HU #11339: sin ellos la bandeja de fallidos vuelve a enseñar un código pelado.
    expect(Object.keys(plano).sort()).toEqual([
      'accionSugerida', 'code', 'descripcionOperativa', 'detail', 'message', 'name', 'params',
      'reintentable', 'responsable', 'responsableEtiqueta', 'status', 'textoOperativo',
    ]);
    expect(plano.name).toBe('SiigoApiError');
  });
});
