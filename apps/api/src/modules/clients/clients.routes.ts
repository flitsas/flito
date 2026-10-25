import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import {
  PERSONA_TIPOS,
  SIIGO_ID_TIPOS_CODIGOS,
  SIIGO_ID_TIPO_PERSONA_IMPLICITA,
  RESPONSABILIDADES_FISCALES_CODIGOS,
  DOCUMENT_TYPE_A_PERSONA_TIPO,
  DOCUMENT_TYPE_A_SIIGO,
  SUCURSAL_MINIMA,
  SUCURSAL_MAXIMA,
  type PersonaTipo,
  type SiigoIdTipo,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { clients, flitoProveedoresSoat } from '../../db/schema.js';
import { authMiddleware, invalidateSessionCacheFor } from '../../shared/middleware/auth.js';
import { exigirFuncion, tieneFuncion } from '../../shared/middleware/exigir-funcion.js';
import { audit } from '../../shared/middleware/audit.js';
import { maskName } from '../../shared/utils/pii.js';
import {
  COLUMNAS_LISTADO, COLUMNAS_LISTADO_CON_GESTOR, clienteListadoDto, registrarAccesoListado,
} from './clients.pii.js';
import {
  ClienteDuplicadoError, ClienteNoEncontradoError, EstadoClienteCambiadoError, cambiarEstadoCliente,
  esDuplicadoNitSucursal, exigirNitSucursalLibre, impactoCliente, nombreEnmascarado,
} from './clients.service.js';

const router = Router();
router.use(authMiddleware);

/**
 * El documento se guarda NORMALIZADO, no solo se compara normalizado.
 *
 * Sin esto la tabla acumula `' 900789123'` y `'900789123'` como clientes distintos: la unicidad de
 * aquí los ve iguales y devuelve 409, pero `crearEmpresaDesdeTramite` compara con igualdad exacta e
 * inserta el duplicado igual. Peor todavía, `companiaPorNit` tampoco encontraría el que tiene el
 * espacio, dejando sus trámites sin compañía. Normalizar al escribir hace que los tres criterios
 * que hoy conviven en el repo signifiquen lo mismo.
 */
const documentoNormalizado = z.string().max(20).transform((s) => s.trim().toUpperCase());

const createSchema = z.object({
  name: z.string().min(1).max(200),
  document: documentoNormalizado.optional(),
  documentType: z.string().max(5).optional(),
  phone: z.string().max(20).optional(),
  email: z.string().email().optional(),
  address: z.string().max(300).optional(),
  city: z.string().max(100).optional(),
  notes: z.string().optional(),

  // ── Datos fiscales para Siigo (HU #11292) ────────────────────────────────
  //
  // A diferencia de `documentType` —cadena libre de hasta 5 caracteres que no se puede cerrar sin
  // romper filas existentes—, todo lo de aquí es enumeración cerrada desde el primer día. Un
  // `id_type` inventado no se descubre al guardarlo: se descubre cuando Siigo rechaza una factura.
  //
  // `.nullable()` en todos: la pantalla necesita poder BORRAR un dato fiscal mal capturado, y con
  // solo `.optional()` un campo omitido es indistinguible de uno que se quiere vaciar.
  personType: z.enum(PERSONA_TIPOS).nullable().optional(),
  idType: z.enum(SIIGO_ID_TIPOS_CODIGOS as [string, ...string[]]).nullable().optional(),
  checkDigit: z.number().int().min(0).max(9).nullable().optional(),
  fiscalResponsibilities: z.array(z.enum(RESPONSABILIDADES_FISCALES_CODIGOS as [string, ...string[]]))
    .max(RESPONSABILIDADES_FISCALES_CODIGOS.length).optional(),
  // Con patrón, no solo con longitud. Los tres acaban en `audit_logs.detail`, que es append-only
  // por REVOKE y que ningún cron purga: un `cityCode` usado como campo libre —un celular, un
  // nombre— sería PII imborrable en la única tabla de la que este módulo la mantiene fuera.
  countryCode: z.string().regex(/^[A-Za-z]{2}$/, 'Dos letras, como Co').nullable().optional(),
  stateCode: z.string().regex(/^[0-9]{1,5}$/, 'Solo dígitos').nullable().optional(),
  cityCode: z.string().regex(/^[0-9]{1,10}$/, 'Solo dígitos').nullable().optional(),
  commercialName: z.string().max(200).nullable().optional(),
  branchOffice: z.number().int().min(SUCURSAL_MINIMA).max(SUCURSAL_MAXIMA).optional(),
  contactFirstName: z.string().max(100).nullable().optional(),
  contactLastName: z.string().max(100).nullable().optional(),
  contactEmail: z.string().email().max(150).nullable().optional(),
  // Siigo los quiere numéricos y de 10 como máximo. El mismo CHECK está en la 0132.
  phoneIndicative: z.string().regex(/^[0-9]{1,10}$/, 'Solo dígitos, máximo 10').nullable().optional(),
  phoneNumber: z.string().regex(/^[0-9]{1,10}$/, 'Solo dígitos, máximo 10').nullable().optional(),
});

/**
 * Combinaciones fiscales imposibles (AC4 mirado de frente).
 *
 * Los CHECK son por columna, así que cada campo por separado puede ser válido y el conjunto ser
 * mentira. El caso real: un cliente migrado como NIT resulta ser una persona natural y alguien
 * corrige lo único que ve en pantalla, `documentType: 'CC'`. La fila queda con `idType` 31 (NIT) y
 * `personType` Company sobre un número de cédula, y la factura sale ante la DIAN con el tipo de
 * identificación equivocado — justo lo que la regla «no adivinar» de la migración evitaba, entrando
 * por la puerta de al lado.
 *
 * Se evalúa sobre el estado RESULTANTE, no sobre el cuerpo de la petición: un PATCH parcial es
 * precisamente cómo se llega a la incoherencia.
 */
export function incoherenciasFiscales(fila: {
  documentType?: string | null;
  personType?: string | null;
  idType?: string | null;
}): string[] {
  const problemas: string[] = [];
  const doc = fila.documentType ? fila.documentType.trim().toUpperCase() : null;
  const persona = (fila.personType ?? null) as PersonaTipo | null;
  const id = (fila.idType ?? null) as SiigoIdTipo | null;

  const personaEsperada = doc ? DOCUMENT_TYPE_A_PERSONA_TIPO[doc] : undefined;
  if (personaEsperada && persona && persona !== personaEsperada) {
    problemas.push(
      `El tipo de documento ${doc} corresponde a ${personaEsperada} y el tipo de persona dice ${persona}.`,
    );
  }

  const idEsperado = doc ? DOCUMENT_TYPE_A_SIIGO[doc] : undefined;
  if (idEsperado && id && id !== idEsperado) {
    problemas.push(
      `El tipo de documento ${doc} corresponde al tipo de identificación ${idEsperado} de Siigo y dice ${id}.`,
    );
  }

  const personaImplicita = id ? SIIGO_ID_TIPO_PERSONA_IMPLICITA[id] : undefined;
  if (personaImplicita && persona && persona !== personaImplicita) {
    problemas.push(
      `El tipo de identificación ${id} solo puede ser ${personaImplicita} y el tipo de persona dice ${persona}.`,
    );
  }
  return problemas;
}

// Lectura alineada con la del módulo fusionado (HU #10979): antes bastaba con estar autenticado,
// mientras que su gemelo `GET /flito/parametrizacion/companias` —la misma tabla— exigía rol. Dos
// puertas distintas a los mismos datos no es una decisión, es un descuido.
// HU #13422 (ADR-0023): la lectura la decide `clients.clientes.ver` (sembrada a admin, auditor y
// financiera, la lista que exigía el rol). HU #13428 (diseño §5-ter.1 punto 2): el transitorio
// `clients.clientes.administrar` se parte por GRUPO DE CAMPOS del cuerpo — crear (`POST /`), editar los
// datos generales (`PATCH /:id [editar]`) y los datos fiscales (`[fiscal]`, cualquier clave de
// `CAMPOS_FISCALES`). Un PATCH solo con claves fiscales exige únicamente `datos_fiscales`; un POST con
// claves fiscales exige `crear` Y `datos_fiscales`. Se decide ANTES de validar el cuerpo (403 antes que 400).

/**
 * Campos fiscales que se pueden escribir en la auditoría tal cual.
 *
 * Son códigos de catálogo, no datos personales. Los de contacto —nombres, apellidos, correo,
 * teléfono— quedan fuera a propósito: dejar un correo en `audit_logs` es meter PII en una tabla que
 * nadie purga (Ley 1581). De esos se registra QUÉ cambió, no a qué valor.
 */
const CAMPOS_FISCALES_TRAZABLES = [
  'personType', 'idType', 'checkDigit', 'fiscalResponsibilities',
  'countryCode', 'stateCode', 'cityCode', 'branchOffice',
] as const;

const CAMPOS_FISCALES_PII = [
  'commercialName', 'contactFirstName', 'contactLastName', 'contactEmail',
  'phoneIndicative', 'phoneNumber',
] as const;

/** Las claves fiscales del cuerpo (las de `createSchema` del bloque «Datos fiscales para Siigo»). */
const CAMPOS_FISCALES: ReadonlySet<string> = new Set([...CAMPOS_FISCALES_TRAZABLES, ...CAMPOS_FISCALES_PII]);

const clavesDe = (body: unknown): string[] => (body && typeof body === 'object' ? Object.keys(body) : []);

/** `[fiscal]`: un solo `tieneFuncion` literal para POST y PATCH (el intento denegado queda en la bitácora). */
function puedeDatosFiscales(req: Request): Promise<boolean> {
  return tieneFuncion(req, 'clients.clientes.datos_fiscales');
}

function comoTexto(v: unknown): string {
  if (v === null || v === undefined || v === '') return '∅';
  return Array.isArray(v) ? (v.length === 0 ? '∅' : v.join('+')) : String(v);
}

/**
 * Resumen «antes → después» de los datos fiscales para la auditoría (AC7).
 *
 * Devuelve cadena vacía si no cambió ninguno, para no ensuciar la auditoría de las ediciones
 * normales de un cliente con ruido de facturación.
 */
function diffFiscal(antes: Record<string, unknown>, despues: Record<string, unknown>): string {
  const partes: string[] = [];
  for (const campo of CAMPOS_FISCALES_TRAZABLES) {
    const a = comoTexto(antes[campo]);
    const d = comoTexto(despues[campo]);
    if (a !== d) partes.push(`${campo}: ${a} → ${d}`);
  }
  for (const campo of CAMPOS_FISCALES_PII) {
    if (comoTexto(antes[campo]) !== comoTexto(despues[campo])) partes.push(`${campo}: modificado`);
  }
  return partes.join(' · ');
}

/**
 * En Siigo la identidad de un tercero es la pareja (identificación, sucursal): el mismo número solo
 * puede repetirse si la sucursal es distinta. La regla (RN-CLI-7, HU #13952) vive en el servicio
 * (`exigirNitSucursalLibre` + índice único parcial de la 0257); aquí solo se traduce a HTTP.
 */
function responderDuplicado(res: Response, e: ClienteDuplicadoError): void {
  res.status(409).json({ error: e.message, campo: 'document' });
}

/**
 * El padrón de clientes, por tramos (HU #11299, AC8).
 *
 * Dos cosas que antes no estaban y que van juntas:
 *
 *   · **Proyección explícita.** Era un `db.select()` desnudo: la fila COMPLETA de hasta 500
 *     clientes, incluidas columnas que ninguna pantalla lee y las que se añadan mañana a la tabla.
 *     Qué entrega ahora —y contra qué consumidores se midió— está en `clients.pii.ts`.
 *   · **Rastro de la lectura.** Es la lectura de datos personales más grande de la aplicación y no
 *     dejaba una línea en `pii_access_log` (Ley 1581 art. 17, AGENTS.md §16).
 *
 * El registro va DESPUÉS de la consulta y con `await`: `filas` no se sabe antes, y `logPiiAccess`
 * es best-effort —nunca tumba la operación—, así que esperar cuesta una inserción y garantiza que
 * el rastro está escrito antes de que la respuesta salga.
 *
 * ── El gestor por defecto, resuelto en la misma consulta (HU #12079) ────────────────────────────
 *
 * `LEFT JOIN`, nunca `INNER`: el gestor es opcional —solo las compañías con el canal «SOAT sin
 * trámite» abierto tienen uno— y con una unión interna el padrón perdería a casi todos sus clientes.
 * Es la misma unión de una sola fila por cliente (la clave primaria del proveedor), así que no
 * multiplica filas ni cambia el tramo que `limit`/`offset` entregan.
 *
 * El porqué de sacarlo por esta ruta y no por parametrización está en `clients.pii.ts`, junto a la
 * proyección: `financiera` ve esta pantalla y no aquella.
 */
router.get('/', exigirFuncion('clients.clientes.ver'), async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
  const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
  const result = await db.select(COLUMNAS_LISTADO_CON_GESTOR).from(clients)
    .leftJoin(flitoProveedoresSoat, eq(flitoProveedoresSoat.id, clients.flitoProveedorSoatSinTramiteId))
    .orderBy(clients.name).limit(limit).offset(offset);
  await registrarAccesoListado(req, { filas: result.length, limit, offset });
  res.json(result.map(clienteListadoDto));
});

