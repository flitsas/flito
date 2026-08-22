// Envío a facturación — si la factura sale por correo al cliente, y a qué direcciones (HU #11709).
//
// Es la mitad visible de la HU #11708, que convirtió el correo en una ELECCIÓN de cada envío. Hasta
// entonces se deducía del ambiente: en producción salía siempre. Ahora el servidor lee `correo` del
// cuerpo y, si no viene, entiende que nadie lo pidió — deja acta `no_solicitado` y no manda nada.
// Mientras esta pantalla no exista, ninguna factura nueva sale por correo. De ahí que las dos vayan
// juntas a producción.
//
// TRES DECISIONES QUE SOSTIENEN EL COMPONENTE
//
//   1. **La elección por omisión no depende de ninguna petición.** Nace en `CORREO_POR_OMISION`
//      —marcada, sin direcciones—, que es exactamente «mándala por correo a lo que diga la ficha de
//      cada cliente», resuelto por el servidor en el momento de emitir. Lo que se carga aquí solo
//      REVELA a qué direcciones iría (AC1) y descubre los dos casos que cambian la elección: el
//      ambiente no productivo (AC3) y el cliente sin correo (AC5). Así, alguien que envía mientras
//      la consulta viaja obtiene el comportamiento correcto, no el silencio.
//   2. **Deshabilitada y explicada, nunca ausente** (AC3). Una casilla que desaparece fuera de
//      producción hace creer que el correo saldrá igual; el envío es el mismo, lo que cambia es que
//      no sale ni un correo. Se dice con el motivo a la vista.
//   3. **Un cliente sin correo no es un error** (AC5). La opción queda desmarcada con su motivo y el
//      trámite se envía a facturación igual: la factura ante la DIAN no depende del correo, y para
//      el correo queda el reenvío manual, que ya existe.
//
// LO QUE NO SE OFRECE AQUÍ: el timbre ante la DIAN. Sigue derivándose del ambiente a propósito
// (`facturacion.correo.ts`): un interruptor apagado en producción produciría facturas que en FLITO
// figuran emitidas y ante la DIAN no existen.
//
// Ninguna dirección viaja en la URL del SPA ni acaba en consola (AGENTS.md §14): la elección va en
// el CUERPO del `POST`, y los mensajes de error señalan la POSICIÓN de la dirección que falla, no su
// valor — la misma regla que el servidor aplica en su acta.

import { useEffect, useMemo, useState } from 'react';
import { SIIGO_ENVIO_MAX_DESTINATARIOS } from '@operaciones/shared-types';
import { api, errorMessage } from '../../lib/api';
import { inputCls } from '../siigo/estilos';
import { flitBtnSecondarySm } from '../flit/flitPageKit';
import type { EmpresaDelEnvio } from './EmisionPorEmpresa';

/** Lo que el envío elige sobre el correo. Espeja `SiigoCorreoElegido` del cuerpo del `POST`. */
export interface EleccionCorreo {
  enviar: boolean;
  /** Direcciones escritas. **Vacío no es «a nadie»**: es «las que diga la ficha del cliente». */
  destinatarios: string[];
}

/**
 * Marcada y sin direcciones (AC1). Vale antes de que cargue nada y es el caso normal: el servidor
 * resuelve la ficha de cada cliente al emitir, que es más tarde y más fiel que leerla ahora.
 */
export const CORREO_POR_OMISION: EleccionCorreo = { enviar: true, destinatarios: [] };

/** El mismo patrón que la ficha fiscal (`FichaFiscal.tsx`). El servidor revalida con Zod. */
const CORREO_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** `z.string().email().max(150)` en `facturacion.routes.ts`. */
const LARGO_MAXIMO = 150;

/** Una dirección utilizable. Vacía no lo es, pero tampoco es un error: es una fila sin rellenar. */
function esCorreoValido(valor: string): boolean {
  const limpio = valor.trim();
  return limpio.length <= LARGO_MAXIMO && CORREO_RE.test(limpio);
}

/**
 * Qué impide continuar (AC2). Devuelve el texto o `null`.
 *
 * Vive aquí —y no en el diálogo— porque la regla tiene que ser UNA: el mismo módulo que pinta las
 * filas decide si esa lista se puede mandar. El mensaje nombra la POSICIÓN y nunca la dirección.
 *
 * Las repetidas se paran también: Siigo las cuenta contra el tope de cinco y el cliente recibe dos
 * veces el mismo documento. El servidor las rechaza al emitir (`destinatario_repetido`), pero
 * enterarse media hora después, en un acta, no ayuda a quien las acaba de pegar.
 */
