// Feature #13978, HU #14100 AC3 (ADR-0034 D2, D4) — comprobación de llaves al arrancar. La BD es un
// doble en memoria que lee el filtro por versión que Drizzle genera; la primitiva de cifrado no se dobla.
// HU #14273 AC3: un valor con forma del formato viejo no entra a la muestra ni tumba el arranque.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import { getTableName, type SQL, type Table } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  registro: new Map<number, string>(),
  datos: {} as Record<string, Record<string, unknown>[]>,
  inserciones: 0,
  antesDeInsertar: null as null | ((version: number) => void),
  sqlPorTabla: {} as Record<string, string[]>,
  log: { info: vi.fn(), fatal: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const dialect = new PgDialect();

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: () => {
      let tabla = '';
      let version: number | null = null;
      // El patrón de las fotos se evalúa de verdad: es el que deja fuera el formato retirado.
      let patron: RegExp | null = null;
      const q = {
        from: (t: Table) => { tabla = getTableName(t); return q; },
        where: (cond: SQL) => {
          const { sql, params } = dialect.sqlToQuery(cond);
          (m.sqlPorTabla[tabla] ??= []).push(sql);
          if (tabla === 'pii_key_registry') version = Number(params[0]);
          const literal = / ~ '([^']+)'/.exec(sql)?.[1];
          if (literal) patron = new RegExp(literal);
          return q;
        },
        limit: () => q,
        then: (ok: (v: unknown) => unknown, fallo?: (e: unknown) => unknown) => {
          const filas = tabla === 'pii_key_registry'
            ? [...m.registro].filter(([v]) => version === null || v === version).map(([v, canario]) => ({ version: v, canario }))
            : (m.datos[tabla] ?? []).filter((f) => !patron || patron.test(String(f.valor)));
          return Promise.resolve(filas).then(ok, fallo);
        },
      };
      return q;
    },
    insert: () => ({
      values: (v: { version: number; canario: string }) => ({
        onConflictDoNothing: async () => {
          m.antesDeInsertar?.(v.version);
          if (!m.registro.has(v.version)) { m.registro.set(v.version, v.canario); m.inserciones += 1; }
        },
      }),
    }),
  },
}));

vi.mock('../../src/shared/logger.js', () => ({
  logger: m.log,
  loggerFor: () => m.log,
  REDACT_PATHS: [],
}));

import { env } from '../../src/config/env.js';
import {
  comprobarLlavesPiiAlArrancar, LlavePiiError, verificarLlavesPii,
} from '../../src/modules/privacy/rotacion/comprobar-llaves.js';
import { encryptCounterpartyField } from '../../src/modules/laft/employees/counterparty-pii.js';
import { protegerDocumento } from '../../src/modules/flito-logistica/flito-logistica.cifrado.js';
import { encryptPii, encryptPiiText, encryptPiiTextConVersion } from '../../src/shared/utils/crypto.js';

const envMutable = env as unknown as { PII_ENC_KEY: string | undefined; PII_ENC_KEY_CURRENT_VERSION: number };
const LLAVE_A = env.PII_ENC_KEY as string;
const LLAVE_B = 'a7f3c91e5d20b84f6e13d7a9c0428fb5e16d3a7c94f08b2d';
const LLAVE_OTRA = '5be2049fd1c76a38e9f04b1d7c62a85310de94fb76c1a2e8';
const ctxCanario = (version: number) => ({ table: 'pii_key_registry', column: 'canario', id: version });
const CANARIO = 'flito-pii-canario';
/** Forma `iv:tag:data` del formato retirado, como la dejaría un dump restaurado. */
const VALOR_VIEJO = '00112233445566778899aabbccddeeff:ffeeddccbbaa99887766554433221100:deadbeef';

/** El canario que habría dejado otra llave: se cifra con ella y se vuelve a la configuración del caso. */
function canarioDeOtraLlave(version: number, pasada: string): string {
  const v1 = envMutable.PII_ENC_KEY;
  const vn = process.env[`PII_ENC_KEY_V${version}`];
  if (version === 1) envMutable.PII_ENC_KEY = pasada;
  else process.env[`PII_ENC_KEY_V${version}`] = pasada;
  const canario = encryptPiiTextConVersion(CANARIO, ctxCanario(version), version);
  envMutable.PII_ENC_KEY = v1;
  if (version !== 1) {
    if (vn === undefined) delete process.env[`PII_ENC_KEY_V${version}`];
    else process.env[`PII_ENC_KEY_V${version}`] = vn;
  }
  return canario;
}

