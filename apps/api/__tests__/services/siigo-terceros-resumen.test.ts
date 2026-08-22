// HU #11299, AC3 — la tercera cifra: cuántos clientes tienen tercero vinculado en Siigo.
//
// El AC pide tres números en la misma frase («cuántos están listos para facturar, cuántos no lo
// están y cuántos tienen tercero vinculado en Siigo») y solo existían dos: `GET /clientes/validacion`
// daba el veredicto de facturabilidad y NADIE contaba los vínculos. `GET /terceros/cliente/:id`
// responde por uno; el panel no puede preguntarlo 294 veces para pintar una cifra.
//
// **Por qué este archivo compila SQL de verdad en vez de mockear `db`.** Lo que hay que sostener
// aquí no es que la función devuelva lo que el mock le acaba de dar —eso no comprueba nada—, sino
// las tres decisiones que solo viven dentro de la consulta y que un mock de `db.select()` no puede
// ver: que cuenta CLIENTES distintos y no filas, que el universo es el mismo que el del resumen de
// facturabilidad, y que cuenta en Postgres y no trayéndose el padrón a Node. Se reutiliza el montaje
// de `siigo-catalogos-sql.test.ts`: un drizzle real sobre el driver `pg-proxy`, que compila con el
// mismo dialecto de producción y entrega `(sql, params)` en vez de abrir un socket.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/pg-proxy';

interface Sentencia { sql: string; params: unknown[] }

const sentencias: Sentencia[] = [];

/**
 * Filas que devuelve la siguiente consulta, en formato POSICIONAL: pg-proxy entrega al mapeador de
 * drizzle un arreglo de valores por fila, en el orden de las columnas seleccionadas.
 *
 * Los conteos se encolan como CADENA a propósito. `count()` en Postgres es `bigint` y el driver lo
 * entrega como texto para no perder precisión; si la consulta dejara de pasar por el mapeador de
 * drizzle, el panel recibiría `"294"` en vez de `294` y lo pintaría igual — hasta que alguien
 * intentara sumar o comparar. Encolar números aquí habría dado por buena esa versión.
 */
let filasEncoladas: unknown[][] = [];

const proxy = drizzle(async (sql: string, params: unknown[]) => {
  sentencias.push({ sql, params });
  const filas = filasEncoladas;
  filasEncoladas = [];
  return { rows: filas };
});

const dbFalsa: Record<string, unknown> = {
  select: proxy.select.bind(proxy),
  insert: proxy.insert.bind(proxy),
  update: proxy.update.bind(proxy),
  delete: proxy.delete.bind(proxy),
  execute: proxy.execute.bind(proxy),
  transaction: async (cb: (tx: unknown) => unknown) => cb(dbFalsa),
};

vi.mock('../../src/db/client.js', () => ({ db: dbFalsa, getPoolStats: vi.fn() }));

vi.mock('../../src/modules/siigo/siigo.operaciones.repo.js', () => ({
  registrarOperacion: vi.fn().mockResolvedValue(undefined),
}));

const { resumenTerceros } = await import('../../src/modules/siigo/siigo.terceros.service.js');
const { resumenValidacionClientes } = await import(
  '../../src/modules/siigo/siigo.validador-cliente.service.js'
);

/** La única sentencia que se compiló, normalizada a una línea y en minúsculas. */
function sentenciaUnica(): Sentencia {
  expect(sentencias, 'se esperaba una sola consulta').toHaveLength(1);
  return { ...sentencias[0]!, sql: sentencias[0]!.sql.replace(/\s+/g, ' ').trim().toLowerCase() };
}

beforeEach(() => {
  sentencias.length = 0;
  filasEncoladas = [];
});

