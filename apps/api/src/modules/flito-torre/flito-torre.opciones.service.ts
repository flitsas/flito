// Torre de Control Gerencial (Épica #14590) — opciones de la barra de filtros (`GET /api/flito/torre/opciones`), para
// que las gerencias no dependan de `parametrizacion.companias.listar`.
//
// RN-TOR-O1: FUENTE de los valores = `flito_tramites`, las MISMAS columnas que filtra el motor (`DIMS_TRAMITE` de
//   `flito-torre.catalogo.ts`, que `condicionesTorre` compara con `lower(col) IN (...)`): `tipo_tramite`, `flit_estado`,
//   `organismo_codigo` y `compania_id`. Así cada `valor` devuelto filtra exacto. Las variantes de mayúsculas de un
//   mismo valor (FLIT manda «Entregado», una carga vieja «ENTREGADO») se agrupan por `lower()` —el motor no las
//   distingue— y se devuelve la grafía más frecuente.
// RN-TOR-O2: el alcance es el del motor (`condicionPorCompania` sobre `flito_tramites.compania_id`).
// RN-TOR-O3: solo IDs, códigos y nombres. Nada de NIT, documento, teléfono ni correo de `clients`.
// RN-TOR-O4: no se limita por rango: la opción existe si hay algún trámite con ese valor en el alcance.
import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { OpcionesFiltroTorre } from '@operaciones/shared-types';
import { clients, flitoTramites } from '../../db/schema.js';
import { condicionPorCompania } from '../../shared/alcance-filas.js';
import type { AlcanceResuelto } from '../../shared/middleware/frontera-enlace.js';
import { hoyColombia } from '../../shared/utils/fecha-rango.js';
import { donde } from './flito-torre.filtro.js';
import { claveCache, enTorre, guardarCache, leerCache, nombreOrganismo } from './flito-torre.metricas.service.js';

const T = flitoTramites;

/** Valores distintos (sin mayúsculas duplicadas) de una columna de texto de `flito_tramites`. */
function distintos(col: AnyColumn, alcance: SQL): SQL {
  return sql`SELECT mode() WITHIN GROUP (ORDER BY ${col}) AS valor
    FROM ${T} WHERE ${alcance} AND ${col} IS NOT NULL AND btrim(${col}) <> ''
    GROUP BY lower(${col}) ORDER BY 1`;
}

export async function opcionesFiltroTorre(alcance: AlcanceResuelto, hoy: string = hoyColombia()): Promise<OpcionesFiltroTorre> {
  const clave = claveCache('opciones', alcance, hoy);
  const cacheado = await leerCache<OpcionesFiltroTorre>(clave);
  if (cacheado) return cacheado;

  const porAlcance = condicionPorCompania(T.companiaId, alcance);
  const w = donde(porAlcance ? [porAlcance] : []);
  const opciones = await enTorre(async (q) => {
    const companias = await q<{ id: number; nombre: string }>(sql`
      SELECT ${clients.id} AS id, ${clients.name} AS nombre FROM ${clients}
      WHERE ${clients.id} IN (SELECT DISTINCT ${T.companiaId} FROM ${T} WHERE ${w} AND ${T.companiaId} IS NOT NULL)
      ORDER BY ${clients.name}, ${clients.id}`);
    const organismos = await q<{ valor: string }>(distintos(T.organismoCodigo, w));
    const tipos = await q<{ valor: string }>(distintos(T.tipoTramite, w));
    const estados = await q<{ valor: string }>(distintos(T.flitEstado, w));
    return {
      companias: companias.map((c) => ({ id: Number(c.id), nombre: c.nombre })),
      // El filtro solo admite DIVIPOLA de 5 dígitos: un código raro no se ofrece (no podría volver como filtro).
      organismos: organismos.filter((o) => /^\d{5}$/.test(o.valor)).map((o) => ({ codigo: o.valor, nombre: nombreOrganismo(o.valor) }))
        .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
      tiposTramite: tipos.map((t) => ({ valor: t.valor, etiqueta: t.valor })),
      flitEstados: estados.map((e) => ({ valor: e.valor, etiqueta: e.valor })),
    };
  });
  await guardarCache(clave, opciones);
  return opciones;
}
