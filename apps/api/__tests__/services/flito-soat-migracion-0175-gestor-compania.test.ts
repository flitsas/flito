// HU #12078 (Feature #12074) — guarda de contrato de la migración 0175: el gestor por defecto del
// canal sin trámite y la invariante que impide abrir el canal sin destinatario.
//
// Análisis estático puro: NO toca la base. P6 —aplicar el SQL DOS VECES contra la BD local— vive en
// el HANDOFF del backend-agent, no aquí: un test que abriera una conexión no correría en CI.
//
// Este archivo se escribe ANTES que el resolutor a propósito. Lo que fija son las dos cosas que una
// revisión puede degradar sin que NADA funcional se ponga rojo (ADR-0005, notas para `qa-agent`):
//
//   1. **`ON DELETE RESTRICT`.** Cambiarlo por `SET NULL` deja toda la suite en verde y abre por
//      detrás justo el estado que el AC2c declara imposible: canal encendido, destino vacío. En
//      silencio, además, porque ninguna consulta lo delata.
//   2. **La forma del predicado del CHECK.** Convertirlo en bidireccional —o ponerle `NOT VALID`—
//      tampoco rompe ningún camino feliz: lo primero prohibiría conservar el gestor al apagar el
//      flag (segunda mitad del AC2c) y lo segundo dejaría vivas exactamente las filas que la
//      constraint existe para impedir.
//
// Lo demás que se afirma, por orden de lo que costaría si dejara de ser verdad:
//
//   3. **La columna es `uuid` NULLABLE y sin default** (AC2b). Un `NOT NULL` obligaría a inventarle
//      un gestor a cada compañía; un default escribiría en la base un destino que nadie eligió.
//   4. **El apagado del paso 2 toca el FLAG y solo el flag.** Si además pusiera el gestor a NULL —o
//      si apagara compañías que sí tienen destino— la migración estaría desconfigurando entornos.
//   5. **Idempotencia real** (P6): `ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` + `ADD`.
//   6. **Paridad con `schema.ts`**, por la lección de la 0157: una columna que solo vive en la base
//      convence a quien lee `schema.ts` de que no hace falta migración.
//   7. **`flito_reglas_proveedor_soat` no aparece** (AC2): sus reglas se retiraron en la HU #10979 y
//      esta migración no las resucita ni de paso.
//   8. **La 0174 no se reescribe** — ya está aplicada y su sha256 registrado.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { CLIENTS_COLUMNAS_PII, CLIENTS_COLUMNAS_SIN_PII } from '@operaciones/shared-types';
import { clients } from '../../src/db/schema.js';
import { scanForTxControl } from '../../src/scripts/db-apply.js';

const ARCHIVO = '0175_flito_soat_gestor_por_defecto_compania.sql';
const COLUMNA = 'flito_proveedor_soat_sin_tramite_id';
const CHK = 'clients_sin_tramite_gestor_chk';

