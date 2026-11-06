// ADR-DB-001 — guard scanForTxControl / isGrandfathered
// Valida que el runner detecte BEGIN/COMMIT top-level en migraciones nuevas
// (≥0071) y respete las grandfathered (0050-0070).

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import {
  scanForTxControl,
  isGrandfathered,
  DRIFT_ABORTA,
  EXIT_DERIVA,
  arrancar,
  comprobarDeriva,
  decidir,
  decidirArranque,
  detectarDeriva,
  hashearDisco,
  lineasReporte,
  marcarTodas,
  opcionesConexion,
  parsearArgs,
  sha256De,
  validarManifiesto,
  ArgumentoInvalidoError,
  ManifiestoInvalidoError,
  type DepsArranque,
  type DerivaAceptada,
} from '../../src/scripts/db-apply.js';

describe('isGrandfathered', () => {
  it('returns true for migs <=0070', () => {
    expect(isGrandfathered('0050_serial_to_bigserial.sql')).toBe(true);
    expect(isGrandfathered('0068_pesv_diagnostico_niveles.sql')).toBe(true);
    expect(isGrandfathered('0070_pesv_trigger_worm_rubrica.sql')).toBe(true);
  });

  it('returns false for migs >=0071', () => {
    expect(isGrandfathered('0071_anything.sql')).toBe(false);
    expect(isGrandfathered('0100_future_mig.sql')).toBe(false);
    expect(isGrandfathered('9999_test.sql')).toBe(false);
  });

  it('returns false for files without numeric prefix', () => {
    expect(isGrandfathered('seed.sql')).toBe(false);
    expect(isGrandfathered('rollback.sql')).toBe(false);
  });
});

describe('scanForTxControl', () => {
  it('detects top-level BEGIN;', () => {
    const sql = `
      ALTER TABLE foo ADD COLUMN bar text;
      BEGIN;
      UPDATE foo SET bar = 'x';
      COMMIT;
    `;
    const hits = scanForTxControl('0071_test.sql', sql);
    expect(hits.length).toBe(2);
    expect(hits[0]).toMatch(/0071_test\.sql:3/);
    expect(hits[1]).toMatch(/0071_test\.sql:5/);
  });

  it('detects START TRANSACTION', () => {
    const sql = `START TRANSACTION;\nALTER TABLE foo ADD COLUMN bar text;\nCOMMIT;`;
    const hits = scanForTxControl('0072.sql', sql);
    expect(hits.length).toBe(2);
  });

  it('detects ROLLBACK', () => {
    const sql = `ALTER TABLE foo ADD COLUMN bar text;\nROLLBACK;`;
    const hits = scanForTxControl('0073.sql', sql);
    expect(hits.length).toBe(1);
    expect(hits[0]).toMatch(/ROLLBACK/i);
  });

  it('is case-insensitive', () => {
    const sql = `begin;\nALTER TABLE foo ADD COLUMN bar text;\ncommit;`;
    const hits = scanForTxControl('0074.sql', sql);
    expect(hits.length).toBe(2);
  });

  it('IGNORES BEGIN/END inside dollar-quoted DO block', () => {
    const sql = `
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'foo_enum') THEN
          CREATE TYPE foo_enum AS ENUM ('a', 'b');
        END IF;
      END
      $$;
      ALTER TABLE bar ADD COLUMN baz text;
    `;
    const hits = scanForTxControl('0075.sql', sql);
    expect(hits.length).toBe(0);
  });

  it('IGNORES BEGIN inside named dollar-quoted block', () => {
    const sql = `
      CREATE OR REPLACE FUNCTION my_fn() RETURNS trigger AS $body$
      BEGIN
        RAISE NOTICE 'hello';
        RETURN NEW;
      END;
      $body$ LANGUAGE plpgsql;
    `;
    const hits = scanForTxControl('0076.sql', sql);
    expect(hits.length).toBe(0);
  });

  it('IGNORES BEGIN inside line comments', () => {
    const sql = `
      -- BEGIN this is a comment
      ALTER TABLE foo ADD COLUMN bar text;
      -- COMMIT also a comment
    `;
    const hits = scanForTxControl('0077.sql', sql);
    expect(hits.length).toBe(0);
  });

  it('IGNORES BEGIN inside block comments', () => {
    const sql = `
      /* BEGIN; in a block comment
         COMMIT; should not trigger */
      ALTER TABLE foo ADD COLUMN bar text;
    `;
    const hits = scanForTxControl('0078.sql', sql);
    expect(hits.length).toBe(0);
  });

  it('returns empty for clean mig', () => {
    const sql = `
      ALTER TABLE foo ADD COLUMN bar text NOT NULL DEFAULT 'x';
      CREATE INDEX idx_foo_bar ON foo (bar);
      COMMENT ON COLUMN foo.bar IS 'bar column';
    `;
    expect(scanForTxControl('0079.sql', sql).length).toBe(0);
  });

  it('detects BEGIN with extra whitespace', () => {
    const sql = `    BEGIN  ;\nALTER TABLE foo ADD COLUMN bar text;`;
    const hits = scanForTxControl('0080.sql', sql);
    expect(hits.length).toBe(1);
  });
});

