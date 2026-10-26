import type { ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import {
  AREAS_SOPORTE, ETIQUETAS_AREA_SOPORTE, ETIQUETAS_FRECUENCIA_SOPORTE, ETIQUETAS_PRIORIDAD_SOPORTE,
  FRECUENCIAS_SOPORTE, PRIORIDADES_SOPORTE,
} from '@operaciones/shared-types';
import FlitSelect from '../flit/FlitSelect';
import { FlitPillGroup, flitInp, flitPillBtn, flitPillBtnClase } from '../flit/flitPageKit';
import { editarCampo, type BorradorSoporte } from '../../lib/drFlitSoporte';
import {
  CONTADOR_DESDE, MAXIMOS, errorMostrado, type CampoSoporte, type CamposSoporte,
} from '../../lib/drFlitSoporteModelo';

// Dr. Flit — campos de los pasos «Contacto» y «Caso» del asistente de soporte (HU #13806; anexo UX
// F5.4 D/E, F5.7, F5.12–F5.14). Labels con la clase del rótulo de `FlitField` (no admite `htmlFor` ni
// `aria-describedby`), inputs con `flitInp` a 16 px en <lg (sin zoom de iOS), `aria-invalid` +
// `aria-describedby` (error primero, luego ayuda y contador). Errores en `--flit-danger-text` (el `-ink` no
// tiene par oscuro: ~2,5:1 sobre la tarjeta oscura, ver flit-tokens.css). Sin `role="alert"` por campo: el foco va
// al primer campo con error y el lector lee su descripción.

/** Id del control de un campo: el asistente enfoca el primer error por aquí. */
export const idCampoSoporte = (campo: CampoSoporte) => `drflit-soporte-${campo}`;

const ROTULO = 'mb-1 block text-[11px] font-semibold text-[color:var(--flit-text-primary)]';
const AYUDA = 'mt-1 break-words text-xs text-flit-secondary';
/** `flitInp` con 16 px por debajo de lg (como la caja de pregunta) y sin desbordar el panel. */
const INPUT = `${flitInp.replace('text-sm', 'text-base lg:text-sm')} min-w-0`;
const BORDE_ERROR = { borderColor: 'var(--flit-danger-text)' } as const;

function ErrorCampo({ id, texto }: { id: string; texto: string }) {
  return (
    <p id={id} className="mt-1 flex items-start gap-1 break-words text-xs text-[color:var(--flit-danger-text)]">
      <AlertCircle aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0">{texto}</span>
    </p>
  );
}

interface PropsCampo {
  b: BorradorSoporte;
  /** Los errores del paso se ven solo tras el primer «Siguiente» (nunca al salir de un campo). */
  mostrar: boolean;
}

function errorVisible(campo: CampoSoporte, { b, mostrar }: PropsCampo): string | null {
  return mostrar ? errorMostrado(campo, b.campos, b.rechazados) : null;
}

type CampoTextoNombre = 'nombre' | 'correo' | 'telefono' | 'titulo' | 'detalle' | 'resultadoEsperado';

function CampoTexto({
  campo, label, ayuda, filas, type = 'text', autoComplete, inputMode, ...p
}: PropsCampo & {
  campo: CampoTextoNombre;
  label: string;
  ayuda?: string;
  /** Con filas es un `textarea` (`resize-y`). */
  filas?: number;
  type?: 'text' | 'email' | 'tel';
  autoComplete?: string;
  inputMode?: 'text' | 'email' | 'tel';
}) {
  const id = idCampoSoporte(campo);
  const valor = p.b.campos[campo];
  const error = errorVisible(campo, p);
  const max = MAXIMOS[campo];
  const desde = CONTADOR_DESDE[campo];
  const conContador = max !== undefined && desde !== undefined && valor.length >= desde;
  const describe = [error && `${id}-error`, ayuda && `${id}-ayuda`, conContador && `${id}-contador`]
    .filter(Boolean).join(' ') || undefined;
  const comun = {
    id,
    value: valor,
    maxLength: max,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describe,
    style: error ? BORDE_ERROR : undefined,
  } as const;
  return (
    <div className="min-w-0">
      <label htmlFor={id} className={ROTULO}>{label}</label>
      {filas ? (
        <textarea
          {...comun}
          rows={filas}
          onChange={(e) => editarCampo(campo, e.target.value)}
          className={`${INPUT} resize-y`}
        />
      ) : (
        <input
          {...comun}
          type={type}
          autoComplete={autoComplete}
          inputMode={inputMode}
          onChange={(e) => editarCampo(campo, e.target.value)}
          className={INPUT}
        />
      )}
      {error && <ErrorCampo id={`${id}-error`} texto={error} />}
      {ayuda && <p id={`${id}-ayuda`} className={AYUDA}>{ayuda}</p>}
      {conContador && (
        <p id={`${id}-contador`} aria-live="polite" className="mt-1 text-xs text-flit-secondary">
          {valor.length >= max ? `Llegó al máximo de ${max} caracteres.` : `${valor.length}/${max}`}
        </p>
      )}
    </div>
  );
}

/** Radios nativos con cara de pill (F5.13): el input va `sr-only` y el anillo se pinta en el label. */
function GrupoRadios<K extends 'frecuencia' | 'prioridad'>({
  campo, legend, ayuda, opciones, ...p
}: PropsCampo & {
  campo: K;
  legend: string;
  ayuda?: string;
  opciones: readonly { valor: CamposSoporte[K]; etiqueta: string }[];
}) {
  const id = idCampoSoporte(campo);
  const error = errorVisible(campo, p);
  const describe = [error && `${id}-error`, ayuda && `${id}-ayuda`].filter(Boolean).join(' ') || undefined;
  return (
    <fieldset className="min-w-0">
      <legend className={ROTULO}>{legend}</legend>
      {ayuda && <p id={`${id}-ayuda`} className={`${AYUDA} mb-2 mt-0`}>{ayuda}</p>}
      <FlitPillGroup>
        {opciones.map((o, i) => {
          const marcada = p.b.campos[campo] === o.valor;
          return (
            <label
              key={o.valor}
              className={`${flitPillBtnClase} cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[color:var(--flit-border-focus)]`}
              // `capitalize` del kit cambiaría «A veces» por «A Veces»: el copy va tal cual.
              style={{ ...flitPillBtn(marcada), textTransform: 'none' }}
            >
              <input
                id={i === 0 ? id : undefined}
                type="radio"
                name={id}
                value={o.valor}
                checked={marcada}
                onChange={() => editarCampo(campo, o.valor)}
                aria-invalid={error ? true : undefined}
                aria-describedby={describe}
                className="sr-only"
              />
              {o.etiqueta}
            </label>
          );
        })}
      </FlitPillGroup>
      {error && <ErrorCampo id={`${id}-error`} texto={error} />}
    </fieldset>
  );
}

function Pila({ children }: { children: ReactNode }) {
  return <div className="mt-4 flex min-w-0 flex-col gap-4">{children}</div>;
}

export function PasoContacto(p: PropsCampo) {
  return (
    <Pila>
      <CampoTexto {...p} campo="nombre" label="Nombre" autoComplete="name" />
      <CampoTexto {...p} campo="correo" label="Correo" type="email" inputMode="email" autoComplete="email" />
      <CampoTexto
        {...p}
        campo="telefono"
        label="Teléfono (opcional)"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        ayuda="Soporte lo usará solo si necesita llamarle por este caso."
      />
    </Pila>
  );
}

const OPCIONES_AREA = [
  { valor: '', etiqueta: 'Elija un área' },
  ...AREAS_SOPORTE.map((a) => ({ valor: a, etiqueta: ETIQUETAS_AREA_SOPORTE[a] })),
];
const OPCIONES_FRECUENCIA = FRECUENCIAS_SOPORTE.map((f) => ({ valor: f, etiqueta: ETIQUETAS_FRECUENCIA_SOPORTE[f] }));
const OPCIONES_PRIORIDAD = PRIORIDADES_SOPORTE.map((v) => ({ valor: v, etiqueta: ETIQUETAS_PRIORIDAD_SOPORTE[v] }));

export function PasoCaso(p: PropsCampo) {
  const errorArea = errorVisible('area', p);
  return (
    <Pila>
      {/* `FlitSelect` no admite clase: el 16 px en <lg y el borde de error llegan por el contenedor. */}
      <div
        id={`${idCampoSoporte('area')}-caja`}
        className={`min-w-0 max-lg:[&_select]:text-base ${errorArea ? '[&_select]:border-[color:var(--flit-danger-text)]' : ''}`}
      >
        <FlitSelect
          label="Área"
          value={p.b.campos.area}
          opciones={OPCIONES_AREA}
          onChange={(v) => editarCampo('area', v as CamposSoporte['area'])}
          error={errorArea ?? undefined}
        />
      </div>
      <CampoTexto {...p} campo="titulo" label="Título" />
      <CampoTexto {...p} campo="detalle" label="Detalle" filas={4} ayuda="Qué hacía, en qué pantalla y qué pasó." />
      <CampoTexto {...p} campo="resultadoEsperado" label="Resultado esperado" filas={3} />
      <GrupoRadios {...p} campo="frecuencia" legend="Frecuencia" opciones={OPCIONES_FRECUENCIA} />
      <GrupoRadios
        {...p}
        campo="prioridad"
        legend="Prioridad"
        ayuda="Alta si le impide trabajar."
        opciones={OPCIONES_PRIORIDAD}
      />
    </Pila>
  );
}
