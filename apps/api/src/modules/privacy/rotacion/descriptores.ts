// Feature #13978, HU #13987 (ADR-0034 D3) — una entrada por columna cifrada. El motor (`motor.ts`) no sabe
// de formatos: lee filas, las descifra, las vuelve a cifrar con la versión vigente y las escribe con guarda.
//
// RN-RO1  Solo se recifra lo que descifró autenticado. Un valor en claro no entra en ningún descriptor.
// RN-RO2  Se conserva `aad_nonce`, y la AAD la construye el módulo dueño de la columna: no se copia aquí.
// RN-RO3  Byte exacto: bundle, jsonb y serializado pasan por `decryptPiiBuffer`/`encryptPiiBuffer`.
// RN-RO4  Guarda de concurrencia en cada UPDATE: iv y versión leídos, o el valor completo en las columnas
//         de texto. Si la API escribió o anonimizó mientras tanto, no se pisa nada.
// RN-RO5  Las clases `viejo`, `data_uri`, `base64_plano` y `desconocido` de biometría no se tocan: las
//         resuelve el script de #14097. Aquí solo se cuentan.

import { and, asc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { db } from '../../../db/client.js';
import {
  driverProfile, flitoLogisticaActaFirmas, flitoLogisticaRecogidaFirmantes, laftCounterparties, manifiestos, tramitesValidaciones,
} from '../../../db/schema.js';
import {
  decryptPiiBuffer, decryptPiiText, encryptPiiBuffer, encryptPiiText, PII_TEXT_PREFIJO, type AadPii,
} from '../../../shared/utils/crypto.js';
import type { ColumnaCifrada, ColumnaAadConductor } from '../../../shared/utils/pii-columnas.js';
import { aadConductor } from '../../drivers/drivers.aad.js';
import { aadDocumento, parsearDocumento, serializarDocumento } from '../../flito-logistica/flito-logistica.cifrado.js';
import {
  aadCounterparty, bundleToJsonb, jsonbToBundle, type CounterpartyEncColumn, type EncBundleJsonb,
} from '../../laft/employees/counterparty-pii.js';
import { aadTitularPago } from '../../rndc/manifiestos.aad.js';
import { clasificarFoto, TABLA_FOTOS, type ClaseFoto, type ColumnaFoto } from '../../tramites/identidad.fotos.js';
import { lecturaPorClave } from './lectura.js';
import { descriptorObjetosBolsas } from './objetos-bolsas.js';
import type { Descriptor, IdFila } from './tipos.js';

export const LOTE_FILAS = 200;
/** Una sola fila de fotos puede traer varios MB. */
export const LOTE_FOTOS = 50;
const LOTE_CLASIFICACION = 1000;
/** Basta para clasificar una foto sin traerla: `clasificarFoto` no mira más allá de 200 caracteres. */
const LARGO_CLASIFICACION = 201;
/** `v<versión hasta 5 dígitos>:<24>:<32>:`. */
const LARGO_PREFIJO_TEXTO = 70;

// ── Bundle bytea ───────────────────────────────────────────────────────────────────────────────────

interface CeldaBundle {
  cipher: Buffer | null; iv: Buffer | null; authTag: Buffer | null; aadNonce: string | null; keyVersion: number | null;
}

interface DefBundle {
  id: ColumnaCifrada;
  tabla: PgTable;
  pk: AnyPgColumn;
  /** Prefijo de las propiedades Drizzle, p. ej. `cedula` en `cedulaCipher`. */
  prop: string;
  columnas: { cipher: AnyPgColumn; iv: AnyPgColumn; authTag: AnyPgColumn; aadNonce: AnyPgColumn; keyVersion: AnyPgColumn };
  /** Columna extra que la AAD usa como clave de fila; por defecto, la clave primaria. */
  claveAad?: AnyPgColumn;
  aad(rowKey: string, aadNonce: string): AadPii;
}

function descriptorBundle(def: DefBundle): Descriptor<CeldaBundle> {
  const { cipher, iv, authTag, aadNonce, keyVersion } = def.columnas;
  return {
    ...lecturaPorClave<CeldaBundle>({
      id: def.id,
      lote: LOTE_FILAS,
      tabla: def.tabla,
      pk: def.pk,
      seleccion: { id: def.pk, claveAad: def.claveAad ?? def.pk, cipher, iv, authTag, aadNonce, keyVersion },
      fila: (r) => ({
        id: r.id as IdFila,
        rowKey: String(r.claveAad),
        celda: {
          cipher: r.cipher as Buffer | null, iv: r.iv as Buffer | null, authTag: r.authTag as Buffer | null,
          aadNonce: r.aadNonce as string | null, keyVersion: r.keyVersion as number | null,
        },
      }),
      hayDato: isNotNull(cipher),
      // `key_version` NULL se lee como 1 en las rutas.
      enOtraVersion: (version) => sql`coalesce(${keyVersion}, 1) <> ${version}`,
    }),
    version: ({ celda }) => celda.keyVersion ?? 1,
    descifrar: ({ rowKey, celda }) => {
      if (!celda.cipher || !celda.iv || !celda.authTag || !celda.aadNonce) throw new Error('paquete incompleto');
      return decryptPiiBuffer(
        { cipher: celda.cipher, iv: celda.iv, authTag: celda.authTag, keyVersion: celda.keyVersion ?? 1 },
        def.aad(rowKey, celda.aadNonce),
      );
    },
    cifrar: (plano, { rowKey, celda }) => {
      const b = encryptPiiBuffer(plano, def.aad(rowKey, celda.aadNonce as string));
      return { cipher: b.cipher, iv: b.iv, authTag: b.authTag, aadNonce: celda.aadNonce, keyVersion: b.keyVersion };
    },
    escribir: async ({ id, celda }, valor) => {
      const filas = await db.update(def.tabla)
        .set({
          [`${def.prop}Cipher`]: valor.cipher,
          [`${def.prop}Iv`]: valor.iv,
          [`${def.prop}AuthTag`]: valor.authTag,
          [`${def.prop}KeyVersion`]: valor.keyVersion,
        } as never)
        .where(and(
          eq(def.pk, id),
          eq(iv, celda.iv as Buffer),
          celda.keyVersion === null ? isNull(keyVersion) : eq(keyVersion, celda.keyVersion),
        ))
        .returning({ id: def.pk });
      return filas.length > 0;
    },
  };
}

function bundleConductor(columna: ColumnaAadConductor, prop: 'cedula' | 'licenciaNumero' | 'runtPayload'): Descriptor<CeldaBundle> {
  const t = driverProfile;
  return descriptorBundle({
    id: `driver_profile.${columna}`,
    tabla: t,
    pk: t.userId,
    prop,
    columnas: {
      cipher: t[`${prop}Cipher`], iv: t[`${prop}Iv`], authTag: t[`${prop}AuthTag`], aadNonce: t[`${prop}AadNonce`], keyVersion: t[`${prop}KeyVersion`],
    },
    aad: (rowKey, aadNonce) => aadConductor(columna, rowKey, aadNonce),
  });
}

// ── Jsonb de LAFT ──────────────────────────────────────────────────────────────────────────────────

function descriptorContraparte(
  id: ColumnaCifrada,
  columna: CounterpartyEncColumn,
  prop: 'docNumberEnc' | 'emailEnc' | 'phoneEnc',
): Descriptor<EncBundleJsonb> {
  const t = laftCounterparties;
  const col = t[prop];
  return {
    ...lecturaPorClave<EncBundleJsonb>({
      id,
      lote: LOTE_FILAS,
      tabla: t,
      pk: t.id,
      seleccion: { id: t.id, enc: col },
      fila: (r) => ({ id: r.id as number, rowKey: String(r.id), celda: r.enc as EncBundleJsonb }),
      hayDato: isNotNull(col),
      enOtraVersion: (version) => sql`${col}->>'keyVersion' IS DISTINCT FROM ${String(version)}`,
    }),
    version: ({ celda }) => celda.keyVersion,
    descifrar: ({ id, celda }) => decryptPiiBuffer(jsonbToBundle(celda), aadCounterparty(columna, id as number, celda.aadNonce)),
    cifrar: (plano, { id, celda }) => bundleToJsonb(encryptPiiBuffer(plano, aadCounterparty(columna, id as number, celda.aadNonce)), celda.aadNonce),
    escribir: async ({ id, celda }, valor) => {
      const filas = await db.update(t).set({ [prop]: valor })
        .where(and(
          eq(t.id, id as number),
          sql`${col}->>'iv' = ${celda.iv}`,
          sql`${col}->>'keyVersion' = ${String(celda.keyVersion)}`,
        ))
        .returning({ id: t.id });
      return filas.length > 0;
    },
  };
}

// ── Texto `v1:<ver>:<nonce>:<iv>:<tag>:<cipher>` de logística ──────────────────────────────────────

function descriptorDocumento(
  id: ColumnaCifrada,
  t: typeof flitoLogisticaActaFirmas | typeof flitoLogisticaRecogidaFirmantes,
): Descriptor<string> {
  const col = t.documentoCifrado;
  const guardar = async (filaId: IdFila, leido: string, valor: string) => {
    const filas = await db.update(t as PgTable).set({ documentoCifrado: valor } as never)
      .where(and(eq(t.id, filaId as string), eq(col, leido)))
      .returning({ id: t.id });
    return filas.length > 0;
  };
  return {
    ...lecturaPorClave<string>({
      id,
      lote: LOTE_FILAS,
      tabla: t,
      pk: t.id,
      seleccion: { id: t.id, cifrado: col },
      fila: (r) => ({ id: r.id as string, rowKey: String(r.id), celda: r.cifrado as string }),
      hayDato: isNotNull(col),
      // El `v1` inicial es la versión del formato; la de la llave es el segundo campo.
      enOtraVersion: (version) => sql`split_part(${col}, ':', 2) <> ${String(version)}`,
    }),
    version: ({ celda }) => parsearDocumento(celda).bundle.keyVersion,
    descifrar: ({ rowKey, celda }) => {
      const { bundle, aadNonce } = parsearDocumento(celda);
      return decryptPiiBuffer(bundle, aadDocumento(rowKey, aadNonce));
    },
    cifrar: (plano, { rowKey, celda }) => {
      const { aadNonce } = parsearDocumento(celda);
      return serializarDocumento(encryptPiiBuffer(plano, aadDocumento(rowKey, aadNonce)), aadNonce);
    },
    escribir: ({ id, celda }, valor) => guardar(id, celda, valor),
  };
}

// ── Texto `v<ver>:<iv>:<tag>:<b64>` de biometría ───────────────────────────────────────────────────

/** Clases de foto que no dependen del formato vigente y que este script no toca (RN-RO5). */
const CLASES_LEGADO: readonly ClaseFoto[] = ['viejo', 'data_uri', 'base64_plano', 'desconocido'];

function descriptorFoto(columna: ColumnaFoto, prop: 'fotoRostro' | 'fotoCedulaFrontal' | 'fotoCedulaReverso'): Descriptor<string> {
  const t = tramitesValidaciones;
  const col = t[prop];
  const ctx = (id: IdFila) => ({ table: TABLA_FOTOS, column: columna, id }) as const;
  const prefijo = sql`left(${col}, ${LARGO_PREFIJO_TEXTO})`;
  return {
    ...lecturaPorClave<string>({
      id: `tramites_validaciones.${columna}`,
      lote: LOTE_FOTOS,
      tabla: t,
      pk: t.id,
      seleccion: { id: t.id, valor: col },
      fila: (r) => ({ id: r.id as number, rowKey: String(r.id), celda: r.valor as string }),
      hayDato: sql`${prefijo} ~ ${PII_TEXT_PREFIJO.source}`,
      enOtraVersion: (version) => sql`substring(${prefijo} from ${'^v([0-9]+):'}) <> ${String(version)}`,
    }),
    version: ({ celda }) => Number(PII_TEXT_PREFIJO.exec(celda)?.[1]),
    descifrar: ({ id, celda }) => Buffer.from(decryptPiiText(celda, ctx(id)), 'utf8'),
    cifrar: (plano, { id }) => encryptPiiText(plano.toString('utf8'), ctx(id)),
    escribir: async ({ id, celda }, valor) => {
      const filas = await db.update(t).set({ [prop]: valor })
        .where(and(eq(t.id, id as number), eq(col, celda)))
        .returning({ id: t.id });
      return filas.length > 0;
    },
    legado: async () => {
      const conteo = { bloquean: 0, desconocido: 0 };
      let despuesDe = 0;
      for (;;) {
        // Trae solo el inicio de cada foto: alcanza para clasificarla y evita bajar varios MB por fila.
        const lote = await db.select({ id: t.id, inicio: sql<string>`left(${col}, ${LARGO_CLASIFICACION})` }).from(t)
          .where(and(isNotNull(col), gt(t.id, despuesDe)))
          .orderBy(asc(t.id))
          .limit(LOTE_CLASIFICACION);
        if (lote.length === 0) return conteo;
        for (const { inicio } of lote) {
          const clase = clasificarFoto(inicio);
          if (!CLASES_LEGADO.includes(clase)) continue;
          if (clase === 'desconocido') conteo.desconocido += 1;
          else conteo.bloquean += 1;
        }
        despuesDe = lote[lote.length - 1].id;
      }
    },
  };
}

// ── Catálogo ───────────────────────────────────────────────────────────────────────────────────────

const m = manifiestos;

export const DESCRIPTORES = {
  'driver_profile.cedula': bundleConductor('cedula', 'cedula'),
  'driver_profile.licencia_numero': bundleConductor('licencia_numero', 'licenciaNumero'),
  'driver_profile.runt_payload': bundleConductor('runt_payload', 'runtPayload'),
  'manifiestos.titular_pago_cuenta': descriptorBundle({
    id: 'manifiestos.titular_pago_cuenta',
    tabla: m,
    pk: m.id,
    prop: 'titularPagoCuenta',
    columnas: {
      cipher: m.titularPagoCuentaCipher, iv: m.titularPagoCuentaIv, authTag: m.titularPagoCuentaAuthTag,
      aadNonce: m.titularPagoCuentaAadNonce, keyVersion: m.titularPagoCuentaKeyVersion,
    },
    // La clave de fila de la AAD es `numero`, no `id`. Viaja solo en `rowKey`: nunca a la salida.
    claveAad: m.numero,
    aad: aadTitularPago,
  }),
  'laft_counterparties.doc_number_enc': descriptorContraparte('laft_counterparties.doc_number_enc', 'doc_number', 'docNumberEnc'),
  'laft_counterparties.email_enc': descriptorContraparte('laft_counterparties.email_enc', 'email', 'emailEnc'),
  'laft_counterparties.phone_enc': descriptorContraparte('laft_counterparties.phone_enc', 'phone', 'phoneEnc'),
  'flito_logistica_acta_firmas.documento_cifrado': descriptorDocumento('flito_logistica_acta_firmas.documento_cifrado', flitoLogisticaActaFirmas),
  'flito_logistica_recogida_firmantes.documento_cifrado': descriptorDocumento('flito_logistica_recogida_firmantes.documento_cifrado', flitoLogisticaRecogidaFirmantes),
  'flito_bolsas_documentos.archivo': descriptorObjetosBolsas,
  'tramites_validaciones.foto_rostro': descriptorFoto('foto_rostro', 'fotoRostro'),
  'tramites_validaciones.foto_cedula_frontal': descriptorFoto('foto_cedula_frontal', 'fotoCedulaFrontal'),
  'tramites_validaciones.foto_cedula_reverso': descriptorFoto('foto_cedula_reverso', 'fotoCedulaReverso'),
} satisfies Record<ColumnaCifrada, Descriptor<unknown>>;
