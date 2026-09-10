// HU #12083 — El CIERRE de la reconducción (AC1, AC2, AC3): en los 19 directorios de FLITO, trámites
// y usuarios ya no decide ningún `requireRole`; decide el motor, ruta a ruta, con `exigirFuncion`.
//
//   · AC1/AC2: cero `requireRole(` en los 19 directorios (fuera de comentarios con `sinComentarios`, y
//     también dentro: el AC dice «ninguna aparición»); cero `import … requireRole`.
//   · Los 22 ficheros de rutas importan `exigirFuncion`; conservan `router.use(authMiddleware)` o, en
//     `identidad.routes.ts`, `authMiddleware` en cada ruta que lo llevaba (lista explícita de 7).
//   · Cada `router.<método>(` de los 22 ficheros lleva `exigirFuncion('…')` O está en la lista blanca
//     de 4 rutas sin guarda de función. Es la red que sustituye a los `router.use(requireRole)`
//     retirados: una ruta nueva sin guarda no «nace protegida» por herencia, nace aquí en rojo.
//   · `leerMontajes` cubre la foto entera (228 = 217 de la #12081 + 11 de esta HU, dos en línea).
//   · AC3: las comparaciones de ÁMBITO siguen existiendo (15 medidas el 10/09/2026; el diseño contó
//     14 porque agrupó los dos `esGestor`/`esCliente` de soat), enumeradas por fichero (regex por
//     contenido, no por número de línea): cambian QUÉ filas ve alguien, no QUIÉN puede ejecutar. Las 27
//     de `users.routes.ts` son el `superRefine` del usuario editado (HU #12088), tampoco guardas.
//
// Mutación del AC8: devolver `requireRole('admin')` a una ruta reconducida → rojo en el primer aserto
// (aparece `requireRole(`) y en el de «cada ruta lleva exigirFuncion»; y en la paridad («fila sin
// montaje»).

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FICHEROS_EN_ALCANCE, RAIZ_MODULOS, leerMontajes, llaveDe, montajesDeFunciones, sinComentarios,
} from '../../src/modules/permisos/inventario-guardas.js';
import { GUARDAS_MEDIDAS } from '../../src/modules/permisos/inventario.generado.js';
import { OPERACIONES_DECLARADAS } from '../../src/modules/permisos/catalogo-operaciones.js';

/** Los 19 directorios del enunciado (cadena SOAT + resto de FLITO, trámites incluidos, y usuarios). */
export const DIRECTORIOS_RECONDUCIDOS = [
  'flito-soat', 'flito-parametrizacion', 'flito-compuerta', 'flito-bolsas', 'flito-revisiones', 'flito-sync',
  'flito-excepciones', 'flito-ocr',
  'tramites', 'flito-tramites', 'flito-impuestos', 'flito-comparendos', 'flito-conciliacion',
  'flito-liquidacion', 'flito-logistica', 'flito-tablero', 'flito-bitacora', 'flito-derechos', 'users',
] as const;

/** Rutas de los 22 ficheros que NO llevan guarda de función y siguen igual (§4 del diseño). */
const LISTA_BLANCA = new Set([
  'tramites/identidad.routes.ts GET /info/:token',        // pública con limitador
  'tramites/identidad.routes.ts POST /completar/:token',  // pública con limitador
  'tramites/identidad.routes.ts POST /recortar-cedula',   // solo authMiddleware
  'users/users.routes.ts PATCH /:id/password',            // authMiddleware; la AJENA es guarda en línea
]);

/** En identidad no hay `router.use(authMiddleware)`: lo llevan estas 7 rutas, una a una. */
const AUTH_EN_RUTA_IDENTIDAD = [
  'GET /sse', 'POST /iniciar', 'POST /iniciar-partes', 'GET /estado/:tramiteId',
  'GET /documentos/:tramiteId', 'POST /certificado/:tramiteId', 'POST /recortar-cedula',
];

