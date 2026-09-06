// FLITO — parametrización (HTTP). Portado de packages/server/src/parametrizacion.
//
// Toda la parametrización es de `operaciones`, con lectura para `auditor`. Los gestores
// NO entran: un gestor que pudiera cambiar el umbral de OCR de su proveedor podría hacer
// que sus propias facturas pasaran sin revisión (RN-04).

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  clients,
  flitoImpuestos,
  flitoOrganismoVigencias,
  flitoProveedoresSoat,
  flitoReglasProveedorSoat,
  organismosTransitoConfig,
} from '../../db/schema.js';
import { authMiddleware, requireRole } from '../../shared/middleware/auth.js';
import { audit } from '../../shared/middleware/audit.js';
import {
  AmbitoReglaProveedor,
  CONCEPTOS_TARIFA,
  EstadoImpuesto,
  ModalidadOrganismo,
  ORGANISMOS_TRANSITO,
  PRIORIDAD_POR_AMBITO,
} from '@operaciones/shared-types';
import { modalidadVigente } from './flito-parametrizacion.service.js';
import {
  actualizarTarifa, crearTarifa, eliminarTarifa, listarTarifas, TarifaError,
} from './flito-tarifas.service.js';

const router = Router();
router.use(authMiddleware);

// Lectura: operaciones + auditoría (solo lectura). Escritura: solo operaciones.
const LECTURA = requireRole('admin', 'auditor');
const ESCRITURA = requireRole('admin');
// Las TARIFAS son la parte comercial del cliente: las negocia Finanzas, así que también las escribe.
// El resto de la parametrización (umbrales de OCR, SLA, modalidad, autogestión) sigue siendo solo de
// Operaciones — RN-04: un gestor que pudiera mover su propio umbral colaría sus facturas sin revisar.
const ESCRITURA_TARIFAS = requireRole('admin', 'financiera');
const LECTURA_TARIFAS = requireRole('admin', 'auditor', 'financiera');

// ───────────────────────────────── Compañías (sobre `clients`) ──────────────

/**
 * Las columnas de `clients` que el DTO publica, para poder PROYECTAR las lecturas y escrituras.
 *
 * `clients` es la tabla con más PII del esquema (nombre de contacto, correo, teléfono, dirección,
 * notas: ver `CLIENTS_COLUMNAS_PII`). Un `returning()` desnudo trae las 25 columnas y solo el DTO
 * impide que salgan; con esta constante, un `res.json(updated)` por descuido publicaría exactamente
 * lo mismo que `res.json(companiaDto(updated))`. Es el patrón que las otras cuatro escrituras del
 * cambio ya siguen.
 */
const COLUMNAS_COMPANIA_DTO = {
  id: clients.id,
  name: clients.name,
  document: clients.document,
  soatAutogestionable: clients.soatAutogestionable,
  soatSinTramite: clients.soatSinTramite,
  flitoProveedorSoatSinTramiteId: clients.flitoProveedorSoatSinTramiteId,
  impuestosAutogestionable: clients.impuestosAutogestionable,
  logisticaAutogestionable: clients.logisticaAutogestionable,
  logisticaPermiteParcial: clients.logisticaPermiteParcial,
  flitoCarpetaStorage: clients.flitoCarpetaStorage,
  flitoToleranciaValorImpuesto: clients.flitoToleranciaValorImpuesto,
} as const;

/**
 * Lo mínimo que `companiaDto` necesita. Se deriva de la constante de arriba y no se escribe a mano:
 * añadir una clave al DTO obliga a añadirla a la proyección, o no compila.
 */
type FilaCompania = Pick<typeof clients.$inferSelect, keyof typeof COLUMNAS_COMPANIA_DTO>;

