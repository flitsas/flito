// Reporte de costos — la tarjeta que dispara el envío a facturación electrónica (HU #11329).
//
// Es la única superficie nueva con datos propios, y por eso lleva los cuatro estados del AC2
// enteros. **Solo se monta para quien tiene la acción `emitir`**: al `auditor` el AC1 le concede «la
// pantalla y el estado», y el estado ya lo tiene entero —contadores, columna «Factura DIAN» y su
// ficha—. Esta tarjeta no informa: es el envoltorio de la acción. Enseñársela inerte sería un botón
// apagado en cada visita y, de paso, una consulta cara por algo que nunca podrá ejecutar.
//
// **El error va ANTES que el vacío**, por la misma razón que ya escribió `ContadoresFacturacion`: si
// la consulta falló no se sabe si hay elegibles, y decir «no hay» sería afirmar algo que nadie
// comprobó.

import type { RefObject } from 'react';
import { Link } from 'react-router-dom';
import {
  MOTIVOS_TRAMITE_NO_ELEGIBLE, MOTIVO_TRAMITE_NO_ELEGIBLE_TEXTO,
  type MotivoTramiteNoElegible, type ResumenElegibilidad,
} from '@operaciones/shared-types';
import { FlitCard, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondarySm } from '../flit/flitPageKit';

interface Props {
  cargando: boolean;
  error: string | null;
  onReintentar: () => void;
  /** Cuántas filas tiene la página. Solo para el vacío del caso A. */
  filas: number;
  /** Trámites `facturado` de la página: sobre quién tuvo sentido preguntar. */
  candidatos: number;
  resumen: ResumenElegibilidad | null;
  /** Cuántos se enviarían al pulsar. Con 0 el botón no existe: nunca se ofrece «Enviar 0». */
  elegibles: number;
  /** Sobre cuántos habla la frase: los facturados de la página, o los seleccionados. */
  universo: number;
  /** `true` = la frase habla de la selección. El alcance lo dice la frase, no el botón. */
  deLaSeleccion: boolean;
  onEnviar: () => void;
  onVerPorFacturar: () => void;
  /** El enlace a la configuración de emisión solo se pinta si el usuario tiene ese slug. */
  puedeVerConfiguracion: boolean;
  /** Para rescatar el foco cuando la fila que abrió el diálogo ya no está en el DOM. */
  tituloRef: RefObject<HTMLHeadingElement>;
}

const TEXTO_SECUNDARIO = { color: 'var(--flit-text-secondary)' } as const;

/**
 * Los dos motivos que DELEGAN el diagnóstico. Su texto de catálogo es un encabezado y el detalle
 * real es por trámite, así que se dice — o alguien creería que el encabezado es todo lo que hay.
 */
const DELEGAN: readonly MotivoTramiteNoElegible[] = ['cliente_no_facturable', 'compuerta_cerrada'];

export default function TarjetaEnvioFacturacion(p: Props) {
  return (
    <FlitCard className="!p-3">
      {/* `tabIndex={-1}`: no entra en el orden de tabulación, pero puede recibir foco por código. */}
      <h3 ref={p.tituloRef} tabIndex={-1}
        className="mb-2 text-xs font-semibold uppercase tracking-wide"
        style={{ color: 'var(--flit-text-muted)' }}>
        Envío a facturación electrónica
      </h3>
      <Cuerpo {...p} />
    </FlitCard>
  );
}

