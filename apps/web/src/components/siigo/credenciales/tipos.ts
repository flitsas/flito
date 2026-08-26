// Credenciales de la integración con Siigo (HU #11890) — tipos, copy y reglas compartidas.
//
// Vive aparte de la pantalla porque las tres piezas (tarjeta, modal de alta y diálogo de baja)
// tienen que decir EXACTAMENTE lo mismo sobre tres cosas que el backend ya decidió y que la web no
// puede reinterpretar:
//
//   1. `accessKey` NUNCA es un valor: el listado devuelve la constante `'••••••••'` para todas las
//      filas (`credenciales.service.ts`). No refleja la longitud y no hay nada que revelar. Por eso
//      el formulario NO se inicializa nunca desde una credencial del listado: `'••••••••'` mide
//      ocho caracteres y pasaría el `min(8)` del servidor, guardando una credencial basura.
//   2. Los topes de validación son los del `credencialSchema` del router, copiados a mano y con su
//      referencia: si divergen, el usuario ve un error que el servidor no comparte.
//   3. `probar-conexion` responde **200 siempre**. `ok:false` no es un error de la aplicación: es
//      un diagnóstico que terminó bien y trae malas noticias.

import type { ChipTone } from '../../flit/StatusChip';

export type Ambiente = 'pruebas' | 'produccion';

export const AMBIENTES: readonly Ambiente[] = ['pruebas', 'produccion'];

export const ETIQUETA_AMBIENTE: Record<Ambiente, string> = {
  pruebas: 'Pruebas',
  produccion: 'Producción',
};

/** En minúscula, para las frases: «la credencial de producción». */
export const AMBIENTE_EN_FRASE: Record<Ambiente, string> = {
  pruebas: 'pruebas',
  produccion: 'producción',
};

