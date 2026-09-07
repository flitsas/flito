// FLITO — canal Cliente: los bloques del formulario de solicitud (HU #11914, #11936, #11967,
// #12091).
//
// ── Por qué cada bloque es una `<section>` con `<h2>` ────────────────────────────────────────────
//
// Es lo que permite saltar de bloque a bloque con un lector de pantalla. Los tres bloques montan
// sus controles desde el primer paint: la compuerta de la HU #11967 es del ENVÍO, no del tecleo, y
// doce controles grises que no reciben foco es lo que la #11936 quitó con razón.
//
// El ORDEN de los tres —vehículo, factura, propietario— lo decide la página, que es quien los monta.

import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import FlitSelect from '../../flit/FlitSelect';
import FlitUploadBox from '../../flit/FlitUploadBox';
import { flitInp, flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';
import { esNit, MAX_MB_FACTURA, OPCIONES_TIPO_DOC, tamanoMb } from '../../../lib/soatCliente';

// ───────────────────────────── Datos del propietario ─────────────────────────────────────────────

/**
 * El titular, **partido** (HU #11966, AC5) y con contacto y ubicación obligatorios.
 *
 * `nombreCompleto` ya no existe: salió del contrato y lo deriva el servidor. Y los tres campos de
 * nombre son **independientes y permanentes**: el tipo de documento decide cuáles se montan y
 * cuáles viajan, nunca cuáles existen. Un solo campo que se renombra al conmutar pierde lo escrito
 * y acaba mandando un apellido como razón social.
 */
export interface Propietario {
  tipoDocumento: string;
  numeroDocumento: string;
  nombres: string;
  apellidos: string;
  razonSocial: string;
  correo: string;
  celular: string;
  direccion: string;
  municipio: string;
  departamento: string;
}

export type CampoPropietario = keyof Propietario;

export const PROPIETARIO_VACIO: Propietario = {
  tipoDocumento: '', numeroDocumento: '', nombres: '', apellidos: '', razonSocial: '',
  correo: '', celular: '', direccion: '', municipio: '', departamento: '',
};

/** Los tres campos que la conmutación NIT ⇄ persona natural monta y desmonta. */
export const CAMPOS_NOMBRE: readonly CampoPropietario[] = ['nombres', 'apellidos', 'razonSocial'];

/**
 * Ids ESTABLES de los controles que la página tiene que poder enfocar.
 *
 * Al primer campo inválido, no al mensaje: enfocando el control el lector anuncia etiqueta, estado
 * inválido y descripción de una vez, que es el criterio que `FlitSelect` ya implementa. Se hace con
 * `id` y no con un `ref` por control porque los controles viven en este archivo y quien decide cuál
 * es el primero es la página: pasar seis refs hacia arriba sería plomería para el mismo efecto.
 *
 * `tipoDocumento` NO está aquí a propósito: `FlitSelect` genera su id con `useId()` y se enfoca solo
 * en cuanto recibe `error`. Duplicarlo aquí sería una segunda fuente de verdad para el mismo foco.
 *
 * `placa` salió en la HU #12091 (AC1) con el control que lo llevaba: el Cliente ya no la teclea.
 * `numeroDocumento` **se queda**, aunque el AC1 nombre los tres campos a la vez: no desaparece del
 * formulario sino que cambia de bloque, y este id es con el que `useFocoPrimerError` lo alcanza en
 * el error más común del formulario. Retirarlo dejaría el foco cayendo a `<body>`.
 */
export const ID_CAMPO = {
  vin: 'sol-vin',
  numeroDocumento: 'sol-numero-documento',
  nombres: 'sol-nombres',
  apellidos: 'sol-apellidos',
  razonSocial: 'sol-razon-social',
  correo: 'sol-correo',
  celular: 'sol-celular',
  direccion: 'sol-direccion',
  municipio: 'sol-municipio',
  departamento: 'sol-departamento',
} as const;

// ───────────────────────────── Piezas compartidas ────────────────────────────────────────────────

/** Un bloque del formulario. El número va en el `<h2>` porque es parte del rótulo, no un adorno. */
export function Seccion({ titulo, chip, children }: { titulo: string; chip?: ReactNode; children: ReactNode }) {
  return (
    <section
      aria-label={titulo}
      className="bg-flit-card p-5"
      style={{ borderRadius: 'var(--flit-radius-card)', border: '1px solid var(--flit-border-soft)', boxShadow: 'var(--flit-shadow-card)' }}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>{titulo}</h2>
        {chip}
      </div>
      {children}
    </section>
  );
}

/**
 * Un campo de texto con etiqueta asociada, ayuda y error.
 *
 * `aria-invalid` se pone **solo mientras hay error** y se quita en cuanto el campo se corrige:
 * dejarlo puesto convierte la marca en ruido. El mensaje va en `role="alert"` porque impide
 * continuar; la ayuda y la marca de procedencia son texto normal enlazado por `aria-describedby`.
 */
export function Campo({
  id, label, valor, onCambio, onBlur, error, ayuda, opcional,
  maxLength, autoComplete, inputRef, readOnly, invalido, describedByExtra,
}: {
  id: string; label: string; valor: string; onCambio: (v: string) => void; onBlur?: () => void;
  error?: string; ayuda?: string;
  /**
   * Hoy **ningún campo de esta pantalla lo usa**: el VIN era el único opcional y la HU #12091 lo
   * hizo obligatorio (AC1). Se conserva la capacidad —no el rótulo a medida `textoOpcional`, que
   * existía solo para no escribir «VIN (número de chasis) (opcional)»— porque el marcador de
   * requerido es de este componente y no de sus llamadores.
   */
  opcional?: boolean;
  maxLength?: number; autoComplete?: string;
  /** Para `restoreFocusRef` de los modales de bloqueo: hace falta el nodo, no su id. */
  inputRef?: RefObject<HTMLInputElement>;
  /**
   * `readOnly` y **nunca `disabled`** para el campo que está en vuelo: un control deshabilitado
   * pierde el foco que tuviera y sale del recorrido de tabulación a media consulta. En solo lectura
   * el valor se sigue viendo, se sigue pudiendo copiar y el foco no se cae a `<body>`.
   */
  readOnly?: boolean;
  /**
   * Marca el control como inválido **sin mensaje propio**, cuando quien lo explica es una banda de
   * fuera (el `422 runt_no_cuadra`). Repetir el texto bajo el campo sería decir dos veces lo mismo;
   * no marcarlo dejaría al lector de pantalla sin saber cuál es el campo.
   */
  invalido?: boolean;
  /** Id del texto de fuera que describe el estado inválido. Se suma al `aria-describedby`. */
  describedByExtra?: string;
}) {
  const idAyuda = `${id}-ayuda`;
  const idError = `${id}-error`;
  const describedBy = [
    ayuda ? idAyuda : null,
    error ? idError : null,
    invalido && describedByExtra ? describedByExtra : null,
  ].filter(Boolean).join(' ');
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
        {label}{opcional ? ' (opcional)' : ' *'}
      </label>
      <input
        id={id}
        ref={inputRef}
        className={flitInp}
        value={valor}
        maxLength={maxLength}
        autoComplete={autoComplete}
        required={!opcional}
        readOnly={readOnly}
        aria-invalid={error || invalido ? true : undefined}
        aria-describedby={describedBy || undefined}
        onChange={(e) => onCambio(e.target.value)}
        onBlur={onBlur}
      />
      {ayuda && (
        <p id={idAyuda} className="mt-1 text-[11px]" style={{ color: 'var(--flit-text-secondary)' }}>
          {ayuda}
        </p>
      )}
      {error && (
        <p id={idError} role="alert" className="mt-1 text-xs" style={{ color: 'var(--flit-danger-ink)' }}>{error}</p>
      )}
    </div>
  );
}