function companiaDto(c: FilaCompania) {
  return {
    id: c.id,
    nombre: c.name,
    nit: c.document,
    soatAutogestionable: c.soatAutogestionable,
    // Feature #11912 — «SOAT sin trámite»: el canal por el que un usuario `cliente` de esta compañía
    // le pide a FLITO un SOAT sin que haya trámite digital abierto. Campo APARTE y no derivado de
    // `soatAutogestionable`: son dos preguntas distintas y las dos encendidas a la vez es una
    // combinación válida (AC3).
    soatSinTramite: c.soatSinTramite,
    // Feature #12074, HU #12078 — el gestor por defecto AL QUE VAN las solicitudes de ese canal.
    // Va en el DTO para que la pantalla pueda pintarlo (el selector es la HU #12079) y para que
    // quien encienda el flag sepa contra qué lo está encendiendo. Es el uuid de una aseguradora, no
    // un dato personal. **Solo del canal sin trámite**: el SOAT por trámite elige gestor en cada
    // `POST /flito/soat/enviar` y no lee esta columna (AC2e).
    proveedorSoatSinTramiteId: c.flitoProveedorSoatSinTramiteId,
    impuestosAutogestionable: c.impuestosAutogestionable,
    logisticaAutogestionable: c.logisticaAutogestionable,
    logisticaPermiteParcial: c.logisticaPermiteParcial,
    carpetaStorage: c.flitoCarpetaStorage,
    toleranciaValorImpuesto: Number(c.flitoToleranciaValorImpuesto),
  };
}

router.get('/companias', LECTURA, async (_req: Request, res: Response) => {
  const filas = await db.select().from(clients).orderBy(asc(clients.name));
  res.json(filas.map(companiaDto));
});

const actualizarCompaniaSchema = z.object({
  soatAutogestionable: z.boolean().optional(),
  soatSinTramite: z.boolean().optional(),
  impuestosAutogestionable: z.boolean().optional(),
  logisticaAutogestionable: z.boolean().optional(),
  logisticaPermiteParcial: z.boolean().optional(),
  carpetaStorage: z.string().max(300).nullable().optional(),
  toleranciaValorImpuesto: z.number().min(0, 'La tolerancia no puede ser negativa').optional(),
  // HU #12078. Sin el prefijo `flito` en el cuerpo, como `carpetaStorage` ↔ `flitoCarpetaStorage`.
  // `null` explícito SÍ se acepta: es cómo se desconfigura el destino, y solo pasa la guarda del
  // estado resultante si el canal queda apagado.
  proveedorSoatSinTramiteId: z.string().uuid().nullable().optional(),
});

/**
 * Lo que hay que configurar antes de abrir el canal, dicho entero (AC2c).
 *
 * El mensaje importa más de lo normal y conviene dejar escrito por qué: entre el merge de la HU
 * #12078 y el de la #12079 —que trae el selector— la casilla «SOAT sin trámite» de `Clients.tsx`
 * llama a este PATCH con un solo campo, así que encenderla responde 400 y este texto es LO ÚNICO
 * que el usuario va a ver. Tiene que decir qué falta y dónde se arregla, no «datos inválidos».
 */
const FALTA_GESTOR =
  'Para abrir el canal «SOAT sin trámite» hay que decir a qué gestor van sus solicitudes: '
  + 'configure el gestor por defecto de la compañía (proveedorSoatSinTramiteId) en la misma '
  + 'operación o antes de encender el canal.';

/** Violación de CHECK en PostgreSQL. */
const CHECK_VIOLATION = '23514';

/**
 * El CHECK de la migración 0175, POR NOMBRE.
 *
 * `clients` tiene otros seis CHECK y el `catch` de abajo atribuía a este cualquier `23514` del
 * UPDATE. Hoy la atribución sería correcta —ninguno de los otros cubre lo que este PATCH escribe—,
 * pero el día que la tabla gane una restricción sobre un campo fiscal, quien la violara recibiría
 * «configure el gestor por defecto» y se iría a buscar un problema de configuración del canal SOAT
 * donde hay uno de otra cosa. Mismo criterio que el `catch` estrecho por `code`, un nivel más abajo.
 *
 * `constraint_name` es el nombre del campo tal como lo expone `postgres` (porsager): el driver copia
 * los campos del error de PostgreSQL con sus nombres largos, y drizzle-orm 0.45 no envuelve el error
 * —lo deja subir tal cual—, que es lo mismo que ya hace posible leer `code`.
 */
