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
// La HU #11562 enganchó aquí el panel de detalle, y con él tres decisiones de cableado:
//
//   · **El número de comparendo pasó de texto a botón.** Deja de ser cierto que «un botón que no
//     abre nada es peor que ninguno»: ya abre. Sigue siendo UNO por fila y ninguno más, que es lo
//     que impide que la tabla meta una parada de tabulador por celda.
//   · **La fila se parchea en sitio tras gestionar** (`parchearItem`), con el cuerpo del `PATCH`.
//     No se vuelve a pedir la página: hacerlo movería la lista bajo los pies de quien acaba de
//     gestionar y, con cursor, una fila reordenada puede desaparecer de la vista.
//   · **El foco tiene un respaldo** (`encabezadoResultadosRef`) para cuando la fila que abrió el
//     panel ya no está en el DOM al cerrarlo. Sin él, `.focus()` sobre ese nodo desmontado no hace
//     nada y el foco se queda en `<body>` (nota QA #63).
//
// La HU #11561 cierra el Feature colgando de aquí lo que faltaba —los cuatro filtros de la #11555 y
// la descarga en Excel— y con ello dos decisiones de cableado:
//
//   · **El export lee `criterios`, que es lo APLICADO, no lo escrito en la barra.** Si hay un NIT a
//     medio teclear sin `[Buscar]`, el archivo sale sin él: contiene lo que la tabla enseña, que es
//     literalmente para lo que existe. El texto de ayuda junto al botón lo dice en voz alta, porque
//     no es evidente.
//   · **El botón y su banda de resultado van separados** (`BotonExportarComparendos` en el hueco de
//     acciones, `AvisoExportComparendos` debajo): el mensaje del tope es una frase larga y dentro de
//     la cabecera aplastaría el título en cuanto la ventana se estreche.
// ══════════════════════════════════════════════════════════════════════════════════════════════

import { useRef, useState } from 'react';
import type {
  ComparendoRegistro, ComparendoRegistroDetalle, ComparendosOrigenMerge,
} from '@operaciones/shared-types';
import PageHeaderCard from '../components/flit/PageHeaderCard';
import { FlitCard, FlitEmpty, flitBtnSecondary, flitBtnSecondaryStyle } from '../components/flit/flitPageKit';
import BarraFiltrosComparendos from '../components/flito/comparendos/BarraFiltrosComparendos';
import {
  AvisoExportComparendos, BotonExportarComparendos, useExportComparendos,
} from '../components/flito/comparendos/ExportarComparendos';
import PaginacionCursor from '../components/flito/comparendos/PaginacionCursor';
import PanelDetalleComparendo from '../components/flito/comparendos/PanelDetalleComparendo';
import TablaComparendos, { TablaComparendosCargando } from '../components/flito/comparendos/TablaComparendos';
import {
  hayCriterios, useCatalogosComparendos, useComparendosLista,
  type CatalogosComparendos, type CriteriosComparendos,
} from '../components/flito/comparendos/useComparendosLista';

/**
 * Resumen de lo que estaba puesto cuando no hubo resultados. Es lo que convierte «no hay nada» en
 * «no hay nada DE ESTO», que es una conclusión muy distinta y la única accionable.
 *
 * **Enumera los OCHO criterios, no cuatro.** Hasta la HU #11561 listaba solo estado, número, NIT y
 * placa, que era todo lo que la barra sabía poner; con los cuatro filtros nuevos en pantalla, un
 * vacío provocado por un municipio o una causal se anunciaba como «Filtros puestos:» seguido de
 * nada, o —peor— repitiendo solo los otros, que es afirmar que se buscó algo distinto de lo que se
 * buscó. `catalogos` entra para poder decir «Itagüí» donde el criterio guarda «ITAGUI»: el resumen
 * lo lee un humano que eligió un nombre en un desplegable, no un código de fuente.
 */
function resumenCriterios(c: CriteriosComparendos, catalogos: CatalogosComparendos): string {
  const partes: string[] = [];
  if (c.estado) partes.push(`estado «${c.estado === 'activo' ? 'Activos' : 'Inactivos'}»`);
  if (c.q.trim()) partes.push(`n.º «${c.q.trim()}»`);
  if (c.nit.trim()) partes.push(`NIT «${c.nit.trim()}»`);
  if (c.placa.trim()) partes.push(`placa «${c.placa.trim()}»`);
  if (c.municipio) partes.push(`municipio «${catalogos.municipios[c.municipio] ?? c.municipio}»`);
  if (c.fuente) partes.push(`fuente «${ETIQUETA_FUENTE[c.fuente]}»`);
  if (c.causalId) partes.push(`causal «${catalogos.causales[c.causalId] ?? 'aplicada'}»`);
  if (c.sinCausal) partes.push('causal «sin asignar»');
  return partes.join(' · ');
}

/** Las mismas etiquetas del selector, y por el mismo motivo: «SIMIT» a secas no dice «solo SIMIT». */
const ETIQUETA_FUENTE: Record<ComparendosOrigenMerge, string> = {
  simit: 'Solo SIMIT',
  municipal: 'Solo municipal',
  ambos: 'Ambas fuentes',
};

