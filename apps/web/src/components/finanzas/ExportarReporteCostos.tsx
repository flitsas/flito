// Finanzas — Reporte de costos: la descarga en Excel del detalle y del consolidado (HU #12532).
//
// Es el patrón de SOAT/Impuestos (`components/flito/ExportarCola.tsx`, HU #11909) traído a esta
// pantalla, con dos diferencias que son las de su contrato: hay DOS destinos —el detalle con sus 36
// columnas y el consolidado cliente × periodo— y los dos comparten un solo estado, porque el botón
// cambia con la vista pero la descarga que está en vuelo no.
//
// Lo que define el módulo, y por qué:
//
//   · **Un solo constructor de criterios.** `cuerpoDeExport` arma el objeto del POST desde el mismo
//     estado del que sale la consulta de la tabla, y `paramsDeCriterios` VIERTE ese objeto a la
//     query de los GET. La pantalla no tiene un segundo sitio donde se decida qué filtro viaja: si
//     el archivo trae otra cosa de la que se ve, es porque el API la trajo, no porque aquí se
//     construyó distinto (D-04).
//   · **Nada va a la URL.** El export es un POST con el criterio en el cuerpo: `window.open` con
//     query fue lo que dejó la exportación en un 401 en pestaña nueva desde el 2026-08-13 y lo que
//     escribía el buscador en el historial y en el access log (AGENTS.md §14).
//   · **La página no viaja.** El archivo es todo el filtro; `page`/`pageSize` no están en el tipo y
//     por eso no pueden colarse. El esquema del API es `.strict()`: una clave de más es un 400.
//   · **El nombre lo pone el servidor** (`Content-Disposition`, hora de Colombia) y el cliente lo
//     valida con `esNombreDeExport` antes de enseñarlo; si no encaja, cae al respaldo.

import { useCallback, useRef, useState } from 'react';
import type { SiigoEstadoReporte } from '@operaciones/shared-types';
import { ApiError, api } from '../../lib/api';
import { avisoDeError, esNombreDeExport, type AvisoExport } from '../flito/ExportarCola';
import type { Etapa, FiltrosDetalle, TipoPeriodo } from './tiposReporteCostos';

/** Qué archivo se pide: el detalle con sus 36 columnas o el consolidado cliente × periodo. */
export type VistaExport = 'detalle' | 'consolidado';

/**
 * El cuerpo del POST, declarado aquí y no en `shared-types` por el mismo reparto que
 * `FiltrosExportCola`: el tipo compartido lo escribe el backend al lado de su esquema Zod
 * (`exportDetalleSchema` / `exportConsolidadoSchema` en `finanzas.routes.ts`). Este describe lo que
 * la pantalla manda; el día que exista el compartido, se sustituye y el compilador dice si sobraba.
 *
 * Sin `page` ni `pageSize`, a propósito.
 */
export interface CuerpoExportReporteCostos {
  buscar?: string;
  /** Los NIT de la empresa elegida. La faceta trae varios en un solo valor (`'900111,9001112'`). */
  empresas?: string[];
  tipos?: string[];
  etapa?: Exclude<Etapa, ''>;
  desde?: string;
  hasta?: string;
  aprobadoDesde?: string;
  aprobadoHasta?: string;
  estados?: string[];
  /** Por CÓDIGO, que es la identidad del organismo en el API (CF-04); el nombre es para leer. */
  organismos?: string[];
  documentacionCompleta?: boolean;
  estadoFacturacion?: SiigoEstadoReporte;
  /** Solo el consolidado: el eje del agrupado. El detalle no lo manda (esquema `.strict()`). */
  periodo?: TipoPeriodo;
}

/** Parte un valor de faceta con varios NIT en su lista, sin vacíos. */
const partir = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);

/**
 * Los criterios de la pantalla como objeto: lo que la tabla consulta y lo que el archivo trae.
 * Solo entran las claves con valor; una lista vacía no filtra y por eso no viaja.
 */
export function cuerpoDeExport(f: FiltrosDetalle, estadoFe: SiigoEstadoReporte | null): CuerpoExportReporteCostos {
  const c: CuerpoExportReporteCostos = {};
  if (f.buscar.trim()) c.buscar = f.buscar.trim();
  if (f.empresa) c.empresas = partir(f.empresa);
  if (f.tipo) c.tipos = [f.tipo];
  if (f.etapa) c.etapa = f.etapa;
  if (f.desde) c.desde = f.desde;
  if (f.hasta) c.hasta = f.hasta;
  if (f.aprobadoDesde) c.aprobadoDesde = f.aprobadoDesde;
  if (f.aprobadoHasta) c.aprobadoHasta = f.aprobadoHasta;
  if (f.estados.length) c.estados = f.estados;
  if (f.organismos.length) c.organismos = f.organismos;
  if (f.docCompleta) c.documentacionCompleta = true;
  if (estadoFe) c.estadoFacturacion = estadoFe;
  return c;
}

/**
 * El MISMO criterio vertido a la query de los GET (`/reporte-costos`, `/facturacion-electronica`,
 * `/consolidado`): listas separadas por coma y el booleano como `si`, que es lo que `filtrosDe` lee
 * en el API. Es una proyección del objeto, no otro constructor.
 */
export function paramsDeCriterios(c: CuerpoExportReporteCostos): URLSearchParams {
  const p = new URLSearchParams();
  for (const [clave, valor] of Object.entries(c)) {
    if (valor === undefined || valor === false) continue;
    p.set(clave, valor === true ? 'si' : Array.isArray(valor) ? valor.join(',') : String(valor));
  }
  return p;
}