const CHK_SIN_TRAMITE_GESTOR = 'clients_sin_tramite_gestor_chk';

// `next` solo para el `catch` del CHECK: lo que NO sea `23514` tiene que seguir su camino hasta
// `errorHandler` (que ya lo registra y responde 500), no convertirse en un 400 que mande a buscar un
// problema de configuración donde hay uno de red.
router.patch('/companias/:id', ESCRITURA, async (req: Request, res: Response, next: NextFunction) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = actualizarCompaniaSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }

  const cambios = parsed.data;

  // ── Se lee la fila previa ANTES de construir el `set` (HU #12078) ──────────────────────────────
  //
  // Hasta ahora no se leía y el 404 salía del `returning()`. Sin el estado previo no se puede
  // validar el estado RESULTANTE cuando el PATCH trae solo una de las dos cosas —y «encender el
  // flag a secas» es el caso normal—. Es el gesto que `clients.routes.ts` ya hace para
  // `incoherenciasFiscales`. Proyección explícita: de esta fila solo hacen falta las dos columnas
  // que deciden, y ninguna sale por HTTP.
  const [previo] = await db
    .select({
      id: clients.id,
      soatSinTramite: clients.soatSinTramite,
      proveedorSinTramiteId: clients.flitoProveedorSoatSinTramiteId,
    })
    .from(clients).where(eq(clients.id, id)).limit(1);
  if (!previo) { res.status(404).json({ error: 'La compañía no existe' }); return; }

  // El proveedor tiene que existir y estar ACTIVO (AC2b). «Válida incluye vigente»: aceptar un
  // proveedor apagado —que la pantalla ya no ofrece— convertiría el catálogo en una lista de
  // sugerencias, y el alta del canal Cliente lo mandaría todo a contingencia sin que nadie lo
  // hubiera decidido.
  if (cambios.proveedorSoatSinTramiteId) {
    const [proveedor] = await db
      .select({ id: flitoProveedoresSoat.id, activo: flitoProveedoresSoat.activo })
      .from(flitoProveedoresSoat)
      .where(eq(flitoProveedoresSoat.id, cambios.proveedorSoatSinTramiteId)).limit(1);
    if (!proveedor || proveedor.activo !== true) {
      res.status(400).json({
        error: 'El gestor por defecto no existe o está inactivo',
        campo: 'proveedorSoatSinTramiteId',
      });
      return;
    }
  }

  // Sobre el estado RESULTANTE y no sobre lo que llega: `cambios.x ?? previo.x` en las DOS claves.
  // Encender el flag sin tocar el gestor y quitar el gestor sin tocar el flag llegan aquí igual.
  const flagResultante = cambios.soatSinTramite ?? previo.soatSinTramite;
  const gestorResultante = cambios.proveedorSoatSinTramiteId !== undefined
    ? cambios.proveedorSoatSinTramiteId
    : previo.proveedorSinTramiteId;
  if (flagResultante && gestorResultante == null) {
    res.status(400).json({ error: FALTA_GESTOR, campo: 'proveedorSoatSinTramiteId' });
    return;
  }

  const set: Partial<typeof clients.$inferInsert> = {};
  if (cambios.soatAutogestionable !== undefined) set.soatAutogestionable = cambios.soatAutogestionable;
  // Cada bandera se escribe SOLA. Un `set.soatSinTramite = false` colgado del `if` de la autogestión
  // sería justo lo que el AC3 prohíbe: apagar una y que se apague la otra.
  if (cambios.soatSinTramite !== undefined) set.soatSinTramite = cambios.soatSinTramite;
  if (cambios.impuestosAutogestionable !== undefined) set.impuestosAutogestionable = cambios.impuestosAutogestionable;
  if (cambios.logisticaAutogestionable !== undefined) set.logisticaAutogestionable = cambios.logisticaAutogestionable;
  if (cambios.logisticaPermiteParcial !== undefined) set.logisticaPermiteParcial = cambios.logisticaPermiteParcial;
  if (cambios.carpetaStorage !== undefined) set.flitoCarpetaStorage = cambios.carpetaStorage;
  if (cambios.toleranciaValorImpuesto !== undefined) set.flitoToleranciaValorImpuesto = String(cambios.toleranciaValorImpuesto);
  // Cada bandera se escribe SOLA, y el gestor también: **apagar el canal NO borra el gestor**
  // (AC2c), se conserva por si se vuelve a encender. Colgar un `set.flitoProveedorSoatSinTramiteId
  // = null` del `if` del flag sería exactamente lo que el comentario de arriba prohíbe entre
  // banderas, y además obligaría a reconfigurar cada vez.
  if (cambios.proveedorSoatSinTramiteId !== undefined) {
    set.flitoProveedorSoatSinTramiteId = cambios.proveedorSoatSinTramiteId;
  }

  if (Object.keys(set).length === 0) { res.status(400).json({ error: 'Nada que actualizar' }); return; }

  let updated: FilaCompania | undefined;
  try {
    // `returning()` PROYECTADO a lo que el DTO publica: ver `COLUMNAS_COMPANIA_DTO`.
    [updated] = await db.update(clients).set(set).where(eq(clients.id, id))
      .returning(COLUMNAS_COMPANIA_DTO);
  } catch (e) {
    // `clients_sin_tramite_gestor_chk` (migración 0175), Y NO CUALQUIER `23514`. Con las dos guardas
    // de arriba no debería llegar aquí desde una sola petición; SÍ puede llegar desde dos PATCH
    // concurrentes —uno que enciende el flag y otro que quita el gestor, cada uno legal contra el
    // estado que leyó—, que es justo el caso que motiva el CHECK. Sin esta traducción sale como 500;
    // sin la comprobación del NOMBRE, cualquier otra restricción de `clients` saldría como un consejo
    // equivocado.
    const err = e as { code?: string; constraint_name?: string };
    if (err?.code === CHECK_VIOLATION && err.constraint_name === CHK_SIN_TRAMITE_GESTOR) {
      res.status(400).json({ error: FALTA_GESTOR, campo: 'proveedorSoatSinTramiteId' });
      return;
    }
    next(e);
    return;
  }
  if (!updated) { res.status(404).json({ error: 'La compañía no existe' }); return; }

  // ── El QUÉ, y no solo el quién y el cuándo (HU #12078) ─────────────────────────────────────────
  //
  // «Operaciones redirigió el canal de esta compañía a otra aseguradora» es una decisión de
  // ENRUTAMIENTO: de ella depende a qué gestor van a parar todas las solicitudes que esa compañía
  // radique a partir de ese instante. `clients` no versiona su configuración —guarda el estado
  // actual y nada más—, así que si el registro de auditoría solo dice actor e instante, el cambio no
  // es reconstruible después: no hay dónde mirar de qué gestor a cuál se movió.
  //
  // Solo lo que VINO en el patch (`cambios.x !== undefined`), no el estado resultante: un PATCH de la
  // carpeta de storage no puede dejar escrito «gestor por defecto: …» sin que nadie lo haya tocado.
  // El uuid del proveedor identifica una EMPRESA, no a una persona — es el mismo dato que ya viaja en
  // el `detail` del alta del canal.
  const cambiosDelCanal: string[] = [];
  if (cambios.soatSinTramite !== undefined) {
    cambiosDelCanal.push(`SOAT sin trámite ${cambios.soatSinTramite ? 'activado' : 'desactivado'}`);
  }
  if (cambios.proveedorSoatSinTramiteId !== undefined) {
    cambiosDelCanal.push(
      `gestor por defecto: ${cambios.proveedorSoatSinTramiteId ?? 'sin configurar'}`,
    );
  }

  await audit(req, {
    action: 'update',
    resource: 'flito_compania',
    resourceId: String(id),
    detail: `Parametrización compañía ${updated.name}`
      + (cambiosDelCanal.length ? ` — ${cambiosDelCanal.join('; ')}` : ''),
  });
  res.json(companiaDto(updated));
});