function filaConductor(userId: number, plano = '1036640908') {
  const aadNonce = '11111111-2222-4333-8444-555555555555';
  const b = encryptPii(plano, { table: 'driver_profile', column: 'cedula', empresaNit: String(userId), aadNonce });
  return { userId, cipher: b.cipher, iv: b.iv, authTag: b.authTag, aadNonce, keyVersion: b.keyVersion };
}

const conLlaveOtra = <T>(cifrar: () => T): T => {
  envMutable.PII_ENC_KEY = LLAVE_OTRA;
  try { return cifrar(); } finally { envMutable.PII_ENC_KEY = LLAVE_A; }
};

const motivoDe = async () => {
  const e = await verificarLlavesPii().then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(LlavePiiError);
  return (e as LlavePiiError).motivo;
};

beforeEach(() => {
  m.registro.clear();
  m.datos = {};
  m.inserciones = 0;
  m.antesDeInsertar = null;
  m.sqlPorTabla = {};
  for (const fn of Object.values(m.log)) fn.mockClear();
  envMutable.PII_ENC_KEY = LLAVE_A;
  envMutable.PII_ENC_KEY_CURRENT_VERSION = 1;
  delete process.env.PII_ENC_KEY_V2;
  delete process.env.PII_ENC_KEY_V3;
});

afterEach(() => {
  envMutable.PII_ENC_KEY = LLAVE_A;
  envMutable.PII_ENC_KEY_CURRENT_VERSION = 1;
  delete process.env.PII_ENC_KEY_V2;
  delete process.env.PII_ENC_KEY_V3;
  vi.restoreAllMocks();
});

describe('registro de canarios', () => {
  it('sin datos y sin registro: registra V1 y arranca', async () => {
    const r = await verificarLlavesPii();
    expect(r).toEqual({ versionVigente: 1, versionesConfiguradas: [1], versionesRegistradas: [1] });
    expect(m.registro.get(1)?.startsWith('v1:')).toBe(true);
  });

  it('el canario no lleva el texto plano ni ninguna llave', async () => {
    await verificarLlavesPii();
    const canario = m.registro.get(1) as string;
    for (const prohibido of [CANARIO, LLAVE_A]) expect(canario).not.toContain(prohibido);
  });

  it('segundo arranque: verifica y no vuelve a escribir', async () => {
    await verificarLlavesPii();
    await verificarLlavesPii();
    expect(m.inserciones).toBe(1);
  });

  it('V2 configurada y vigente 1: registra las dos y la vigente sigue en 1', async () => {
    process.env.PII_ENC_KEY_V2 = LLAVE_B;
    const r = await verificarLlavesPii();
    expect(r.versionVigente).toBe(1);
    expect(r.versionesRegistradas).toEqual([1, 2]);
    expect(m.registro.get(2)?.startsWith('v2:')).toBe(true);
  });

  it('una fila de una versión ya retirada no estorba', async () => {
    m.registro.set(1, canarioDeOtraLlave(1, LLAVE_A));
    process.env.PII_ENC_KEY_V2 = LLAVE_B;
    envMutable.PII_ENC_KEY = undefined;
    envMutable.PII_ENC_KEY_CURRENT_VERSION = 2;
    const r = await verificarLlavesPii();
    expect(r.versionesConfiguradas).toEqual([2]);
    expect(r.versionesRegistradas).toEqual([1, 2]);
  });
});