function Cuerpo(p: Props) {
  if (p.cargando) {
    return (
      <p className="text-sm" style={TEXTO_SECUNDARIO} role="status">
        Comprobando cuáles se pueden facturar…
      </p>
    );
  }

  if (p.error) {
    // Sin elegibilidad no se puede afirmar cuántos son elegibles, y el AC3 exige decirlo ANTES de
    // enviar: por eso aquí no se ofrece el botón de envío, solo el reintento.
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm" style={{ color: 'var(--flit-danger)' }} role="alert">
          No se pudo comprobar cuáles se pueden facturar: {p.error}
        </span>
        <button type="button" className={flitBtnSecondarySm} onClick={p.onReintentar}
          style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}>
          Reintentar
        </button>
      </div>
    );
  }

  // Caso A — nadie ha pasado por «Facturar». Cuesta CERO peticiones: se sabe con la columna que la
  // fila ya trae. Y el porqué no se redacta aquí: es el texto del catálogo que usa el servidor.
  if (p.candidatos === 0) {
    return (
      <div className="space-y-1 text-sm">
        <p style={{ color: 'var(--flit-text-primary)' }}>
          Ninguno de los {p.filas.toLocaleString('es-CO')} trámites de esta página está facturado
          todavía.
        </p>
        <p style={TEXTO_SECUNDARIO}>
          {MOTIVO_TRAMITE_NO_ELEGIBLE_TEXTO.liquidacion_no_facturada}
        </p>
        <button type="button" className="text-sm font-semibold underline"
          style={{ color: 'var(--flit-blue-text)' }} onClick={p.onVerPorFacturar}>
          Ver los que están por facturar
        </button>
      </div>
    );
  }

  // Caso B — hay candidatos y ninguno es elegible. Aquí sí se pagó la consulta, así que se puede
  // decir algo concreto en vez de un «no hay» que no ayuda a nadie. Sin resumen no se pinta nada:
  // lo único que no puede pasar es que se ofrezca «Enviar 0».
  if (p.elegibles === 0) return p.resumen ? <SinElegibles {...p} resumen={p.resumen} /> : null;

  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
        <strong>{p.elegibles.toLocaleString('es-CO')}</strong> de los{' '}
        {p.universo.toLocaleString('es-CO')}{' '}
        {p.deLaSeleccion ? 'trámites seleccionados' : 'trámites facturados de esta página'} se pueden
        enviar a facturación electrónica.
        {!p.deLaSeleccion && p.universo > p.elegibles && (
          <span style={TEXTO_SECUNDARIO}>
            {' '}Los otros {(p.universo - p.elegibles).toLocaleString('es-CO')} no: cada fila dice
            por qué.
          </span>
        )}
      </p>
      {/* Nunca inhabilitado: `disabled:opacity-50` sobre el degradado baja el contraste del texto
          blanco. O hay elegibles y el botón se pinta, o no existe (regla 12). */}
      <button type="button" className={`${flitBtnPrimary} ml-auto`} style={flitBtnPrimaryStyle}
        onClick={p.onEnviar}>
        Enviar {p.elegibles.toLocaleString('es-CO')} a facturación electrónica
      </button>
    </div>
  );
}

/**
 * El desglose del caso B.
 *
 * **El orden es el del catálogo, no el de la cantidad.** `MOTIVOS_TRAMITE_NO_ELEGIBLE` está ordenado
 * «primero lo que depende del trámite, después de su cliente, al final la configuración» —que es el
 * orden en que alguien lo arregla— y además es estable: ordenar por cantidad haría bailar las líneas
 * entre dos consultas.
 *
 * **`anterior_al_corte` va aparte y NO se repite arriba.** Hoy `porMotivo.anterior_al_corte` y
 * `anterioresAlCorte` son el mismo hecho contado por la misma ruta; pintarlo dos veces sería
 * contarlo dos veces. Va separado porque responde otra pregunta: es el único motivo que no se
 * arregla trabajando el trámite, sino cambiando un dato de configuración.
 */
function SinElegibles({ candidatos, resumen, puedeVerConfiguracion }: Props & { resumen: ResumenElegibilidad }) {
  const lineas = MOTIVOS_TRAMITE_NO_ELEGIBLE
    .filter((m) => m !== 'anterior_al_corte' && resumen.porMotivo[m] > 0);

  return (
    <div className="space-y-2 text-sm">
      <p style={{ color: 'var(--flit-text-primary)' }}>
        Ninguno de los {candidatos.toLocaleString('es-CO')} trámites facturados de esta página se
        puede enviar a facturación electrónica todavía. Esto es lo que falta:
      </p>

      <ul className="space-y-1">
        {lineas.map((m) => (
          <li key={m} className="flex gap-2" style={TEXTO_SECUNDARIO}>
            <strong className="tabular-nums" style={{ color: 'var(--flit-text-primary)' }}>
              {resumen.porMotivo[m].toLocaleString('es-CO')}
            </strong>
            {/* El texto del motivo, sin retocar: el navegador aporta el número y el orden, nada más. */}
            <span>
              {MOTIVO_TRAMITE_NO_ELEGIBLE_TEXTO[m]}
              {DELEGAN.includes(m) && (
                <span style={{ color: 'var(--flit-text-muted)' }}>
                  {' '}(el detalle exacto está en cada fila, en «¿Por qué no?»)
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>

      {lineas.length > 1 && (
        <p className="text-xs" style={TEXTO_SECUNDARIO}>
          Un trámite puede aparecer en varias líneas: resolver una causa no siempre lo desbloquea.
        </p>
      )}

      {resumen.anterioresAlCorte > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t pt-2"
          style={{ borderColor: 'var(--flit-border-soft)' }}>
          <span style={TEXTO_SECUNDARIO}>
            <strong style={{ color: 'var(--flit-text-primary)' }}>
              {resumen.anterioresAlCorte.toLocaleString('es-CO')}
            </strong>{' '}
            quedaron fuera por la fecha de corte del histórico. Si deben facturarse, esa fecha se
            cambia en la configuración de emisión.
          </span>
          {puedeVerConfiguracion && (
            <Link to="/siigo/parametrizacion" className="text-sm font-semibold underline"
              style={{ color: 'var(--flit-blue-text)' }}>
              Ir a la configuración
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
