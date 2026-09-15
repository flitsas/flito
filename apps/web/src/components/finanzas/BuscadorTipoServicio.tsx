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

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import type { ServicioAdicionalTipo } from '@operaciones/shared-types';
import { ApiError, api, errorMessage } from '../../lib/api';
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

/** Lo que falla al pedir el catálogo: un 403 no se reintenta (no se arregla reintentando). */
interface ErrorCatalogo { mensaje: string; reintentable: boolean }

export default function BuscadorTipoServicio({
  tramiteId, asignados, onAsignado, onRecargarLista, onFallo, onCerrar,
}: {
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
}) {
  const { user } = useAuth();
  const idListbox = useId();
  const campoRef = useRef<HTMLInputElement>(null);

  const [tipos, setTipos] = useState<ServicioAdicionalTipo[] | null>(null);
  const [cargando, setCargando] = useState(true);
  const [errorCatalogo, setErrorCatalogo] = useState<ErrorCatalogo | null>(null);
  const [recargaCatalogo, setRecargaCatalogo] = useState(0);
  const [consulta, setConsulta] = useState('');
  const [resaltado, setResaltado] = useState(0);
  const [enviando, setEnviando] = useState(false);
  const [errorAlta, setErrorAlta] = useState<string | null>(null);

  // El foco entra en el campo (§6.2). El buscador se monta al pulsar «Añadir servicio», así que
  // esto ocurre una vez por apertura.
  useEffect(() => { campoRef.current?.focus(); }, []);

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
          : { mensaje: `No se pudo cargar el catálogo de servicios adicionales. ${errorMessage(e)}`, reintentable: true });
      })
      .finally(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; };
  }, [recargaCatalogo]);

  const opciones = useMemo(() => asignablesDe(tipos ?? [], asignados, consulta), [tipos, asignados, consulta]);
  // El resaltado no puede quedarse apuntando fuera cuando la lista se acorta al teclear.
  const activo = opciones.length === 0 ? -1 : Math.min(resaltado, opciones.length - 1);

  const elegir = async (tipo: ServicioAdicionalTipo) => {
    setEnviando(true);
    setErrorAlta(null);
    try {
      await api.post(rutaServiciosDeTramite(tramiteId), { tipoId: tipo.id });
      setConsulta('');
      setResaltado(0);
      campoRef.current?.focus();
      onAsignado(tipo.nombre);
    } catch (e) {
      const fallo = falloDeEscritura(e, 'asignar');
      // Sellado, desaparecido o sin permiso: el buscador se cierra y lo dice el PANEL, que es quien
      // sigue en pantalla. Lo demás se explica aquí, bajo el campo, con el buscador abierto.
      if (fallo.soloLectura || fallo.tramiteIdo) { onFallo(fallo); return; }
      setErrorAlta(fallo.mensaje);
      if (fallo.recargarLista) onRecargarLista();
      if (fallo.recargarCatalogo) setRecargaCatalogo((n) => n + 1);
    } finally {
      setEnviando(false);
    }
  };

  const teclas = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      // `useEscape` de `FlitModal` escucha en `window` y el portal cuelga de <body>: sin esto, Esc
      // cerraría el PANEL en vez del buscador (§9, escape por capas).
      e.stopPropagation();
      onCerrar();
      return;
    }
    if (opciones.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setResaltado((i) => (Math.min(i, opciones.length - 1) + 1) % opciones.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setResaltado((i) => (Math.min(i, opciones.length - 1) + opciones.length - 1) % opciones.length); }
    else if (e.key === 'Enter' && activo >= 0 && !enviando) { e.preventDefault(); void elegir(opciones[activo]); }
  };

  const idOpcion = (i: number) => `${idListbox}-op-${i}`;

  return (
    <div className="mb-4 rounded-lg border p-3" style={{ borderColor: 'var(--flit-border-input)' }} onKeyDown={teclas}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Añadir servicio</h3>
        <button type="button" className={flitBtnSecondarySm} onClick={onCerrar}>Cancelar</button>
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

        {!cargando && !errorCatalogo && (
          <ul id={idListbox} role="listbox" aria-label="Tipos de servicio adicional">
            {opciones.map((t, i) => (
              <li key={t.id} id={idOpcion(i)} role="option" aria-selected={i === activo} data-id={t.id}
                className="border-t first:border-t-0" style={{ borderColor: 'var(--flit-border-soft)' }}>
                <button type="button" disabled={enviando}
                  className="flit-focus w-full px-1 py-2 text-left disabled:opacity-50"
                  style={i === activo ? { background: 'var(--flit-bg-table-header)' } : undefined}
                  onMouseEnter={() => setResaltado(i)}
                  onClick={() => void elegir(t)}>
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="text-sm font-semibold">{t.nombre}</span>
                    <span className="text-sm tabular-nums">{pesos(t.valor)}</span>
                  </span>
                  {/* La descripción solo aquí: es lo que ayuda a ELEGIR. En la lista ya se eligió. */}
                  {t.descripcion && <span className="mt-0.5 block truncate text-xs" style={SECUNDARIO}>{t.descripcion}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}

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
