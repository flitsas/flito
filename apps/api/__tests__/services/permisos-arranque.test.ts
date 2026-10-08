// HU #12081 AC6 — `verificarCatalogoAlArrancar`: la red que avisa cuando el catálogo se desincroniza.
//
// Por qué este fichero existe: la comprobación de arranque es la única pieza del AC6 que corre en
// PRODUCCIÓN, y hasta ahora nadie comprobaba que detectase nada. Un envoltorio sin red puede dejar de
// dispararse en silencio —un `if` que nunca entra, una lista que siempre sale vacía— y el AC quedaría
// cumplido sobre el papel mientras el aviso no llega nunca. Lo que se prueba aquí es que DETECTA, en
// los dos sentidos, y que el mensaje NOMBRA el código concreto: un error que dijera «hay desajuste»
// sin decir cuál obligaría a reconstruir a mano las 260 funciones.
//
// Lo que este fichero NO cambia, y es deliberado: la comprobación **no tumba el proceso**. `server.ts`
// la llama y registra el fallo con `log.error`. Tumbar el API al arrancar por un desajuste de catálogo
// convertiría una pantalla mal repartida en una caída del producto entero — y además, mientras la
// #12082 no exista, ninguna guarda depende todavía de estas filas. La función lanza; quien decide qué
// hacer con eso es `server.ts`.
//
// El catálogo del CÓDIGO es real (`catalogoCompleto()`, 260 funciones); lo que se falsea es la BASE,
// que es lo que en producción puede llegar viejo o adelantado.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chain } from '../helpers/db.js';

const selectMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: { select: selectMock, insert: vi.fn(), update: vi.fn(), execute: vi.fn() },
  getPoolStats: vi.fn(),
}));

const permisosService = await import('../../src/modules/permisos/permisos.service.js');
const { verificarCatalogoAlArrancar, ArranquePermisosError } =
  await import('../../src/modules/permisos/permisos.service.js');
const { catalogoCompleto } = await import('../../src/modules/permisos/catalogo.js');

const CATALOGO = catalogoCompleto();
const CODIGOS = CATALOGO.map((f) => f.codigo);
const MODULO_DE = new Map(CATALOGO.map((f) => [f.codigo, f.modulo]));

/**
 * Encola la única consulta de la comprobación: el catálogo de la base (código y módulo).
 * HU #13424 (ADR-0022 §D1): ya no hay segunda ni tercera —el reparto de `admin`—, porque el arranque
 * dejó de exigir nada a `admin`.
 */
function conBase(
  codigosEnBase: string[],
  /** HU #12716: el módulo que la BASE declara por código; por defecto el del catálogo (base al día). */
  moduloEnBase: (codigo: string) => string = (codigo) => MODULO_DE.get(codigo) ?? 'inventado',
) {
  const filasCatalogo = codigosEnBase.map((codigo) => ({ codigo, modulo: moduloEnBase(codigo) }));
  selectMock.mockReturnValueOnce(chain(filasCatalogo));
}

beforeEach(() => { selectMock.mockReset(); });

describe('AC6 — la comprobación de arranque detecta el desajuste de catálogo', () => {
  it('con la base al día no protesta', async () => {
    conBase(CODIGOS);
    await expect(verificarCatalogoAlArrancar()).resolves.toBeUndefined();
  });

  // ── Sentido 1: el código exige algo que la base no declara ────────────────────────────────────
  it('una guarda que exige una función AUSENTE del catálogo se detecta y se nombra', async () => {
    // La base se quedó en la versión anterior: la guarda `POST /flito/soat/enviar` existe en el
    // código y su función no está sembrada. Es el caso real de desplegar el API sin aplicar la
    // migración que la trae.
    conBase(CODIGOS.filter((c) => c !== 'soat.solicitud.enviar'));

    await expect(verificarCatalogoAlArrancar()).rejects.toThrow(ArranquePermisosError);
    conBase(CODIGOS.filter((c) => c !== 'soat.solicitud.enviar'));
    await expect(verificarCatalogoAlArrancar())
      .rejects.toThrow(/El código exige y la base no declara \(1\): soat\.solicitud\.enviar/);
  });

  // ── Sentido 2: la base declara algo que ninguna guarda usa ────────────────────────────────────
  it('una función del catálogo que NINGUNA guarda usa se detecta y se nombra', async () => {
    // El sentido contrario, y el que se olvida: se retiró una ruta y su función quedó sembrada. Sin
    // esta mitad, el catálogo acumularía casillas que la pantalla de permisos ofrece conceder y que
    // no habilitan nada — exactamente el argumento por el que `flito_ayuda` no entra (AC2-bis).
    conBase([...CODIGOS, 'soat.revision.rechazar']);

    await expect(verificarCatalogoAlArrancar()).rejects.toThrow(ArranquePermisosError);
    conBase([...CODIGOS, 'soat.revision.rechazar']);
    await expect(verificarCatalogoAlArrancar())
      .rejects.toThrow(/La base declara y el código no usa \(1\): soat\.revision\.rechazar/);
  });

  it('los dos sentidos a la vez salen los dos en el mismo mensaje', async () => {
    // Si una de las dos direcciones dejara de calcularse, este caso seguiría en verde por la otra…
    // salvo que se exijan LAS DOS frases. Ese es el mutante que mata: borrar `faltan` o borrar
    // `sobran` deja aquí media verdad.
    conBase([...CODIGOS.filter((c) => c !== 'impuestos.cola.ver'), 'tramite.ocr.inventado']);
    const error = await verificarCatalogoAlArrancar().catch((e: Error) => e);

    expect(error).toBeInstanceOf(ArranquePermisosError);
    expect((error as Error).message).toMatch(/El código exige y la base no declara \(1\): impuestos\.cola\.ver/);
    expect((error as Error).message).toMatch(/La base declara y el código no usa \(1\): tramite\.ocr\.inventado/);
    // Y dice dónde se arregla, que es la mitad útil de un error de arranque.
    expect((error as Error).message).toMatch(/npm run permisos:seed -w apps\/api/);
  });

  it('la tabla vacía se nombra como lo que es —falta la migración— y no como 260 funciones perdidas', async () => {
    conBase([]);
    await expect(verificarCatalogoAlArrancar())
      .rejects.toThrow(/permisos_funciones está vacía: falta aplicar la migración 0179_permisos_modelo\.sql/);
  });
});

