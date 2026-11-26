// Épica #14707 (ADR-0049 §3, D5/D6) — el impuesto de un trámite muerto. Es 1:1 con el trámite (`tramite_id UNIQUE`),
// así que SIEMPRE pasa a `descartado`, en cualquier estado (también `pagado`: sale de los reportes y deja de bloquear
// el impuesto del vehículo, `impuestoBloqueantePorVehiculo`). Si estaba `solicitado`, se avisa a quien lo envió (D6).
// Idempotente: un impuesto ya `descartado` no se toca. La liberación de sus comprobantes (D11) la decide el orquestador.
import { eq } from 'drizzle-orm';
import { EstadoImpuesto } from '@operaciones/shared-types';
import { flitoImpuestos } from '../../db/schema.js';
import { registrarCambio } from '../../shared/historial/estado-historial.js';
import { registrarAvisoSolicitudRetirada } from '../flito-avisos/flito-avisos.escritura.js';
import { motivoHistorial, type ContextoDescarte, type Tx } from './descarte-comun.js';

/** Devuelve `true` si descartó el impuesto en esta llamada. */
export async function descartarImpuesto(tx: Tx, c: ContextoDescarte): Promise<boolean> {
  const [imp] = await tx.select({ id: flitoImpuestos.id, estado: flitoImpuestos.estado, enviadoPorId: flitoImpuestos.enviadoPorId })
    .from(flitoImpuestos).where(eq(flitoImpuestos.tramiteId, c.tramite.id)).for('update').limit(1);
  if (!imp || imp.estado === EstadoImpuesto.DESCARTADO) return false;
  const ahora = new Date();
  await tx.update(flitoImpuestos).set({
    estado: EstadoImpuesto.DESCARTADO, descartadoEn: ahora, motivoDescarte: c.motivo, updatedAt: ahora,
  }).where(eq(flitoImpuestos.id, imp.id));
  await registrarCambio(tx, {
    concepto: 'impuesto', registroId: imp.id, estadoAnterior: imp.estado, estadoNuevo: EstadoImpuesto.DESCARTADO,
    motivo: motivoHistorial(c.tramite.idFlit, c.motivo, 'el impuesto'), origen: 'sistema',
  });
  c.r.impuestos += 1;
  if (c.o.avisar && imp.estado === EstadoImpuesto.SOLICITADO && imp.enviadoPorId !== null) {
    const creado = await registrarAvisoSolicitudRetirada(tx, {
      usuarioId: imp.enviadoPorId, concepto: 'impuesto', registroId: imp.id, tramiteId: c.tramite.id, motivo: c.motivo,
    });
    if (creado) c.r.avisos += 1;
  }
  return true;
}