// ───────────────────────────── Documento del propietario ─────────────────────────────────────────

/**
 * Tipo y número del catálogo RUNT, **en el bloque del propietario y en ningún otro sitio**
 * (HU #12091, AC1).
 *
 * Vivían en el bloque 1 porque la consulta por placa los exigía (Bug #11927). Desde la HU #12090 el
 * RUNT se interroga solo por VIN: un dato que no cambia el resultado de la consulta no tiene por qué
 * pedirse antes de ella, y arriba no hacía más que provocar la pregunta «¿y por qué me pide el
 * documento aquí?». Con la mudanza desaparece también su eco de abajo, así que el documento vuelve
 * a tener UNA sola aparición en la pantalla.
 */
export function CamposDocumento({ valor, onCambio, errores, onBlur }: {
  valor: Pick<Propietario, 'tipoDocumento' | 'numeroDocumento'>;
  onCambio: (campo: CampoPropietario, v: string) => void;
  errores: Partial<Record<CampoPropietario, string>>;
  onBlur: (campo: CampoPropietario) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <FlitSelect
        label="Tipo de documento"
        value={valor.tipoDocumento}
        opciones={OPCIONES_TIPO_DOC}
        onChange={(v) => onCambio('tipoDocumento', v)}
        ayuda="Como aparece en el documento del propietario."
        error={errores.tipoDocumento ?? null}
        required
      />
      <Campo
        id={ID_CAMPO.numeroDocumento} label="Número de documento" valor={valor.numeroDocumento}
        onCambio={(v) => onCambio('numeroDocumento', v)} onBlur={() => onBlur('numeroDocumento')}
        error={errores.numeroDocumento} maxLength={30} autoComplete="off"
      />
    </div>
  );
}