describe('HU #12716 AC7 — el arranque compara también el módulo de agrupación, fila a fila', () => {
  it('la base con los códigos correctos pero `pagina.flito_soat` aún en `flito_soat_e_impuestos` se detecta, se nombra y remite a la 0205', async () => {
    // El caso real: desplegar el binario de esta HU sin aplicar la 0205. Los códigos coinciden, así
    // que la comparación de códigos NO lo ve; solo la de módulo. Mutante nombrado: quitar la
    // comparación de `modulo` en `verificarCatalogoAlArrancar` → este caso resuelve en vez de caer.
    const viejo = (c: string) => (c === 'pagina.flito_soat' ? 'flito_soat_e_impuestos' : MODULO_DE.get(c)!);
    conBase(CODIGOS, viejo);
    const error = await verificarCatalogoAlArrancar().catch((e: Error) => e);

    expect(error).toBeInstanceOf(ArranquePermisosError);
    expect((error as Error).message).toMatch(/difiere entre la base y el código en 1 funciones/);
    expect((error as Error).message).toMatch(/«pagina\.flito_soat»: base «flito_soat_e_impuestos» → código «soat»/);
    expect((error as Error).message).toMatch(/0205_permisos_reagrupar_modulos\.sql/);
    expect((error as Error).message).toMatch(/--reagrupar/);
  });

  it('con más de diez diferencias se listan diez y se cuenta el resto, sin volcar el catálogo entero', async () => {
    // La base ANTES de la 0205: las 46 filas con el módulo estructural. Se simula devolviendo el
    // módulo viejo para las 23 páginas reagrupadas y el prefijo del código para las operaciones.
    const { reagrupaciones } = await import('../../src/modules/permisos/catalogo-agrupacion.js');
    const reagrupadas = new Set(reagrupaciones().map(([c]) => c));
    const viejo = (c: string) => {
      if (!reagrupadas.has(c)) return MODULO_DE.get(c)!;
      return c.startsWith('pagina.') ? 'grupo_viejo' : c.slice(0, c.indexOf('.'));
    };
    conBase(CODIGOS, viejo);
    const error = await verificarCatalogoAlArrancar().catch((e: Error) => e);

    expect(error).toBeInstanceOf(ArranquePermisosError);
    // 47 pares en el mapa; `pagina.transito_organismos` se simula con `grupo_viejo`, así que aquí
    // difieren las 47 (es la simulación, no la 0205: la 0205 cambia 46).
    expect((error as Error).message).toMatch(/difiere entre la base y el código en 47 funciones/);
    expect((error as Error).message).toMatch(/… y 37 más/);
    expect(((error as Error).message.match(/^\s+«/gm) ?? [])).toHaveLength(10);
  });

  it('con la base al día (misma agrupación que el código) no protesta, y el mensaje de códigos sigue mandando si faltan códigos', async () => {
    conBase(CODIGOS);
    await expect(verificarCatalogoAlArrancar()).resolves.toBeUndefined();
    // Si además falta un código, se reporta la falta de código (la comparación de módulo va después).
    conBase(CODIGOS.filter((c) => c !== 'soat.solicitud.enviar'), () => 'lo_que_sea');
    await expect(verificarCatalogoAlArrancar())
      .rejects.toThrow(/El código exige y la base no declara \(1\): soat\.solicitud\.enviar/);
  });
});

describe('HU #13424 AC1 — `admin` es editable: el arranque no exige nada de su reparto', () => {
  it('con la base al día arranca leyendo SOLO el catálogo, sin consultar qué tiene `admin`', async () => {
    // Antes: una segunda y tercera lectura (`funcionesSinAdmin`) y un `ArranquePermisosError` si al
    // rol `admin` le faltaba una función en la base viva — desmarcarle P desde el panel dejaba la API
    // sin arrancar en el siguiente reinicio. Mutante nombrado: volver a leer `permisos_rol_funcion`
    // aquí → `selectMock` se llama dos veces (y la cola, vacía, rompe la comprobación).
    conBase(CODIGOS);
    await expect(verificarCatalogoAlArrancar()).resolves.toBeUndefined();
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('el servicio ya no exporta la lista de excepciones de `admin` ni su lector', () => {
    expect(permisosService).not.toHaveProperty('FUNCIONES_SIN_ADMIN');
    expect(permisosService).not.toHaveProperty('funcionesSinAdmin');
  });
});
