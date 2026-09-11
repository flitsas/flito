// HU #12081 / #12083 — El LECTOR de montajes: qué código del catálogo exige cada ruta de los módulos
// FLITO y de trámites, leído del propio fuente.
//
// Hasta la #12083 este fichero leía `requireRole(...)` y devolvía ROLES: era la mitad automática del
// catálogo. Desde la #12083 ninguna ruta de los ficheros en alcance lleva `requireRole`; llevan
// `exigirFuncion('<codigo>')` (o `tieneFuncion(req, '<codigo>')` dentro de un handler) y lo que se
// lee es el CÓDIGO montado. Los roles de partida ya no están en el fuente: están en la foto histórica
// `inventario.generado.ts` (qué exigía cada `requireRole` el día que dejó de decidir) y en la base.
//
// Por qué un lector de TEXTO y no importar los routers: `exigirFuncion` devuelve un middleware opaco,
// y Express no expone con qué argumentos se construyó. Importar los módulos además arrastra la
// conexión a base de datos y los crons. Leer el fuente es lo único que responde «qué código exige
// esta ruta» sin arrancar el API.
//
// Lo que este lector NO ve, y hay que saberlo:
//   · Rutas sin guarda de función (las públicas, y las que solo llevan `authMiddleware`). No son
//     operaciones del catálogo: `permisos.reconduccion-cierre.test.ts` las enumera como lista blanca.
//   · Un `exigirFuncion(` sin literal (una variable, un template). El lector FALLA en vez de adivinar:
//     un código que el catálogo no conoce es una guarda que responde `no_reconocida` a todo el mundo.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
export const RAIZ_MODULOS = join(AQUI, '..');

/** Una operación tal como la protegía `requireRole` el día de la foto (`inventario.generado.ts`). */
export interface GuardaLeida {
  /** Código de módulo del catálogo (`soat`, `impuestos`, `transito`…). */
  modulo: string;
  /** Ruta del fichero relativa a `src/modules`, para poder señalarla en un error. */
  fichero: string;
  metodo: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Ruta declarada en el router, sin el prefijo de montaje. */
  ruta: string;
  /**
   * Solo en las guardas EN LÍNEA (dentro del handler, con `tieneFuncion`): la condición que las
   * distingue de la ruta que las contiene (`_forzarContinuar`, `ajena`). Entra en la llave.
   */
  condicion?: string;
  /** Roles que exigía la guarda, ordenados. */
  roles: string[];
  /** `true` si la guarda venía de un `router.use(...)` y no de la propia línea de la ruta. */
  heredada: boolean;
}

/** Un código del catálogo tal como está MONTADO hoy en el fuente. */
export interface MontajeLeido {
  fichero: string;
  /** Nulos cuando el código se pide en línea con `tieneFuncion(req, …)`. */
  metodo: GuardaLeida['metodo'] | null;
  ruta: string | null;
  codigo: string;
}

/** Un fichero de rutas en alcance y el módulo del catálogo al que aporta sus operaciones. */
export interface FicheroEnAlcance {
  modulo: string;
  fichero: string;
}

/**
 * Los ficheros en alcance del Feature #12072: FLITO, trámites de tránsito y usuarios.
 *
 * `clients` queda FUERA a propósito (el Feature lo excluye) y también todo lo legacy que no es ni
 * FLITO ni trámites: PESV, mantenimiento, LAFT, flota, conductores, rutas, SOAT legacy, RNDC,
 * privacidad, Siigo y vehículos. Sus guardas siguen siendo `requireRole` cableado hasta que otra
 * oleada las traiga; que no estén aquí no es un olvido, es el alcance (AC4/AC5 de la #12083).
 */
export const FICHEROS_EN_ALCANCE: FicheroEnAlcance[] = [
  { modulo: 'soat', fichero: 'flito-soat/flito-soat.routes.ts' },
  { modulo: 'soat', fichero: 'flito-soat/flito-soat-cliente.routes.ts' },
  { modulo: 'impuestos', fichero: 'flito-impuestos/flito-impuestos.routes.ts' },
  { modulo: 'derechos', fichero: 'flito-derechos/flito-derechos.routes.ts' },
  { modulo: 'revisiones', fichero: 'flito-revisiones/flito-revisiones.routes.ts' },
  { modulo: 'compuerta', fichero: 'flito-compuerta/flito-compuerta.routes.ts' },
  { modulo: 'tramites', fichero: 'flito-tramites/flito-tramites.routes.ts' },
  { modulo: 'tablero', fichero: 'flito-tablero/flito-tablero.routes.ts' },
  { modulo: 'bitacora', fichero: 'flito-bitacora/flito-bitacora.routes.ts' },
  { modulo: 'logistica', fichero: 'flito-logistica/flito-logistica.routes.ts' },
  { modulo: 'bolsas', fichero: 'flito-bolsas/flito-bolsas.routes.ts' },
  { modulo: 'conciliacion', fichero: 'flito-conciliacion/flito-conciliacion.routes.ts' },
  { modulo: 'comparendos', fichero: 'flito-comparendos/flito-comparendos.routes.ts' },
  { modulo: 'liquidacion', fichero: 'flito-liquidacion/flito-liquidacion.routes.ts' },
  { modulo: 'parametrizacion', fichero: 'flito-parametrizacion/flito-parametrizacion.routes.ts' },
  { modulo: 'sync', fichero: 'flito-sync/flito-sync.routes.ts' },
  { modulo: 'tramite', fichero: 'tramites/tramites.routes.ts' },
  { modulo: 'tramite', fichero: 'tramites/ocr-docs.routes.ts' },
  { modulo: 'tramite', fichero: 'tramites/identidad.routes.ts' },
  { modulo: 'transito', fichero: 'tramites/transito.routes.ts' },
  { modulo: 'transito', fichero: 'tramites/transito-config.routes.ts' },
  { modulo: 'usuarios', fichero: 'users/users.routes.ts' },
];

