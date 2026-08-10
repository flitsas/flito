// HU #11339 — qué hacer y a quién le toca ante cada error de Siigo (Feature #11244).
//
// La HU #11250 ya traducía el código a una descripción. Eso informa pero no desatasca: quien opera
// la facturación lee «la resolución DIAN está vencida», no puede renovarla —la renueva contabilidad
// en Siigo Nube— y se queda mirando la pantalla. Lo que se prueba aquí es que cada error diga la
// acción concreta y el responsable, y que reintentar y corregir no se confundan nunca.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  traducirErrorSiigo,
  esReintentable,
  guiaParaCodigo,
  codigosCatalogados,
  codigosSinCatalogar,
  olvidarCodigosSinCatalogar,
  ETIQUETA_RESPONSABLE,
  MARCA_CAMPO_OMITIDO,
  MARCA_SECRETO_OMITIDO,
  CODIGO_RESPUESTA_INESPERADA,
  type ResponsableError,
} from '../../src/modules/siigo/siigo.errors.js';
import { MAX_LONGITUD_MENSAJE } from '../../src/modules/siigo/siigo.redaccion.js';

/** Cuerpo de error con la forma que documenta Siigo. */
function cuerpo(code: string, params: string[] = ['code']) {
  return {
    Status: 400,
    Errors: [{ Code: code, Message: `The field ${code} failed`, Params: params, Detail: 'Check the docs' }],
  };
}

beforeEach(() => {
  // El registro de códigos sin catalogar es memoria de proceso y los tests corren en serie:
  // sin esto, un código desconocido de otro archivo contamina las aserciones de conteo.
  olvidarCodigosSinCatalogar();
});

describe('AC1 — cada error conocido trae acción y responsable', () => {
  const RESPONSABLES: ResponsableError[] = ['operacion', 'contabilidad', 'soporte', 'automatico'];

  it('ningún código del catálogo se queda sin acción ni sin dueño', () => {
    // Recorrer el catálogo entero, y no una muestra, es lo que impide que un código añadido con
    // prisa entre solo con descripción y vuelva a dejar a quien opera sin saber qué hacer.
    const sinAccion: string[] = [];
    const sinResponsable: string[] = [];

    for (const codigo of codigosCatalogados()) {
      const guia = guiaParaCodigo(codigo);
      if (guia.accion.trim().length < 20) sinAccion.push(codigo);
      if (!RESPONSABLES.includes(guia.responsable)) sinResponsable.push(codigo);
    }

    expect(sinAccion).toEqual([]);
    expect(sinResponsable).toEqual([]);
  });

  it('el catálogo no dejó de conocer ningún código: sigue por encima de cincuenta', () => {
    expect(codigosCatalogados().length).toBeGreaterThan(50);
  });

  it('la resolución DIAN vencida dice que la renueva contabilidad, no quien opera', () => {
    // Es el ejemplo que motivó la HU: el texto viejo describía el problema y dejaba al operador
    // reintentando contra una resolución que solo contabilidad puede renovar.
    const guia = traducirErrorSiigo(400, cuerpo('invalid_dian_resolution', [])).guia;

    expect(guia.responsable).toBe('contabilidad');
    expect(guia.accion).toMatch(/contabilidad/i);
    expect(guia.accion).toMatch(/Siigo Nube/);
    expect(guia.texto).toMatch(/Lo resuelve: contabilidad, en Siigo Nube\./);
  });

  it('un error de credenciales no se le echa encima a quien opera: es de soporte', () => {
    expect(guiaParaCodigo('unauthorized').responsable).toBe('soporte');
    expect(guiaParaCodigo('invalid_partner_id').responsable).toBe('soporte');
  });

  it('un dato mal capturado sí es de quien opera, y la acción dice dónde se corrige', () => {
    const guia = guiaParaCodigo('invalid_identification', { params: ['customer.identification'] });

    expect(guia.responsable).toBe('operacion');
    expect(guia.accion).toMatch(/FLITO/);
    expect(guia.texto).toContain('Campo: customer.identification.');
  });

  it('el responsable viaja con su etiqueta legible, para no traducirlo en cada pantalla', () => {
    const guia = guiaParaCodigo('requests_limit');
    expect(guia.responsableEtiqueta).toBe(ETIQUETA_RESPONSABLE.automatico);
    expect(guia.responsableEtiqueta).toMatch(/se resuelve solo/);
  });

  it('el error ya clasificado expone acción y responsable sin pasar por la guía', () => {
    // La bandeja de fallidos serializa el error tal cual; si estos campos no salen en el JSON,
    // la pantalla vuelve a mostrar un código pelado.
    const e = traducirErrorSiigo(400, cuerpo('invalid_email', ['customer.email']));
    const plano = JSON.parse(JSON.stringify(e)) as Record<string, unknown>;

    expect(e.accionSugerida).toMatch(/correo/i);
    expect(e.responsable).toBe('operacion');
    expect(plano.accionSugerida).toBe(e.accionSugerida);
    expect(plano.responsable).toBe('operacion');
    expect(String(plano.textoOperativo)).toMatch(/Lo resuelve:/);
  });
});

