// HU #11343 — qué correcciones admite una factura ya emitida (Feature #11244).
//
// Dos cosas se prueban aquí, y la segunda importa tanto como la primera.
//
// 1. **La decisión.** `evaluarCorreccion()` es pura, así que se puede interrogar caso por caso sin
//    base de datos ni red. Es justamente la razón de que sea pura: esta respuesta se da en tres
//    sitios —la pantalla, el registro y el mensaje de `reversar`— y no puede diferir entre ellos.
//
// 2. **Lo que la historia se niega a afirmar.** No se sabe si corregir una factura aceptada por la
//    DIAN es una nota crédito: ese grupo de la API de Siigo nunca se ha leído (pregunta 8, abierta
//    por dos motivos, el de negocio y el documental). Hay tests abajo que fallan si alguien mete
//    `nota_credito` en el catálogo o si el ejecutor automático aparece sin que la pregunta se haya
//    respondido. **Que fallen no es que el test sobre: es que la respuesta tiene que quedar escrita.**

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  SIIGO_CORRECCION_EJECUTORES, SIIGO_CORRECCION_MOTIVO_MIN, SIIGO_CORRECCION_TIPOS,
  SIIGO_CORRECCION_TIPO_ETIQUETA, SIIGO_CORRECCION_VIAS,
} from '@operaciones/shared-types';
import {
  evaluarCorreccion, opcionDe, resumirVia, type SituacionFactura,
} from '../../src/modules/siigo/siigo.correcciones.js';

const MIGRACION = readFileSync(
  path.resolve(process.cwd(), 'src/db/migrations/0140_siigo_factura_correcciones.sql'),
  'utf8',
);

/**
 * La migración sin sus comentarios. Se necesita porque el archivo EXPLICA largamente por qué no
 * existe `nota_credito`, y un test que buscara la cadena a secas confundiría la explicación con la
 * afirmación — exactamente al revés de lo que hay que vigilar.
 */
const SQL_EJECUTABLE = MIGRACION.replace(/^\s*--.*$/gm, '').replace(/\s--.*$/gm, '');

const AHORA = new Date('2026-08-10T15:00:00Z');
const HACE_UN_DIA = new Date('2026-08-09T15:00:00Z');

/** Una factura emitida que todavía no ha llegado a la DIAN: sin CUFE y sin envío en curso. */
function sinDian(over: Partial<SituacionFactura> = {}): SituacionFactura {
  return {
    estado: 'emitida', siigoInvoiceId: 'inv-1', cufe: null, emitidaEn: HACE_UN_DIA, ...over,
  };
}

/** La misma factura ya aceptada por la DIAN: tiene CUFE. Es el caso que hay que corregir. */
function aceptada(over: Partial<SituacionFactura> = {}): SituacionFactura {
  return sinDian({ cufe: 'cufe-abc', ...over });
}

