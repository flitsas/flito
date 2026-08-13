// Siigo — ¿este trámite se puede enviar a facturación electrónica? (HU #11324). Un bloque por AC.
//
// La mayor parte de la regla es PURA (`motivosLocales`) y se interroga sin base ni red: es donde
// vive el negocio y donde conviene poder probar exhaustivamente y barato.
//
// Lo que NO se puede afirmar aquí es que la condición de documentación completa sea correcta: eso
// es SQL, se reutiliza del reporte de costos por exigencia del AC6, y se verificó ejecutando la
// consulta compilada contra PostgreSQL 16 real.

import { describe, it, expect } from 'vitest';
import {
  MOTIVOS_TRAMITE_NO_ELEGIBLE, MOTIVO_TRAMITE_NO_ELEGIBLE_TEXTO, resumenElegibilidadVacio,
} from '@operaciones/shared-types';
import {
  esAnteriorAlCorte, motivosLocales, resumirElegibilidad,
} from '../../src/modules/siigo/facturacion.elegibilidad.service.js';

/** Un trámite que SÍ se puede enviar: todo en orden. */
function fila(over: Record<string, unknown> = {}) {
  return {
    tramiteId: 'aaaa1111-2222-4333-8444-555566667777',
    companiaId: 42,
    estadoLiquidacion: 'facturado',
    facturadoEn: '2026-08-01',
    documentacionCompleta: true,
    terceroVinculado: true,
    facturaViva: false,
    historicoDesde: '2026-01-01',
    valores: {
      valorSoat: '450000.00', valorImpuesto: null, valorDerecho: '80000.00',
      valorTramiteDigital: '200000.00', valorLogistica: null, valorGmf: '3460.00',
    },
    cliente: null,
    ...over,
  } as Parameters<typeof motivosLocales>[0];
}

const nombres = (f: Parameters<typeof motivosLocales>[0]) => motivosLocales(f).map((m) => m.motivo);

describe('AC3 — solo se envía lo que ya está sellado y facturado', () => {
  it('una liquidación facturada sí pasa: la emisión es el paso SIGUIENTE al botón', () => {
    expect(nombres(fila())).not.toContain('liquidacion_no_facturada');
  });

  it.each(['liquidado', null, 'estimado'])('con estado %s no pasa', (estado) => {
    // Facturar valores que todavía pueden cambiar produce una factura que habrá que corregir ante
    // la DIAN, y corregir allá es caro o imposible.
    expect(nombres(fila({ estadoLiquidacion: estado }))).toContain('liquidacion_no_facturada');
  });
});

describe('AC4 — el corte del histórico es un dato, no un supuesto', () => {
  it('lo anterior al corte no pasa', () => {
    expect(nombres(fila({ facturadoEn: '2025-12-31' }))).toContain('anterior_al_corte');
  });

  it('el propio día del corte sí pasa: el corte incluye su fecha', () => {
    expect(nombres(fila({ facturadoEn: '2026-01-01' }))).not.toContain('anterior_al_corte');
  });

  it('cambiar la fecha cambia el veredicto sin tocar código', () => {
    const t = { facturadoEn: '2026-03-15' };
    expect(nombres(fila({ ...t, historicoDesde: '2026-01-01' }))).not.toContain('anterior_al_corte');
    expect(nombres(fila({ ...t, historicoDesde: '2026-06-01' }))).toContain('anterior_al_corte');
  });

  it('sin fecha configurada NO se factura nada, y se dice por qué', () => {
    // **Esta prueba afirmaba lo contrario, y esa era la regresión.** El razonamiento de entonces
    // seguía en pie —«la ausencia de configuración no puede comportarse como una prohibición
    // silenciosa: alguien buscaría durante horas por qué no se factura y no habría nada que
    // encontrar»— pero la 0148 retiró la pantalla que escribía la tabla y «no hay fila» pasó a ser
    // el estado normal de cualquier ambiente. Con la regla vieja, el único control que impide
    // facturar histórico no autorizado quedaba apagado en todas partes, sin ruido.
    //
    // Lo que se conserva del argumento original es el antídoto, no la conclusión: se bloquea, pero
    // con un motivo PROPIO que se cuenta y se pinta. Un bloqueo explicado no es un bloqueo
    // silencioso, y en la única puerta antes de la DIAN el error tiene que caer de este lado.
    const m = nombres(fila({ historicoDesde: null, facturadoEn: '2020-01-01' }));
    expect(m).toContain('sin_corte_configurado');
    // Y NO se disfraza del otro motivo: «se facturó antes del corte» mandaría a subir una fecha que
    // no existe, en vez de a sembrarla.
    expect(m).not.toContain('anterior_al_corte');
  });

  it('con fecha configurada, el motivo de ambiente sin sembrar desaparece', () => {
    expect(nombres(fila())).not.toContain('sin_corte_configurado');
    expect(nombres(fila({ facturadoEn: '2025-12-31' }))).not.toContain('sin_corte_configurado');
  });

  it('ante la duda BLOQUEA, nunca deja pasar', () => {
    // Es la única puerta antes de emitir ante la DIAN. Un falso «no elegible» se corrige mirando;
    // un falso «elegible» se corrige ante la autoridad. Con formatos raros, la comparación de
    // cadenas cae del lado seguro.
    expect(nombres(fila({ facturadoEn: '01/06/2025', historicoDesde: '2026-01-01' })))
      .toContain('anterior_al_corte');
    expect(nombres(fila({ facturadoEn: '2025-06-01', historicoDesde: 'no-es-una-fecha' })))
      .toContain('anterior_al_corte');
  });

  it('sin fecha de facturación no pasa por OTRA razón, no por el corte', () => {
    // Un CHECK de la tabla garantiza que toda liquidación `facturado` tiene fecha, así que un nulo
    // significa que no está facturada — y eso ya lo bloquea la comprobación del AC3.
    const m = nombres(fila({ facturadoEn: null, estadoLiquidacion: 'liquidado' }));
    expect(m).toContain('liquidacion_no_facturada');
    expect(m).not.toContain('anterior_al_corte');
  });

  it('se puede contar cuántos quedan a cada lado', () => {
    expect(esAnteriorAlCorte({ facturadoEn: '2025-01-01', historicoDesde: '2026-01-01' })).toBe(true);
    expect(esAnteriorAlCorte({ facturadoEn: '2026-05-01', historicoDesde: '2026-01-01' })).toBe(false);
    expect(esAnteriorAlCorte({ facturadoEn: null, historicoDesde: '2026-01-01' })).toBe(false);
  });
});

