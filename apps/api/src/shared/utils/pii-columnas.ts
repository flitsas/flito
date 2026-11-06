// Feature #13978, HU #13987 (ADR-0034 Inventario y D5) — catálogo de lo cifrado con `PII_ENC_KEY`.
//
// Sin dependencias a propósito: lo importan `crypto.ts` (solo el tipo), el script de rotación y la prueba
// de cobertura `__tests__/services/pii-columnas-cobertura.test.ts`, que falla si aparece una columna
// cifrada, o un archivo que cifre, sin declararse aquí.
//
// `aad` es lo que entra en la AAD, y no siempre coincide con la columna real:
//   - LAFT: la columna de la AAD no lleva `_enc`.
//   - Firmantes de recogida: la AAD nombra la tabla `flito_logistica_acta_firmas`.
//   - Bolsas: `archivo` es una columna lógica; el dato vive en un objeto de MinIO.

export type FormaColumnaPii = 'bundle_bytea' | 'jsonb' | 'texto_serializado' | 'texto_versionado' | 'objeto';

const paqueteBytea = (base: string) => [
  `${base}_cipher`, `${base}_iv`, `${base}_auth_tag`, `${base}_aad_nonce`, `${base}_key_version`,
] as const;

export const COLUMNAS_CIFRADAS_PII = [
  { id: 'driver_profile.cedula', tabla: 'driver_profile', forma: 'bundle_bytea', aadTabla: 'driver_profile', aadColumna: 'cedula', fisicas: paqueteBytea('cedula') },
  { id: 'driver_profile.licencia_numero', tabla: 'driver_profile', forma: 'bundle_bytea', aadTabla: 'driver_profile', aadColumna: 'licencia_numero', fisicas: paqueteBytea('licencia_numero') },
  { id: 'driver_profile.runt_payload', tabla: 'driver_profile', forma: 'bundle_bytea', aadTabla: 'driver_profile', aadColumna: 'runt_payload', fisicas: paqueteBytea('runt_payload') },
  { id: 'manifiestos.titular_pago_cuenta', tabla: 'manifiestos', forma: 'bundle_bytea', aadTabla: 'manifiestos', aadColumna: 'titular_pago_cuenta', fisicas: paqueteBytea('titular_pago_cuenta') },
  { id: 'laft_counterparties.doc_number_enc', tabla: 'laft_counterparties', forma: 'jsonb', aadTabla: 'laft_counterparties', aadColumna: 'doc_number', fisicas: ['doc_number_enc'] },
  { id: 'laft_counterparties.email_enc', tabla: 'laft_counterparties', forma: 'jsonb', aadTabla: 'laft_counterparties', aadColumna: 'email', fisicas: ['email_enc'] },
  { id: 'laft_counterparties.phone_enc', tabla: 'laft_counterparties', forma: 'jsonb', aadTabla: 'laft_counterparties', aadColumna: 'phone', fisicas: ['phone_enc'] },
  { id: 'flito_logistica_acta_firmas.documento_cifrado', tabla: 'flito_logistica_acta_firmas', forma: 'texto_serializado', aadTabla: 'flito_logistica_acta_firmas', aadColumna: 'documento_cifrado', fisicas: ['documento_cifrado'] },
  { id: 'flito_logistica_recogida_firmantes.documento_cifrado', tabla: 'flito_logistica_recogida_firmantes', forma: 'texto_serializado', aadTabla: 'flito_logistica_acta_firmas', aadColumna: 'documento_cifrado', fisicas: ['documento_cifrado'] },
  { id: 'flito_bolsas_documentos.archivo', tabla: 'flito_bolsas_documentos', forma: 'objeto', aadTabla: 'flito_bolsas_documentos', aadColumna: 'archivo', fisicas: ['cifrado_iv', 'cifrado_tag', 'cifrado_key_version', 'aad_nonce', 'storage_key', 'storage_key_previa'] },
  { id: 'tramites_validaciones.foto_rostro', tabla: 'tramites_validaciones', forma: 'texto_versionado', aadTabla: 'tramites_validaciones', aadColumna: 'foto_rostro', fisicas: ['foto_rostro'] },
  { id: 'tramites_validaciones.foto_cedula_frontal', tabla: 'tramites_validaciones', forma: 'texto_versionado', aadTabla: 'tramites_validaciones', aadColumna: 'foto_cedula_frontal', fisicas: ['foto_cedula_frontal'] },
  { id: 'tramites_validaciones.foto_cedula_reverso', tabla: 'tramites_validaciones', forma: 'texto_versionado', aadTabla: 'tramites_validaciones', aadColumna: 'foto_cedula_reverso', fisicas: ['foto_cedula_reverso'] },
] as const;