export function problemaDelCorreo(v: EleccionCorreo): string | null {
  if (!v.enviar) return null;
  const vistas = new Set<string>();
  for (let i = 0; i < v.destinatarios.length; i += 1) {
    const limpio = (v.destinatarios[i] ?? '').trim();
    if (limpio === '') continue;
    if (!esCorreoValido(limpio)) {
      return `La dirección ${i + 1} no tiene formato de correo. Corrígela o quítala para continuar.`;
    }
    if (vistas.has(limpio.toLowerCase())) {
      return `La dirección ${i + 1} está repetida. Siigo la contaría dos veces y el cliente `
        + 'recibiría la factura por duplicado.';
    }
    vistas.add(limpio.toLowerCase());
  }
  if (v.destinatarios.filter((d) => d.trim() !== '').length > SIIGO_ENVIO_MAX_DESTINATARIOS) {
    return `Siigo admite ${SIIGO_ENVIO_MAX_DESTINATARIOS} direcciones por factura como máximo.`;
  }
  return null;
}

/** Lo que se manda en el cuerpo: sin espacios ni filas a medio escribir, y nada si no se pidió. */
export function destinatariosParaEnviar(v: EleccionCorreo): string[] {
  if (!v.enviar) return [];
  return v.destinatarios.map((d) => d.trim()).filter((d) => d !== '');
}

/** Del padrón solo se mira el correo de la compañía: es lo único que `/clients` entrega y usamos. */
interface ClienteDelPadron { id: number; email: string | null }

/**
 * `correos: null` significa «no se pudo leer su ficha», que NO es lo mismo que «no tiene correo».
 *
 * `GET /clients` entrega el padrón por tramos, así que un cliente que caiga fuera del tramo no
 * aparece. Tratar esa ausencia como «sin correo» apagaría la casilla por un dato que no se llegó a
 * mirar — un estado leído como otro, que es justo lo que el AC3 y el AC5 previenen.
 */
interface FichaDelEnvio { clienteId: number; nombre: string; correos: string[] | null }

interface Cargado { ambiente: string; fichas: FichaDelEnvio[] }

/**
 * Las direcciones que la ficha resuelve, con la MISMA regla que el servidor.
 *
 * Hoy es solo el correo de la compañía (decisión D-3 del diseño, `resolverDestinatarios`). El correo
 * del contacto fiscal existe en la ficha desde la HU #11292 y si debe recibirlo también es una
 * pregunta de contabilidad sin responder; el día que se responda, se responde en el servidor y aquí
 * se copia — no al revés.
 */
function correosDeLaFicha(ficha: ClienteDelPadron): string[] {
  const correo = (ficha.email ?? '').trim();
  return correo === '' ? [] : [correo];
}

interface Props {
  empresas: EmpresaDelEnvio[];
  valor: EleccionCorreo;
  onCambio: (v: EleccionCorreo) => void;
  /**
   * La elección que se deduce de lo cargado. El diálogo la aplica UNA sola vez: volver al paso 1
   * después de haber estado en el 2 no puede borrar lo que alguien escribió.
   */
  onSemilla: (v: EleccionCorreo) => void;
}

