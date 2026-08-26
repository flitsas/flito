// Siigo API — catálogo de ubicaciones (HU #11293). Montado en /api/siigo/ciudades.
//
// Permisos (AC6):
//   · LECTURA → los mismos roles que leen clientes (`admin`, `auditor`, `financiera`). Es un
//     catálogo público de la DIAN, sin nada sensible, y se necesita para llenar el formulario del
//     cliente: cerrarlo más solo conseguiría que la pantalla no pudiera pintar sus listas.
//   · CARGA/RECARGA → solo `admin`. Reescribe 4.605 filas y puede desactivar ciudades que otros
//     clientes referencian.
//
// **Ninguna ruta de aquí llama a Siigo.** El catálogo se carga desde un archivo del repo, así que
// no hay cuota que gastar ni cortacircuitos que consultar (AC5).

import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { makeStore, userOrIpKey } from '../../shared/middleware/rateLimiter.js';
import {
  SiigoCiudadesError, buscarCiudades, cargarCiudades, listarCiudades,
  listarDepartamentos, listarPaises, resumenCiudades,
} from './siigo.ciudades.service.js';

const router = Router();
router.use(authMiddleware);

const LECTURA = requireRole('admin', 'auditor', 'financiera');
const ESCRITURA = requireRole('admin');

/**
 * La recarga no gasta cuota de Siigo, pero sí escribe 4.605 filas y las lee todas antes.
 *
 * Repetirla en bucle no rompe nada —es idempotente— pero mantiene la base ocupada sin ningún
 * beneficio: el archivo solo cambia cuando alguien commitea una versión nueva del listado. Dos por
 * hora sobra para eso y para reintentar si la primera falló.
 */
const cargaLimiter = rateLimit({
  windowMs: 3_600_000,
  max: 2,
  keyGenerator: userOrIpKey('siigo-ciudades-carga'),
  message: { error: 'La carga del catálogo de ubicaciones está limitada a 2 por hora.' },
  store: makeStore('rl:siigo-ciudades-carga:'),
});

const paisSchema = z.object({ pais: z.string().min(1).max(2) });
const departamentoSchema = paisSchema.extend({ departamento: z.string().min(1).max(5) });
const busquedaSchema = z.object({
  q: z.string().min(2, 'Escribe al menos dos caracteres').max(80),
  pais: z.string().min(1).max(2).optional(),
});

// GET / — estado del catálogo: si está cargado, cuántas trae y de qué versión (AC1).
router.get('/', LECTURA, async (_req: Request, res: Response) => {
  res.json(await resumenCiudades());
});

// GET /paises
router.get('/paises', LECTURA, async (_req: Request, res: Response) => {
  res.json({ data: await listarPaises() });
});

// GET /buscar?q=...&pais=Co — va ANTES de /:pais para que Express no lo tome por un código.
router.get('/buscar', LECTURA, async (req: Request, res: Response) => {
  const parsed = busquedaSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Búsqueda inválida', details: parsed.error.flatten() });
    return;
  }
  res.json({ data: await buscarCiudades(parsed.data.q, parsed.data.pais) });
});

// GET /:pais/departamentos
router.get('/:pais/departamentos', LECTURA, async (req: Request, res: Response) => {
  const parsed = paisSchema.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: 'País inválido' }); return; }
  res.json({ data: await listarDepartamentos(parsed.data.pais) });
});

// GET /:pais/:departamento/ciudades
router.get('/:pais/:departamento/ciudades', LECTURA, async (req: Request, res: Response) => {
  const parsed = departamentoSchema.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: 'País o departamento inválido' }); return; }
  res.json({ data: await listarCiudades(parsed.data.pais, parsed.data.departamento) });
});

// POST /cargar — carga o recarga desde el archivo del repo (AC1, AC3, AC4).
//
// El orden importa: la guarda de rol va ANTES del limitador, para que un rechazo por permiso no
// consuma el cupo de quien sí lo tiene.
router.post('/cargar', ESCRITURA, cargaLimiter, async (req: Request, res: Response) => {
  try {
    const resultado = await cargarCiudades();
    await audit(req, {
      action: 'update',
      resource: 'siigo_ciudades',
      detail: `Catálogo de ubicaciones cargado · versión ${resultado.version} · `
        + `${resultado.insertadas} nuevas, ${resultado.actualizadas} actualizadas, `
        + `${resultado.inactivadas} inactivadas`,
    });
    res.json(resultado);
  } catch (e) {
    // El archivo es nuestro, no de Siigo: su mensaje no lleva nada de un tercero ni datos de
    // conexión, así que se puede mostrar tal cual y decir qué hay que arreglar.
    if (e instanceof SiigoCiudadesError) {
      res.status(422).json({ error: e.message, codigo: e.codigo });
      return;
    }
    throw e;
  }
});

export default router;