/** Espejo de `SiigoCredencialPublica` (`apps/api/src/modules/siigo/credenciales.service.ts`). */
export interface SiigoCredencialPublica {
  id: number;
  ambiente: string;
  username: string;
  /** Siempre enmascarada. El servidor no devuelve —ni conoce en claro— el valor real. */
  accessKey: string;
  /** La bandera es `activo`, NO `activa`. */
  activo: boolean;
  keyVersion: number;
  notas: string | null;
  descifradoFallidoEn: string | null;
  descifradoFallidoMotivo: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RespuestaCredenciales {
  data: SiigoCredencialPublica[];
  llaveMaestraConfigurada: boolean;
}

/** Espejo de `ResultadoDiagnostico` (`siigo.diagnostico.service.ts`). */
export interface ResultadoDiagnostico {
  ok: boolean;
  codigo: string;
  mensaje: string;
  ambiente: string;
  modo: string;
  /** Usuario de la credencial activa. Nunca el access key. */
  username: string | null;
  tokenObtenido: boolean;
  duracionMs: number;
}

// ── Topes de validación — fuente: `credencialSchema` en `credenciales.routes.ts` ────────────────
export const USUARIO_MIN = 3;
export const USUARIO_MAX = 150;
export const ACCESS_KEY_MIN = 8;
export const ACCESS_KEY_MAX = 500;
export const NOTAS_MAX = 500;

/** El `id` del banner de entorno. Lo referencian los botones deshabilitados con `aria-describedby`. */
export const ID_BANNER_LLAVE = 'siigo-llave-maestra';

export const NOTA_MASCARA = 'Los puntos no indican la longitud real. El valor no se puede volver a '
  + 'consultar desde FLITO.';

/** Cómo se rotula una fila del historial. `activo:false` NO siempre es «alguien la desactivó». */
export function chipDeCredencial(c: SiigoCredencialPublica): { tono: ChipTone; etiqueta: string } {
  if (c.activo) return { tono: 'success', etiqueta: 'Activa' };
  // Una fila que el servicio desactivó SOLO porque el ciphertext no verifica —típicamente porque
  // se rotó `SIIGO_ENC_KEY` sin migrar lo cifrado— no se rotula «Inactiva»: mandaría a buscar un
  // culpable que no existe, y la acción correcta es otra (generar una llave nueva en Siigo Nube).
  if (c.descifradoFallidoEn) return { tono: 'danger', etiqueta: 'No se puede descifrar' };
  return { tono: 'neutral', etiqueta: 'Inactiva' };
}

/**
 * Quita del mensaje del servidor la frase que, LEÍDA AQUÍ, manda al usuario a donde ya está.
 *
 * `siigo.diagnostico.service.ts` cierra el mensaje de `sin_credenciales` con «Regístralas en
 * Administración › Integración con Siigo.». Es correcta en el reporte de costos, en la bandeja o en
 * un log —de ahí que no se toque el backend— pero en ESTA pantalla es autorreferencial: quien la lee
 * está en Administración › Integración con Siigo, mirando la tarjeta del ambiente que se lo dice.
 *
 * Se recorta LA FRASE, no el mensaje entero: lo que el servidor tenga que decir además («No hay
 * credenciales de Siigo activas para el ambiente "pruebas".») se sigue pintando literal, y si mañana
 * el backend cambia ese texto, lo que sobreviva se pinta igual.
 */
export function sinAutorreferencia(mensaje: string): string {
  return mensaje.replace(/\s*Regístralas en Administración\s*›\s*Integración con Siigo\.?/i, '').trim();
}

export interface CopiaVeredicto {
  tono: ChipTone;
  /** Símbolo redundante con el texto: nunca solo color. */
  simbolo: string;
  encabezado: string;
  /** Línea propia de la pantalla, cuando el mensaje del servidor no basta o no sirve aquí. */
  segunda?: string;
  /** Hoy siempre `true`: lo que se recorta es la frase autorreferencial, no el mensaje entero. */
  pintarMensajeDelServidor: boolean;
}

/**
 * Copy de los siete códigos del diagnóstico, más el camino de un código desconocido.
 *
 * El tono se decide por `codigo` y no por `ok` porque el servidor deriva uno del otro
 * (`ok: codigo === 'ok'`): una sola fuente. Y un código nuevo del backend NO rompe el panel — cae
 * al neutro y se pinta el mensaje del servidor entero, que es lo único que hace falta para
 * diagnosticar.
 */
export function copiaVeredicto(codigo: string, ambiente: Ambiente): CopiaVeredicto {
  switch (codigo) {
    case 'ok':
      return { tono: 'success', simbolo: '✓', encabezado: 'Conexión correcta.', pintarMensajeDelServidor: true };
    case 'sin_credenciales':
      return {
        tono: 'warning',
        simbolo: '✗',
        encabezado: `No hay credenciales activas para el ambiente "${ambiente}".`,
        // El backend cierra este mensaje con «Regístralas en Administración › Integración con
        // Siigo», que aquí manda a quien lee a la pantalla en la que ya está. `sinAutorreferencia`
        // recorta ESA frase y esta línea la sustituye por la indicación que sí sirve estando aquí.
        segunda: 'Regístrala con el botón de arriba: la prueba no llegó a salir hacia Siigo.',
        pintarMensajeDelServidor: true,
      };
    case 'sin_configuracion':
      return {
        tono: 'danger',
        simbolo: '✗',
        encabezado: 'Falta configuración del servidor. Es un problema del entorno.',
        pintarMensajeDelServidor: true,
      };
    case 'llave_maestra':
      return {
        tono: 'danger',
        simbolo: '✗',
        encabezado: 'Falta la llave maestra de cifrado del servidor.',
        segunda: 'Lo resuelve quien administra el servidor: no hay nada que corregir desde aquí.',
        pintarMensajeDelServidor: true,
      };
    case 'credenciales_rechazadas':
      return {
        tono: 'danger',
        simbolo: '✗',
        encabezado: 'Siigo rechazó estas credenciales.',
        segunda: 'Verifícalas en Siigo Nube y regístralas de nuevo.',
        pintarMensajeDelServidor: true,
      };
    case 'servicio_no_disponible':
      return {
        tono: 'warning',
        simbolo: '✗',
        encabezado: 'Siigo no está respondiendo. No es un problema de tus credenciales.',
        pintarMensajeDelServidor: true,
      };
    default:
      return {
        tono: 'neutral',
        simbolo: '✗',
        encabezado: 'La prueba terminó con un resultado que esta pantalla no sabe interpretar.',
        pintarMensajeDelServidor: true,
      };
  }
}

/** Tinta accesible de cada tono (≥ 4,5:1 sobre blanco). `--flit-danger` es para bordes e iconos. */
export const TINTA_TONO: Record<ChipTone, string> = {
  success: 'var(--flit-success-ink)',
  active: 'var(--flit-blue-ink)',
  warning: 'var(--flit-warning-ink)',
  danger: 'var(--flit-danger-ink)',
  draft: 'var(--flit-draft)',
  neutral: 'var(--flit-text-muted)',
};

/** Color de marca del borde del panel: decorativo, exento de SC 1.4.11. */
export const BORDE_TONO: Record<ChipTone, string> = {
  success: 'var(--flit-success)',
  active: 'var(--flit-info)',
  warning: 'var(--flit-warning)',
  danger: 'var(--flit-danger)',
  draft: 'var(--flit-draft)',
  neutral: 'var(--flit-border-soft)',
};
