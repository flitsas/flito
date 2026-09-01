// AC3 — «qué pasó, qué hacer y quién lo resuelve», compartido por la fila y por el detalle.
//
// **La pantalla no interpreta ni un código de error.** Todo este bloque se pinta con `item.guia`,
// que el servidor ya resolvió contra el catálogo de códigos de Siigo. Reinterpretar aquí un código
// sería una segunda traducción del mismo error, y la que se quedaría vieja.
//
// Las tres marcas de este archivo llevan SÍMBOLO Y PALABRA, nunca color solo (AGENTS.md §12): quien
// no distingue el rojo del gris tiene que poder leer «No se arregla reintentando».

import type { GuiaErrorSiigo, SiigoBandejaDescarte } from '@operaciones/shared-types';
import { fecha } from '../estilos';

/** El motivo, la acción y el responsable, literales. Nunca se recortan ni se retocan. */
export default function GuiaCaso(
  { guia, descarte }: { guia: GuiaErrorSiigo; descarte: SiigoBandejaDescarte | null },
) {
  return (
    <div className="flex flex-col gap-1">
      {descarte && <MarcaDescartado descarte={descarte} />}
      {!guia.sirveReintentar && <MarcaNoReintentable />}
      <p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>{guia.descripcion}</p>
      <p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>→ {guia.accion}</p>
      {/* `--flit-text-secondary` y no `--flit-text-muted`: el responsable hay que leerlo, y el gris
          de las ausencias no llega al 4,5:1 sobre la fila cuando el ratón la tiñe. */}
      <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
        Responsable: {guia.responsableEtiqueta}
      </p>
    </div>
  );
}

/**
 * El aviso que más importa no disimular: el servidor no supo traducir el código.
 *
 * El crudo (`guia.texto`) **no se pinta aquí**: es la única cadena de la pantalla que nadie ha
 * revisado y podría arrastrar un dato del cliente. Vive en el detalle, rotulado como tal.
 */
export function MarcaNoCatalogado({ guia }: { guia: GuiaErrorSiigo }) {
  if (guia.conocido) return null;
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold"
      style={{ color: 'var(--flit-text-muted)', background: '#EFF1F3', borderRadius: 'var(--flit-radius-pill)' }}
    >
      Motivo no catalogado
    </span>
  );
}

/**
 * `sirveReintentar === false` — el fallo es de un dato nuestro y volver a intentarlo consigue el
 * mismo rechazo. Aquí no hace falta un botón «¿por qué no?»: el motivo está escrito justo debajo,
 * que es la columna principal de esta pantalla.
 */
function MarcaNoReintentable() {
  return (
    <p className="text-sm font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>
      <span aria-hidden="true">⊘ </span>No se arregla reintentando
    </p>
  );
}

function MarcaDescartado({ descarte }: { descarte: SiigoBandejaDescarte }) {
  return (
    <div>
      <p className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
        <span aria-hidden="true">⚑ </span>Dado por perdido el {fecha(descarte.marcadoEn)}
      </p>
      <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
        {descarte.motivoEtiqueta}
        {descarte.nota ? ` · «${descarte.nota}»` : ''}
      </p>
    </div>
  );
}
