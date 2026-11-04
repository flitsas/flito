// Feature #13978, HU #13987 AC1, AC2, AC3 (ADR-0034 D3, D4) — script de rotación de `PII_ENC_KEY`.
//
// La BD es un doble en memoria que EVALÚA el SQL que Drizzle genera (filtros por versión, keyset y guardas),
// para que el guardado condicional se pruebe y no se dé por hecho. MinIO es un mapa. La primitiva de cifrado
// no se dobla: se cifra con A, se rota a B y se lee con B de verdad.
import { Readable } from 'node:stream';
import { Column, getTableColumns, getTableName, type SQL, type Table } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Fila = Record<string, unknown>;

const m = vi.hoisted(() => ({
  tablas: {} as Record<string, Record<string, unknown>[]>,
  escrituras: [] as string[],
  antesDeEscribir: null as null | ((tabla: string) => void),
  objetos: new Map<string, Buffer>(),
  subidas: 0,
  borrados: [] as string[],
  fallaBorrado: false,
  corromperSubida: false,
  fallaEscrituraEn: null as null | { tabla: string; restantes: number },
}));

const dialect = new PgDialect();

function partirEn(texto: string, sep: string): string[] {
  const partes: string[] = [];
  let nivel = 0;
  let inicio = 0;
  for (let i = 0; i < texto.length; i += 1) {
    if (texto[i] === '(') nivel += 1;
    if (texto[i] === ')') nivel -= 1;
    if (nivel === 0 && texto.startsWith(sep, i)) {
      partes.push(texto.slice(inicio, i));
      inicio = i + sep.length;
    }
  }
  partes.push(texto.slice(inicio));
  return partes;
}