// ───────────────────────────────── Proveedores de SOAT ──────────────────────

function proveedorDto(p: typeof flitoProveedoresSoat.$inferSelect) {
  return {
    id: p.id,
    nombre: p.nombre,
    estrategia: p.estrategia,
    umbralOcr: p.umbralOcr === null ? null : Number(p.umbralOcr),
    slaHoras: p.slaHoras,
    activo: p.activo,
  };
}

router.get('/proveedores-soat', LECTURA, async (_req: Request, res: Response) => {
  const filas = await db.select().from(flitoProveedoresSoat).orderBy(asc(flitoProveedoresSoat.nombre));
  res.json(filas.map(proveedorDto));
});

const crearProveedorSchema = z.object({
  nombre: z.string().min(1).max(150),
  estrategia: z.string().max(40).optional(),
  umbralOcr: z.number().min(0).max(1).nullable().optional(),
  slaHoras: z.number().int().min(1).nullable().optional(),
});

router.post('/proveedores-soat', ESCRITURA, async (req: Request, res: Response) => {
  const parsed = crearProveedorSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  const { nombre, estrategia, umbralOcr, slaHoras } = parsed.data;

  const [existente] = await db.select({ id: flitoProveedoresSoat.id }).from(flitoProveedoresSoat)
    .where(eq(flitoProveedoresSoat.nombre, nombre)).limit(1);
  if (existente) { res.status(409).json({ error: 'Ya existe un proveedor con ese nombre' }); return; }

  const [creado] = await db.insert(flitoProveedoresSoat).values({
    nombre,
    ...(estrategia !== undefined ? { estrategia } : {}),
    umbralOcr: umbralOcr === undefined || umbralOcr === null ? null : String(umbralOcr),
    slaHoras: slaHoras ?? null,
  }).returning();

  await audit(req, { action: 'create', resource: 'flito_proveedor_soat', resourceId: creado.id, detail: `Proveedor SOAT: ${nombre}` });
  res.status(201).json(proveedorDto(creado));
});

