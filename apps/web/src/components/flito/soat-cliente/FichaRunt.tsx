// FLITO — canal Cliente: la ficha «Datos del RUNT» (HU #11914 AC1, #11967, #12091 AC3).
//
// ── Por qué una ficha `<dl>` y no once `<input disabled>` ────────────────────────────────────────
//
// Es el corazón del AC1 y la decisión se toma aquí, no en la página:
//
//   1. Un `<input disabled>` **no recibe foco**. Quien navega con teclado o con lector de pantalla
//      nunca llega al valor: once datos ilegibles con su herramienta habitual.
//   2. Gris + borde + rectángulo es el vocabulario de «esto se edita, pero ahora no puedes» — el
//      mismo que usa un campo bloqueado POR UN ERROR. El AC1 pide justo que no parezca eso. Un dato
//      que nunca se va a editar no debe llevar la forma de un control.
//   3. Un `<dl>` se copia, se lee y el lector lo anuncia como par etiqueta–valor, que es lo que es.
//   4. Ya existe en el producto: es el patrón `Dato` del detalle del SOAT (`FlitoSoat.tsx`). No se
//      inventa un patrón que el kit ya resuelve.
//
// La ficha **no está en el recorrido de tabulación**, y eso es correcto: es texto, no controles. Se
// alcanza por encabezados y por regiones, para lo cual lleva un `<h3>` REAL y no un `<p>` en negrita.
//
// ── Placa y VIN SÍ entran, y es el giro de la HU #12091 ─────────────────────────────────────────
//
// Este comentario decía lo contrario hasta la #12091, con razón entonces: se consultaba **por
// placa**, la pasarela devolvía el identificador consultado aunque no reconociera el vehículo, y
// enseñar el VIN habría convertido la pantalla en un lector de VIN por placa para quien sondeara
// placas ajenas. Con la #12090 la dirección se invirtió y las dos premisas caen:
//
//   · El **VIN** es lo que el Cliente acaba de teclear. No es un dato que se le revele: es el suyo.
//   · La **placa** ya no es eco de nada. Es lo que devuelve el registro y lo que se persiste en
//     `vehicles.plate`, así que es LA confirmación de que el RUNT habla de su vehículo — y por eso
//     encabeza la ficha, delante del VIN.
//
// Con ella desapareció `identificadoresGuardados`, el prop que existía para el único caso en que
// los dos entraban a la ficha (la subsanación, retirada en la #12079): ahora se pintan siempre y
// salen los dos de `datos.vehiculo`.
//
// ── Tres grupos y no once líneas planas (UX §4.1) ───────────────────────────────────────────────
//
// Once pares etiqueta–valor en una rejilla uniforme se leen como un volcado de payload: nadie sabe
// cuál mirar primero, y la pregunta que el Cliente se hace —«¿este es mi carro?»— se responde en
// dos de ellos. Se agrupan en orden de utilidad decreciente, con un `<h4>` real por grupo y el
// mismo token que ya usan los `<dt>`. Cero colores, cero bordes y cero separadores nuevos.
//
// ── Las tres cosas que la ficha lleva además de los datos ───────────────────────────────────────
//
//   · El **sello de procedencia** («Traídos el …»), en `role="status"`: informa, no interrumpe.
//   · Qué significa un «—», porque cuatro guiones seguidos se leen como una carga a medias.
//   · La frase de **qué hacer si están mal** (corregirlos ante el organismo, no aquí). Sin ella, un
//     dato incorrecto y no editable es una pared; con ella, es una instrucción.

import type { ReactNode } from 'react';
import type { PreconsultaRunt } from '../../../lib/soatCliente';

/** «Traídos el 29/08/2026 10:14». Fecha y hora, porque el RUNT cambia en el día. */
const selloDe = (d: Date) => d.toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });

/** Un valor que el RUNT no trajo se pinta «—»: un hueco en blanco se confunde con un fallo de carga. */
const dato = (v: string | null) => (v && v.trim() ? v : '—');

interface Props {
  datos: PreconsultaRunt;
  consultadoEn: Date;
}