// --- ADR-0035: integridad de migraciones ---------------------------------------------

const sha = (c: string) => 'abcdef0123456789'.charAt(c.charCodeAt(0) % 16).repeat(64);
const A = sha('a');
const B = sha('b');
const C = sha('c');
const D = sha('d');

function mapa(entradas: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entradas));
}

function deps(disco: Record<string, string>, ledger: Record<string, string>, manifiesto: DerivaAceptada[] = []) {
  const logs: string[] = [];
  const errores: string[] = [];
  const aplicar = vi.fn(async () => undefined);
  const d: DepsArranque = {
    leerDisco: () => mapa(disco),
    leerLedger: async () => mapa(ledger),
    leerManifiesto: () => manifiesto,
    aplicar,
    log: (l) => logs.push(l),
    error: (l) => errores.push(l),
  };
  return { d, logs, errores, aplicar };
}

function entrada(archivo: string, shaLedger: string, shaDisco: string | null): DerivaAceptada {
  return { archivo, shaLedger, shaDisco, motivo: 'edición aprobada', wi: '#13981' };
}

describe('detectarDeriva', () => {
  it('AC1: la aplicada intacta queda intacta y solo lo no registrado es pendiente', () => {
    const r = detectarDeriva(mapa({ '0001_a.sql': A, '0002_b.sql': B }), mapa({ '0001_a.sql': A }), []);
    expect(r.intactas).toEqual(['0001_a.sql']);
    expect(r.pendientes).toEqual(['0002_b.sql']);
    expect(r.derivas).toEqual([]);
    expect(r.huerfanas).toEqual([]);
  });

  it('AC2: sha distinto del ledger es deriva, con los dos hashes', () => {
    const r = detectarDeriva(mapa({ '0001_a.sql': B }), mapa({ '0001_a.sql': A }), []);
    expect(r.derivas).toEqual([{ archivo: '0001_a.sql', shaLedger: A, shaDisco: B }]);
    expect(r.intactas).toEqual([]);
  });

  it('AC8 caso 1: un pendiente con el mismo sha da pista=sha', () => {
    const r = detectarDeriva(mapa({ '0002_a.sql': A }), mapa({ '0001_a.sql': A }), []);
    expect(r.huerfanas[0]).toMatchObject({ archivo: '0001_a.sql', pista: { caso: 1, tipo: 'sha', nombres: ['0002_a.sql'] } });
  });

  it('AC8 caso 2: sha registrado bajo otro nombre cuyo archivo existe da pista=registrada', () => {
    const r = detectarDeriva(mapa({ '0005_z.sql': A }), mapa({ '0001_a.sql': A, '0005_z.sql': A }), []);
    expect(r.huerfanas[0]).toMatchObject({ archivo: '0001_a.sql', pista: { caso: 2, tipo: 'registrada', nombres: ['0005_z.sql'] } });
  });

  it('AC8 caso 2: si el otro nombre tampoco existe en disco no hay pista', () => {
    const r = detectarDeriva(mapa({}), mapa({ '0001_a.sql': A, '0005_z.sql': A }), []);
    expect(r.huerfanas.map((h) => h.pista.caso)).toEqual([4, 4]);
  });

  it('AC8 caso 3: un pendiente con el mismo nombre sin número y otro sha da pista=nombre', () => {
    const r = detectarDeriva(mapa({ '0275_foo.sql': B }), mapa({ '0274_foo.sql': A }), []);
    expect(r.huerfanas[0]).toMatchObject({ pista: { caso: 3, tipo: 'nombre', nombres: ['0275_foo.sql'] } });
  });

  it('AC8 caso 3: reconoce el prefijo con letra (0004a_)', () => {
    const r = detectarDeriva(mapa({ '0005_foo.sql': B }), mapa({ '0004a_foo.sql': A }), []);
    expect(r.huerfanas[0].pista.caso).toBe(3);
  });

  it('AC8 caso 4: sin rastro da pista=ninguna', () => {
    const r = detectarDeriva(mapa({ '0002_otra.sql': B }), mapa({ '0001_a.sql': A }), []);
    expect(r.huerfanas[0]).toMatchObject({ pista: { caso: 4, tipo: 'ninguna', nombres: [] } });
  });

  it('si coinciden los casos 2 y 3 gana el que aún se re-ejecutaría', () => {
    const r = detectarDeriva(
      mapa({ '0002_foo.sql': B, '0009_z.sql': A }),
      mapa({ '0001_foo.sql': A, '0009_z.sql': A }),
      [],
    );
    expect(r.huerfanas[0].pista.caso).toBe(3);
  });

  it('el manifiesto acepta el par exacto de una deriva, no otra edición', () => {
    const aceptado = detectarDeriva(mapa({ '0001_a.sql': B }), mapa({ '0001_a.sql': A }), [entrada('0001_a.sql', A, B)]);
    expect(aceptado.derivas).toEqual([]);
    expect(aceptado.aceptadas).toHaveLength(1);

    const otraEdicion = detectarDeriva(mapa({ '0001_a.sql': C }), mapa({ '0001_a.sql': A }), [entrada('0001_a.sql', A, B)]);
    expect(otraEdicion.derivas).toHaveLength(1);
    expect(otraEdicion.aceptadas).toEqual([]);
  });

  it('el manifiesto acepta una huérfana solo con shaDisco null y su sha de ledger', () => {
    const aceptada = detectarDeriva(mapa({}), mapa({ '0001_a.sql': A }), [entrada('0001_a.sql', A, null)]);
    expect(aceptada.huerfanas).toEqual([]);
    expect(aceptada.aceptadas).toHaveLength(1);

    expect(detectarDeriva(mapa({}), mapa({ '0001_a.sql': A }), [entrada('0001_a.sql', B, null)]).huerfanas).toHaveLength(1);
    expect(detectarDeriva(mapa({}), mapa({ '0001_a.sql': A }), [entrada('0001_a.sql', A, D)]).huerfanas).toHaveLength(1);
  });
});