const actualizarProveedorSchema = z.object({
  nombre: z.string().min(1).max(150).optional(),
  estrategia: z.string().max(40).optional(),
  umbralOcr: z.number().min(0, 'El umbral de OCR debe estar entre 0 y 1').max(1, 'El umbral de OCR debe estar entre 0 y 1').nullable().optional(),
  slaHoras: z.number().int().min(1).nullable().optional(),
  activo: z.boolean().optional(),
});

router.patch('/proveedores-soat/:id', ESCRITURA, async (req: Request, res: Response) => {
  const id = req.params.id;
  const parsed = actualizarProveedorSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }

  const cambios = parsed.data;
  const set: Partial<typeof flitoProveedoresSoat.$inferInsert> = {};
  if (cambios.nombre !== undefined) set.nombre = cambios.nombre;
  if (cambios.estrategia !== undefined) set.estrategia = cambios.estrategia;
  if (cambios.umbralOcr !== undefined) set.umbralOcr = cambios.umbralOcr === null ? null : String(cambios.umbralOcr);
  if (cambios.slaHoras !== undefined) set.slaHoras = cambios.slaHoras;
  if (cambios.activo !== undefined) set.activo = cambios.activo;

  if (Object.keys(set).length === 0) { res.status(400).json({ error: 'Nada que actualizar' }); return; }

  const [updated] = await db.update(flitoProveedoresSoat).set(set).where(eq(flitoProveedoresSoat.id, id)).returning();
  if (!updated) { res.status(404).json({ error: 'El proveedor no existe' }); return; }

  await audit(req, { action: 'update', resource: 'flito_proveedor_soat', resourceId: id, detail: `Parametrización proveedor ${updated.nombre}` });
  res.json(proveedorDto(updated));
});