function sinParentesisExternos(t: string): string {
  let s = t.trim();
  while (s.startsWith('(') && s.endsWith(')')) {
    let nivel = 0;
    let cierraAlFinal = true;
    for (let i = 0; i < s.length - 1; i += 1) {
      if (s[i] === '(') nivel += 1;
      if (s[i] === ')') nivel -= 1;
      if (nivel === 0) { cierraAlFinal = false; break; }
    }
    if (!cierraAlFinal) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}

const COL = '(?:"\\w+"\\.)?"(\\w+)"';

function igual(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (Buffer.isBuffer(a) || Buffer.isBuffer(b)) return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
  return String(a) === String(b);
}

function evaluar(texto: string, params: unknown[], fila: Fila): boolean {
  const t = sinParentesisExternos(texto);
  const ands = partirEn(t, ' and ');
  if (ands.length > 1) return ands.every((x) => evaluar(x, params, fila));
  const ors = partirEn(t, ' or ');
  if (ors.length > 1) return ors.some((x) => evaluar(x, params, fila));
  const p = (n: string) => params[Number(n) - 1];
  let c: RegExpExecArray | null;
  if ((c = new RegExp(`^${COL} is not null$`).exec(t))) return fila[c[1]] !== null && fila[c[1]] !== undefined;
  if ((c = new RegExp(`^${COL} is null$`).exec(t))) return fila[c[1]] === null || fila[c[1]] === undefined;
  if ((c = new RegExp(`^${COL} = \\$(\\d+)$`).exec(t))) return igual(fila[c[1]], p(c[2]));
  if ((c = new RegExp(`^${COL} <> \\$(\\d+)$`).exec(t))) return fila[c[1]] !== null && !igual(fila[c[1]], p(c[2]));
  if ((c = new RegExp(`^${COL} > \\$(\\d+)$`).exec(t))) return (fila[c[1]] as number) > (p(c[2]) as number);
  if ((c = new RegExp(`^coalesce\\(${COL}, 1\\) <> \\$(\\d+)$`).exec(t))) return String(fila[c[1]] ?? 1) !== String(p(c[2]));
  if ((c = new RegExp(`^${COL}->>'(\\w+)' IS DISTINCT FROM \\$(\\d+)$`).exec(t))) {
    const v = (fila[c[1]] as Fila | null)?.[c[2]];
    return v === undefined || v === null || String(v) !== String(p(c[3]));
  }
  if ((c = new RegExp(`^${COL}->>'(\\w+)' = \\$(\\d+)$`).exec(t))) {
    const v = (fila[c[1]] as Fila | null)?.[c[2]];
    return v !== undefined && v !== null && String(v) === String(p(c[3]));
  }
  if ((c = new RegExp(`^split_part\\(${COL}, ':', 2\\) <> \\$(\\d+)$`).exec(t))) {
    return String(fila[c[1]] ?? '').split(':')[1] !== String(p(c[2]));
  }
  if ((c = new RegExp(`^left\\(${COL}, \\$(\\d+)\\) ~ \\$(\\d+)$`).exec(t))) {
    const v = fila[c[1]];
    return typeof v === 'string' && new RegExp(String(p(c[3]))).test(v.slice(0, Number(p(c[2]))));
  }
  if ((c = new RegExp(`^substring\\(left\\(${COL}, \\$(\\d+)\\) from \\$(\\d+)\\) <> \\$(\\d+)$`).exec(t))) {
    const v = String(fila[c[1]] ?? '').slice(0, Number(p(c[2])));
    return new RegExp(String(p(c[3]))).exec(v)?.[1] !== String(p(c[4]));
  }
  throw new Error(`SQL no reconocido por el doble: ${t}`);
}

function cumple(cond: SQL | undefined, fila: Fila): boolean {
  if (!cond) return true;
  const { sql, params } = dialect.sqlToQuery(cond);
  return evaluar(sql, params, fila);
}

vi.mock('../../src/db/client.js', () => {
  const filasDe = (t: Table) => (m.tablas[getTableName(t)] ??= []);
  const aColumnas = (t: Table, datos: Fila) => {
    const cols = getTableColumns(t) as Record<string, Column>;
    return Object.fromEntries(Object.entries(datos).map(([k, v]) => [cols[k].name, v]));
  };
  const proyectar = (shape: Record<string, unknown>, fila: Fila) => Object.fromEntries(Object.entries(shape).map(([alias, v]) => {
    if (v instanceof Column) return [alias, fila[v.name] ?? null];
    const { sql: texto, params } = dialect.sqlToQuery(v as SQL);
    const c = new RegExp(`^left\\(${COL}, \\$1\\)$`).exec(texto);
    if (!c) throw new Error(`proyección no reconocida: ${texto}`);
    const valor = fila[c[1]];
    return [alias, typeof valor === 'string' ? valor.slice(0, Number(params[0])) : null];
  }));
  const db = {
    select: (shape: Record<string, unknown>) => {
      let tabla: Table;
      let cond: SQL | undefined;
      let orden: string | null = null;
      let limite = Infinity;
      const ejecutar = () => {
        let filas = filasDe(tabla).filter((f) => cumple(cond, f));
        if ('n' in shape && !(shape.n instanceof Column)) return [{ n: filas.length }];
        if (orden) {
          const col = orden;
          filas = [...filas].sort((a, b) => ((a[col] as number) > (b[col] as number) ? 1 : -1));
        }
        return filas.slice(0, limite).map((f) => proyectar(shape, f));
      };
      const q = {
        from: (t: Table) => { tabla = t; return q; },
        where: (c: SQL | undefined) => { cond = c; return q; },
        orderBy: (o: SQL) => {
          orden = new RegExp(COL).exec(dialect.sqlToQuery(o).sql)?.[1] ?? null;
          return q;
        },
        limit: (n: number) => { limite = n; return q; },
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve().then(ejecutar).then(ok, ko),
      };
      return q;
    },
    update: (t: Table) => ({
      set: (datos: Fila) => ({
        where: (cond: SQL) => {
          const correr = () => {
            const nombre = getTableName(t);
            m.antesDeEscribir?.(nombre);
            const falla = m.fallaEscrituraEn;
            if (falla?.tabla === nombre && falla.restantes > 0) {
              falla.restantes -= 1;
              throw new Error('conexión caída con VALOR-QUE-NO-DEBE-SALIR');
            }
            const afectadas = filasDe(t).filter((f) => cumple(cond, f));
            for (const f of afectadas) {
              Object.assign(f, aColumnas(t, datos));
              m.escrituras.push(nombre);
            }
            return afectadas;
          };
          const p = Promise.resolve().then(correr);
          return Object.assign(p, {
            returning: (shape: Record<string, unknown>) => p.then((fs) => fs.map((f) => proyectar(shape, f))),
          });
        },
      }),
    }),
    insert: (t: Table) => ({
      values: (datos: Fila) => {
        const correr = () => {
          const fila = { id: `pend-${filasDe(t).length + 1}`, ...aColumnas(t, datos) };
          filasDe(t).push(fila);
          m.escrituras.push(getTableName(t));
          return fila;
        };
        const p = Promise.resolve().then(correr);
        return Object.assign(p, {
          returning: (shape: Record<string, unknown>) => p.then((f) => [proyectar(shape, f)]),
        });
      },
    }),
    transaction: (cb: (tx: unknown) => Promise<unknown>) => cb(db),
  };
  return { db };
});

vi.mock('../../src/services/storage.js', () => ({
  uploadEntityDocument: async (prefijo: string, entidad: number, _n: string, buf: Buffer) => {
    m.subidas += 1;
    const clave = `${prefijo}/${entidad}/subida-${m.subidas}`;
    m.objetos.set(clave, m.corromperSubida ? Buffer.concat([buf, Buffer.from('x')]) : buf);
    return clave;
  },
  getEntityDocumentStream: async (clave: string) => {
    const buf = m.objetos.get(clave);
    if (!buf) throw Object.assign(new Error('no existe'), { code: 'NoSuchKey' });
    return Readable.from([buf]);
  },
  removeEntityDocument: async (clave: string) => {
    if (m.fallaBorrado) throw Object.assign(new Error('caído'), { name: 'S3Error' });
    m.objetos.delete(clave);
    m.borrados.push(clave);
  },
  deleteEntityDocument: async () => true,
  getPhoto: async () => null,
}));

vi.mock('../../src/shared/logger.js', () => {
  const l = { info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, debug: () => {}, child: () => l };
  return { logger: l, loggerFor: () => l, REDACT_PATHS: [] };
});

import { env } from '../../src/config/env.js';
import { aadConductor } from '../../src/modules/drivers/drivers.aad.js';
import { aadDe } from '../../src/modules/flito-bolsas-documentos/flito-bolsas-documentos.service.js';
import { protegerDocumento, revelarDocumento } from '../../src/modules/flito-logistica/flito-logistica.cifrado.js';
import { descifrarCounterpartyEstricto, encryptCounterpartyField, type EncBundleJsonb } from '../../src/modules/laft/employees/counterparty-pii.js';
import { codigoSalidaRotacion, ejecutarRotacion, type ResultadoRotacion } from '../../src/modules/privacy/rotacion/motor.js';
import { DESCRIPTORES } from '../../src/modules/privacy/rotacion/descriptores.js';
import { aadTitularPago } from '../../src/modules/rndc/manifiestos.aad.js';
import { opcionesDesdeArgs } from '../../src/scripts/flito-rotar-llave-pii.js';
import {
  decryptPii, decryptPiiBuffer, decryptPiiText, encryptPii, encryptPiiBuffer, encryptPiiText, encryptPiiTextConVersion,
} from '../../src/shared/utils/crypto.js';
import { COLUMNAS_CIFRADAS_PII } from '../../src/shared/utils/pii-columnas.js';

const envMutable = env as unknown as { PII_ENC_KEY: string | undefined; PII_ENC_KEY_CURRENT_VERSION: number };
const LLAVE_A = env.PII_ENC_KEY as string;
const LLAVE_B = 'a7f3c91e5d20b84f6e13d7a9c0428fb5e16d3a7c94f08b2d';
const LLAVE_OTRA = '5be2049fd1c76a38e9f04b1d7c62a85310de94fb76c1a2e8';
const NUMERO = 'MAN-NUMERO-SECRETO-777';
const NONCE = '11111111-2222-4333-8444-555555555555';
const FIRMA_ID = '00000000-0000-4000-8000-0000000000a1';
const FIRMANTE_ID = '00000000-0000-4000-8000-0000000000b1';
const DOC_ID = '00000000-0000-4000-8000-0000000000c1';
const PLANO = {
  cedula: '1036640908', licencia: 'LIC-55443', runt: '{"nombre":"Ñandú Pérez"}', cuenta: '0550-1234-9', doc: '900123456',
  email: 'persona@correo.test', phone: '3001234567', firma: '79123456', firmante: '52987654', foto: 'data:image/png;base64,QUJD',
};
const ARCHIVO = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0x80, 0x01]);
const CLAVE_ORIGINAL = 'flito-bolsas-documentos/77/original';