describe('AC1 — el sistema dice qué correcciones admite cada factura', () => {
  it('devuelve una opción por cada tipo del catálogo, ninguna sin motivo', () => {
    for (const situacion of [sinDian(), aceptada(), sinDian({ estado: 'fallida' })]) {
      const e = evaluarCorreccion(situacion, { ahora: AHORA });
      expect(e.opciones.map((o) => o.tipo).sort()).toEqual([...SIIGO_CORRECCION_TIPOS].sort());
      // Una exclusión sin motivo no es una respuesta: obliga a preguntar por fuera del sistema.
      for (const o of e.opciones) expect(o.motivo.length).toBeGreaterThan(20);
    }
  });

  it('sin CUFE, las dos operaciones que Siigo documenta quedan admisibles', () => {
    const e = evaluarCorreccion(sinDian(), { ahora: AHORA });
    expect(opcionDe(e, 'anulacion')!.admisible).toBe(true);
    expect(opcionDe(e, 'borrado')!.admisible).toBe(true);
    // Y se nombran por su endpoint: son operaciones DISTINTAS, no dos nombres de la misma.
    expect(opcionDe(e, 'anulacion')!.motivo).toContain('/annul');
    expect(opcionDe(e, 'borrado')!.motivo).toContain('DELETE /v1/invoices');
  });

  it('con CUFE, ninguna de las dos aplica, y el motivo cita el hecho', () => {
    const e = evaluarCorreccion(aceptada(), { ahora: AHORA });
    for (const tipo of ['anulacion', 'borrado'] as const) {
      const o = opcionDe(e, tipo)!;
      expect(o.admisible).toBe(false);
      expect(o.motivo).toContain('CUFE');
      expect(o.motivo).toContain('siigo-api.md');
    }
  });

  it('en proceso de envío a la DIAN se excluyen igual que con CUFE', () => {
    // La documentación excluye los dos casos, no solo el aceptado. El dato lo aportará la HU #11330.
    const e = evaluarCorreccion(sinDian({ enTransitoAnteDian: true }), { ahora: AHORA });
    expect(opcionDe(e, 'anulacion')!.admisible).toBe(false);
    expect(opcionDe(e, 'anulacion')!.motivo).toContain('proceso de envío');
  });

  it('cuando no queda ninguna operación de Siigo, la vía es registrar la hecha por fuera', () => {
    const e = evaluarCorreccion(aceptada(), { ahora: AHORA });
    expect(e.puedeCorregirse).toBe(true);
    expect(e.via).toBe('registro_externo');
    expect(opcionDe(e, 'otra')!.admisible).toBe(true);
    expect(opcionDe(e, 'otra')!.ejecutores).toEqual(['manual']);
    // Y no se automatiza lo que no se sabe qué es.
    expect(opcionDe(e, 'otra')!.automatizable).toBe(false);
  });

  it('no llama a Siigo: la evaluación es síncrona y no devuelve una promesa', () => {
    // La comprobación es tonta y es el punto: una función que no puede esperar a nadie no puede
    // consultar a nadie. Si algún día alguien la hace `async`, este test lo dice.
    expect(evaluarCorreccion(sinDian(), { ahora: AHORA })).not.toBeInstanceOf(Promise);
  });
});

describe('AC1 — la evaluación también es función del tiempo transcurrido', () => {
  it('calcula la antigüedad de la factura en horas', () => {
    expect(evaluarCorreccion(sinDian(), { ahora: AHORA }).antiguedadHoras).toBe(24);
  });

  it('con una ventana establecida, pasada la ventana la anulación queda fuera', () => {
    const e = evaluarCorreccion(sinDian(), { ahora: AHORA, ventanaAnulacionHoras: 12 });
    expect(opcionDe(e, 'anulacion')!.admisible).toBe(false);
    expect(opcionDe(e, 'anulacion')!.motivo).toContain('ventana');
    // El borrado no tiene ventana documentada: suponerle una sería inventar una norma.
    expect(opcionDe(e, 'borrado')!.admisible).toBe(true);
  });

  it('dentro de la ventana, la anulación sigue admisible', () => {
    const e = evaluarCorreccion(sinDian(), { ahora: AHORA, ventanaAnulacionHoras: 48 });
    expect(opcionDe(e, 'anulacion')!.admisible).toBe(true);
  });

  it('SIN ventana establecida no se excluye por tiempo, y se dice que no la hay', () => {
    // Es la respuesta honesta mientras la pregunta 8 siga abierta: nadie ha establecido el plazo, y
    // escribir aquí «5 días» sería inventarse una norma de la DIAN.
    const e = evaluarCorreccion(sinDian(), { ahora: AHORA });
    expect(opcionDe(e, 'anulacion')!.admisible).toBe(true);
    expect(opcionDe(e, 'anulacion')!.motivo).toContain('pregunta 8');
  });

  it('una fecha de emisión en el futuro no produce una antigüedad negativa', () => {
    const e = evaluarCorreccion(
      sinDian({ emitidaEn: new Date('2026-08-11T15:00:00Z') }),
      { ahora: AHORA, ventanaAnulacionHoras: 1 },
    );
    // Con antigüedad negativa, `-24 > 1` sería falso y la ventana pasaría por accidente. Se acota a 0
    // para que el reloj torcido de un servidor no autorice una anulación.
    expect(e.antiguedadHoras).toBe(0);
  });
});