// ───────────────────────────────── Organismos + modalidad ───────────────────

async function organismoDto(codigo: string) {
  const [org] = await db.select().from(organismosTransitoConfig).where(eq(organismosTransitoConfig.codigo, codigo)).limit(1);
  if (!org) return null;
  const modalidad = await modalidadVigente(codigo);
  return {
    codigo: org.codigo,
    nombre: org.alias ?? org.codigo,
    alias: org.alias,
    activo: org.activo,
    modalidadVigente: modalidad,
    umbralOcr: org.flitoUmbralOcr === null ? null : Number(org.flitoUmbralOcr),
    slaHoras: org.flitoSlaHoras,
    diferenciaValorActiva: org.flitoDiferenciaValorActiva,
    // Derechos de trámite (HU #10950/#10952): pista de OCR y carpeta de Drive del organismo.
    ocrPromptHint: org.flitoOcrPromptHint,
    driveFolderId: org.flitoDriveFolderId,
    driveActivo: org.flitoDriveActivo,
  };
}

router.get('/organismos', LECTURA, async (_req: Request, res: Response) => {
  const filas = await db.select().from(organismosTransitoConfig).orderBy(asc(organismosTransitoConfig.codigo));
  const dtos = await Promise.all(filas.map((o) => organismoDto(o.codigo)));
  res.json(dtos.filter(Boolean));
});

/**
 * Garantiza que exista la fila de config del organismo, creándola desde el catálogo nacional si aún no
 * estaba sembrada. Permite clasificar/parametrizar CUALQUIER secretaría (no solo las del seed): la
 * modalidad por defecto ya es AUTOGESTIONADO (ver modalidadVigente). Devuelve false solo si el código no
 * corresponde a un organismo real del catálogo.
 */
async function asegurarConfigOrganismo(codigo: string): Promise<boolean> {
  const [existe] = await db.select({ codigo: organismosTransitoConfig.codigo })
    .from(organismosTransitoConfig).where(eq(organismosTransitoConfig.codigo, codigo)).limit(1);
  if (existe) return true;
  const enCatalogo = ORGANISMOS_TRANSITO.find((o) => o.codigo === codigo);
  if (!enCatalogo) return false;
  await db.insert(organismosTransitoConfig)
    .values({ codigo, alias: `Tránsito de ${enCatalogo.ciudad}` })
    .onConflictDoNothing();
  return true;
}

router.get('/organismos/:codigo/vigencias', LECTURA, async (req: Request, res: Response) => {
  const codigo = req.params.codigo;
  const filas = await db.select().from(flitoOrganismoVigencias)
    .where(eq(flitoOrganismoVigencias.organismoCodigo, codigo))
    .orderBy(desc(flitoOrganismoVigencias.desde));
  res.json(filas.map((v) => ({
    id: v.id,
    modalidad: v.modalidad,
    desde: v.desde.toISOString(),
    hasta: v.hasta ? v.hasta.toISOString() : null,
    motivo: v.motivo,
    actorNombre: v.actorNombre,
    creadoEn: v.createdAt.toISOString(),
  })));
});

const cambiarModalidadSchema = z.object({
  modalidad: z.enum([
    ModalidadOrganismo.REQUIERE_GESTION,
    ModalidadOrganismo.AUTOGESTIONADO,
  ]),
  motivo: z.string().min(5, 'El motivo debe explicar el porqué del cambio'),
});

/**
 * Cambia la modalidad: cierra la vigencia anterior y abre una nueva (CA-04, nunca sobrescribe). Los
 * impuestos ya sincronizados conservan su estado; los nuevos trámites toman la modalidad vigente en el
 * próximo sync. El motivo es obligatorio para la auditoría.
 */
