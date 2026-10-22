// HU #13804 (AC4) — mapeo puro del caso a json-patch de FLIT - SOPORTE (verificado contra el Bug #13713).
import { describe, it, expect } from 'vitest';
import type { CasoSoporteDrFlit } from '@operaciones/shared-types';
import {
  construirBugSoporte, escaparHtml, textoHtml, tagsPara, fechaBogota, type ConfigMapeoAdo,
} from '../../../src/modules/flito-dr-flit/dr-flit-ado.mapeo.js';

const CFG: ConfigMapeoAdo = {
  campoDetalle: 'Microsoft.VSTS.TCM.ReproSteps', campoPrioridad: 'Microsoft.VSTS.Common.Priority',
  campoAmbiente: 'Custom.Environment', tags: 'FLITO', tagsPruebas: 'FLITO-PRUEBAS',
};
const CASO: CasoSoporteDrFlit = {
  claveIdempotencia: '00000000-0000-4000-8000-000000000001',
  contacto: { nombre: 'Ana "La" O\'Neil', correo: 'ana@ejemplo.com' },
  area: 'corredor_impuestos', titulo: 'Pantalla <img src=x onerror=alert(1)>',
  detalle: 'Línea 1\nLínea <2>', resultadoEsperado: 'Que funcione & ya', frecuencia: 'a_veces', prioridad: 'media',
};
const CTX = { intentoId: 42, ambiente: 'QA' as const, fecha: new Date('2026-10-22T15:30:00Z'), adjuntosCantidad: 0 };
const valor = (ops: ReturnType<typeof construirBugSoporte>, path: string) => ops.find((o) => o.path === path)?.value;

describe('mapeo a ADO', () => {
  it('título con prefijo constante; prioridad media → 2; ambiente y tags de pruebas en QA', () => {
    const ops = construirBugSoporte(CASO, CTX, CFG);
    expect(valor(ops, '/fields/System.Title')).toBe('[ DR. FLIT FLITO ] Pantalla <img src=x onerror=alert(1)>');
    expect(valor(ops, '/fields/Microsoft.VSTS.Common.Priority')).toBe(2);
    expect(valor(ops, '/fields/Custom.Environment')).toBe('QA');
    expect(valor(ops, '/fields/System.Tags')).toBe('FLITO; FLITO-PRUEBAS');
    expect(ops.every((o) => o.op === 'add')).toBe(true);
    expect(ops.map((o) => o.path).join(' ')).not.toMatch(/Severity|SolutionArea|AffectedModule|AssignedTo|AreaPath/);
  });

  it.each([['alta', 1], ['media', 2], ['baja', 3]] as const)('prioridad %s → %i', (p, n) => {
    expect(valor(construirBugSoporte({ ...CASO, prioridad: p }, CTX, CFG), '/fields/Microsoft.VSTS.Common.Priority')).toBe(n);
  });

  it('ReproSteps: todo valor escapado, área con su etiqueta, saltos → <br> tras escapar, Ref DRF-<id>', () => {
    const r = String(valor(construirBugSoporte(CASO, CTX, CFG), '/fields/Microsoft.VSTS.TCM.ReproSteps'));
    expect(r).not.toContain('<img');
    expect(r).toContain('Pantalla &lt;img src=x onerror=alert(1)&gt;');
    expect(r).toContain('Ana &quot;La&quot; O&#39;Neil');
    expect(r).toContain('Línea 1<br>Línea &lt;2&gt;');
    expect(r).toContain('Que funcione &amp; ya');
    expect(r).toContain('Corredor Impuestos');
    expect(r).toContain('A veces');
    expect(r).toContain('Media');
    expect(r).toContain('QA (QA)');
    expect(r).toContain('<td><b>Teléfono</b></td><td>—</td>');
    expect(r).toContain('<td><b>Adjuntos</b></td><td>No</td>');
    expect(r).toContain(fechaBogota(CTX.fecha));
    expect(r).toContain('Ref. FLITO: DRF-42');
  });

  it('PDN: solo el tag base; campo de ambiente vacío no se envía; AreaPath solo si se configuró', () => {
    const ops = construirBugSoporte(CASO, { ...CTX, ambiente: 'PDN' }, { ...CFG, campoAmbiente: '', areaPath: 'FLIT - SOPORTE\\FLITO' });
    expect(valor(ops, '/fields/System.Tags')).toBe('FLITO');
    expect(ops.some((o) => o.path === '/fields/Custom.Environment')).toBe(false);
    expect(valor(ops, '/fields/System.AreaPath')).toBe('FLIT - SOPORTE\\FLITO');
  });

  it('nombres de campo configurables', () => {
    const ops = construirBugSoporte(CASO, CTX, { ...CFG, campoDetalle: 'Custom.Detalle', campoPrioridad: 'Custom.Prio' });
    expect(valor(ops, '/fields/Custom.Prio')).toBe(2);
    expect(typeof valor(ops, '/fields/Custom.Detalle')).toBe('string');
  });

  it('helpers', () => {
    expect(escaparHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    expect(textoHtml('a\r\nb\rc')).toBe('a<br>b<br>c');
    expect(tagsPara('DEV', CFG)).toBe('FLITO; FLITO-PRUEBAS');
    expect(tagsPara('DEV', { ...CFG, tagsPruebas: '' })).toBe('FLITO');
    expect(fechaBogota(new Date('2026-01-01T04:30:00Z'))).toMatch(/31\/12\/2025.*23:30/);
  });
});