describe('AC3 — la cifra que faltaba sale de la base, no de Node', () => {
  it('devuelve el total de clientes y cuántos tienen tercero', async () => {
    filasEncoladas = [['294', '181']];

    expect(await resumenTerceros()).toEqual({ totalClientes: 294, conTercero: 181 });
  });

  it('los conteos llegan como número aunque Postgres los mande como `bigint` en texto', async () => {
    // `count()` es `bigint`: el driver lo entrega como cadena. `countDistinct` lo pasa por
    // `mapWith(Number)`; sin ese camino el panel recibiría `"294"` y lo pintaría igual hasta que
    // alguien intentara compararlo.
    filasEncoladas = [['294', '181']];
    const r = await resumenTerceros();

    expect(typeof r.totalClientes).toBe('number');
    expect(typeof r.conTercero).toBe('number');
  });

  it('cuenta en una sola consulta y no se trae ni una fila del padrón', async () => {
    // El anti-patrón que esto descarta: `select().from(clients)` + `filas.length`. Con 294 clientes
    // funciona y se nota poco; es la misma forma que ya hace lento al resumen de facturabilidad.
    filasEncoladas = [['294', '181']];
    await resumenTerceros();

    const { sql } = sentenciaUnica();
    expect(sql).toContain('count(distinct');
    expect(sql).not.toContain('"clients"."name"');
    expect(sql).not.toContain('"clients"."document"');
  });

  it('cuenta CLIENTES distintos, no filas de `siigo_terceros`', async () => {
    // La clave real del tercero en Siigo es identificación + sucursal. Hoy `idx_siigo_terceros_cliente`
    // impone una fila por cliente, pero eso es una decisión de ESTE esquema: el día que se modelen
    // sucursales por cliente, un `count(*)` sobre el LEFT JOIN contaría filas y `conTercero` podría
    // superar a `totalClientes` sin que nadie entendiera por qué.
    filasEncoladas = [['294', '181']];
    await resumenTerceros();

    const { sql } = sentenciaUnica();
    expect(sql).toContain('count(distinct "clients"."id")');
    expect(sql).toContain('count(distinct "siigo_terceros"."client_id")');
    expect(sql).not.toMatch(/count\(\*\)/);
  });

  it('el vínculo se cuenta con LEFT JOIN: un cliente sin tercero sigue estando en el total', async () => {
    // Con `innerJoin` el total dejaría de ser el padrón y pasaría a ser «los que ya están
    // vinculados»: las dos cifras serían siempre iguales y la tarjeta no diría nada.
    filasEncoladas = [['294', '181']];
    await resumenTerceros();

    const { sql } = sentenciaUnica();
    expect(sql).toContain('left join "siigo_terceros"');
    expect(sql).toContain('"siigo_terceros"."client_id" = "clients"."id"');
    expect(sql).not.toContain('inner join');
  });

  it('cero vinculados es cero, no un hueco', async () => {
    // El primer día del panel: hay cartera y no hay ni un tercero. `count(distinct col)` sobre un
    // LEFT JOIN sin coincidencias devuelve 0 —no NULL—, y la tarjeta tiene que pintar «0 de 294».
    filasEncoladas = [['294', '0']];

    expect(await resumenTerceros()).toEqual({ totalClientes: 294, conTercero: 0 });
  });

  it('una cartera vacía devuelve dos ceros y no revienta', async () => {
    filasEncoladas = [['0', '0']];

    expect(await resumenTerceros()).toEqual({ totalClientes: 0, conTercero: 0 });
  });
});

describe('el universo es el mismo que el del resumen de facturabilidad', () => {
  it('filtra por cliente activo, igual que `ResumenValidacionClientes.total`', async () => {
    filasEncoladas = [['294', '181']];
    await resumenTerceros();

    const { sql, params } = sentenciaUnica();
    expect(sql).toContain('where "clients"."active" = $1');
    expect(params).toEqual([true]);
  });

  it('las dos consultas compilan EL MISMO `where`: comparten el criterio, no lo copian', async () => {
    // Es la prueba que sostiene la tarjeta. `totalClientes` y `ResumenValidacionClientes.total` se
    // pintan uno al lado del otro; si cada consulta decidiera por su cuenta a quién mira, un día
    // alguien añadiría un filtro aquí y no allá y las dos cifras se contradirían sin que ninguna
    // estuviera «mal». Se comparan los `where` compilados, no el nombre de la constante: renombrar
    // `CLIENTE_ACTIVO` no debe romper esto, pero divergir sí.
    filasEncoladas = [['294', '181']];
    await resumenTerceros();
    const dosCifras = sentenciaUnica();

    sentencias.length = 0;
    filasEncoladas = [];
    await resumenValidacionClientes();
    const facturabilidad = {
      ...sentencias[0]!,
      sql: sentencias[0]!.sql.replace(/\s+/g, ' ').trim().toLowerCase(),
    };

    const whereDe = (sql: string) => sql.slice(sql.indexOf('where '));
    expect(whereDe(dosCifras.sql)).toBe(whereDe(facturabilidad.sql));
    expect(dosCifras.params).toEqual(facturabilidad.params);
  });

  it('no llama a Siigo (AC6): la cifra sale de la copia local', async () => {
    // Contar vínculos consultando `/v1/customers` gastaría cuota de la misma ventana que emite las
    // facturas, y por una cifra que el panel pide cada vez que se abre.
    const fetchEspia = vi.fn();
    vi.stubGlobal('fetch', fetchEspia);
    filasEncoladas = [['294', '181']];

    await resumenTerceros();

    expect(fetchEspia).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