describe('lineasReporte', () => {
  it('emite el formato estable del ADR', () => {
    const r = detectarDeriva(
      mapa({ '0001_a.sql': A, '0002_b.sql': C, '0003_c.sql': D }),
      mapa({ '0001_a.sql': A, '0002_b.sql': B, '0099_x.sql': D }),
      [],
    );
    expect(lineasReporte(r)).toEqual([
      `[drift] deriva archivo=0002_b.sql ledger=${B} disco=${C}`,
      `[drift] huerfana archivo=0099_x.sql ledger=${D} pista=sha:0003_c.sql`,
      '[drift] resumen intactas=1 aceptadas=0 derivas=1 huerfanas=1 pendientes=1',
    ]);
  });
});

describe('decidir (la lógica de aborto, sin activar en PR 1)', () => {
  it('AC2: con deriva y sin bandera aborta y nombra archivo y acción correctiva', () => {
    const r = detectarDeriva(mapa({ '0001_a.sql': B }), mapa({ '0001_a.sql': A }), []);
    const d = decidir(r);
    expect(d.accion).toBe('abortar');
    if (d.accion !== 'abortar') return;
    expect(d.codigo).not.toBe(0);
    expect(d.razones.join('\n')).toMatch(/0001_a\.sql.*restaurar los bytes aplicados.*derivas-aceptadas\.json/);
  });

  it.each([
    [1, { '0002_a.sql': A }, /restaurar el nombre registrado/],
    [2, { '0002_z.sql': A }, /doble efecto.*shaDisco null/],
    [3, { '0002_a.sql': B }, /restaurar el nombre registrado revisando el diff/],
    [4, {}, /investigar/],
  ] as const)('AC8: la huérfana del caso %i aborta con su acción', (caso, disco, accion) => {
    const ledger = caso === 2 ? { '0001_a.sql': A, '0002_z.sql': A } : { '0001_a.sql': A };
    const d = decidir(detectarDeriva(mapa(disco), mapa(ledger), []));
    expect(d.accion).toBe('abortar');
    if (d.accion === 'abortar') expect(d.razones.join('\n')).toMatch(accion);
  });

  it('AC6: --allow-drift continúa y registra archivo y motivo por cada hallazgo', () => {
    const r = detectarDeriva(mapa({ '0001_a.sql': B }), mapa({ '0001_a.sql': A, '0099_x.sql': C }), []);
    const d = decidir(r, 'incidente 42');
    expect(d.accion).toBe('continuar');
    if (d.accion !== 'continuar') return;
    expect(d.registros).toContain('[drift] allow-drift archivo=0001_a.sql motivo=incidente 42');
    expect(d.registros).toContain('[drift] allow-drift archivo=0099_x.sql motivo=incidente 42');
  });

  it.each([
    [1, { '0002_a.sql': A }],
    [3, { '0002_a.sql': B }],
  ])('AC8/H2: --allow-drift en el caso %i avisa de la re-ejecución y nombra el archivo', (_caso, disco) => {
    const d = decidir(detectarDeriva(mapa(disco), mapa({ '0001_a.sql': A }), []), 'motivo');
    expect(d.accion).toBe('continuar');
    if (d.accion === 'continuar') {
      expect(d.registros.join('\n')).toMatch(/aviso-reejecucion archivo=0002_a\.sql huerfana=0001_a\.sql.*se ejecutará de nuevo/);
    }
  });

  it('--allow-drift en los casos 2 y 4 no avisa de re-ejecución', () => {
    const d = decidir(detectarDeriva(mapa({ '0002_z.sql': A }), mapa({ '0001_a.sql': A, '0002_z.sql': A, '0003_b.sql': B }), []), 'motivo');
    expect(d.accion === 'continuar' && d.registros.join('\n')).not.toMatch(/aviso-reejecucion/);
  });

  it('una huérfana aceptada que se re-ejecutaría también avisa', () => {
    const d = decidir(detectarDeriva(mapa({ '0002_a.sql': A }), mapa({ '0001_a.sql': A }), [entrada('0001_a.sql', A, null)]));
    expect(d.accion).toBe('continuar');
    if (d.accion === 'continuar') expect(d.registros.join('\n')).toMatch(/aviso-reejecucion archivo=0002_a\.sql.*origen=manifiesto/);
  });

  it('todo aceptado o intacto continúa sin registrar nada', () => {
    const d = decidir(detectarDeriva(mapa({ '0001_a.sql': B, '0002_b.sql': C }), mapa({ '0001_a.sql': A, '0002_b.sql': C }), [entrada('0001_a.sql', A, B)]));
    expect(d).toEqual({ accion: 'continuar', registros: [] });
  });

  it('un manifiesto inválido aborta salvo --allow-drift', () => {
    const r = { ...detectarDeriva(mapa({}), mapa({}), []), errorManifiesto: 'JSON inválido' };
    expect(decidir(r).accion).toBe('abortar');
    expect(decidir(r, 'motivo').accion).toBe('continuar');
  });
});