router.post('/', exigirFuncion('clients.clientes.crear'), async (req: Request, res: Response) => {
  if (clavesDe(req.body).some((k) => CAMPOS_FISCALES.has(k)) && !(await puedeDatosFiscales(req))) {
    res.status(403).json({ error: 'Sin permisos' });
    return;
  }
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }

  const datos = parsed.data;
  const problemas = incoherenciasFiscales(datos);
  if (problemas.length > 0) {
    res.status(400).json({ error: 'Datos fiscales incoherentes', details: problemas });
    return;
  }

  const sucursalAlta = datos.branchOffice ?? 0;
  try {
    await exigirNitSucursalLibre(datos.document, sucursalAlta);
  } catch (e) {
    if (e instanceof ClienteDuplicadoError) { responderDuplicado(res, e); return; }
    throw e;
  }

  // `personTypeOrigen` no está en el schema —no es escribible desde fuera— pero sí se deriva de la
  // petición: quien crea un cliente declarando su tipo de persona lo está clasificando a mano, y la
  // migración 0132 solo respeta lo humano si está marcado como tal.
  // `.returning(COLUMNAS_LISTADO)` y no `.returning()` a secas (HU #12078): la fila ENTERA sacaba a
  // HTTP toda columna que se le añadiera a `clients` sin que nadie lo decidiera —el mismo patrón que
  // mordió en la HU #12093—, y la que acaba de nacer (`flito_proveedor_soat_sin_tramite_id`) ni
  // siquiera es escribible por esta ruta: `createSchema` no la acepta. Se proyecta la MISMA lista que
  // entrega `GET /clients`, que es la unión medida de lo que leen los cinco consumidores, para que
  // las tres respuestas del módulo digan lo mismo y la próxima columna tampoco salga sola.
  let client;
  try {
    [client] = await db.insert(clients)
      .values({ ...datos, ...(datos.personType ? { personTypeOrigen: 'manual' as const } : {}) })
      .returning(COLUMNAS_LISTADO);
  } catch (e) {
    // AC6: otra alta ganó la carrera entre la validación y el INSERT → el mismo 409, nunca 500.
    if (esDuplicadoNitSucursal(e)) { responderDuplicado(res, new ClienteDuplicadoError(datos.document!.trim(), sucursalAlta)); return; }
    throw e;
  }
  await audit(req, {
    action: 'create',
    resource: 'client',
    resourceId: String(client.id),
    detail: `Cliente: ${maskName(client.name)}`,
  });
  res.status(201).json(client);
});