interface Destino {
  /** Ruta del POST, sin `/api`. */
  ruta: string;
  /** Prefijo del nombre que pone el servidor y respaldo si el nombre no tiene la forma esperada. */
  prefijo: 'reporte-costos' | 'consolidado-costos';
  /** Lo que se anuncia por la región `role="status"` de la página mientras se genera. */
  anuncio: string;
}

const DESTINOS: Record<VistaExport, Destino> = {
  detalle: {
    ruta: '/finanzas/reporte-costos/export', prefijo: 'reporte-costos',
    anuncio: 'Generando el archivo del reporte de costos.',
  },
  consolidado: {
    ruta: '/finanzas/reporte-costos/consolidado/export', prefijo: 'consolidado-costos',
    anuncio: 'Generando el archivo del consolidado.',
  },
};

/**
 * Lanza la descarga y devuelve el nombre con el que se guardó.
 *
 * `downloadPostNamed` mira `res.ok` antes de entregar y lanza `ApiError` si la respuesta no es OK
 * aunque venga vestida de archivo: un 422 nunca acaba en la carpeta de descargas.
 */
export function exportarReporteCostos(vista: VistaExport, cuerpo: CuerpoExportReporteCostos): Promise<string> {
  const d = DESTINOS[vista];
  return api.downloadPostNamed(d.ruta, `${d.prefijo}.xlsx`, cuerpo, (nombre) => esNombreDeExport(d.prefijo, nombre));
}

/**
 * El copy de error de ESTA pantalla (D-07): decidido por `status` + `codigo` en `avisoDeError`, con
 * el 403 y el tiempo agotado redactados para el reporte y el respaldo del tope sin la jerga de las
 * colas («Creado en FLITO» no es un filtro de aquí). El eco del servidor en 422/429 se mantiene.
 *
 * El 401 no lleva aviso: el gancho global del cliente cierra la sesión y navega a Login, y esta
 * página deja de existir (D-12). Devolver `null` es no pintar nada sobre un componente que se va.
 */
export function avisoDeErrorExport(e: unknown): AvisoExport | null {
  if (e instanceof ApiError && e.status === 401) return null;
  return avisoDeError(e, {
    tope: 'El filtro que tienes puesto trae más filas de las que admite un archivo. Acota el periodo o el '
      + 'filtro y vuelve a exportar.',
    sinPermiso: 'Tu usuario ya no puede exportar el reporte de costos. Habla con un administrador.',
    tiempo: 'El archivo tardó demasiado en generarse. Vuelve a intentarlo con un periodo más corto.',
  });
}

export interface EstadoExportReporteCostos {
  ocupado: boolean;
  aviso: AvisoExport | null;
  exportar: (vista: VistaExport) => void;
  /** Repite el último destino con los criterios que HAY en pantalla ahora (los del kit, no un eco). */
  reintentar: () => void;
  descartar: () => void;
}

/**
 * El estado de la descarga, compartido por los dos botones (D-05).
 *
 * **El candado es una `ref`, no el `disabled`** (lección de la HU #11562, escrita en
 * `useExportCola`): `disabled` llega al DOM en el commit siguiente al clic y entre medias cabe un
 * segundo clic. La `ref` se lee y se escribe en el mismo instante síncrono del evento.
 *
 * Es propio y no `ejecutar` de la página: aquel enciende `enProceso`, que deshabilita Liquidar en
 * toda la tabla, y comparte `error` con el fallo de carga. Exportar no puede bloquear la
 * liquidación ni pisar el error de la tabla.
 *
 * Los criterios se leen de una `ref` refrescada en cada render: lo que se exporta es lo que está en
 * pantalla en el instante del clic, sin que la identidad del objeto entre en las dependencias.
 */
export function useExportReporteCostos(
  criteriosDe: (vista: VistaExport) => CuerpoExportReporteCostos,
  anunciar: (texto: string) => void,
): EstadoExportReporteCostos {
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState<AvisoExport | null>(null);
  const enVuelo = useRef(false);
  const ultimaVista = useRef<VistaExport>('detalle');
  const criterios = useRef(criteriosDe);
  criterios.current = criteriosDe;
  const anuncio = useRef(anunciar);
  anuncio.current = anunciar;

  const exportar = useCallback((vista: VistaExport) => {
    if (enVuelo.current) return;
    enVuelo.current = true;
    ultimaVista.current = vista;
    setOcupado(true);
    setAviso(null);
    anuncio.current(DESTINOS[vista].anuncio);

    exportarReporteCostos(vista, criterios.current(vista))
      .then((nombre) => {
        const texto = `Archivo descargado: ${nombre}`;
        setAviso({ tono: 'ok', reintentable: false, texto });
        anuncio.current(texto);
      })
      .catch((e) => {
        // El error va SOLO por el `role="alert"` de la banda: repetirlo en el `status` se oye dos veces.
        setAviso(avisoDeErrorExport(e));
        anuncio.current('');
      })
      .finally(() => {
        enVuelo.current = false;
        setOcupado(false);
      });
  }, []);

  const reintentar = useCallback(() => exportar(ultimaVista.current), [exportar]);
  const descartar = useCallback(() => setAviso(null), []);

  return { ocupado, aviso, exportar, reintentar, descartar };
}
