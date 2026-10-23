// HU #13803 (Feature #13695) — Contrato de la autorización de Dr. Flit en shared-types.
// D5: el texto no puede cambiar sin cambiar la versión (hash fijado por versión). Quién lo usa: las
// páginas con ficha de Ayuda FLITO (`PAGINAS_AYUDA_DRFLIT`), nunca una lista de roles.
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  AUTORIZACIONES_DRFLIT, ETIQUETAS_AMBIENTE_DESPLIEGUE, FINALIDADES_DRFLIT, LIMITES_CASO_SOPORTE,
  PAGINAS_AYUDA_DRFLIT, PAGES,
} from '../src/index.js';

/**
 * Hash del texto por finalidad y versión. Si este test falla porque cambió el texto: SUBIR la versión
 * (las aceptaciones viejas dejan de valer, AC4) y fijar aquí el hash nuevo. Nunca solo el hash.
 */
const HASH_POR_VERSION: Record<string, Record<string, string>> = {
  soporte: { '2026-10-provisional-1': 'e737476539b3577b3048cb6d0bc3e5e73c3112d6197b3f84fda19d7f1d9fd38e' },
  // HU #13856 (IA-4, AC10): texto ampliado (proveedor, transferencia internacional, qué se oculta y qué no).
  ia: { '2026-11-v1': '61de596ca5abfc27cecf9a22dbd613cd0bbdcf7c6df57995439841ac978b5212' },
};

const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

describe('AUTORIZACIONES_DRFLIT', () => {
  it.each(FINALIDADES_DRFLIT)('el texto de «%s» corresponde al hash fijado para su versión', (f) => {
    const { version, texto } = AUTORIZACIONES_DRFLIT[f];
    expect(HASH_POR_VERSION[f]?.[version], `versión sin hash fijado: ${version}`).toBeDefined();
    expect(sha(texto)).toBe(HASH_POR_VERSION[f]![version]);
  });

  it('IA-4 AC10: el texto «ia» 2026-11-v1 informa proveedor externo, transferencia, qué se oculta y qué no', () => {
    const { version, texto } = AUTORIZACIONES_DRFLIT.ia;
    expect(version).toBe('2026-11-v1');
    expect(texto).toMatch(/proveedor externo de inteligencia artificial \(Anthropic\)/);
    expect(texto).toMatch(/transferencia internacional/);
    for (const oculto of ['placas', 'VIN', 'documento', 'correos']) expect(texto).toContain(oculto);
    expect(texto).toMatch(/nombres de personas, las direcciones .* NO se pueden ocultar/);
    expect(texto).toMatch(/FLITO no guarda el texto/);
  });

  it('las dos finalidades son exactamente soporte e ia', () => {
    expect([...FINALIDADES_DRFLIT]).toEqual(['soporte', 'ia']);
    expect(Object.keys(AUTORIZACIONES_DRFLIT).sort()).toEqual(['ia', 'soporte']);
  });

  it('el texto sigue marcado como provisional (P9-5: HU-4 no cierra sin el aprobado)', () => {
    for (const f of FINALIDADES_DRFLIT) expect(AUTORIZACIONES_DRFLIT[f].texto).toMatch(/PROVISIONAL/);
  });

  it('está congelado', () => {
    expect(Object.isFrozen(AUTORIZACIONES_DRFLIT)).toBe(true);
    expect(Object.isFrozen(AUTORIZACIONES_DRFLIT.soporte)).toBe(true);
  });
});

describe('PAGINAS_AYUDA_DRFLIT', () => {
  it('son páginas existentes, sin repetir, congeladas y sin `flito_ayuda` (que solo tiene admin)', () => {
    for (const p of PAGINAS_AYUDA_DRFLIT) expect(Object.keys(PAGES)).toContain(p);
    expect(new Set(PAGINAS_AYUDA_DRFLIT).size).toBe(PAGINAS_AYUDA_DRFLIT.length);
    expect(PAGINAS_AYUDA_DRFLIT).not.toContain('flito_ayuda');
    expect(Object.isFrozen(PAGINAS_AYUDA_DRFLIT)).toBe(true);
  });
});

describe('etiquetas de ambiente y topes del caso', () => {
  it('PDN → Producción, QA → QA, DEV → Otro (DEV)', () => {
    expect(ETIQUETAS_AMBIENTE_DESPLIEGUE).toEqual({ PDN: 'Producción', QA: 'QA', DEV: 'Otro (DEV)' });
  });

  it('topes de longitud del anexo UX F5', () => {
    expect(LIMITES_CASO_SOPORTE.nombre.max).toBe(120);
    expect(LIMITES_CASO_SOPORTE.correo.max).toBe(254);
    expect(LIMITES_CASO_SOPORTE.titulo.max).toBe(120);
    expect(LIMITES_CASO_SOPORTE.detalle.max).toBe(2000);
    expect(LIMITES_CASO_SOPORTE.resultadoEsperado.max).toBe(1000);
  });
});