const CANARIO = 'flito-pii-canario';
const ctxCanario = (version: number) => ({ table: 'pii_key_registry', column: 'canario', id: version });

function registrar(version: number): void {
  (m.tablas.pii_key_registry ??= []).push({ version, canario: encryptPiiTextConVersion(CANARIO, ctxCanario(version), version) });
}

function usarVersion(vigente: number): void {
  envMutable.PII_ENC_KEY_CURRENT_VERSION = vigente;
}

/** Bundle bytea con el nombre de las columnas reales. */
function bundleBd(base: string, b: ReturnType<typeof encryptPii>, aadNonce: string): Fila {
  return {
    [`${base}_cipher`]: b.cipher, [`${base}_iv`]: b.iv, [`${base}_auth_tag`]: b.authTag,
    [`${base}_aad_nonce`]: aadNonce, [`${base}_key_version`]: b.keyVersion,
  };
}

/** Una celda con dato en cada una de las 13 columnas, cifrada con la versión vigente. */
function sembrarTodo(): void {
  const conductor = (c: 'cedula' | 'licencia_numero' | 'runt_payload', plano: string) => (
    bundleBd(c, encryptPii(plano, aadConductor(c, 1, NONCE)), NONCE)
  );
  m.tablas.driver_profile = [{
    user_id: 1,
    ...conductor('cedula', PLANO.cedula),
    ...conductor('licencia_numero', PLANO.licencia),
    ...conductor('runt_payload', PLANO.runt),
  }, { user_id: 2 }];
  m.tablas.manifiestos = [{
    id: 10, numero: NUMERO,
    ...bundleBd('titular_pago_cuenta', encryptPii(PLANO.cuenta, aadTitularPago(NUMERO, NONCE)), NONCE),
  }];
  m.tablas.laft_counterparties = [{
    id: 5,
    doc_number_enc: encryptCounterpartyField(PLANO.doc, 'doc_number', 5),
    email_enc: encryptCounterpartyField(PLANO.email, 'email', 5),
    phone_enc: encryptCounterpartyField(PLANO.phone, 'phone', 5),
  }];
  m.tablas.flito_logistica_acta_firmas = [{ id: FIRMA_ID, documento_cifrado: protegerDocumento(PLANO.firma, FIRMA_ID).cifrado }];
  m.tablas.flito_logistica_recogida_firmantes = [{ id: FIRMANTE_ID, documento_cifrado: protegerDocumento(PLANO.firmante, FIRMANTE_ID).cifrado }];
  const fotos = (id: number) => ({
    foto_rostro: encryptPiiText(PLANO.foto, { table: 'tramites_validaciones', column: 'foto_rostro', id }),
    foto_cedula_frontal: encryptPiiText(PLANO.foto, { table: 'tramites_validaciones', column: 'foto_cedula_frontal', id }),
    foto_cedula_reverso: encryptPiiText(PLANO.foto, { table: 'tramites_validaciones', column: 'foto_cedula_reverso', id }),
  });
  m.tablas.tramites_validaciones = [{ id: 7, ...fotos(7) }];
  const archivo = encryptPiiBuffer(ARCHIVO, aadDe(DOC_ID, NONCE));
  m.objetos.set(CLAVE_ORIGINAL, archivo.cipher);
  m.tablas.flito_bolsas_documentos = [{
    id: DOC_ID, compania_id: 77, storage_key: CLAVE_ORIGINAL, storage_key_previa: null, cifrado_iv: archivo.iv, cifrado_tag: archivo.authTag,
    cifrado_key_version: archivo.keyVersion, aad_nonce: NONCE, purgado_en: null,
  }];
}

