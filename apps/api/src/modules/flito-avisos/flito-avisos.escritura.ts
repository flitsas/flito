// FLITO avisos — escritura (Épica #14707, ADR-0049 §7, D6). Módulo nuevo `flito-avisos` (`/api/flito/avisos`; la
// lectura, el «visto» y la purga llegan en el Bloque 2).
//
// Hoy un solo tipo: `solicitud_retirada`. Se descartó un SOAT o un impuesto que estaba `solicitado` porque su trámite
// murió en FLIT, y se avisa SOLO a quien lo envió (`enviado_por_id`; decisión cerrada 7: ni al gestor ni al
// proveedor). El aviso guarda solo referencias (Ley 1581): la placa y el radicado se resuelven con JOIN al leer.
// Idempotente: `ON CONFLICT DO NOTHING` sobre `(usuario_id, tipo, concepto, registro_id)`.
import { flitoAvisosUsuario } from '../../db/schema.js';
import type { db } from '../../db/client.js';
import type { MotivoDescarte } from '@operaciones/shared-types';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface AvisoSolicitudRetirada {
  usuarioId: number;
  concepto: 'soat' | 'impuesto';
  registroId: string;
  tramiteId: string | null;
  motivo: MotivoDescarte;
}

/** Registra el aviso en la tx del descarte. Devuelve `true` si lo creó (`false` = ya existía). */
export async function registrarAvisoSolicitudRetirada(tx: Tx, a: AvisoSolicitudRetirada): Promise<boolean> {
  const filas = await tx.insert(flitoAvisosUsuario).values({
    usuarioId: a.usuarioId, tipo: 'solicitud_retirada', concepto: a.concepto,
    registroId: a.registroId, tramiteId: a.tramiteId, motivo: a.motivo,
  }).onConflictDoNothing().returning({ id: flitoAvisosUsuario.id });
  return filas.length > 0;
}