router.patch('/:id', async (req: Request, res: Response) => {
  const claves = clavesDe(req.body);
  const fiscales = claves.some((k) => CAMPOS_FISCALES.has(k));
  // Sin claves fiscales (también el cuerpo vacío) es una edición general: exige `editar`.
  const generales = !fiscales || claves.some((k) => !CAMPOS_FISCALES.has(k));
  if ((generales && !(await tieneFuncion(req, 'clients.clientes.editar')))
    || (fiscales && !(await puedeDatosFiscales(req)))) {
    res.status(403).json({ error: 'Sin permisos' });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = createSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }

  // Se lee ANTES de escribir: sin el estado previo no hay «valor anterior» que auditar (AC7), y
  // tampoco se puede saber contra qué sucursal validar cuando el PATCH solo trae uno de los dos.
  const [previo] = await db.select().from(clients).where(eq(clients.id, id)).limit(1);
  if (!previo) { res.status(404).json({ error: 'Cliente no encontrado' }); return; }

  // HU #13945 (AC8): el estado no se cambia por la edición general sino con «Activar o desactivar» (exclusiva del
  // Administrador, `PATCH /:id/estado`). `createSchema` no acepta `active` —se descartaría en silencio—, así que se
  // mira el cuerpo crudo: igual al estado actual se ignora (un formulario que reenvía la fila entera no se rompe);
  // distinto → 400.
  if (req.body && typeof req.body === 'object' && 'active' in req.body && req.body.active !== previo.active) {
    res.status(400).json({ error: 'El estado del cliente se cambia con Activar o Desactivar.' });
    return;
  }

  const cambios = parsed.data;

  // Sobre el estado RESULTANTE: cambiar solo `documentType` es exactamente cómo se llega a un
  // cliente con tipo de identificación de NIT y número de cédula.
  const problemas = incoherenciasFiscales({
    documentType: cambios.documentType ?? previo.documentType,
    personType: cambios.personType ?? previo.personType,
    idType: cambios.idType ?? previo.idType,
  });
  if (problemas.length > 0) {
    res.status(400).json({ error: 'Datos fiscales incoherentes', details: problemas });
    return;
  }

  const documento = cambios.document ?? previo.document;
  const sucursal = cambios.branchOffice ?? previo.branchOffice;
  const tocaIdentidad = cambios.document !== undefined || cambios.branchOffice !== undefined;
  if (tocaIdentidad) {
    try {
      await exigirNitSucursalLibre(documento, sucursal, id);
    } catch (e) {
      if (e instanceof ClienteDuplicadoError) { responderDuplicado(res, e); return; }
      throw e;
    }
  }

  // Igual que en el POST: fijar el tipo de persona a mano lo marca como `manual`, y eso es lo que
  // impide que una reejecución de la migración 0132 lo vuelva a derivar del `document_type`.
  // Proyectado por lo mismo que el POST (HU #12078). `diffFiscal` sigue funcionando: los catorce
  // campos de `CAMPOS_FISCALES_TRAZABLES` y `CAMPOS_FISCALES_PII` están todos en `COLUMNAS_LISTADO`.
  // El `previo` de arriba sí se lee entero, y eso NO es un descuido: no sale por HTTP y `diffFiscal`
  // recorre listas cerradas, así que una columna nueva no puede colarse en el `audit` por ahí.
  let updated;
  try {
    [updated] = await db.update(clients)
      .set({ ...cambios, ...(cambios.personType ? { personTypeOrigen: 'manual' as const } : {}) })
      .where(eq(clients.id, id)).returning(COLUMNAS_LISTADO);
  } catch (e) {
    // AC6: carrera con otra escritura sobre la misma pareja → el mismo 409, nunca 500.
    if (esDuplicadoNitSucursal(e)) {
      responderDuplicado(res, new ClienteDuplicadoError((documento ?? '').trim(), sucursal)); return;
    }
    throw e;
  }
  if (!updated) { res.status(404).json({ error: 'Cliente no encontrado' }); return; }

  // Su gemelo de parametrización sí auditaba; este no. Cambiar los datos de un cliente sin dejar
  // rastro es peor aquí, donde además se editan sus datos de contacto.
  const fiscal = diffFiscal(previo as Record<string, unknown>, updated as Record<string, unknown>);
  await audit(req, {
    action: 'update',
    resource: 'client',
    resourceId: String(id),
    detail: `Cliente actualizado: ${maskName(updated.name)}${fiscal ? ` · Datos fiscales — ${fiscal}` : ''}`,
  });
  res.json(updated);
});