/** Lee todo como lo hace la aplicación. Lanza si algo no descifra. */
async function leerTodo() {
  const d = m.tablas.driver_profile[0];
  const conductor = (c: 'cedula' | 'licencia_numero' | 'runt_payload') => decryptPii(
    { cipher: d[`${c}_cipher`] as Buffer, iv: d[`${c}_iv`] as Buffer, authTag: d[`${c}_auth_tag`] as Buffer, keyVersion: (d[`${c}_key_version`] as number | null) ?? 1 },
    aadConductor(c, 1, d[`${c}_aad_nonce`] as string),
  );
  const mf = m.tablas.manifiestos[0];
  const l = m.tablas.laft_counterparties[0];
  const f = m.tablas.tramites_validaciones[0];
  const b = m.tablas.flito_bolsas_documentos[0];
  return {
    cedula: conductor('cedula'),
    licencia: conductor('licencia_numero'),
    runt: conductor('runt_payload'),
    cuenta: decryptPii(
      { cipher: mf.titular_pago_cuenta_cipher as Buffer, iv: mf.titular_pago_cuenta_iv as Buffer, authTag: mf.titular_pago_cuenta_auth_tag as Buffer, keyVersion: mf.titular_pago_cuenta_key_version as number },
      aadTitularPago(NUMERO, mf.titular_pago_cuenta_aad_nonce as string),
    ),
    doc: descifrarCounterpartyEstricto(l.doc_number_enc as EncBundleJsonb, 'doc_number', 5),
    email: descifrarCounterpartyEstricto(l.email_enc as EncBundleJsonb, 'email', 5),
    phone: descifrarCounterpartyEstricto(l.phone_enc as EncBundleJsonb, 'phone', 5),
    firma: revelarDocumento(m.tablas.flito_logistica_acta_firmas[0].documento_cifrado as string, FIRMA_ID),
    firmante: revelarDocumento(m.tablas.flito_logistica_recogida_firmantes[0].documento_cifrado as string, FIRMANTE_ID),
    fotos: (['foto_rostro', 'foto_cedula_frontal', 'foto_cedula_reverso'] as const).map((c) => decryptPiiText(f[c] as string, { table: 'tramites_validaciones', column: c, id: 7 })),
    archivo: decryptPiiBuffer(
      { cipher: m.objetos.get(b.storage_key as string) as Buffer, iv: b.cifrado_iv as Buffer, authTag: b.cifrado_tag as Buffer, keyVersion: b.cifrado_key_version as number },
      aadDe(DOC_ID, b.aad_nonce as string),
    ),
  };
}

function esperarLecturaCorrecta(l: Awaited<ReturnType<typeof leerTodo>>): void {
  expect(l).toEqual({
    cedula: PLANO.cedula, licencia: PLANO.licencia, runt: PLANO.runt, cuenta: PLANO.cuenta, doc: PLANO.doc, email: PLANO.email, phone: PLANO.phone,
    firma: PLANO.firma, firmante: PLANO.firmante, fotos: [PLANO.foto, PLANO.foto, PLANO.foto], archivo: ARCHIVO,
  });
}

function totales(r: ResultadoRotacion) {
  const cs = Object.values(r.columnas);
  return {
    escrito: cs.reduce((s, c) => s + c.escrito, 0),
    recifrable: cs.reduce((s, c) => s + c.recifrable, 0),
    fallo: cs.reduce((s, c) => s + c.fallo, 0),
  };
}

const conAB = async () => {
  sembrarTodo();
  registrar(1);
  process.env.PII_ENC_KEY_V2 = LLAVE_B;
  registrar(2);
  usarVersion(2);
};

const commit = (v = 2) => ejecutarRotacion({ modo: 'commit', versionObjetivo: v });
const verificar = (v = 2) => ejecutarRotacion({ modo: 'verificar', versionObjetivo: v });
const instantanea = () => JSON.stringify(m.tablas, (_k, v) => (v?.type === 'Buffer' ? Buffer.from(v.data).toString('hex') : v));

beforeEach(() => {
  m.tablas = {};
  m.escrituras = [];
  m.antesDeEscribir = null;
  m.objetos = new Map();
  m.subidas = 0;
  m.borrados = [];
  m.fallaBorrado = false;
  m.corromperSubida = false;
  m.fallaEscrituraEn = null;
  envMutable.PII_ENC_KEY = LLAVE_A;
  usarVersion(1);
  delete process.env.PII_ENC_KEY_V2;
  delete process.env.PII_ENC_KEY_V3;
});

afterEach(() => {
  envMutable.PII_ENC_KEY = LLAVE_A;
  usarVersion(1);
  delete process.env.PII_ENC_KEY_V2;
  delete process.env.PII_ENC_KEY_V3;
});

describe('AC1: rotación feliz', () => {
  it('todo queda en B y legible con la configuración nueva, aunque A ya no esté', async () => {
    await conAB();
    const r = await commit();
    expect(r.abortado).toBe(false);
    expect(codigoSalidaRotacion(r)).toBe(0);
    expect(totales(r)).toEqual({ escrito: 13, recifrable: 13, fallo: 0 });
    for (const { id } of COLUMNAS_CIFRADAS_PII) expect(r.columnas[id]?.escrito, id).toBe(1);
    envMutable.PII_ENC_KEY = undefined;
    esperarLecturaCorrecta(await leerTodo());
  });

  it('cada formato queda marcado con la versión 2 y conserva su aad_nonce', async () => {
    await conAB();
    await commit();
    expect(m.tablas.driver_profile[0].cedula_key_version).toBe(2);
    expect(m.tablas.driver_profile[0].cedula_aad_nonce).toBe(NONCE);
    expect((m.tablas.laft_counterparties[0].email_enc as EncBundleJsonb).keyVersion).toBe(2);
    expect(String(m.tablas.flito_logistica_acta_firmas[0].documento_cifrado).split(':').slice(0, 2)).toEqual(['v1', '2']);
    expect(String(m.tablas.tramites_validaciones[0].foto_rostro).startsWith('v2:')).toBe(true);
    expect(m.tablas.flito_bolsas_documentos[0].cifrado_key_version).toBe(2);
    expect(m.tablas.flito_bolsas_documentos[0].aad_nonce).toBe(NONCE);
  });

  it('--verificar pasa con todo en B y sin A', async () => {
    await conAB();
    await commit();
    envMutable.PII_ENC_KEY = undefined;
    m.tablas.pii_key_registry = m.tablas.pii_key_registry.filter((f) => f.version === 2);
    const r = await verificar();
    expect(r.abortado).toBe(false);
    expect(codigoSalidaRotacion(r)).toBe(0);
  });

  it('un binario no utf8 sale byte a byte', async () => {
    await conAB();
    await commit();
    const { archivo } = await leerTodo();
    expect(archivo.equals(ARCHIVO)).toBe(true);
  });

  it('rollback: de vuelta a V1 con V2 aún configurada, sin perder nada', async () => {
    await conAB();
    await commit();
    usarVersion(1);
    const r = await commit(1);
    expect(codigoSalidaRotacion(r)).toBe(0);
    expect(m.tablas.driver_profile[0].cedula_key_version).toBe(1);
    delete process.env.PII_ENC_KEY_V2;
    m.tablas.pii_key_registry = m.tablas.pii_key_registry.filter((f) => f.version === 1);
    esperarLecturaCorrecta(await leerTodo());
  });
});

