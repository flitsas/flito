// FLITO — Comparendos monitoreados: el visor (Feature #11495, 17b, HU #11560).
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
// QUÉ ES ESTE ARCHIVO — y qué falta por enganchar
//
// Esta página es el cableado del visor: cabecera, barra de búsqueda, tabla y paginación por cursor,
// con los cuatro estados resueltos en un orden que importa (el ERROR antes que el vacío). La
// especificación, columna a columna, está en `docs/ux/flito-comparendos-visor.md`.
//
// La HU #11559 dejó aquí el cascarón —la página, su permiso y su entrada de menú— y con él dos
// decisiones que esta HU HEREDA y no revisa:
//
//   1. **La guarda de permiso vive en `App.tsx`, fuera de este componente.** `ProtectedRoute`
//      devuelve `NoAccess` en lugar de sus hijos, así que sin la página este componente no se monta
//      y, como `React.lazy` dispara su `import()` al montarse, tampoco se descarga el módulo ni sale
//      una sola petición. Aquí no hay ni habrá un condicional por rol: esta pantalla no tiene modo
//      lectura y quien entra puede todo lo que ofrece.
//   2. **El texto del servidor NO se pinta.** El copy de error se deriva del código de estado
//      (`errorDeVista`, en el hook). El porqué —un filtro por forma en el cliente deja pasar el NIT
//      con separadores, que es como lo escriben SIMIT y los organismos— está escrito en el hook y en
//      la spec. La decisión de producto sigue abierta; la conducta, no.
//
// Dos puntos en los que el enunciado de la HU y la spec de UX decían cosas distintas, resueltos por
// el Líder Técnico (2026-08-18) y escritos aquí para que no se vuelvan a discutir en un PR:
//
//   · **Búsqueda mixta.** El AC3 pedía debounce y el descarte 6 de la spec lo rechazaba. Gana la
//     distinción, no una de las dos: debounce SOLO en el número de comparendo (no es identidad y va
//     por `GET`); Enter o `[Buscar]` en NIT y placa. Los tres motivos del descarte —registro de
//     acceso PII, limitador de 60/min y el cambio de verbo a mitad de tecleo— pesan sobre la
//     identidad, y ahí se respetan enteros. Se reescribe el AC3, no la spec.
//   · **Paginación: gana la spec.** `[← Anterior] [Siguiente →]` con la página REEMPLAZADA y el
//     botón inhabilitado —no oculto— al llegar al final, sobre una pila de cursores en cliente. El
//     AC5 describía un «ver más» que añade filas; no se implementa. Y el AC6 se cumple con algo que
//     el AC no dice: al cambiar de criterio se vacía TAMBIÉN la pila, o «Anterior» desde la nueva
//     primera página devolvería una página del listado viejo.
//
// Lo que todavía NO cuelga de aquí, y por eso no se promete en pantalla con un control inhabilitado
// ni con un «próximamente»:
//
//   · `PanelDetalleComparendo` (HU del detalle) — mientras no exista, el número de comparendo es
//     texto y no un botón: un botón que no abre nada es peor que ninguno. Con él llegan también las
//     columnas de nivel C (estado en la fuente, observación, visto por última vez, corrida).
//   · `FormularioGestion` (HU #11557) y `ExportarComparendos` (HU #11558).
//   · `BarraFiltrosComparendos` crece con municipio, fuente y causal en la HU #11561: el estado de
//     búsqueda (`CriteriosComparendos`) ya los lleva opcionales y ya viajan en la query, así que esa
//     HU es una barra nueva y no un rediseño de este cableado.
// ══════════════════════════════════════════════════════════════════════════════════════════════

import PageHeaderCard from '../components/flit/PageHeaderCard';
import { FlitCard, FlitEmpty, flitBtnSecondary, flitBtnSecondaryStyle } from '../components/flit/flitPageKit';
import BarraFiltrosComparendos from '../components/flito/comparendos/BarraFiltrosComparendos';
import PaginacionCursor from '../components/flito/comparendos/PaginacionCursor';
import TablaComparendos, { TablaComparendosCargando } from '../components/flito/comparendos/TablaComparendos';
import {
  hayCriterios, useCatalogosComparendos, useComparendosLista,
  type CriteriosComparendos,
} from '../components/flito/comparendos/useComparendosLista';

/** Resumen de lo que estaba puesto cuando no hubo resultados. Es lo que convierte «no hay nada» en
 *  «no hay nada DE ESTO», que es una conclusión muy distinta y la única accionable. */
function resumenCriterios(c: CriteriosComparendos): string {
  const partes: string[] = [];
  if (c.estado) partes.push(`estado «${c.estado === 'activo' ? 'Activos' : 'Inactivos'}»`);
  if (c.q.trim()) partes.push(`n.º «${c.q.trim()}»`);
  if (c.nit.trim()) partes.push(`NIT «${c.nit.trim()}»`);
  if (c.placa.trim()) partes.push(`placa «${c.placa.trim()}»`);
  return partes.join(' · ');
}

