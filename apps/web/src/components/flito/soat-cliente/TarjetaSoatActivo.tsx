// FLITO — canal Cliente del SOAT: la tarjeta «SOAT activo» del bloque 1 (HU #12844, Feature #12840).
//
// Sustituye al modal `ModalSoatVigente` y a la caja del aviso de la HU #12213: las dos situaciones
// son ESTADOS que siguen siendo ciertos mientras el VIN no cambie, así que van en la página y no en
// una superposición que se cierra (docs/ux/soat-cliente-tarjeta-soat-activo.md, decisión 1).
//
// | Variante | Cuándo                                   | Título / icono / chip                                  |
// |----------|------------------------------------------|--------------------------------------------------------|
// | bloqueo  | `409 soat_vigente` con `soatActivo`      | «ya tiene» · ShieldCheck · success «No hace falta…»    |
// | aviso    | `200` con `vigenciaProxima`              | «todavía tiene» · CalendarClock · active «Puede…»      |
//
// | renovar  | Renovación, vehículo YA en FLITO (#14019)| «Ya está en FLITO · quedan N días» · «Renovar»        |
//
// Las variantes se distinguen por título, icono y texto del chip (AC3), no solo por el tono.
//
// **La póliza y la aseguradora se pintan AQUÍ y en ningún otro sitio** (RN-05 del Feature #12840):
// ni en un `aria-label`, ni en la URL, ni en la consola, ni en un toast. El nombre accesible de la
// sección sale del `h3`, que no interpola ningún dato.