export default function CorreoDelEnvio({ empresas, valor, onCambio, onSemilla }: Props) {
  const [datos, setDatos] = useState<Cargado | null>(null);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<string | null>(null);
  /** Sube con cada «Reintentar». Es lo que vuelve a disparar la carga sin cerrar el diálogo (AC4). */
  const [intento, setIntento] = useState(0);

  const clienteIds = useMemo(() => empresas.map((e) => e.clienteId).join(','), [empresas]);

  useEffect(() => {
    let vivo = true;
    const cargar = async () => {
      setCargando(true);
      setFallo(null);
      try {
        // El ambiente lo dice el SERVIDOR y sin parámetro, como en la pestaña de terceros: es el
        // único contra el que se emite. Preguntarlo con un ambiente elegido aquí contestaría sobre
        // una configuración que este envío no va a usar.
        const [compuerta, padron] = await Promise.all([
          api.get<{ ambiente: string }>('/siigo/compuerta'),
          api.get<ClienteDelPadron[]>('/clients?limit=500'),
        ]);
        if (!vivo) return;
        const porId = new Map(padron.map((c) => [c.id, c]));
        const fichas = empresas.map((e) => {
          const ficha = porId.get(e.clienteId);
          return {
            clienteId: e.clienteId,
            nombre: e.nombre,
            correos: ficha ? correosDeLaFicha(ficha) : null,
          };
        });
        setDatos({ ambiente: compuerta.ambiente, fichas });
        onSemilla(semillaDe(compuerta.ambiente, fichas));
      } catch (e) {
        if (vivo) setFallo(errorMessage(e));
      } finally {
        if (vivo) setCargando(false);
      }
    };
    void cargar();
    return () => { vivo = false; };
    // `empresas` y las callbacks quedan fuera a propósito: lo que identifica esta carga es QUÉ
    // clientes hay, y `clienteIds` ya es esa identidad en forma estable. Incluirlas reejecutaría en
    // cada render y volvería a sembrar sobre lo que alguien acaba de escribir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clienteIds, intento]);

  const noProductivo = datos !== null && datos.ambiente !== 'produccion';
  const conocidas = datos?.fichas.filter((f) => f.correos !== null) ?? [];
  const sinNingunCorreo = datos !== null && datos.fichas.length > 0
    && conocidas.length === datos.fichas.length
    && conocidas.every((f) => (f.correos ?? []).length === 0);
  /**
   * Solo se editan direcciones con UNA empresa en la selección, y no es una limitación técnica.
   *
   * La lista viaja para todo el envío (así lo guarda el lote): con dos empresas, escribir
   * direcciones concretas mandaría la factura de cada una a las direcciones de la otra. Con varias,
   * cada factura sale a las de SU ficha —`destinatarios` vacío— y eso es lo que se muestra.
   */
  const editable = datos !== null && !noProductivo && empresas.length === 1
    && (datos.fichas[0]?.correos ?? null) !== null;

  const problema = problemaDelCorreo(valor);
  const cambiarDireccion = (i: number, texto: string) => {
    onCambio({ ...valor, destinatarios: valor.destinatarios.map((d, j) => (j === i ? texto : d)) });
  };

  return (
    <fieldset className="rounded-lg border p-3" style={{ borderColor: 'var(--flit-border-input)' }}>
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide"
        style={{ color: 'var(--flit-text-muted)' }}>Correo al cliente</legend>

      <label htmlFor="correo-enviar" className="flex items-center gap-2 text-sm"
        style={{ color: 'var(--flit-text-secondary)' }}>
        <input
          id="correo-enviar"
          type="checkbox"
          className="flit-focus"
          checked={valor.enviar}
          disabled={noProductivo}
          onChange={(e) => onCambio({ ...valor, enviar: e.target.checked })}
        />
        Enviar la factura por correo al cliente
      </label>

      {cargando && (
        <p role="status" className="mt-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          Buscando a qué direcciones iría…
        </p>
      )}

      {/* AC4 — el fallo se reintenta SIN cerrar el diálogo, y mientras tanto se dice qué pasará: la
          elección por omisión sigue siendo válida porque no dependía de esta consulta. */}
      {!cargando && fallo !== null && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span role="alert" style={{ color: 'var(--flit-danger-ink)' }}>
            No se pudo consultar a qué direcciones iría: {fallo}. La factura saldrá igual por correo
            a lo que diga la ficha de cada cliente al emitirse.
          </span>
          <button type="button" className={flitBtnSecondarySm} style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}
            onClick={() => setIntento((n) => n + 1)}>
            Reintentar
          </button>
        </div>
      )}

      {/* AC3 — fuera de producción se explica, no se esconde. */}
      {noProductivo && (
        <p className="mt-2 text-xs" style={{ color: 'var(--flit-text-primary)' }}>
          En el ambiente <strong>{datos?.ambiente}</strong> la factura se crea en Siigo pero no sale
          ningún correo al cliente. El correo solo se manda desde producción.
        </p>
      )}

      {/* AC5 — sin correo en la ficha no hay error: hay una casilla desmarcada y un motivo. */}
      {!noProductivo && sinNingunCorreo && (
        <p className="mt-2 text-xs" style={{ color: 'var(--flit-text-primary)' }}>
          {conocidas.length === 1
            ? `La ficha de ${conocidas[0]?.nombre} no tiene ningún correo registrado.`
            : 'Ninguna de las fichas de estas empresas tiene un correo registrado.'}
          {' '}Puedes enviar el trámite a facturación igual: la factura se emitirá y, cuando alguien
          complete el correo en la ficha, queda el reenvío manual.
        </p>
      )}

      {/* AC1 — a qué direcciones iría, tomadas de la ficha. */}
      {datos !== null && !sinNingunCorreo && !editable && (
        <ul className="mt-2 space-y-1 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
          {datos.fichas.map((f) => (
            <li key={f.clienteId}>
              <span className="font-semibold">{f.nombre}</span>:{' '}
              {f.correos === null
                ? 'no se pudo leer su ficha; se usará lo que tenga al emitirse'
                : (f.correos.length === 0 ? 'sin correo en su ficha' : f.correos.join(', '))}
            </li>
          ))}
        </ul>
      )}

      {datos !== null && !editable && empresas.length > 1 && valor.enviar && (
        <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
          Cada factura sale a las direcciones de su propia ficha. Para elegir direcciones concretas,
          envía una empresa a la vez.
        </p>
      )}

      {/* AC2 — con una empresa, las direcciones se editan y viaja exactamente lo que quede. */}
      {editable && valor.enviar && (
        <div className="mt-2 space-y-2">
          {valor.destinatarios.map((direccion, i) => {
            const id = `correo-destinatario-${i}`;
            const invalido = direccion.trim() !== '' && !esCorreoValido(direccion);
            return (
              <div key={id} className="flex flex-wrap items-end gap-2">
                <div className="min-w-[16rem] flex-1">
                  <label htmlFor={id} className="mb-1 block text-xs font-semibold"
                    style={{ color: 'var(--flit-text-muted)' }}>
                    Dirección {i + 1}
                  </label>
                  <input
                    id={id}
                    type="email"
                    className={inputCls}
                    value={direccion}
                    aria-invalid={invalido}
                    aria-describedby={invalido ? `${id}-error` : undefined}
                    onChange={(e) => cambiarDireccion(i, e.target.value)}
                  />
                  {invalido && (
                    <p id={`${id}-error`} className="mt-1 text-xs" style={{ color: 'var(--flit-danger-ink)' }}>
                      No tiene formato de correo.
                    </p>
                  )}
                </div>
                <button type="button" className={flitBtnSecondarySm}
                  style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}
                  onClick={() => onCambio({
                    ...valor, destinatarios: valor.destinatarios.filter((_, j) => j !== i),
                  })}>
                  Quitar la dirección {i + 1}
                </button>
              </div>
            );
          })}

          <button type="button" className={flitBtnSecondarySm}
            style={{ borderColor: 'var(--flit-border-input)', color: 'var(--flit-text-secondary)' }}
            disabled={valor.destinatarios.length >= SIIGO_ENVIO_MAX_DESTINATARIOS}
            onClick={() => onCambio({ ...valor, destinatarios: [...valor.destinatarios, ''] })}>
            Añadir dirección
          </button>

          <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
            {valor.destinatarios.length === 0
              ? 'Sin ninguna dirección no saldrá ningún correo; quedará el reenvío manual.'
              : `Salen de la ficha del cliente y se envía exactamente a las que dejes aquí. Siigo `
                + `admite ${SIIGO_ENVIO_MAX_DESTINATARIOS} como máximo.`}
          </p>
        </div>
      )}

      {/* AC6 — el problema se anuncia, no solo se pinta: `role="alert"` lo lee el lector de pantalla
          en cuanto aparece, y el botón de continuar queda bloqueado mientras esté. */}
      {problema !== null && (
        <p role="alert" className="mt-2 text-xs font-semibold" style={{ color: 'var(--flit-danger-ink)' }}>
          {problema}
        </p>
      )}
    </fieldset>
  );
}