describe('arrancar', () => {
  it('AC1 y AC3: aplica solo las pendientes, en orden, sin hallazgos', async () => {
    const { d, aplicar } = deps(
      { '0003_c.sql': C, '0001_a.sql': A, '0002_b.sql': B },
      { '0001_a.sql': A },
    );
    expect(await arrancar(d, {}, decidir)).toBe(0);
    expect(aplicar.mock.calls.map(([f]) => f)).toEqual(['0002_b.sql', '0003_c.sql']);
  });

  it('AC2: si `decidir` aborta, `aplicar` no se llama y la salida no es 0', async () => {
    const { d, aplicar, errores, logs } = deps(
      { '0001_a.sql': B, '0002_b.sql': C },
      { '0001_a.sql': A },
    );
    const codigo = await arrancar(d, {}, decidir);
    expect(codigo).toBe(EXIT_DERIVA);
    expect(aplicar).not.toHaveBeenCalled();
    expect(logs.join('\n')).toMatch(/\[drift\] deriva archivo=0001_a\.sql/);
    expect(errores.join('\n')).toMatch(/0001_a\.sql.*restaurar/);
  });

  it('AC6: sin --allow-drift aborta; con él aplica y registra', async () => {
    const sin = deps({ '0002_b.sql': C }, { '0001_a.sql': A });
    expect(await arrancar(sin.d, {}, decidir)).toBe(EXIT_DERIVA);
    expect(sin.aplicar).not.toHaveBeenCalled();

    const con = deps({ '0002_b.sql': C }, { '0001_a.sql': A });
    expect(await arrancar(con.d, { motivoAllowDrift: 'restauración' }, decidir)).toBe(0);
    expect(con.aplicar).toHaveBeenCalledWith('0002_b.sql');
    expect(con.logs).toContain('[drift] allow-drift archivo=0001_a.sql motivo=restauración');
  });
});