// ───────────────────────────── Bloque 3 · Propietario ────────────────────────────────────────────

/**
 * El propietario, **entero y editable**, con su documento incluido (HU #12091, AC1).
 *
 * Este bloque **no tiene estado «cargando»**: el catálogo de tipos de documento es estático y la
 * partición NIT/natural es local. Nadie debe inventarle un `onReintentar` que no reintentaría nada.
 *
 * ── Se fue el modo `eco` ────────────────────────────────────────────────────────────────────────
 *
 * El prop `documento` tenía dos modos porque el documento era entrada de la consulta al RUNT y vivía
 * en el bloque 1: aquí solo se ENSEÑABA, en una línea que decía dónde se cambia. Desde la #12090 la
 * consulta va por VIN, el documento vuelve a ser un dato del propietario y nada más, y con un solo
 * modo el prop sobra. Y es además la forma exacta que la HU #12094 necesita para prellenar campos
 * corregibles con lo que lea de la factura: **con esta HU nacen vacíos**.
 */
export function BloquePropietario({ valor, onCambio, errores, onBlur, referenciaRunt }: {
  valor: Propietario;
  onCambio: (campo: CampoPropietario, v: string) => void;
  errores: Partial<Record<CampoPropietario, string>>;
  onBlur: (campo: CampoPropietario) => void;
  /**
   * El nombre que el RUNT reporta como propietario, **solo como referencia** y jamás prellenado.
   *
   * La respuesta lo trae fundido en una cadena y partirlo por el espacio es la heurística que el
   * propio backend rechaza por escrito: falla en cada nombre compuesto y en cada razón social, y
   * guardaría «MARÍA FERNANDA GÓMEZ RUIZ» como nombre de pila. Una línea de referencia dice la
   * verdad y no obliga a nadie a corregir un reparto inventado.
   */
  referenciaRunt?: string | null;
}) {
  const juridica = esNit(valor.tipoDocumento);
  return (
    <div className="space-y-3">
      {/* El vacío útil del bloque: qué se escribe aquí y para qué sirve. NO promete que la factura
          vaya a precargarlo —eso es la HU #12094 y hoy no sería verdad. */}
      <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
        Escriba el propietario como aparece en la factura de venta: son los datos que van en la póliza.
      </p>

      <CamposDocumento valor={valor} onCambio={onCambio} errores={errores} onBlur={onBlur} />

      {referenciaRunt && (
        <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          El RUNT reporta como propietario: {referenciaRunt}. Escríbalo como aparece en la factura de venta.
        </p>
      )}

      {/* El tipo decide cuáles se MONTAN; los tres valores siguen guardados en el estado del
          formulario, así que volver a la forma anterior devuelve lo que había escrito. */}
      {juridica
        ? (
          <Campo
            id={ID_CAMPO.razonSocial} label="Razón social" valor={valor.razonSocial}
            onCambio={(v) => onCambio('razonSocial', v)} onBlur={() => onBlur('razonSocial')}
            error={errores.razonSocial} ayuda="Como aparece en el RUT y en la factura de venta."
            maxLength={200}
          />
        )
        : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Campo
              id={ID_CAMPO.nombres} label="Nombre/s" valor={valor.nombres}
              onCambio={(v) => onCambio('nombres', v)} onBlur={() => onBlur('nombres')}
              error={errores.nombres} ayuda="Como aparecen en el documento del propietario."
              maxLength={200}
            />
            <Campo
              id={ID_CAMPO.apellidos} label="Apellido/s" valor={valor.apellidos}
              onCambio={(v) => onCambio('apellidos', v)} onBlur={() => onBlur('apellidos')}
              error={errores.apellidos} maxLength={200}
            />
          </div>
        )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Campo
          id={ID_CAMPO.correo} label="Correo electrónico" valor={valor.correo}
          onCambio={(v) => onCambio('correo', v)} onBlur={() => onBlur('correo')}
          error={errores.correo} maxLength={150} autoComplete="off"
        />
        <Campo
          id={ID_CAMPO.celular} label="Celular" valor={valor.celular}
          onCambio={(v) => onCambio('celular', v)} onBlur={() => onBlur('celular')}
          error={errores.celular} maxLength={30} autoComplete="off"
        />
      </div>

      <Campo
        id={ID_CAMPO.direccion} label="Dirección" valor={valor.direccion}
        onCambio={(v) => onCambio('direccion', v)} onBlur={() => onBlur('direccion')}
        error={errores.direccion} maxLength={300} autoComplete="off"
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <Campo
          id={ID_CAMPO.municipio} label="Municipio" valor={valor.municipio}
          onCambio={(v) => onCambio('municipio', v)} onBlur={() => onBlur('municipio')}
          error={errores.municipio} ayuda="Donde vive el propietario. No es el del organismo de tránsito."
          maxLength={100} autoComplete="off"
        />
        <Campo
          id={ID_CAMPO.departamento} label="Departamento" valor={valor.departamento}
          onCambio={(v) => onCambio('departamento', v)} onBlur={() => onBlur('departamento')}
          error={errores.departamento} maxLength={100} autoComplete="off"
        />
      </div>
    </div>
  );
}

