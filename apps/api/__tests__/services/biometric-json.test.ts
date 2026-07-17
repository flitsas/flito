import { describe, it, expect } from 'vitest';
import { extractAnthropicText, parseBiometricJson } from '../../src/modules/tramites/biometric-json.js';

describe('biometric-json', () => {
  it('extractAnthropicText concatena bloques text', () => {
    expect(extractAnthropicText({
      content: [
        { type: 'text', text: '{"a":1' },
        { type: 'text', text: '}' },
      ],
    })).toBe('{"a":1\n}');
  });

  it('parseBiometricJson acepta JSON puro', () => {
    const j = parseBiometricJson('{"resultado_general":{"aprobado":true}}');
    expect(j?.resultado_general).toEqual({ aprobado: true });
  });

  it('parseBiometricJson acepta markdown fence', () => {
    const j = parseBiometricJson('```json\n{"liveness":{"es_persona_real":true}}\n```');
    expect(j?.liveness).toEqual({ es_persona_real: true });
  });

  it('parseBiometricJson extrae objeto embebido en texto', () => {
    const j = parseBiometricJson('Análisis:\n{"comparacion_facial":{"score":72}}\nFin.');
    expect(j?.comparacion_facial).toEqual({ score: 72 });
  });

  it('parseBiometricJson retorna null si no hay JSON', () => {
    expect(parseBiometricJson('sin json aqui')).toBeNull();
  });
});