describe('AC2 — se extiende el catálogo que ya existía, no se crea otro', () => {
  it('la descripción de la HU #11250 sigue saliendo del mismo sitio que la acción', () => {
    const guia = guiaParaCodigo('invalid_total_payments');

    // Misma frase que ya leía quien opera antes de esta HU: no se retradujo nada.
    expect(guia.descripcion).toBe('La suma de las formas de pago no coincide con el total del documento.');
    expect(guia.texto).toContain(guia.descripcion);
    expect(guia.texto).toContain(guia.accion);
  });

  it('todo código reintentable está en el catálogo: no hay lista de reintentos por separado', () => {
    // Antes la lista de transitorios vivía aparte y `entry_service` y `general_service` se
    // reintentaban sin tener texto que enseñar. Derivar una de otra hace imposible esa deriva.
    const huerfanos = codigosCatalogados()
      .filter((c) => esReintentable(c, 400))
      .filter((c) => !guiaParaCodigo(c).conocido);

    expect(huerfanos).toEqual([]);
  });

  it.each(['entry_service', 'general_service', 'payment_types_service'])(
    '%s se reintenta Y tiene texto propio: antes tenía lo primero y no lo segundo', (codigo) => {
      expect(esReintentable(codigo, 400)).toBe(true);
      expect(guiaParaCodigo(codigo).conocido).toBe(true);
      expect(guiaParaCodigo(codigo).descripcion).not.toMatch(/todavía no traduce/);
    },
  );

  it('los códigos transitorios son exactamente los que el catálogo marca como automáticos', () => {
    const reintentables = codigosCatalogados().filter((c) => esReintentable(c, 400));
    const automaticos = codigosCatalogados().filter((c) => guiaParaCodigo(c).responsable === 'automatico');

    expect(reintentables.sort()).toEqual(automaticos.sort());
  });
});