// ───────────────────────────── Bloque 2 · Factura de venta ───────────────────────────────────────

/**
 * El bloque es una `<Seccion>` propia y va DELANTE del propietario (HU #12091, AC2): es el orden en
 * el que el trabajo se hace de verdad —primero se sube el papel, después se copia lo que dice— y es
 * el que la HU #12094 necesita para leerlo por OCR y precargar el propietario sin volver a reordenar
 * la pantalla. Aquí acaba la preparación: **hoy no se pinta nada más en este bloque**, ni un aviso
 * de lectura ni un hueco reservado que prometa algo que todavía no ocurre.
 *
 * `FlitUploadBox` ya trae los cuatro estados (`idle | uploading | verified | rejected`) con su color,
 * su icono y su texto. Se usa tal cual, con dos añadidos que el componente no puede dar:
 *
 *   · `accept=".pdf"` — el defecto incluye imágenes y aquí solo vale PDF. No es una validación:
 *     `accept` es una sugerencia del diálogo del sistema y se salta arrastrando el archivo.
 *   · Un `role="alert"` **con el motivo concreto**. El «Rechazado — cargar otro» del componente no
 *     basta: no dice por qué, y el rechazo del servidor por bytes es exactamente el caso en el que
 *     el usuario no puede adivinarlo.
 *
 * **Un solo archivo**, aunque el endpoint de facturas de la cola acepte 50: lo garantiza el índice
 * único parcial sobre `flito_soportes`. Dos facturas vivas para el mismo SOAT y la pantalla
 * enseñaría la que ordenara primero.
 *
 * **No se previsualiza.** `VisorPdf` existe, pero montar el worker de pdfjs en una pantalla cuyo
 * trabajo es ENVIAR —con un archivo que acaba de salir del disco del usuario— no responde a la
 * pregunta que se hace aquí, que es «¿es el que quería?». El nombre y el tamaño sí.
 */
