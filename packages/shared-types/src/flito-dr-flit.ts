// Dr. Flit — soporte y autorización de tratamiento de datos (Feature #13695, HU #13803 y #13804).
// Diseño: docs/diseno/feature-13695-dr-flit-soporte.md (D5) y ADR-0026.
//
// La versión y el TEXTO de cada autorización viven aquí, y solo aquí: la API valida la versión y guarda
// el SHA-256 del texto junto a ella (prueba de qué texto exacto se aceptó, Ley 1581); la web pinta este
// mismo texto. Cambiar el texto sin cambiar la versión lo detecta el test de este paquete (hash fijado
// por versión).
import type { PageSlug, UserRole } from './permissions.js';

export const FINALIDADES_DRFLIT = ['soporte', 'ia'] as const;
export type FinalidadDrFlit = (typeof FINALIDADES_DRFLIT)[number];

export interface AutorizacionDrFlitVigente {
  version: string;
  texto: string;
}

/**
 * PROVISIONAL (P9-5): texto de trabajo, NO aprobado por PO/jurídico. La HU #13806 (HU-4) no se cierra
 * sin el texto aprobado; al reemplazarlo hay que subir la versión y actualizar el hash del test.
 */
export const AUTORIZACIONES_DRFLIT: Readonly<Record<FinalidadDrFlit, Readonly<AutorizacionDrFlitVigente>>> = Object.freeze({
  soporte: Object.freeze({
    version: '2026-10-provisional-1',
    texto:
      '[TEXTO PROVISIONAL — pendiente de aprobación por PO y jurídico] '
      + 'Autorizo a FLIT S.A.S. a tratar los datos personales que registre en este caso de soporte '
      + '(nombre, correo, teléfono y la información que describa o adjunte) con la única finalidad de '
      + 'atender y dar seguimiento a mi solicitud de soporte, conforme a la Ley 1581 de 2012 y a la '
      + 'política de tratamiento de datos de FLIT. Entiendo que esta información se registra en la '
      + 'herramienta de gestión de casos de soporte de FLIT (Microsoft Azure DevOps) y que puedo '
      + 'conocer, actualizar, rectificar y suprimir mis datos y revocar esta autorización.',
  }),
  ia: Object.freeze({
    version: '2026-10-provisional-1',
    texto:
      '[TEXTO PROVISIONAL — pendiente de aprobación por PO y jurídico] '
      + 'Autorizo a FLIT S.A.S. a tratar la información que escriba en Dr. Flit con herramientas de '
      + 'inteligencia artificial, con la única finalidad de responder mis consultas, conforme a la '
      + 'Ley 1581 de 2012 y a la política de tratamiento de datos de FLIT.',
  }),
});

/** Valor de `DEPLOY_ENVIRONMENT`. Nunca se deriva de `NODE_ENV` salvo el fallback de desarrollo. */
export const AMBIENTES_DESPLIEGUE = ['DEV', 'QA', 'PDN'] as const;
export type AmbienteDespliegue = (typeof AMBIENTES_DESPLIEGUE)[number];

/** Etiqueta de solo lectura que muestra el asistente (anexo UX F5, §F5.17). */
export const ETIQUETAS_AMBIENTE_DESPLIEGUE: Readonly<Record<AmbienteDespliegue, string>> = Object.freeze({
  PDN: 'Producción',
  QA: 'QA',
  DEV: 'Otro (DEV)',
});

/**
 * Quién alcanza Dr. Flit: «lo usa quien lo ve». En la web Dr. Flit se pinta con `puedeVerAyudaFlito`
 * (≥1 ficha de la Ayuda FLITO visible), y una ficha es visible si el usuario tiene la PÁGINA de su
 * `permiso`. Estas son esas páginas: la del permiso de cada ficha de
 * `apps/web/src/content/ayuda/catalogo.ts`, sin repetir. El servidor exige al menos una
 * (`pagina.<slug>` del motor de permisos), nunca el nombre del rol (HU #13425 AC6).
 * Un test del API compara esta lista con el catálogo de la web: una ficha nueva obliga a añadirla aquí.
 */
