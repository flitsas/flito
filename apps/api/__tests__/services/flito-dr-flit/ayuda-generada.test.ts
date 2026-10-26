// HU #13853 (Feature #13696, IA-1 · ADR-0027) — artefacto de fichas de Ayuda del API. AC1, AC2, AC3.
// El generador importa código PURO del web (catálogo, `parsearFicha`, `seccionesDeFicha`); el
// artefacto commiteado no importa nada del web (la imagen Docker del API no copia `apps/web`).
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, copyFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  COMANDO_REGENERAR, DIR_FICHAS, RUTA_ARTEFACTO, fichasPublicadas, generarArtefacto,
} from '../../../scripts/generar-ayuda-drflit';
import { FICHAS_AYUDA } from '../../../src/modules/flito-dr-flit/ayuda/fichas-ayuda.generated.js';
import { CATALOGO_AYUDA } from '../../../../web/src/content/ayuda/catalogo';
import { parsearFicha } from '../../../../web/src/lib/ayudaFicha';
import { parseMarkdown } from '../../../../web/src/lib/ayudaMarkdown';

const tmps: string[] = [];
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('AC3 — deriva entre fichas .md y artefacto commiteado', () => {
  it('regenerar en memoria da exactamente el archivo commiteado', () => {
    const commiteado = readFileSync(RUTA_ARTEFACTO, 'utf8');
    const enMemoria = generarArtefacto();
    expect(enMemoria === commiteado, `El artefacto de fichas está desactualizado: corra ${COMANDO_REGENERAR}`).toBe(true);
  });

  it('el mensaje de falla nombra el comando exacto', () => {
    expect(COMANDO_REGENERAR).toBe('npm run ayuda:drflit -w apps/api');
  });
});

describe('AC1 — contenido del artefacto', () => {
  it('trae cada ficha publicada del catálogo con todos sus campos, en el orden del catálogo', () => {
    const publicadas = CATALOGO_AYUDA.filter((e) => e.permiso && existsSync(path.join(DIR_FICHAS, `${e.clave}.md`)));
    expect(FICHAS_AYUDA.map((f) => f.clave)).toEqual(publicadas.map((e) => e.clave));
    expect(FICHAS_AYUDA.length).toBeGreaterThan(0);
    for (const f of FICHAS_AYUDA) {
      const entrada = publicadas.find((e) => e.clave === f.clave)!;
      const enc = parsearFicha(readFileSync(path.join(DIR_FICHAS, `${f.clave}.md`), 'utf8')).encabezado!;
      expect(f).toMatchObject({
        permiso: entrada.permiso, etiqueta: entrada.etiqueta, resumen: enc.resumen, version: enc.version,
        fecha: enc.fecha, palabrasClave: enc.palabrasClave, consultas: enc.consultas,
      });
      expect(f.secciones.length).toBeGreaterThan(0);
      for (const s of f.secciones) {
        expect(Object.keys(s).sort()).toEqual(['ancla', 'texto', 'titulo']);
        expect(s.ancla).not.toBe('');
      }
    }
  });

  it('las anclas son idénticas a los id h1–h3 que emite parseMarkdown del web', () => {
    for (const f of FICHAS_AYUDA) {
      const cuerpo = parsearFicha(readFileSync(path.join(DIR_FICHAS, `${f.clave}.md`), 'utf8')).cuerpo;
      const ids = parseMarkdown(cuerpo).flatMap((b) => (b.type === 'h1' || b.type === 'h2' || b.type === 'h3' ? [b.id] : []));
      expect(f.secciones.map((s) => s.ancla), f.clave).toEqual(ids);
    }
  });

  it('usa el `permiso` del catálogo, no la clave (soat → flito_soat, privacy_log_pii → privacy)', () => {
    const permiso = (c: string) => FICHAS_AYUDA.find((f) => f.clave === c)?.permiso;
    expect(permiso('soat')).toBe('flito_soat');
    expect(permiso('privacy_log_pii')).toBe('privacy');
  });

  it('el artefacto es autosuficiente: no importa nada (ni del web)', () => {
    const fuente = readFileSync(RUTA_ARTEFACTO, 'utf8');
    expect(fuente).not.toMatch(/^\s*import\s/m);
    expect(fuente).not.toMatch(/apps\/web\/src\/(lib|content)\/[^\s]*['"]/);
  });
});

describe('AC2 — ficha pendiente (entrada del catálogo sin .md)', () => {
  it('no aparece en el artefacto', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ayuda-drflit-'));
    tmps.push(dir);
    // Solo dos fichas publicadas: el resto del catálogo queda «pendiente».
    for (const c of ['soat', 'flito_impuestos']) copyFileSync(path.join(DIR_FICHAS, `${c}.md`), path.join(dir, `${c}.md`));
    expect(fichasPublicadas(dir).map((f) => f.clave).sort()).toEqual(['flito_impuestos', 'soat']);
    expect(generarArtefacto(dir)).not.toContain('"clave": "flito_tramites"');
  });

  it('las entradas del catálogo sin .md hoy tampoco están en el artefacto', () => {
    const md = new Set(readdirSync(DIR_FICHAS).filter((a) => a.endsWith('.md')).map((a) => a.slice(0, -3)));
    const pendientes = CATALOGO_AYUDA.filter((e) => !md.has(e.clave)).map((e) => e.clave);
    for (const c of pendientes) expect(FICHAS_AYUDA.some((f) => f.clave === c)).toBe(false);
  });
});
