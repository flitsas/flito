// FLITO — SOAT, canal Cliente (HTTP). Feature #11912, HU #11914.
// Montado en `/api/flito/soat`, junto al router del módulo. Contrato: ADR-0008 §6.
//
// ── Por qué un router aparte y montado en la MISMA base ──────────────────────────────────────────
//
// La base es la misma porque el recurso es el mismo (`flito_soat`) y porque el aislamiento por
// compañía tiene que seguir pasando por `contextoSoat()`. El archivo es otro por el techo de líneas
// de `flito-soat.routes.ts` y, sobre todo, porque estas dos rutas son las ÚNICAS de todo el módulo
// que sirven al rol `cliente` con escritura: tenerlas juntas hace que se puedan leer de una vez, con
// su rate limit, su validación de MIME real y su auditoría a la vista.
//
// No hay colisión de rutas con el router del módulo: sus patrones de segundo nivel son literales
// (`enviar`, `facturas`, `:id/rechazar`, `:id/factura`…) y ninguno casa con `/cliente` ni con
// `/cliente/preconsulta`. El montaje va ANTES en `app.ts` para que, si algún día se añadiera un
// patrón que sí casara, gane el específico.
//
// ── PII: nada identificable en la URL (AGENTS.md §14, AC5) ──────────────────────────────────────
//
// Placa, VIN y documento del propietario viajan SIEMPRE en el cuerpo. Por eso la preconsulta es un
// `POST` y no un `GET` con parámetros, aunque no escriba nada: un `GET /preconsulta?placa=…` deja la
// placa en el log de acceso de nginx, en el historial del navegador y en el `Referer`. La misma
// razón por la que la HU #11915 tiene que mover el `GET /?buscar=` de la cola a `POST /buscar`.

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import { soatClienteLimiter } from '../../shared/middleware/rateLimiter.js';
import { TIPOS_DOCUMENTO_RUNT } from '@operaciones/shared-types';
import { contextoSoat } from './flito-soat.service.js';
import { registrarAccesoRuntCliente } from './flito-soat.pii.js';
import {
  crearSolicitud, preconsulta, SolicitudSoatError, type ArchivoSolicitud,
} from './flito-soat-cliente.service.js';

const router = Router();
router.use(authMiddleware);

/**
 * Solo el `cliente`. Ni siquiera el `admin`: radicar es un acto de la compañía —la solicitud queda
 * atada a `users.compania_id` y firmada con el nombre de quien la radica—, y un admin no tiene
 * compañía, así que su alta acabaría en `SIN_COMPANIA`. Que lo diga `requireRole` y no un error a
 * mitad de camino hace explícito de quién es este canal.
 *
 * Es la SEGUNDA cerradura: la primera es `RUTAS_PERMITIDAS_CLIENTE` (`shared/middleware/
 * canal-cliente.ts`), que niega por defecto todo lo que no esté inscrito allí. Las dos hacen falta
 * y en sentidos opuestos: aquella impide que el `cliente` alcance el resto de la API, esta impide
 * que el resto de los roles alcance el canal.
 */
const CANAL_CLIENTE = requireRole('cliente');

/**
 * El adjunto: UN archivo, campo `facturaVenta`, 15 MB como el resto del módulo.
 *
 * El `fileFilter` mira el mime DECLARADO y no basta —se falsifica renombrando el archivo—: el filtro
 * de verdad es `verificarPdfReal()` en el servicio, que olfatea los bytes. Este de aquí solo evita
 * cargar en memoria 15 MB de algo que ya se sabe que no se va a aceptar.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) cb(null, true);
    else cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`));
  },
});

function manejarError(res: Response, e: unknown): void {
  if (e instanceof SolicitudSoatError) {
    // El `codigo` viaja JUNTO al mensaje, no en su lugar: el mensaje es para la persona y el código
    // para la pantalla (AC2, AC3, AC4). `error` sigue siendo una CADENA, como en todo el repo —el
    // cliente HTTP de la web lo lee así para el toast—, y lo que el caso necesite además va en
    // claves hermanas (`propia`, `id`, `estado` del 409 de RN-01), nunca anidado dentro de `error`.
    res.status(e.status).json({ error: e.message, codigo: e.codigo, ...(e.datos ?? {}) });
    return;
  }
  throw e;
}

/** Placa y VIN, normalizados en el servicio. Longitudes de columna: `vehicles.plate`/`vin`. */
const vehiculoSchema = z.object({
  placa: z.string().trim().min(4, 'La placa es obligatoria').max(10),
  vin: z.string().trim().min(5, 'El VIN es obligatorio').max(17),
});