describe('garantía del PR 1: el arranque normal no aborta (ADR-0035 §A)', () => {
  it('DRIFT_ABORTA es false', () => {
    expect(DRIFT_ABORTA).toBe(false);
  });

  it('con deriva y huérfanas de los 4 casos sale con 0, informa y aplica las pendientes', async () => {
    const { d, logs, errores, aplicar } = deps(
      {
        '0001_a.sql': B, // deriva
        '0011_uno.sql': C, // caso 1 de 0010_uno
        '0021_dos.sql': D, // caso 2 de 0020_dos
        '0031_tres.sql': A, // caso 3 de 0030_tres
      },
      {
        '0001_a.sql': A,
        '0010_uno.sql': C,
        '0020_dos.sql': D,
        '0021_dos.sql': D,
        '0030_tres.sql': B,
        '0040_cuatro.sql': sha('e'),
      },
    );
    expect(await arrancar(d, {})).toBe(0);
    expect(errores).toEqual([]);
    expect(aplicar.mock.calls.map(([f]) => f)).toEqual(['0011_uno.sql', '0031_tres.sql']);
    const salida = logs.join('\n');
    expect(salida).toMatch(/\[drift\] deriva archivo=0001_a\.sql/);
    for (const pista of ['sha:0011_uno.sql', 'registrada:0021_dos.sql', 'nombre:0031_tres.sql', 'ninguna']) {
      expect(salida).toContain(`pista=${pista}`);
    }
    expect(salida).toMatch(/\[drift\] sin-aborto DRIFT_ABORTA=false/);
  });

  it('la renombrada pendiente se aplica como hoy y queda registrada con aviso', async () => {
    const { d, logs, aplicar } = deps({ '0002_a.sql': A }, { '0001_a.sql': A });
    expect(await arrancar(d, {})).toBe(0);
    expect(aplicar).toHaveBeenCalledWith('0002_a.sql');
    expect(logs.join('\n')).toMatch(/aviso-reejecucion archivo=0002_a\.sql huerfana=0001_a\.sql/);
  });

  it('un manifiesto inválido tampoco aborta: lo informa y sigue', async () => {
    const { d, logs, aplicar } = deps({ '0001_a.sql': A }, {});
    d.leerManifiesto = () => {
      throw new ManifiestoInvalidoError('JSON inválido');
    };
    expect(await arrancar(d, {})).toBe(0);
    expect(aplicar).toHaveBeenCalledWith('0001_a.sql');
    expect(logs.join('\n')).toMatch(/\[drift\] manifiesto-invalido JSON inválido/);
  });

  it('decidirArranque nunca devuelve abortar', () => {
    const r = detectarDeriva(mapa({ '0001_a.sql': B }), mapa({ '0001_a.sql': A, '0099_x.sql': C }), []);
    expect(decidirArranque(r).accion).toBe('continuar');
    expect(decidirArranque({ ...r, errorManifiesto: 'x' }).accion).toBe('continuar');
  });

  it('main no inyecta otra decisión: usa la puerta por defecto', () => {
    const fuente = readFileSync(fileURLToPath(new URL('../../src/scripts/db-apply.ts', import.meta.url)), 'utf8');
    expect(fuente).toContain('return arrancar(deps, { motivoAllowDrift: opciones.motivoAllowDrift });');
    expect(fuente.match(/arrancar\(/g)).toHaveLength(2); // la definición y la llamada de main
  });

  it('main atiende --check-drift antes de crear el ledger: ese modo no escribe', () => {
    const fuente = readFileSync(fileURLToPath(new URL('../../src/scripts/db-apply.ts', import.meta.url)), 'utf8');
    const cuerpoMain = fuente.slice(fuente.indexOf('async function main('));
    const crearLedger = cuerpoMain.search(/ensureTrackingTable\(\)/);
    expect(crearLedger).toBeGreaterThan(-1);
    expect(cuerpoMain.indexOf('return comprobarDeriva(')).toBeGreaterThan(-1);
    expect(crearLedger).toBeGreaterThan(cuerpoMain.indexOf('return comprobarDeriva('));
  });
});

describe('archivo ilegible (ADR-0035 §A)', () => {
  const eacces = () => new Error('EACCES: permission denied, open /ruta/sensible/archivo.sql');
  const leerSalvo = (ilegible: string, contenido: Record<string, Buffer>) => (f: string): Buffer => {
    if (f === ilegible) throw eacces();
    return contenido[f];
  };
  const bytes = Buffer.from('SELECT 1;');
  const shaBytes = sha256De(bytes);

  it('hashearDisco: un archivo ilegible queda en null y la causa no sale por consola', () => {
    const espias = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      const disco = hashearDisco(['0001_a.sql', '0002_b.sql'], leerSalvo('0001_a.sql', { '0002_b.sql': bytes }));

      expect(disco.get('0001_a.sql')).toBeNull();
      expect(disco.get('0002_b.sql')).toBe(shaBytes);
      expect(espias.flatMap((e) => e.mock.calls).flat().join('\n')).not.toMatch(/EACCES|\/ruta\/sensible/);
    } finally {
      espias.forEach((e) => e.mockRestore());
    }
  });

  it('arranque: un registrado ilegible se informa sin causa, no aborta y aplica las pendientes', async () => {
    const disco = hashearDisco(
      ['0001_a.sql', '0002_b.sql', '0003_c.sql'],
      leerSalvo('0001_a.sql', { '0002_b.sql': bytes, '0003_c.sql': bytes }),
    );
    const { d, logs, errores, aplicar } = deps({}, { '0001_a.sql': A, '0002_b.sql': shaBytes });
    d.leerDisco = () => disco;

    expect(await arrancar(d, {})).toBe(0);

    expect(errores).toEqual([]);
    expect(aplicar.mock.calls.map(([f]) => f)).toEqual(['0003_c.sql']);
    expect(logs).toContain('[drift] ilegible archivo=0001_a.sql');
    const salida = logs.join('\n');
    expect(salida).not.toMatch(/EACCES|\/ruta\/sensible/);
    expect(salida).not.toMatch(/\[drift\] (deriva|huerfana) archivo=0001_a\.sql/);
  });

  it('arranque: un pendiente ilegible falla al aplicarlo, en su turno, como hasta hoy', async () => {
    const disco = hashearDisco(
      ['0001_a.sql', '0002_b.sql', '0003_c.sql'],
      leerSalvo('0002_b.sql', { '0001_a.sql': bytes, '0003_c.sql': bytes }),
    );
    const { d, logs } = deps({}, {});
    d.leerDisco = () => disco;
    const aplicadas: string[] = [];
    d.aplicar = async (f) => {
      if (disco.get(f) === null) throw eacces();
      aplicadas.push(f);
    };

    await expect(arrancar(d, {})).rejects.toThrow('EACCES');

    expect(aplicadas).toEqual(['0001_a.sql']);
    expect(logs).toContain('[drift] ilegible archivo=0002_b.sql');
  });

  it.each([
    ['registrado', { '0001_a.sql': A }],
    ['pendiente', {}],
  ])('--check-drift: un %s ilegible es hallazgo y sale 3', async (_caso, ledger: Record<string, string>) => {
    const { d, logs } = deps({}, ledger);
    d.leerDisco = () => hashearDisco(['0001_a.sql'], leerSalvo('0001_a.sql', {}));

    expect(await comprobarDeriva(d)).toBe(EXIT_DERIVA);

    expect(logs).toContain('[drift] ilegible archivo=0001_a.sql');
    expect(logs.join('\n')).toMatch(/\[drift\] accion archivo=0001_a\.sql/);
    expect(logs.join('\n')).not.toMatch(/EACCES|\/ruta\/sensible/);
  });

  it('activar el aborto (PR 2) basta para que el registrado ilegible aborte: decidir ya lo trata como hallazgo', async () => {
    const { d, aplicar } = deps({}, { '0001_a.sql': A });
    d.leerDisco = () => hashearDisco(['0001_a.sql', '0002_b.sql'], leerSalvo('0001_a.sql', { '0002_b.sql': bytes }));

    expect(await arrancar(d, {}, decidir)).toBe(EXIT_DERIVA);
    expect(aplicar).not.toHaveBeenCalled();
  });
});