/** AC3 — las 15 comparaciones de ámbito que se quedan, y por qué. */
const AMBITO: { fichero: string; patron: RegExp; veces: number; porque: string }[] = [
  { fichero: 'flito-soat/flito-soat.service.ts', patron: /role === '(proveedor|cliente)'/g, veces: 4, porque: 'contextoSoat: proveedor ve lo suyo, cliente su compañía' },
  { fichero: 'flito-impuestos/flito-impuestos.routes.ts', patron: /role === 'gestor_impuestos'/g, veces: 1, porque: 'contextoImpuesto: organismos del gestor' },
  { fichero: 'flito-impuestos/flito-impuestos.service.ts', patron: /role === 'gestor_impuestos'/g, veces: 1, porque: 'contextoImpuesto: frontera por organismo' },
  { fichero: 'flito-impuestos/flito-recibos.service.ts', patron: /role === 'gestor_impuestos'/g, veces: 1, porque: 'recibos: frontera por organismo' },
  { fichero: 'tramites/transito-scope.ts', patron: /role (===|!==) '(admin|transito)'/g, veces: 2, porque: 'resolveTransitoScope: organismo del usuario de tránsito' },
  { fichero: 'tramites/transito-config.routes.ts', patron: /role === 'transito'/g, veces: 3, porque: 'organismo del transito al leer config, checklist y logo' },
  { fichero: 'flito-logistica/flito-logistica.service.ts', patron: /role === 'mensajero'/g, veces: 3, porque: 'el mensajero solo toca sus propias actas' },
];

function ficherosTs(dir: string): string[] {
  const salida: string[] = [];
  for (const nombre of readdirSync(dir)) {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) salida.push(...ficherosTs(ruta));
    else if (ruta.endsWith('.ts')) salida.push(ruta);
  }
  return salida;
}

const leer = (rel: string) => readFileSync(join(RAIZ_MODULOS, rel), 'utf8');
const FICHEROS_DE_RUTAS = FICHEROS_EN_ALCANCE.map((f) => f.fichero);

describe('AC1/AC2 — en los 19 directorios ya no decide ningún requireRole', () => {
  for (const dir of DIRECTORIOS_RECONDUCIDOS) {
    it(`${dir}/: cero requireRole( (fuera y dentro de comentarios) y cero import de requireRole`, () => {
      const conAparicion: string[] = [];
      for (const f of ficherosTs(join(RAIZ_MODULOS, dir))) {
        const fuente = readFileSync(f, 'utf8');
        if (/requireRole\(/.test(sinComentarios(fuente)) || /requireRole\(/.test(fuente)) conAparicion.push(f.replace(RAIZ_MODULOS, ''));
        if (/import[^;]*\brequireRole\b/.test(fuente)) conAparicion.push(`${f.replace(RAIZ_MODULOS, '')} (import)`);
      }
      expect(conAparicion).toEqual([]);
    });
  }

  it('los directorios del enunciado son 19 y los 22 ficheros de rutas del alcance viven en ellos', () => {
    expect(DIRECTORIOS_RECONDUCIDOS).toHaveLength(19);
    expect(FICHEROS_DE_RUTAS).toHaveLength(22);
    for (const f of FICHEROS_DE_RUTAS) {
      expect((DIRECTORIOS_RECONDUCIDOS as readonly string[]).includes(f.split('/')[0]!), f).toBe(true);
    }
  });
});

describe('AC1/AC2 — cada fichero de rutas importa exigirFuncion y ninguna ruta pierde authMiddleware', () => {
  for (const fichero of FICHEROS_DE_RUTAS) {
    it(`${fichero}`, () => {
      const fuente = sinComentarios(leer(fichero));
      expect(fuente).toMatch(/import \{[^}]*\bexigirFuncion\b[^}]*\} from '\.\.\/\.\.\/shared\/middleware\/exigir-funcion\.js';/);
      if (fichero === 'tramites/identidad.routes.ts') {
        for (const r of AUTH_EN_RUTA_IDENTIDAD) {
          const [metodo, ruta] = r.split(' ');
          const re = new RegExp(`router\\.${metodo!.toLowerCase()}\\(\\s*'${ruta!.replace(/[/:]/g, (c) => `\\${c}`)}'\\s*,\\s*authMiddleware\\b`);
          expect(fuente, `${fichero} ${r} lleva authMiddleware en la ruta`).toMatch(re);
        }
      } else {
        expect(fuente, `${fichero} conserva router.use(authMiddleware)`).toMatch(/router\.use\(\s*authMiddleware\s*\)/);
        expect(fuente).not.toMatch(/router\.use\([^)]*exigirFuncion/); // ADR-0016 §2: nunca a nivel de router
      }
    });
  }
});