describe('AC6 — no se corrige lo que no llegó a existir', () => {
  it('una emisión fallida no admite ninguna corrección', () => {
    const e = evaluarCorreccion(sinDian({ estado: 'fallida' }), { ahora: AHORA });
    expect(e.puedeCorregirse).toBe(false);
    expect(e.opciones.every((o) => !o.admisible)).toBe(true);
    expect(e.via).toBe('reintento');
    expect(e.viaTexto).toContain('reintentar');
    expect(e.viaTexto).toContain('fallida definitiva');
  });

  it('una factura en proceso sin identificador de Siigo tampoco', () => {
    const e = evaluarCorreccion(
      { estado: 'en_proceso', siigoInvoiceId: null, cufe: null }, { ahora: AHORA },
    );
    expect(e.puedeCorregirse).toBe(false);
    expect(e.via).toBe('reintento');
  });

  it('sin documento no hay antigüedad que reportar', () => {
    const e = evaluarCorreccion({ estado: 'en_proceso', siigoInvoiceId: null, cufe: null });
    expect(e.antiguedadHoras).toBeNull();
  });
});

describe('AC2 — el ejecutor es intercambiable y hoy solo existe uno', () => {
  it('toda opción admisible ofrece exactamente el ejecutor manual', () => {
    for (const situacion of [sinDian(), aceptada()]) {
      for (const o of evaluarCorreccion(situacion, { ahora: AHORA }).opciones) {
        expect(o.ejecutores).toEqual(o.admisible ? ['manual'] : []);
      }
    }
  });

  it('«automatizable» no significa «ejecutable hoy»', () => {
    // La anulación de una factura sin CUFE es automatizable —Siigo la documenta— y aun así el único
    // ejecutor es el manual, porque el automático es la HU #11344 y está bloqueada.
    const o = opcionDe(evaluarCorreccion(sinDian(), { ahora: AHORA }), 'anulacion')!;
    expect(o.automatizable).toBe(true);
    expect(o.ejecutores).toEqual(['manual']);
  });

  it('el catálogo de ejecutores sigue teniendo uno solo', () => {
    // Si esto falla es porque llegó el ejecutor automático, y eso significa que la pregunta 8 se
    // respondió. Esa respuesta tiene que estar escrita en el diseño antes que en el código.
    expect(SIIGO_CORRECCION_EJECUTORES).toEqual(['manual']);
  });
});

describe('la historia no afirma lo que no sabe', () => {
  it('«nota crédito» no existe como tipo de corrección', () => {
    // `docs/integraciones/siigo-api.md` documenta DELETE=borrar y POST /annul=anular como
    // operaciones distintas, dice que NINGUNA aplica a una factura con CUFE, y el grupo
    // /v1/credit-notes nunca se ha leído. Nombrar `nota_credito` sería convertir eso en un hecho.
    expect(SIIGO_CORRECCION_TIPOS).not.toContain('nota_credito');
    // Sobre el SQL ejecutable: el archivo sí explica en prosa por qué el valor no está, y esa
    // explicación es media historia — lo que no puede aparecer es como literal de una sentencia.
    expect(SQL_EJECUTABLE).not.toContain('nota_credito');
  });

  it('ninguna evaluación nombra la nota crédito como la vía', () => {
    for (const situacion of [sinDian(), aceptada(), sinDian({ estado: 'fallida' })]) {
      const e = evaluarCorreccion(situacion, { ahora: AHORA });
      const texto = [e.viaTexto, ...e.opciones.map((o) => o.motivo)].join(' ').toLowerCase();
      expect(texto).not.toContain('nota crédito');
      expect(texto).not.toContain('nota credito');
    }
  });

  it('para una factura aceptada se dice que cuál corresponde NO está establecido', () => {
    expect(opcionDe(evaluarCorreccion(aceptada(), { ahora: AHORA }), 'otra')!.motivo)
      .toContain('no está establecido');
  });

  it('cada tipo tiene etiqueta: la pantalla no puede quedarse sin texto', () => {
    expect(Object.keys(SIIGO_CORRECCION_TIPO_ETIQUETA).sort())
      .toEqual([...SIIGO_CORRECCION_TIPOS].sort());
  });
});

