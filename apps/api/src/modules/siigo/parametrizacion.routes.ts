// Siigo API — parametrización contable (HU #11281). Montado en /api/siigo/parametrizacion.
//
// Permisos (AC7):
//   · ESCRITURA (disparar la sincronización) → solo `admin`. Cada ejecución consume seis peticiones
//     de la cuota de 100/min que comparte con las facturas, así que no es una acción inocua.
//   · LECTURA (consultar la copia local) → `admin` y `financiera`, que es quien parametriza y quien
//     tiene que poder revisar contra qué se está facturando.
//
// La guarda va como middleware ANTES del handler: así el rechazo ocurre sin que el servicio llegue
// a ejecutarse y, por tanto, sin que salga ninguna petición hacia Siigo.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { SIIGO_TIPOS_CATALOGO } from '@operaciones/shared-types';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import {
  leerCatalogo, resumenCatalogos, sincronizarCatalogos,
} from './siigo.catalogos.service.js';

const router = Router();
router.use(authMiddleware);

const LECTURA = requireRole('admin', 'financiera');
const ESCRITURA = requireRole('admin');

const tipoSchema = z.enum(SIIGO_TIPOS_CATALOGO);
const ambienteSchema = z.enum(['pruebas', 'produccion']);

const sincronizarSchema = z.object({
  ambiente: ambienteSchema.optional(),
  // Permite reintentar solo el catálogo que falló sin volver a traer los otros cinco: gastar seis
  // peticiones para arreglar una es justo lo que el control de tasa intenta evitar.
  tipos: z.array(tipoSchema).min(1).max(SIIGO_TIPOS_CATALOGO.length).optional(),
});

// El ambiente es opcional en las lecturas y por omisión es el configurado en el servidor. Se acepta
// explícito porque `pruebas` y `produccion` son empresas distintas de Siigo y la pantalla de
// parametrización tiene que poder mirar la copia de una sin cambiar la configuración del servidor.
const listarSchema = z.object({
  // Llega por query string, así que es texto. `'true'` explícito y nada más: un `?incluirInactivos=0`
  // interpretado como verdadero mostraría elementos que ya no se pueden usar.
  incluirInactivos: z.enum(['true', 'false']).optional(),
  ambiente: ambienteSchema.optional(),
});

const resumenSchema = z.object({ ambiente: ambienteSchema.optional() });

// GET /catalogos — resumen de los seis catálogos con su última sincronización.
router.get('/catalogos', LECTURA, async (req: Request, res: Response) => {
  const query = resumenSchema.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: 'Parámetros inválidos', details: query.error.flatten() });
    return;
  }

  const data = await resumenCatalogos({ ambiente: query.data.ambiente });
  res.json({ data });
});

// GET /catalogos/:tipo — elementos de un catálogo, desde la copia local. Nunca llama a Siigo (AC3).
router.get('/catalogos/:tipo', LECTURA, async (req: Request, res: Response) => {
  const tipo = tipoSchema.safeParse(req.params.tipo);
  if (!tipo.success) {
    res.status(400).json({
      error: 'Catálogo desconocido',
      catalogosValidos: SIIGO_TIPOS_CATALOGO,
    });
    return;
  }

  const query = listarSchema.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: 'Parámetros inválidos', details: query.error.flatten() });
    return;
  }

  const data = await leerCatalogo(tipo.data, {
    incluirInactivos: query.data.incluirInactivos === 'true',
    ambiente: query.data.ambiente,
  });
  res.json(data);
});

// POST /catalogos/sincronizar — trae los catálogos de Siigo y actualiza la copia local.
//
// Responde 200 aunque algún catálogo falle, igual que el diagnóstico de conexión (HU #11253). El
// veredicto viaja siempre en el mismo sitio —`ok`, `parcial` y `catalogos[].error`—, de modo que
// quien consume lo lee de un solo lugar en vez de tener que mirar el status para los fallos totales
// y el cuerpo para los parciales. Una sincronización parcial NO es un error del endpoint: es
// exactamente el resultado que AC5 pide reportar.
//
// `vaciadoMasivo` viaja por el mismo canal y es independiente de `ok`: un catálogo que estaba
// poblado y volvió vacío es una sincronización exitosa cuyo efecto es dejar la parametrización sin
// opciones. La pantalla tiene que poder distinguirlo de un verde normal.
router.post('/catalogos/sincronizar', ESCRITURA, async (req: Request, res: Response) => {
  const parsed = sincronizarSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
    return;
  }

  const resultado = await sincronizarCatalogos({
    ambiente: parsed.data.ambiente,
    tipos: parsed.data.tipos,
    usuarioId: req.user?.sub as number,
  });

  const fallidos = resultado.catalogos.filter((c) => !c.ok).map((c) => c.tipo);
  // Los vaciados van a la auditoría aunque `ok` sea true: es el único rastro de que una
  // sincronización «exitosa» dejó la parametrización sin opciones, y de quién la disparó.
  const vaciados = resultado.catalogos.filter((c) => c.vaciadoMasivo).map((c) => c.tipo);
  await audit(req, {
    action: 'update',
    resource: 'siigo_catalogos',
    resourceId: resultado.ambiente,
    detail: `sincronizacion ambiente=${resultado.ambiente} modo=${resultado.modo} `
      + `ok=${resultado.ok} catalogos=${resultado.catalogos.length} `
      + `fallidos=${fallidos.length ? fallidos.join(',') : 'ninguno'} `
      + `vaciados=${vaciados.length ? vaciados.join(',') : 'ninguno'}`,
  });

  res.json(resultado);
});

export default router;