describe('AC3: una llave mal configurada no arranca', () => {
  it('canario que no descifra', async () => {
    m.registro.set(1, canarioDeOtraLlave(1, LLAVE_OTRA));
    expect(await motivoDe()).toBe('canario_no_descifra');
  });

  it('V2 con una llave distinta a la registrada', async () => {
    process.env.PII_ENC_KEY_V2 = LLAVE_B;
    m.registro.set(2, canarioDeOtraLlave(2, LLAVE_OTRA));
    expect(await motivoDe()).toBe('canario_no_descifra');
  });

  it('un canario con el prefijo de otra versión no vale, aunque la llave exista', async () => {
    process.env.PII_ENC_KEY_V2 = LLAVE_B;
    m.registro.set(1, encryptPiiTextConVersion('flito-pii-canario', { table: 'pii_key_registry', column: 'canario', id: 1 }, 2));
    expect(await motivoDe()).toBe('canario_no_descifra');
  });

  it('llave retirada reutilizada como versión nueva', async () => {
    m.registro.set(2, canarioDeOtraLlave(2, LLAVE_OTRA));
    process.env.PII_ENC_KEY_V3 = LLAVE_OTRA;
    expect(await motivoDe()).toBe('llave_retirada');
    expect(m.registro.has(3)).toBe(false);
  });

  it('la versión 1 reutilizada como versión nueva, con V1 aún en el registro', async () => {
    m.registro.set(1, canarioDeOtraLlave(1, LLAVE_OTRA));
    envMutable.PII_ENC_KEY = undefined;
    process.env.PII_ENC_KEY_V2 = LLAVE_OTRA;
    expect(await motivoDe()).toBe('llave_retirada');
  });

  it('dos réplicas con V2 distinta: la segunda no arranca', async () => {
    process.env.PII_ENC_KEY_V2 = LLAVE_B;
    m.antesDeInsertar = (v) => { if (v === 2) m.registro.set(2, canarioDeOtraLlave(2, LLAVE_OTRA)); };
    expect(await motivoDe()).toBe('divergencia_entre_replicas');
  });

  it('dos réplicas con la misma V2: arrancan las dos', async () => {
    process.env.PII_ENC_KEY_V2 = LLAVE_B;
    m.antesDeInsertar = (v) => { if (v === 2) m.registro.set(2, encryptPiiTextConVersion(CANARIO, ctxCanario(2), 2)); };
    await expect(verificarLlavesPii()).resolves.toMatchObject({ versionesRegistradas: [1, 2] });
  });
});

describe('primer registro de la versión 1: muestra de datos reales', () => {
  it('si nada descifra, no arranca y no registra', async () => {
    m.datos.driver_profile = conLlaveOtra(() => [filaConductor(1), filaConductor(2)]);
    expect(await motivoDe()).toBe('muestra_no_descifra');
    expect(m.registro.size).toBe(0);
  });

  it('si descifra, registra', async () => {
    m.datos.driver_profile = [filaConductor(1)];
    await verificarLlavesPii();
    expect(m.registro.has(1)).toBe(true);
  });

  it('una fila corrupta suelta no frena el arranque: basta un éxito', async () => {
    m.datos.driver_profile = [...conLlaveOtra(() => [filaConductor(1)]), filaConductor(2)];
    await verificarLlavesPii();
    expect(m.registro.has(1)).toBe(true);
  });

  it('con V1 ya registrada no vuelve a mirar la muestra', async () => {
    m.registro.set(1, encryptPiiTextConVersion(CANARIO, ctxCanario(1), 1));
    m.datos.driver_profile = conLlaveOtra(() => [filaConductor(1)]);
    await expect(verificarLlavesPii()).resolves.toBeTruthy();
  });

  it('cada formato prueba la llave con la AAD de su columna', async () => {
    const uuid = '99999999-2222-4333-8444-555555555555';
    const manifiesto = () => {
      const aadNonce = uuid;
      const b = encryptPii('cuenta', { table: 'manifiestos', column: 'titular_pago_cuenta', empresaNit: 'M-1', aadNonce });
      return { numero: 'M-1', cipher: b.cipher, iv: b.iv, authTag: b.authTag, aadNonce, keyVersion: b.keyVersion };
    };
    const contraparte = () => ({ id: 4, enc: encryptCounterpartyField('900', 'doc_number', 4) });
    const firma = () => ({ id: uuid, cifrado: protegerDocumento('123', uuid).cifrado });
    const foto = () => ({ id: 9, valor: encryptPiiText('foto', { table: 'tramites_validaciones', column: 'foto_rostro', id: 9 }) });
    const casos: [string, () => Record<string, unknown>][] = [
      ['manifiestos', manifiesto], ['laft_counterparties', contraparte], ['flito_logistica_acta_firmas', firma],
      ['flito_logistica_recogida_firmantes', firma], ['tramites_validaciones', foto],
    ];
    for (const [tabla, fila] of casos) {
      m.registro.clear();
      m.datos = { [tabla]: [conLlaveOtra(fila)] };
      expect(await motivoDe(), tabla).toBe('muestra_no_descifra');
      m.datos = { [tabla]: [fila()] };
      await expect(verificarLlavesPii(), tabla).resolves.toBeTruthy();
    }
  });

  it('un valor viejo restaurado no entra a la muestra: sin más datos, registra la llave', async () => {
    m.datos = { tramites_validaciones: [{ id: 9, valor: VALOR_VIEJO }] };

    await expect(verificarLlavesPii()).resolves.toBeTruthy();

    expect(m.inserciones).toBe(1);
  });

  it('el valor viejo no enmascara una llave equivocada: lo vigente de otra llave sigue fallando', async () => {
    const deOtraLlave = conLlaveOtra(() => encryptPiiText('foto', { table: 'tramites_validaciones', column: 'foto_rostro', id: 9 }));
    m.datos = { tramites_validaciones: [{ id: 8, valor: VALOR_VIEJO }, { id: 9, valor: deOtraLlave }] };

    expect(await motivoDe()).toBe('muestra_no_descifra');
  });

  it('solo muestrea valores de la versión 1 y nunca toca bolsas (MinIO)', async () => {
    await verificarLlavesPii();
    expect(m.sqlPorTabla.driver_profile?.[0]).toContain('"cedula_key_version" is null or "driver_profile"."cedula_key_version" = $1');
    expect(m.sqlPorTabla.laft_counterparties?.[0]).toContain("->>'keyVersion' = '1'");
    expect(m.sqlPorTabla.flito_logistica_acta_firmas?.[0]).toContain("LIKE 'v1:1:%'");
    expect(m.sqlPorTabla.flito_bolsas_documentos).toBeUndefined();
  });
});

