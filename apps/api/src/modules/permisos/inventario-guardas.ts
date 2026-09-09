// HU #12081 — El LECTOR de guardas: qué operaciones protege hoy `requireRole` y para qué roles.
//
// Es la mitad automática del catálogo. La otra mitad —cómo se llama cada operación en el negocio—
// vive en `catalogo-operaciones.ts` y la escribe el producto (CF-23). Aquí NO se teclea ni un rol:
// los roles salen de leer los ficheros de rutas, que es lo que el AC4 exige («enumeradas por el
// generador, no por un número escrito a mano»).
//
// Por qué un lector de TEXTO y no importar los routers: `requireRole` devuelve un middleware opaco,
// y Express no expone con qué argumentos se construyó. Importar los módulos además arrastra la
// conexión a base de datos y los crons. Leer el fuente es lo único que responde «qué roles exige
// esta ruta» sin arrancar el API.
//
// Lo que este lector NO ve, y hay que saberlo:
//   · Rutas sin `requireRole` (las públicas, y las que solo llevan `authMiddleware`). No son
//     operaciones del catálogo: su permiso no es de rol y la #12082 las tratará aparte.
//   · Guardas construidas en tiempo de ejecución (`requireRole(...variable)` con una variable que no
//     esté en `CONSTANTES_ROLES`). El lector FALLA en vez de adivinar: una guarda mal leída siembra
//     un reparto falso, y eso es peor que no sembrar nada.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
export const RAIZ_MODULOS = join(AQUI, '..');

/** Una operación tal como el CÓDIGO la protege hoy. */
export interface GuardaLeida {
  /** Código de módulo del catálogo (`soat`, `impuestos`, `transito`…). */
  modulo: string;
  /** Ruta del fichero relativa a `src/modules`, para poder señalarla en un error. */
  fichero: string;
  metodo: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Ruta declarada en el router, sin el prefijo de montaje. */
  ruta: string;
  /** Roles que exige la guarda, ordenados. */
  roles: string[];
  /** `true` si la guarda viene de un `router.use(...)` y no de la propia línea de la ruta. */
  heredada: boolean;
}

/** Un fichero de rutas en alcance y el módulo del catálogo al que aporta sus operaciones. */
interface FicheroEnAlcance {
  modulo: string;
  fichero: string;
}

/**
 * Los ficheros en alcance del Feature #12072: FLITO y trámites de tránsito.
 *
 * `clients` queda FUERA a propósito (el Feature lo excluye) y también todo lo legacy que no es ni
 * FLITO ni trámites: PESV, mantenimiento, LAFT, flota, conductores, rutas, SOAT legacy, RNDC,
 * privacidad, Siigo y vehículos. Sus guardas siguen siendo `requireRole` cableado hasta que otra
 * oleada las traiga; que no estén aquí no es un olvido, es el alcance.
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
];

/**
 * Constantes de roles que una guarda expande con spread. Se resuelven a mano y no leyendo su fichero
 * porque son dos líneas y leerlas costaría un segundo lector; si aparece una tercera, el error del
 * lector la nombra.
 */
const CONSTANTES_ROLES: Record<string, string[]> = {
  // flito-liquidacion/flito-liquidacion.routes.ts:28
  ROLES_LIQUIDACION_ESCRITURA: ['admin', 'financiera'],
};

/** Quita comentarios de bloque y de línea sin tocar el contenido de las cadenas simples. */
function sinComentarios(fuente: string): string {
  return fuente
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

/** Los roles literales de un `requireRole(...)`, ya expandidos los spread conocidos. */
function rolesDe(argumentos: string, fichero: string): string[] {
  const roles: string[] = [];
  for (const trozo of argumentos.split(',')) {
    const t = trozo.trim();
    if (!t) continue;
    const literal = /^'([^']+)'$/.exec(t);
    if (literal) { roles.push(literal[1]); continue; }
    const spread = /^\.\.\.([A-Za-z0-9_]+)$/.exec(t);
    if (spread && CONSTANTES_ROLES[spread[1]]) { roles.push(...CONSTANTES_ROLES[spread[1]]); continue; }
    throw new Error(
      `inventario-guardas: no sé qué roles exige \`requireRole(${argumentos})\` en ${fichero}. ` +
      'Si es una constante, decláralas en CONSTANTES_ROLES; adivinar sembraría un reparto falso.',
    );
  }
  return [...new Set(roles)].sort();
}