export function BloqueFactura({ archivo, error, rotulo, onElegir, onQuitar }: {
  archivo: File | null;
  error?: string;
  /** Rótulo alternativo para la subsanación, donde el adjunto es opcional. */
  rotulo?: string;
  onElegir: (f: File) => void;
  onQuitar: () => void;
}) {
  const estado = error ? 'rejected' : archivo ? 'verified' : 'idle';
  return (
    <div className="space-y-2">
      <FlitUploadBox
        label="Factura de venta del vehículo"
        required={!rotulo}
        state={estado}
        count={archivo ? 1 : 0}
        accept=".pdf"
        hint={rotulo ?? `Un solo archivo PDF · máximo ${MAX_MB_FACTURA} MB`}
        onFile={onElegir}
      />
      {archivo && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs font-medium" style={{ color: 'var(--flit-text-primary)' }}>
            {archivo.name} · {tamanoMb(archivo.size)}
          </span>
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onQuitar}>
            Quitar el archivo
          </button>
        </div>
      )}
      {error && <p role="alert" className="text-xs" style={{ color: 'var(--flit-danger-ink)' }}>{error}</p>}
    </div>
  );
}

// ───────────────────────────── Foco al primer campo inválido ─────────────────────────────────────

/**
 * Lleva el foco al primer control inválido **tras un intento de envío o de consulta, y solo ahí**.
 *
 * Vive en un hook del PADRE y no en cada campo porque el orden lo decide la página. Y corre en un
 * `useEffect` del padre a propósito: los efectos de los hijos se vacían antes, así que si el primer
 * error fuera otro campo este gana sobre el `focus()` que `FlitSelect` se hace a sí mismo. Cuando el
 * primero ES el selector, `idPrimerError` viene `null` y se deja que el componente lo haga.
 *
 * ── Por qué el disparador es `intento` y NO el cambio de `idPrimerError` ─────────────────────────
 *
 * Porque los campos también se validan al SALIR de ellos. Reaccionando al id, tabular fuera de un
 * requerido vacío pintaba su error y el efecto devolvía el foco al campo que se acababa de dejar:
 * una **trampa de teclado** (WCAG 2.1.2) en el primer control del formulario —medido: desde «Placa»
 * vacía el tabulador no llegaba nunca a «Tipo de documento»—. El foco automático solo lo pide quien
 * pulsó un botón y no puede continuar; quien está tecleando decide él a dónde va.
 *
 * `intento` es un contador y no un booleano para que dos intentos seguidos con exactamente el mismo
 * error vuelvan a llevar el foco.
 */
export function useFocoPrimerError(idPrimerError: string | null, intento: number) {
  const atendido = useRef(intento);
  useEffect(() => {
    if (intento === atendido.current) return;
    atendido.current = intento;
    if (idPrimerError) document.getElementById(idPrimerError)?.focus();
  }, [idPrimerError, intento]);
}
