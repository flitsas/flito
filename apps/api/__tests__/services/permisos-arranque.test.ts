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

const { verificarCatalogoAlArrancar, ArranquePermisosError, FUNCIONES_SIN_ADMIN } =
  await import('../../src/modules/permisos/permisos.service.js');
const { catalogoCompleto } = await import('../../src/modules/permisos/catalogo.js');

const CATALOGO = catalogoCompleto();
const CODIGOS = CATALOGO.map((f) => f.codigo);

/**
 * Encola las tres consultas de la comprobación en su orden: el catálogo de la base, y las dos de
 * `funcionesSinAdmin()` (el catálogo otra vez y el reparto entero).
 *
 * `repartoAdmin` por defecto le concede a `admin` todo el catálogo menos las tres del canal Cliente,
 * que es el estado sano — así los casos de desajuste de catálogo fallan por el catálogo y no por
 * arrastrar de paso un `admin` incompleto.
 */
function conBase(codigosEnBase: string[], repartoAdmin = codigosEnBase.filter((c) => !FUNCIONES_SIN_ADMIN.includes(c))) {
  const filasCatalogo = codigosEnBase.map((codigo) => ({ codigo }));
  selectMock
    .mockReturnValueOnce(chain(filasCatalogo))
    .mockReturnValueOnce(chain(filasCatalogo))
    .mockReturnValueOnce(chain(repartoAdmin.map((codigo) => ({ rol: 'admin', codigo }))));
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

describe('AC6 — añadir una función obliga a decidir sobre `admin`', () => {
  it('una función que `admin` no tiene concedida se detecta y se nombra', async () => {
    // El catálogo y la base coinciden; lo que falta es la marca de `admin`. Es el desajuste que no
    // rompe nada visible el día del despliegue y deja al administrador sin una pantalla.
    const sinUna = CODIGOS.filter((c) => !FUNCIONES_SIN_ADMIN.includes(c) && c !== 'pagina.users');
    conBase(CODIGOS, sinUna);

    const error = await verificarCatalogoAlArrancar().catch((e: Error) => e);
    expect(error).toBeInstanceOf(ArranquePermisosError);
    expect((error as Error).message).toMatch(/El rol admin no tiene concedidas 1 funciones del catálogo: pagina\.users/);
    expect((error as Error).message).toMatch(/FUNCIONES_SIN_ADMIN/);
  });

  it('las tres del canal Cliente NO protestan: están declaradas con su motivo', async () => {
    conBase(CODIGOS);
    await expect(verificarCatalogoAlArrancar()).resolves.toBeUndefined();
    // Y son exactamente las tres, no «las que falten»: el reparto encolado no incluye ninguna.
    expect([...FUNCIONES_SIN_ADMIN].sort())
      .toEqual(['soat.factura.leer', 'soat.runt.preconsultar', 'soat.solicitud.crear']);
  });

  it('las filas de OTROS roles no cuentan como concesión a `admin`', async () => {
    // `funcionesSinAdmin` filtra por `rol === 'admin'`. Sin ese filtro, el reparto de `auditor`
    // taparía el hueco de `admin` y el aviso no llegaría nunca.
    const filasCatalogo = CODIGOS.map((codigo) => ({ codigo }));
    selectMock
      .mockReturnValueOnce(chain(filasCatalogo))
      .mockReturnValueOnce(chain(filasCatalogo))
      .mockReturnValueOnce(chain(CODIGOS.map((codigo) => ({ rol: 'auditor', codigo }))));

    // Todas las del catálogo menos las tres del canal Cliente: el número sale del catálogo, no se
    // escribe a mano (la HU #12083 lo subió de 257 a 268 al añadir 11 funciones).
    const esperadas = CODIGOS.length - FUNCIONES_SIN_ADMIN.length;
    await expect(verificarCatalogoAlArrancar())
      .rejects.toThrow(new RegExp(`El rol admin no tiene concedidas ${esperadas} funciones del catálogo`));
  });
});
