import { useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { AlertCircle } from 'lucide-react';
import {
  ETIQUETAS_AREA_SOPORTE, ETIQUETAS_FRECUENCIA_SOPORTE, ETIQUETAS_PRIORIDAD_SOPORTE,
} from '@operaciones/shared-types';
import {
  flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondarySm,
} from '../flit/flitPageKit';
import {
  aceptarAutorizacion, ahoraNo, confirmarCaso, corregir, limitesAdjuntos, pasoAnterior, reintentarPreparar,
  siguientePaso, useSoporteDrFlit, volverAlChat, type BorradorSoporte, type EstadoSoporteDrFlit, type FocoSoporte,
} from '../../lib/drFlitSoporte';
import {
  CAMPOS_POR_PASO, PASOS_SOPORTE, TITULOS_PASO, primerError, type CampoSoporte,
} from '../../lib/drFlitSoporteModelo';
import { PasoCaso, PasoContacto, idCampoSoporte } from './DrFlitSoporteCampos';
import { PasoArchivos, enfocarArchivos } from './DrFlitSoporteArchivos';
import { DRFLIT_PANEL_ID } from './DrFlitMarco';

// Dr. Flit — asistente «Necesito soporte» (HU #13806, Feature #13695; anexo UX F5). Toma el cuerpo del
// panel mientras dura (sustituye la conversación y el pie); el marco no cambia. Todo su estado vive en
// `lib/drFlitSoporte.ts` (memoria, por encima del panel): este componente solo pinta y despacha.
// Pantallas: preparando · error de preparación · no disponible · autorización · Contacto → Caso → Archivos
// (HU #13807, multipart #13805) → Resumen.

const TITULO_ID = 'drflit-soporte-encabezado';
/** Botones que en <lg suben a 44 px de alto (objetivo táctil, F5.12); en lg+ la altura del kit. */
const SM_TACTIL = `${flitBtnSecondarySm} max-lg:h-11`;
const PRIMARIA = `${flitBtnPrimary} max-lg:h-11`;
const SECUNDARIA = `${flitBtnSecondary} max-lg:h-11`;

function AvisoError({ titulo, detalle, rol = 'alert' }: { titulo: string; detalle: string; rol?: 'alert' | 'status' }) {
  return (
    <div role={rol} className="mt-4 rounded-flit-lg border border-flit-soft bg-flit-app p-3 text-sm text-flit-ink">
      <div className="flex items-start gap-2">
        <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--flit-danger-text)]" />
        <div className="min-w-0">
          <p className="break-words">{titulo}</p>
          <p className="mt-1 break-words text-flit-secondary">{detalle}</p>
        </div>
      </div>
    </div>
  );
}

function Dato({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-flit-muted">{rotulo}</dt>
      <dd className="whitespace-pre-line break-words text-sm text-flit-ink">{valor}</dd>
    </div>
  );
}

function Bloque({ titulo, corregirPaso, inactivo, children }: {
  titulo: string; corregirPaso?: 'contacto' | 'caso' | 'archivos'; inactivo: boolean; children: ReactNode;
}) {
  return (
    <div className="border-t border-flit-soft pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-flit-ink">{titulo}</h4>
        {corregirPaso && (
          <button
            type="button"
            onClick={() => corregir(corregirPaso)}
            aria-disabled={inactivo || undefined}
            aria-label={`Corregir ${titulo.toLowerCase()}`}
            className={SM_TACTIL}
          >
            Corregir
          </button>
        )}
      </div>
      <dl className="mt-2 flex flex-col gap-2">{children}</dl>
    </div>
  );
}

