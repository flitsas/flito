// Bug #14630 (Feature #13267) — guardián estático de la 0306: reencolado único de los envíos a FLIT 2
// que quedaron en `error` por `409 not_allowed_in_state` en un estado que FLIT 2 ya admite.
//
// Mutaciones que deja la migración VÁLIDA y la promesa ROTA, y que aquí se cazan:
//   · Sin filtro `ultimo_resultado = 'not_allowed_in_state'`: reencola errores por otros motivos
//     (attachment_exists, invalid_mime…), que son definitivos de verdad.
//   · Sin excluir anulado/revocado: reenvía a trámites que FLIT 2 sigue rechazando.
//   · Sin exigir el impuesto `pagado` (valor real de `EstadoImpuesto.PAGADO`): reencola reversados.
//   · Sin `destino = 'flit2'`: se lleva filas de FLIT 1.
// Análisis estático puro: NO toca la base. Si se pone rojo con la 0306 ya aplicada, se corrige con
// una migración NUEVA.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EstadoImpuesto, EstadoEnvioFlit2 } from '@operaciones/shared-types';
import { ESTADOS_FLIT2_NO_ADMITEN_ADJUNTO } from '../../src/modules/flito-sync/flit2-adjuntos.js';

const crudo = readFileSync(fileURLToPath(new URL(
  '../../src/db/migrations/0306_flito_envios_flit2_reencolar_not_allowed.sql', import.meta.url)), 'utf8');
/** SQL sin comentarios de línea y con espacios normalizados. */
const sqlDe = crudo.split('\n').map((l) => l.replace(/--.*$/, '')).join(' ').replace(/\s+/g, ' ');
const update = sqlDe.slice(sqlDe.indexOf('UPDATE flito_impuesto_envios_flit2'), sqlDe.indexOf('RETURNING'));

describe('0306 reencolado not_allowed_in_state (Bug #14630)', () => {
  it('sin control de transacción propio (lo pone el runner)', () => {
    expect(sqlDe).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK)\b/i);
  });

  it('solo filas error de FLIT 2 por not_allowed_in_state', () => {
    expect(update).toMatch(/e\.estado = 'error'/);
    expect(update).toMatch(/e\.destino = 'flit2'/);
    expect(update).toMatch(/e\.ultimo_resultado = 'not_allowed_in_state'/);
  });

  it('excluye anulado/revocado (los mismos del código) y exige estado_flit2 no nulo', () => {
    expect(update).toMatch(/e\.estado_flit2 IS NOT NULL/);
    const m = update.match(/lower\(e\.estado_flit2\) NOT IN \(([^)]*)\)/);
    expect(m).not.toBeNull();
    const lista = m![1].split(',').map((x) => x.trim().replace(/'/g, ''));
    expect(lista).toEqual([...ESTADOS_FLIT2_NO_ADMITEN_ADJUNTO]);
  });

  it('exige el impuesto en pagado (valor real de EstadoImpuesto.PAGADO)', () => {
    expect(update).toMatch(/i\.id = e\.impuesto_id/);
    expect(update).toContain(`i.estado = '${EstadoImpuesto.PAGADO}'`);
  });

  it('pasa a pendiente con intentos 0, cita ya y sin arrendamiento', () => {
    expect(update).toContain(`estado = '${EstadoEnvioFlit2.PENDIENTE}'`);
    expect(update).toMatch(/intentos = 0/);
    expect(update).toMatch(/proximo_intento_en = now\(\)/);
    expect(update).toMatch(/tomado_por = NULL/);
    expect(update).toMatch(/tomado_en = NULL/);
    expect(update).toMatch(/updated_at = now\(\)/);
  });

  it('una fila de auditoría por reencolada, sin PII (ids y estados)', () => {
    expect(sqlDe).toMatch(/INSERT INTO audit_logs \(user_id, user_email, action, resource, resource_id, detail\)/);
    expect(sqlDe).toMatch(/FROM reencoladas r/);
    expect(sqlDe).toContain('Envío a FLIT 2 reencolado (Bug #14630): estaba error por not_allowed_in_state (estado FLIT 2 ');
  });
});