describe('AC3 — reintentar y corregir no se confunden', () => {
  it('un error de un dato nuestro dice que reintentar no lo arregla y qué corregir', () => {
    const guia = traducirErrorSiigo(400, cuerpo('parameter_required', ['date'])).guia;

    expect(guia.reintentable).toBe(false);
    expect(guia.texto).toMatch(/Reintentar no lo arregla/);
    expect(guia.texto).toContain('Campo: date.');
    expect(guia.responsable).toBe('operacion');
  });

  it('una indisponibilidad de Siigo dice que vuelve sola y que no hay que intervenir', () => {
    const guia = traducirErrorSiigo(503, cuerpo('service_unavailable', [])).guia;

    expect(guia.reintentable).toBe(true);
    expect(guia.texto).toMatch(/Se reintenta automáticamente/);
    expect(guia.texto).toMatch(/no hace falta intervenir/);
    expect(guia.responsable).toBe('automatico');
  });

  it('las dos frases son excluyentes: ningún texto puede decir las dos cosas', () => {
    for (const codigo of codigosCatalogados()) {
      const texto = guiaParaCodigo(codigo).texto;
      const dicePasajero = /Se reintenta automáticamente/.test(texto);
      const diceDefinitivo = /Reintentar no lo arregla/.test(texto);
      expect(dicePasajero).not.toBe(diceDefinitivo);
    }
  });

  it('un lote con un error de datos dentro no promete reintento aunque el primero sea transitorio', () => {
    // El código principal es `requests_limit`, que por sí solo se reintenta. Pero el lote trae una
    // fecha mala: si la guía copiara el defecto del catálogo, prometería un reintento que la cola
    // nunca va a hacer, y la factura se quedaría esperando para siempre.
    const e = traducirErrorSiigo(429, {
      Status: 429,
      Errors: [
        { Code: 'requests_limit', Message: 'demasiadas' },
        { Code: 'invalid_date', Message: 'fecha mala' },
      ],
    });

    expect(e.reintentable).toBe(false);
    expect(e.guia.reintentable).toBe(false);
    expect(e.guia.texto).toMatch(/Reintentar no lo arregla/);
  });

  it('una respuesta rara con estado transitorio sí se anuncia como reintentable', () => {
    // Aquí manda el estado HTTP, no el catálogo: el código sintético no dice nada de reintentos.
    const e = traducirErrorSiigo(503, '<html>Bad Gateway</html>');

    expect(e.code).toBe(CODIGO_RESPUESTA_INESPERADA);
    expect(e.guia.reintentable).toBe(true);
    expect(e.guia.texto).toMatch(/Se reintenta automáticamente/);
  });

  it('la misma respuesta rara con un 400 se anuncia como definitiva', () => {
    const e = traducirErrorSiigo(400, '<html>Bad Request</html>');
    expect(e.guia.reintentable).toBe(false);
    expect(e.guia.texto).toMatch(/Reintentar no lo arregla/);
  });
});

describe('AC4 — un código desconocido no se queda mudo', () => {
  it('el texto genérico sigue siendo accionable y nombra el código original', () => {
    const guia = traducirErrorSiigo(400, cuerpo('invoice_zeta_9000', [])).guia;

    expect(guia.conocido).toBe(false);
    expect(guia.texto).toContain('invoice_zeta_9000');
    expect(guia.texto).toMatch(/soporte técnico/);
    expect(guia.responsable).toBe('soporte');
  });

  it('un código que nadie tradujo no se reintenta: el defecto seguro es parar y avisar', () => {
    // Siigo bloquea el usuario API si durante 7 días más del 80 % de las peticiones fallan.
    const guia = guiaParaCodigo('codigo_recien_inventado');
    expect(guia.reintentable).toBe(false);
    expect(guia.texto).toMatch(/Reintentar no lo arregla/);
  });

  it('queda registrado para poder añadirlo al catálogo', () => {
    traducirErrorSiigo(400, cuerpo('nuevo_codigo_de_siigo', []));
    expect(codigosSinCatalogar()).toContain('nuevo_codigo_de_siigo');
  });

  it('un código conocido no ensucia el registro', () => {
    traducirErrorSiigo(400, cuerpo('invalid_date', []));
    guiaParaCodigo('invalid_date');
    expect(codigosSinCatalogar()).toEqual([]);
  });

  it('el mismo código desconocido se registra una vez, no una por factura', () => {
    // Si Siigo empieza a devolver un código nuevo en cada factura de la noche interesa saberlo,
    // no tener cuatro mil líneas idénticas en la bitácora.
    for (let i = 0; i < 50; i += 1) guiaParaCodigo('codigo_repetido');
    expect(codigosSinCatalogar()).toEqual(['codigo_repetido']);
  });

  it('el registro está acotado: un código desconocido no puede vaciar la memoria', () => {
    for (let i = 0; i < 500; i += 1) guiaParaCodigo(`codigo_${i}`);
    expect(codigosSinCatalogar().length).toBeLessThanOrEqual(200);
  });

  it('`sin_codigo` también se registra: un error sin Code es tan opaco como uno desconocido', () => {
    traducirErrorSiigo(400, { Status: 400, Errors: [{ Message: 'algo pasó' }] });
    expect(codigosSinCatalogar()).toContain('sin_codigo');
  });
});