export const PAGINAS_AYUDA_DRFLIT = Object.freeze([
  'clients', 'drive', 'finanzas_gastos_diarios', 'finanzas_reporte_costos', 'flito_bitacora', 'flito_bolsas',
  'flito_comparendos', 'flito_comprobantes', 'flito_conciliacion', 'flito_derechos', 'flito_impuestos',
  'flito_logistica', 'flito_logistica_ruta', 'flito_revisiones', 'flito_servicios_adicionales',
  'flito_soat', 'flito_tablero', 'flito_tarifas', 'flito_tramites', 'privacy', 'roles_permisos',
  'siigo_credenciales', 'siigo_operacion', 'siigo_parametrizacion', 'soat', 'users',
] as const satisfies readonly PageSlug[]);

/** Topes de longitud de los campos del caso (anexo UX F5). Los consumen HU-2 (API) y HU-4 (web). */
export const LIMITES_CASO_SOPORTE = Object.freeze({
  nombre: Object.freeze({ min: 1, max: 120 }),
  correo: Object.freeze({ min: 3, max: 254 }),
  telefono: Object.freeze({ min: 0, max: 20 }),
  titulo: Object.freeze({ min: 3, max: 120 }),
  detalle: Object.freeze({ min: 10, max: 2000 }),
  resultadoEsperado: Object.freeze({ min: 1, max: 1000 }),
});

export type TipoAdjuntoSoporte = 'image/png' | 'image/jpeg' | 'application/pdf';

export interface EstadoAutorizacionDrFlit {
  finalidad: FinalidadDrFlit;
  autorizado: boolean;
  versionVigente: string;
  /** Texto vigente de la autorización (el mismo cuyo SHA-256 se guarda al aceptar). */
  textoVigente: string;
  /** ISO 8601 de la aceptación de la versión vigente; `null` si no la ha aceptado. */
  aceptadaEn: string | null;
  soporte: {
    disponible: boolean;
    /** `null` cuando el ambiente no está declarado (fallo cerrado: `disponible=false`). */
    ambiente: AmbienteDespliegue | null;
    ambienteEtiqueta: string | null;
    adjuntos: { maxArchivos: number; maxBytesArchivo: number; tipos: readonly TipoAdjuntoSoporte[] };
  };
}

export interface AceptarAutorizacionDrFlit {
  finalidad: FinalidadDrFlit;
  version: string;
}

export interface AutorizacionAceptadaDrFlit {
  finalidad: FinalidadDrFlit;
  version: string;
  aceptadaEn: string;
}

/**
 * Códigos de error de Dr. Flit soporte. HU-1: autorización. HU-2 (#13804): radicación del caso.
 * HU-3 (#13805) amplía la unión con los de adjuntos.
 */
export type CodigoErrorDrFlit =
  | 'finalidad-invalida' | 'version-no-vigente' | 'campo-invalido'
  | 'autorizacion-requerida' | 'radicacion-en-curso' | 'soporte-no-disponible'
  | 'ado-error' | 'ado-no-disponible'
  | 'adjunto-invalido' | 'adjunto-muy-grande' | 'adjuntos-limite';

// ── HU #13804: el caso de soporte ────────────────────────────────────────────────────────────────

export const AREAS_SOPORTE = [
  'operaciones', 'facturacion', 'corredor_soat', 'corredor_impuestos', 'mensajero_logistica',
] as const;
export type AreaSoporte = (typeof AREAS_SOPORTE)[number];

export const FRECUENCIAS_SOPORTE = ['siempre', 'a_veces', 'solo_una_vez'] as const;
export type FrecuenciaSoporte = (typeof FRECUENCIAS_SOPORTE)[number];

export const PRIORIDADES_SOPORTE = ['alta', 'media', 'baja'] as const;
export type PrioridadSoporte = (typeof PRIORIDADES_SOPORTE)[number];