import { useId, type Ref } from 'react';
import { CalendarClock, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { SoatActivoRunt, SoatFlitoContexto } from '@operaciones/shared-types';
import StatusChip from '../../flit/StatusChip';
import {
  flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../../flit/flitPageKit';
import { copyRenovar } from '../../../lib/mensajesTipoSoat';
import {
  AVISO_VIGENCIA_CHIP, avisoVigenciaProxima, fechaLargaOGuion, fraseBloqueoVigente,
} from '../../../lib/soatCliente';
import { Dato, dato } from './FichaRunt';

const VARIANTE = {
  bloqueo: {
    titulo: 'Este vehículo ya tiene SOAT activo',
    chip: 'No hace falta comprar otro',
    tono: 'success' as const,
    Icono: ShieldCheck,
    insignia: { background: 'var(--flit-chip-success-bg)', color: 'var(--flit-success-ink)' },
  },
  aviso: {
    titulo: 'Este vehículo todavía tiene SOAT activo',
    chip: AVISO_VIGENCIA_CHIP,
    tono: 'active' as const,
    Icono: CalendarClock,
    insignia: { background: 'var(--flit-chip-active-bg)', color: 'var(--flit-blue-ink)' },
  },
};

interface PropsRunt {
  variante: 'bloqueo' | 'aviso';
  datos: SoatActivoRunt;
  /** Aviso: el `venceEl` del 200. Bloqueo: el `fechaVencimiento` del 409, si vino. */
  venceEl?: string | null;
  /** Solo en el bloqueo: limpia el VIN y devuelve el foco al campo (AC1). */
  onConsultarOtro?: () => void;
  /** Solo en el bloqueo: la página lleva el foco al `h3` al montarse. */
  tituloRef?: Ref<HTMLHeadingElement>;
  /** Para la cuenta de días; inyectable para probar. */
  hoy?: Date;
}

interface PropsRenovar {
  variante: 'renovar';
  /** El contexto «ya en FLITO» de la preconsulta: días y fecha; no hay póliza ni aseguradora (UX P8). */
  flito: SoatFlitoContexto;
  /** Continúa el flujo en la misma pantalla (no consulta de nuevo). Solo si el contexto es renovable. */
  onRenovar?: () => void;
  onConsultarOtro: () => void;
  tituloRef?: Ref<HTMLHeadingElement>;
}

export default function TarjetaSoatActivo(props: PropsRunt | PropsRenovar) {
  return props.variante === 'renovar' ? <TarjetaRenovar {...props} /> : <TarjetaRunt {...props} />;
}

/** Renovable (vigente 0–30 días o vencido) con «Renovar»; fuera de ventana, la misma tarjeta SIN botón. */
function TarjetaRenovar({ flito, onRenovar, onConsultarOtro, tituloRef }: PropsRenovar) {
  const idTitulo = useId();
  const c = copyRenovar(flito);
  const vencido = c.tono === 'warning';
  const Icono = vencido ? TriangleAlert : CalendarClock;
  return (
    <section
      aria-labelledby={idTitulo} role="status" data-variante="renovar"
      className="mt-3 rounded-[10px] p-4 sm:p-5"
      style={{ border: '1px solid var(--flit-border-soft)', background: 'var(--flit-bg-app)' }}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
          style={vencido
            ? { background: 'var(--flit-chip-warning-bg)', color: 'var(--flit-warning-ink)' }
            : { background: 'var(--flit-chip-active-bg)', color: 'var(--flit-blue-ink)' }}
        >
          <Icono size={18} />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 id={idTitulo} ref={tituloRef} tabIndex={-1} className="flit-focus rounded text-base font-semibold outline-none" style={{ color: 'var(--flit-text-primary)' }}>
              {c.titulo}
            </h3>
            {c.chip && <StatusChip tone={c.tono}>{c.chip}</StatusChip>}
          </div>
          {c.frase && <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{c.frase}</p>}
          {c.detalle && <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{c.detalle}</p>}
        </div>
      </div>
      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
        <button type="button" className={`${flitBtnSecondary} w-full justify-center sm:w-auto`} style={flitBtnSecondaryStyle} onClick={onConsultarOtro}>
          Consultar otro vehículo
        </button>
        {c.puedeRenovar && onRenovar && (
          <button type="button" className={`${flitBtnPrimary} w-full justify-center sm:w-auto`} style={flitBtnPrimaryStyle} onClick={onRenovar}>
            Renovar
          </button>
        )}
      </div>
    </section>
  );
}

function TarjetaRunt({ variante, datos, venceEl, onConsultarOtro, tituloRef, hoy }: PropsRunt) {
  const idTitulo = useId();
  const v = VARIANTE[variante];
  const esAviso = variante === 'aviso';

  // Aviso: `venceEl` y, si no sirve, `vencimiento`. Bloqueo: `vencimiento` y, si no, el
  // `fechaVencimiento` de siempre. Ninguna de las dos frases escribe «—» ni «Invalid Date».
  const aviso = esAviso
    ? avisoVigenciaProxima({ venceEl: venceEl ?? '', vencimiento: datos.vencimiento }, hoy)
    : null;
  const frase = aviso ? aviso.titulo : fraseBloqueoVigente(datos.vencimiento, venceEl ?? undefined);

  return (
    <section
      aria-labelledby={idTitulo}
      // Aviso: se anuncia al montarse y NO mueve el foco (como la #12213). Bloqueo: sin región viva,
      // porque el foco ya va al `h3` y dos anuncios del mismo título se pisarían.
      role={esAviso ? 'status' : undefined}
      data-variante={variante}
      className="mt-3 rounded-[10px] p-4 sm:p-5"
      style={{ border: '1px solid var(--flit-border-soft)', background: 'var(--flit-bg-app)' }}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
          style={v.insignia}
        >
          <v.Icono size={18} />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3
              id={idTitulo} ref={tituloRef} tabIndex={-1}
              className="flit-focus rounded text-base font-semibold outline-none"
              style={{ color: 'var(--flit-text-primary)' }}
            >
              {v.titulo}
            </h3>
            <StatusChip tone={v.tono}>{v.chip}</StatusChip>
          </div>
          <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{frase}</p>
          {aviso?.detalle && (
            <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>{aviso.detalle}</p>
          )}
        </div>
      </div>

      {/* Las seis filas se pintan SIEMPRE, con «—» por dato ausente (AC4). Fila 1 en semibold: lo
          que decide y lo que identifica; fila 2 en peso normal: el contexto. */}
      <dl
        className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 pt-4 sm:grid-cols-3"
        style={{ borderTop: '1px solid var(--flit-border-soft)' }}
      >
        <Dato k="Aseguradora" v={dato(datos.aseguradora)} clase="col-span-2 sm:col-span-1" claseValor="font-semibold break-words" />
        <Dato k="Vence" v={fechaLargaOGuion(datos.vencimiento)} claseValor="font-semibold" />
        <Dato k="Póliza" v={dato(datos.poliza)} claseValor="font-semibold tabular-nums break-all" />
        <Dato k="Inicio de vigencia" v={fechaLargaOGuion(datos.inicioVigencia)} claseValor="font-normal" />
        <Dato k="Fecha de expedición" v={fechaLargaOGuion(datos.fechaExpedicion)} claseValor="font-normal" />
        <Dato k="Estado" v={dato(datos.estado)} claseValor="font-normal break-words" />
      </dl>

      {!esAviso && onConsultarOtro && (
        <div className="mt-4 flex flex-wrap justify-end">
          <button
            type="button"
            className={`${flitBtnSecondary} w-full justify-center sm:w-auto`}
            style={flitBtnSecondaryStyle}
            onClick={onConsultarOtro}
          >
            Consultar otro vehículo
          </button>
        </div>
      )}
    </section>
  );
}