describe('AC5 — el tercero tiene que estar vinculado', () => {
  it('sin vínculo no pasa, y lo dice por su nombre', () => {
    expect(nombres(fila({ terceroVinculado: false }))).toContain('tercero_sin_vincular');
  });

  it('sin compañía el motivo es OTRO: no hay a quién facturarle', () => {
    // Distinguirlos importa: «sincroniza el tercero» sobre un trámite sin compañía manda a alguien
    // a una pantalla donde no hay nada que sincronizar.
    const m = nombres(fila({ companiaId: null, terceroVinculado: false }));
    expect(m).toContain('sin_compania');
    expect(m).not.toContain('tercero_sin_vincular');
  });
});

describe('AC6 y la duplicación', () => {
  it('sin documentación completa no pasa', () => {
    expect(nombres(fila({ documentacionCompleta: false }))).toContain('documentacion_incompleta');
  });

  it('un trámite con factura viva no se vuelve a enviar', () => {
    // Emitir dos veces el mismo trámite lo duplica ante la DIAN, y eso no se deshace.
    expect(nombres(fila({ facturaViva: true }))).toContain('ya_facturado');
  });
});

describe('AC1 — los motivos se enumeran TODOS, no se corta en el primero', () => {
  it('un trámite con cuatro problemas devuelve los cuatro', () => {
    const m = nombres(fila({
      estadoLiquidacion: 'liquidado',
      documentacionCompleta: false,
      terceroVinculado: false,
      facturadoEn: '2025-01-01',
    }));

    // Enumerar todo de una vez es la diferencia entre una corrección y cuatro viajes: quien arregla
    // la documentación quiere enterarse EN ESE MOMENTO de que además falta sincronizar el tercero.
    expect(m).toEqual(expect.arrayContaining([
      'liquidacion_no_facturada', 'tercero_sin_vincular',
      'documentacion_incompleta', 'anterior_al_corte',
    ]));
  });

  it('un trámite en orden no devuelve ningún motivo', () => {
    expect(motivosLocales(fila())).toEqual([]);
  });

  it('nunca hay un motivo genérico: cada uno está en el catálogo y tiene texto', () => {
    for (const m of MOTIVOS_TRAMITE_NO_ELEGIBLE) {
      expect(MOTIVO_TRAMITE_NO_ELEGIBLE_TEXTO[m], m).toBeTruthy();
      expect(MOTIVO_TRAMITE_NO_ELEGIBLE_TEXTO[m].length, m).toBeGreaterThan(20);
    }
  });

  it('el detalle dice qué hacer, no solo qué pasa', () => {
    // Un motivo que solo nombra el problema deja a quien lo lee en el mismo sitio que un mensaje
    // genérico. Cada texto del catálogo apunta a dónde se arregla.
    const t = MOTIVO_TRAMITE_NO_ELEGIBLE_TEXTO;
    expect(t.liquidacion_no_facturada).toMatch(/reporte de costos/i);
    expect(t.tercero_sin_vincular).toMatch(/sincron/i);
    expect(t.anterior_al_corte).toMatch(/configuración de emisión/i);
    // Este manda a AVISAR, no a configurar: la fila del ambiente se siembra con una migración y no
    // hay pantalla donde tocarla. Decir «configúralo» sería mandar a buscar algo que no existe.
    expect(t.sin_corte_configurado).toMatch(/equipo técnico/i);
  });
});

