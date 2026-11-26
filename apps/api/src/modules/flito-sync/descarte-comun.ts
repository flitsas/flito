// Épica #14707 (ADR-0049 §3-§5) — piezas comunes del descarte de un trámite muerto (`descarte-*.ts`).
// Logs y auditoría: radicado e ids. NUNCA VIN, placa ni PII (§8 del ADR).
import type { db } from '../../db/client.js';
import { auditLogs, flitoTramites } from '../../db/schema.js';
import type { MotivoDescarte } from '@operaciones/shared-types';

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type FilaTramite = typeof flitoTramites.$inferSelect;

/** Contadores del descarte (entran en el log del sync y en el resumen de `audit_logs`). */
export interface ResultadoDescarte {
  impuestos: number; soats: number; soatsHeredados: number; soatsConservados: number; vivosRearrancados: number;
  comprobantesLiberados: number; comprobantesNoLiberados: number; avisos: number;
}

export const resultadoDescarteVacio = (): ResultadoDescarte => ({
  impuestos: 0, soats: 0, soatsHeredados: 0, soatsConservados: 0, vivosRearrancados: 0,
  comprobantesLiberados: 0, comprobantesNoLiberados: 0, avisos: 0,
});

/**
 * Rearranque de SOAT de un vivo desligado (D3a). Lo inyecta quien llama (`flito-sync.service.ts`) para no abrir el
 * ciclo descarte → sync. `true` = cumplía las condiciones de arranque y se resolvió su SOAT.
 */
export type RearrancarSoat = (tx: Tx, vivo: FilaTramite, vin: string) => Promise<boolean>;

export interface OpcionesDescarte {
  /** D6: avisar a `enviado_por_id` si lo descartado estaba `solicitado`. El saneo histórico (0319) no avisa. */
  avisar: boolean;
  rearrancar: RearrancarSoat;
}

export interface ContextoDescarte {
  tramite: FilaTramite;
  motivo: MotivoDescarte;
  o: OpcionesDescarte;
  r: ResultadoDescarte;
}

export const motivoHistorial = (radicado: string, motivo: MotivoDescarte, que: 'el SOAT' | 'el impuesto'): string =>
  `Trámite ${radicado} ${motivo} en FLIT: ${que} se descarta porque su trámite ya no existe en FLITO (Épica 14707).`;

export async function auditSistema(tx: Tx, e: { resource: string; resourceId: string; detail: string }): Promise<void> {
  await tx.insert(auditLogs).values({ userId: null, userEmail: 'sistema', action: 'update', resource: e.resource, resourceId: e.resourceId, detail: e.detail });
}