describe('AC2: mezcla, reanudación e idempotencia', () => {
  it('con filas en A y en B, todo queda en B y lo ya recifrado no se toca', async () => {
    await conAB();
    const cedulaB = encryptPii('52111222', aadConductor('cedula', 3, NONCE));
    m.tablas.driver_profile.push({ user_id: 3, ...bundleBd('cedula', cedulaB, NONCE) });
    usarVersion(2);
    const r = await commit();
    expect(r.columnas['driver_profile.cedula']?.escrito).toBe(1);
    expect(m.tablas.driver_profile[2].cedula_cipher).toBe(cedulaB.cipher);
    expect(m.tablas.driver_profile[0].cedula_key_version).toBe(2);
  });

  it('una segunda corrida consecutiva no produce cambios', async () => {
    await conAB();
    await commit();
    const antes = instantanea();
    m.escrituras = [];
    const subidas = m.subidas;
    const r = await commit();
    expect(totales(r).escrito).toBe(0);
    expect(m.escrituras).toEqual([]);
    expect(m.subidas).toBe(subidas);
    expect(instantanea()).toBe(antes);
    expect(codigoSalidaRotacion(r)).toBe(0);
  });

  it('una corrida interrumpida se reanuda volviendo a correr', async () => {
    await conAB();
    m.fallaEscrituraEn = { tabla: 'manifiestos', restantes: 1 };
    const primera = await commit();
    expect(primera.columnas['manifiestos.titular_pago_cuenta']?.fallo).toBe(1);
    expect(primera.columnas['manifiestos.titular_pago_cuenta']?.idsFallidos).toEqual([10]);
    expect(codigoSalidaRotacion(primera)).toBe(2);
    const segunda = await commit();
    expect(codigoSalidaRotacion(segunda)).toBe(0);
    expect(totales(segunda).escrito).toBe(1);
    esperarLecturaCorrecta(await leerTodo());
  });

  it('recorre más de un lote completo por clave primaria', async () => {
    usarVersion(1);
    m.tablas.laft_counterparties = Array.from({ length: 205 }, (_v, i) => ({
      id: i + 1, doc_number_enc: encryptCounterpartyField(`doc-${i}`, 'doc_number', i + 1), email_enc: null, phone_enc: null,
    }));
    registrar(1);
    process.env.PII_ENC_KEY_V2 = LLAVE_B;
    registrar(2);
    usarVersion(2);
    const r = await commit();
    expect(r.columnas['laft_counterparties.doc_number_enc']?.escrito).toBe(205);
  });

  it('key_version NULL se lee como 1: pendiente hacia V2 y ya al día hacia V1', async () => {
    await conAB();
    const fila = m.tablas.driver_profile[0];
    fila.cedula_key_version = null;
    const d = DESCRIPTORES['driver_profile.cedula'];
    expect(await d.pendientes(null, 1)).toHaveLength(0);
    expect(await d.pendientes(null, 2)).toHaveLength(1);
    const r = await commit();
    expect(r.columnas['driver_profile.cedula']?.escrito).toBe(1);
    expect(fila.cedula_key_version).toBe(2);
  });
});

describe('AC3: dry-run', () => {
  it('reporta cuántas recifraría sin escribir nada, ni en BD ni en MinIO', async () => {
    await conAB();
    const antes = instantanea();
    const r = await ejecutarRotacion({ modo: 'dry-run', versionObjetivo: 2 });
    expect(totales(r)).toEqual({ escrito: 0, recifrable: 13, fallo: 0 });
    expect(codigoSalidaRotacion(r)).toBe(0);
    expect(m.escrituras).toEqual([]);
    expect(m.subidas).toBe(0);
    expect(m.borrados).toEqual([]);
    expect(instantanea()).toBe(antes);
  });

  it('con una celda que no descifra sale 2: avisa antes del commit', async () => {
    await conAB();
    const iv = m.tablas.manifiestos[0].titular_pago_cuenta_iv as Buffer;
    m.tablas.manifiestos[0].titular_pago_cuenta_iv = Buffer.alloc(iv.length, 7);
    const r = await ejecutarRotacion({ modo: 'dry-run', versionObjetivo: 2 });
    expect(codigoSalidaRotacion(r)).toBe(2);
    expect(m.escrituras).toEqual([]);
  });
});