describe('comprobarDeriva (--check-drift)', () => {
  it('AC5: sale 3 con deriva, la reporta y no tiene cómo aplicar', async () => {
    const { d, logs } = deps({ '0001_a.sql': B }, { '0001_a.sql': A });
    expect(await comprobarDeriva(d)).toBe(EXIT_DERIVA);
    expect(logs.join('\n')).toMatch(/\[drift\] deriva archivo=0001_a\.sql/);
    expect(logs.join('\n')).toMatch(/\[drift\] accion archivo=0001_a\.sql/);
    expect(d.aplicar).not.toHaveBeenCalled();
  });

  it('AC8: reporta la huérfana con su pista y sale 3', async () => {
    const { d, logs } = deps({ '0002_a.sql': A }, { '0001_a.sql': A });
    expect(await comprobarDeriva(d)).toBe(EXIT_DERIVA);
    expect(logs.join('\n')).toMatch(/\[drift\] huerfana archivo=0001_a\.sql .*pista=sha:0002_a\.sql/);
  });

  it('sale 0 limpio, aunque haya pendientes o deriva aceptada', async () => {
    const { d, logs } = deps(
      { '0001_a.sql': B, '0002_b.sql': C },
      { '0001_a.sql': A },
      [entrada('0001_a.sql', A, B)],
    );
    expect(await comprobarDeriva(d)).toBe(0);
    expect(logs).toEqual(['[drift] resumen intactas=0 aceptadas=1 derivas=0 huerfanas=0 pendientes=1']);
  });

  it('sin ledger lo informa y sale 0', async () => {
    const { d, logs } = deps({ '0001_a.sql': A }, {});
    expect(await comprobarDeriva({ ...d, leerLedger: async () => null })).toBe(0);
    expect(logs.join('\n')).toMatch(/\[drift\] sin-ledger/);
  });

  it('un manifiesto inválido sale 1', async () => {
    const { d, errores } = deps({}, {});
    d.leerManifiesto = () => {
      throw new ManifiestoInvalidoError('debe ser un arreglo');
    };
    expect(await comprobarDeriva(d)).toBe(1);
    expect(errores.join('\n')).toMatch(/manifiesto-invalido/);
  });

  it('un error de conexión se propaga (main sale 1)', async () => {
    const { d } = deps({}, {});
    await expect(comprobarDeriva({ ...d, leerLedger: async () => { throw new Error('ECONNREFUSED'); } })).rejects.toThrow('ECONNREFUSED');
  });

  it('la conexión impone solo lectura en Postgres, y solo en este modo', () => {
    expect(opcionesConexion(true).connection).toEqual({ default_transaction_read_only: true });
    expect(opcionesConexion(false)).toEqual({ max: 1 });
  });
});

