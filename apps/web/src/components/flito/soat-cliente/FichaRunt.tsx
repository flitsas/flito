// FLITO — canal Cliente: la ficha «Datos del RUNT» (HU #11914, AC1).
//
// ── Por qué una ficha `<dl>` y no siete `<input disabled>` ───────────────────────────────────────
//
// Es el corazón del AC1 y la decisión se toma aquí, no en la página:
//
//   1. Un `<input disabled>` **no recibe foco**. Quien navega con teclado o con lector de pantalla
//      nunca llega al valor: siete datos ilegibles con su herramienta habitual.
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
// ── Las dos cosas que la ficha lleva además de los datos ────────────────────────────────────────
//
//   · El **sello de procedencia** («Traídos el …»), en `role="status"`: informa, no interrumpe.
//   · La frase de **qué hacer si están mal** (corregirlos ante el organismo, no aquí). Sin ella, un
//     dato incorrecto y no editable es una pared; con ella, es una instrucción.

import type { PreconsultaRunt } from '../../../lib/soatCliente';

/** «Traídos el 29/08/2026 10:14». Fecha y hora, porque el RUNT cambia en el día. */
const selloDe = (d: Date) => d.toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });

/** Un valor que el RUNT no trajo se pinta «—»: un hueco en blanco se confunde con un fallo de carga. */
const dato = (v: string | null) => (v && v.trim() ? v : '—');

interface Props {
  datos: PreconsultaRunt;
  consultadoEn: Date;
  /**
   * Placa y VIN **guardados** de una solicitud que ya existe (modo subsanación).
   *
   * Es el ÚNICO punto donde los dos entran a la ficha, y la diferencia no es cosmética: en el alta
   * son el eco de lo que el usuario acaba de teclear —la pasarela devuelve el identificador
   * consultado aunque no reconozca el vehículo—, mientras que aquí son lo que ya está persistido y
   * no se puede cambiar (cambiar el VIN convertiría la subsanación en un alta encubierta sobre otro
   * vehículo, con la fila equivocada).
   */
  identificadoresGuardados?: { placa: string; vin: string };
}

export default function FichaRunt({ datos, consultadoEn, identificadoresGuardados }: Props) {
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

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        {identificadoresGuardados && (
          <>
            <Dato k="Placa" v={identificadoresGuardados.placa} />
            <Dato k="VIN" v={identificadoresGuardados.vin} />
          </>
        )}
        <Dato k="Marca" v={dato(vehiculo.marca)} />
        <Dato k="Línea" v={dato(vehiculo.linea)} />
        <Dato k="Modelo" v={dato(vehiculo.modelo)} />
        <Dato k="Clase" v={dato(vehiculo.clase)} />
        <Dato k="Servicio" v={dato(vehiculo.tipoServicio)} />
        <Dato k="Cilindraje" v={dato(vehiculo.cilindraje)} />
        {/* El organismo, por su NOMBRE. El código DIVIPOLA es la clave que viaja al backend y
            «05001» no le dice nada a nadie. */}
        <Dato k="Organismo de tránsito" v={dato(organismo.nombre)} ancho />
      </dl>

      <p className="mt-3 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
        Estos datos los trae el RUNT y no se editan. Si alguno no coincide con su vehículo, corríjalo
        ante su organismo de tránsito antes de pedir el SOAT.
      </p>
    </section>
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
