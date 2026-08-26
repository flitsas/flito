// Siigo API — informe de clientes no facturables (HU #11296). Montado en /api/siigo/clientes.
//
// Permisos (AC7): los mismos que leen clientes. Es un informe de lectura y **no permite modificar
// nada**: quien corrige un cliente lo hace por la ruta de clientes, con su propia guarda y su
// auditoría. Un informe que además edita se convierte en una segunda puerta a los mismos datos con
// permisos distintos, que es cómo se cuelan las inconsistencias de autorización.
//
// Ninguna ruta de aquí llama a Siigo (AC6): todo sale de la copia local.
//
// ── Registro de acceso a datos personales (HU #11299) ────────────────────────────────────────────
//
// Las tres rutas de LECTURA dejan rastro en `pii_access_log` vía `registrarAccesoCliente`, porque el
// informe devuelve nombre e identificación —cédula de personas naturales, NIT de jurídicas— y hasta
// esta HU el módulo `siigo/` entero no registraba una sola lectura (Ley 1581 art. 17, AGENTS.md
// §16). El permiso responde «¿podías mirar?»; esto responde «¿quién miró?», y son preguntas
// distintas: la segunda es la que hay que poder contestar cuando la haga un titular.
//
// Cada ruta declara los campos que ELLA entrega, que no son los mismos: el resumen solo devuelve
// conteos. El porqué de cada lista está en `siigo.pii.ts`, no repetido aquí.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { MOTIVOS_NO_FACTURABLE_CODIGOS } from '@operaciones/shared-types';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import {
  CAMPOS_PII_RESUMEN, CAMPOS_PII_VEREDICTO, registrarAccesoCliente,
} from './siigo.pii.js';
import {
  informeClientes, recalcularDuplicados, resumenValidacionClientes, veredictoCliente,
} from './siigo.validador-cliente.service.js';

const router = Router();
router.use(authMiddleware);

const LECTURA = requireRole('admin', 'auditor', 'financiera');
const ESCRITURA = requireRole('admin');

const informeSchema = z.object({
  motivo: z.enum(MOTIVOS_NO_FACTURABLE_CODIGOS as [string, ...string[]]).optional(),
  // Llega por query string. `'true'` explícito y nada más: un `?incluirFacturables=0` interpretado
  // como verdadero devolvería una lista que no es la que se pidió.
  incluirFacturables: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// GET /validacion — conteos por motivo: por dónde empezar a corregir.
//
// Registra el barrido con la lista de campos VACÍA (`CAMPOS_PII_RESUMEN`): recorre el padrón entero
// pero no devuelve ni un nombre ni una identificación. `evaluados` deja constancia del tamaño del
// recorrido, que es lo único personal-adyacente que hay aquí.
router.get('/validacion', LECTURA, async (req: Request, res: Response) => {
  const resumen = await resumenValidacionClientes();
  await registrarAccesoCliente(req, {
    accion: 'search',
    campos: CAMPOS_PII_RESUMEN,
    evaluados: resumen.total,
  });
  res.json(resumen);
});

// GET /validacion/detalle — la lista, filtrable por motivo (AC5).
router.get('/validacion/detalle', LECTURA, async (req: Request, res: Response) => {
  const parsed = informeSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Filtros inválidos', details: parsed.error.flatten() });
    return;
  }
  const { motivo, incluirFacturables, limit, offset } = parsed.data;
  const informe = await informeClientes({
    motivo: motivo as never,
    incluirFacturables: incluirFacturables === 'true',
    limit,
    offset,
  });

  // La lectura masiva del padrón: hasta 500 fichas con nombre e identificación en una respuesta, y
  // desde el panel de Terceros es la llamada habitual, no la excepcional. `filas` distingue quien
  // consultó una página de quien se llevó el tope. Los filtros van al motivo por
  // `registrarAccesoCliente`, que los enmascara; ninguno es personal hoy.
  await registrarAccesoCliente(req, {
    accion: 'search',
    campos: CAMPOS_PII_VEREDICTO,
    filas: informe.data.length,
    filtros: { motivo, incluirFacturables, offset },
  });

  res.json(informe);
});

// GET /:id/validacion — el veredicto de un cliente puntual (AC5).
//
// Va DESPUÉS de las rutas fijas para que Express no capture `validacion` como un identificador.
router.get('/:id/validacion', LECTURA, async (req: Request, res: Response) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }

  const veredicto = await veredictoCliente(id);
  if (veredicto === null) { res.status(404).json({ error: 'Cliente no encontrado' }); return; }

  // DESPUÉS del 404 a propósito: si el cliente no existe nadie miró los datos de nadie, y registrar
  // el intento llenaría el log de accesos que no ocurrieron. Aquí sí va `resource_id`: es la única
  // de las tres rutas que apunta a una ficha concreta, y la columna es `integer` como `clients.id`.
  await registrarAccesoCliente(req, {
    accion: 'read',
    campos: CAMPOS_PII_VEREDICTO,
    clienteId: veredicto.clienteId,
  });

  res.json(veredicto);
});

// POST /validacion/recalcular-duplicados — revisa los conflictos de identidad sobre los datos de hoy.
//
// La migración 0132 marcó los duplicados que existían entonces, pero nada volvía a mirarlos: uno
// creado después quedaría sin marca y por tanto pareciendo limpio, y uno ya resuelto arrastraría la
// marca para siempre. Es idempotente y no toca ningún otro campo.
router.post('/validacion/recalcular-duplicados', ESCRITURA, async (req: Request, res: Response) => {
  const resultado = await recalcularDuplicados();
  await audit(req, {
    action: 'update',
    resource: 'siigo_validacion_clientes',
    detail: `Conflictos de identidad recalculados: ${resultado.marcados} marcados, `
      + `${resultado.desmarcados} desmarcados`,
  });
  res.json(resultado);
});

export default router;