describe('D4: llave equivocada', () => {
  const noEscribe = () => {
    expect(m.escrituras).toEqual([]);
    expect(m.subidas).toBe(0);
  };

  it.each(['commit', 'dry-run', 'verificar'] as const)('%s: B del Job distinta de la registrada aborta con salida 1', async (modo) => {
    await conAB();
    process.env.PII_ENC_KEY_V2 = LLAVE_OTRA;
    const r = await ejecutarRotacion({ modo, versionObjetivo: 2 });
    expect(r.abortado).toBe(true);
    expect(r.motivoAborto).toBe('llave_no_coincide');
    expect(codigoSalidaRotacion(r)).toBe(1);
    noEscribe();
  });

  it('B sin registrar: aborta, y el Job nunca registra', async () => {
    sembrarTodo();
    registrar(1);
    process.env.PII_ENC_KEY_V2 = LLAVE_B;
    usarVersion(2);
    const r = await commit();
    expect(r.motivoAborto).toBe('llave_sin_registro');
    expect(m.tablas.pii_key_registry.map((f) => f.version)).toEqual([1]);
    noEscribe();
  });

  it('la llave vieja equivocada: canario de V1 no descifra, aborta sin escribir', async () => {
    await conAB();
    envMutable.PII_ENC_KEY = LLAVE_OTRA;
    const r = await commit();
    expect(r.motivoAborto).toBe('llave_no_coincide');
    noEscribe();
  });

  it('--target-version distinta de la vigente aborta', async () => {
    await conAB();
    const r = await commit(1);
    expect(r.motivoAborto).toBe('version_objetivo_no_vigente');
    noEscribe();
  });

  it('--target-version sin llave aborta', async () => {
    await conAB();
    const r = await commit(3);
    expect(r.motivoAborto).toBe('version_objetivo_sin_llave');
    noEscribe();
  });

  it('--solo-llaves: 0 con todo bien, 1 con la B equivocada, y no toca datos', async () => {
    await conAB();
    const ok = await ejecutarRotacion({ modo: 'solo-llaves' });
    expect(codigoSalidaRotacion(ok)).toBe(0);
    expect(ok.llaves).toEqual([{ version: 1, estado: 'ok' }, { version: 2, estado: 'ok' }]);
    expect(ok.columnas).toEqual({});
    process.env.PII_ENC_KEY_V2 = LLAVE_OTRA;
    expect(codigoSalidaRotacion(await ejecutarRotacion({ modo: 'solo-llaves' }))).toBe(1);
    noEscribe();
  });

  it('canario de columna: si nada de una columna descifra, esa no se escribe, las demás sí, salida 2', async () => {
    await conAB();
    m.tablas.flito_logistica_recogida_firmantes[0].id = 'ffffffff-0000-4000-8000-0000000000b1';
    const r = await commit();
    const c = r.columnas['flito_logistica_recogida_firmantes.documento_cifrado'];
    expect(c?.canario).toBe('fallo');
    expect(c?.escrito).toBe(0);
    expect(r.columnas['driver_profile.cedula']?.escrito).toBe(1);
    expect(codigoSalidaRotacion(r)).toBe(2);
  });

  it('una fila corrupta suelta no frena su columna: se cuenta, y las otras pasan', async () => {
    await conAB();
    // Copiada de otra fila: la AAD no cuadra y GCM la rechaza.
    m.tablas.driver_profile[1] = { ...m.tablas.driver_profile[0], user_id: 2 };
    const r = await commit();
    const c = r.columnas['driver_profile.cedula'];
    expect(c?.canario).toBe('ok');
    expect(c?.escrito).toBe(1);
    expect(c?.fallo).toBe(1);
    expect(c?.idsFallidos).toEqual([2]);
    expect(codigoSalidaRotacion(r)).toBe(2);
  });

  it('valor en claro en una columna bytea: no se cifra (se cierra la vía de #14097)', async () => {
    await conAB();
    m.tablas.driver_profile[1] = {
      user_id: 2, cedula_cipher: Buffer.from('79111222'), cedula_iv: null, cedula_auth_tag: null, cedula_aad_nonce: null, cedula_key_version: 1,
    };
    const r = await commit();
    expect(r.columnas['driver_profile.cedula']?.fallo).toBe(1);
    expect((m.tablas.driver_profile[1].cedula_cipher as Buffer).toString()).toBe('79111222');
  });
});

describe('D3: guarda de concurrencia', () => {
  it.each([
    ['driver_profile', 'driver_profile.cedula', (f: Fila) => { f.cedula_iv = Buffer.alloc(12, 9); }],
    ['manifiestos', 'manifiestos.titular_pago_cuenta', (f: Fila) => { f.titular_pago_cuenta_key_version = 2; }],
    ['laft_counterparties', 'laft_counterparties.doc_number_enc', (f: Fila) => { f.doc_number_enc = null; }],
    ['flito_logistica_acta_firmas', 'flito_logistica_acta_firmas.documento_cifrado', (f: Fila) => { f.documento_cifrado = 'v1:2:escrito-por-la-api'; }],
    ['tramites_validaciones', 'tramites_validaciones.foto_rostro', (f: Fila) => { f.foto_rostro = null; }],
  ] as const)('%s: si la API escribió o anonimizó, no se pisa', async (tabla, id, cambiar) => {
    await conAB();
    let hecho = false;
    m.antesDeEscribir = (t) => {
      if (t === tabla && !hecho) { hecho = true; cambiar(m.tablas[tabla][0]); }
    };
    const original = { ...m.tablas[tabla][0] };
    const r = await commit();
    expect(r.columnas[id]?.omitido_concurrente).toBe(1);
    expect(r.columnas[id]?.escrito).toBe(0);
    expect(codigoSalidaRotacion(r)).toBe(2);
    const despues = { ...original };
    cambiar(despues);
    const clave = Object.keys(despues).find((k) => despues[k] !== original[k]) as string;
    expect(m.tablas[tabla][0][clave]).toEqual(despues[clave]);
  });
});

