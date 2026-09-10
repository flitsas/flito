// HU #12081 — El catálogo de funciones, comprobado sobre el CÓDIGO (AC2, AC2-bis, AC3, AC6).
//
// Aquí no hay base de datos y no hace falta: lo que se comprueba es lo que el catálogo AFIRMA antes
// de sembrarse. La otra mitad —que la base tiene exactamente esto y que el reparto reproduce el
// estado de hoy— vive en `__tests__/db/migracion-0179.test.ts`, que sí necesita PostgreSQL.
//
// **Ningún número escrito a mano decide nada aquí, salvo el 43.** El enunciado original de esta HU
// decía «46 constantes requireRole» y lo medido son 217 rutas guardadas; un test que hubiera fijado
// el 46 habría pasado en verde dejando fuera lo demás. Por eso los asertos de operaciones comparan
// CONJUNTOS contra la foto y contra los montajes leídos del fuente, no cardinales. El 43 sí se
// escribe: es 44 slugs de PAGES menos `flito_ayuda`, y ahí el número ES la afirmación del AC2-bis.
//
// Desde la HU #12083 las rutas ya no llevan `requireRole`: la fuente de los ROLES es la foto histórica
// `inventario.generado.ts` (congelada; se edita a mano solo con migración) y lo que se lee del fuente
// es el CÓDIGO montado con `exigirFuncion`/`tieneFuncion`. El invariante de doble sentido pasa a ser:
// por fichero, los montajes cubren EXACTAMENTE la foto.
import { describe, it, expect } from 'vitest';
import { PAGES, PAGE_GROUPS, USER_ROLES, paginasPorDefecto } from '@operaciones/shared-types';
import {
  catalogoCompleto, catalogoDePaginas, catalogoDeOperaciones, repartoDePartida,
  PAGINAS_NO_CONCEDIBLES, CatalogoIncoherenteError,
} from '../../src/modules/permisos/catalogo.js';
import {
  leerMontajes, llaveDe, FICHEROS_EN_ALCANCE,
} from '../../src/modules/permisos/inventario-guardas.js';
import { GUARDAS_MEDIDAS } from '../../src/modules/permisos/inventario.generado.js';
import {
  OPERACIONES_DECLARADAS, OPERACIONES_RETIRADAS_CANAL_CLIENTE,
} from '../../src/modules/permisos/catalogo-operaciones.js';
import { FUNCIONES_SIN_ADMIN } from '../../src/modules/permisos/permisos.service.js';

const catalogo = catalogoCompleto();
const paginas = catalogo.filter((f) => f.tipo === 'pagina');
const operaciones = catalogo.filter((f) => f.tipo === 'operacion');

describe('AC2-bis — los dos defectos del catálogo de origen, y el que no lo era', () => {
  it('`PAGE_GROUPS` trae 44 entradas para 43 slugs únicos: `transito` está dos veces', () => {
    const entradas = PAGE_GROUPS.flatMap((g) => g.pages);
    expect(entradas).toHaveLength(44);
    expect(new Set(entradas).size).toBe(43);
    const repetidos = entradas.filter((s, i) => entradas.indexOf(s) !== i);
    expect(repetidos).toEqual(['transito']);
  });

  it('la duplicación no se propaga: ni un código repetido en el catálogo', () => {
    const codigos = catalogo.map((f) => f.codigo);
    expect(new Set(codigos).size).toBe(codigos.length);
    // Y en particular la que lo provocaría: una sola función para `transito`.
    expect(codigos.filter((c) => c === 'pagina.transito')).toHaveLength(1);
  });

  it('`flito_ayuda` NO genera función de tipo `pagina`, y nadie la puede "arreglar"', () => {
    // El AC original mandaba meterla en PAGE_GROUPS por estar fuera; se corrigió el 9/09/2026. El
    // motivo está escrito encima de su declaración en permissions.ts: existe SOLO para el label de
    // NoAccess y el ítem de nav, y su visibilidad es DERIVADA (`puedeVerAyudaFlito`, la intersección
    // con el catálogo de fichas). Concederla a mano no habilita nada.
    //
    // Este caso es el clavo: si alguien la mete en PAGE_GROUPS o la saca de PAGINAS_NO_CONCEDIBLES,
    // se pone rojo y obliga a releer aquel comentario antes de "arreglarla".
    expect(PAGES).toHaveProperty('flito_ayuda');
    expect(PAGE_GROUPS.flatMap((g) => g.pages)).not.toContain('flito_ayuda');
    expect(PAGINAS_NO_CONCEDIBLES).toContain('flito_ayuda');
    expect(catalogo.map((f) => f.codigo)).not.toContain('pagina.flito_ayuda');
  });

  it('las funciones de tipo `pagina` son 43: los 44 slugs de PAGES menos `flito_ayuda`', () => {
    expect(Object.keys(PAGES)).toHaveLength(44);
    expect(paginas).toHaveLength(43);
    const esperados = Object.keys(PAGES).filter((s) => s !== 'flito_ayuda').sort();
    expect(paginas.map((f) => f.codigo.replace('pagina.', '')).sort()).toEqual(esperados);
  });
});