function Resumen({ b, ambiente, inactivo }: { b: BorradorSoporte; ambiente: string; inactivo: boolean }) {
  const c = b.campos;
  return (
    <div className="mt-4 flex flex-col gap-4">
      <Bloque titulo="Contacto" corregirPaso="contacto" inactivo={inactivo}>
        <Dato rotulo="Nombre" valor={c.nombre.trim()} />
        <Dato rotulo="Correo" valor={c.correo.trim()} />
        <Dato rotulo="Teléfono" valor={c.telefono.trim() || 'No indicado'} />
      </Bloque>
      <Bloque titulo="Caso" corregirPaso="caso" inactivo={inactivo}>
        <Dato rotulo="Área" valor={c.area ? ETIQUETAS_AREA_SOPORTE[c.area] : ''} />
        <Dato rotulo="Título" valor={c.titulo.trim()} />
        <Dato rotulo="Detalle" valor={c.detalle.trim()} />
        <Dato rotulo="Resultado esperado" valor={c.resultadoEsperado.trim()} />
        <Dato rotulo="Frecuencia" valor={c.frecuencia ? ETIQUETAS_FRECUENCIA_SOPORTE[c.frecuencia] : ''} />
        <Dato rotulo="Prioridad" valor={c.prioridad ? ETIQUETAS_PRIORIDAD_SOPORTE[c.prioridad] : ''} />
      </Bloque>
      <Bloque titulo="Archivos" corregirPaso="archivos" inactivo={inactivo}>
        {b.adjuntar && b.adjuntos.length > 0 ? (
          <>
            <Dato
              rotulo="Adjuntos"
              valor={`Sí · ${b.adjuntos.length} ${b.adjuntos.length === 1 ? 'archivo' : 'archivos'}`}
            />
            <div className="min-w-0">
              <dt className="sr-only">Nombres</dt>
              <dd>
                <ul aria-label="Archivos que se enviarán" className="flex flex-col gap-0.5 text-sm text-flit-ink">
                  {b.adjuntos.map((a) => <li key={a.id} className="break-all">{a.file.name}</li>)}
                </ul>
              </dd>
            </div>
          </>
        ) : (
          <Dato rotulo="Adjuntos" valor="No" />
        )}
      </Bloque>
      <Bloque titulo="Datos del reporte" inactivo={inactivo}>
        <Dato rotulo="Fecha" valor={b.fecha ?? ''} />
        <Dato rotulo="Ambiente" valor={ambiente} />
      </Bloque>
    </div>
  );
}

/** Enfoca el control de un campo: input/textarea por id, el select dentro de su caja, el primer radio. */
function enfocarCampo(campo: CampoSoporte): void {
  const id = idCampoSoporte(campo);
  const el = document.getElementById(id) ?? document.querySelector<HTMLElement>(`#${id}-caja select`);
  el?.focus();
}

