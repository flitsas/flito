# Diseño — El recorrido de verificación de vigencia del SOAT (HU #12096)

> **Qué es este documento.** La entrada del `backend-agent` que implemente la HU
> [#12096](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/12096), eslabón 1 de 2 del
> Feature [#12075](https://dev.azure.com/FlitDevOps/FLIT%20-%20FLITO/_workitems/edit/12075)
> (*verificación diaria del SOAT contra el RUNT a las 00:10*). El eslabón 0 (#12095) ya está en el
> repo: `flito-soat-vigencia.cron.ts` (el andamiaje) y `flito-soat-vigencia.service.ts` (el punto de
> extensión vacío). El eslabón 2 (#12097) es la pantalla, y su contrato es
> `docs/ux/flito-soat-vigencia-en-la-cola.md` en el worktree de esa HU.
>
> **Las decisiones y sus alternativas viven en
> [ADR-0013](./adr/ADR-0013-flito-soat-corridas-de-vigencia.md).** Aquí está el CÓMO: DDL, tipos,
> firmas, secuencia y la lista exacta de archivos. Cuando una decisión necesita defensa, este
> documento apunta al ADR en vez de repetirla.
>
> **Estado del ADR: `Propuesto`.** Hay **un** punto abierto que toca el código (ADR §4.2, marcado abajo
> con ⚠) y el `backend-agent` debe leerlo antes de escribir el `set()` de la escritura por vehículo.

---

## 1 · Lo que ya existe y no se toca

| Pieza | Archivo | Estado |
|---|---|---|
| Reloj de Bogotá (RN-D4) | `flito-soat-vigencia.cron.ts` · `ahoraEnBogota` | **intacta**, y se **reutiliza** en la cola (§7) |
| Decisión temporal | `decidirCorrida`, `latidoVigenciaSoat`, cadencia, `MAX_REINTENTOS` | **intactas** |
| Candado (CF-08) | `withLock('flito-soat-vigencia', 50 min)` | **intacto** |
| Puerta positiva (RN-D6) | `env.SOAT_VIGENCIA_CRON_ENABLED` | **intacta** |
| Higiene del log (AC7 #12095) | `nombreDeError`, claves sin PII | **intacta** |
| Primitivas RUNT (#12090) | `soatVigenteSegunRunt`, `fechaVencimientoSoatRunt`, `causaDeCaida`, `runtSinRegistro`, `consultarRuntCrudo` | **se reutilizan sin cambiarlas** |

Lo único que cambia del cron son **los cuerpos** de `leerEstadoDelDia` / `guardarEstadoDelDia` y el
paso del resumen (ADR §2.4).

---

## 2 · Diagrama de secuencia

```mermaid
sequenceDiagram
    autonumber
    participant Cron as flito-soat-vigencia.cron
    participant Serv as flito-soat-vigencia.service
    participant DB as PostgreSQL
    participant CB as circuitBreaker (runt-vehicle)
    participant RUNT as Kyverum / RUNT

    Note over Cron: latido cada 5 min
    Cron->>DB: leerEstadoDelDia() — (A) agregado del día · (B) fila (dia, intento)
    DB-->>Cron: EstadoDelDia | null
    Cron->>Cron: decidirCorrida(estado, reloj)   %% función pura, sin cambios

    Cron->>DB: guardarEstadoDelDia(entrada) — upsert (dia,intento), estado='en_curso'
    Note right of DB: la escritura de ENTRADA es la protección de CF-08
    Cron->>Serv: recorrerVigenciaSoat({ dia, intento })

    Serv->>DB: vehiculosAVerificar(corteDelDia)
    Note right of DB: EXISTS factura_soat viva · NO join
    DB-->>Serv: [{ soatId, vin }]  — sin placa, sin propietario

    loop tandas de SOAT_VIGENCIA_CONCURRENCIA (conConcurrencia)
        Serv->>CB: circuitoAbierto('runt-vehicle')?
        alt circuito abierto o presupuesto agotado
            Serv->>Serv: se corta la corrida; el resto cuenta como pendientes
        else
            Serv->>RUNT: consultarRuntCrudo(vin)
            RUNT-->>Serv: { ok, data } | { ok:false, message, httpStatus? }
            alt sin respuesta (hasta MAX_REINTENTOS_VEHICULO)
                Serv->>DB: UPDATE estado_vigencia='no_verificado'
                Note right of DB: verificada_en, vence_el y poliza_runt INTACTOS (AC5)
            else con respuesta
                Serv->>DB: UPDATE estado_vigencia, verificada_en, [vence_el, poliza_runt]
                opt cambió algo
                    Serv->>DB: INSERT audit_logs (userId NULL, userEmail 'sistema')
                end
            end
        end
    end

    Serv-->>Cron: { considerados, verificados, pendientes, cambiaron, motivos }
    Cron->>DB: guardarEstadoDelDia(cierre, resumen) — totales, motivos, cerrada_en
    Note over Cron: log: host, dia, intento, totales. Ni placa, ni VIN, ni documento.
```

---

## 3 · Migración `0177_flito_soat_vigencia_runt.sql`

Estilo de la 0174 (cabecera con el porqué, `IF NOT EXISTS`, `COMMENT ON` por columna, sin
`BEGIN/COMMIT` propio — ADR-DB-001) y de la 0176 (`RAISE NOTICE` antes de borrar). `ADD CONSTRAINT`
no admite `IF NOT EXISTS` en PostgreSQL, así que va `DROP CONSTRAINT IF EXISTS` + `ADD`, tal como la
0167:139 lo deja escrito.

> **Regla de la 0156, repetida en la 0167:** ningún comentario de este archivo puede escribir el par
> de dólares que abre un bloque. `scanForTxControl` tapa los bloques citados con dólares **antes** de
> quitar los comentarios, y un par suelto dentro de un `--` emparejaría con el que abre el bloque de
> abajo.

```sql
-- ── 1. flito_soat: la vigencia del VEHÍCULO (no de la solicitud, RN-D7) ─────
ALTER TABLE flito_soat
  ADD COLUMN IF NOT EXISTS estado_vigencia varchar(15) NOT NULL DEFAULT 'no_verificado',
  ADD COLUMN IF NOT EXISTS verificada_en   timestamptz,
  ADD COLUMN IF NOT EXISTS vence_el        date,
  ADD COLUMN IF NOT EXISTS poliza_runt     varchar(60);

ALTER TABLE flito_soat DROP CONSTRAINT IF EXISTS flito_soat_estado_vigencia_chk;
ALTER TABLE flito_soat ADD CONSTRAINT flito_soat_estado_vigencia_chk
  CHECK (estado_vigencia IN ('vigente', 'sin_registro', 'no_verificado'));

-- ── 2. Una fila por corrida ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS flito_soat_verificacion_corridas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dia         date        NOT NULL,
  intento     smallint    NOT NULL,
  iniciada_en timestamptz NOT NULL DEFAULT now(),
  cerrada_en  timestamptz,
  estado      varchar(10) NOT NULL DEFAULT 'en_curso',
  total       integer     NOT NULL DEFAULT 0,
  verificados integer     NOT NULL DEFAULT 0,
  cambiaron   integer     NOT NULL DEFAULT 0,
  fallidos    integer     NOT NULL DEFAULT 0,
  motivos     jsonb       NOT NULL DEFAULT '{}'::jsonb
);

-- El único ES el índice de `WHERE dia = $1` (prefijo izquierdo): no se crea un segundo índice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_flito_soat_verif_corrida_dia_intento
  ON flito_soat_verificacion_corridas (dia, intento);

ALTER TABLE flito_soat_verificacion_corridas
  DROP CONSTRAINT IF EXISTS flito_soat_verif_corrida_estado_chk;
ALTER TABLE flito_soat_verificacion_corridas
  ADD CONSTRAINT flito_soat_verif_corrida_estado_chk
  CHECK (estado IN ('en_curso', 'completa', 'parcial'));

-- ── 3. Los dos índices que el censo necesita ────────────────────────────────
-- flito_soportes NO tiene índice por soat_id solo: tiene idx_flito_soportes_hash y tres únicos
-- parciales, ninguno utilizable por el EXISTS del censo, que es su único predicado selectivo.
CREATE INDEX IF NOT EXISTS idx_flito_soportes_soat_tipo
  ON flito_soportes (soat_id, tipo)
  WHERE soat_id IS NOT NULL AND descartado = false;

-- `verificada_en` NO se indexa: inerte (btree ASC NULLS LAST no sirve al ASC NULLS FIRST del
-- censo, medido con EXPLAIN). Ver ADR-0013 §Índices y el bloque de la propia 0177.

-- ── 4. El KV se retira, con constancia en el log del CD ─────────────────────
-- Bloque DO que lee la clave, emite RAISE NOTICE con dia/estado/intentos (ningún dato personal) y
-- la borra. Ver ADR-0013 §2.5 y el precedente de la 0176 §3.
```

**`COMMENT ON` obligatorio en las cuatro columnas y en la tabla.** Los dos que más trabajo hacen, y
que hay que escribir con estas ideas dentro:

- **`estado_vigencia`** — que **no** es `flito_soat.estado`; que RN-D7 prohíbe confundirlas; y que
  `sin_registro` **no es una alerta contra el gestor ni contra la aseguradora**: puede ser un vehículo
  cuyo comprobante sigue en la cola de revisión OCR (ADR §3).
- **`poliza_runt`** — que **no** es `numero_poliza`: aquella la leyó el OCR de la factura que subió el
  gestor y esta la dice el registro nacional; que divergen es información, no ruido.

**Idempotencia:** `ADD COLUMN IF NOT EXISTS` ×4, `CREATE TABLE`/`INDEX IF NOT EXISTS`, `DROP`+`ADD` de
los dos CHECK, `DELETE` sobre una clave que en la segunda pasada ya no está. **Ni una fila cambia.**
**Sin backfill**, deliberado, en las dos tablas (ADR §Modelo de datos).

---

## 4 · Tipos Drizzle (`schema.ts`)

```ts
// dentro de flitoSoat, junto a numeroPoliza
estadoVigencia: varchar('estado_vigencia', { length: 15 })
  .notNull().default('no_verificado').$type<EstadoVigenciaSoat>(),
verificadaEn: timestamp('verificada_en', { withTimezone: true }),
venceEl: date('vence_el'),
polizaRunt: varchar('poliza_runt', { length: 60 }),

// en el bloque (t) => ({ … })
estadoVigenciaChk: check('flito_soat_estado_vigencia_chk',
  sql`${t.estadoVigencia} IN ('vigente', 'sin_registro', 'no_verificado')`),

// tabla nueva
export const flitoSoatVerificacionCorridas = pgTable('flito_soat_verificacion_corridas', {
  id: uuid('id').primaryKey().defaultRandom(),
  dia: date('dia').notNull(),                 // modo cadena → 'YYYY-MM-DD', el mismo de ahoraEnBogota
  intento: smallint('intento').notNull(),
  iniciadaEn: timestamp('iniciada_en', { withTimezone: true }).notNull().defaultNow(),
  cerradaEn: timestamp('cerrada_en', { withTimezone: true }),
  estado: varchar('estado', { length: 10 }).notNull().default('en_curso').$type<EstadoCorrida>(),
  total: integer('total').notNull().default(0),
  verificados: integer('verificados').notNull().default(0),
  cambiaron: integer('cambiaron').notNull().default(0),
  fallidos: integer('fallidos').notNull().default(0),
  motivos: jsonb('motivos').$type<ResumenMotivosCorrida>().notNull().default({}),
}, (t) => ({
  diaIntentoUq: uniqueIndex('uq_flito_soat_verif_corrida_dia_intento').on(t.dia, t.intento),
  estadoChk: check('flito_soat_verif_corrida_estado_chk',
    sql`${t.estado} IN ('en_curso', 'completa', 'parcial')`),
}));

// en flitoSoportes, (t) => ({ … })
soatTipoIdx: index('idx_flito_soportes_soat_tipo').on(t.soatId, t.tipo)
  .where(sql`${t.soatId} IS NOT NULL AND ${t.descartado} = false`),
```

`date('dia')` en modo cadena devuelve `'YYYY-MM-DD'`, exactamente lo que produce `ahoraEnBogota()`: sin
conversión de ida y vuelta y sin una zona horaria más de la que desconfiar.

---

## 5 · Contratos

### 5.1 El censo

```ts
export interface VehiculoAVerificar { soatId: string; vin: string }

/**
 * Los SOAT cuyo comprobante ya cargó el gestor y que TOCA verificar en este intento (AC2).
 *
 * CRITERIO, sacado del esquema y no de una suposición: existe al menos una fila VIVA de
 * `flito_soportes` con `soat_id` = este SOAT, `tipo = 'factura_soat'` y `descartado = false`. Ese es
 * EL comprobante que sube el gestor — la superficie del ZIP «tiene UN solo tipo» y es este
 * (`flito-soat.routes.ts:300`). `factura_venta` sobre el mismo `soat_id` es el adjunto que sube el
 * CLIENTE y NO cuenta.
 *
 * `estado = 'pagado'` se consideró y se descartó (ADR-0013 §3): es un subconjunto estricto —deja
 * fuera al SOAT cuyo comprobante cayó en la cola de revisión OCR— y es una afirmación sobre el flujo
 * interno de FLITO, no sobre el comprobante.
 *
 * `exists()` y NO un `JOIN`: `factura_soat` puede repetirse por SOAT (el único parcial de esa tabla es
 * de `factura_venta`), así que un join duplicaría filas e inflaría `total`.
 *
 * AC6, segunda parte — se excluye lo ya verificado CON ÉXITO hoy, y es UNA sola condición:
 *
 *     verificada_en IS NULL OR verificada_en < corteDelDia
 *
 * Basta porque `verificada_en` registra la última RESPUESTA del RUNT (ADR-0013 §4.2): el vehículo que
 * falló esta madrugada conserva su fecha vieja —o su `NULL`— y vuelve a entrar en el reintento
 * horario, que es lo que el AC6 pide. **NO hace falta `OR estado_vigencia = 'no_verificado'`**: esa
 * cláusula la necesitaría la variante descartada, la que registraba el último INTENTO.
 *
 * NO devuelve placa, ni documento, ni propietario: solo `soatId` y `vin`, que es el mínimo para
 * consultar y escribir.
 */
export async function vehiculosAVerificar(corteDelDia: Date): Promise<VehiculoAVerificar[]>;
```

`corteDelDia` se calcula en JS como `new Date(`${dia}T00:00:00-05:00`)` — Colombia no tiene horario de
verano, así que el desplazamiento es constante. **No** se usa `AT TIME ZONE` en SQL: el valor entra una
sola vez como parámetro ligado y el aserto se puede escribir con `helpers/sql-ligado.ts`.

### 5.2 El recorrido

```ts
export interface ResultadoRecorridoVigencia {
  considerados: number;   // → corrida.total
  verificados: number;    // de ESTE intento → corrida.verificados
  pendientes: number;     // → corrida.fallidos, y lo ÚNICO que dispara el reintento horario
  cambiaron: number;      // → corrida.cambiaron   (nuevo, AC7)
  motivos: ResumenMotivosCorrida; // → corrida.motivos (nuevo, AC7)
}

/** Vocabulario CERRADO. Agrupa MOTIVOS, no filas: por construcción no cabe una placa. */
export interface ResumenMotivosCorrida {
  /** Claves = el retorno de `causaDeCaida`: 'timeout' | 'red' | 'circuito' | 'otro'. */
  causas?: Partial<Record<CausaCaidaRunt, number>>;
  /** Reintentos intra-corrida GASTADOS en total (AC7). Un número, no un mapa por vehículo. */
  reintentos?: number;
}
```

### 5.3 El clasificador — el orden es el diseño

```ts
// 1. ¿Merece la pena preguntar?   circuitoAbierto('runt-vehicle') → no_verificado + 'circuito'
// 2. Transporte:                  !respuesta.ok  → no_verificado + causaDeCaida(respuesta.message)
// 3. ¿Hay vehículo?               runtSinRegistro(respuesta.data) → sin_registro
// 4. Vigencia:                    soatVigenteSegunRunt(respuesta) → vigente | sin_registro
//                                 fechaVencimientoSoatRunt(respuesta.data) → vence_el
```

> ⚠ **`soatVigenteSegunRunt` devuelve `false` por silencio.** Medido en `preflight.ts:113-118`: con
> `ok:false` el check sale `unknown` y la función solo cuenta `status === 'ok'`. Un
> `soatVigenteSegunRunt(r) ? 'vigente' : 'sin_registro'` escribe **`sin_registro` cuando el RUNT está
> caído**, que es dar por vencido por silencio — lo que el AC5 prohíbe. Los pasos 1 y 2 van **antes**
> por eso, y no por estilo.

> **Asimetría de firmas:** `soatVigenteSegunRunt` recibe la **respuesta entera**;
> `fechaVencimientoSoatRunt` recibe **`respuesta.data`**. Pasarle la respuesta entera a la segunda
> devuelve `null` siempre, sin error.

> **`consultarVehiculoRunt` casi nunca lanza**: atrapa todo —incluido `CircuitoAbiertoError`— y
> devuelve `{ ok:false, message }`. Por eso `causaDeCaida` se aplica **al mensaje de la respuesta** y
> no dentro de un `catch`: acepta `unknown` y hace `String(err ?? '')`.

### 5.4 Qué escribe cada desenlace

| Desenlace | `estado_vigencia` | `verificada_en` | `vence_el` | `poliza_runt` |
|---|---|---|---|---|
| Responde, hay SOAT vigente | `vigente` | ahora | si vino | si vino |
| Responde, no hay | `sin_registro` | ahora | intacto | intacto |
| **No responde** | `no_verificado` | **intacto** | **intacto** | **intacto** |

> **`verificada_en` no se toca en el silencio** — ADR-0013 §4.2, decisión de David del 2026-09-07.
> Registra la última vez que el RUNT **respondió** y **puede ser `NULL`**. Dos razones, en este orden:
>
> 1. Moverla con cada intento fallido **rompe la métrica que justifica el Feature** —«cuánto tiempo
>    lleva sin actualizarse el dato más viejo de la cola»—: la cola se vería fresca con el RUNT caído
>    una semana, que es justo el escenario que el indicador existe para detectar.
> 2. Es la única variante en la que el predicado del AC6 es **una sola condición** y es correcta
>    (§5.1). La variante del intento marcaría como reciente al vehículo que falló, el reintento
>    horario lo saltaría, y haría falta una cláusula extra solo para deshacer ese daño.
>
> **Coste asumido:** `estado_vigencia = 'no_verificado'` con `verificada_en = NULL` **no distingue**
> «se intentó y no hubo respuesta» de «la corrida aún no ha llegado» — lo que escribe un fallo es
> idéntico al `DEFAULT` de la columna. Su consecuencia sobre el filtro de la cola está en §7.1.

**Además:**

- **`updated_at` de `flito_soat` NO se toca.** Todos sus escritores actuales son acciones humanas del
  módulo; moverla cada madrugada la vaciaría de significado sin poner nada rojo.
- **Ni `registrarCambio` ni `flito_estado_historial`.** Es la mitad ejecutable de RN-D7.
- **`audit_logs` solo cuando cambió algo**, con `{ userId: null, userEmail: 'sistema' }` —el patrón de
  `flito-compuerta.service.ts:238`—, `resourceId` = uuid del SOAT y `detail` sin placa, VIN ni
  documento.

### 5.5 La costura con el cron

```ts
// leerEstadoDelDia(): dos consultas, ninguna dependiente del orden (ADR §2.3)
//   A) max(intento), sum(verificados)  WHERE dia = $1          ← agregado SIN GROUP BY
//   B) estado, fallidos, iniciada_en, cerrada_en  WHERE dia = $1 AND intento = $2
//   proximoIntentoEn = (estado === 'en_curso' && intento <= MAX_REINTENTOS)
//                        ? iniciada_en + REINTENTO_MS : null      ← DERIVADO, no persistido

// guardarEstadoDelDia(estado: EstadoDelDia, resumen?: ResultadoRecorridoVigencia): Promise<void>
//   upsert ON CONFLICT (dia, intento) DO UPDATE
//   entrada → sin resumen · cierre → con resumen
//   escribe `verificados` POR CORRIDA (resumen.verificados), nunca el acumulado del día
```

**No hay ninguna resta de contadores, y es donde se metería el error.**
`ResultadoRecorridoVigencia.verificados` ya es «de este intento» por contrato; el acumulado del día lo
reconstruye el `sum()` de (A).

---

## 6 · Ritmo, tope y presupuesto

```ts
// config/env.ts, junto a SOAT_VIGENCIA_CRON_ENABLED
SOAT_VIGENCIA_CONCURRENCIA: z.coerce.number().int().min(1).max(8).default(2),

// flito-soat-vigencia.service.ts
const MAX_REINTENTOS_VEHICULO = 1;              // AC6: el «tope declarado»
const PRESUPUESTO_CORRIDA_MS  = 40 * 60_000;    // 80 % de LOCK_TTL_MS (50 min)
```

- **Pool:** `conConcurrencia(items, limite, fn)` de `shared/utils/con-concurrencia.ts` — ya lo usan
  `flito-recibos.service.ts:151` y `certificacion.service.ts`. Promesas, no `sleep`: **no bloquea el
  event loop**.
- **Por tandas**, para consultar entre una y otra `circuitoAbierto('runt-vehicle')` y el presupuesto.
- **Default 2 y no 5** (el de comparendos): aquel sync no comparte breaker con el camino de usuario y
  aquí sí, con `THRESHOLD = 5`. Ver ADR §5.1, que es el argumento que sostiene el AC6 entero.
- **Nada de `LIMIT` en el censo**: truncaría en silencio y `total` mentiría. El presupuesto trunca por
  tiempo y devuelve el resto como `pendientes`, que es la señal que el reintento ya sabe leer.

---

## 7 · Delta de API de la cola (extensión declarada — ADR §7)

> **No lo pide ningún AC de la #12096 ni de la #12095**, y la #12097 es de front. Es alcance añadido a
> conciencia porque sin él la pantalla no tiene qué pintar. Se declara como extensión.

### 7.1 Lo que viaja en cada ítem de `GET /flito/soat`

```ts
vigencia: {
  estado: 'vigente' | 'vencido' | 'sin_registro' | 'no_verificado';  // 'vencido' DERIVADO
  verificadaEn: string | null; // última RESPUESTA del RUNT; null = nunca respondió
  venceEl: string | null;      // yyyy-mm-dd
} | null                        // null = sin comprobante vivo: no entra en la verificación diaria
```

```sql
CASE WHEN estado_vigencia = 'vigente'
      AND vence_el IS NOT NULL
      AND vence_el < $hoyBogota  THEN 'vencido'
     ELSE estado_vigencia END
```

**`vencido` solo se deriva desde `vigente`.** Una fila `sin_registro` con un `vence_el` viejo —el
último conocido, que el AC5 conserva— **no** se reetiqueta: son los dos estados que el UX §3 más
trabaja para que no se confundan.

**`verificadaEn` puede ser `null`, y eso cambia una línea del contrato de UX** (ADR §7.1.b): la
segunda línea de una fila `no_verificado` es **«Verificado hace 3 días»** cuando hay fecha —informa más
que «Último intento hoy», porque da las dos cosas: que hoy falló y desde cuándo no sabemos nada— y
**«Sin verificar aún»** cuando es `null`. Los cuatro textos de chip no cambian.

**El universo de los tres filtros es el `EXISTS` del comprobante vivo** —el mismo de §5.1—, que es
además el predicado que decide si `vigencia` viaja o es `null`. ⚠ **Es una corrección derivada de la
decisión de §5.4 y está abierta:** con «última respuesta», `verificada_en IS NOT NULL` dejaría fuera
del filtro «No se pudo consultar» a los vehículos que fallaron y nunca obtuvieron respuesta — es decir,
vaciaría el filtro durante la avería. La derivación completa, con los cinco casos y el coste de cada
opción, está en **ADR-0013 §7.2**.

### 7.2 Las cinco costuras

| Dónde | Qué | Si se olvida |
|---|---|---|
| `condicionesCola` (`flito-soat.service.ts:370`) | el predicado del filtro | — (es el único sitio; su docblock explica por qué) |
| `cola` (`:535`) | la proyección de §7.1 | la pantalla no recibe nada |
| `facetasCola` (`:609`) | **nada**: las 4 opciones son fijas | — |
| `colaFiltrosCampos` (`flito-soat.routes.ts:179-195`) | declarar `vigencia` | el `POST /export` responde **400**, no «filtro ignorado»: su esquema se deriva con `.strict()` |
| `CAMPOS_SOLO_INTERNOS` (`:228`) | añadir `'vigencia'` | el rol `cliente` ve el estado de un proceso interno de FLITO (UX §6) |
| `filtrosPermitidos` (`:346`) | `vigencia: undefined` para el `cliente` | un `cliente` filtra por un campo que no recibe y lo infiere del conteo |

`$hoyBogota` se calcula una vez por petición reutilizando `ahoraEnBogota()`, que el cron ya exporta.
Una sola definición de «hoy en Bogotá» en el módulo, y no dos que puedan divergir cinco horas.

---

## 8 · Archivos

**Crear**

- `apps/api/src/db/migrations/0177_flito_soat_vigencia_runt.sql`
- `apps/api/__tests__/services/flito-soat-vigencia.recorrido.test.ts`

**Modificar**

- `apps/api/src/db/schema.ts`
- `apps/api/src/modules/flito-soat/flito-soat-vigencia.service.ts`
- `apps/api/src/modules/flito-soat/flito-soat-vigencia.cron.ts`
- `apps/api/src/modules/flito-soat/flito-soat.service.ts`
- `apps/api/src/modules/flito-soat/flito-soat.routes.ts`
- `apps/api/src/config/env.ts`
- `apps/api/__tests__/services/flito-soat-vigencia.cron.test.ts` — los ~10 puntos atados a `system_kv`
  (líneas 109, 125-139, 209, 245-250, 286, 635)
- `packages/shared-types/src/flito-estados.ts`
- `.env.example` y la documentación de despliegue que declare las variables del cron

**Ya creados por este diseño**

- `docs/adr/ADR-0013-flito-soat-corridas-de-vigencia.md` *(Propuesto)*
- este documento

**Sin dependencias nuevas.**

---

## 9 · Notas para `qa-agent` — los asertos que el mock puede dejar vacíos

1. **El censo y el filtro se comprueban sobre el SQL renderizado** (`helpers/sql-ligado.ts`). El
   `chain` del mock devuelve la fila entera aunque el `select` pida menos e **ignora el `where`**:
   afirmar sobre las filas devueltas es una tautología.
2. **Ningún `orderBy` en `leerEstadoDelDia`.** Si aparece, el test es verde vacío
   (`helpers/orden-sql.ts`).
3. **`TZ=UTC` en el archivo**, como el de la #12095: en `-05` el mutante del reloj sobrevive.
4. **El agregado del día no lleva `GROUP BY`.** Si alguien lo añade, un literal repetido son dos
   parámetros y PostgreSQL responde `42803` en cada llamada.
5. **Mutantes nombrados que deben poner rojo:**
   - quitar `descartado = false` del `EXISTS` del censo;
   - invertir el orden transporte/vigencia de §5.3;
   - quitar la guarda de `circuitoAbierto`;
   - **escribir `verificada_en` en la rama `no_verificado`** — rompe la métrica del Feature y hace
     que el reintento horario salte al vehículo que falló (ADR §4.2);
   - derivar `vencido` también desde `sin_registro`;
   - **introducir un import de `extraerDatosCanal` o `consultarYClasificar`** — es el requisito
     estructural del ADR §6 y sostiene toda la decisión de no escribir `pii_access_log`.
6. **Ningún test debe meter placa, VIN ni póliza en un `data-*`**: los selectores de axe arrastran
   valores de atributo al informe.

---

## 10 · Lo que falta decidir antes del merge

| # | Qué | Dueño |
|---|---|---|
| 1 | **§7.1 ⚠ — el universo de los tres filtros de la cola (ADR §7.2).** Consecuencia de la decisión de §5.4: `verificada_en IS NOT NULL` deja fuera a los que fallaron sin respuesta previa. Se propone el `EXISTS` del comprobante. Único punto abierto que toca el código. | David |
| 2 | La extensión de API de §7: se queda en la #12096 o se mueve a la #12097. | PO / David |
| 3 | Revisión del `security-agent` sobre ADR §6 antes del PR. | `security-agent` |
| 4 | Declarar la desviación de nombres del ADR §1 en el PR y en la Discussion del WI #12096. | quien abra el PR |
| 5 | No desplegar la 0177 entre las 00:10 y las 01:10 de Colombia (ADR §2.5). | quien despliegue |
| 6 | Medir el censo real en DEV antes de fijar `SOAT_VIGENCIA_CONCURRENCIA` en producción. | operaciones |