describe('AC2 — el catálogo, nombrado como lo nombra el negocio', () => {
  it('cada página lleva el label de PAGES como nombre de negocio', () => {
    for (const f of paginas) {
      const slug = f.codigo.replace('pagina.', '') as keyof typeof PAGES;
      expect(f.nombreNegocio).toBe(PAGES[slug]);
    }
  });

  it('ninguna función tiene descripción vacía, ni página ni operación', () => {
    const vacias = catalogo.filter((f) => !f.descripcion.trim()).map((f) => f.codigo);
    expect(vacias).toEqual([]);
  });

  it('cada función lleva módulo, y el de las operaciones prefija su código', () => {
    expect(catalogo.filter((f) => !f.modulo)).toEqual([]);
    for (const f of operaciones) expect(f.codigo.startsWith(`${f.modulo}.`)).toBe(true);
  });

  it('los códigos de operación tienen la forma <modulo>.<objeto>.<accion>', () => {
    const malFormados = operaciones.filter((f) => !/^[a-z_]+\.[a-z_]+\.[a-z_]+$/.test(f.codigo));
    expect(malFormados.map((f) => f.codigo)).toEqual([]);
  });

  it('los diez códigos SOAT que el AC nombra existen tal cual', () => {
    const codigos = new Set(catalogo.map((f) => f.codigo));
    for (const c of [
      'soat.cola.ver', 'soat.solicitud.crear', 'soat.solicitud.enviar', 'soat.solicitud.reversar',
      'soat.proveedor.cambiar', 'soat.soportes.descargar', 'soat.excel.exportar',
      'soat.comprobante.cargar', 'soat.masiva.cargar', 'soat.runt.preconsultar',
    ]) expect(codigos).toContain(c);
  });

  it('caben en las columnas que declara la 0179', () => {
    for (const f of catalogo) {
      expect(f.codigo.length).toBeLessThanOrEqual(80);
      expect(f.modulo.length).toBeLessThanOrEqual(40);
      expect(f.nombreNegocio.length).toBeLessThanOrEqual(120);
    }
  });
});