type EntradaCatalogo = (typeof COLUMNAS_CIFRADAS_PII)[number];

export type ColumnaCifrada = EntradaCatalogo['id'];

type TablaAad = EntradaCatalogo['aadTabla'];

/**
 * Capa 4 de D5: los `encrypt*` de PII solo aceptan una tabla y una columna de este catálogo. Una columna
 * nueva dentro de un archivo que ya cifra no compila hasta declararla aquí.
 */
export type ParAadPii = {
  [T in TablaAad]: { table: T; column: Extract<EntradaCatalogo, { aadTabla: T }>['aadColumna'] };
}[TablaAad];

/** Columnas de driver_profile en la AAD, para los helpers de la ruta. */
export type ColumnaAadConductor = Extract<ParAadPii, { table: 'driver_profile' }>['column'];

/**
 * Archivos que llaman a un `encrypt*` de PII. Es lo que cubre las columnas sin marca en el nombre, como
 * las fotos de `tramites_validaciones`: un archivo nuevo que cifra obliga a revisar este catálogo.
 */
export const ESCRITORES = [
  'modules/drivers/drivers.routes.ts',
  'modules/flito-bolsas-documentos/flito-bolsas-documentos.service.ts',
  'modules/flito-logistica/flito-logistica.cifrado.ts',
  'modules/laft/employees/counterparty-pii.ts',
  'modules/privacy/rotacion/comprobar-llaves.ts',
  'modules/privacy/rotacion/descriptores.ts',
  'modules/privacy/rotacion/objetos-bolsas.ts',
  'modules/rndc/manifiestos.routes.ts',
  'scripts/flito-recifrar-biometria.ts',
] as const;

const CREDENCIAL = 'Credencial de integración, no PII. Keyspace propio por ADR-0002';
const FIRMA = 'Firma e integridad de un documento, no cifrado';

/** Columnas que parecen cifradas y no van con `PII_ENC_KEY`, con su motivo. */
export const FUERA_DE_ALCANCE: Readonly<Record<string, string>> = {
  'rndc_credenciales.clave_qr_cipher': `${CREDENCIAL} (RNDC_ENC_KEY)`,
  'rndc_credenciales.clave_qr_iv': `${CREDENCIAL} (RNDC_ENC_KEY)`,
  'rndc_credenciales.clave_qr_auth_tag': `${CREDENCIAL} (RNDC_ENC_KEY)`,
  'siigo_credenciales.access_key_cipher': `${CREDENCIAL} (SIIGO_ENC_KEY)`,
  'siigo_credenciales.access_key_iv': `${CREDENCIAL} (SIIGO_ENC_KEY)`,
  'siigo_credenciales.access_key_auth_tag': `${CREDENCIAL} (SIIGO_ENC_KEY)`,
  'flito_comparendos_token_simit.token_cipher': `${CREDENCIAL} (COMPARENDOS_ENC_KEY)`,
  'flito_comparendos_token_simit.token_iv': `${CREDENCIAL} (COMPARENDOS_ENC_KEY)`,
  'flito_comparendos_token_simit.token_auth_tag': `${CREDENCIAL} (COMPARENDOS_ENC_KEY)`,
  'flito_sync_flit2_acceso.secret_cipher': `${CREDENCIAL} (FLIT2_ENC_KEY)`,
  'flito_sync_flit2_acceso.secret_iv': `${CREDENCIAL} (FLIT2_ENC_KEY)`,
  'flito_sync_flit2_acceso.secret_auth_tag': `${CREDENCIAL} (FLIT2_ENC_KEY)`,
  'driver_profile.cedula_hash': 'HMAC con PII_HMAC_KEY, no cifrado. No se rota (ADR-0034 D7)',
  'pesv_comite_actas.hash_sha256': FIRMA,
  'pesv_comite_actas.pkcs7_signature': FIRMA,
  'pesv_policy.hash_sha256': FIRMA,
  'pesv_policy.pkcs7_signature': FIRMA,
};