/**
 * POST /cliente/preconsulta — paso 1: qué dice el RUNT de este vehículo.
 *
 * No escribe nada, pero **sí deja rastro de acceso a datos personales**: devuelve la placa, el VIN y,
 * cuando el RUNT lo trae, el nombre del propietario. Es una consulta a un registro nacional sobre un
 * vehículo que puede no ser de quien pregunta, y quien pregunta es una empresa tercera.
 */
router.post('/cliente/preconsulta', CANAL_CLIENTE, soatClienteLimiter, async (req: Request, res: Response) => {
  const parsed = vehiculoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  try {
    const ctx = await contextoSoat(req.user!);
    const resultado = await preconsulta(parsed.data.placa, parsed.data.vin, ctx);
    await registrarAccesoRuntCliente(req, { conPropietario: resultado.propietario !== null });
    res.json(resultado);
  } catch (e) { manejarError(res, e); }
});

/**
 * El cuerpo del alta. Llega como `multipart/form-data`, así que TODO campo es texto: no hay booleanos
 * ni números que Zod pueda coaccionar, y los campos opcionales llegan como cadena vacía cuando el
 * formulario los deja sin llenar — de ahí el `.transform` que los pasa a `null`.
 *
 * Marca, línea, modelo, clase, servicio, cilindraje y organismo NO están aquí, y esa ausencia es el
 * AC1: salen del RUNT y no se teclean. Aceptarlos «por comodidad del formulario» permitiría radicar
 * una solicitud con los datos que a uno le apetezca y con un organismo que decide a qué proveedor
 * acaba yendo el caso.
 */
const vacioANull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

const altaSchema = vehiculoSchema.extend({
  tipoDocumento: z.enum(TIPOS_DOCUMENTO_RUNT),
  numeroDocumento: z.string().trim().min(4, 'El documento del propietario es obligatorio').max(30),
  nombreCompleto: z.string().trim().min(3, 'El nombre del propietario es obligatorio').max(200),
  correo: z.preprocess(vacioANull, z.string().trim().email('El correo no es válido').max(150).nullable().optional()),
  celular: z.preprocess(vacioANull, z.string().trim().max(30).nullable().optional()),
  direccion: z.preprocess(vacioANull, z.string().trim().max(300).nullable().optional()),
});

/**
 * POST /cliente — crear ES enviar (AC1). Sin borrador.
 *
 * `upload.single` corre DESPUÉS del rate limit a propósito: el limitador tiene que frenar antes de
 * que el proceso cargue 15 MB en memoria, no después.
 */
router.post('/cliente', CANAL_CLIENTE, soatClienteLimiter, upload.single('facturaVenta'), async (req: Request, res: Response) => {
  const parsed = altaSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  if (!req.file) { res.status(400).json({ error: 'Falta la factura de venta (PDF)' }); return; }

  const { placa, vin, tipoDocumento, numeroDocumento, nombreCompleto, correo, celular, direccion } = parsed.data;
  const archivo: ArchivoSolicitud = {
    originalname: req.file.originalname, mimetype: req.file.mimetype,
    buffer: req.file.buffer, size: req.file.size,
  };

  try {
    const ctx = await contextoSoat(req.user!);
    const creada = await crearSolicitud(
      { placa, vin, propietario: { tipoDocumento, numeroDocumento, nombreCompleto, correo, celular, direccion } },
      archivo, ctx,
    );
    // El `detail` NO lleva placa, VIN ni documento, y no es una omisión: `audit_logs` es una tabla
    // append-only que se exporta y se lee entera, y el patrón contrario ya existe en el repo
    // (`runt.routes.ts` escribe la placa en su bitácora). El `resourceId` es el uuid del SOAT, que
    // es opaco y basta para reconstruir el caso desde la fila.
    await audit(req, {
      action: 'create', resource: 'flito_soat', resourceId: creada.id,
      detail: `Alta de solicitud SOAT del canal Cliente (origen=cliente, estado=${creada.estado})`,
    });
    res.status(201).json(creada);
  } catch (e) { manejarError(res, e); }
});

export default router;