describe('AC5 — el resumen que usa el mensaje de reversar', () => {
  it('nombra los tipos admisibles cuando Siigo documenta alguno', () => {
    const texto = resumirVia(evaluarCorreccion(sinDian(), { ahora: AHORA }));
    expect(texto).toContain('anulacion');
    expect(texto).toContain('borrado');
  });

  it('cuando no queda ninguno, lo dice y remite al registro de la hecha por fuera', () => {
    const texto = resumirVia(evaluarCorreccion(aceptada(), { ahora: AHORA }));
    expect(texto).toContain('Ninguna operación de la API de Siigo');
    expect(texto).toContain('se registra en FLITO');
  });

  it('sin documento, remite al reintento y no a una corrección', () => {
    const texto = resumirVia(evaluarCorreccion(sinDian({ estado: 'fallida' }), { ahora: AHORA }));
    expect(texto).toContain('reintentar');
  });

  it('las vías son las dos del catálogo, ni una más', () => {
    expect(SIIGO_CORRECCION_VIAS).toEqual(['registro_externo', 'reintento']);
  });
});

describe('el modelo: lo que la migración 0140 garantiza', () => {
  it('los tipos del código y los del CHECK son los mismos', () => {
    const m = /CONSTRAINT\s+siigo_correccion_tipo_chk[\s\S]*?IN\s*\(([^)]*)\)/.exec(MIGRACION);
    const enLaBase = [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!).sort();
    expect(enLaBase).toEqual([...SIIGO_CORRECCION_TIPOS].sort());
  });

  it('los ejecutores también', () => {
    const m = /CONSTRAINT\s+siigo_correccion_ejecutor_chk[\s\S]*?IN\s*\(([^)]*)\)/.exec(MIGRACION);
    const enLaBase = [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!).sort();
    expect(enLaBase).toEqual([...SIIGO_CORRECCION_EJECUTORES].sort());
  });

  it('NO añade una sola columna a siigo_facturas', () => {
    // La Feature 13 tiene que poder evolucionar su fila sin arrastrar a nadie, y una factura
    // corregida sigue existiendo ante la DIAN: no se marca encima de la historia.
    expect(MIGRACION).not.toMatch(/ALTER TABLE\s+siigo_facturas/i);
  });

  it('la corrección cuelga de la factura con clave foránea', () => {
    expect(MIGRACION).toMatch(/factura_id\s+uuid NOT NULL REFERENCES siigo_facturas\(id\)/);
  });

  it('es append-only: lo que afirma que una factura se corrigió no se reescribe', () => {
    expect(MIGRACION).toContain('trg_siigo_correcciones_no_update');
    expect(MIGRACION).toContain('trg_siigo_correcciones_no_delete');
    // Y los permisos acompañan al disparador: sin UPDATE ni DELETE concedidos.
    expect(MIGRACION).toMatch(/GRANT SELECT, INSERT ON siigo_factura_correcciones/);
  });

  it('el motivo es obligatorio en la base, no solo en el formulario', () => {
    expect(MIGRACION).toMatch(/motivo\s+text NOT NULL/);
    expect(MIGRACION).toContain(`length(btrim(motivo)) >= ${SIIGO_CORRECCION_MOTIVO_MIN}`);
  });

  it('un doble envío no puede dejar dos correcciones del mismo documento', () => {
    // En una tabla que prohíbe DELETE, la fila duplicada se quedaría para siempre.
    expect(MIGRACION).toMatch(
      /CREATE UNIQUE INDEX[^;]*idx_siigo_correcciones_documento[\s\S]*?\(factura_id,\s*lower\(btrim\(documento_siigo\)\)\)/,
    );
  });

  it('no abre transacción propia (ADR-DB-001)', () => {
    expect(MIGRACION).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\s*;/im);
  });
});