describe('D3: biometría en formatos legados', () => {
  const VIEJO = `${'a'.repeat(32)}:${'b'.repeat(32)}:QUJD`;

  it('no se tocan, se cuentan, y --verificar no pasa con viejo o texto en claro', async () => {
    await conAB();
    m.tablas.tramites_validaciones.push(
      { id: 8, foto_rostro: VIEJO, foto_cedula_frontal: null, foto_cedula_reverso: null },
      { id: 9, foto_rostro: 'data:image/png;base64,PLANA', foto_cedula_frontal: null, foto_cedula_reverso: null },
    );
    const r = await commit();
    expect(m.tablas.tramites_validaciones[1].foto_rostro).toBe(VIEJO);
    expect(m.tablas.tramites_validaciones[2].foto_rostro).toBe('data:image/png;base64,PLANA');
    expect(r.columnas['tramites_validaciones.foto_rostro']).toMatchObject({ escrito: 1, formato_legado: 2 });
    expect(codigoSalidaRotacion(r)).toBe(0);
    const v = await verificar();
    expect(v.columnas['tramites_validaciones.foto_rostro']?.formato_legado).toBe(2);
    expect(codigoSalidaRotacion(v)).toBe(2);
  });

  it('`desconocido` se informa y no bloquea; `storage_key` ni se cuenta', async () => {
    await conAB();
    m.tablas.tramites_validaciones.push(
      { id: 8, foto_rostro: 'dato-raro', foto_cedula_frontal: null, foto_cedula_reverso: null },
      { id: 9, foto_rostro: 'validaciones/9/rostro.jpg', foto_cedula_frontal: null, foto_cedula_reverso: null },
    );
    await commit();
    const v = await verificar();
    expect(v.columnas['tramites_validaciones.foto_rostro']).toMatchObject({ formato_legado: 0, formato_desconocido: 1 });
    expect(codigoSalidaRotacion(v)).toBe(0);
    expect(m.tablas.tramites_validaciones[1].foto_rostro).toBe('dato-raro');
  });

  it('una foto grande se clasifica por su inicio', async () => {
    await conAB();
    m.tablas.tramites_validaciones.push({ id: 8, foto_rostro: 'A'.repeat(5000), foto_cedula_frontal: null, foto_cedula_reverso: null });
    const r = await commit();
    expect(r.columnas['tramites_validaciones.foto_rostro']?.formato_legado).toBe(1);
  });
});

describe('--verificar', () => {
  it('sale 2 con una celda en la versión anterior, aunque se pueda leer', async () => {
    await conAB();
    const r = await verificar();
    expect(codigoSalidaRotacion(r)).toBe(2);
    expect(r.columnas['driver_profile.cedula']).toMatchObject({ otra_version: 1, fallo: 0, idsFallidos: [1] });
  });

  it('sale 2 con una celda en la versión objetivo que no descifra', async () => {
    await conAB();
    await commit();
    m.tablas.driver_profile[0].cedula_auth_tag = Buffer.alloc(16, 3);
    const r = await verificar();
    expect(r.columnas['driver_profile.cedula']).toMatchObject({ fallo: 1, idsFallidos: [1] });
    expect(codigoSalidaRotacion(r)).toBe(2);
  });

  it('no escribe nada', async () => {
    await conAB();
    await verificar();
    expect(m.escrituras).toEqual([]);
    expect(m.subidas).toBe(0);
  });
});