describe('AC1/AC2 — cada router.<método>( de los 22 ficheros lleva exigirFuncion o está en la lista blanca', () => {
  const RUTA = /router\.(get|post|put|patch|delete)\(\s*'([^']*)'\s*,([\s\S]{0,500}?)(?:async\s*\(|\(\s*_?req\b|\(\s*\)\s*=>|\);)/g;

  for (const fichero of FICHEROS_DE_RUTAS) {
    it(`${fichero}`, () => {
      const fuente = sinComentarios(leer(fichero));
      const rutas = [...fuente.matchAll(RUTA)];
      expect(rutas.length, 'el fichero declara rutas').toBeGreaterThan(0);
      const sinGuarda = rutas
        .filter((m) => !/exigirFuncion\('[a-z_.]+'\)/.test(m[3]))
        .map((m) => `${fichero} ${m[1].toUpperCase()} ${m[2]}`)
        .filter((llave) => !LISTA_BLANCA.has(llave));
      expect(sinGuarda, 'rutas sin exigirFuncion que no están en la lista blanca').toEqual([]);
    });
  }

  it('la lista blanca son exactamente 4 rutas, y todas existen sin guarda de función', () => {
    expect(LISTA_BLANCA.size).toBe(4);
    for (const llave of LISTA_BLANCA) {
      const [fichero, metodo, ruta] = llave.split(' ');
      const fuente = sinComentarios(leer(fichero!));
      const re = new RegExp(`router\\.${metodo!.toLowerCase()}\\(\\s*'${ruta!.replace(/[/:]/g, (c) => `\\${c}`)}'\\s*,([\\s\\S]{0,300}?)(?:async\\s*\\(|\\(\\s*_?req\\b)`);
      const m = re.exec(fuente);
      expect(m, `${llave} existe`).not.toBeNull();
      expect(m![1]).not.toMatch(/exigirFuncion/);
    }
  });

  it('las dos guardas en línea están montadas con tieneFuncion(req, …) en su fichero', () => {
    expect(sinComentarios(leer('tramites/tramites.routes.ts'))).toMatch(/tieneFuncion\(req, 'tramite\.tramite\.forzar_continuar'\)/);
    expect(sinComentarios(leer('users/users.routes.ts'))).toMatch(/tieneFuncion\(req, 'usuarios\.contrasena\.cambiar_ajena'\)/);
  });
});

describe('el lector de montajes cubre la foto entera', () => {
  it('229 montajes = 217 de la #12081 + 11 de esta HU + 2 − 1 de la #12373; los códigos son exactamente los de la foto', () => {
    const montajes = montajesDeFunciones();
    expect(GUARDAS_MEDIDAS).toHaveLength(229);
    expect(montajes).toHaveLength(229);
    const codigoDeLlave = new Map(OPERACIONES_DECLARADAS.map((o) => [o.llave, o.codigo]));
    expect(montajes.map((m) => m.codigo).sort()).toEqual(GUARDAS_MEDIDAS.map((g) => codigoDeLlave.get(llaveDe(g))!).sort());
    expect(montajes.filter((m) => m.metodo === null)).toHaveLength(2);
  });

  it('un exigirFuncion sin literal hace que el lector LANCE en vez de adivinar', () => {
    // Se prueba sobre un fichero temporal en el scratchpad del test: no se toca ningún router.
    const dir = join(RAIZ_MODULOS, '..', '..', '__tests__', 'fixtures');
    const tmp = join(dir, 'permisos-montaje-no-literal.tmp.ts');
    writeFileSync(tmp, "router.get('/x', exigirFuncion(CODIGO), async (req, res) => {});\n", 'utf8');
    try {
      expect(() => leerMontajes({ modulo: 'x', fichero: 'permisos-montaje-no-literal.tmp.ts' }, dir)).toThrow(/no sé qué código/);
    } finally { unlinkSync(tmp); }
  });
});

describe('AC3 — el ámbito no se toca: las 15 comparaciones de rol que deciden QUÉ filas se ven siguen ahí', () => {
  for (const { fichero, patron, veces, porque } of AMBITO) {
    it(`${fichero}: ${veces} (${porque})`, () => {
      const fuente = sinComentarios(leer(fichero));
      expect(fuente.match(patron) ?? []).toHaveLength(veces);
    });
  }

  it('son 15 en total, y fuera de ellas solo quedan las del superRefine de users (HU #12088)', () => {
    expect(AMBITO.reduce((n, a) => n + a.veces, 0)).toBe(15);
    const enUsers = sinComentarios(leer('users/users.routes.ts')).match(/\brole (===|!==) '[a-z_]+'/g) ?? [];
    expect(enUsers.length).toBe(27);
    // Ninguna de las 26 compara `req.user`: son sobre el usuario EDITADO (`d.role`, `data.role`…).
    expect(sinComentarios(leer('users/users.routes.ts'))).not.toMatch(/req\.user!?\.role (===|!==)/);
  });
});