describe('AC2/AC6 — las operaciones salen de la foto, y los montajes del fuente la cubren exactamente', () => {
  const guardas = GUARDAS_MEDIDAS;
  const codigoDeLlave = new Map(OPERACIONES_DECLARADAS.map((o) => [o.llave, o.codigo]));

  it('por fichero, `leerMontajes` cubre EXACTAMENTE la foto: cada ruta de la foto lleva montado el código que el catálogo le declara, y no hay montaje fuera de la foto', () => {
    // El runtime NO relee los `.ts` —la imagen de producción no los lleva—, así que lo que decide en
    // arranque es `inventario.generado.ts`. Este caso es lo único que impide que esa foto se separe del
    // fuente: una ruta nueva con `exigirFuncion` y sin entrada en la foto (ni migración) se ve aquí;
    // una ruta de la foto que alguien deje sin guarda, también. Las guardas EN LÍNEA (`condicion`) se
    // comprueban por código: `tieneFuncion(req, '<codigo>')` aparece en su fichero.
    for (const f of FICHEROS_EN_ALCANCE) {
      const esperados = guardas.filter((g) => g.fichero === f.fichero).map((g) => {
        const codigo = codigoDeLlave.get(llaveDe(g));
        return g.condicion ? `${g.fichero} tieneFuncion → ${codigo}` : `${llaveDe(g)} → ${codigo}`;
      }).sort();
      const leidos = leerMontajes(f).map((m) => (m.metodo === null
        ? `${m.fichero} tieneFuncion → ${m.codigo}`
        : `${m.fichero} ${m.metodo} ${m.ruta} → ${m.codigo}`)).sort();
      expect(leidos, f.fichero).toEqual(esperados);
    }
  });

  it('hay exactamente una función por ruta de la foto, y ninguna de sobra', () => {
    // El aserto que el «46» del enunciado habría dejado pasar: conjuntos, no cardinales.
    expect(new Set(OPERACIONES_DECLARADAS.map((o) => o.llave)))
      .toEqual(new Set(guardas.map(llaveDe)));
    expect(operaciones).toHaveLength(guardas.length);
    expect(new Set(operaciones.map((f) => f.codigo)).size).toBe(guardas.length);
  });

  it('los roles de cada operación son LITERALMENTE los de su entrada en la foto', () => {
    const porLlave = new Map(guardas.map((g) => [llaveDe(g), g]));
    const declPorLlave = new Map(OPERACIONES_DECLARADAS.map((o) => [o.llave, o]));
    for (const f of operaciones) {
      const llave = [...declPorLlave.entries()].find(([, o]) => o.codigo === f.codigo)![0];
      expect(f.roles).toEqual(porLlave.get(llave)!.roles);
    }
  });

  it('la foto cubre el alcance del Feature —incluido `users/` desde la #12083— y NO se cuela `clients`, que queda fuera', () => {
    expect(FICHEROS_EN_ALCANCE.some((f) => f.fichero.startsWith('clients/'))).toBe(false);
    expect(new Set(guardas.map((g) => g.fichero))).toEqual(new Set(FICHEROS_EN_ALCANCE.map((f) => f.fichero)));
    expect(guardas.some((g) => g.fichero === 'users/users.routes.ts')).toBe(true);
  });

  it('una guarda sin nombre declarado revienta, y dice cuál', () => {
    const sobrante = [...guardas, {
      modulo: 'soat', fichero: 'flito-soat/flito-soat.routes.ts',
      metodo: 'POST' as const, ruta: '/inventada', roles: ['admin'], heredada: false,
    }];
    expect(() => catalogoDeOperaciones(sobrante)).toThrow(CatalogoIncoherenteError);
    expect(() => catalogoDeOperaciones(sobrante)).toThrow(/POST \/inventada/);
  });

  it('un nombre declarado sin guarda viva revienta también, que es el otro sentido', () => {
    const faltante = guardas.filter((g) => g.ruta !== '/enviar');
    expect(() => catalogoDeOperaciones(faltante)).toThrow(/SIN guarda viva/);
  });

  it('las dos guardas en línea van con su condición en la llave y no colisionan con la ruta que las contiene', () => {
    const enLinea = guardas.filter((g) => g.condicion);
    expect(enLinea.map(llaveDe).sort()).toEqual([
      'tramites/tramites.routes.ts PATCH /:id [_forzarContinuar]',
      'users/users.routes.ts PATCH /:id/password [ajena]',
    ]);
    expect(codigoDeLlave.get('tramites/tramites.routes.ts PATCH /:id')).toBe('tramite.tramite.editar');
    expect(codigoDeLlave.get('tramites/tramites.routes.ts PATCH /:id [_forzarContinuar]')).toBe('tramite.tramite.forzar_continuar');
  });
});

describe('AC3 — las cuatro operaciones del canal Cliente no existen, y no vuelven', () => {
  it('ninguna de las cuatro está en el catálogo', () => {
    const codigos = new Set(catalogo.map((f) => f.codigo));
    for (const c of OPERACIONES_RETIRADAS_CANAL_CLIENTE) expect(codigos).not.toContain(c);
  });

  it('ni queda rastro de validar, rechazar con causal, ver causales o subsanar en SOAT', () => {
    // Por si vuelven con otro nombre: se busca el verbo, no el código exacto.
    const soat = catalogo.filter((f) => f.codigo.startsWith('soat.'));
    const sospechosas = soat.filter((f) => /causal|subsan|\.validar$/.test(f.codigo));
    expect(sospechosas.map((f) => f.codigo)).toEqual([]);
  });
});

