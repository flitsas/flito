// Reporte de costos — el diálogo de envío a facturación electrónica (HU #11329).
//
// **El mismo componente para la fila y para el lote** (AC7): una fila es una selección de uno.
// Cuatro fases —confirmar, enviando, fallo de la petición, resultado— que son los cuatro estados de
// esta superficie.
//
// **Volver a pulsar no duplica** (AC6), y se resuelve dos veces: aquí, porque el botón primario no
// acepta pulsaciones mientras hay un envío en curso; y en el servidor, que es quien de verdad
// garantiza la idempotencia y devuelve `ya_en_cola` / `ya_enviado`.
//
// **`FlitModal` no sabe impedir su cierre** (queda anotado como diferido en la especificación):
// cerrar mientras el `POST` viaja pierde el detalle por trámite, aunque el envío se complete igual
// en el servidor. La mitigación de esta HU es el copy «No cierres esta ventana» más la región
// `aria-live` de la página con el resumen.

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ConceptoFacturable,
  MotivoElegibilidad, SiigoEnvioTramite, SiigoRespuestaEnvio, SiigoResumenEnvio,
} from '@operaciones/shared-types';
import { CONCEPTOS_FACTURABLES, CONCEPTO_FACTURABLE_LABEL } from '@operaciones/shared-types';
import { ApiError, api, errorMessage } from '../../lib/api';
import FlitModal from '../flit/FlitModal';
import { flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle } from '../flit/flitPageKit';
import ResultadoEnvio from './ResultadoEnvio';
import EmisionPorEmpresa, {
  faltantesDe,
  type Elemento as ElementoComprobante,
  type EmisionEmpresa,
  type EmpresaDelEnvio,
} from './EmisionPorEmpresa';

/**
 * Espeja `TOPE_TRAMITES_ENVIO` de `facturacion.encolado.service.ts`. Con `pageSize = 50` es
 * inalcanzable desde esta pantalla; se comprueba igual, porque si algún día la página crece el
 * fallo sería un 400 críptico en mitad de un cierre de mes.
 */
export const TOPE_ENVIO = 200;

export interface TramiteDelEnvio {
  tramiteId: string;
  idFlit: string;
  /** De quién es. `null` = sin compañía, que ya lo hace no elegible. Lo usa el paso 2 (A4). */
  clienteId?: number | null;
  empresa?: string | null;
}

interface Props {
  /** Los elegibles que se van a enviar. Nunca vacío: el botón que abre esto no existe con 0. */
  tramites: TramiteDelEnvio[];
  /** Lo seleccionado que NO se enviará, con sus motivos literales del servidor. */
  excluidos: (TramiteDelEnvio & { motivos: MotivoElegibilidad[] })[];
  puedeReactivar: boolean;
  idFlitDe: (tramiteId: string) => string;
  /** El parche inmediato de las filas, en cuanto llega el 202 (AC5). */
  onEncolados: (items: SiigoEnvioTramite[]) => void;
  onCerrar: (resumen: SiigoResumenEnvio | null) => void;
}

type Fase = 'confirmar' | 'emision' | 'enviando' | 'fallo' | 'resultado';

/**
 * Tres situaciones distintas y tres mensajes distintos: confundirlas hace que alguien vuelva a
 * enviar algo que ya salió.
 *
 * **Sin respuesta es el único caso en el que no se ofrece reintentar**, y es deliberado: reintentar
 * a ciegas es justo lo que el AC6 quiere evitar. La idempotencia del servidor protegería
 * (`ya_en_cola`), pero una interfaz que empuja a repetir una operación que no sabe si ocurrió es una
 * interfaz que enseña a desconfiar de sí misma.
 */
