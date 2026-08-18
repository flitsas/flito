// FLITO — Comparendos monitoreados (Feature #11495, 17b).
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
// QUÉ ES ESTE ARCHIVO HOY — y dónde engancha la HU #11560
//
// Esta es la HU #11559: la página, su permiso (`flito_comparendos`) y su entrada de menú. Lo que
// hay aquí es el CASCARÓN con los cuatro estados reales (cargando, error con reintento, vacío y con
// datos) sobre una consulta barata de verdad; NO es el visor.
//
// El visor completo lo trae la HU #11560 y está especificado, columna a columna, en
// `docs/ux/flito-comparendos-visor.md`. Cuando llegue, esta página se convierte en el cableado que
// describe el reparto de archivos de esa spec y de aquí desaparece casi todo:
//
//   · `useComparendosLista`      ← reemplaza el `useEffect` de abajo: filtros, elección de ruta
//                                  GET/POST según haya NIT o placa, pila de cursores e invalidación.
//                                  La consulta pasa a NO mandar `limit` (regla 1 de la spec:
//                                  ausente = 50, que es lo que la tabla quiere).
//   · `BarraFiltrosComparendos`  ← entra entre la cabecera y la tabla. Los filtros de identidad
//                                  viven en estado de React y NUNCA en la URL (AGENTS.md §14).
//   · `TablaComparendos`         ← reemplaza la tabla mínima de abajo: 13 columnas en dos niveles,
//                                  filas fantasma dentro de `FlitTable` y los DOS vacíos (A: no hay
//                                  datos todavía; B: el filtro no arroja nada).
//   · `PaginacionCursor`         ← debajo de la tabla; sin total, porque el API no lo devuelve.
//   · `PanelDetalleComparendo`   ← se abre desde el número de comparendo, que pasa a ser un
//                                  `<button>` con `aria-label`.
//   · Export (#11558) y formulario de gestión (#11557) cuelgan de la cabecera y del panel.
//
// Lo que este cascarón ya deja fijado y NO hay que rehacer: la guarda de permiso vive en `App.tsx`,
// FUERA de este componente. `ProtectedRoute` devuelve `NoAccess` en lugar de sus hijos, así que sin
// la página este componente no se monta; y como `React.lazy` dispara su `import()` al montarse —no
// al crearse el elemento—, sin la página tampoco se descarga el módulo ni sale una sola petición.
// El acceso a datos va por `src/lib/api.ts` y el error se pinta sin eco del texto del servidor.
//
// Lo que este cascarón NO pinta a propósito: ningún control deshabilitado ni ningún «próximamente».
// Prometer en pantalla algo que la pantalla todavía no puede hacer es peor que no mencionarlo.
//
// Y lo que no aparecerá nunca: un condicional por rol. La spec lo dice con todas las letras —esta
// pantalla no tiene modo lectura—: quien entra puede todo lo que la pantalla ofrece, y toda la
// decisión de acceso está en la guarda de la ruta y en el `NavItem`.
// ══════════════════════════════════════════════════════════════════════════════════════════════