router.post('/organismos/:codigo/modalidad', ESCRITURA, async (req: Request, res: Response) => {
  const codigo = req.params.codigo;
  const parsed = cambiarModalidadSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  const { modalidad, motivo } = parsed.data;

  // Crea la fila de config al vuelo si el organismo del catálogo aún no estaba sembrado (así se puede
  // clasificar cualquier secretaría, no solo las del seed).
  if (!(await asegurarConfigOrganismo(codigo))) { res.status(404).json({ error: 'El organismo no existe' }); return; }

  const anterior = await modalidadVigente(codigo);
  if (anterior === modalidad) { res.status(400).json({ error: `El organismo ya está en modalidad "${modalidad}"` }); return; }

  const ahora = new Date();
  await db.transaction(async (tx) => {
    await tx.update(flitoOrganismoVigencias).set({ hasta: ahora })
      .where(and(eq(flitoOrganismoVigencias.organismoCodigo, codigo), sql`hasta IS NULL`));
    await tx.insert(flitoOrganismoVigencias).values({
      organismoCodigo: codigo, modalidad, desde: ahora, hasta: null,
      motivo: motivo.trim(), actorId: req.user!.sub, actorNombre: req.user!.username,
    });
  });

  await audit(req, {
    action: 'update', resource: 'flito_organismo', resourceId: codigo,
    detail: `Modalidad ${anterior} → ${modalidad}. Motivo: ${motivo.trim()}`,
  });
  res.json(await organismoDto(codigo));
});

const actualizarOrganismoSchema = z.object({
  umbralOcr: z.number().min(0).max(1).nullable().optional(),
  slaHoras: z.number().int().min(1).nullable().optional(),
  // D-5 (Fase 7): activa/desactiva la marca de diferencia de valor de impuestos por organismo.
  diferenciaValorActiva: z.boolean().optional(),
  // HU #10950: pista que se concatena al prompt genérico de derechos de trámite. Cadena vacía = quitar.
  ocrPromptHint: z.string().max(500).nullable().optional(),
  // HU #10952: carpeta de Drive del organismo y su interruptor. Configurar no es activar: se puede
  // dejar la carpeta puesta con la sincronización apagada mientras se valida.
  driveFolderId: z.string().max(120).nullable().optional(),
  driveActivo: z.boolean().optional(),
});

router.patch('/organismos/:codigo', ESCRITURA, async (req: Request, res: Response) => {
  const codigo = req.params.codigo;
  const parsed = actualizarOrganismoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }

  const cambios = parsed.data;
  const set: Partial<typeof organismosTransitoConfig.$inferInsert> = {};
  if (cambios.umbralOcr !== undefined) set.flitoUmbralOcr = cambios.umbralOcr === null ? null : String(cambios.umbralOcr);
  if (cambios.slaHoras !== undefined) set.flitoSlaHoras = cambios.slaHoras;
  if (cambios.diferenciaValorActiva !== undefined) set.flitoDiferenciaValorActiva = cambios.diferenciaValorActiva;
  if (cambios.ocrPromptHint !== undefined) set.flitoOcrPromptHint = cambios.ocrPromptHint?.trim() || null;
  if (cambios.driveFolderId !== undefined) set.flitoDriveFolderId = cambios.driveFolderId?.trim() || null;
  if (cambios.driveActivo !== undefined) set.flitoDriveActivo = cambios.driveActivo;
  if (Object.keys(set).length === 0) { res.status(400).json({ error: 'Nada que actualizar' }); return; }

  // Igual que en el cambio de modalidad: crea la config si el organismo del catálogo no estaba sembrado.
  if (!(await asegurarConfigOrganismo(codigo))) { res.status(404).json({ error: 'El organismo no existe' }); return; }
  const [updated] = await db.update(organismosTransitoConfig).set(set).where(eq(organismosTransitoConfig.codigo, codigo)).returning();
  if (!updated) { res.status(404).json({ error: 'El organismo no existe' }); return; }

  const detalleDif = cambios.diferenciaValorActiva === undefined ? '' : `; diferencia de valor ${cambios.diferenciaValorActiva ? 'activada' : 'desactivada'}`;
  const detalleDrive = cambios.driveActivo === undefined ? '' : `; sincronización Drive ${cambios.driveActivo ? 'activada' : 'desactivada'}`;
  await audit(req, { action: 'update', resource: 'flito_organismo', resourceId: codigo, detail: `Parámetros OCR/SLA organismo ${codigo}${detalleDif}${detalleDrive}` });
  res.json(await organismoDto(codigo));
});