function traducirFallo(e: unknown): { mensaje: string; reintentable: boolean } {
  const status = e instanceof ApiError ? e.status : -1;
  if (status === 0) {
    return {
      mensaje: 'No hubo respuesta del servidor. Puede que el envío sí se haya registrado. Cierra '
        + 'esta ventana y revisa la columna «Factura DIAN» antes de volver a enviar.',
      reintentable: false,
    };
  }
  if (status === 503) {
    return {
      mensaje: `La facturación electrónica está frenada ahora mismo: ${errorMessage(e)}. No se `
        + 'encoló ningún trámite. Cuando se reactive, vuelve a intentarlo.',
      reintentable: true,
    };
  }
  if (status === 429) {
    return {
      mensaje: 'Demasiados envíos seguidos. Espera un minuto y vuelve a intentarlo. No se encoló '
        + 'ningún trámite.',
      reintentable: true,
    };
  }
  return { mensaje: `El envío no se realizó: ${errorMessage(e)}.`, reintentable: true };
}

export default function DialogoEnvioFacturacion({
  tramites, excluidos, puedeReactivar, idFlitDe, onEncolados, onCerrar,
}: Props) {
  const [fase, setFase] = useState<Fase>('confirmar');
  const [fallo, setFallo] = useState<{ mensaje: string; reintentable: boolean } | null>(null);
  const [salida, setSalida] = useState<SiigoRespuestaEnvio | null>(null);
  const ultimo = useRef<{ ids: string[]; reactivar: boolean }>({ ids: [], reactivar: false });
  /**
   * Qué conceptos van en la factura (A1). Arranca en trámite digital porque es lo único que hoy se
   * cobra por factura electrónica: el resto se recupera por reintegro. **Arranca ahí, no se queda
   * ahí** — se puede cambiar, y esa es toda la diferencia con deducirlo de la liquidación.
   */
  const [conceptos, setConceptos] = useState<ConceptoFacturable[]>(['tramite_digital']);
  /** A4 — lo elegido en el paso 2, una entrada por empresa. Lo precarga `EmisionPorEmpresa`. */
  const [emision, setEmision] = useState<EmisionEmpresa[]>([]);
  /**
   * Los comprobantes que cargó el paso 2. Suben hasta aquí por un motivo concreto: si el
   * comprobante elegido exige centro de costo, ese campo pasa a ser obligatorio, y sin el catálogo
   * no hay forma de saberlo. Validar «completo» sin esto dejaría pasar envíos que Siigo rechaza.
   */
  const [comprobantes, setComprobantes] = useState<ElementoComprobante[]>([]);

  /**
   * Las empresas de la selección, con cuántos trámites aporta cada una.
   *
   * Se agrupa aquí y no en el servidor porque la pantalla ya tiene el dato: el veredicto de
   * elegibilidad trae la compañía de cada trámite desde A2. Los que no la tengan no llegan hasta
   * aquí —«sin compañía» es motivo de exclusión—, pero se filtran igual: un `null` agrupado
   * produciría una fila fantasma con un desplegable que no significa nada.
   */
  const empresas = useMemo<EmpresaDelEnvio[]>(() => {
    const porId = new Map<number, EmpresaDelEnvio>();
    for (const t of tramites) {
      if (typeof t.clienteId !== 'number') continue;
      const ya = porId.get(t.clienteId);
      if (ya) ya.tramites += 1;
      else porId.set(t.clienteId, { clienteId: t.clienteId, nombre: t.empresa ?? `Cliente ${t.clienteId}`, tramites: 1 });
    }
    return [...porId.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  }, [tramites]);

  /**
   * Las empresas a las que todavía les falta algo para poder emitir.
   *
   * Mientras el paso 2 carga no hay ni valores ni catálogos, y todas parecerían incompletas. Se
   * consideran completas hasta que haya con qué juzgarlas: un botón apagado durante la carga se lee
   * como «esto no se puede enviar», no como «espera».
   */
  const incompletas = useMemo(() => {
    if (emision.length === 0) return [];
    return empresas.filter((e) => {
      const v = emision.find((x) => x.clienteId === e.clienteId);
      return faltantesDe(v, comprobantes).length > 0;
    });
  }, [empresas, emision, comprobantes]);

  const encabezadoRef = useRef<HTMLHeadingElement>(null);

  // El contenido cambia entero bajo el mismo diálogo: sin esto el foco se queda en un botón que ya
  // no significa lo mismo.
  useEffect(() => { if (fase === 'resultado') encabezadoRef.current?.focus(); }, [fase]);

  async function enviar(ids: string[], reactivar: boolean) {
    if (ids.length === 0) return;
    if (conceptos.length === 0) {
      setFallo({ mensaje: 'Elige al menos un concepto: una factura sin líneas no es una factura.', reintentable: false });
      setFase('fallo');
      return;
    }
    if (ids.length > TOPE_ENVIO) {
      setFallo({ mensaje: `Puedes enviar hasta ${TOPE_ENVIO} trámites de una vez. Selecciona menos.`, reintentable: false });
      setFase('fallo');
      return;
    }
    ultimo.current = { ids, reactivar };
    setFase('enviando');
    try {
      // El cuerpo es `.strict()` en el servidor: `tramiteIds`, `conceptos`, `emision` y, solo al
      // reactivar, `reactivar`. Nada más — ni `ambiente`, que el servidor rechaza con un 400.
      //
      // `emision` viaja SIEMPRE y con todas las empresas. Antes se filtraban las que no habían
      // elegido nada, porque el servidor las resolvía contra la configuración global; esa
      // configuración ya no existe, así que una empresa ausente es un lote que no se podrá emitir.
      // El botón no deja llegar aquí sin completarlas.
      const cuerpo = { tramiteIds: ids, conceptos, emision };
      const r = await api.post<SiigoRespuestaEnvio>(
        '/siigo/facturacion', reactivar ? { ...cuerpo, reactivar: true } : cuerpo,
      );
      setSalida(r);
      // Antes de pintar: las filas afectadas pasan a «En cola» sin recargar nada.
      onEncolados(r.items);
      setFase('resultado');
    } catch (e) {
      setFallo(traducirFallo(e));
      setFase('fallo');
    }
  }

  const cerrar = () => onCerrar(salida?.resumen ?? null);
  const enResultado = fase === 'resultado';

  return (
    <FlitModal wide onClose={cerrar}
      title={enResultado
        ? 'Envío a facturación electrónica · resultado'
        : 'Enviar a facturación electrónica'}>
      <div className="space-y-3 text-sm">

        {fase === 'confirmar' && (
          <>
            <p style={{ color: 'var(--flit-text-primary)' }}>
              Se van a enviar <strong>{tramites.length.toLocaleString('es-CO')}</strong> trámite(s):
            </p>
            {/* Alto máximo con desplazamiento propio: doscientos identificadores no pueden empujar
                los botones fuera de la vista. */}
            <div className="flex max-h-40 flex-wrap gap-1 overflow-y-auto rounded-lg p-2"
              style={{ background: 'var(--flit-bg-app)' }}>
              {tramites.map((t) => (
                <span key={t.tramiteId} className="rounded-[999px] bg-white px-2 py-0.5 text-xs"
                  style={{ color: 'var(--flit-text-secondary)' }}>{t.idFlit}</span>
              ))}
            </div>

            {/* A1 — qué se factura se ELIGE. A la empresa se le gestiona el trámite entero pero solo
                se le factura electrónicamente una parte; el resto va por reintegro. Es una decisión
                de quien envía, no una consecuencia de lo que el trámite tenga liquidado. */}
            <fieldset className="rounded-lg border p-3" style={{ borderColor: 'var(--flit-border-input)' }}>
              <legend className="px-1 text-xs font-semibold uppercase tracking-wide"
                style={{ color: 'var(--flit-text-muted)' }}>Conceptos que van en la factura</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {CONCEPTOS_FACTURABLES.map((c) => (
                  <label key={c} className="flex items-center gap-2 text-sm"
                    style={{ color: 'var(--flit-text-secondary)' }}>
                    <input
                      type="checkbox"
                      checked={conceptos.includes(c)}
                      onChange={() => setConceptos((prev) => (
                        prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]
                      ))}
                    />
                    {CONCEPTO_FACTURABLE_LABEL[c]}
                  </label>
                ))}
              </div>
              <p className="mt-2 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
                Solo se facturan los conceptos marcados que además estén liquidados en cada trámite.
              </p>
            </fieldset>

            {excluidos.length > 0 && (
              // Plegado: quien confirma no necesita leerlo, y quien duda lo abre. Dentro, los
              // motivos literales del servidor, con el mismo formato que «¿Por qué no?».
              <details>
                <summary className="flit-focus cursor-pointer" style={{ color: 'var(--flit-text-secondary)' }}>
                  {excluidos.length} de los seleccionados no se enviarán
                </summary>
                <ul className="mt-2 space-y-2">
                  {excluidos.map((t) => (
                    <li key={t.tramiteId}>
                      <span className="font-semibold">{t.idFlit}</span>
                      <ul className="list-disc pl-5 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
                        {t.motivos.map((m) => <li key={m.motivo}>{m.detalle}</li>)}
                      </ul>
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
              Se emite una factura electrónica por trámite. Cuando la DIAN la acepte, corregirla es
              un proceso aparte.
            </p>

            {/* La acción irreversible va LA ÚLTIMA en el orden de foco, no la primera. */}
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                onClick={cerrar}>Cancelar</button>
              <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
                onClick={() => setFase('emision')}>
                Siguiente: con qué se emite
              </button>
            </div>
          </>
        )}

        {/* A4 — paso 2. Separado del primero y no apilado debajo: el paso 1 dice QUÉ se factura y
            el 2 CON QUÉ, y con cuatro empresas en pantalla mezclarlos convierte el diálogo en un
            formulario largo en el que la acción irreversible queda fuera de la vista. */}
        {fase === 'emision' && (
          <>
            <EmisionPorEmpresa empresas={empresas} valores={emision} onCambio={setEmision}
              onCatalogos={setComprobantes} />

            {/* Se enumeran las empresas incompletas en vez de deshabilitar el botón a secas: con
                cuatro empresas plegadas en pantalla, un botón apagado sin motivo obliga a recorrer
                los cuatro bloques buscando el hueco. */}
            {incompletas.length > 0 && (
              <p role="alert" className="text-xs" style={{ color: 'var(--flit-text-primary)' }}>
                <span aria-hidden="true" style={{ color: 'var(--flit-danger)' }}>⚠ </span>
                Falta elegir con qué emitir en: {incompletas.map((e) => e.nombre).join(', ')}.
              </p>
            )}

            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                onClick={() => setFase('confirmar')}>Atrás</button>
              <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
                disabled={incompletas.length > 0}
                onClick={() => void enviar(tramites.map((t) => t.tramiteId), false)}>
                Enviar {tramites.length.toLocaleString('es-CO')} a facturación
              </button>
            </div>
          </>
        )}

        {fase === 'enviando' && (
          <div role="status">
            <p style={{ color: 'var(--flit-text-primary)' }}>
              Enviando {ultimo.current.ids.length.toLocaleString('es-CO')} trámite(s)…
            </p>
            <p className="text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
              No cierres esta ventana: aquí se ve qué pasó con cada uno.
            </p>
            <div className="mt-3 flex justify-end">
              <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle} disabled>
                Enviando…
              </button>
            </div>
          </div>
        )}

        {fase === 'fallo' && fallo && (
          <>
            <p role="alert" style={{ color: 'var(--flit-danger)' }}>{fallo.mensaje}</p>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                onClick={cerrar}>Cerrar</button>
              {fallo.reintentable && (
                <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
                  onClick={() => void enviar(ultimo.current.ids, ultimo.current.reactivar)}>
                  Reintentar
                </button>
              )}
            </div>
          </>
        )}

        {enResultado && salida && (
          <>
            <ResultadoEnvio items={salida.items} resumen={salida.resumen} idFlitDe={idFlitDe}
              puedeReactivar={puedeReactivar} encabezadoRef={encabezadoRef}
              // Los reintentos vuelven a la fase 2 y SUSTITUYEN el resultado, no lo apilan: el que
              // se lee es siempre el del último envío.
              onReenviar={(ids, reactivar) => void enviar(ids, reactivar)} />
            <div className="flex justify-end">
              <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                onClick={cerrar}>Cerrar</button>
            </div>
          </>
        )}
      </div>
    </FlitModal>
  );
}
