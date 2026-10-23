// HU #13803 (Feature #13695) — Variables de Dr. Flit en `env.ts` (superRefine P9-1) y disponibilidad
// (`dr-flit.config.ts`). `env.ts` hace `parse` al importar: cada caso recarga el módulo con el entorno
// del caso (`vi.resetModules` + `vi.stubEnv`).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ambienteDespliegue, etiquetaAmbiente, limitesAdjuntos, soporteDisponible, type ConfigDrFlit } from '../../../src/modules/flito-dr-flit/dr-flit.config.js';

async function cargarEnv(vars: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v as string);
  return import('../../../src/config/env.js');
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('env.ts — DEPLOY_ENVIRONMENT y DRFLIT_ADO_*', () => {
  it('defaults: modo real, proyecto FLIT - SOPORTE, sin ambiente; en blanco = ausente', async () => {
    const { env } = await cargarEnv({ DEPLOY_ENVIRONMENT: '', DRFLIT_ADO_MODO: '', DRFLIT_ADO_PAT: '', DRFLIT_ADO_ORG_URL: '' });
    expect(env.DRFLIT_ADO_MODO).toBe('real');
    expect(env.DRFLIT_ADO_PROJECT).toBe('FLIT - SOPORTE');
    expect(env.DEPLOY_ENVIRONMENT).toBeUndefined();
    expect(env.DRFLIT_ADO_PAT).toBeUndefined();
  });

  it('simulado con DEPLOY_ENVIRONMENT=PDN → la API no arranca (error nombra la variable)', async () => {
    await expect(cargarEnv({ DRFLIT_ADO_MODO: 'simulado', DEPLOY_ENVIRONMENT: 'PDN' })).rejects.toThrow(/DRFLIT_ADO_MODO/);
  });

  it('simulado en NODE_ENV=production sin DEPLOY_ENVIRONMENT → no arranca (fallo cerrado)', async () => {
    await expect(cargarEnv({ NODE_ENV: 'production', DRFLIT_ADO_MODO: 'simulado', DEPLOY_ENVIRONMENT: '' }))
      .rejects.toThrow(/DRFLIT_ADO_MODO/);
  });

  it('simulado en QA → arranca', async () => {
    const { env } = await cargarEnv({ DRFLIT_ADO_MODO: 'simulado', DEPLOY_ENVIRONMENT: 'QA' });
    expect(env.DRFLIT_ADO_MODO).toBe('simulado');
  });

  it('DEPLOY_ENVIRONMENT fuera del enum → no arranca', async () => {
    await expect(cargarEnv({ DEPLOY_ENVIRONMENT: 'PROD' })).rejects.toThrow(/DEPLOY_ENVIRONMENT/);
  });

  it.each([
    ['http://dev.azure.com/org', false],
    ['https://evil.example.com/org', false],
    ['https://dev.azure.com.evil.com/org', false],
    ['https://user:pw@dev.azure.com/org', false],
    ['https://dev.azure.com/flitsas', true],
    ['https://flitsas.visualstudio.com', true],
  ])('DRFLIT_ADO_ORG_URL %s → válida=%s', async (url, valida) => {
    const p = cargarEnv({ DRFLIT_ADO_ORG_URL: url });
    if (valida) await expect(p).resolves.toBeDefined();
    else await expect(p).rejects.toThrow(/DRFLIT_ADO_ORG_URL/);
  });
});