export default function FlitoComparendos() {
  // Los criterios, la pila de cursores y la petición viven en el hook: la página no puede
  // desincronizarlos porque no los toca. `aplicar` y `limpiar` son estables, que es lo que necesita
  // el efecto del debounce de la barra para no relanzarse en cada render.
  const {
    criterios, items, cargando, error, pagina, hayAnterior, haySiguiente,
    aplicar, limpiar, anterior, siguiente, recargar, volverAlPrincipio,
  } = useComparendosLista();
  const catalogos = useCatalogosComparendos();

  const filtrado = hayCriterios(criterios);

  // Anuncio para lectores de pantalla: sin esto, quien navega con lector no se entera de que la
  // tabla cambió bajo el mismo encabezado.
  const anuncio = cargando
    ? 'Cargando comparendos.'
    : error
      ? error.texto
      : items && items.length > 0
        ? `${items.length} comparendos en esta página.`
        : filtrado
          ? 'Ningún comparendo coincide con lo que buscaste.'
          : 'No hay comparendos registrados.';

  return (
    <div className="space-y-4">
      <PageHeaderCard
        title="Comparendos monitoreados"
        subtitle="Lo que SIMIT y los municipios reportan de los NIT que se vigilan. Los datos vienen de la fuente y no se editan aquí: lo único que se registra es la causal y la observación de gestión."
      />

      <p className="sr-only" aria-live="polite">{anuncio}</p>

      <BarraFiltrosComparendos criterios={criterios} onAplicar={aplicar} onLimpiar={limpiar} />

      <FlitCard>
        {/* Los cuatro estados, en este orden: el ERROR va antes que el vacío. Si la consulta falló
            no se sabe si hay filas, y decir «no hay comparendos» sería afirmar algo que nadie
            comprobó. Por el mismo motivo, bajo el error no se deja pintada una tabla anterior. */}
        {error && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm" style={{ color: 'var(--flit-danger)' }}>{error.texto}</p>
            {error.accion && (
              <button
                type="button"
                className={flitBtnSecondary}
                style={flitBtnSecondaryStyle}
                onClick={error.accion === 'reiniciar' ? volverAlPrincipio : recargar}
              >
                {error.accion === 'reiniciar' ? 'Volver a la primera página' : 'Reintentar'}
              </button>
            )}
          </div>
        )}

        {cargando && <TablaComparendosCargando />}

        {!error && items?.length === 0 && (
          <FlitEmpty>
            {filtrado ? (
              // Vacío B: el filtro no arroja nada.
              <div className="space-y-3" style={{ color: 'var(--flit-text-secondary)' }}>
                <p className="font-semibold">Ningún comparendo coincide con lo que buscaste.</p>
                <p>Filtros puestos: {resumenCriterios(criterios)}</p>
                {/* Solo con NIT o placa: con un filtro de estado o de número, esta frase sería ruido.

                    POLÍTICA DEL MÓDULO — este texto la aplica, y es la misma que deja los campos de
                    NIT y de placa SIN `placeholder` de ejemplo: en las pantallas de comparendos, lo
                    único con FORMA de NIT o de placa que llega al DOM viene de la respuesta del
                    servidor o de lo que el propio usuario acaba de escribir (el «Filtros puestos» de
                    aquí arriba es eso). El código no inventa ninguna, ni siquiera fabricada. El motivo no es que un ejemplo inventado sea un
                    dato personal —no lo es—, sino que la única defensa práctica contra una fuga aquí
                    es barrer el documento entero buscando esa forma (lo hacen los specs del módulo y
                    lo hará cualquier detector que se añada después), y un ejemplo estático obliga a
                    ese barrido a llevar una lista de excepciones. Una lista de excepciones es
                    exactamente el sitio donde un día se cuela un valor real sin que nadie lo note.
                    La spec de UX escribía este copy con una placa y un NIT de ejemplo; se conserva
                    lo que enseñaban —que los separadores de la placa dan igual y que el dígito de
                    verificación NO— sin escribir ninguno de los dos. */}
                {(criterios.nit.trim() || criterios.placa.trim()) && (
                  <p>
                    El NIT y la placa se buscan exactos, aunque no al pie de la letra: en la placa dan
                    igual los espacios y los guiones. En el NIT no: si lo escribes con dígito de
                    verificación no encuentra al mismo NIT sin él, ni al revés. El número de
                    comparendo sí busca por fragmento.
                  </p>
                )}
                <button
                  type="button"
                  className={flitBtnSecondary}
                  style={flitBtnSecondaryStyle}
                  onClick={limpiar}
                >
                  Quitar los filtros
                </button>
              </div>
            ) : (
              // Vacío A: todavía no hay datos. Sin botón de acción, y es deliberado: lo natural
              // sería «Ir a la sincronización», pero esa pantalla no existe todavía en apps/web y un
              // enlace a ninguna parte es peor que ninguno.
              <span style={{ color: 'var(--flit-text-secondary)' }}>
                Todavía no hay comparendos registrados. Aparecen aquí después de una sincronización
                con SIMIT y con los municipios configurados; si acabas de dar de alta los NIT que se
                vigilan, todavía no se ha consultado a ninguna fuente.
              </span>
            )}
          </FlitEmpty>
        )}

        {!error && !!items?.length && (
          <>
            <TablaComparendos
              items={items}
              catalogos={catalogos}
              mostrarInactivado={criterios.estado === 'inactivo'}
            />
            <PaginacionCursor
              enEstaPagina={items.length}
              pagina={pagina}
              hayAnterior={hayAnterior}
              haySiguiente={haySiguiente}
              onAnterior={anterior}
              onSiguiente={siguiente}
            />
          </>
        )}
      </FlitCard>
    </div>
  );
}