// ── HU #13945: desactivar y activar un cliente, con vista previa de su impacto ─────────────────────────────────
// Las dos rutas exigen `clients.clientes.estado`, que concede «Activar o desactivar clientes», exclusiva del
// Administrador (HU #13944). El impacto usa la misma función y no la de ver clientes: lo consume el modal de
// desactivar, y sus conteos (saldo de la bolsa, procesos abiertos) no son parte de la lectura del padrón.

const idCliente = (req: Request): number | null => {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
};

router.get('/:id/impacto', exigirFuncion('clients.clientes.estado'), async (req: Request, res: Response) => {
  const id = idCliente(req);
  if (id === null) { res.status(400).json({ error: 'ID inválido' }); return; }
  const impacto = await impactoCliente(db, id);
  if (!impacto) { res.status(404).json({ error: 'Cliente no encontrado' }); return; }
  res.json(impacto);
});

const estadoSchema = z.object({ activo: z.boolean(), activoEsperado: z.boolean() }).strict();

router.patch('/:id/estado', exigirFuncion('clients.clientes.estado'), async (req: Request, res: Response, next: NextFunction) => {
  const id = idCliente(req);
  if (id === null) { res.status(400).json({ error: 'ID inválido' }); return; }
  const parsed = estadoSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() }); return; }

  let cambio;
  try {
    cambio = await cambiarEstadoCliente(id, parsed.data);
  } catch (e) {
    if (e instanceof ClienteNoEncontradoError) { res.status(404).json({ error: e.message }); return; }
    if (e instanceof EstadoClienteCambiadoError) { res.status(409).json({ error: e.message }); return; }
    // HU #13946 (AC6): p. ej. falló el arranque de un retenido al activar; la tx ya se revirtió. Al errorHandler (500):
    // un `throw` en un handler async de Express 4 dejaría la petición colgada.
    next(e); return;
  }
  // DESPUÉS del commit (patrón de `users.routes.ts`): la siguiente petición de cada usuario relee la marca.
  for (const userId of cambio.usuariosInvalidados) invalidateSessionCacheFor(userId);

  const verbo = cambio.active ? 'activado' : 'desactivado';
  await audit(req, {
    action: 'update',
    resource: 'client',
    resourceId: String(id),
    detail: `Cliente ${verbo}: ${nombreEnmascarado(cambio.name)}`
      + (cambio.active ? '' : ` · sesiones invalidadas: ${cambio.usuariosInvalidados.length} usuario(s)`),
  });
  res.json({ id: cambio.id, active: cambio.active });
});

export default router;