export default function FlitoComparendos() {
  // Los criterios, la pila de cursores y la petición viven en el hook: la página no puede
  // desincronizarlos porque no los toca. `aplicar` y `limpiar` son estables, que es lo que necesita
  // el efecto del debounce de la barra para no relanzarse en cada render.
  const {
    criterios, items, cargando, error, pagina, hayAnterior, haySiguiente,
    aplicar, limpiar, anterior, siguiente, recargar, volverAlPrincipio, parchearItem,
  } = useComparendosLista();
  const catalogos = useCatalogosComparendos();
  const exportacion = useExportComparendos(criterios);

  // La fila abierta, no solo su id: el panel pinta el número en el título ANTES de que llegue
  // ninguna respuesta, y ese número ya se conoce porque está en la fila que se acaba de pulsar.
  const [abierto, setAbierto] = useState<ComparendoRegistro | null>(null);
  /**
   * Respaldo del foco al cerrar el panel (AC8 · nota QA #63).
   *
   * Cuelga del ENCABEZADO de la región de resultados y no del `<caption>` de la tabla, que es lo
   * que la nota pedía al pie de la letra. El motivo es que el caso en que este respaldo hace falta
   * —cerrar tras un 404, que además recarga la lista— es justo aquel en el que la tabla se
   * desmonta: el foco aterrizaría en el `<caption>` del esqueleto y lo perdería otra vez al llegar
   * los datos, porque ese nodo también se va. Este encabezado está montado en los CUATRO estados de
   * la vista, así que es el único destino que no puede desaparecer bajo el foco. Cumple lo que la
   * nota persigue —«al encabezado de la tabla, nunca a `<body>`»— y además anuncia algo con
   * sentido: un `<caption>` recibiendo foco no dice dónde has quedado.
   */
  const encabezadoResultadosRef = useRef<HTMLHeadingElement>(null);

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
        actions={(
          <div className="flex flex-col items-end gap-1">
            <BotonExportarComparendos ocupado={exportacion.ocupado} onExportar={exportacion.exportar} />
            {/* El tope se anuncia ANTES de fallar, pero SIN cifra: el máximo de filas es
                configurable por entorno y cualquier número escrito aquí puede ser falso en cualquier
                despliegue. Cuando el tope se alcanza, el 422 trae el número de verdad. */}
            <span className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
              Se exporta el conjunto filtrado que estás viendo, no solo esta página.
            </span>
          </div>
        )}
      />

      <p className="sr-only" aria-live="polite">{anuncio}</p>

      <AvisoExportComparendos
        ocupado={exportacion.ocupado}
        aviso={exportacion.aviso}
        onReintentar={exportacion.exportar}
        onDescartar={exportacion.descartar}
      />

      <BarraFiltrosComparendos
        criterios={criterios}
        onAplicar={aplicar}
        onLimpiar={limpiar}
        catalogos={catalogos}
      />

      <FlitCard>
        {/* Encabezado de la región de resultados y destino de respaldo del foco (AC8).
            `sr-only focus:not-sr-only`: no ocupa sitio —el título de la página ya nombra la
            pantalla— pero **se hace visible al recibir el foco**, porque un elemento enfocado que
            no se ve incumple «foco visible» para quien navega con teclado sin lector. */}
        <h2
          ref={encabezadoResultadosRef}
          tabIndex={-1}
          className="flit-focus sr-only rounded focus:not-sr-only focus:mb-3 focus:block focus:text-sm focus:font-semibold"
          style={{ color: 'var(--flit-text-primary)' }}
        >
          Lista de comparendos
        </h2>

        {/* Los cuatro estados, en este orden: el ERROR va antes que el vacío. Si la consulta falló
            no se sabe si hay filas, y decir «no hay comparendos» sería afirmar algo que nadie
            comprobó. Por el mismo motivo, bajo el error no se deja pintada una tabla anterior. */}
        {error && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3">
            {/* `--flit-danger` es color de superficie: como texto de 14px sobre la tarjeta blanca
                se queda en 4,19 (axe lo marca `serious`). La variante tinta del bug #11604 sube a
                5,71 sin cambiar la lectura del mensaje: sigue siendo rojo de error. */}
            <p className="text-sm" style={{ color: 'var(--flit-danger-ink)' }}>{error.texto}</p>
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
                <p>Filtros puestos: {resumenCriterios(criterios, catalogos)}</p>
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
              onAbrir={setAbierto}
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

      {/* El panel se monta con el clic, no con la respuesta: abre de inmediato con el número en el
          título y el cuerpo en esqueleto. Montarlo al llegar los datos, además de sentirse como un
          clic perdido, rompería la restauración del foco (ver `PanelDetalleComparendo`). */}
      {abierto && (
        <PanelDetalleComparendo
          fila={abierto}
          catalogos={catalogos}
          onCerrar={() => setAbierto(null)}
          onCerrarYRecargar={() => { setAbierto(null); recargar(); }}
          onGestionado={(nuevo: ComparendoRegistroDetalle) => {
            // Se le quita `eventos` antes de guardarlo en la lista: el timeline es del panel y en la
            // fila sería un campo que nadie lee y que crecería con cada gestión de la sesión.
            const { eventos: _eventos, ...fila } = nuevo;
            parchearItem(fila);
          }}
          respaldoFocoRef={encabezadoResultadosRef}
        />
      )}
    </div>
  );
}
