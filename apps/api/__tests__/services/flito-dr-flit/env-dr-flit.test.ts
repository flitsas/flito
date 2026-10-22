// HU #13803 (Feature #13695) — Variables de Dr. Flit en `env.ts` (superRefine P9-1) y disponibilidad
// (`dr-flit.config.ts`). `env.ts` hace `parse` al importar: cada caso recarga el módulo con el entorno
// del caso (`vi.resetModules` + `vi.stubEnv`).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ambienteDespliegue, etiquetaAmbiente, soporteDisponible, type ConfigDrFlit } from '../../../src/modules/flito-dr-flit/dr-flit.config.js';

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
