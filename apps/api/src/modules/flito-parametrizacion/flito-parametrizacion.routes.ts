// FLITO — parametrización (HTTP). Portado de packages/server/src/parametrizacion.
//
// Toda la parametrización es de `operaciones`, con lectura para `auditor`. Los gestores
// NO entran: un gestor que pudiera cambiar el umbral de OCR de su proveedor podría hacer
// que sus propias facturas pasaran sin revisión (RN-04).

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { mensajesDeTipo } from '../../shared/utils/zod-mensajes.js';
import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  clients,
  flitoImpuestos,
  flitoOrganismoVigencias,
  flitoProveedoresSoat,
  flitoReglasProveedorSoat,
  organismosTransitoConfig,
} from '../../db/schema.js';
import { authMiddleware, invalidateSessionCacheFor } from '../../shared/middleware/auth.js';
import { exigirFuncion, funcionesConcedidas, tieneFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import {
  AmbitoReglaProveedor,
  CONCEPTOS_TARIFA,
  EstadoImpuesto,
  ModalidadOrganismo,
  ORGANISMOS_TRANSITO,
  PRIORIDAD_POR_AMBITO,
  SERVICIO_ADICIONAL_DESCRIPCION_MAX,
  SERVICIO_ADICIONAL_NOMBRE_MAX,
  TARIFA_VALOR_MAX,
  tipoTramiteTarifaDe,
  esConceptoLogistica,
} from '@operaciones/shared-types';
import {
  esDuplicadoNombreProveedorSoat, mensajeNombreProveedorDuplicado, modalidadVigente,
} from './flito-parametrizacion.service.js';
import { clienteVigente } from '../clients/cliente-operable.js';
import {
  ProveedorLogisticaNoUsableError, ProveedorLogisticaRequeridoError, exigirProveedorLogisticaUsable, exigirProveedorSiEncendida,
} from './flito-logistica-proveedor-compania.service.js';
import { parseFechaQuery } from '../../shared/utils/fecha-rango.js';
import {
  cambiarOCerrar, fijarTarifa, historial, listarTarifas, vistaPorCompania,
  TarifaCeroSinConfirmarError, TarifaConflictoError, TarifaError, TarifaNoEncontradaError,
} from './flito-tarifas.service.js';
import {
  crearTipo, darDeBajaTipo, editarTipo, listarTipos,
  ServicioAdicionalConflictoError, ServicioAdicionalError, ServicioAdicionalNoEncontradoError,
} from './flito-servicios-adicionales.service.js';
import {
  EstadoProveedorCambiadoError, MENSAJE_ESTADO_POR_ACCION, ProveedorSoatNoEncontradoError,
  ProveedorSoatNoUsableError, cambiarEstadoProveedorSoat, exigirProveedorSoatUsable, impactoProveedorSoat,
} from './flito-proveedores-estado.service.js';
import { listarProveedoresUnificados } from './flito-proveedores-logistica-gestion.service.js';
import { ProveedorSoatNoEliminableError, eliminarProveedorSoat } from './flito-proveedores-eliminar.service.js';
import { BloqueoAdministracionError } from '../../shared/permisos-anti-bloqueo.js';
import { actorDeRequest } from '../../shared/historial/permisos-auditoria.js';

const router = Router();
router.use(authMiddleware);

// Lectura: operaciones + auditoría (solo lectura). Escritura: solo operaciones.
// Las TARIFAS son la parte comercial del cliente: las negocia Finanzas, así que también las escribe.
// El resto de la parametrización (umbrales de OCR, SLA, modalidad, autogestión) sigue siendo solo de
// Operaciones — RN-04: un gestor que pudiera mover su propio umbral colaría sus facturas sin revisar.

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
  // HU #13953: el selector de compañías distingue activas de inactivas (los eliminados ni salen).
  active: clients.active,
  soatAutogestionable: clients.soatAutogestionable,
  /** @deprecated #13968 — HU #13967: calculado (canal abierto = proveedor elegido); la columna salió del esquema. */
  soatSinTramite: sql<boolean>`${clients.flitoProveedorSoatSinTramiteId} IS NOT NULL`,
  flitoProveedorSoatSinTramiteId: clients.flitoProveedorSoatSinTramiteId,
  impuestosAutogestionable: clients.impuestosAutogestionable,
  logisticaAutogestionable: clients.logisticaAutogestionable,
  flitoProveedorLogisticaId: clients.flitoProveedorLogisticaId,
  logisticaPermiteParcial: clients.logisticaPermiteParcial,
  flitoCarpetaStorage: clients.flitoCarpetaStorage,
  flitoToleranciaValorImpuesto: clients.flitoToleranciaValorImpuesto,
} as const;

/**
 * Lo mínimo que `companiaDto` necesita. Se deriva de la constante de arriba y no se escribe a mano:
 * añadir una clave al DTO obliga a añadirla a la proyección, o no compila.
 */
type FilaCompania = Pick<typeof clients.$inferSelect, Exclude<keyof typeof COLUMNAS_COMPANIA_DTO, 'soatSinTramite'>>
  & { soatSinTramite: boolean };