const leer = (nombre: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/db/migrations/${nombre}`, import.meta.url)), 'utf8');

const CRUDO = leer(ARCHIVO);

/**
 * Quita los comentarios `--` sin tocar lo que va dentro de una cadena. Calcado de la suite de la
 * 0174 y por el mismo motivo: media docena de afirmaciones de este archivo son sobre lo que el SQL
 * **no** dice (`SET NULL`, `NOT VALID`, `CREATE INDEX`, `flito_reglas_proveedor_soat`), y la prosa
 * de la cabecera de la migración las nombra TODAS para explicar por qué no están. Sin podar, cada
 * negación sería verde por el comentario que la justifica — que es la peor clase de verde.
 */
function podarComentarios(texto: string): string {
  let salida = '';
  let enCadena = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (enCadena) {
      salida += c;
      if (c === "'") enCadena = false;
      continue;
    }
    if (c === "'") { enCadena = true; salida += c; continue; }
    if (c === '-' && texto[i + 1] === '-') {
      while (i < texto.length && texto[i] !== '\n') i++;
      salida += '\n';
      continue;
    }
    salida += c;
  }
  return salida;
}

const SQL = podarComentarios(CRUDO);

describe('migración 0175 — la columna del gestor por defecto', () => {
  it('no lleva control de transacción propio (ADR-DB-001)', () => {
    expect(scanForTxControl(ARCHIVO, CRUDO)).toEqual([]);
  });

  it(`**\`clients.${COLUMNA}\` es \`uuid\` y entra con \`IF NOT EXISTS\`**`, () => {
    expect(SQL).toMatch(
      new RegExp(`ALTER TABLE\\s+clients\\s+ADD COLUMN IF NOT EXISTS\\s+${COLUMNA}\\s+uuid`, 'i'),
    );
  });

  it('**la FK es a `flito_proveedores_soat(id)` con `ON DELETE RESTRICT` EXPLÍCITO**', () => {
    // El mutante que mata: `ON DELETE SET NULL`. Aplicaría sin error, no rompería ningún camino
    // feliz, y borrar un proveedor dejaría a sus compañías con el canal ABIERTO y sin destino —el
    // estado que el AC2c declara imposible— sin que ninguna consulta lo delatara.
    const linea = new RegExp(`ADD COLUMN IF NOT EXISTS\\s+${COLUMNA}[^;]*`, 'i').exec(SQL);
    expect(linea, `no se encontró el ADD COLUMN de ${COLUMNA}`).not.toBeNull();
    expect(linea![0]).toMatch(/REFERENCES\s+flito_proveedores_soat\s*\(\s*id\s*\)/i);
    expect(linea![0]).toMatch(/ON DELETE RESTRICT/i);
    // Y ninguna de las dos alternativas, ni siquiera en otra FK de este archivo.
    expect(SQL).not.toMatch(/ON DELETE SET NULL/i);
    expect(SQL).not.toMatch(/ON DELETE CASCADE/i);
  });

  it('**NULLABLE y sin DEFAULT**: casi ninguna compañía tiene el canal abierto', () => {
    // Un `NOT NULL` obligaría a inventarle un gestor a cada compañía; un DEFAULT escribiría en la
    // base un destino que nadie eligió. La obligatoriedad es CONDICIONAL al flag y la sostiene el
    // CHECK, no la columna.
    const linea = new RegExp(`ADD COLUMN IF NOT EXISTS\\s+${COLUMNA}[^;]*`, 'i').exec(SQL);
    expect(linea![0]).not.toMatch(/NOT NULL/i);
    expect(linea![0]).not.toMatch(/DEFAULT/i);
  });

  it('**una y solo una columna**, con la guarda: ni una de más', () => {
    expect(SQL.match(/ADD COLUMN IF NOT EXISTS/gi) ?? []).toHaveLength(1);
    // Una sola sin la guarda rompería la segunda pasada entera (42701).
    expect(SQL.match(/ADD COLUMN/gi) ?? []).toHaveLength(1);
  });

  it('**sin índice, y es deliberado**: `clients` tiene cientos de filas y no hay DELETE de proveedores', () => {
    expect(SQL).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX/i);
  });

  it('**la columna lleva `COMMENT ON COLUMN` y dice que es SOLO del canal sin trámite** (AC2b)', () => {
    expect(SQL).toMatch(new RegExp(`COMMENT ON COLUMN\\s+clients\\.${COLUMNA}\\s+IS`, 'i'));
    // El comentario existe para que quien mire `\\d clients` sepa el límite del AC2e sin leer el
    // código: tiene que nombrar el canal y la ruta que NO la lee.
    const comentario = new RegExp(`COMMENT ON COLUMN\\s+clients\\.${COLUMNA}\\s+IS([\\s\\S]*?);`, 'i')
      .exec(SQL)![1];
    expect(comentario).toMatch(/SIN TRAMITE/i);
    expect(comentario).toMatch(/enviar/i);
  });
});