describe('AC5 — el texto no filtra detalles técnicos', () => {
  it('no reproduce el mensaje que devolvió Siigo: el texto se arma con el catálogo', () => {
    // Es la defensa estructural. `Message` y `Detail` son los únicos campos por donde podría venir
    // un volcado, y sencillamente no participan en la construcción del texto.
    const e = traducirErrorSiigo(400, {
      Status: 400,
      Errors: [{
        Code: 'invalid_value',
        Message: 'Failed query: select * from "clientes" where "cedula" = $1 params: 1032456789',
        Detail: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.firma',
      }],
    });

    expect(e.guia.texto).not.toContain('1032456789');
    expect(e.guia.texto).not.toContain('Bearer');
    expect(e.guia.texto).not.toContain('clientes');
  });

  // Estos dos esperaban las marcas ESPECÍFICAS de SQL y de secreto, que son las que produce la
  // lista negra de contenido. Desde la HU #11333 los `params` pasan antes por una lista BLANCA de
  // forma —un nombre de campo no lleva espacios, ni comillas, ni un `=` con un valor detrás—, que
  // los ataja antes y cubre estrictamente más: también una cédula o un correo, que ninguna lista
  // negra reconoce. La garantía que estos tests defienden sigue en pie y es más fuerte; lo que
  // cambia es qué marca aparece. Las marcas específicas siguen aplicando donde la lista negra es la
  // única defensa, como el propio código de error —ver el test del JWT, justo debajo.
  it('un volcado de SQL colado en un nombre de campo no sale, y se dice que se omitió algo', () => {
    const guia = guiaParaCodigo('invalid_value', {
      params: ['Failed query: insert into "siigo_operaciones" values ($1)'],
    });

    expect(guia.texto).not.toMatch(/siigo_operaciones/);
    expect(guia.texto).toContain(MARCA_CAMPO_OMITIDO);
  });

  it('algo con pinta de credencial en un campo se sustituye por una marca', () => {
    const guia = guiaParaCodigo('invalid_value', { params: ['access_key=8f3a91c2d7e5'] });

    expect(guia.texto).not.toContain('8f3a91c2d7e5');
    expect(guia.texto).toContain(MARCA_CAMPO_OMITIDO);
  });

  it('y un dato personal, que ninguna lista negra reconocía, tampoco sale', () => {
    const guia = guiaParaCodigo('invalid_identification', { params: ['1032456789'] });
    expect(guia.texto).not.toContain('1032456789');
    expect(guia.texto).toContain(MARCA_CAMPO_OMITIDO);
  });

  it('un token JWT colado en el código de error tampoco sale', () => {
    const guia = guiaParaCodigo('eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZGxhcmdv.firmafirma');

    expect(guia.texto).not.toContain('cGF5bG9hZGxhcmdv');
    expect(guia.texto).toContain(MARCA_SECRETO_OMITIDO);
  });

  it('la longitud está acotada aunque Siigo devuelva doscientos campos', () => {
    const params = Array.from({ length: 200 }, (_, i) => `campo_numero_${i}`);
    const guia = guiaParaCodigo('parameter_required', { params });

    expect(guia.texto.length).toBeLessThanOrEqual(MAX_LONGITUD_MENSAJE + 1);
    // Y lo que importa no se pierde por el recorte de los campos.
    expect(guia.texto).toMatch(/Lo resuelve:/);
  });

  it('un código absurdamente largo no se lleva por delante el texto', () => {
    const guia = guiaParaCodigo('x'.repeat(5000));

    expect(guia.texto.length).toBeLessThanOrEqual(MAX_LONGITUD_MENSAJE + 1);
    expect(guia.texto).toMatch(/soporte técnico/);
  });

  it('ningún texto del catálogo llega siquiera cerca del tope', () => {
    for (const codigo of codigosCatalogados()) {
      expect(guiaParaCodigo(codigo).texto.length).toBeLessThan(MAX_LONGITUD_MENSAJE);
    }
  });
});