function companiaDto(c: FilaCompania) {
  return {
    id: c.id,
    nombre: c.name,
    nit: c.document,
    activo: c.active,
    soatAutogestionable: c.soatAutogestionable,
    // Feature #11912 — «SOAT sin trámite». @deprecated #13968: desde la HU #13967 no hay interruptor;
    // el canal está abierto si la compañía tiene proveedor elegido, y este booleano lo CALCULA
    // (`COLUMNAS_COMPANIA_DTO`) para no romper la web vieja.
    soatSinTramite: c.soatSinTramite,
    // Feature #12074, HU #12078 — el gestor por defecto AL QUE VAN las solicitudes de ese canal.
    // Va en el DTO para que la pantalla pueda pintarlo (el selector es la HU #12079). `null` = «Sin
    // proveedor» = canal cerrado (HU #13967). Es el uuid de una aseguradora, no
    // un dato personal. **Solo del canal sin trámite**: el SOAT por trámite elige gestor en cada
    // `POST /flito/soat/enviar` y no lee esta columna (AC2e).
    proveedorSoatSinTramiteId: c.flitoProveedorSoatSinTramiteId,
    impuestosAutogestionable: c.impuestosAutogestionable,
    logisticaAutogestionable: c.logisticaAutogestionable,
    // HU #14104 — proveedor que maneja la logística (uuid de una empresa; `null` = sin asignar).
    proveedorLogisticaId: c.flitoProveedorLogisticaId,
    logisticaPermiteParcial: c.logisticaPermiteParcial,
    carpetaStorage: c.flitoCarpetaStorage,
    toleranciaValorImpuesto: Number(c.flitoToleranciaValorImpuesto),
  };
}

router.get('/companias', exigirFuncion('parametrizacion.companias.listar'), async (_req: Request, res: Response) => {
  // RN-CLI-9 (HU #13953): el selector solo ofrece clientes vigentes.
  const filas = await db.select(COLUMNAS_COMPANIA_DTO).from(clients).where(clienteVigente()).orderBy(asc(clients.name));
  res.json(filas.map(companiaDto));
});

const actualizarCompaniaSchema = z.object({
  soatAutogestionable: z.boolean().optional(),
  // HU #13967: `soatSinTramite` ya no se acepta — `z.object` (no `.strict()`) lo DESCARTA en silencio.
  impuestosAutogestionable: z.boolean().optional(),
  logisticaAutogestionable: z.boolean().optional(),
  // HU #14104: `null` explícito = quitar el proveedor (solo válido con la logística apagada).
  proveedorLogisticaId: z.string().guid().nullable().optional(),
  logisticaPermiteParcial: z.boolean().optional(),
  carpetaStorage: z.string().max(300).nullable().optional(),
  toleranciaValorImpuesto: z.number().min(0, 'La tolerancia no puede ser negativa').optional(),
  // HU #12078. Sin el prefijo `flito` en el cuerpo, como `carpetaStorage` ↔ `flitoCarpetaStorage`.
  // `null` explícito SÍ se acepta: es «Sin proveedor», y cierra el canal (HU #13967).
  proveedorSoatSinTramiteId: z.string().guid().nullable().optional(),
});

// HU #13428 (diseño §5-ter.1 punto 2): la guarda se parte por GRUPO DE CAMPOS del cuerpo, cada uno con
// su operación en línea — autogestión (`[autogestion]`), «SOAT sin trámite» (`[sinTramite]`) y el resto
// (`[general]`, `parametrizacion.companias.editar`). Cada grupo presente exige la suya; un cuerpo sin
// ningún campo conocido → 400. Se decide antes de validar el cuerpo (403 antes que 400).
// HU #14104: el proveedor de logística viaja con la autogestión de logística (misma operación, sin guarda nueva).
const CAMPOS_AUTOGESTION = ['soatAutogestionable', 'impuestosAutogestionable', 'logisticaAutogestionable', 'proveedorLogisticaId'];
const CAMPOS_SIN_TRAMITE = ['proveedorSoatSinTramiteId'];
// HU #13967: `soatSinTramite` se IGNORA. No exige operación ni cuenta como campo; un cuerpo que solo
// la trae pasa la guarda y cae en el 400 «Nada que actualizar» (la web siempre manda las dos claves).
const CAMPOS_IGNORADOS = ['soatSinTramite'];
const CAMPOS_GENERALES = ['logisticaPermiteParcial', 'carpetaStorage', 'toleranciaValorImpuesto'];

/** `null` = puede; `'vacio'` = el cuerpo no trae ningún grupo; si no, el grupo al que le faltó su operación. */
async function grupoDenegadoCompania(req: Request): Promise<null | 'vacio' | 'general' | 'autogestion' | 'sinTramite'> {
  const claves = req.body && typeof req.body === 'object' ? Object.keys(req.body) : [];
  const trae = (grupo: string[]) => claves.some((k) => grupo.includes(k));
  if (!trae(CAMPOS_AUTOGESTION) && !trae(CAMPOS_SIN_TRAMITE) && !trae(CAMPOS_GENERALES) && !trae(CAMPOS_IGNORADOS)) {
    return 'vacio';
  }
  if (trae(CAMPOS_GENERALES) && !(await tieneFuncion(req, 'parametrizacion.companias.editar'))) return 'general';
  if (trae(CAMPOS_AUTOGESTION) && !(await tieneFuncion(req, 'parametrizacion.companias.autogestion'))) return 'autogestion';
  if (trae(CAMPOS_SIN_TRAMITE) && !(await tieneFuncion(req, 'parametrizacion.companias.soat_sin_tramite'))) return 'sinTramite';
  return null;
}