describe('migración 0175 — la invariante «canal encendido ⇒ gestor configurado» (AC2c)', () => {
  it('**el CHECK existe, con el patrón `DROP IF EXISTS` + `ADD`** (idempotencia)', () => {
    expect(SQL).toMatch(new RegExp(`ALTER TABLE\\s+clients\\s+DROP CONSTRAINT IF EXISTS\\s+${CHK}\\s*;`, 'i'));
    expect(SQL).toMatch(new RegExp(`ALTER TABLE\\s+clients\\s+ADD CONSTRAINT\\s+${CHK}`, 'i'));
  });

  it('**el predicado es la implicación material, en UN solo sentido**', () => {
    // `soat_sin_tramite = false OR <gestor> IS NOT NULL` — calcado de `users_cliente_compania_chk`.
    // El mutante que mata: hacerlo bidireccional (`AND` / `= (… IS NOT NULL)`), que prohibiría
    // conservar el gestor al APAGAR el flag y rompería la segunda mitad del AC2c.
    const predicado = new RegExp(`ADD CONSTRAINT\\s+${CHK}\\s+CHECK\\s*\\(([^;]*)\\)\\s*;`, 'i').exec(SQL);
    expect(predicado, 'no se encontró el CHECK').not.toBeNull();
    const texto = predicado![1].replace(/\s+/g, ' ').trim();
    expect(texto).toMatch(
      new RegExp(`^soat_sin_tramite\\s*=\\s*false\\s+OR\\s+${COLUMNA}\\s+IS NOT NULL$`, 'i'),
    );
    expect(texto).not.toMatch(/\bAND\b/i);
  });

  it('**sin `NOT VALID`**: el AC2c dice «no puede existir», no «no puede crearse desde ahora»', () => {
    // `NOT VALID` dejaría vivas exactamente las filas que la constraint existe para impedir.
    expect(SQL).not.toMatch(/NOT VALID/i);
  });

  it('el CHECK lleva `COMMENT ON CONSTRAINT` explicando por qué la base y no solo Zod', () => {
    expect(SQL).toMatch(new RegExp(`COMMENT ON CONSTRAINT\\s+${CHK}\\s+ON\\s+clients\\s+IS`, 'i'));
  });
});