/**
 * La elección que se deduce de lo cargado (AC1, AC3, AC5).
 *
 * Fuera de una empresa única no se siembran direcciones: `destinatarios` vacío manda cada factura a
 * la ficha de SU cliente, que es lo que se está mostrando. Y sin ningún correo en las fichas, la
 * casilla se desmarca — pedir un correo que no tiene a dónde ir solo produciría un acta de que no
 * salió.
 */
function semillaDe(ambiente: string, fichas: FichaDelEnvio[]): EleccionCorreo {
  const conocidas = fichas.filter((f) => f.correos !== null);
  // Sin ninguna empresa identificada no se deduce nada: «no hay fichas» no es «no hay correos».
  const sinNingunCorreo = fichas.length > 0 && conocidas.length === fichas.length
    && conocidas.every((f) => (f.correos ?? []).length === 0);
  if (sinNingunCorreo) return { enviar: false, destinatarios: [] };
  // En un ambiente que no manda correos NO se siembran direcciones: se guardarían en el lote datos
  // personales para un correo que nadie va a mandar (Ley 1581, minimización). La casilla sigue
  // marcada y deshabilitada, así que el acta dirá «en este ambiente no se manda correo a nadie»,
  // que es la verdad, en vez de «no se solicitó», que sería otra cosa.
  if (ambiente !== 'produccion') return { enviar: true, destinatarios: [] };
  const unica = fichas.length === 1 ? fichas[0] : undefined;
  if (unica && unica.correos !== null && unica.correos.length > 0) {
    return { enviar: true, destinatarios: unica.correos };
  }
  return { enviar: true, destinatarios: [] };
}