describe('D3: objetos de bolsas', () => {
  const fila = () => m.tablas.flito_bolsas_documentos[0];

  it('sube a una clave nueva y conserva el objeto anterior en storage_key_previa', async () => {
    await conAB();
    const cifradoOriginal = m.objetos.get(CLAVE_ORIGINAL);
    await commit();
    expect(fila().storage_key).not.toBe(CLAVE_ORIGINAL);
    expect(fila().storage_key_previa).toBe(CLAVE_ORIGINAL);
    expect(m.objetos.get(CLAVE_ORIGINAL)).toBe(cifradoOriginal);
    expect(m.borrados).toEqual([]);
  });

  it('si la guarda falla, borra lo subido y no toca la fila', async () => {
    await conAB();
    let hecho = false;
    m.antesDeEscribir = (t) => {
      if (t === 'flito_bolsas_documentos' && !hecho) { hecho = true; fila().storage_key = null; fila().purgado_en = new Date(); }
    };
    const r = await commit();
    expect(r.columnas['flito_bolsas_documentos.archivo']?.omitido_concurrente).toBe(1);
    expect(fila().storage_key).toBeNull();
    expect(fila().storage_key_previa).toBeNull();
    expect(m.borrados).toEqual(['flito-bolsas-documentos/77/subida-1']);
    expect(m.objetos.has('flito-bolsas-documentos/77/subida-1')).toBe(false);
  });

  it('si lo subido no descifra al releerlo, no enlaza y lo borra', async () => {
    await conAB();
    m.corromperSubida = true;
    const r = await commit();
    const c = r.columnas['flito_bolsas_documentos.archivo'];
    expect(c?.fallo).toBe(1);
    expect(c?.idsFallidos).toEqual([DOC_ID]);
    expect(fila().storage_key).toBe(CLAVE_ORIGINAL);
    expect(m.borrados).toEqual(['flito-bolsas-documentos/77/subida-1']);
  });

  it('si no se puede borrar lo subido, queda en la cola de borrados pendientes', async () => {
    await conAB();
    m.corromperSubida = true;
    m.fallaBorrado = true;
    await commit();
    const pendientes = m.tablas.flito_storage_borrados_pendientes;
    expect(pendientes).toHaveLength(1);
    expect(pendientes[0]).toMatchObject({ storage_key: 'flito-bolsas-documentos/77/subida-1', origen: 'rotacion-pii' });
    expect(pendientes[0].resuelto_en ?? null).toBeNull();
    expect(pendientes[0].ultimo_error).toBe('S3Error');
  });

  it('recifrada otra vez con previa ocupada: se conserva solo la inmediatamente anterior', async () => {
    await conAB();
    await commit();
    const primeraNueva = fila().storage_key;
    usarVersion(1);
    await commit(1);
    expect(fila().storage_key_previa).toBe(primeraNueva);
    expect(m.borrados).toEqual([CLAVE_ORIGINAL]);
    expect(m.tablas.flito_storage_borrados_pendientes[0].motivo_cierre).toBe('borrado');
  });

  it('un documento purgado no se recifra', async () => {
    await conAB();
    Object.assign(fila(), { storage_key: null, purgado_en: new Date() });
    const r = await commit();
    expect(r.columnas['flito_bolsas_documentos.archivo']).toMatchObject({ recorridas: 0, escrito: 0 });
  });

  it('--limpiar-objetos borra la previa y anula la columna; repetirlo no hace nada', async () => {
    await conAB();
    await commit();
    expect((await verificar()).objetosPrevios).toBe(1);
    const r = await ejecutarRotacion({ modo: 'limpiar-objetos' });
    expect(r.limpieza).toMatchObject({ borrados: 1, fallo: 0 });
    expect(codigoSalidaRotacion(r)).toBe(0);
    expect(r.objetosPrevios).toBe(0);
    expect(m.objetos.has(CLAVE_ORIGINAL)).toBe(false);
    expect(fila().storage_key_previa).toBeNull();
    expect((await ejecutarRotacion({ modo: 'limpiar-objetos' })).limpieza?.borrados).toBe(0);
  });

  it('--limpiar-objetos no borra la previa de una fila fuera de la versión vigente', async () => {
    await conAB();
    await commit();
    usarVersion(1);
    const r = await ejecutarRotacion({ modo: 'limpiar-objetos' });
    expect(r.limpieza).toMatchObject({ borrados: 0, omitido_otra_version: 1 });
    expect(codigoSalidaRotacion(r)).toBe(2);
    expect(m.objetos.has(CLAVE_ORIGINAL)).toBe(true);
  });

  it('--limpiar-objetos con MinIO caído: sale 2, conserva la columna y se puede repetir', async () => {
    await conAB();
    await commit();
    m.fallaBorrado = true;
    const r = await ejecutarRotacion({ modo: 'limpiar-objetos' });
    expect(r.limpieza).toMatchObject({ fallo: 1, idsFallidos: [DOC_ID] });
    expect(codigoSalidaRotacion(r)).toBe(2);
    expect(fila().storage_key_previa).toBe(CLAVE_ORIGINAL);
  });
});

describe('RN-RO11: salida sin PII', () => {
  it('ni valores, ni causas, ni llaves, ni claves de objeto, ni `numero`', async () => {
    await conAB();
    m.fallaEscrituraEn = { tabla: 'manifiestos', restantes: 1 };
    const salida = JSON.stringify([await commit(), await verificar()]);
    const prohibidos = [
      NUMERO, LLAVE_A, LLAVE_B, CLAVE_ORIGINAL, 'subida-', 'VALOR-QUE-NO-DEBE-SALIR', NONCE,
      PLANO.cedula, PLANO.licencia, PLANO.cuenta, PLANO.doc, PLANO.email, PLANO.phone, PLANO.firma, PLANO.firmante,
    ];
    for (const p of prohibidos) expect(salida, p).not.toContain(p);
  });

  it('en manifiestos el id que sale es `id`, no `numero`', async () => {
    await conAB();
    m.fallaEscrituraEn = { tabla: 'manifiestos', restantes: 1 };
    const r = await commit();
    expect(r.columnas['manifiestos.titular_pago_cuenta']?.idsFallidos).toEqual([10]);
  });
});

describe('argumentos', () => {
  it('acepta exactamente un modo con lo que ese modo exige', () => {
    expect(opcionesDesdeArgs(['--dry-run', '--target-version=2'])).toEqual({ modo: 'dry-run', versionObjetivo: 2 });
    expect(opcionesDesdeArgs(['--commit', '--target-version=1'])).toEqual({ modo: 'commit', versionObjetivo: 1 });
    expect(opcionesDesdeArgs(['--verificar', '--target-version=3'])).toEqual({ modo: 'verificar', versionObjetivo: 3 });
    expect(opcionesDesdeArgs(['--solo-llaves'])).toEqual({ modo: 'solo-llaves' });
    expect(opcionesDesdeArgs(['--limpiar-objetos'])).toEqual({ modo: 'limpiar-objetos' });
  });

  it.each([
    [[]],
    [['--commit']],
    [['--target-version=2']],
    [['--dry-run', '--commit', '--target-version=2']],
    [['--commit', '--target-version=0']],
    [['--commit', '--target-version=abc']],
    [['--commit', '--target-version=2', '--target-version=3']],
    [['--commit', '--target-version=2', '--otra']],
    [['--solo-llaves', '--target-version=2']],
    [['--limpiar-objetos', '--target-version=2']],
    [['--limpiar-objetos', '--solo-llaves']],
  ])('rechaza %j', (args) => {
    expect(opcionesDesdeArgs(args)).toBeNull();
  });
});