describe('dr-flit.config — disponibilidad', () => {
  const base: ConfigDrFlit = { NODE_ENV: 'production', DRFLIT_ADO_MODO: 'real' };
  const conPat = { DRFLIT_ADO_PAT: 'x', DRFLIT_ADO_ORG_URL: 'https://dev.azure.com/o' };

  it('ambiente: DEPLOY_ENVIRONMENT manda; development cae a DEV; producción sin él → null', () => {
    expect(ambienteDespliegue({ ...base, DEPLOY_ENVIRONMENT: 'QA' })).toBe('QA');
    expect(ambienteDespliegue({ ...base, NODE_ENV: 'development' })).toBe('DEV');
    expect(ambienteDespliegue(base)).toBeNull();
  });

  it('etiquetas', () => {
    expect(etiquetaAmbiente('PDN')).toBe('Producción');
    expect(etiquetaAmbiente('QA')).toBe('QA');
    expect(etiquetaAmbiente('DEV')).toBe('Otro (DEV)');
    expect(etiquetaAmbiente(null)).toBeNull();
  });

  it('real: disponible solo con PAT y organización y ambiente declarado', () => {
    expect(soporteDisponible({ ...base, DEPLOY_ENVIRONMENT: 'PDN', ...conPat })).toBe(true);
    expect(soporteDisponible({ ...base, DEPLOY_ENVIRONMENT: 'PDN', DRFLIT_ADO_ORG_URL: conPat.DRFLIT_ADO_ORG_URL })).toBe(false);
    expect(soporteDisponible({ ...base, ...conPat })).toBe(false); // producción sin ambiente
  });

  it('simulado: disponible en DEV/QA, nunca en PDN', () => {
    expect(soporteDisponible({ ...base, DRFLIT_ADO_MODO: 'simulado', DEPLOY_ENVIRONMENT: 'QA' })).toBe(true);
    expect(soporteDisponible({ ...base, DRFLIT_ADO_MODO: 'simulado', NODE_ENV: 'development' })).toBe(true);
    expect(soporteDisponible({ ...base, DRFLIT_ADO_MODO: 'simulado', DEPLOY_ENVIRONMENT: 'PDN' })).toBe(false);
  });
});

describe('HU #13805 — límites de adjuntos configurables (AC3)', () => {
  it('defaults 3 archivos de 5 MB; en blanco = default; los valores llegan a los límites', async () => {
    const { env } = await cargarEnv({ DRFLIT_ADJUNTOS_MAX: '', DRFLIT_ADJUNTO_MAX_MB: '' });
    expect([env.DRFLIT_ADJUNTOS_MAX, env.DRFLIT_ADJUNTO_MAX_MB]).toEqual([3, 5]);
    const otro = await cargarEnv({ DRFLIT_ADJUNTOS_MAX: '1', DRFLIT_ADJUNTO_MAX_MB: '2' });
    expect(limitesAdjuntos(otro.env)).toEqual({
      maxArchivos: 1, maxBytesArchivo: 2 * 1024 * 1024, tipos: ['image/png', 'image/jpeg', 'application/pdf'],
    });
  });

  it.each([['DRFLIT_ADJUNTOS_MAX', '11'], ['DRFLIT_ADJUNTOS_MAX', '-1'], ['DRFLIT_ADJUNTO_MAX_MB', '0'], ['DRFLIT_ADJUNTO_MAX_MB', '26']])(
    '%s=%s fuera de rango → no arranca', async (k, v) => {
      await expect(cargarEnv({ [k]: v })).rejects.toThrow(new RegExp(k));
    });
});

describe('HU #13854 — DRFLIT_IA_HABILITADA y DRFLIT_IA_TOPE_DIARIO (AC7, AC9)', () => {
  it('defaults: IA apagada y tope 30; en blanco = default', async () => {
    const { env } = await cargarEnv({ DRFLIT_IA_HABILITADA: undefined, DRFLIT_IA_TOPE_DIARIO: '' });
    expect(env.DRFLIT_IA_HABILITADA).toBe(false);
    expect(env.DRFLIT_IA_TOPE_DIARIO).toBe(30);
  });

  it('solo =1 enciende; true/yes no (puerta positiva)', async () => {
    expect((await cargarEnv({ DRFLIT_IA_HABILITADA: '1' })).env.DRFLIT_IA_HABILITADA).toBe(true);
    expect((await cargarEnv({ DRFLIT_IA_HABILITADA: 'true' })).env.DRFLIT_IA_HABILITADA).toBe(false);
  });

  it.each(['0', '1', '500'])('DRFLIT_IA_TOPE_DIARIO=%s → arranca', async (v) => {
    expect((await cargarEnv({ DRFLIT_IA_TOPE_DIARIO: v })).env.DRFLIT_IA_TOPE_DIARIO).toBe(Number(v));
  });

  it.each(['-1', '501', '2.5', 'treinta'])('DRFLIT_IA_TOPE_DIARIO=%s → no arranca, con mensaje claro', async (v) => {
    await expect(cargarEnv({ DRFLIT_IA_TOPE_DIARIO: v })).rejects.toThrow(/DRFLIT_IA_TOPE_DIARIO debe ser un entero entre 0 y 500/);
  });
});
