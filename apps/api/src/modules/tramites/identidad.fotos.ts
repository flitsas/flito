// Feature #14097 (HU #14098, #14099) — lectura de las fotos de `tramites_validaciones`.
//
// Esas columnas `text` conviven con varios formatos de épocas distintas (clave de MinIO, cifrado
// nuevo, cifrado viejo, base64 sin cifrar). Este archivo es la única definición de cuál es cuál: la
// usan la ruta, el backfill a S3 y el script de recifrado, para que no discrepen.
//
// Regla que motiva el módulo: un valor que PARECE cifrado y no descifra es un error, no legado.
// Devolverlo tal cual hacía que una llave equivocada respondiera 200 con el cifrado dentro.
//
// HU #14273: el cifrado viejo ya no se descifra. Se sigue reconociendo porque, sin la clase `viejo`, un
// valor de un dump restaurado caería en `desconocido` y se devolvería como dato.

import { getPhoto } from '../../services/storage.js';
import { loggerFor } from '../../shared/logger.js';
import { piiDecryptFailuresTotal, piiLegacyPlaintextTotal } from '../../shared/metrics.js';
import {
  decryptPiiText,
  PII_BIOMETRICO_VIEJO_PREFIJO,
  PII_TEXT_PREFIJO,
  PiiDecryptError,
} from '../../shared/utils/crypto.js';

const log = loggerFor('tramites-identidad-fotos');

export const TABLA_FOTOS = 'tramites_validaciones';

export type ColumnaFoto = 'foto_rostro' | 'foto_cedula_frontal' | 'foto_cedula_reverso';

export type ClaseFoto =
  | 'vacio'
  | 'storage_key'
  | 'nuevo'
  | 'viejo'
  | 'data_uri'
  | 'base64_plano'
  | 'desconocido';

const BASE64_ALFABETO = /^[A-Za-z0-9+/=]+$/;

/** Primer acierto gana: el orden es parte del contrato. No descifra ni registra nada. */
export function clasificarFoto(valor: string | null | undefined): ClaseFoto {
  if (!valor) return 'vacio';
  if (valor.startsWith('validaciones/')) return 'storage_key';
  if (PII_TEXT_PREFIJO.test(valor)) return 'nuevo';
  if (PII_BIOMETRICO_VIEJO_PREFIJO.test(valor)) return 'viejo';
  if (valor.startsWith('data:image/')) return 'data_uri';
  if (valor.length > 100 && BASE64_ALFABETO.test(valor.slice(0, 200))) return 'base64_plano';
  return 'desconocido';
}

/**
 * Devuelve la foto lista para mostrar, o null si no hay.
 *
 * @throws {PiiDecryptError} si el valor tiene formato cifrado y no descifra, o tiene la forma del
 * formato viejo, que ya nunca descifra. La métrica se incrementa
 * aquí y no en quien captura el error, para que cuente aunque la ruta lo maneje por su cuenta.
 */
export async function resolverFotoBiometrica(
  valor: string | null | undefined,
  { column, id }: { column: ColumnaFoto; id: number },
): Promise<string | null> {
  const clase = clasificarFoto(valor);
  const ctx = { table: TABLA_FOTOS, column, id };

  switch (clase) {
    case 'vacio':
      return null;
    case 'storage_key':
      try { return await getPhoto(valor as string); } catch { return null; }
    case 'nuevo':
      try {
        return decryptPiiText(valor as string, ctx);
      } catch (e) {
        if (e instanceof PiiDecryptError) piiDecryptFailuresTotal.inc({ table: TABLA_FOTOS, column });
        throw e;
      }
    case 'viejo':
      piiDecryptFailuresTotal.inc({ table: TABLA_FOTOS, column });
      throw new PiiDecryptError(ctx);
    default:
      piiLegacyPlaintextTotal.inc({ table: TABLA_FOTOS, column });
      log.warn({ table: TABLA_FOTOS, column, id, clase }, 'foto sin formato cifrado: se devuelve tal cual');
      return valor as string;
  }
}