export default function FichaRunt({ datos, consultadoEn }: Props) {
  const { vehiculo, organismo } = datos;
  return (
    <section
      aria-labelledby="ficha-runt-titulo"
      className="rounded-[12px] p-4"
      style={{ border: '1px solid var(--flit-border-soft)', background: 'var(--flit-bg-app)' }}
    >
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="ficha-runt-titulo" tabIndex={-1} className="text-sm font-bold outline-none" style={{ color: 'var(--flit-blue-text)' }}>
          Datos del RUNT
        </h3>
        <p role="status" className="text-[11px]" style={{ color: 'var(--flit-text-secondary)' }}>
          Traídos el {selloDe(consultadoEn)}
        </p>
      </div>

      {/* La placa va PRIMERA: es el dato que el Cliente no tecleó, el que aporta el registro y el
          que reconoce de un vistazo. El VIN detrás, que es el suyo. */}
      <Grupo titulo="Identificación">
        <Dato k="Placa" v={dato(vehiculo.placa)} />
        <Dato k="VIN" v={dato(vehiculo.vin)} />
      </Grupo>

      <Grupo titulo="Vehículo">
        <Dato k="Marca" v={dato(vehiculo.marca)} />
        <Dato k="Línea" v={dato(vehiculo.linea)} />
        <Dato k="Modelo" v={dato(vehiculo.modelo)} />
        <Dato k="Clase" v={dato(vehiculo.clase)} />
        <Dato k="Carrocería" v={dato(vehiculo.carroceria)} />
      </Grupo>

      {/* Lo que decide la TARIFA del SOAT, y lo que el Cliente casi nunca sabe de memoria: va al
          final porque no se verifica de un vistazo, se comprueba. `pasajerosSentados` y `puertas`
          dejaron de omitirse en la HU #12091 (AC3): se pintan SIEMPRE, con «—» cuando el RUNT no
          los trajo. Omitir la línea escondía la diferencia entre «no aplica» y «no vino». */}
      <Grupo titulo="Ficha técnica">
        <Dato k="Servicio" v={dato(vehiculo.tipoServicio)} />
        <Dato k="Cilindraje" v={dato(vehiculo.cilindraje)} />
        <Dato k="Capacidad (pasajeros)" v={dato(vehiculo.pasajerosSentados)} />
        <Dato k="Puertas" v={dato(vehiculo.puertas)} />
      </Grupo>

      {/* El organismo NO es uno de los once: no es un dato del vehículo sino de dónde está
          matriculado, y viaja en otra rama de la respuesta. Va aparte, en una línea ancha y sin
          rótulo de grupo. Por su NOMBRE: el código DIVIPOLA es la clave que viaja al backend y
          «05001» no le dice nada a nadie. **Si no cruza catálogo se pinta «—» y no pasa nada más**:
          desde la HU #11966 el organismo no es compuerta y la solicitud se envía igual. */}
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Dato k="Organismo de tránsito" v={dato(organismo.nombre)} ancho />
      </dl>

      <p className="mt-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
        Un dato en «—» es un dato que el RUNT no publica. No impide enviar la solicitud.
      </p>
      <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
        Estos datos los trae el RUNT y no se editan. Si alguno no coincide con su vehículo, corríjalo
        ante su organismo de tránsito antes de pedir el SOAT.
      </p>
    </section>
  );
}

/**
 * Un grupo rotulado de la ficha: un `<h4>` REAL —no un `<p>` en negrita— y su propio `<dl>`.
 *
 * El `<h4>` va FUERA del `<dl>` porque una lista de definiciones solo admite `dt`, `dd` y
 * envoltorios; meterlo dentro rompería la semántica que justifica usar `<dl>`. Y es un encabezado y
 * no un `aria-label` en el `<dl>` para que el grupo se alcance con la navegación por encabezados,
 * que es como se recorre una ficha de solo lectura.
 */
function Grupo({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <div className="mt-3 first:mt-0">
      <h4 className="mb-1 text-[11px] uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>
        {titulo}
      </h4>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">{children}</dl>
    </div>
  );
}

function Dato({ k, v, ancho }: { k: string; v: string; ancho?: boolean }) {
  return (
    <div className={`flex flex-col ${ancho ? 'col-span-2' : ''}`}>
      <dt className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--flit-text-muted)' }}>{k}</dt>
      <dd className="text-sm font-medium" style={{ color: 'var(--flit-text-primary)' }}>{v}</dd>
    </div>
  );
}