describe('AC4 — el resumen', () => {
  it('parte de todos los motivos a cero: ninguno desaparece', () => {
    const r = resumenElegibilidadVacio();
    for (const m of MOTIVOS_TRAMITE_NO_ELEGIBLE) expect(r.porMotivo[m]).toBe(0);
  });

  it('un trámite con varios motivos cuenta en TODOS', () => {
    const r = resumirElegibilidad([
      { tramiteId: 'a', elegible: false, motivos: [
        { motivo: 'documentacion_incompleta', detalle: 'x' },
        { motivo: 'tercero_sin_vincular', detalle: 'y' },
      ] },
      { tramiteId: 'b', elegible: true, motivos: [] },
    ]);

    // La pregunta que responde es «¿cuántos están frenados por cada causa?», no «¿en qué cajón cae
    // cada uno?». Repartirlos por su primer motivo escondería que arreglar la documentación no
    // desbloquea a los que además tienen el tercero sin vincular.
    expect(r.porMotivo.documentacion_incompleta).toBe(1);
    expect(r.porMotivo.tercero_sin_vincular).toBe(1);
    expect(r).toMatchObject({ total: 2, elegibles: 1, noElegibles: 1 });
  });

  it('un motivo repetido en el mismo trámite cuenta una vez', () => {
    // El validador de clientes puede devolver varios faltantes, y todos entran como
    // `cliente_no_facturable`. Contarlos por separado inflaría el número de TRÁMITES frenados.
    const r = resumirElegibilidad([
      { tramiteId: 'a', elegible: false, motivos: [
        { motivo: 'cliente_no_facturable', detalle: 'falta ciudad' },
        { motivo: 'cliente_no_facturable', detalle: 'falta responsabilidad fiscal' },
      ] },
    ]);
    expect(r.porMotivo.cliente_no_facturable).toBe(1);
    expect(r.noElegibles).toBe(1);
  });

  it('informa cuántos quedan al otro lado del corte', () => {
    const r = resumirElegibilidad([{ tramiteId: 'a', elegible: true, motivos: [] }], 17);
    // Es la información con la que alguien decide si la fecha de corte es la correcta.
    expect(r.anterioresAlCorte).toBe(17);
  });
});

describe('AC7 — la evaluación no gasta cuota de Siigo', () => {
  it('el servicio no importa el cliente HTTP de Siigo', async () => {
    const { readFileSync } = await import('node:fs');
    const fuente = readFileSync(
      new URL('../../src/modules/siigo/facturacion.elegibilidad.service.ts', import.meta.url), 'utf8');

    // Se consulta en cada carga del reporte. Una llamada a Siigo aquí gastaría la cuota que
    // comparte con la emisión: mirar frenaría facturar.
    expect(fuente).not.toContain('siigo.client');
    expect(fuente).not.toContain('siigoRequest');
  });

  it('reutiliza la condición del reporte, no una segunda definición', async () => {
    const fuente = (await import('node:fs')).readFileSync(
      new URL('../../src/modules/siigo/facturacion.elegibilidad.service.ts', import.meta.url), 'utf8');

    // El AC6 lo pide con todas las letras. Dos definiciones de «documentación completa» coinciden
    // hoy y divergen en cuanto una cambie — y la divergencia no falla: solo hace que el reporte y
    // la elegibilidad discrepen sobre el mismo trámite.
    expect(fuente).toContain('EXPR_DOC_COMPLETA');
    expect(fuente).toContain('conJoins');
  });
});

