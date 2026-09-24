// El buscador de «Añadir servicio» del panel de servicios adicionales (HU #12548, Feature #12544).
// Diseño: `docs/ux/finanzas-reporte-costos-servicios-adicionales.md` §6.2.
//
// Vive DENTRO del panel, encima de la lista: no es un segundo diálogo (§12-D4). El catálogo se pide
// al montarlo —es decir, al pulsar «Añadir servicio»— y no al abrir el panel: quien solo viene a
// mirar no paga una petición (§12-D5). Tras un 201 sigue abierto y limpio, porque añadir dos
// servicios seguidos es el caso real, y el recién añadido desaparece solo de los resultados (la
// exclusión se recalcula sobre `asignados`, que el panel repide).
//
// El teclado es el combobox/listbox que ya usan `CommandPalette` y `FlitOrganismoCombobox`: no se
// inventa un patrón para esta pantalla.

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import type { ServicioAdicionalTipo } from '@operaciones/shared-types';
import { ApiError, api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { hasPage } from '../../lib/permissions';
import { RUTA_SERVICIOS_ADICIONALES } from '../../lib/serviciosAdicionales';
import {
  asignablesDe, falloDeEscritura, rutaServiciosDeTramite, type FalloEscritura,
} from '../../lib/serviciosAdicionalesTramite';
import { flitBtnSecondary, flitBtnSecondarySm, flitInp } from '../flit/flitPageKit';
// El dinero de esta superficie lo escribe el REPORTE, no el catálogo (§7-R2): el valor de la opción,
// el de la línea ya asignada y el total del pie tienen que decir la misma cifra con la misma forma.
import { pesos } from './tiposReporteCostos';

const SECUNDARIO = { color: 'var(--flit-text-secondary)' } as const;
const TENUE = { color: 'var(--flit-text-muted)' } as const;
const PELIGRO = { color: 'var(--flit-danger-ink)' } as const;
const AZUL = { color: 'var(--flit-blue-text)' } as const;
const SIN_EXCLUIR: readonly string[] = [];

/** Lo que falla al pedir el catálogo: un 403 no se reintenta (no se arregla reintentando). */
interface ErrorCatalogo { mensaje: string; reintentable: boolean }

/** Ayuda bajo el campo en modo `elegir` (UX slim Bug #12913). */
export const AYUDA_ELEGIR = 'El servicio queda asignado al trámite con el valor de este comprobante. Si ya estaba asignado, se actualiza su valor.';
export const MARCA_YA_ASIGNADO = 'Ya asignado · se actualizará el valor';

/** Modo `asignar` (default): el buscador del panel del trámite, que ASIGNA con su POST (HU #12548). */
interface PropsAsignar {
  modo?: 'asignar';
  tramiteId: string;
  /** Los `tipoId` que el trámite ya lleva: se excluyen de los resultados (AC3). */
  asignados: readonly string[];
  /** 201: el panel mete el servicio en la lista, refresca el reporte y anuncia. */
  onAsignado: (nombre: string) => void;
  /** Lo que se vio ya no es lo que hay (409 `SERVICIO_YA_ASIGNADO`): repedir la lista. */
  onRecargarLista: () => void;
  /** Solo los fallos que cierran el buscador: trámite sellado, trámite ido, permiso retirado. */
  onFallo: (fallo: FalloEscritura) => void;
  onCerrar: () => void;
}

/**
 * Modo `elegir` (Bug #12913): un campo de formulario que solo ELIGE un tipo activo —sin POST— para
 * aplicar un comprobante de pago de servicios adicionales. Los ya asignados NO se excluyen (aquí se
 * corrige su valor): se marcan con `MARCA_YA_ASIGNADO`.
 */
interface PropsElegir {
  modo: 'elegir';
  /** `id` del input, para el `<label>` visible que pinta este mismo componente. */
  inputId: string;
  asignados: readonly string[];
  elegido: ServicioAdicionalTipo | null;
  onElegir: (tipo: ServicioAdicionalTipo | null) => void;
  /** Súbelo para repedir el catálogo (p. ej. un tipo dado de baja en vuelo). */
  recarga?: number;
  inputRef?: RefObject<HTMLInputElement>;
  invalido?: boolean;
  /** `id` del `<p role="alert">` que el formulario pinta debajo cuando falta el tipo. */
  errorId?: string;
}

export default function BuscadorTipoServicio(props: PropsAsignar | PropsElegir) {
  const elige = props.modo === 'elegir';
  const { user } = useAuth();
  const idListbox = useId();
  const idAyuda = useId();
  const campoPropio = useRef<HTMLInputElement>(null);
  const campoRef = (elige && props.inputRef) || campoPropio;

  const [tipos, setTipos] = useState<ServicioAdicionalTipo[] | null>(null);
  const [cargando, setCargando] = useState(true);
  const [errorCatalogo, setErrorCatalogo] = useState<ErrorCatalogo | null>(null);
  const [recargaCatalogo, setRecargaCatalogo] = useState(0);
  const [consulta, setConsulta] = useState('');
  const [resaltado, setResaltado] = useState(0);
  const [enviando, setEnviando] = useState(false);
  const [errorAlta, setErrorAlta] = useState<string | null>(null);
  // En `elegir` la lista se abre al enfocar/teclear y se cierra al elegir o con Esc; en `asignar`
  // siempre está a la vista (el buscador entero ya es lo que se abrió).
  const [abierta, setAbierta] = useState(!elige);
  const recargaExterna = elige ? (props.recarga ?? 0) : 0;

  // El foco entra en el campo (§6.2). El buscador se monta al pulsar «Añadir servicio», así que
  // esto ocurre una vez por apertura. En `elegir` es un campo más del formulario: no roba el foco.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (!elige) campoRef.current?.focus(); }, []);

  useEffect(() => {
    let vivo = true;
    setCargando(true);
    setErrorCatalogo(null);
    // SIN `incluirBajas`: solo los tipos activos se pueden cobrar (AC3).
    api.get<ServicioAdicionalTipo[]>(RUTA_SERVICIOS_ADICIONALES)
      .then((r) => { if (vivo) setTipos(r); })
      .catch((e) => {
        if (!vivo) return;
        setTipos(null);
        // El 403 NOMBRA la función que falta, y es de OTRO módulo que las tres de la 0193: «Añadir»
        // necesita `finanzas.servicios_adicionales.asignar` para escribir y
        // `parametrizacion.servicios_adicionales.listar` para leer el catálogo (UX §7-R1).
        setErrorCatalogo(e instanceof ApiError && e.status === 403
          ? {
            mensaje: 'Tu usuario no puede ver el catálogo de servicios adicionales. Pídele a un administrador la función «Ver el catálogo de servicios adicionales».',
            reintentable: false,
          }
          // El detalle crudo del API no se pinta (regla 16): la frase dice qué pasó y el botón qué sigue.
          : { mensaje: 'No se pudo cargar el catálogo de servicios adicionales.', reintentable: true });
      })
      .finally(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; };
  }, [recargaCatalogo, recargaExterna]);

  // En `elegir` no se excluye nadie: el ya asignado es justo el que se corrige.
  const excluidos = elige ? SIN_EXCLUIR : props.asignados;
  const opciones = useMemo(() => asignablesDe(tipos ?? [], excluidos, consulta), [tipos, excluidos, consulta]);
  const yaAsignados = useMemo(() => new Set(props.asignados), [props.asignados]);
  // El resaltado no puede quedarse apuntando fuera cuando la lista se acorta al teclear.
  const activo = opciones.length === 0 ? -1 : Math.min(resaltado, opciones.length - 1);

  const elegir = async (tipo: ServicioAdicionalTipo) => {
    if (props.modo === 'elegir') {
      props.onElegir(tipo);
      setConsulta('');
      setResaltado(0);
      setAbierta(false);
      return;
    }
    setEnviando(true);
    setErrorAlta(null);
    try {
      await api.post(rutaServiciosDeTramite(props.tramiteId), { tipoId: tipo.id });
      setConsulta('');
      setResaltado(0);
      campoRef.current?.focus();
      props.onAsignado(tipo.nombre);
    } catch (e) {
      const fallo = falloDeEscritura(e, 'asignar');
      // Sellado, desaparecido o sin permiso: el buscador se cierra y lo dice el PANEL, que es quien
      // sigue en pantalla. Lo demás se explica aquí, bajo el campo, con el buscador abierto.
      if (fallo.soloLectura || fallo.tramiteIdo) { props.onFallo(fallo); return; }
      setErrorAlta(fallo.mensaje);
      if (fallo.recargarLista) props.onRecargarLista();
      if (fallo.recargarCatalogo) setRecargaCatalogo((n) => n + 1);
    } finally {
      setEnviando(false);
    }
  };

  const teclas = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (props.modo === 'elegir') {
        // Esc cierra SOLO la lista; con la lista cerrada se deja subir y el modal hace lo suyo.
        if (abierta) { e.stopPropagation(); setAbierta(false); }
        return;
      }
      // `useEscape` de `FlitModal` escucha en `window` y el portal cuelga de <body>: sin esto, Esc
      // cerraría el PANEL en vez del buscador (§9, escape por capas).
      e.stopPropagation();
      props.onCerrar();
      return;
    }
    if (elige && !abierta && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setAbierta(true); return; }
    if (opciones.length === 0 || !abierta) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setResaltado((i) => (Math.min(i, opciones.length - 1) + 1) % opciones.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setResaltado((i) => (Math.min(i, opciones.length - 1) + opciones.length - 1) % opciones.length); }
    else if (e.key === 'Enter' && activo >= 0 && !enviando) { e.preventDefault(); void elegir(opciones[activo]); }
  };

  const idOpcion = (i: number) => `${idListbox}-op-${i}`;

  const lista = (
    <ul id={idListbox} role="listbox" aria-label="Tipos de servicio adicional"
      className={elige ? 'mt-1 max-h-60 overflow-auto rounded-lg border' : undefined}
      style={elige ? { borderColor: 'var(--flit-border-input)' } : undefined}>
      {opciones.map((t, i) => (
        <li key={t.id} id={idOpcion(i)} role="option" aria-selected={elige ? props.elegido?.id === t.id : i === activo} data-id={t.id}
          className="border-t first:border-t-0" style={{ borderColor: 'var(--flit-border-soft)' }}>
          <button type="button" disabled={enviando} tabIndex={elige ? -1 : undefined}
            className="flit-focus w-full px-2 py-2 text-left transition-colors hover:bg-[var(--flit-bg-hover)] disabled:opacity-50"
            style={i === activo ? { background: 'var(--flit-bg-table-header)' } : undefined}
            // En `elegir` el foco se queda en el input (combobox): sin esto, el blur cerraría la lista antes del clic.
            onMouseDown={elige ? (e) => e.preventDefault() : undefined}
            onMouseEnter={() => setResaltado(i)}
            onClick={() => void elegir(t)}>
            <span className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-semibold">{t.nombre}</span>
              <span className="text-sm tabular-nums">{pesos(t.valor)}</span>
            </span>
            {/* La descripción solo aquí: es lo que ayuda a ELEGIR. En la lista ya se eligió. */}
            {t.descripcion && <span className="mt-0.5 block truncate text-xs" style={SECUNDARIO}>{t.descripcion}</span>}
            {elige && yaAsignados.has(t.id) && <span className="mt-0.5 block text-xs" style={TENUE}>{MARCA_YA_ASIGNADO}</span>}
          </button>
        </li>
      ))}
    </ul>
  );

  const estados = (
    <>
      {cargando && <p className="text-xs" style={TENUE}>Cargando el catálogo…</p>}

      {!cargando && errorCatalogo && (
        <>
          <p role="alert" className="text-sm" style={PELIGRO}>{errorCatalogo.mensaje}</p>
          {errorCatalogo.reintentable && (
            <button type="button" className={`${flitBtnSecondary} mt-2`} onClick={() => setRecargaCatalogo((n) => n + 1)}>
              Reintentar
            </button>
          )}
        </>
      )}
    </>
  );

  if (props.modo === 'elegir') {
    const hayActivos = (tipos ?? []).some((t) => t.activo);
    const sinActivos = !cargando && !errorCatalogo && !hayActivos;
    const describedBy = [idAyuda, props.invalido && props.errorId ? props.errorId : undefined].filter(Boolean).join(' ');
    const mostrarLista = abierta && !cargando && !errorCatalogo && hayActivos;
    return (
      <div className="w-full space-y-1" onKeyDown={teclas}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setAbierta(false); }}>
        <label htmlFor={props.inputId} className="text-xs font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
          Tipo de servicio <span aria-hidden="true">*</span>
        </label>
        <input
          id={props.inputId}
          ref={campoRef}
          type="text"
          role="combobox"
          autoComplete="off"
          aria-required="true"
          aria-invalid={props.invalido ? true : undefined}
          aria-expanded={mostrarLista && opciones.length > 0}
          aria-controls={idListbox}
          aria-autocomplete="list"
          aria-activedescendant={mostrarLista && activo >= 0 ? idOpcion(activo) : undefined}
          aria-describedby={describedBy}
          placeholder="Buscar un tipo…"
          disabled={cargando || !!errorCatalogo || sinActivos}
          className={`${flitInp} w-full`}
          // Tras elegir, el campo dice el nombre; el valor que viaja es el del comprobante, así que el
          // de catálogo no se repite fuera de la lista (no se ofrecen dos cifras).
          value={abierta || !props.elegido ? consulta : props.elegido.nombre}
          onFocus={() => setAbierta(true)}
          onClick={() => setAbierta(true)}
          onChange={(e) => {
            setConsulta(e.target.value); setResaltado(0); setAbierta(true);
            if (props.elegido) props.onElegir(null);
          }}
        />
        <p id={idAyuda} className="text-[11px]" style={TENUE}>{AYUDA_ELEGIR}</p>
        {estados}
        {sinActivos && (
          <p className="text-sm" style={SECUNDARIO}>
            No hay tipos de servicio adicional activos. Actívalos en Servicios adicionales para poder aplicar este pago.
            {hasPage(user, 'flito_servicios_adicionales') && (
              <>
                {' '}
                <Link to="/flito/servicios-adicionales" className="flit-focus font-semibold underline" style={AZUL}>
                  Ir a Servicios adicionales
                </Link>
              </>
            )}
          </p>
        )}
        {mostrarLista && (opciones.length > 0
          ? lista
          : <p className="text-sm" style={SECUNDARIO}>Ningún tipo activo coincide con «{consulta.trim()}».</p>)}
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-lg border p-3" style={{ borderColor: 'var(--flit-border-input)' }} onKeyDown={teclas}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Añadir servicio</h3>
        <button type="button" className={flitBtnSecondarySm} onClick={props.onCerrar}>Cancelar</button>
      </div>

      <input
        ref={campoRef}
        type="search"
        role="combobox"
        aria-expanded={opciones.length > 0}
        aria-controls={idListbox}
        aria-autocomplete="list"
        aria-activedescendant={activo >= 0 ? idOpcion(activo) : undefined}
        aria-label="Buscar un tipo de servicio adicional"
        placeholder="Buscar un tipo…"
        className={`${flitInp} mt-2 w-full`}
        value={consulta}
        onChange={(e) => { setConsulta(e.target.value); setResaltado(0); }}
      />

      {/* Mientras el POST está en vuelo las opciones no se pueden pulsar; sin rótulo «Añadiendo…». */}
      <div className="mt-2" aria-busy={enviando || undefined}>
        {estados}

        {!cargando && !errorCatalogo && lista}

        {!cargando && !errorCatalogo && opciones.length === 0 && (
          <VacioDelBuscador
            consulta={consulta}
            hayTipos={(tipos ?? []).some((t) => t.activo)}
            puedeVerCatalogo={hasPage(user, 'flito_servicios_adicionales')}
          />
        )}
      </div>

      {errorAlta && <p role="alert" className="mt-2 text-sm" style={PELIGRO}>{errorAlta}</p>}
    </div>
  );
}

/** Los tres vacíos del buscador, que dicen cosas distintas y no se pueden decir igual (§6.2). */
function VacioDelBuscador({ consulta, hayTipos, puedeVerCatalogo }: {
  consulta: string; hayTipos: boolean; puedeVerCatalogo: boolean;
}) {
  if (consulta.trim() !== '') {
    return <p className="text-sm" style={SECUNDARIO}>Ningún tipo activo coincide con «{consulta.trim()}».</p>;
  }
  if (hayTipos) {
    return <p className="text-sm" style={SECUNDARIO}>Este trámite ya tiene todos los tipos activos del catálogo.</p>;
  }
  return (
    <p className="text-sm" style={SECUNDARIO}>
      No hay tipos de servicio adicional activos en el catálogo.
      {/* El enlace solo para quien puede entrar ahí: un enlace a una página sin permiso es un 403
          con más pasos (precedente: `TarjetaEnvioFacturacion` con `puedeVerConfiguracion`). */}
      {puedeVerCatalogo && (
        <>
          {' '}
          <Link to="/flito/servicios-adicionales" className="flit-focus font-semibold underline" style={AZUL}>
            Ir a Servicios adicionales
          </Link>
        </>
      )}
    </p>
  );
}
