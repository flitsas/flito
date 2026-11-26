// Épica #14707 (ADR-0049 §3-§5) — orquestador del descarte cuando un trámite pasa de VIVO a MUERTO. Lo llama
// `escribirTramite` (común a FLIT 1 y FLIT 2) en la MISMA transacción, después del UPDATE: el muerto y su descarte
// se confirman juntos o no se confirma ninguno (no hay ventana en la que su SOAT siga en una cola).
//
// Orden, un bloqueo por paso:
//   1. vigencia (anulado | abortado | revocado) desde `flit_estado`.
//   2. Impuesto (`descarte-impuesto.ts`): siempre `descartado` (D5) + aviso si estaba `solicitado` (D6).
//   3. SOAT (`descarte-soat.ts`): tabla D3 / D9 y rearranque de los vivos desligados (D3a).
//   4. D11 (`flito-comprobantes.liberar-descarte.ts`): se liberan los comprobantes aplicados AL DESCARTADO — del
//      muerto solo si es anulado/abortado (un revocado conserva lo cobrado); de los vivos desligados por D3a, siempre.
//   5. Resumen en `audit_logs` y en el log (radicado y conteos; nunca VIN ni placa).
// Idempotente: cada paso actúa solo sobre lo que no está `descartado`; los avisos usan ON CONFLICT DO NOTHING.
//
// La liberación se importa a demanda (`import()`): `flito-comprobantes` llega, por `flito-impuestos`, a
// `flito-sync.service.ts`, que importa este archivo; el import estático cerraría el ciclo en la carga del módulo.
import { ConceptoCosto, vigenciaLiberaPagos, vigenciaTramite } from '@operaciones/shared-types';
import { loggerFor } from '../../shared/logger.js';
import {
  auditSistema, resultadoDescarteVacio, type FilaTramite, type OpcionesDescarte, type ResultadoDescarte, type Tx,
} from './descarte-comun.js';
import { descartarImpuesto } from './descarte-impuesto.js';
import { descartarSoat } from './descarte-soat.js';

export type { ResultadoDescarte, OpcionesDescarte } from './descarte-comun.js';

const log = loggerFor('flito-sync-descarte');

export async function descartarDeTramiteMuerto(tx: Tx, tramite: FilaTramite, o: OpcionesDescarte): Promise<ResultadoDescarte> {
  const r = resultadoDescarteVacio();
  const vigencia = vigenciaTramite(tramite.estado, tramite.flitEstado);
  if (vigencia === 'vigente') return r;
  const c = { tramite, motivo: vigencia, o, r };

  const impuestoDescartado = await descartarImpuesto(tx, c);
  const soat = await descartarSoat(tx, c);

  const { liberarComprobantesDeDescarte } = await import('../flito-comprobantes/flito-comprobantes.liberar-descarte.js');
  const propios = vigenciaLiberaPagos(vigencia);
  const conceptos = [
    ...(impuestoDescartado ? [ConceptoCosto.IMPUESTO] : []),
    ...(soat.soatDescartadoId ? [ConceptoCosto.SOAT] : []),
  ];
  if (propios && conceptos.length > 0) {
    const l = await liberarComprobantesDeDescarte(tx, {
      tramiteIds: [tramite.id], conceptos, radicado: tramite.idFlit, soatDescartadoId: soat.soatDescartadoId,
    });
    r.comprobantesLiberados += l.liberados; r.comprobantesNoLiberados += l.noLiberados;
  }
  if (soat.vivosDesligados.length > 0) {
    const l = await liberarComprobantesDeDescarte(tx, {
      tramiteIds: soat.vivosDesligados, conceptos: [ConceptoCosto.SOAT], radicado: tramite.idFlit,
      soatDescartadoId: propios ? null : soat.soatDescartadoId,
    });
    r.comprobantesLiberados += l.liberados; r.comprobantesNoLiberados += l.noLiberados;
  }

  await auditSistema(tx, {
    resource: 'flito_tramite', resourceId: tramite.id,
    detail: `Trámite ${tramite.idFlit} ${vigencia} en FLIT: ya no existe en FLITO (Épica 14707). Impuestos descartados ${r.impuestos},`
      + ` SOAT descartados ${r.soats}, heredados ${r.soatsHeredados}, conservados ${r.soatsConservados}, vivos rearrancados ${r.vivosRearrancados},`
      + ` comprobantes liberados ${r.comprobantesLiberados}, no liberados ${r.comprobantesNoLiberados}, avisos ${r.avisos}.`,
  });
  log.info({ tramiteId: tramite.id, radicado: tramite.idFlit, vigencia, ...r }, 'trámite muerto: descarte aplicado');
  return r;
}