/** Lee un fichero de rutas y devuelve una entrada por ruta guardada. */
export function leerGuardas({ modulo, fichero }: FicheroEnAlcance, raiz = RAIZ_MODULOS): GuardaLeida[] {
  const fuente = sinComentarios(readFileSync(join(raiz, fichero), 'utf8'));

  // 1) Los alias: `const LECTURA = requireRole('admin', 'auditor');`
  const alias = new Map<string, string[]>();
  for (const m of fuente.matchAll(/const\s+([A-Z_][A-Z0-9_]*)\s*=\s*requireRole\(([^)]*)\)/g)) {
    alias.set(m[1], rolesDe(m[2], fichero));
  }

  // 2) La guarda de router.use(...), que cubre todo lo declarado DESPUÉS. Se guarda con su posición
  //    justamente por eso: en `flito-comparendos` el `router.use` está en la línea 113 y las rutas
  //    empiezan en la 439, pero nada garantiza ese orden en el siguiente fichero.
  const heredadas: { desde: number; roles: string[] }[] = [];
  for (const m of fuente.matchAll(/router\.use\((?:[^)]*?)requireRole\(([^)]*)\)/g)) {
    heredadas.push({ desde: m.index ?? 0, roles: rolesDe(m[1], fichero) });
  }
  const heredadaEn = (pos: number): string[] | null => {
    const aplicables = heredadas.filter((h) => h.desde < pos);
    if (!aplicables.length) return null;
    return [...new Set(aplicables.flatMap((h) => h.roles))].sort();
  };

  // 3) Las rutas. El trozo entre la ruta y el handler es donde vive la guarda propia; se corta en el
  //    handler (`async (`, `(req`, `(_req`) para no arrastrar el cuerpo entero de la función.
  const salida: GuardaLeida[] = [];
  const rutas = /router\.(get|post|put|patch|delete)\(\s*'([^']*)'\s*,([\s\S]{0,400}?)(?:async\s*\(|\(\s*_?req\b|\(\s*\)\s*=>)/g;
  for (const m of fuente.matchAll(rutas)) {
    const pos = m.index ?? 0;
    const entre = m[3];
    let roles: string[] | null;
    let heredada = false;

    const propia = /requireRole\(([^)]*)\)/.exec(entre);
    if (propia) {
      roles = rolesDe(propia[1], fichero);
    } else {
      const usado = [...alias.keys()].find((a) => new RegExp(`\\b${a}\\b`).test(entre));
      if (usado) {
        roles = alias.get(usado)!;
      } else {
        roles = heredadaEn(pos);
        heredada = roles !== null;
      }
    }
    if (!roles) continue; // ruta sin guarda de rol: no es una operación de este catálogo

    salida.push({
      modulo,
      fichero,
      metodo: m[1].toUpperCase() as GuardaLeida['metodo'],
      ruta: m[2],
      roles,
      heredada,
    });
  }
  return salida;
}

/** Todas las guardas del alcance, en orden estable (fichero, método, ruta). */
export function inventarioDeGuardas(raiz = RAIZ_MODULOS): GuardaLeida[] {
  return FICHEROS_EN_ALCANCE.flatMap((f) => leerGuardas(f, raiz));
}

/** La llave con la que el catálogo de negocio nombra una guarda: `<fichero> <MÉTODO> <ruta>`. */
export function llaveDe(g: Pick<GuardaLeida, 'fichero' | 'metodo' | 'ruta'>): string {
  return `${g.fichero} ${g.metodo} ${g.ruta}`;
}
