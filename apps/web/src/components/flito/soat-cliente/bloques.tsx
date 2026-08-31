// FLITO — canal Cliente: los bloques 2 y 3 del formulario de solicitud (HU #11914, AC1).
//
// ── Por qué cada bloque es una `<section>` con `<h2>` ────────────────────────────────────────────
//
// Es lo que permite saltar de bloque a bloque con un lector de pantalla, y lo que hace que «Se
// habilita cuando el RUNT responda» se lea DENTRO de su sección y no suelta en mitad de la página.
//
// ── Y por qué los bloques se pintan «en espera» en vez de esconderse o salir `disabled` ─────────
//
// Las dos alternativas son peores. Esconderlos deja al usuario sin saber qué le van a pedir —y la
// factura de venta hay que ir a buscarla, no está a mano—. Pintarlos `disabled` mete doce controles
// grises que no reciben foco y que parecen una pantalla rota, que es exactamente lo que el AC1 pide
// evitar en la ficha del RUNT y vale igual aquí.

import { useEffect, type ReactNode, type RefObject } from 'react';
import FlitSelect from '../../flit/FlitSelect';
import FlitUploadBox from '../../flit/FlitUploadBox';
import { flitInp, flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';
import { MAX_MB_FACTURA, OPCIONES_TIPO_DOC, tamanoMb } from '../../../lib/soatCliente';

// ───────────────────────────── Datos del bloque 2 ────────────────────────────────────────────────

export interface Propietario {
  tipoDocumento: string;
  numeroDocumento: string;
  nombreCompleto: string;
  correo: string;
  celular: string;
  direccion: string;
}

export type CampoPropietario = keyof Propietario;

export const PROPIETARIO_VACIO: Propietario = {
  tipoDocumento: '', numeroDocumento: '', nombreCompleto: '', correo: '', celular: '', direccion: '',
};

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
  nombreCompleto: 'sol-nombre-completo',
  correo: 'sol-correo',
  celular: 'sol-celular',
  direccion: 'sol-direccion',
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

/** La línea de espera de un bloque que todavía no se puede llenar. */
export function EnEspera() {
  return <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>Se habilita cuando el RUNT responda.</p>;
}

/**
 * Un campo de texto con etiqueta asociada, ayuda y error.
 *
 * `aria-invalid` se pone **solo mientras hay error** y se quita en cuanto el campo se corrige:
 * dejarlo puesto convierte la marca en ruido. El mensaje va en `role="alert"` porque impide
 * continuar; la ayuda y la marca de procedencia son texto normal enlazado por `aria-describedby`.
 */
export function Campo({ id, label, valor, onCambio, onBlur, error, ayuda, opcional, prellenado, maxLength, autoComplete, inputRef }: {
  id: string; label: string; valor: string; onCambio: (v: string) => void; onBlur?: () => void;
  error?: string; ayuda?: string; opcional?: boolean; prellenado?: boolean;
  maxLength?: number; autoComplete?: string;
  /** Para `restoreFocusRef` de los modales de bloqueo: hace falta el nodo, no su id. */
  inputRef?: RefObject<HTMLInputElement>;
}) {
  const idAyuda = `${id}-ayuda`;
  const idError = `${id}-error`;
  const describedBy = [ayuda || prellenado ? idAyuda : null, error ? idError : null].filter(Boolean).join(' ');
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
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        onChange={(e) => onCambio(e.target.value)}
        onBlur={onBlur}
      />
      {(ayuda || prellenado) && (
        <p id={idAyuda} className="mt-1 text-[11px]" style={{ color: 'var(--flit-text-secondary)' }}>
          {ayuda}{ayuda && prellenado ? ' · ' : ''}{prellenado ? 'Lo trajo el RUNT' : ''}
        </p>
      )}
      {error && (
        <p id={idError} role="alert" className="mt-1 text-xs" style={{ color: 'var(--flit-danger-ink)' }}>{error}</p>
      )}
    </div>
  );
}

// ───────────────────────────── Documento del propietario (bloque 1 del alta) ─────────────────────

/**
 * Tipo y número del catálogo RUNT. Mismos controles y mismo copy en dos sitios:
 *
 *   · **Alta, bloque 1** — ANTES de «Consultar el RUNT»: la pasarela exige el documento junto
 *     con la placa (Bug #11927).
 *   · **Subsanación, bloque 2** — se editan ahí porque en esa pantalla no hay preconsulta nueva.
 *
 * Extraído para no inventar un tercer widget ni duplicar el `FlitSelect` a mano.
 */