import { useEffect, useState } from 'react';
import type { ComparendoRegistro, ComparendosRegistrosPagina } from '@operaciones/shared-types';
import { ApiError, api } from '../lib/api';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import {
  FlitCard, FlitEmpty, FlitTable, FlitTh, FlitTr, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../components/flit/flitPageKit';
import StatusChip from '../components/flit/StatusChip';

// Cuántas filas pide el cascarón. La spec del visor manda la consulta SIN `limit` (ausente = 50),
// y así la dejará la #11560; aquí se pide un puñado a propósito, porque lo único que esta HU
// necesita del endpoint es ejercitar los cuatro estados, no llenar una tabla.
const CASCARON_LIMIT = 5;

/**
 * Error de la consulta: qué se le dice al usuario y si tiene sentido ofrecerle reintentar.
 *
 * **El texto del servidor NO se hace eco.** El AC5 pide mostrar el error «sin exponer detalles
 * internos», y la primera versión de esto intentó cumplirlo filtrando el mensaje del backend por
 * forma: fuera lo que oliera a traza, a SQL o a ristra de dígitos. Era un colador. Basta con que el
 * dato llegue formateado —«NIT 900.123.456-7», «placa ABC123», «ECONNREFUSED 10.8.0.5»— para que el
 * filtro lo dé por frase humana, y ese es justo el formato con el que los organismos y SIMIT
 * escriben los documentos. Un filtro así siempre va una versión por detrás del siguiente formato, y
 * el precio de quedarse corto es un dato personal en la captura de pantalla que alguien comparte
 * por chat.
 *
 * Así que la regla es la contraria y no tiene huecos que mantener: la pantalla dice lo que SABE por
 * el código de estado, y el diagnóstico del servidor se queda en el servidor, que es donde se puede
 * leer con contexto y bajo retención. Lo que se pierde —un mensaje más específico en el 5xx— vale
 * poco: para quien está mirando la tabla, «no se pudo cargar, reintenta» y el texto interno del
 * backend llevan exactamente a la misma acción.
 *
 * El 403 es el único sin botón: reintentar un permiso que no se tiene es pedirle a alguien que
 * repita algo que va a fallar igual. El 429 sí lo lleva —esconderlo obligaría a recargar la página
 * entera, que es otra petición—. Y aquí no hay ningún `console.*`: el módulo trata datos personales
 * y la consola del navegador no está bajo la retención que la Ley 1581 exige.
 *
 * La #11560 hereda esta regla. Si algún día se quiere el mensaje del backend en pantalla, lo que
 * hace falta es un contrato del servidor —un campo aparte, garantizado libre de datos del titular—,
 * no un filtro en el cliente.
 */
interface ErrorVista { texto: string; reintentable: boolean }

function errorDeVista(e: unknown): ErrorVista {
  if (e instanceof ApiError) {
    if (e.status === 403) {
      return {
        texto: 'Tu usuario ya no tiene acceso a los comparendos. Habla con un administrador.',
        reintentable: false,
      };
    }
    if (e.status === 429) {
      return {
        texto: 'Se hicieron demasiadas consultas seguidas. Espera un minuto y vuelve a intentarlo. '
          + 'El módulo limita las consultas porque cada página trae datos personales.',
        reintentable: true,
      };
    }
    if (e.status === 0) {
      // Sin respuesta: se agotó el tiempo o no hubo red. Es la única distinción que la pantalla
      // puede hacer sin repetir nada de lo que dijo el servidor, porque el servidor no dijo nada.
      return {
        texto: 'No hubo respuesta del servidor al cargar los comparendos. Revisa tu conexión y vuelve a intentarlo.',
        reintentable: true,
      };
    }
  }
  return {
    texto: 'No se pudieron cargar los comparendos. Vuelve a intentarlo; si sigue fallando, avisa a soporte.',
    reintentable: true,
  };
}

/** `YYYY-MM-DD` → «12 jul 2026». `null` es información (hay fuentes que no traen la fecha): «—». */
function fechaCorta(fecha: string | null): string {
  if (!fecha) return '—';
  const [y, m, d] = fecha.split('-').map(Number);
  if (!y || !m || !d) return fecha;
  return new Date(y, m - 1, d).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function FlitoComparendos() {
  const [datos, setDatos] = useState<ComparendoRegistro[] | null>(null);
  const [error, setError] = useState<ErrorVista | null>(null);
  // Reintento: cambiar el nonce vuelve a lanzar el efecto con los mismos parámetros. Es el patrón
  // que ya usan BolsasTablero y el reporte de costos.
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let vigente = true;
    setDatos(null);
    setError(null);
    api.get<ComparendosRegistrosPagina>(`/flito/comparendos/registros?limit=${CASCARON_LIMIT}`)
      .then((pagina) => { if (vigente) setDatos(pagina?.items ?? []); })
      .catch((e) => { if (vigente) setError(errorDeVista(e)); });
    return () => { vigente = false; };
  }, [nonce]);

  const cargando = datos === null && error === null;
  // Anuncio para lectores de pantalla: sin esto, quien navega con lector no se entera de que el
  // contenido cambió bajo el mismo encabezado.
  const anuncio = cargando
    ? 'Cargando comparendos.'
    : error
      ? error.texto
      : datos && datos.length > 0
        ? `Se cargaron ${datos.length} comparendos.`
        : 'No hay comparendos registrados.';

  return (
    <div className="space-y-4">
      <PageHeaderCard
        title="Comparendos monitoreados"
        subtitle="Lo que SIMIT y los municipios reportan de los NIT que se vigilan. Los datos vienen de la fuente y no se editan aquí: lo único que se registra es la causal y la observación de gestión."
      />

      <p className="sr-only" aria-live="polite">{anuncio}</p>

      <FlitCard>
        {/* Los cuatro estados, en este orden: el ERROR va antes que el vacío. Si la consulta falló
            no se sabe si hay filas, y decir «no hay comparendos» sería afirmar algo que nadie
            comprobó. Por el mismo motivo, bajo el error no se deja pintada una tabla anterior. */}
        {error && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm" style={{ color: 'var(--flit-danger)' }}>{error.texto}</p>
            {error.reintentable && (
              <button
                type="button"
                className={flitBtnSecondary}
                style={flitBtnSecondaryStyle}
                onClick={() => setNonce((n) => n + 1)}
              >
                Reintentar
              </button>
            )}
          </div>
        )}

        {cargando && (
          <div
            role="status"
            aria-busy="true"
            aria-label="Cargando comparendos"
            className="animate-pulse space-y-3 motion-reduce:animate-none"
          >
            {Array.from({ length: CASCARON_LIMIT }, (_, i) => (
              <div
                key={i}
                className="h-9"
                style={{ background: 'var(--flit-border-soft)', borderRadius: 8, opacity: 1 - i * 0.12 }}
              />
            ))}
          </div>
        )}

        {!error && datos?.length === 0 && (
          <FlitEmpty>
            Todavía no hay comparendos registrados. Aparecen aquí después de una sincronización con
            SIMIT y con los municipios configurados; si acabas de dar de alta los NIT que se vigilan,
            todavía no se ha consultado a ninguna fuente.
          </FlitEmpty>
        )}

        {!error && !!datos?.length && (
          <>
            {/* Tabla mínima del cascarón: la reemplaza `TablaComparendos` en la #11560 con las 13
                columnas de la spec. Aquí no se pintan ni la placa ni el NIT monitoreado —los dos
                son cuasi-PII— porque nada de lo que esta HU demuestra los necesita. */}
            <FlitTable>
              <caption className="sr-only">Comparendos monitoreados</caption>
              <thead>
                <FlitTr>
                  <FlitTh>N.º comparendo</FlitTh>
                  <FlitTh>Fecha</FlitTh>
                  <FlitTh>Estado</FlitTh>
                </FlitTr>
              </thead>
              <tbody>
                {datos.map((c) => (
                  <FlitTr key={c.id}>
                    <td className="px-4 py-2.5 text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>
                      {c.numeroComparendo}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
                      {fechaCorta(c.fechaComparendo)}
                    </td>
                    <td className="px-4 py-2.5">
                      {/* «Inactivo» NO significa pagado ni resuelto: significa que las fuentes
                          dejaron de reportarlo. El chip lleva su etiqueta dentro, así que la
                          distinción no depende del color. */}
                      <StatusChip tone={c.estado === 'activo' ? 'active' : 'draft'}>
                        {c.estado === 'activo' ? 'Activo' : 'Inactivo'}
                      </StatusChip>
                    </td>
                  </FlitTr>
                ))}
              </tbody>
            </FlitTable>
            {/* El contador dice lo que sabe y nada más: el API pagina por cursor y NO devuelve un
                total, así que aquí no hay «de 1.284» ni «página 3 de 47» que se puedan escribir sin
                inventarlos. Los botones de Anterior/Siguiente los trae `PaginacionCursor` en la
                #11560, cuando la consulta deje de pedir un puñado de filas. */}
            <p className="mt-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
              {datos.length} comparendos en esta página · se piden los {CASCARON_LIMIT} más recientes
            </p>
          </>
        )}
      </FlitCard>
    </div>
  );
}
