// FLITO — canal Cliente: los bloques del formulario de solicitud (HU #11914, #11936, #11967).
//
// ── Por qué cada bloque es una `<section>` con `<h2>` ────────────────────────────────────────────
//
// Es lo que permite saltar de bloque a bloque con un lector de pantalla. Los tres bloques montan
// sus controles desde el primer paint: la compuerta de la HU #11967 es del ENVÍO, no del tecleo, y
// doce controles grises que no reciben foco es lo que la #11936 quitó con razón.

import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import FlitSelect from '../../flit/FlitSelect';
import FlitUploadBox from '../../flit/FlitUploadBox';
import { flitInp, flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';
import { esNit, etiquetaTipoDoc, MAX_MB_FACTURA, OPCIONES_TIPO_DOC, tamanoMb } from '../../../lib/soatCliente';

// ───────────────────────────── Datos del bloque 2 ────────────────────────────────────────────────

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
 */
export const ID_CAMPO = {
  placa: 'sol-placa',
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
  id, label, valor, onCambio, onBlur, error, ayuda, opcional, textoOpcional,
  maxLength, autoComplete, inputRef, readOnly, invalido, describedByExtra,
}: {
  id: string; label: string; valor: string; onCambio: (v: string) => void; onBlur?: () => void;
  error?: string; ayuda?: string; opcional?: boolean;
  /**
   * Cómo se rotula «opcional» cuando el rótulo ya lleva paréntesis —«VIN (número de chasis)»—, que
   * con el sufijo de serie quedaría «(número de chasis) (opcional)». Mismo mecanismo, otro signo.
   */
  textoOpcional?: string;
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
   * fuera (el `422 runt_no_cuadra` con `campo: 'vin'`). Repetir el texto bajo el campo sería decir
   * dos veces lo mismo; no marcarlo dejaría al lector de pantalla sin saber cuál es el campo.
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
        {label}{opcional ? ` ${textoOpcional ?? '(opcional)'}` : ' *'}
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

// ───────────────────────────── Documento del propietario (bloque 2) ──────────────────────────────

/**
 * Tipo y número del catálogo RUNT. **Los usan las DOS pantallas, en sitios distintos** (HU #11967):
 * el alta los monta en el bloque 1, porque son entrada de la consulta al RUNT, y la subsanación en
 * el bloque 2 junto al resto del propietario, porque allí no hay consulta que alimentar.
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

// ───────────────────────────── Bloque 2 · Propietario ────────────────────────────────────────────

/**
 * El propietario **sí se edita**. El vehículo (placa/VIN) no, en la subsanación: cambiarlos sería
 * un alta encubierta sobre otro vehículo.
 *
 * Este bloque **no tiene estado «cargando»**: el catálogo de tipos de documento es estático y la
 * partición NIT/natural es local. Nadie debe inventarle un `onReintentar` que no reintentaría nada.
 *
 * ── Dónde vive el documento, que no es lo mismo en las dos pantallas (HU #11967) ────────────────
 *
 * En el **alta**, tipo y número son entrada de la consulta al RUNT y viven en el bloque 1: aquí solo
 * se ENSEÑAN, en una línea de texto que dice dónde se cambian (`documento.modo === 'eco'`). Dos
 * controles para el mismo dato es la forma más barata de radicar una solicitud consultada con un
 * documento y enviada con otro.
 *
 * En la **subsanación** no hay consulta, así que los dos vuelven a ser controles editables y
 * cambiarlos no invalida nada (`documento.modo === 'editable'`).
 */
export function BloquePropietario({ valor, onCambio, errores, onBlur, documento, referenciaRunt }: {
  valor: Propietario;
  onCambio: (campo: CampoPropietario, v: string) => void;
  errores: Partial<Record<CampoPropietario, string>>;
  onBlur: (campo: CampoPropietario) => void;
  documento: { modo: 'eco'; dondeSeCambia: string } | { modo: 'editable' };
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
      {documento.modo === 'editable'
        ? <CamposDocumento valor={valor} onCambio={onCambio} errores={errores} onBlur={onBlur} />
        : (
          <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
            <span style={{ color: 'var(--flit-text-primary)' }}>
              Documento: {valor.tipoDocumento ? `${etiquetaTipoDoc(valor.tipoDocumento)} ${valor.numeroDocumento}`.trim() : 'todavía sin elegir'}
            </span>
            {' · '}{documento.dondeSeCambia}
          </p>
        )}

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

// ───────────────────────────── Bloque 3 · Factura de venta ───────────────────────────────────────

/**
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