export function CamposDocumento({ valor, onCambio, errores, onBlur, prellenadoNumero }: {
  valor: Pick<Propietario, 'tipoDocumento' | 'numeroDocumento'>;
  onCambio: (campo: CampoPropietario, v: string) => void;
  errores: Partial<Record<CampoPropietario, string>>;
  onBlur: (campo: CampoPropietario) => void;
  prellenadoNumero?: boolean;
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
        error={errores.numeroDocumento} maxLength={30}
        prellenado={prellenadoNumero}
      />
    </div>
  );
}

// ───────────────────────────── Bloque 2 · Propietario ────────────────────────────────────────────

/**
 * El propietario **sí se edita** aunque el RUNT lo prellene, y el vehículo no. La frase que lo
 * explica: lo no editable es lo que decide QUÉ VEHÍCULO es y a qué organismo pertenece —lo que fija
 * el trámite y el precio—; lo editable es QUIÉN ES LA PERSONA, que es lo que va en la factura de
 * venta y lo que el RUNT puede tener desactualizado tras una compraventa reciente. Justo el caso en
 * el que este canal se usa.
 *
 * Este bloque **no tiene estado «cargando»**, y es correcto: se monta ya resuelto tras la
 * preconsulta y el catálogo de tipos de documento es estático. Tampoco tiene «error de carga», así
 * que el selector no lleva `onReintentar`: no habría nada que reintentar.
 *
 * En el **alta**, tipo y número ya se pidieron en el bloque 1: `omitirDocumento` evita montarlos
 * otra vez (serían el mismo `id` dos veces). En la **subsanación** sí van aquí: no hay preconsulta.
 */
export function BloquePropietario({ valor, onCambio, errores, onBlur, prellenados, omitirDocumento }: {
  valor: Propietario;
  onCambio: (campo: CampoPropietario, v: string) => void;
  errores: Partial<Record<CampoPropietario, string>>;
  onBlur: (campo: CampoPropietario) => void;
  /** Campos que llegaron del RUNT. Vacío es el caso NORMAL y no se avisa de nada. */
  prellenados: ReadonlySet<CampoPropietario>;
  /** Alta: el documento vive en el bloque 1. Subsanación: no pasar. */
  omitirDocumento?: boolean;
}) {
  return (
    <div className="space-y-3">
      {!omitirDocumento && (
        <CamposDocumento
          valor={valor} onCambio={onCambio} errores={errores} onBlur={onBlur}
          prellenadoNumero={prellenados.has('numeroDocumento')}
        />
      )}

      <Campo
        id={ID_CAMPO.nombreCompleto} label="Nombre completo o razón social" valor={valor.nombreCompleto}
        onCambio={(v) => onCambio('nombreCompleto', v)} onBlur={() => onBlur('nombreCompleto')}
        error={errores.nombreCompleto} ayuda="Como aparece en la factura de venta." maxLength={200}
        prellenado={prellenados.has('nombreCompleto')}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <Campo
          id={ID_CAMPO.correo} label="Correo electrónico" opcional valor={valor.correo}
          onCambio={(v) => onCambio('correo', v)} onBlur={() => onBlur('correo')}
          error={errores.correo} maxLength={150} autoComplete="off"
        />
        <Campo
          id={ID_CAMPO.celular} label="Teléfono" opcional valor={valor.celular}
          onCambio={(v) => onCambio('celular', v)} maxLength={30} autoComplete="off"
        />
      </div>

      <Campo
        id={ID_CAMPO.direccion} label="Dirección" opcional valor={valor.direccion}
        onCambio={(v) => onCambio('direccion', v)} maxLength={300} autoComplete="off"
      />

      {prellenados.size > 0 && (
        <p className="text-[11px]" style={{ color: 'var(--flit-text-secondary)' }}>
          Los datos que trajo el RUNT están marcados. Corríjalos si no coinciden con la factura de venta.
        </p>
      )}
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
 * Lleva el foco al primer control inválido tras un intento de envío.
 *
 * Vive en un hook del PADRE y no en cada campo porque el orden lo decide la página. Y corre en un
 * `useEffect` del padre a propósito: los efectos de los hijos se vacían antes, así que si el primer
 * error fuera otro campo este gana sobre el `focus()` que `FlitSelect` se hace a sí mismo. Cuando el
 * primero ES el selector, `idPrimerError` viene `null` y se deja que el componente lo haga.
 */
export function useFocoPrimerError(idPrimerError: string | null, intento: number) {
  useEffect(() => {
    // `intento` no se usa en el cuerpo y por eso está aquí: es lo que fuerza a repetir el foco
    // cuando se vuelve a pulsar Enviar con exactamente el mismo error.
    if (idPrimerError) document.getElementById(idPrimerError)?.focus();
  }, [idPrimerError, intento]);
}