/** Quita comentarios de bloque y de línea sin tocar el contenido de las cadenas simples. */
export function sinComentarios(fuente: string): string {
  return fuente
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

/**
 * La regex de rutas con la que la #12081 leyó las 217 guardas: el trozo entre la ruta y el handler
 * es donde vive la guarda propia; se corta en el handler (`async (`, `(req`, `(_req`) para no
 * arrastrar el cuerpo entero de la función, o en el `);` que cierra la declaración cuando el handler
 * es una referencia (`router.post('/x', exigirFuncion('…'), traspaso(...));`, impuestos).
 */
const RUTAS = /router\.(get|post|put|patch|delete)\(\s*'([^']*)'\s*,([\s\S]{0,500}?)(?:async\s*\(|\(\s*_?req\b|\(\s*\)\s*=>|\);)/g;

const CODIGO = /^'([a-z_]+\.[a-z_]+\.[a-z_]+)'$/;

function codigoDe(argumentos: string, fichero: string, forma: string): string {
  const literal = CODIGO.exec(argumentos.trim());
  if (literal) return literal[1];
  throw new Error(
    `inventario-guardas: no sé qué código exige \`${forma}(${argumentos})\` en ${fichero}. ` +
    'La guarda va con el código literal: adivinarlo montaría una guarda que el catálogo no conoce.',
  );
}

/**
 * Lee un fichero de rutas y devuelve un montaje por `exigirFuncion('<codigo>')` a nivel de ruta y
 * otro por cada `tieneFuncion(req, '<codigo>')` en línea (estos con método y ruta nulos).
 */
export function leerMontajes({ fichero }: FicheroEnAlcance, raiz = RAIZ_MODULOS): MontajeLeido[] {
  const fuente = sinComentarios(readFileSync(join(raiz, fichero), 'utf8'));
  const salida: MontajeLeido[] = [];

  for (const m of fuente.matchAll(RUTAS)) {
    const entre = m[3];
    const guarda = /exigirFuncion\(([^)]*)\)/.exec(entre);
    if (!guarda) continue; // ruta sin guarda de función: pública o solo authMiddleware
    salida.push({
      fichero,
      metodo: m[1].toUpperCase() as GuardaLeida['metodo'],
      ruta: m[2],
      codigo: codigoDe(guarda[1], fichero, 'exigirFuncion'),
    });
  }

  for (const m of fuente.matchAll(/tieneFuncion\(([^)]*)\)/g)) {
    const [, argumentos] = /^\s*req\s*,(.*)$/s.exec(m[1]) ?? [];
    if (argumentos === undefined) {
      throw new Error(`inventario-guardas: \`tieneFuncion(${m[1]})\` en ${fichero} no recibe \`req\` como primer argumento.`);
    }
    salida.push({ fichero, metodo: null, ruta: null, codigo: codigoDe(argumentos, fichero, 'tieneFuncion') });
  }
  return salida;
}

/** Todos los montajes del alcance, en orden estable (fichero, posición en el fuente). */
export function montajesDeFunciones(raiz = RAIZ_MODULOS): MontajeLeido[] {
  return FICHEROS_EN_ALCANCE.flatMap((f) => leerMontajes(f, raiz));
}

/**
 * La llave con la que el catálogo de negocio nombra una guarda: `<fichero> <MÉTODO> <ruta>`, y entre
 * corchetes la condición cuando la guarda es en línea (`… PATCH /:id [_forzarContinuar]`).
 */
export function llaveDe(g: Pick<GuardaLeida, 'fichero' | 'metodo' | 'ruta' | 'condicion'>): string {
  return `${g.fichero} ${g.metodo} ${g.ruta}${g.condicion ? ` [${g.condicion}]` : ''}`;
}
