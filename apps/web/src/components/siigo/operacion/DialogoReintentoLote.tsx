// AC4 — reintentar en lote SIN sorpresas: antes de confirmar se ve qué se va a intentar y qué queda
// fuera con su motivo; al terminar, el resultado de cada uno.
//
// DOS ENDPOINTS Y NO UNO, y la previsualización los separa siempre:
//   · `POST /bandeja/reintentar`      → **202**. Encola. La factura NO existe cuando esto contesta.
//   · `POST /bandeja/reenviar-correo` → **200**. Síncrono. El acta ya existe cuando contesta.
// Un 202 y un 200 no significan lo mismo y el copy no puede fundirlos. Por eso los encolados se
// rotulan «de vuelta en la cola» y nunca «reintentados con éxito»: lo que salió fue la orden, no la
// factura. Es la misma disciplina que llevó a «En cola» y no «Enviado» en el reporte de costos.
//
// **Si el bloque 1 falla, el bloque 2 se ejecuta igual.** Son operaciones independientes sobre
// conjuntos disjuntos; cancelar el segundo castigaría a casos que no tuvieron nada que ver.

import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  SIIGO_BANDEJA_RESULTADO_CORREO_ETIQUETA, SIIGO_BANDEJA_RESULTADO_ETIQUETA,
} from '@operaciones/shared-types';
import type {
  SiigoBandejaRespuestaCorreo, SiigoBandejaRespuestaReintento,
} from '@operaciones/shared-types';
import { ApiError, api, errorMessage } from '../../../lib/api';
import FlitModal from '../../flit/FlitModal';
import {
  flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../../flit/flitPageKit';
import { previsualizarLote, type CasoLote, type ExclusionLote } from './previsualizarLote';

type Fase = 'confirmar' | 'enviando' | 'resultado';

interface FalloBloque {
  mensaje: string;
  /** `ApiError.status === 0`: no hubo respuesta. **Puede que sí se haya registrado.** */
  sinRespuesta: boolean;
  casos: number;
}

interface Desenlace {
  emision: SiigoBandejaRespuestaReintento | null;
  correo: SiigoBandejaRespuestaCorreo | null;
  falloEmision: FalloBloque | null;
  falloCorreo: FalloBloque | null;
}

interface Props {
  seleccion: CasoLote[];
  onCerrar: () => void;
  /** Se llama al cerrar con el resumen ya en una frase, para el anuncio `aria-live` de la página. */
  onTerminado: (anuncio: string) => void;
  restoreFocusRef: RefObject<HTMLElement | null>;
}

export default function DialogoReintentoLote(
  { seleccion, onCerrar, onTerminado, restoreFocusRef }: Props,
) {
  const previa = previsualizarLote(seleccion);
  const [fase, setFase] = useState<Fase>('confirmar');
  const [desenlace, setDesenlace] = useState<Desenlace | null>(null);
  const tituloResultado = useRef<HTMLHeadingElement>(null);

  // Al pasar de «en curso» a «resultado» el contenido cambia entero bajo el mismo diálogo: sin
  // mover el foco, quien navega con teclado se queda sobre un botón que ya no significa lo mismo.
  useEffect(() => {
    if (fase === 'resultado') tituloResultado.current?.focus();
  }, [fase]);

  const ejecutar = async (idsEmision: string[], idsCorreo: string[]) => {
    setFase('enviando');
    const salida: Desenlace = { emision: null, correo: null, falloEmision: null, falloCorreo: null };

    if (idsEmision.length > 0) {
      try {
        salida.emision = await api.post<SiigoBandejaRespuestaReintento>(
          '/siigo/bandeja/reintentar', { facturaIds: idsEmision },
        );
      } catch (e) {
        salida.falloEmision = falloDe(e, idsEmision.length);
      }
    }
    if (idsCorreo.length > 0) {
      try {
        salida.correo = await api.post<SiigoBandejaRespuestaCorreo>(
          '/siigo/bandeja/reenviar-correo', { facturaIds: idsCorreo },
        );
      } catch (e) {
        salida.falloCorreo = falloDe(e, idsCorreo.length);
      }
    }
    setDesenlace(salida);
    setFase('resultado');
  };

  const cerrar = () => {
    if (desenlace) onTerminado(anuncioDe(desenlace));
    onCerrar();
  };

  return (
    <FlitModal title="Reintentar en lote" onClose={cerrar} wide restoreFocusRef={restoreFocusRef}>
      {fase === 'confirmar' && (
        <Confirmacion
          previa={previa}
          onCancelar={cerrar}
          onConfirmar={() => ejecutar(previa.emision.facturaIds, previa.correo.facturaIds)}
        />
      )}
      {fase === 'enviando' && (
        <div role="status" className="flex flex-col gap-2 text-sm" style={{ color: 'var(--flit-text-primary)' }}>
          <p className="font-semibold">Reintentando…</p>
          {previa.emision.facturaIds.length > 0 && <p>Enviando {previa.emision.facturaIds.length} a la cola de emisión.</p>}
          {previa.correo.facturaIds.length > 0 && <p>Reenviando {previa.correo.facturaIds.length} correos… (esto sí espera respuesta)</p>}
          <p style={{ color: 'var(--flit-text-secondary)' }}>
            No cierres esta ventana: aquí se ve qué pasó con cada uno.
          </p>
        </div>
      )}
      {fase === 'resultado' && desenlace && (
        <Resultado
          desenlace={desenlace}
          tituloRef={tituloResultado}
          onCerrar={cerrar}
          onReintentarFallidos={(e, c) => ejecutar(e, c)}
        />
      )}
    </FlitModal>
  );
}

function falloDe(e: unknown, casos: number): FalloBloque {
  const sinRespuesta = e instanceof ApiError && e.status === 0;
  return { mensaje: errorMessage(e), sinRespuesta, casos };
}

function anuncioDe(d: Desenlace): string {
  const partes: string[] = [];
  if (d.emision) partes.push(`${d.emision.resumen.encolados} casos volvieron a la cola`);
  if (d.correo) partes.push(`${d.correo.resumen.enviados} correos enviados`);
  if (d.falloEmision) partes.push('el reintento de la emisión falló');
  if (d.falloCorreo) partes.push('el reenvío de correo falló');
  return partes.length > 0 ? `${partes.join(', ')}.` : 'No se ejecutó ninguna acción.';
}

// ── Fase 1 · la previsualización ────────────────────────────────────────────

function Confirmacion(
  { previa, onCancelar, onConfirmar }:
  { previa: ReturnType<typeof previsualizarLote>; onCancelar: () => void; onConfirmar: () => void },
) {
  return (
    <div className="flex flex-col gap-4">
      {/* El número de esta frase y el del botón son LA MISMA VARIABLE. Si difieren, es un bug. */}
      <p className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
        Se van a intentar {previa.aIntentar} de los {previa.seleccionados} seleccionados.
      </p>

      {previa.emision.casos.length > 0 && (
        <Bloque
          titulo={`${previa.emision.casos.length} · Reintentar la emisión`}
          nota="Vuelven a la cola. La factura sale sola en los próximos minutos: el resultado no se sabe al cerrar esta ventana."
          etiquetas={previa.emision.casos.map((c) => c.etiqueta)}
        />
      )}
      {previa.correo.casos.length > 0 && (
        <Bloque
          titulo={`${previa.correo.casos.length} · Reenviar el correo al cliente`}
          nota="Se envía ahora mismo y aquí se ve qué pasó con cada uno."
          etiquetas={previa.correo.casos.map((c) => c.etiqueta)}
        />
      )}

      {/* «Quedan fuera», NUNCA «se descartan»: esa palabra es la de dar por perdido. */}
      {previa.totalFuera > 0 && (
        <>
          <p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
            {previa.totalFuera} quedan fuera de este lote. No se les hace nada:
          </p>
          <Exclusiones titulo="⊘ No se arreglan reintentando" casos={previa.noSirveReintentar} />
          <Exclusiones titulo="⚑ Ya están dados por perdidos" casos={previa.descartados} />
          <Exclusiones titulo="⚖ Los rechazó la DIAN: se corrigen" casos={previa.dian} />
          <Exclusiones titulo="⏳ Pasan del tope de este lote" casos={previa.fueraDeTope} />
        </>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onCancelar} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>
          Cancelar
        </button>
        <button type="button" onClick={onConfirmar} className={flitBtnPrimary} style={flitBtnPrimaryStyle}>
          Reintentar {previa.aIntentar} casos
        </button>
      </div>
    </div>
  );
}

function Bloque({ titulo, nota, etiquetas }: { titulo: string; nota: string; etiquetas: string[] }) {
  return (
    <div className="rounded-[10px] p-3" style={{ background: 'var(--flit-bg-app)' }}>
      <p className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>{titulo}</p>
      <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{nota}</p>
      <ListaEtiquetas etiquetas={etiquetas} />
    </div>
  );
}

/**
 * Los desplegables nacen ABIERTOS. Lo que el AC4 quiere evitar es la sorpresa, y una sorpresa
 * plegada sigue siendo una sorpresa.
 */
function Exclusiones({ titulo, casos }: { titulo: string; casos: ExclusionLote[] }) {
  // Un cubo con cero no se pinta: la ausencia no necesita rótulo.
  if (casos.length === 0) return null;
  return (
    <details open className="rounded-[10px] p-3" style={{ background: 'var(--flit-bg-app)' }}>
      <summary className="flit-focus cursor-pointer text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
        {titulo} ({casos.length})
      </summary>
      <ul className="mt-2 flex max-h-32 flex-col gap-1 overflow-y-auto">
        {casos.map((c) => (
          <li key={c.clave} className="text-xs" style={{ color: 'var(--flit-text-primary)' }}>
            <strong>{c.etiqueta}</strong> — {c.motivo}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Alto máximo y desplazamiento propio: cien identificadores no pueden empujar los botones fuera. */
function ListaEtiquetas({ etiquetas }: { etiquetas: string[] }) {
  return (
    <p className="mt-2 max-h-32 overflow-y-auto text-xs" style={{ color: 'var(--flit-text-primary)' }}>
      {etiquetas.join('  ·  ')}
    </p>
  );
}

// ── Fase 4 · el resultado ───────────────────────────────────────────────────

function Resultado(
  { desenlace, tituloRef, onCerrar, onReintentarFallidos }:
  { desenlace: Desenlace; tituloRef: RefObject<HTMLHeadingElement>; onCerrar: () => void;
    onReintentarFallidos: (emision: string[], correo: string[]) => void },
) {
  const { emision, correo, falloEmision, falloCorreo } = desenlace;

  const emisionFallidos = (emision?.items ?? []).filter((i) => i.resultado === 'error').map((i) => i.facturaId);
  const correoFallidos = (correo?.items ?? [])
    .filter((i) => i.resultado === 'fallido' || i.resultado === 'error').map((i) => i.facturaId);
  const hayQueReintentar = emisionFallidos.length + correoFallidos.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <h3
        ref={tituloRef}
        tabIndex={-1}
        className="text-base font-bold outline-none"
        style={{ color: 'var(--flit-text-primary)' }}
      >
        Reintento en lote · resultado
      </h3>

      {/* Lo que exige que alguien actúe va ARRIBA. El éxito no se lee, se comprueba de un vistazo. */}
      <Fallo bloque="el reintento de la emisión" fallo={falloEmision} />
      <Fallo bloque="el reenvío de correo" fallo={falloCorreo} />

      {correo && (
        <GrupoResultado
          orden={['fallido', 'error', 'descartado_datos', 'no_realizado', 'enviado']}
          por={correo.resumen.porResultado}
          etiqueta={(r) => SIIGO_BANDEJA_RESULTADO_CORREO_ETIQUETA[r as keyof typeof SIIGO_BANDEJA_RESULTADO_CORREO_ETIQUETA]}
          prefijo="Correo"
        />
      )}
      {emision && (
        <GrupoResultado
          orden={['error', 'descartado_datos', 'no_aplica', 'fallido_definitivo', 'ya_en_cola', 'ya_enviado', 'encolado', 'reactivado']}
          por={emision.resumen.porResultado}
          etiqueta={(r) => SIIGO_BANDEJA_RESULTADO_ETIQUETA[r as keyof typeof SIIGO_BANDEJA_RESULTADO_ETIQUETA]}
          prefijo="Emisión"
        />
      )}

      {emision && emision.resumen.encolados > 0 && (
        <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          Los que volvieron a la cola salen solos en los próximos minutos. <strong>Todavía no están
          emitidos</strong>: su desenlace aparecerá en esta bandeja si vuelve a fallar.
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        {hayQueReintentar && (
          <button
            type="button"
            onClick={() => onReintentarFallidos(emisionFallidos, correoFallidos)}
            className={flitBtnSecondary}
            style={flitBtnSecondaryStyle}
          >
            Reintentar los {emisionFallidos.length + correoFallidos.length} que fallaron
          </button>
        )}
        <button type="button" onClick={onCerrar} className={flitBtnPrimary} style={flitBtnPrimaryStyle}>
          Cerrar
        </button>
      </div>
    </div>
  );
}

/**
 * El fallo de una petición COMPLETA.
 *
 * El caso sin respuesta es el único sin botón de reintento, y es deliberado: reintentar a ciegas es
 * justo lo que hay que evitar. Una interfaz que empuja a repetir una operación que no sabe si
 * ocurrió enseña a desconfiar de sí misma.
 */
function Fallo({ bloque, fallo }: { bloque: string; fallo: FalloBloque | null }) {
  if (!fallo) return null;
  return (
    <p role="alert" className="rounded-[10px] p-3 text-sm" style={{ background: '#FBE4E2', color: 'var(--flit-text-primary)' }}>
      {fallo.sinRespuesta
        ? `No hubo respuesta del servidor en ${bloque}. Puede que sí se haya registrado: cierra y mira la bandeja antes de volver a intentarlo.`
        : `No se ejecutó ${bloque}: ${fallo.mensaje}. No se tocó ninguno de los ${fallo.casos} de ese bloque.`}
    </p>
  );
}

function GrupoResultado(
  { orden, por, etiqueta, prefijo }:
  { orden: string[]; por: Record<string, number>; etiqueta: (r: string) => string; prefijo: string },
) {
  const conCasos = orden.filter((r) => (por[r] ?? 0) > 0);
  // Los grupos con cero no se pintan.
  if (conCasos.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {conCasos.map((r) => (
        <li key={r} className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
          <strong>{por[r]}</strong> · {prefijo}: {etiqueta(r)}
        </li>
      ))}
    </ul>
  );
}