router.patch('/companias/:id', async (req: Request, res: Response, next: NextFunction) => {
  const denegado = await grupoDenegadoCompania(req);
  if (denegado === 'vacio') { res.status(400).json({ error: 'Datos inválidos: no hay ningún campo que cambiar' }); return; }
  if (denegado) { res.status(403).json({ error: 'Sin permisos', grupo: denegado }); return; }
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = actualizarCompaniaSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }

  const cambios = parsed.data;

  // ── Se lee la fila previa ANTES de construir el `set` (HU #12078) ──────────────────────────────
  //
  // Da el 404 de un eliminado y el gestor ACTUAL, para validar el nuevo solo si cambia (HU #13959).
  // Proyección explícita: nada de esta fila sale por HTTP.
  const [previo] = await db
    .select({
      id: clients.id,
      proveedorSinTramiteId: clients.flitoProveedorSoatSinTramiteId,
      logisticaAutogestionable: clients.logisticaAutogestionable,
      proveedorLogisticaId: clients.flitoProveedorLogisticaId,
    })
    // RN-CLI-9 (HU #13953): un eliminado no admite gestor por defecto ni otra parametrización (= inexistente).
    .from(clients).where(and(eq(clients.id, id), clienteVigente())).limit(1);
  if (!previo) { res.status(404).json({ error: 'La compañía no existe' }); return; }

  // El proveedor tiene que existir y estar ACTIVO (AC2b). «Válida incluye vigente»: aceptar un
  // proveedor apagado —que la pantalla ya no ofrece— convertiría el catálogo en una lista de
  // sugerencias, y el alta del canal Cliente lo mandaría todo a contingencia sin que nadie lo
  // hubiera decidido. HU #13959 (RN-PROV-5): se comprueba SOLO si el valor CAMBIA —un formulario que
  // reenvía el gestor que ya tenía no se rompe porque luego lo desactivaran (AC4)— y DENTRO de la
  // transacción del UPDATE, con `FOR SHARE` sobre el proveedor (AC6). Ver `exigirProveedorSoatUsable`.
  const cambiaGestor = cambios.proveedorSoatSinTramiteId != null
    && cambios.proveedorSoatSinTramiteId !== previo.proveedorSinTramiteId;

  const set: Partial<typeof clients.$inferInsert> = {};
  if (cambios.soatAutogestionable !== undefined) set.soatAutogestionable = cambios.soatAutogestionable;
  if (cambios.impuestosAutogestionable !== undefined) set.impuestosAutogestionable = cambios.impuestosAutogestionable;
  if (cambios.logisticaAutogestionable !== undefined) set.logisticaAutogestionable = cambios.logisticaAutogestionable;
  if (cambios.proveedorLogisticaId !== undefined) set.flitoProveedorLogisticaId = cambios.proveedorLogisticaId;
  if (cambios.logisticaPermiteParcial !== undefined) set.logisticaPermiteParcial = cambios.logisticaPermiteParcial;
  if (cambios.carpetaStorage !== undefined) set.flitoCarpetaStorage = cambios.carpetaStorage;
  if (cambios.toleranciaValorImpuesto !== undefined) set.flitoToleranciaValorImpuesto = String(cambios.toleranciaValorImpuesto);
  // HU #13967: el proveedor ES el canal — uuid lo abre hacia ese proveedor, `null` lo cierra.
  if (cambios.proveedorSoatSinTramiteId !== undefined) {
    set.flitoProveedorSoatSinTramiteId = cambios.proveedorSoatSinTramiteId;
  }

  if (Object.keys(set).length === 0) { res.status(400).json({ error: 'Nada que actualizar' }); return; }

  // HU #14104 (RN-PLOGC-1): se valida el estado RESULTANTE, y solo si el cuerpo toca la logística o su proveedor —un
  // PATCH de otra cosa no debe fallar por una compañía encendida que aún no tiene proveedor (las existentes al migrar).
  const proveedorLogisticaFinal = cambios.proveedorLogisticaId !== undefined ? cambios.proveedorLogisticaId : previo.proveedorLogisticaId;
  if (cambios.logisticaAutogestionable !== undefined || cambios.proveedorLogisticaId !== undefined) {
    try {
      exigirProveedorSiEncendida(cambios.logisticaAutogestionable ?? previo.logisticaAutogestionable, proveedorLogisticaFinal);
    } catch (e) {
      if (e instanceof ProveedorLogisticaRequeridoError) {
        res.status(422).json({ error: e.message, campo: 'proveedorLogisticaId' });
        return;
      }
      throw e;
    }
  }
  const cambiaProveedorLogistica = cambios.proveedorLogisticaId != null
    && cambios.proveedorLogisticaId !== previo.proveedorLogisticaId;

  let updated: FilaCompania | undefined;
  try {
    // `returning()` PROYECTADO a lo que el DTO publica: ver `COLUMNAS_COMPANIA_DTO`.
    [updated] = await db.transaction(async (tx) => {
      if (cambiaGestor) await exigirProveedorSoatUsable(tx, cambios.proveedorSoatSinTramiteId!);
      if (cambiaProveedorLogistica) await exigirProveedorLogisticaUsable(tx, cambios.proveedorLogisticaId!);
      return tx.update(clients).set(set).where(and(eq(clients.id, id), clienteVigente()))
        .returning(COLUMNAS_COMPANIA_DTO);
    });
  } catch (e) {
    if (e instanceof ProveedorSoatNoUsableError) {
      res.status(400).json({ error: e.message, campo: 'proveedorSoatSinTramiteId' });
      return;
    }
    if (e instanceof ProveedorLogisticaNoUsableError) {
      res.status(422).json({ error: e.message, campo: 'proveedorLogisticaId' });
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
  if (cambios.proveedorSoatSinTramiteId !== undefined) {
    cambiosDelCanal.push(`Proveedor SOAT sin trámite: ${cambios.proveedorSoatSinTramiteId ?? 'Sin proveedor'}`);
  }

  if (cambios.proveedorLogisticaId !== undefined) {
    cambiosDelCanal.push(`Proveedor de logística: ${cambios.proveedorLogisticaId ?? 'Sin proveedor'}`);
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

// HU #14148: listado UNIFICADO de proveedores (SOAT + logística) con `tipo` y `companiasAsignadas`. Misma función que
// los listados por tipo (`parametrizacion.proveedores.listar`): no ensancha quién ve NIT/contacto/teléfono.
router.get('/proveedores', exigirFuncion('parametrizacion.proveedores.listar'), async (_req: Request, res: Response) => {
  res.json(await listarProveedoresUnificados());
});

router.get('/proveedores-soat', exigirFuncion('parametrizacion.proveedores.listar'), async (_req: Request, res: Response) => {
  // HU #13957: los proveedores eliminados (baja lógica, `deleted_at`) no se listan.
  const filas = await db.select().from(flitoProveedoresSoat)
    .where(isNull(flitoProveedoresSoat.deletedAt)).orderBy(asc(flitoProveedoresSoat.nombre));
  res.json(filas.map(proveedorDto));
});

/** ¿Otro proveedor VIGENTE (distinto de `excluirId`) ya usa este nombre exacto? (HU #13957) */
async function nombreProveedorEnUso(nombre: string, excluirId?: string): Promise<boolean> {
  const filtros = [eq(flitoProveedoresSoat.nombre, nombre), isNull(flitoProveedoresSoat.deletedAt)];
  if (excluirId !== undefined) filtros.push(ne(flitoProveedoresSoat.id, excluirId));
  const [fila] = await db.select({ id: flitoProveedoresSoat.id }).from(flitoProveedoresSoat).where(and(...filtros)).limit(1);
  return fila !== undefined;
}

const crearProveedorSchema = z.object({
  nombre: z.string().min(1).max(150),
  estrategia: z.string().max(40).optional(),
  umbralOcr: z.number().min(0).max(1).nullable().optional(),
  slaHoras: z.number().int().min(1).nullable().optional(),
});

router.post('/proveedores-soat', exigirFuncion('parametrizacion.proveedores.crear'), async (req: Request, res: Response) => {
  const parsed = crearProveedorSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }
  const { nombre, estrategia, umbralOcr, slaHoras } = parsed.data;

  // HU #13957: el nombre solo lo ocupa un proveedor VIGENTE (un eliminado lo libera). El índice parcial de la 0259
  // es la red de seguridad de la carrera entre dos altas: su 23505 se traduce al mismo 409.
  if (await nombreProveedorEnUso(nombre)) { res.status(409).json({ error: mensajeNombreProveedorDuplicado(nombre) }); return; }

  let creado: typeof flitoProveedoresSoat.$inferSelect;
  try {
    [creado] = await db.insert(flitoProveedoresSoat).values({
      nombre,
      ...(estrategia !== undefined ? { estrategia } : {}),
      umbralOcr: umbralOcr === undefined || umbralOcr === null ? null : String(umbralOcr),
      slaHoras: slaHoras ?? null,
    }).returning();
  } catch (e) {
    if (esDuplicadoNombreProveedorSoat(e)) { res.status(409).json({ error: mensajeNombreProveedorDuplicado(nombre) }); return; }
    throw e;
  }

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

router.patch('/proveedores-soat/:id', exigirFuncion('parametrizacion.proveedores.editar'), async (req: Request, res: Response) => {
  const id = req.params.id;
  const parsed = actualizarProveedorSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }

  const cambios = parsed.data;
  // HU #13958 (AC5): el estado tiene su propia acción (exclusiva del Administrador, `PATCH /:id/estado`). Intentar
  // CAMBIARLO aquí → 400; el mismo valor que ya tiene se ignora (patrón de `PATCH /api/clients/:id`, HU #13945: el
  // formulario de edición reenvía la fila completa y no debe romperse). `activo` nunca entra en el `set`.
  if (cambios.activo !== undefined) {
    const [actual] = await db.select({ activo: flitoProveedoresSoat.activo }).from(flitoProveedoresSoat)
      .where(eq(flitoProveedoresSoat.id, id)).limit(1);
    if (actual && actual.activo !== cambios.activo) { res.status(400).json({ error: MENSAJE_ESTADO_POR_ACCION }); return; }
  }
  const set: Partial<typeof flitoProveedoresSoat.$inferInsert> = {};
  if (cambios.nombre !== undefined) set.nombre = cambios.nombre;
  if (cambios.estrategia !== undefined) set.estrategia = cambios.estrategia;
  if (cambios.umbralOcr !== undefined) set.umbralOcr = cambios.umbralOcr === null ? null : String(cambios.umbralOcr);
  if (cambios.slaHoras !== undefined) set.slaHoras = cambios.slaHoras;

  if (Object.keys(set).length === 0) { res.status(400).json({ error: 'Nada que actualizar' }); return; }

  if (set.nombre !== undefined && await nombreProveedorEnUso(set.nombre, id)) {
    res.status(409).json({ error: mensajeNombreProveedorDuplicado(set.nombre) }); return;
  }

  let updated: typeof flitoProveedoresSoat.$inferSelect | undefined;
  try {
    [updated] = await db.update(flitoProveedoresSoat).set(set).where(eq(flitoProveedoresSoat.id, id)).returning();
  } catch (e) {
    if (set.nombre !== undefined && esDuplicadoNombreProveedorSoat(e)) {
      res.status(409).json({ error: mensajeNombreProveedorDuplicado(set.nombre) }); return;
    }
    throw e;
  }
  if (!updated) { res.status(404).json({ error: 'El proveedor no existe' }); return; }

  await audit(req, { action: 'update', resource: 'flito_proveedor_soat', resourceId: id, detail: `Parametrización proveedor ${updated.nombre}` });
  res.json(proveedorDto(updated));
});

// ── HU #13958: desactivar y activar un proveedor SOAT, con vista previa de su impacto ────────────────────────────
// Las dos rutas exigen `parametrizacion.proveedores.estado`, que concede «Activar o desactivar proveedores», exclusiva
// del Administrador (0261). Gemelas de `GET /api/clients/:id/impacto` y `PATCH /api/clients/:id/estado` (HU #13945).

const UUID = z.string().uuid();
const idProveedor = (req: Request): string | null => (UUID.safeParse(req.params.id).success ? req.params.id : null);

router.get('/proveedores-soat/:id/impacto', exigirFuncion('parametrizacion.proveedores.estado'), async (req: Request, res: Response) => {
  const id = idProveedor(req);
  if (id === null) { res.status(400).json({ error: 'ID inválido' }); return; }
  const impacto = await impactoProveedorSoat(db, id);
  if (!impacto) { res.status(404).json({ error: new ProveedorSoatNoEncontradoError().message }); return; }
  res.json(impacto);
});

const estadoProveedorSchema = z.object({ activo: z.boolean(), activoEsperado: z.boolean() }).strict();

router.patch('/proveedores-soat/:id/estado', exigirFuncion('parametrizacion.proveedores.estado'), async (req: Request, res: Response, next: NextFunction) => {
  const id = idProveedor(req);
  if (id === null) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = estadoProveedorSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }

  let cambio;
  try {
    cambio = await cambiarEstadoProveedorSoat(id, parsed.data);
  } catch (e) {
    if (e instanceof ProveedorSoatNoEncontradoError) { res.status(404).json({ error: e.message }); return; }
    if (e instanceof EstadoProveedorCambiadoError) { res.status(409).json({ error: e.message }); return; }
    next(e); return;
  }
  // DESPUÉS del commit (patrón de `clients.routes.ts`): la siguiente petición de cada usuario relee la marca.
  for (const userId of cambio.usuariosInvalidados) invalidateSessionCacheFor(userId);

  // El nombre de un proveedor no es PII (mismo detalle que el resto de auditorías de proveedores).
  await audit(req, {
    action: 'update',
    resource: 'flito_proveedor_soat',
    resourceId: id,
    detail: `Proveedor SOAT ${cambio.activo ? 'activado' : 'desactivado'}: ${cambio.nombre}`
      + (cambio.activo ? '' : ` · sesiones invalidadas: ${cambio.usuariosInvalidados.length} usuario(s)`),
  });
  res.json({ id: cambio.id, activo: cambio.activo });
});

// ── HU #13960: eliminar un proveedor SOAT inactivo, sin SOAT en curso ni compañías asignadas (RN-PROV-6/7) ─────────
// Exige `parametrizacion.proveedores.eliminar`, que concede «Eliminar proveedores», exclusiva del Administrador (0263).
router.delete('/proveedores-soat/:id', exigirFuncion('parametrizacion.proveedores.eliminar'), async (req: Request, res: Response, next: NextFunction) => {
  const id = idProveedor(req);
  if (id === null) { res.status(400).json({ error: 'ID inválido' }); return; }
  let eliminado;
  try {
    eliminado = await eliminarProveedorSoat(id, actorDeRequest(req));
  } catch (e) {
    if (e instanceof ProveedorSoatNoEncontradoError) { res.status(404).json({ error: e.message }); return; }
    if (e instanceof EstadoProveedorCambiadoError || e instanceof ProveedorSoatNoEliminableError) {
      res.status(409).json({ error: e.message }); return;
    }
    // Seguro anti-bloqueo (HU #12089): desactivar a sus usuarios dejaría sin administrador. La tx revirtió.
    if (e instanceof BloqueoAdministracionError) { res.status(409).json({ error: e.message, funcion: e.funcion }); return; }
    next(e); return;
  }
  // DESPUÉS del commit: la siguiente petición de cada usuario relee `active = false`.
  for (const userId of eliminado.usuariosDesactivados) invalidateSessionCacheFor(userId);
  await audit(req, {
    action: 'delete', resource: 'flito_proveedor_soat', resourceId: id,
    detail: `Proveedor SOAT eliminado: ${eliminado.nombre} · usuarios desactivados: ${eliminado.usuariosDesactivados.length}`,
  });
  res.json({ id: eliminado.id, eliminado: true });
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

router.get('/organismos', exigirFuncion('parametrizacion.organismos.listar'), async (_req: Request, res: Response) => {
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

router.get('/organismos/:codigo/vigencias', exigirFuncion('parametrizacion.organismos.ver_vigencias'), async (req: Request, res: Response) => {
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
router.post('/organismos/:codigo/modalidad', exigirFuncion('parametrizacion.organismos.fijar_modalidad'), async (req: Request, res: Response) => {
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

router.patch('/organismos/:codigo', exigirFuncion('parametrizacion.organismos.editar'), async (req: Request, res: Response) => {
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
// El valor negociado del trámite digital y de la logística, como VIGENCIAS (HU #12373): fijar abre la
// primera, cambiar cierra la abierta y abre otra, dejar de cobrar cierra sin abrir. No hay DELETE ni
// «inactiva» (RN-04): un `DELETE /tarifas/:id` recibe el 404 genérico de Express.
//
// Una ruta ⇔ una función del catálogo. La ventana de Clientes (AC17) sigue usando GET/POST/PATCH sin
// cambios: `PATCH { activo:false }` es «dejar de cobrar» y `POST` es «fijar».

const valorSchema = z.number({ error: mensajesDeTipo({ requerido: 'es obligatorio', tipo: 'debe ser un número' }) })
  .finite('debe ser un número finito')
  .nonnegative('debe ser mayor o igual a cero')
  .max(TARIFA_VALOR_MAX, 'supera el máximo admitido (12 enteros y 2 decimales)')
  .refine((n) => Math.round(n * 100) / 100 === n, 'admite a lo sumo dos decimales');
const tarifaCrearSchema = z.object({
  companiaId: z.number().int().positive(),
  concepto: z.enum(CONCEPTOS_TARIFA),
  // Se normaliza en el servicio (`tipoTramiteTarifaDe`): obligatorio en trámite digital, prohibido en logística.
  tipoTramite: z.string().trim().max(60).optional().nullable(),
  valor: valorSchema,
  confirmarCero: z.boolean().optional(),
});
const tarifaEditarSchema = z.object({
  valor: valorSchema.optional(),
  activo: z.boolean().optional(),
  cerrar: z.literal(true).optional(),
  confirmarCero: z.boolean().optional(),
}).refine((d) => d.valor !== undefined || d.activo !== undefined || d.cerrar, { message: 'Nada que actualizar' });
const fechaQuerySchema = z.string().refine((f) => parseFechaQuery(f) !== null, 'debe ser un día YYYY-MM-DD').optional();
const historialQuerySchema = z.object({
  concepto: z.enum(CONCEPTOS_TARIFA).optional(),
  tipoTramite: z.string().optional(),
  desde: fechaQuerySchema,
  hasta: fechaQuerySchema,
});

/** «campo: regla» por cada problema, para que el 400 diga QUÉ campo y QUÉ regla (AC9). */
function mensajeDe(e: z.ZodError): string {
  return `Datos inválidos: ${e.issues.map((i) => (i.path.length ? `${i.path.join('.')} ${i.message}` : i.message)).join('; ')}`;
}

/** La clase del error decide el código: no encontrada 404, conflicto 409, cero sin confirmar y negocio 400. */
function tarifaFallo(res: Response, e: unknown): void {
  if (e instanceof TarifaNoEncontradaError) { res.status(404).json({ error: e.message }); return; }
  if (e instanceof TarifaConflictoError) { res.status(409).json({ error: e.message, vigenciaId: e.vigenciaId }); return; }
  if (e instanceof TarifaCeroSinConfirmarError) { res.status(400).json({ error: e.message, requiereConfirmacion: 'cero' }); return; }
  if (e instanceof TarifaError) { res.status(400).json({ error: e.message }); return; }
  throw e;
}

const rotulo = (t: { concepto: string; tipoTramite: string | null; companiaNombre: string | null; companiaId: number }) =>
  `Tarifa ${t.concepto}${t.tipoTramite ? ` (${t.tipoTramite})` : ''} de ${t.companiaNombre ?? t.companiaId}`;

// Acotado a int4 positivo: un id de 11+ dígitos pasaría el regex y Postgres respondería 22003 (500)
// en vez del 404 que corresponde a «esa compañía no existe».
const idCompania = (raw: string): number | null => {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 && n <= 2147483647 ? n : null;
};

router.get('/tarifas', exigirFuncion('parametrizacion.tarifas.listar'), async (req: Request, res: Response) => {
  const companiaId = Number(req.query.companiaId) || undefined;
  res.json(await listarTarifas(companiaId));
});

// Vista por cliente: las cuatro llaves fijas y las CAPACIDADES calculadas con el motor de permisos
// (AC12): la pantalla decide por esto, nunca por el nombre del rol. `editar` exige las dos funciones
// de escritura porque la vista escribe por las dos rutas (POST fija, PATCH cambia/cierra).
router.get('/tarifas/companias/:id', exigirFuncion('parametrizacion.tarifas.ver_por_cliente'), async (req: Request, res: Response) => {
  const companiaId = idCompania(req.params.id);
  if (companiaId === null) { res.status(400).json({ error: 'Datos inválidos: id debe ser numérico' }); return; }
  try {
    const vista = await vistaPorCompania(companiaId);
    const concedidas = await funcionesConcedidas(req, [
      'parametrizacion.tarifas.crear', 'parametrizacion.tarifas.editar', 'parametrizacion.tarifas.historial',
    ]);
    res.json({
      ...vista,
      capacidades: {
        editar: concedidas.has('parametrizacion.tarifas.crear') && concedidas.has('parametrizacion.tarifas.editar'),
        verHistorial: concedidas.has('parametrizacion.tarifas.historial'),
      },
    });
  } catch (e) { tarifaFallo(res, e); }
});

router.get('/tarifas/companias/:id/historial', exigirFuncion('parametrizacion.tarifas.historial'), async (req: Request, res: Response) => {
  const companiaId = idCompania(req.params.id);
  if (companiaId === null) { res.status(400).json({ error: 'Datos inválidos: id debe ser numérico' }); return; }
  const parsed = historialQuerySchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: mensajeDe(parsed.error) }); return; }
  const { concepto, tipoTramite, desde, hasta } = parsed.data;
  let tipo: ReturnType<typeof tipoTramiteTarifaDe> | undefined;
  if (tipoTramite !== undefined && !(concepto && esConceptoLogistica(concepto))) {
    tipo = tipoTramiteTarifaDe(tipoTramite);
    if (tipo === null) { res.status(400).json({ error: 'Datos inválidos: tipoTramite debe ser Matricula, Traspaso u Otros' }); return; }
  }
  try {
    res.json(await historial(companiaId, {
      concepto, tipoTramite: tipo,
      rango: desde || hasta ? { desde: desde ?? null, hasta: hasta ?? null } : undefined,
    }));
  } catch (e) { tarifaFallo(res, e); }
});

router.post('/tarifas', exigirFuncion('parametrizacion.tarifas.crear'), async (req: Request, res: Response) => {
  const parsed = tarifaCrearSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: mensajeDe(parsed.error) }); return; }
  try {
    const t = await fijarTarifa(parsed.data, req.user?.sub ?? null);
    await audit(req, {
      action: 'create', resource: 'flito_tarifa_vigencia', resourceId: t.id,
      detail: `${rotulo(t)} = ${t.valor}, vigente desde ${t.vigenteDesde}`,
    });
    res.status(201).json(t);
  } catch (e) { tarifaFallo(res, e); }
});

router.patch('/tarifas/:id', exigirFuncion('parametrizacion.tarifas.editar'), async (req: Request, res: Response) => {
  const parsed = tarifaEditarSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: mensajeDe(parsed.error) }); return; }
  try {
    const r = await cambiarOCerrar(req.params.id, parsed.data, req.user?.sub ?? null);
    if (r.accion !== 'sin_cambio') {
      await audit(req, {
        action: 'update', resource: 'flito_tarifa_vigencia', resourceId: r.tarifa.id,
        detail: r.accion === 'cerrada'
          ? `${rotulo(r.tarifa)} cerrada (dejar de cobrar); valor anterior ${r.valorAnterior}`
          : `${rotulo(r.tarifa)} de ${r.valorAnterior} a ${r.valorNuevo} (vigencia ${r.tarifa.id})`,
      });
    }
    res.json({ ...r.tarifa, valorAnterior: r.valorAnterior, valorNuevo: r.valorNuevo });
  } catch (e) { tarifaFallo(res, e); }
});

// ───────────────────────────── Servicios adicionales: catálogo de tipos ─────────────
//
// HU #12541 (Feature #12540). Lo que FLIT cobra aparte del trámite, como catálogo editable por
// Finanzas (mismo reparto que las tarifas: admin + financiera). Baja LÓGICA: no hay `DELETE` (recibe
// el 404 genérico de Express) ni reactivación; dar de baja libera el nombre. El nombre es único entre
// los activos comparado plegado; lo garantiza el índice de la 0191 y aquí se traduce a 409.
//
// Una ruta ⇔ una función del catálogo. `valorSchema` es el mismo de las tarifas: la misma columna
// `numeric(14,2)` y las mismas reglas (AC5).

const servicioAdicionalCrearSchema = z.object({
  nombre: z.string({ error: mensajesDeTipo({ requerido: 'es obligatorio', tipo: 'debe ser texto' }) }).trim()
    .min(1, 'es obligatorio').max(SERVICIO_ADICIONAL_NOMBRE_MAX, `admite a lo sumo ${SERVICIO_ADICIONAL_NOMBRE_MAX} caracteres`),
  descripcion: z.string({ error: mensajesDeTipo({ tipo: 'debe ser texto' }) }).trim()
    .max(SERVICIO_ADICIONAL_DESCRIPCION_MAX, `admite a lo sumo ${SERVICIO_ADICIONAL_DESCRIPCION_MAX} caracteres`).nullable().optional(),
  valor: valorSchema,
});
const servicioAdicionalEditarSchema = servicioAdicionalCrearSchema.partial()
  .refine((d) => d.nombre !== undefined || d.descripcion !== undefined || d.valor !== undefined, { message: 'Nada que actualizar' });

const uuidSchema = z.string().guid();
/** Un id que no es uuid es «no existe» (404), no 400 ni 500 (22P02): el id es opaco para el cliente. */
const idUuid = (raw: string): string | null => (uuidSchema.safeParse(raw).success ? raw : null);

/** La clase del error decide el código: no encontrado 404, conflicto 409 (`NOMBRE_DUPLICADO`), negocio 400. */
function servicioAdicionalFallo(res: Response, e: unknown): void {
  if (e instanceof ServicioAdicionalNoEncontradoError) { res.status(404).json({ error: e.message }); return; }
  if (e instanceof ServicioAdicionalConflictoError) { res.status(409).json({ error: e.message, codigo: 'NOMBRE_DUPLICADO', choca: e.choca }); return; }
  if (e instanceof ServicioAdicionalError) { res.status(400).json({ error: e.message }); return; }
  throw e;
}

router.get('/servicios-adicionales', exigirFuncion('parametrizacion.servicios_adicionales.listar'), async (req: Request, res: Response) => {
  const incluirBajas = req.query.incluirBajas === '1' || req.query.incluirBajas === 'true';
  res.json(await listarTipos(incluirBajas));
});

router.post('/servicios-adicionales', exigirFuncion('parametrizacion.servicios_adicionales.crear'), async (req: Request, res: Response) => {
  const parsed = servicioAdicionalCrearSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: mensajeDe(parsed.error) }); return; }
  try {
    const tipo = await crearTipo(parsed.data, req.user?.sub ?? null);
    await audit(req, {
      action: 'create', resource: 'flito_servicio_adicional_tipo', resourceId: tipo.id,
      detail: `Tipo «${tipo.nombre}» creado con valor ${tipo.valor}`,
    });
    res.status(201).json(tipo);
  } catch (e) { servicioAdicionalFallo(res, e); }
});

router.patch('/servicios-adicionales/:id', exigirFuncion('parametrizacion.servicios_adicionales.editar'), async (req: Request, res: Response) => {
  const parsed = servicioAdicionalEditarSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: mensajeDe(parsed.error) }); return; }
  const id = idUuid(req.params.id);
  if (id === null) { res.status(404).json({ error: 'El tipo de servicio adicional no existe o ya está dado de baja' }); return; }
  try {
    const tipo = await editarTipo(id, parsed.data, req.user?.sub ?? null);
    await audit(req, {
      action: 'update', resource: 'flito_servicio_adicional_tipo', resourceId: tipo.id,
      detail: `Tipo «${tipo.nombre}» editado (${Object.keys(parsed.data).join(', ')}); valor ${tipo.valor}`,
    });
    res.json(tipo);
  } catch (e) { servicioAdicionalFallo(res, e); }
});

// Baja LÓGICA (RN-01 del servicio): `update`, no `delete`, en la auditoría — no se amplía `AuditAction`.
router.post('/servicios-adicionales/:id/baja', exigirFuncion('parametrizacion.servicios_adicionales.dar_de_baja'), async (req: Request, res: Response) => {
  const id = idUuid(req.params.id);
  if (id === null) { res.status(404).json({ error: 'El tipo de servicio adicional no existe o ya está dado de baja' }); return; }
  try {
    const tipo = await darDeBajaTipo(id, req.user?.sub ?? null);
    await audit(req, {
      action: 'update', resource: 'flito_servicio_adicional_tipo', resourceId: tipo.id,
      detail: `Tipo «${tipo.nombre}» dado de baja`,
    });
    res.json(tipo);
  } catch (e) { servicioAdicionalFallo(res, e); }
});

export default router;
