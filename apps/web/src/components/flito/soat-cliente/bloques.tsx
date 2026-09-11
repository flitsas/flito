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
import StatusChip from '../../flit/StatusChip';
import { flitInp, flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';
import {
  esNit, MAX_MB_FACTURA, OPCIONES_TIPO_DOC, tamanoMb,
  type CampoComprador, type DesenlaceLectura,
} from '../../../lib/soatCliente';

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

/** El texto que acompaña a un campo marcado de baja confianza (HU #12094, UX §4.1). */
const AYUDA_REVISION = 'Lo leímos de la factura y no quedamos seguros. Compruébelo y confírmelo.';

/**
 * La marca de baja confianza: chip + «Confirmar», calcada de `FlitoRevisiones` (172–193).
 *
 * Vive aquí y no en cada llamador porque la usan los dos controles del bloque 3 —los `Campo` y el
 * `FlitSelect` del tipo de documento—, y dos copias del mismo chip divergen en el primer retoque.
 *
 * **El nombre accesible del botón lleva la ETIQUETA del campo, jamás su valor** («Confirmar
 * municipio»): esta pantalla no mete PII en un `aria-label`, que es justo la superficie de la que
 * tiran los selectores de axe.
 */
export function MarcaRevision({ etiqueta, id, onConfirmar }: {
  etiqueta: string;
  /** Id ESTABLE del botón: es a donde va el foco cuando el campo pendiente no tiene input propio. */
  id: string;
  onConfirmar: () => void;
}) {
  return (
    <span className="flex items-center gap-2">
      <StatusChip tone="warning">⚠ Revise este dato</StatusChip>
      <button
        type="button" id={id} className={flitBtnSecondary} style={flitBtnSecondaryStyle}
        aria-label={`Confirmar ${etiqueta.toLowerCase()}`} onClick={onConfirmar}
      >
        Confirmar
      </button>
    </span>
  );
}

/**
 * Un campo de texto con etiqueta asociada, ayuda y error.
 *
 * `aria-invalid` se pone **solo mientras hay error** y se quita en cuanto el campo se corrige:
 * dejarlo puesto convierte la marca en ruido. El mensaje va en `role="alert"` porque impide
 * continuar; la ayuda y la marca de procedencia son texto normal enlazado por `aria-describedby`.
 *
 * ── Un campo PRELLENADO por la factura se ve EXACTAMENTE igual que uno tecleado ─────────────────
 *
 * Sin fondo gris, sin candado, sin `readOnly`, sin borde de color y sin etiqueta «de la factura»
 * (HU #12094, AC2 y UX §2): todo lo que distinga visualmente ese input de sus vecinos se lee como
 * «no lo toque», y el AC pide justo lo contrario. Lo único que se marca es lo que **pide una
 * acción**: el campo de baja confianza (`porRevisar`).
 */
export function Campo({
  id, label, valor, onCambio, onBlur, error, ayuda, opcional,
  maxLength, autoComplete, inputRef, readOnly, invalido, describedByExtra,
  porRevisar, idConfirmar, onConfirmar,
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
  /**
   * Id de un texto de FUERA que describe al campo. Se suma al `aria-describedby` **siempre que se
   * pase**, y ese desacople es de la HU #12094: hasta ahora solo se enlazaba con `invalido`, y el
   * campo de baja confianza necesita describirse sin marcarse inválido —no es un error, es un dato
   * correcto que quizá no lo sea (UX §4.2)—. Quien quiera el comportamiento de antes pasa el id de
   * forma condicionada, que es lo que hace el VIN con la banda del RUNT.
   */
  describedByExtra?: string;
  /**
   * Baja confianza (AC3): chip «⚠ Revise este dato», botón «Confirmar» y una línea que lo explica.
   *
   * **No pone `aria-invalid`.** El aviso llega por `aria-describedby`; marcar el control como
   * inválido diría que el valor está mal, y lo que pasa es que no se sabe.
   */
  porRevisar?: boolean;
  /** Id estable del botón «Confirmar». Solo se usa con `porRevisar`. */
  idConfirmar?: string;
  onConfirmar?: () => void;
}) {
  const idAyuda = `${id}-ayuda`;
  const idError = `${id}-error`;
  const idRevision = `${id}-revision`;
  const describedBy = [
    ayuda ? idAyuda : null,
    error ? idError : null,
    porRevisar ? idRevision : null,
    describedByExtra ?? null,
  ].filter(Boolean).join(' ');
  const etiqueta = (
    <label htmlFor={id} className="block text-[11px] font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
      {label}{opcional ? ' (opcional)' : ' *'}
    </label>
  );
  return (
    <div>
      {porRevisar && onConfirmar
        ? (
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            {etiqueta}
            <MarcaRevision etiqueta={label} id={idConfirmar ?? `${id}-confirmar`} onConfirmar={onConfirmar} />
          </div>
        )
        : <div className="mb-1">{etiqueta}</div>}
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
      {porRevisar && (
        <p id={idRevision} className="mt-1 text-[11px]" style={{ color: 'var(--flit-text-secondary)' }}>
          {AYUDA_REVISION}
        </p>
      )}
      {error && (
        <p id={idError} role="alert" className="mt-1 text-xs" style={{ color: 'var(--flit-danger-ink)' }}>{error}</p>
      )}
    </div>
  );
}

/**
 * Lo que el bloque 3 necesita saber de la lectura: **qué campos están por revisar y cómo se
 * confirman**. Un solo objeto y no dos props sueltas por campo: son nueve controles.
 *
 * `porRevisar` lo decide la página con UNA regla (`valor !== null` **y** `confiable === false`) y
 * esta capa no la reinterpreta: aquí solo se pinta.
 */
export interface Revision {
  porRevisar: Partial<Record<CampoComprador, boolean>>;
  onConfirmar: (campo: CampoComprador) => void;
}

/**
 * Ids ESTABLES de los botones «Confirmar», por el mismo motivo que `ID_CAMPO`: al pulsar el primario
 * bloqueado el foco va al primer campo pendiente, y el tipo de documento no tiene input propio al que
 * llevarlo —`FlitSelect` genera su id con `useId()`—. Su botón sí.
 */
export const ID_CONFIRMAR: Record<CampoComprador, string> = {
  nombres: 'sol-confirmar-nombres',
  apellidos: 'sol-confirmar-apellidos',
  razonSocial: 'sol-confirmar-razon-social',
  tipoDocumento: 'sol-confirmar-tipo-documento',
  numeroDocumento: 'sol-confirmar-numero-documento',
  direccion: 'sol-confirmar-direccion',
  municipio: 'sol-confirmar-municipio',
  departamento: 'sol-confirmar-departamento',
  celular: 'sol-confirmar-celular',
};

/** Las tres props de revisión de un `Campo`, para no repetirlas nueve veces. */
function marcaDe(revision: Revision | undefined, campo: CampoComprador) {
  return {
    porRevisar: revision?.porRevisar[campo] === true,
    idConfirmar: ID_CONFIRMAR[campo],
    onConfirmar: () => revision?.onConfirmar(campo),
  };
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
export function CamposDocumento({ valor, onCambio, errores, onBlur, revision }: {
  valor: Pick<Propietario, 'tipoDocumento' | 'numeroDocumento'>;
  onCambio: (campo: CampoPropietario, v: string) => void;
  errores: Partial<Record<CampoPropietario, string>>;
  onBlur: (campo: CampoPropietario) => void;
  revision?: Revision;
}) {
  const tipoPorRevisar = revision?.porRevisar.tipoDocumento === true;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {/* Tipo y número son EDITABLES vengan de donde vengan (AC2), y por eso el selector no cambia
          de forma al prellenarse: solo puede ganar la marca de baja confianza. Su descripción va por
          `ayuda`, que es lo que el `aria-describedby` del `<select>` ya enlaza. */}
      <FlitSelect
        label="Tipo de documento"
        value={valor.tipoDocumento}
        opciones={OPCIONES_TIPO_DOC}
        onChange={(v) => onCambio('tipoDocumento', v)}
        ayuda={tipoPorRevisar ? AYUDA_REVISION : 'Como aparece en el documento del propietario.'}
        error={errores.tipoDocumento ?? null}
        required
        accesorio={tipoPorRevisar && revision
          ? (
            <MarcaRevision
              etiqueta="Tipo de documento" id={ID_CONFIRMAR.tipoDocumento}
              onConfirmar={() => revision.onConfirmar('tipoDocumento')}
            />
          )
          : undefined}
      />
      <Campo
        id={ID_CAMPO.numeroDocumento} label="Número de documento" valor={valor.numeroDocumento}
        onCambio={(v) => onCambio('numeroDocumento', v)} onBlur={() => onBlur('numeroDocumento')}
        error={errores.numeroDocumento} maxLength={30} autoComplete="off"
        {...marcaDe(revision, 'numeroDocumento')}
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
export function BloquePropietario({ valor, onCambio, errores, onBlur, referenciaRunt, revision, prellenado }: {
  valor: Propietario;
  onCambio: (campo: CampoPropietario, v: string) => void;
  errores: Partial<Record<CampoPropietario, string>>;
  onBlur: (campo: CampoPropietario) => void;
  /** Qué campos quedaron por revisar tras la lectura y cómo se confirman (HU #12094, AC3). */
  revision?: Revision;
  /**
   * La lectura escribió algo aquí: cambia **la línea de encabezado y nada más** (UX §3.4).
   *
   * Lo que dice de dónde salieron los valores es el CONTEXTO —esta línea y el chip del bloque 2—, no
   * cada campo. Y la última frase no es relleno: tras una lectura perfecta el correo es el único
   * campo vacío entre nueve llenos, y sin decirlo se lee como un fallo de la lectura.
   */
  prellenado?: boolean;
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
      {/* El vacío útil del bloque: qué se escribe aquí y para qué sirve. Con la factura leída, el
          verbo cambia de «escribir» a «revisar» (HU #12094). */}
      <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
        {prellenado
          ? 'Estos datos los tomamos de su factura de venta. Revíselos y corrija lo que no cuadre: son los que van en la póliza. El correo electrónico sí lo tiene que escribir usted.'
          : 'Escriba el propietario como aparece en la factura de venta: son los datos que van en la póliza.'}
      </p>

      <CamposDocumento valor={valor} onCambio={onCambio} errores={errores} onBlur={onBlur} revision={revision} />

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
            maxLength={200} {...marcaDe(revision, 'razonSocial')}
          />
        )
        : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Campo
              id={ID_CAMPO.nombres} label="Nombre/s" valor={valor.nombres}
              onCambio={(v) => onCambio('nombres', v)} onBlur={() => onBlur('nombres')}
              error={errores.nombres} ayuda="Como aparecen en el documento del propietario."
              maxLength={200} {...marcaDe(revision, 'nombres')}
            />
            <Campo
              id={ID_CAMPO.apellidos} label="Apellido/s" valor={valor.apellidos}
              onCambio={(v) => onCambio('apellidos', v)} onBlur={() => onBlur('apellidos')}
              error={errores.apellidos} maxLength={200} {...marcaDe(revision, 'apellidos')}
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
          {...marcaDe(revision, 'celular')}
        />
      </div>

      <Campo
        id={ID_CAMPO.direccion} label="Dirección" valor={valor.direccion}
        onCambio={(v) => onCambio('direccion', v)} onBlur={() => onBlur('direccion')}
        error={errores.direccion} maxLength={300} autoComplete="off"
        {...marcaDe(revision, 'direccion')}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <Campo
          id={ID_CAMPO.municipio} label="Municipio" valor={valor.municipio}
          onCambio={(v) => onCambio('municipio', v)} onBlur={() => onBlur('municipio')}
          error={errores.municipio} ayuda="Donde vive el propietario. No es el del organismo de tránsito."
          maxLength={100} autoComplete="off" {...marcaDe(revision, 'municipio')}
        />
        <Campo
          id={ID_CAMPO.departamento} label="Departamento" valor={valor.departamento}
          onCambio={(v) => onCambio('departamento', v)} onBlur={() => onBlur('departamento')}
          error={errores.departamento} maxLength={100} autoComplete="off"
          {...marcaDe(revision, 'departamento')}
        />
      </div>
    </div>
  );
}

// ───────────────────────────── Bloque 2 · Factura de venta ───────────────────────────────────────

/**
 * El bloque es una `<Seccion>` propia y va DELANTE del propietario (HU #12091, AC2): es el orden en
 * el que el trabajo se hace de verdad —primero se sube el papel, después se copia lo que dice— y es
 * el que la HU #12094 usa para leerlo por OCR y precargar el propietario sin reordenar la pantalla.
 *
 * **La lectura NO se pinta aquí**: sus cuatro estados y la banda de sobrescritura son `AvisoLectura`
 * y `BandaSobrescritura`, que la página monta justo debajo, dentro de la misma `<Seccion>`. Este
 * componente sigue siendo el archivo y nada más — su estado (`idle | verified | rejected`) lo decide
 * el ARCHIVO, no lo que el lector haya sacado de él.
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
      {/* Ya se puede prometer: la #12091 lo prohibía porque entonces habría sido mentira. Explica por
          qué el bloque 2 va delante del 3. */}
      {!archivo && !rotulo && (
        <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          Al adjuntarla, FLITO la lee y llena los datos del propietario. Usted los revisa y corrige lo
          que no cuadre.
        </p>
      )}
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

// ───────────────────────────── Bloque 2 · La lectura de la factura (HU #12094) ───────────────────

/**
 * En qué punto está la LECTURA de la factura — que no es lo mismo que el estado del archivo.
 *
 * El archivo ya tenía los suyos en `FlitUploadBox` (`idle | uploading | verified | rejected`) y no se
 * tocan. Estos cuatro son de lo que el OCR devolvió:
 *
 *   · `leyendo` — arranca sola al adjuntar (AC1) y **nada se deshabilita** mientras dura.
 *   · `ok`      — se escribieron `escritos` datos del propietario. `escritos` puede ser 0 si todos
 *                 los leídos chocaron con lo que el Cliente ya había escrito: entonces habla la
 *                 banda de sobrescritura y esta línea se calla.
 *   · `vacia`   — la factura se leyó y no salió ningún dato del propietario. **No es un fallo** (va
 *                 en `role="status"`, no en `alert`) y el envío sigue su curso normal (AC5).
 *   · `fallo`   — el lector no respondió. Con reintento, y sin añadir un solo pendiente al envío.
 */
export type EstadoLectura =
  | { fase: 'inicial' }
  | { fase: 'leyendo' }
  | { fase: 'ok'; escritos: number }
  | { fase: 'vacia' }
  | { fase: 'fallo'; desenlace: DesenlaceLectura };

/** «Tomamos 1 dato … y lo escribimos abajo» / «Tomamos 4 datos … y los escribimos abajo». */
function fraseDatosLeidos(n: number): string {
  return n === 1
    ? 'Tomamos 1 dato del propietario de esta factura y lo escribimos abajo. Revíselo antes de enviar.'
    : `Tomamos ${n} datos del propietario de esta factura y los escribimos abajo. Revíselos antes de enviar.`;
}

/**
 * Lo que la lectura dice de sí misma, dentro del bloque 2 y **debajo de la caja del archivo**.
 *
 * Los tres avisos que no son fallo van en `role="status"` y el fallo en `role="alert"` (AC1). Ninguno
 * mueve el foco: la lectura puede tardar un minuto y el Cliente puede estar escribiendo en el
 * bloque 3.
 *
 * `⟳` es un carácter del texto, **no una animación**: cero spinners, cero barras de progreso.
 */
export function AvisoLectura({ lectura, onVolverALeer }: {
  lectura: EstadoLectura;
  /** `undefined` mientras no haya archivo adjunto: no hay nada que volver a leer. */
  onVolverALeer?: () => void;
}) {
  if (lectura.fase === 'inicial') return null;

  if (lectura.fase === 'leyendo') {
    return (
      <p role="status" className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
        ⟳ Leyendo la factura… Puede tardar hasta un minuto. Mientras tanto puede seguir llenando el
        formulario.
      </p>
    );
  }

  if (lectura.fase === 'fallo') {
    return (
      <div
        role="alert" className="space-y-1 rounded-[10px] p-3"
        style={{ border: '1px solid var(--flit-border-soft)', background: 'var(--flit-bg-app)' }}
      >
        <p className="text-sm font-semibold" style={{ color: 'var(--flit-warning-ink)' }}>
          {lectura.desenlace.titulo}
        </p>
        <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{lectura.desenlace.detalle}</p>
        {onVolverALeer && (
          <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onVolverALeer}>
            Volver a leer la factura
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p role="status" className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
        {lectura.fase === 'vacia'
          // No miente y no alarma: la factura se leyó, lo que no salió son los datos.
          ? 'No pudimos sacar los datos del propietario de esta factura. Escríbalos a mano: la solicitud se puede enviar igual.'
          : lectura.escritos > 0 ? fraseDatosLeidos(lectura.escritos) : ''}
      </p>
      {onVolverALeer && (
        <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onVolverALeer}>
          Volver a leer
        </button>
      )}
    </div>
  );
}

/** Una fila de la banda de sobrescritura: el campo, lo que hay escrito y lo que dice la factura. */
export interface FilaSobrescritura {
  campo: CampoComprador;
  /** La ETIQUETA visible del campo. Nunca su valor: es lo que nombra la fila y su casilla. */
  etiqueta: string;
  actual: string;
  leido: string;
}

/**
 * El aviso de sobrescritura (AC6): **una banda con casillas, no un modal**.
 *
 * Un modal taparía el bloque 3, que es donde están los datos sobre los que se decide, y convertiría
 * una elección reversible en una interrupción a pantalla completa. Y una banda sin detalle («se van a
 * sobrescribir 3 datos, ¿acepta?») incumple el AC, que pide **qué campos**.
 *
 * Los valores SÍ se pintan aquí —son los datos del propio usuario, en su propia pantalla, y sin ellos
 * la decisión es a ciegas—; lo que no ocurre nunca es que salgan de ahí hacia una URL, un
 * `aria-label` o un chip.
 *
 * **Las casillas nacen marcadas**: el gesto que abrió la banda fue cambiar la factura, y su intención
 * es «lea esta otra». Desmarcar es la excepción. **La banda no roba el foco** (UX §5): va en
 * `role="status"` y justo después de la caja del archivo, que es donde el tabulador la encuentra.
 */
export function BandaSobrescritura({ filas, marcados, onAlternar, onReemplazar, onConservar }: {
  filas: FilaSobrescritura[];
  marcados: Partial<Record<CampoComprador, boolean>>;
  onAlternar: (campo: CampoComprador) => void;
  onReemplazar: () => void;
  onConservar: () => void;
}) {
  const n = filas.filter((f) => marcados[f.campo]).length;
  const rotulo = n === 0 ? 'Reemplazar lo marcado' : n === 1 ? 'Reemplazar 1 dato' : `Reemplazar ${n} datos`;
  return (
    <div
      role="status" className="space-y-2 rounded-[10px] p-3"
      style={{ border: '1px solid var(--flit-border-soft)', background: 'var(--flit-bg-app)' }}
    >
      <p className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
        {filas.length === 1
          ? 'Esta factura dice otra cosa en 1 dato que usted escribió.'
          : `Esta factura dice otra cosa en ${filas.length} datos que usted escribió.`}
      </p>
      <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
        Marque los que quiere reemplazar. Lo que deje sin marcar se queda como está.
      </p>
      <div className="text-xs">
        <div
          className="grid grid-cols-[minmax(9rem,1fr)_1fr_1fr] gap-2 border-b pb-1 font-semibold"
          style={{ color: 'var(--flit-text-muted)', borderColor: 'var(--flit-border-soft)' }}
        >
          <span>Campo</span><span>Usted escribió</span><span>La factura dice</span>
        </div>
        {filas.map((f) => (
          <div key={f.campo} className="grid grid-cols-[minmax(9rem,1fr)_1fr_1fr] items-center gap-2 py-1">
            <label className="flex items-center gap-2" style={{ color: 'var(--flit-text-primary)' }}>
              <input
                type="checkbox" className="flit-focus h-4 w-4"
                checked={marcados[f.campo] === true}
                onChange={() => onAlternar(f.campo)}
              />
              {f.etiqueta}
            </label>
            <span style={{ color: 'var(--flit-text-secondary)' }}>{f.actual}</span>
            <span style={{ color: 'var(--flit-text-primary)' }}>{f.leido}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onReemplazar}>
          {rotulo}
        </button>
        <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle} onClick={onConservar}>
          Conservar lo que escribí
        </button>
      </div>
    </div>
  );
}