describe('migración 0175 — el apagado de las compañías sin destino', () => {
  it('**un solo `UPDATE`, y apaga el FLAG: no toca el gestor**', () => {
    const updates = SQL.match(/\bUPDATE\b/gi) ?? [];
    expect(updates).toHaveLength(1);
    const sentencia = /UPDATE\s+clients[\s\S]*?;/i.exec(SQL)![0].replace(/\s+/g, ' ');
    expect(sentencia).toMatch(/SET\s+soat_sin_tramite\s*=\s*false/i);
    // El mutante que mata: añadir `, <columna> = NULL` al SET. Sería desconfigurar entornos por
    // una migración, y el estado resultante pasaría el CHECK igual.
    expect(sentencia).not.toMatch(new RegExp(`${COLUMNA}\\s*=`, 'i'));
  });

  it('**el `WHERE` es la CONJUNCIÓN de los dos predicados**: canal abierto Y sin destino', () => {
    // Se ancla el `WHERE` ENTERO, y no cada predicado por su lado. El mutante que mata:
    // `WHERE soat_sin_tramite = true OR <columna> IS NULL` — contiene los dos predicados, así que
    // pasaba las dos comprobaciones sueltas, y apaga el canal de TODA compañía que lo tenga
    // encendido, **incluidas las que sí tienen gestor configurado**.
    //
    // Hoy sería inocuo, porque en la primera pasada la columna acaba de nacer y TODAS las filas la
    // tienen NULL. Deja de serlo en cuanto la migración se reaplique sobre una base donde Operaciones
    // ya configuró gestores —restauración, entorno nuevo, fila de `schema_migrations` borrada—: ahí
    // el `OR` desconfiguraría el canal de las compañías correctas, en silencio y sin vuelta atrás.
    const sentencia = /UPDATE\s+clients[\s\S]*?;/i.exec(SQL)![0].replace(/\s+/g, ' ');
    expect(sentencia).toMatch(
      new RegExp(`WHERE soat_sin_tramite = true AND ${COLUMNA} IS NULL\\s*;$`, 'i'),
    );
    // Simétrico al `not.toMatch(/\bAND\b/i)` del CHECK, y por el mismo motivo: la conjunción y la
    // disyunción son las dos formas que el SQL acepta y solo una es la correcta.
    expect(sentencia).not.toMatch(/\bOR\b/i);
  });

  it('**el bloque `DO` entero solo agrega IDS**: ni el `string_agg` ni el aviso tocan columnas personales', () => {
    // El alcance es el bloque COMPLETO y no el `RAISE NOTICE`, que es donde este canario miraba y
    // donde no se decide nada: el valor interpolado se calcula ANTES, en el `SELECT string_agg(...)`.
    // El mutante que sobrevivía a la versión anterior:
    //
    //     SELECT string_agg(id::text || ' ' || name, ', ' ORDER BY id) INTO afectadas
    //
    // — el NOMBRE de cada compañía en el log del despliegue, con el `RAISE NOTICE` intacto.
    expect(SQL).toMatch(/RAISE NOTICE\s+'\[0175\]/i);
    const bloque = /DO \$\$[\s\S]*?\$\$\s*;/i.exec(SQL);
    expect(bloque, 'no se encontró el bloque DO $$ … $$').not.toBeNull();
    const texto = bloque![0].replace(/\s+/g, ' ');

    // La expresión agregada, anclada entera: el id pelado, sin concatenar nada más.
    expect(texto).toMatch(/SELECT string_agg\(id::text, ', ' ORDER BY id\) INTO afectadas/i);
    // Y una sola agregación: una segunda `string_agg` sería otra columna por otra vía.
    expect(texto.match(/string_agg/gi) ?? []).toHaveLength(1);

    // Ninguna columna personal de `clients`, y la lista NO se escribe a mano: sale de la misma
    // constante que clasifica la tabla, así que una columna de PII nueva queda cubierta sola. El id
    // basta para reconfigurar la compañía y no es dato personal; el NOMBRE sí lo sería (una compañía
    // puede ser persona natural). Mismo criterio que los NOTICE de la 0173.
    const columnasClients = clients as unknown as Record<string, { name?: string } | undefined>;
    for (const clave of CLIENTS_COLUMNAS_PII) {
      const columna = columnasClients[clave]?.name;
      expect(columna, `${clave} no es una columna de clients`).toBeDefined();
      expect(texto, `el bloque DO nombra la columna personal ${columna}`)
        .not.toMatch(new RegExp(`\\b${columna}\\b`, 'i'));
    }

    // Y el aviso dice qué hacer: sin eso, quien lea el log ve una lista de números y nada más.
    expect(texto).toMatch(/companias\/:id|PATCH/i);
  });

  it('**el apagado va ANTES del CHECK**: al revés, la cadena entera aborta con 23514', () => {
    const posUpdate = SQL.search(/UPDATE\s+clients/i);
    const posCheck = SQL.search(new RegExp(`ADD CONSTRAINT\\s+${CHK}`, 'i'));
    expect(posUpdate).toBeGreaterThan(-1);
    expect(posCheck).toBeGreaterThan(-1);
    expect(posUpdate).toBeLessThan(posCheck);
  });

  it('la migración no inserta ni borra filas: solo apaga un flag', () => {
    expect(SQL).not.toMatch(/\bINSERT\b/i);
    expect(SQL).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});

describe('migración 0175 — lo que NO resucita', () => {
  it('**`flito_reglas_proveedor_soat` no se nombra** (AC2): se retiró en la HU #10979', () => {
    expect(SQL).not.toMatch(/flito_reglas_proveedor_soat/i);
    // Ni el vocabulario de aquellas reglas: sin ámbitos y sin prioridades.
    expect(SQL).not.toMatch(/ambito|prioridad/i);
  });

  it('no toca `users` ni `flito_soat`: esta migración es de `clients`', () => {
    expect(SQL).not.toMatch(/ALTER TABLE\s+users\b/i);
    expect(SQL).not.toMatch(/ALTER TABLE\s+flito_soat\b/i);
    // En particular NO arregla el `ON DELETE` que le falta a `users.flito_proveedor_soat_id`: eso es
    // DROP + ADD CONSTRAINT con ACCESS EXCLUSIVE sobre `users` por algo que hoy no se ejecuta nunca.
    // Queda anotado como deuda, no como alcance de esta HU.
    expect(SQL).not.toMatch(/flito_proveedor_soat_id\b/i);
  });
});

describe('paridad 0175 ↔ schema.ts', () => {
  const config = getTableConfig(clients);
  const columna = config.columns.find((c) => c.name === COLUMNA);

  it('`clients` declara la columna, uuid, nullable y sin default', () => {
    expect(columna, `${COLUMNA} no está en schema.ts`).toBeDefined();
    expect(columna!.getSQLType()).toBe('uuid');
    expect(columna!.notNull, 'NOT NULL obligaría a inventarle gestor a cada compañía').toBe(false);
    expect(columna!.hasDefault, 'un default escribiría un destino que nadie eligió').toBe(false);
  });

  it('**la FK de `schema.ts` también dice `restrict`**: las dos caras del mismo hecho', () => {
    // Si solo lo dijera el SQL, un `drizzle-kit` futuro «corregiría» la base hacia lo que declara
    // el esquema. Los dos tienen que decir lo mismo.
    const fk = config.foreignKeys.find((f) =>
      f.reference().columns.some((c) => c.name === COLUMNA));
    expect(fk, `no hay FK declarada para ${COLUMNA}`).toBeDefined();
    expect(fk!.onDelete).toBe('restrict');
    // Y apunta al catálogo de proveedores, no a `users` (donde vive la columna homónima del gestor).
    expect(getTableName(fk!.reference().foreignTable)).toBe('flito_proveedores_soat');
    expect(fk!.reference().foreignColumns.map((c) => c.name)).toEqual(['id']);
  });

  it('la columna vive PEGADA a `soat_sin_tramite`: son el mismo hecho partido en dos', () => {
    // El CHECK las ata; separarlas en el esquema invitaría a leer una sin la otra.
    const nombres = config.columns.map((c) => c.name);
    expect(nombres.indexOf(COLUMNA)).toBe(nombres.indexOf('soat_sin_tramite') + 1);
  });
});

describe('el canario de PII clasifica la columna nueva, y la entrada huérfana se fue', () => {
  it('**`flitoProveedorSoatSinTramiteId` está declarada como NO personal**', () => {
    // El canario de `privacy.routes.test.ts` exige que las dos listas cubran la tabla entera. Se
    // repite aquí, en la suite de la HU, para que el motivo quede junto a la columna: es el uuid de
    // una aseguradora, y borrarlo en un derecho al olvido dejaría el canal abierto sin destino —un
    // 23514 que haría fallar la supresión entera—.
    expect([...CLIENTS_COLUMNAS_SIN_PII]).toContain('flitoProveedorSoatSinTramiteId');
    expect([...CLIENTS_COLUMNAS_PII]).not.toContain('flitoProveedorSoatSinTramiteId');
  });

  it('**`flitoProveedorSoatId` ya NO está**: no era una columna de `clients` y era una trampa cargada', () => {
    // Vivía en la lista sin existir en la tabla (la real está en `users`). El canario solo comprueba
    // que no FALTE ninguna columna, no que no SOBRE ninguna cadena: con ella puesta, una columna de
    // `clients` llamada casi igual habría pasado en verde sin que nadie la clasificara.
    expect([...CLIENTS_COLUMNAS_SIN_PII]).not.toContain('flitoProveedorSoatId');
    const columnas = new Set(getTableConfig(clients).columns.map((c) => c.name));
    expect(columnas.has('flito_proveedor_soat_id')).toBe(false);
  });
});

describe('la 0174 no se reescribe: ya está aplicada y su sha registrado', () => {
  it('conserva lo que la define y no menciona nada de esta HU', () => {
    const previa = podarComentarios(leer('0174_flito_soat_procedencia_runt_consultado.sql'));
    expect(previa).not.toMatch(new RegExp(COLUMNA, 'i'));
    expect(previa).not.toMatch(new RegExp(CHK, 'i'));
  });
});