describe('punto de entrada de `server.ts`', () => {
  const espiarSalida = () => vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

  it('un valor viejo restaurado no tumba el arranque: ni `log.fatal` ni salida', async () => {
    const salida = espiarSalida();
    m.datos = { tramites_validaciones: [{ id: 9, valor: VALOR_VIEJO }] };

    await comprobarLlavesPiiAlArrancar();

    expect(salida).not.toHaveBeenCalled();
    expect(m.log.fatal).not.toHaveBeenCalled();
  });

  it('fallo: `log.fatal` sin valores y salida 1', async () => {
    const salida = espiarSalida();
    process.env.PII_ENC_KEY_V2 = LLAVE_B;
    m.registro.set(1, canarioDeOtraLlave(1, LLAVE_OTRA));
    await comprobarLlavesPiiAlArrancar();
    expect(salida).toHaveBeenCalledWith(1);
    expect(m.log.fatal).toHaveBeenCalledOnce();
    const texto = JSON.stringify(m.log.fatal.mock.calls);
    expect(texto).toContain('canario_no_descifra');
    for (const valor of [LLAVE_A, LLAVE_B, LLAVE_OTRA, m.registro.get(1) as string]) expect(texto).not.toContain(valor);
  });

  it('éxito: una línea con versiones y sin valores, y no sale', async () => {
    const salida = espiarSalida();
    process.env.PII_ENC_KEY_V2 = LLAVE_B;
    await comprobarLlavesPiiAlArrancar();
    expect(salida).not.toHaveBeenCalled();
    expect(m.log.info).toHaveBeenCalledWith(
      { versionVigente: 1, versionesConfiguradas: [1, 2], versionesRegistradas: [1, 2] },
      'llaves PII comprobadas',
    );
    const texto = JSON.stringify(m.log.info.mock.calls);
    for (const valor of [LLAVE_A, LLAVE_B]) expect(texto).not.toContain(valor);
  });

  it('un error de BD también detiene el arranque, sin el mensaje del ORM', async () => {
    const salida = espiarSalida();
    const client = await import('../../src/db/client.js');
    vi.spyOn(client.db, 'select').mockImplementationOnce(() => {
      throw Object.assign(new Error(`Failed query params: ${LLAVE_A}`), { cause: { message: 'relation does not exist' } });
    });
    await comprobarLlavesPiiAlArrancar();
    expect(salida).toHaveBeenCalledWith(1);
    const texto = JSON.stringify(m.log.fatal.mock.calls);
    expect(texto).toContain('relation does not exist');
    expect(texto).not.toContain(LLAVE_A);
  });

  it('`server.ts` la espera antes de `app.listen` y los crons', () => {
    const fuente = readFileSync(path.resolve(__dirname, '../../src/server.ts'), 'utf8');
    const comprobacion = fuente.indexOf('await comprobarLlavesPiiAlArrancar()');
    expect(comprobacion).toBeGreaterThan(-1);
    expect(comprobacion).toBeLessThan(fuente.indexOf('createApp()'));
    expect(comprobacion).toBeLessThan(fuente.indexOf('app.listen('));
  });

  it('ni `crypto.ts` ni `app.ts` la ejecutan', () => {
    for (const archivo of ['../../src/shared/utils/crypto.ts', '../../src/app.ts']) {
      expect(readFileSync(path.resolve(__dirname, archivo), 'utf8')).not.toContain('comprobar-llaves');
    }
  });
});
