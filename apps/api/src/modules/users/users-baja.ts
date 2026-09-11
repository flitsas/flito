// HU #12089 — Handlers de baja lógica y reactivación.
//
// Las rutas se montan en `users.routes.ts` (el lector de montajes de permisos lee ese fichero);
// la lógica HTTP vive aquí para no empujar el router por encima del techo de 800 líneas.

import type { Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { invalidateSessionCacheFor } from '../../shared/middleware/auth.js';
import { invalidarPermisosDe } from '../../shared/permisos-efectivos.js';
import { BloqueoAdministracionError } from '../../shared/permisos-anti-bloqueo.js';
import { audit } from '../../shared/middleware/audit.js';
import { actorDeRequest } from '../../shared/historial/permisos-auditoria.js';
import { darDeBaja, reactivarUsuario } from './users.service.js';

/** DELETE /api/users/:id — marca deleted_at (nunca hard-delete). */
export async function handleDarDeBaja(req: Request, res: Response): Promise<void> {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'ID inválido' });
    return;
  }
  if (id === req.user!.sub) {
    res.status(400).json({ error: 'No puede darse de baja a sí mismo' });
    return;
  }
  const [before] = await db.select({
    id: users.id, deletedAt: users.deletedAt, role: users.role, active: users.active,
  }).from(users).where(eq(users.id, id)).limit(1);
  if (!before) {
    res.status(404).json({ error: 'Usuario no encontrado' });
    return;
  }

  let updated;
  try {
    updated = await darDeBaja(id, actorDeRequest(req));
  } catch (e) {
    if (e instanceof BloqueoAdministracionError) {
      res.status(409).json({ error: e.message, funcion: e.funcion });
      return;
    }
    throw e;
  }
  if (!updated) {
    res.status(404).json({ error: 'Usuario no encontrado' });
    return;
  }

  invalidateSessionCacheFor(id);
  invalidarPermisosDe(id);
  await audit(req, {
    action: 'update', resource: 'user', resourceId: String(id),
    detail: before.deletedAt
      ? 'Baja lógica (idempotente)'
      : 'Baja lógica [sesiones invalidadas]',
  });
  res.json(updated);
}

/** POST /api/users/:id/reactivar — limpia deleted_*; conserva active/permisos/ámbito. */
export async function handleReactivar(req: Request, res: Response): Promise<void> {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'ID inválido' });
    return;
  }

  const updated = await reactivarUsuario(id, actorDeRequest(req));
  if (!updated) {
    res.status(404).json({ error: 'Usuario no encontrado' });
    return;
  }

  invalidarPermisosDe(id);
  await audit(req, {
    action: 'update', resource: 'user', resourceId: String(id),
    detail: 'Reactivación tras baja lógica',
  });
  res.json(updated);
}