describe('AC4 — el reparto de partida reproduce el estado de hoy (CF-16)', () => {
  const reparto = repartoDePartida(catalogo);
  const porRol = (rol: string) => reparto.filter(([r]) => r === rol).map(([, c]) => c);

  it('cada rol de sistema tiene una fila `pagina.<slug>` por cada slug que hoy le concede su tabla', () => {
    for (const rol of USER_ROLES) {
      if (rol === 'admin') continue; // el admin va en su propio caso: ya no tiene fila en la tabla
      const esperadas = paginasPorDefecto(rol)
        .filter((s) => !PAGINAS_NO_CONCEDIBLES.includes(s))
        .map((s) => `pagina.${s}`).sort();
      const sembradas = porRol(rol).filter((c) => c.startsWith('pagina.')).sort();
      expect(sembradas, `páginas sembradas para ${rol}`).toEqual(esperadas);
    }
  });

  it('`admin` queda con TODAS las páginas concedibles marcadas una a una', () => {
    // Es la mitad que hace neutro retirar los dos atajos. Si esto se rompe, el administrador se
    // queda sin pantallas el día del merge: no es un test de forma, es el seguro de la HU.
    const suyas = porRol('admin').filter((c) => c.startsWith('pagina.')).sort();
    expect(suyas).toEqual(paginas.map((f) => f.codigo).sort());
    expect(suyas).toHaveLength(43);
  });

  it('`admin` tiene todas las operaciones salvo las tres del canal Cliente, que son de `cliente`', () => {
    const suyas = new Set(porRol('admin'));
    const sinAdmin = operaciones.filter((f) => !suyas.has(f.codigo)).map((f) => f.codigo).sort();
    expect(sinAdmin).toEqual([...FUNCIONES_SIN_ADMIN].sort());
    // Y no están huérfanas: son del canal Cliente, con `requireRole('cliente')` a secas.
    for (const c of sinAdmin) {
      expect(operaciones.find((f) => f.codigo === c)!.roles).toEqual(['cliente']);
    }
  });

  it('ningún rol recibe una función que no esté en el catálogo', () => {
    const codigos = new Set(catalogo.map((f) => f.codigo));
    for (const [, codigo] of reparto) expect(codigos).toContain(codigo);
  });

  it('todos los roles del reparto son roles que el producto conoce', () => {
    const roles = new Set(reparto.map(([r]) => r));
    for (const r of roles) expect(USER_ROLES).toContain(r as never);
  });
});

describe('AC6 — añadir una función obliga a decidir sobre `admin`', () => {
  it('la lista de excepciones nombra las tres, y solo las tres', () => {
    // Un `FUNCIONES_SIN_ADMIN` que crezca sin que nadie lo note es exactamente el fallo que el AC6
    // quiere evitar. Aquí se fija su contenido: ampliarla obliga a tocar este caso y explicarse.
    expect([...FUNCIONES_SIN_ADMIN].sort())
      .toEqual(['soat.factura.leer', 'soat.runt.preconsultar', 'soat.solicitud.crear']);
  });

  it('todas las excepciones existen de verdad en el catálogo', () => {
    const codigos = new Set(catalogo.map((f) => f.codigo));
    for (const c of FUNCIONES_SIN_ADMIN) expect(codigos).toContain(c);
  });
});

describe('el catálogo de páginas se agrupa por su grupo de PAGE_GROUPS', () => {
  it('cada página cae en el módulo de su primer grupo', () => {
    const porCodigo = new Map(catalogoDePaginas().map((f) => [f.codigo, f.modulo]));
    expect(porCodigo.get('pagina.dashboard')).toBe('general');
    expect(porCodigo.get('pagina.users')).toBe('administracion');
    // `transito` está en dos grupos; gana el primero, «Operaciones».
    expect(porCodigo.get('pagina.transito')).toBe('operaciones');
  });
});
