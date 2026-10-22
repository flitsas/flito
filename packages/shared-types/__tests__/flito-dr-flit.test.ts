// HU #13803 (Feature #13695) — Contrato de la autorización de Dr. Flit en shared-types.
// D5: el texto no puede cambiar sin cambiar la versión (hash fijado por versión). P9-7: `cliente` fuera.
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  AUTORIZACIONES_DRFLIT, ETIQUETAS_AMBIENTE_DESPLIEGUE, FINALIDADES_DRFLIT, LIMITES_CASO_SOPORTE,
  ROLES_SOPORTE_DRFLIT, USER_ROLES,
} from '../src/index.js';

/**
 * Hash del texto por finalidad y versión. Si este test falla porque cambió el texto: SUBIR la versión
 * (las aceptaciones viejas dejan de valer, AC4) y fijar aquí el hash nuevo. Nunca solo el hash.
 */
const HASH_POR_VERSION: Record<string, Record<string, string>> = {
  soporte: { '2026-10-provisional-1': 'e737476539b3577b3048cb6d0bc3e5e73c3112d6197b3f84fda19d7f1d9fd38e' },
  ia: { '2026-10-provisional-1': '61f3309410ccc8462030f53e0017bc88cebe12f7707d535e5cbe610e65941883' },
};

const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

describe('AUTORIZACIONES_DRFLIT', () => {
  it.each(FINALIDADES_DRFLIT)('el texto de «%s» corresponde al hash fijado para su versión', (f) => {
    const { version, texto } = AUTORIZACIONES_DRFLIT[f];
    expect(HASH_POR_VERSION[f]?.[version], `versión sin hash fijado: ${version}`).toBeDefined();
    expect(sha(texto)).toBe(HASH_POR_VERSION[f]![version]);
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

describe('ROLES_SOPORTE_DRFLIT', () => {
  it('todos los roles salvo cliente (lista fijada: un rol nuevo obliga a decidir)', () => {
    expect([...ROLES_SOPORTE_DRFLIT]).toEqual([
      'admin', 'proveedor', 'transito', 'compliance', 'lider_pesv', 'supervisor_flota', 'conductor',
      'auditor', 'gestor_impuestos', 'mensajero', 'financiera',
    ]);
    expect(ROLES_SOPORTE_DRFLIT).not.toContain('cliente');
    expect(USER_ROLES).toContain('cliente');
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