export default function DrFlitSoporte() {
  const s = useSoporteDrFlit();
  const tituloRef = useRef<HTMLHeadingElement>(null);
  const primariaRef = useRef<HTMLButtonElement>(null);
  const volverRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const b = s.borrador;
  const enviando = s.envio.fase === 'enviando';

  // Foco pedido por el almacén (F5.6). Al montar (reabrir el panel) se difiere un turno: el marco
  // enfoca su título al abrir y el asistente debe quedarse con el foco de su paso.
  const montado = useRef(false);
  useEffect(() => {
    const aplicar = (a: FocoSoporte) => {
      if (a === 'h3') {
        scrollRef.current?.scrollTo?.({ top: 0 });
        tituloRef.current?.focus();
      } else if (a === 'primaria') {
        // El aviso de error va justo encima del pie: se lleva a la vista junto con el foco.
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
        primariaRef.current?.focus();
      }
      else if (a === 'volver') volverRef.current?.focus();
      else if (b && b.paso === 'archivos' && (a === 'primerError' || a === 'primerCampo' || a === 'archivos' || a === 'quitar')) {
        enfocarArchivos(b, a, s.foco.i);
      }
      else if ((a === 'primerError' || a === 'primerCampo') && b && b.paso !== 'resumen') {
        const campo = a === 'primerError' ? primerError(b.paso, b.campos, b.rechazados) : CAMPOS_POR_PASO[b.paso][0];
        if (campo) enfocarCampo(campo);
      }
    };
    if (montado.current) {
      aplicar(s.foco.a);
      return;
    }
    montado.current = true;
    // Al montar (abrir el asistente o reabrir el panel con él a la vista): h3 de la pantalla.
    const alMontar: FocoSoporte = s.pantalla === 'paso' || s.pantalla === 'autorizacion' ? 'h3'
      : s.pantalla === 'errorPreparar' ? 'primaria' : 'volver';
    const t = window.setTimeout(() => aplicar(alMontar), 0);
    return () => window.clearTimeout(t);
    // Solo reacciona a una petición NUEVA de foco (contador), no a cada tecla del borrador.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.foco.n]);

  // Reabrir el panel (el marco solo se oculta con `hidden`, no se desmonta): el marco enfoca su título y
  // el asistente recupera el foco en el `h3` de su pantalla (F5.6, «Cerrar» con el asistente abierto).
  useEffect(() => {
    const marco = document.getElementById(DRFLIT_PANEL_ID);
    if (!marco) return;
    let t = 0;
    const obs = new MutationObserver(() => {
      if (marco.hidden) return;
      window.clearTimeout(t);
      t = window.setTimeout(() => (tituloRef.current ?? volverRef.current)?.focus(), 0);
    });
    obs.observe(marco, { attributes: true, attributeFilter: ['hidden'] });
    return () => {
      obs.disconnect();
      window.clearTimeout(t);
    };
  }, []);

  // Esc = «Volver al chat» (o «Ahora no» en la autorización); el segundo Esc lo recibe el marco.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    e.preventDefault();
    if (s.pantalla === 'autorizacion') ahoraNo();
    else volverAlChat();
  };

  const cuerpo = cuerpoDe(s, tituloRef, primariaRef, enviando);
  return (
    <section aria-labelledby={TITULO_ID} onKeyDown={onKeyDown} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-flit-muted">Necesito soporte</p>
          <button
            ref={volverRef}
            type="button"
            onClick={() => { if (!enviando) volverAlChat(); }}
            aria-disabled={enviando || undefined}
            className={SM_TACTIL}
          >
            Volver al chat
          </button>
        </div>
        {cuerpo.contenido}
      </div>
      {cuerpo.pie && (
        <div
          className="flex flex-wrap items-center justify-end gap-2 border-t border-flit-soft px-4 pt-3 [&:has(>:nth-child(2))]:justify-between"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        >
          {cuerpo.pie}
        </div>
      )}
    </section>
  );
}

type RefBoton = RefObject<HTMLButtonElement>;

function Titulo({ refH, children }: { refH: RefObject<HTMLHeadingElement>; children: ReactNode }) {
  return (
    <h3 ref={refH} id={TITULO_ID} tabIndex={-1} className="flit-focus mt-3 rounded-md text-base font-semibold text-flit-ink">
      {children}
    </h3>
  );
}

function cuerpoDe(
  s: EstadoSoporteDrFlit,
  tituloRef: RefObject<HTMLHeadingElement>,
  primariaRef: RefBoton,
  enviando: boolean,
): { contenido: ReactNode; pie?: ReactNode } {
  if (s.pantalla === 'preparando') {
    return {
      contenido: (
        <>
          <h3 id={TITULO_ID} className="sr-only">Necesito soporte</h3>
          <p role="status" className="mt-4 text-sm text-flit-secondary">Preparando su caso…</p>
        </>
      ),
    };
  }
  if (s.pantalla === 'errorPreparar') {
    return {
      contenido: (
        <>
          <h3 id={TITULO_ID} className="sr-only">Necesito soporte</h3>
          <AvisoError titulo="No pude conectar con el servicio de soporte." detalle="Revise su conexión e intente de nuevo." rol="status" />
          <button ref={primariaRef} type="button" onClick={reintentarPreparar} className={`${SECUNDARIA} mt-3`}>
            Reintentar
          </button>
        </>
      ),
    };
  }
  if (s.pantalla === 'noDisponible') {
    return {
      contenido: (
        <div role="status" className="mt-4 text-sm text-flit-ink">
          <h3 id={TITULO_ID} className="sr-only">Necesito soporte</h3>
          <p className="break-words">El soporte desde Dr. Flit no está disponible en este momento.</p>
          <p className="mt-1 break-words text-flit-secondary">Puede seguir consultando la Ayuda FLITO.</p>
        </div>
      ),
    };
  }
  if (s.pantalla === 'autorizacion') return cuerpoAutorizacion(s, tituloRef, primariaRef);
  const b = s.borrador;
  if (!b) return { contenido: null };
  const n = PASOS_SOPORTE.indexOf(b.paso) + 1;
  const titulo = (
    <Titulo refH={tituloRef}>
      <span className="block text-xs font-medium text-flit-muted">Paso {n} de {PASOS_SOPORTE.length}</span>
      <span className="block">{TITULOS_PASO[b.paso]}</span>
    </Titulo>
  );
  if (b.paso === 'resumen') {
    const errorEnvio = s.envio.fase === 'error';
    return {
      contenido: (
        <>
          {titulo}
          <Resumen b={b} ambiente={s.consulta.datos?.soporte.ambienteEtiqueta ?? ''} inactivo={enviando} />
          {enviando && <p role="status" className="mt-4 text-sm text-flit-secondary">Radicando su caso…</p>}
          {errorEnvio && (
            s.envio.tope
              ? <AvisoError titulo="Ya radicó varios casos en la última hora." detalle="Su información sigue aquí. Podrá radicar este caso más tarde." />
              : <AvisoError titulo="No pude radicar su caso en este momento." detalle="Su información sigue aquí. Intente de nuevo en unos minutos." />
          )}
        </>
      ),
      pie: (
        <button
          ref={primariaRef}
          type="button"
          onClick={() => { if (!enviando) confirmarCaso(); }}
          aria-disabled={enviando || undefined}
          className={PRIMARIA}
          style={flitBtnPrimaryStyle}
        >
          {enviando ? 'Radicando…' : errorEnvio ? 'Reintentar' : 'Confirmar'}
        </button>
      ),
    };
  }
  const mostrar = b.validados.has(b.paso);
  return {
    contenido: (
      <>
        {titulo}
        {b.paso === 'contacto' && <PasoContacto b={b} mostrar={mostrar} />}
        {b.paso === 'caso' && <PasoCaso b={b} mostrar={mostrar} />}
        {b.paso === 'archivos' && (
          <PasoArchivos b={b} mostrar={mostrar} limites={limitesAdjuntos()} inactivo={enviando} />
        )}
      </>
    ),
    pie: (
      <>
        {b.paso !== PASOS_SOPORTE[0] && (
          <button type="button" onClick={pasoAnterior} className={SECUNDARIA}>Atrás</button>
        )}
        <button ref={primariaRef} type="button" onClick={siguientePaso} className={PRIMARIA} style={flitBtnPrimaryStyle}>
          {b.desdeResumen ? 'Volver al resumen' : 'Siguiente'}
        </button>
      </>
    ),
  };
}

function cuerpoAutorizacion(
  s: EstadoSoporteDrFlit,
  tituloRef: RefObject<HTMLHeadingElement>,
  primariaRef: RefBoton,
): { contenido: ReactNode; pie: ReactNode } {
  const datos = s.consulta.datos;
  const enviando = s.autorizacion.fase === 'enviando';
  const recargando = s.consulta.fase === 'cargando';
  const inactivo = enviando || recargando || !datos;
  return {
    contenido: (
      <>
        <Titulo refH={tituloRef}>Antes de radicar su caso</Titulo>
        {s.autorizacion.aviso && (
          <p role="status" className="mt-3 rounded-flit-lg border border-flit-soft bg-flit-app p-3 text-sm text-flit-ink">
            El texto de la autorización cambió. Léalo y acéptelo para radicar su caso.
          </p>
        )}
        {recargando
          ? <p role="status" className="mt-3 text-sm text-flit-secondary">Preparando su caso…</p>
          : <p className="mt-3 whitespace-pre-line break-words text-sm text-flit-ink">{datos?.textoVigente}</p>}
        {s.autorizacion.fase === 'error' && (
          <AvisoError titulo="No pude registrar su autorización." detalle="Intente de nuevo." />
        )}
      </>
    ),
    pie: (
      <>
        <button
          type="button"
          onClick={() => { if (!enviando) ahoraNo(); }}
          aria-disabled={enviando || undefined}
          className={SECUNDARIA}
        >
          Ahora no
        </button>
        <button
          ref={primariaRef}
          type="button"
          onClick={() => { if (!inactivo) aceptarAutorizacion(); }}
          aria-disabled={inactivo || undefined}
          className={PRIMARIA}
          style={flitBtnPrimaryStyle}
        >
          {enviando ? 'Registrando…' : 'Acepto'}
        </button>
      </>
    ),
  };
}