describe('parsearArgs', () => {
  it('AC6: extrae el motivo, también con espacios', () => {
    expect(parsearArgs(['--allow-drift=restauración de PDN']).motivoAllowDrift).toBe('restauración de PDN');
  });

  it.each([['--allow-drift'], ['--allow-drift='], ['--allow-drift=   ']])('AC6: %j sin motivo es error', (arg) => {
    expect(() => parsearArgs([arg])).toThrow(ArgumentoInvalidoError);
  });

  it('colapsa saltos de línea para no romper el log', () => {
    expect(parsearArgs(['--allow-drift=a\nb']).motivoAllowDrift).toBe('a b');
  });

  it.each([
    [['--check-drift', '--allow-drift=x']],
    [['--check-drift', '--mark-all']],
    [['--mark-all', '--allow-drift=x']],
  ])('rechaza la combinación %j', (argv) => {
    expect(() => parsearArgs(argv)).toThrow(ArgumentoInvalidoError);
  });

  it('reconoce los modos', () => {
    expect(parsearArgs(['--dry', '--check-drift'])).toEqual({ dry: true, markAll: false, checkDrift: true });
    expect(parsearArgs([])).toEqual({ dry: false, markAll: false, checkDrift: false });
  });
});

describe('validarManifiesto', () => {
  it('acepta vacío y entradas completas', () => {
    expect(validarManifiesto('[]')).toEqual([]);
    expect(validarManifiesto(JSON.stringify([entrada('0001_a.sql', A, null), entrada('0002_b.sql', A, B)]))).toHaveLength(2);
  });

  it('el manifiesto versionado de este repo es válido', () => {
    const crudo = readFileSync(fileURLToPath(new URL('../../src/db/migrations/derivas-aceptadas.json', import.meta.url)), 'utf8');
    expect(() => validarManifiesto(crudo)).not.toThrow();
  });

  it.each([
    ['no es JSON', 'x'],
    ['no es arreglo', '{}'],
    ['entrada nula', '[null]'],
    ['sin motivo', JSON.stringify([{ ...entrada('0001_a.sql', A, B), motivo: ' ' }])],
    ['sin wi', JSON.stringify([{ archivo: '0001_a.sql', shaLedger: A, shaDisco: B, motivo: 'x' }])],
    ['sha mal formado', JSON.stringify([entrada('0001_a.sql', 'abc', B)])],
    ['shaDisco ausente', JSON.stringify([{ archivo: '0001_a.sql', shaLedger: A, motivo: 'x', wi: '#1' }])],
    ['archivo que no es sql', JSON.stringify([entrada('README.md', A, B)])],
  ])('rechaza: %s', (_nombre, crudo) => {
    expect(() => validarManifiesto(crudo)).toThrow(ManifiestoInvalidoError);
  });
});

describe('marcarTodas (--mark-all)', () => {
  it('no reescribe el sha de una ya registrada: ON CONFLICT DO NOTHING', async () => {
    const consultas: string[] = [];
    const cliente = ((partes: unknown, ...valores: unknown[]) => {
      if (!Array.isArray(partes)) return partes; // sql(identificador)
      consultas.push(partes.join('?'));
      void valores;
      return Promise.resolve([]);
    }) as unknown as Parameters<typeof marcarTodas>[0];
    await marcarTodas(cliente, [{ filename: '0001_a.sql', sha256: A }]);
    expect(consultas).toHaveLength(1);
    expect(consultas[0]).toMatch(/ON CONFLICT \(filename\) DO NOTHING/);
    expect(consultas[0]).not.toMatch(/DO UPDATE/);
  });
});

describe('sha256De', () => {
  it('hashea los bytes, sin decodificar', () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x41]); // no es UTF-8 válido
    expect(sha256De(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(sha256De(bytes)).not.toBe(createHash('sha256').update(bytes.toString('utf8')).digest('hex'));
  });
});