/** Etiquetas visibles: las pinta la web y las escribe la API en el ReproSteps (una sola fuente). */
export const ETIQUETAS_AREA_SOPORTE: Readonly<Record<AreaSoporte, string>> = Object.freeze({
  operaciones: 'Operaciones',
  facturacion: 'Facturación',
  corredor_soat: 'Corredor SOAT',
  corredor_impuestos: 'Corredor Impuestos',
  mensajero_logistica: 'Mensajero y Logística',
});
export const ETIQUETAS_FRECUENCIA_SOPORTE: Readonly<Record<FrecuenciaSoporte, string>> = Object.freeze({
  siempre: 'Siempre',
  a_veces: 'A veces',
  solo_una_vez: 'Solo una vez',
});
export const ETIQUETAS_PRIORIDAD_SOPORTE: Readonly<Record<PrioridadSoporte, string>> = Object.freeze({
  alta: 'Alta',
  media: 'Media',
  baja: 'Baja',
});

/** Área sugerida por rol (prellenado del asistente, D5). Un rol sin entrada elige el área. */
export const AREA_SOPORTE_POR_ROL: Readonly<Partial<Record<UserRole, AreaSoporte>>> = Object.freeze({
  proveedor: 'corredor_soat',
  gestor_impuestos: 'corredor_impuestos',
  mensajero: 'mensajero_logistica',
  financiera: 'facturacion',
});

/**
 * Cuerpo de `POST /api/flito/dr-flit/casos-soporte` (HU-2). Fecha y ambiente los pone el SERVIDOR.
 * Dos formas (HU-3, #13805):
 *   · `application/json` con este objeto (sin adjuntos; igual que HU-2).
 *   · `multipart/form-data` con la parte de texto `caso` (este objeto en JSON) y de 0 a
 *     `soporte.adjuntos.maxArchivos` partes de archivo `adjuntos` (también se admite `adjuntos[]`).
 * Para reintentar se reenvía la MISMA petición (con los mismos archivos) y la misma `claveIdempotencia`.
 */
export interface CasoSoporteDrFlit {
  /** UUID del cliente; se REUTILIZA al reintentar el mismo caso (idempotencia). */
  claveIdempotencia: string;
  contacto: { nombre: string; correo: string; telefono?: string };
  area: AreaSoporte;
  titulo: string;
  detalle: string;
  resultadoEsperado: string;
  frecuencia: FrecuenciaSoporte;
  prioridad: PrioridadSoporte;
}

/** Nombres de las partes del multipart de `POST /casos-soporte` (HU-3). */
export const PARTE_CASO_MULTIPART = 'caso';
export const PARTE_ADJUNTOS_MULTIPART = 'adjuntos';

/** Por qué se rechazó un adjunto (HU-3). El servidor nunca devuelve el nombre ni el contenido del archivo. */
export type MotivoAdjuntoRechazado = 'tipo-no-permitido' | 'contenido-no-coincide' | 'vacio' | 'muy-grande';

/**
 * Cuerpo de un 400 `adjunto-invalido` o un 413 `adjunto-muy-grande` / `adjuntos-limite` (HU-3).
 * `adjunto.indice` = posición 0-based del archivo entre las partes `adjuntos` (anexo UX §F5.17);
 * `limite` = el límite superado.
 */
export interface ErrorAdjuntoDrFlit {
  error: string;
  codigo: Extract<CodigoErrorDrFlit, 'adjunto-invalido' | 'adjunto-muy-grande' | 'adjuntos-limite'>;
  adjunto?: { indice: number; motivo: MotivoAdjuntoRechazado };
  limite?: { maxArchivos?: number; maxBytesArchivo?: number };
}

/** 201 (nuevo) o 200 (`repetido`: la misma clave ya estaba radicada). Sin URLs ni enlaces de ADO. */
export interface CasoRadicadoDrFlit {
  numero: number;
  repetido: boolean;
}