// Las reglas de enrutamiento de proveedor se retiraron en la HU #10979: el proveedor se elige al
// enviar el SOAT al gestor, que es cuando alguien mira la carga de cada uno. La tabla
// `flito_reglas_proveedor_soat` se deja en la base a propósito —borrar datos en el mismo cambio que
// quita su único lector es innecesariamente irreversible— y su DROP irá en una migración posterior.

// ───────────────────────────────── Tarifas por compañía ────────────────────
//
// El valor negociado del trámite digital y de la logística. Antes eran constantes iguales para
// todos los clientes; el requerimiento cita $200.000 en una compañía y $1.500 en otra.

const tarifaCrearSchema = z.object({
  companiaId: z.number().int().positive(),
  concepto: z.enum(CONCEPTOS_TARIFA),
  // Vacío o ausente = tarifa genérica del concepto.
  tipoTramite: z.string().trim().max(60).optional().nullable(),
  valor: z.number().nonnegative(),
  activo: z.boolean().optional(),
});
const tarifaEditarSchema = z.object({
  valor: z.number().nonnegative().optional(),
  activo: z.boolean().optional(),
}).refine((d) => d.valor !== undefined || d.activo !== undefined, { message: 'Nada que actualizar' });

/** TarifaError es de negocio (400); cualquier otra cosa sube y la maneja el error handler. */
function tarifaFallo(res: Response, e: unknown): void {
  if (e instanceof TarifaError) { res.status(400).json({ error: e.message }); return; }
  throw e;
}

router.get('/tarifas', LECTURA_TARIFAS, async (req: Request, res: Response) => {
  const companiaId = Number(req.query.companiaId) || undefined;
  res.json(await listarTarifas(companiaId));
});

router.post('/tarifas', ESCRITURA_TARIFAS, async (req: Request, res: Response) => {
  const parsed = tarifaCrearSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos' }); return; }
  try {
    const t = await crearTarifa(parsed.data, req.user?.sub ?? null);
    await audit(req, {
      action: 'create', resource: 'flito_tarifa', resourceId: t.id,
      detail: `Tarifa ${t.concepto}${t.tipoTramite ? ` (${t.tipoTramite})` : ' (genérica)'} = ${t.valor} para ${t.companiaNombre ?? t.companiaId}`,
    });
    res.status(201).json(t);
  } catch (e) { tarifaFallo(res, e); }
});

router.patch('/tarifas/:id', ESCRITURA_TARIFAS, async (req: Request, res: Response) => {
  const parsed = tarifaEditarSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos' }); return; }
  try {
    const t = await actualizarTarifa(req.params.id, parsed.data, req.user?.sub ?? null);
    await audit(req, {
      action: 'update', resource: 'flito_tarifa', resourceId: t.id,
      detail: `Tarifa ${t.concepto}${t.tipoTramite ? ` (${t.tipoTramite})` : ' (genérica)'} = ${t.valor}, activa=${t.activo}`,
    });
    res.json(t);
  } catch (e) { tarifaFallo(res, e); }
});

router.delete('/tarifas/:id', ESCRITURA_TARIFAS, async (req: Request, res: Response) => {
  try {
    await eliminarTarifa(req.params.id);
    await audit(req, { action: 'delete', resource: 'flito_tarifa', resourceId: req.params.id, detail: 'Tarifa eliminada' });
    res.status(204).end();
  } catch (e) { tarifaFallo(res, e); }
});

export default router;