describe('Correcciones de la auditoría', () => {
  it('B3 — un cliente completo evalúa como FACTURABLE con la forma que devuelve la consulta', async () => {
    const { evaluarCliente } = await import('../../src/modules/siigo/siigo.validador-cliente.service.js');

    // Este test es el que faltaba, y su ausencia es lo que dejó pasar el fallo: mi fixture tenía
    // `cliente: null`, así que el camino del cliente no se ejercitaba nunca. La consulta usaba
    // `to_jsonb(clients)`, que devuelve nombres de COLUMNA (`person_type`), y el evaluador espera
    // los del modelo (`personType`): coincidían tres de quince, así que TODO cliente salía «no
    // facturable» con seis motivos falsos. Un `as never` impedía que el compilador lo dijera.
    const comoLaDevuelveLaConsulta = {
      id: 42,
      name: 'Transportes del Sur S.A.S.',
      document: '900123456',
      personType: 'Company',
      idType: '31',
      fiscalResponsibilities: ['R-99-PN'],
      address: 'Calle 100 # 20-30',
      countryCode: 'CO',
      stateCode: '11',
      cityCode: '11001',
      phoneIndicative: '601',
      phoneNumber: '3001234',
      contactFirstName: 'Ana',
      contactLastName: 'Ramírez',
      facturacionBloqueos: [],
    };

    expect(evaluarCliente(comoLaDevuelveLaConsulta as never).facturable).toBe(true);
  });

  it('B3 — con nombres de columna en vez de modelo, el veredicto sería falso', async () => {
    const { evaluarCliente } = await import('../../src/modules/siigo/siigo.validador-cliente.service.js');

    // La demostración del fallo: la MISMA información, con las claves que devolvía `to_jsonb`.
    const enSnakeCase = {
      id: 42, name: 'Transportes del Sur S.A.S.', document: '900123456',
      person_type: 'Company', id_type: '31', fiscal_responsibilities: ['R-99-PN'],
      address: 'Calle 100 # 20-30', country_code: 'CO', state_code: '11', city_code: '11001',
      phone_indicative: '601', phone_number: '3001234',
      contact_first_name: 'Ana', contact_last_name: 'Ramírez', facturacion_bloqueos: [],
    };

    expect(evaluarCliente(enSnakeCase as never).facturable).toBe(false);
  });

  it('C7 — la consulta ya NO trae la ficha fiscal del cliente', async () => {
    // B3 vigilaba que la proyección del cliente usara las claves del modelo y no las de la columna.
    // Desde C7 esa proyección no existe: la elegibilidad dejó de juzgar la ficha fiscal, porque sus
    // campos existen para CREAR el tercero en Siigo y no para facturar.
    //
    // Lo que se afirma ahora es más fuerte y de paso es una victoria de PII: quince columnas de
    // `clients` —dirección, teléfonos, nombre del contacto— dejaron de viajar en una consulta que el
    // reporte dispara en cada carga de pantalla, para doscientos trámites a la vez.
    const fuente = (await import('node:fs')).readFileSync(
      new URL('../../src/modules/siigo/facturacion.elegibilidad.service.ts', import.meta.url), 'utf8');
    const codigo = fuente.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

    expect(codigo).not.toContain('to_jsonb');
    expect(codigo).not.toContain('as never');
    expect(codigo).not.toContain("'contactFirstName'");
    expect(codigo).not.toContain("'phoneNumber'");
    expect(codigo).not.toContain('evaluarCliente');
  });

  it('B2 — la fecha se resuelve en hora de Colombia, no en UTC', async () => {
    const fuente = (await import('node:fs')).readFileSync(
      new URL('../../src/modules/siigo/facturacion.elegibilidad.service.ts', import.meta.url), 'utf8');

    // `facturado_en` es `timestamptz` y `::date` usa la zona de la SESIÓN, que es UTC. Toda
    // facturación entre las 19:00 y medianoche hora Bogotá se leía como del día siguiente, y en el
    // borde del corte eso DESACTIVA el bloqueo — en la franja de más actividad de cierre.
    expect(fuente).toContain('AT TIME ZONE');
    expect(fuente).toContain('TZ_COLOMBIA');
  });

  it('B1 — el corte sale de la configuración VIGENTE del ambiente', async () => {
    const fuente = (await import('node:fs')).readFileSync(
      new URL('../../src/modules/siigo/facturacion.elegibilidad.service.ts', import.meta.url), 'utf8');

    // `ORDER BY id` sobre una PK uuid aleatoria es un orden AL AZAR, e ignoraba `ambiente` y
    // `vigente`: podía aplicar el corte de pruebas o el de una configuración apagada, y dar
    // veredictos distintos en dos peticiones idénticas.
    expect(fuente).not.toMatch(/siigo_config_emision\s+ORDER BY id/);
    expect(fuente).toContain('WHERE ambiente =');
    expect(fuente).toContain('AND vigente');
  });
});
