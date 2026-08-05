// Siigo — catálogos de parametrización contable (HU #11281, Feature #11239).
//
// Contrato entre `apps/api` y `apps/web` para la copia local de los catálogos de Siigo. Vive aquí y
// no en el módulo del API porque las pantallas de parametrización (HUs #11282–#11284) eligen de
// estas listas, y el nombre del tipo de catálogo tiene que ser el mismo a los dos lados: un
// `'payment_type'` escrito a mano en el frontend sería un fallo silencioso de lista vacía.
//
// Los tipos usan el identificador de Siigo tal cual (`document_type`, `cost_center`…) en vez de una
// traducción al español. Es lo que aparece en la documentación de Siigo y en la ruta consultada, así
// que quien depura un problema no tiene que mantener un diccionario en la cabeza.

/** Los seis catálogos que FLITO cachea. El orden es el de la pantalla de parametrización. */
export const SIIGO_TIPOS_CATALOGO = [
  'document_type',
  'user',
  'payment_type',
  'tax',
  'account_group',
  'cost_center',
] as const;

export type SiigoTipoCatalogo = typeof SIIGO_TIPOS_CATALOGO[number];

export function esTipoCatalogoSiigo(v: unknown): v is SiigoTipoCatalogo {
  return typeof v === 'string' && (SIIGO_TIPOS_CATALOGO as readonly string[]).includes(v);
}

/** Etiquetas en español para la interfaz. Fuente única: si cambian, cambian en un solo sitio. */
export const SIIGO_CATALOGO_ETIQUETAS: Record<SiigoTipoCatalogo, string> = {
  document_type: 'Tipos de comprobante',
  user: 'Vendedores',
  payment_type: 'Formas de pago',
  tax: 'Impuestos',
  account_group: 'Grupos de inventario',
  cost_center: 'Centros de costo',
};

/**
 * Un elemento de catálogo tal como lo devuelve el API.
 *
 * `codigo` es el identificador de Siigo en texto —los catálogos lo entregan como número, pero se
 * guarda como texto para que un catálogo futuro con código alfanumérico no obligue a migrar.
 *
 * `atributos` lleva lo específico de cada catálogo (porcentaje de un impuesto, si una forma de pago
 * maneja vencimiento…). Nunca lleva datos personales: del catálogo de vendedores solo se conserva
 * el nombre, ni cédula ni correo (Ley 1581).
 */
export interface SiigoCatalogoElemento {
  codigo: string;
  nombre: string;
  descripcion: string | null;
  activo: boolean;
  atributos: Record<string, unknown> | null;
  /** ISO 8601. Cuándo se trajo este elemento de Siigo por última vez. */
  sincronizadoEn: string;
}

/**
 * Ambiente de Siigo al que pertenece una copia local.
 *
 * `pruebas` y `produccion` son EMPRESAS DISTINTAS en Siigo, con identificadores propios. Viaja en
 * toda respuesta de catálogos para que la pantalla pueda decir de qué empresa es la lista que está
 * mostrando: un desplegable de vendedores de pruebas usado para facturar en producción emitiría
 * ante la DIAN con un vendedor que allí no existe.
 */
export type SiigoAmbienteCatalogo = 'pruebas' | 'produccion';

/** Respuesta de la lectura de un catálogo desde la copia local. */
export interface SiigoCatalogoLocal {
  tipo: SiigoTipoCatalogo;
  etiqueta: string;
  /** Empresa de Siigo de la que se leyó. */
  ambiente: SiigoAmbienteCatalogo;
  /** ISO 8601, o `null` si el catálogo nunca se sincronizó. */
  sincronizadoEn: string | null;
  elementos: SiigoCatalogoElemento[];
}

/** Fila del resumen: un catálogo, cuántos elementos tiene y cuándo se trajo. */
export interface SiigoCatalogoResumen {
  tipo: SiigoTipoCatalogo;
  etiqueta: string;
  /** Empresa de Siigo a la que corresponde el conteo. */
  ambiente: SiigoAmbienteCatalogo;
  total: number;
  activos: number;
  sincronizadoEn: string | null;
}

/** Causa de fallo de un catálogo, ya traducida a lenguaje operativo. */
export interface SiigoCatalogoError {
  codigo: string;
  mensaje: string;
}

/** Resultado de sincronizar UN catálogo. Un fallo aquí no invalida a los demás. */
export interface SiigoResultadoCatalogo {
  tipo: SiigoTipoCatalogo;
  etiqueta: string;
  ok: boolean;
  /** Elementos traídos de Siigo. 0 cuando el catálogo falló. */
  total: number;
  /** Elementos que dejaron de venir y quedaron marcados como inactivos. */
  inactivados: number;
  /**
   * El catálogo estaba poblado y Siigo lo devolvió VACÍO: `total = 0` e `inactivados > 0`.
   *
   * Técnicamente la sincronización fue un éxito —Siigo respondió 200 y la copia local quedó fiel—,
   * así que `ok` sigue siendo `true`. Pero el efecto es que la parametrización se quedó sin
   * opciones, y sin esta bandera la pantalla lo anunciaría en verde y nadie sabría que hay que
   * volver a sincronizar. La inactivación NO se revierte: si la baja masiva es legítima, esconderla
   * sería peor. Se señala para que un humano decida.
   */
  vaciadoMasivo: boolean;
  sincronizadoEn: string | null;
  error: SiigoCatalogoError | null;
  duracionMs: number;
}

/** Resultado de la sincronización completa. */
export interface SiigoResultadoSincronizacion {
  /** true solo si TODOS los catálogos se actualizaron. */
  ok: boolean;
  /** true cuando unos respondieron y otros no. */
  parcial: boolean;
  /**
   * true si ALGÚN catálogo poblado volvió vacío. Independiente de `ok`: una sincronización puede ser
   * enteramente exitosa y aun así haber dejado la parametrización desierta.
   */
  vaciadoMasivo: boolean;
  ambiente: string;
  modo: string;
  duracionMs: number;
  catalogos: SiigoResultadoCatalogo[];
}
