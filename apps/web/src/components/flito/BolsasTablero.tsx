// Tablero de bolsas (HU #11127; reestructurado en la #11210).
//
// Una sola vista para las dos caras del mismo negocio: lo que los clientes tienen precargado con
// FLIT y lo que FLIT tiene precargado para pagar ante las secretarías. Antes vivían en pestañas
// distintas, lo que obligaba a saltar entre ellas para contestar la única pregunta que importa aquí
// —dónde hay que poner plata hoy— y dejaba las bolsas de tránsito detrás de un buscador por código.
//
// El orden de las dos rejillas NO lo pone esta pantalla: `/riesgo` y `/transito` llegan ya de peor
// a mejor desde el servidor, y reordenar aquí sería abrir la puerta a que dos vistas del mismo dato
// prioricen distinto.

import { useEffect, useState } from 'react';
import {
  NIVEL_RIESGO_BOLSA_LABEL, NivelRiesgoBolsa,
  type AlertasBolsas, type BolsaConRiesgo, type BolsaTransitoConNivel, type SaldoConsolidado,
} from '@operaciones/shared-types';
import { api, errorMessage } from '../../lib/api';
import { etiquetaPeriodo, pesos, TONO_NIVEL } from '../../lib/bolsas';
import BolsaAbrirCliente, { type ClienteOpcion } from './BolsaAbrirCliente';
import { TarjetaBolsaTransito } from './BolsaTransito';
import BolsaTransitoForm from './BolsaTransitoForm';
import FlitAcordeon from '../flit/FlitAcordeon';
import {
  FlitCard, FlitEmpty, flitBtnPrimary, flitBtnPrimaryStyle, flitBtnSecondary, flitBtnSecondaryStyle,
} from '../flit/flitPageKit';
import KpiCard from '../flit/KpiCard';
import PageContentSkeleton from '../flit/PageContentSkeleton';
import StatusChip from '../flit/StatusChip';

interface Props {
  periodo: string;
  /** Todas las compañías. Sirve para saber a cuáles les falta bolsa (AC3). */
  clientes: ClienteOpcion[];
  onVerCliente: (companiaId: number) => void;
  onVerTransito: (bolsa: { id: string; nombre: string }) => void;
  /** Cambia cuando algo movió saldos —una recarga, una carga— y hay que releer. */
  nonce: number;
  onCambio: () => void;
}

export default function BolsasTablero({
  periodo, clientes, onVerCliente, onVerTransito, nonce, onCambio,
}: Props) {
  const [consolidado, setConsolidado] = useState<SaldoConsolidado | null>(null);
  const [bolsas, setBolsas] = useState<BolsaConRiesgo[] | null>(null);
  const [transitos, setTransitos] = useState<BolsaTransitoConNivel[]>([]);
  const [alertas, setAlertas] = useState<AlertasBolsas | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Abiertos de entrada: la HU quita las pestañas para que todo se vea junto, y arrancar plegado
  // reproduciría el problema que se quiso quitar.
  const [verClientes, setVerClientes] = useState(true);
  const [verTransitos, setVerTransitos] = useState(true);
  const [abriendoBolsa, setAbriendoBolsa] = useState(false);
  const [creandoTransito, setCreandoTransito] = useState(false);

  useEffect(() => {
    let vigente = true;
    setError(null);
    setBolsas(null);
    Promise.all([
      api.get<SaldoConsolidado>('/flito/bolsas/consolidado'),
      // Con periodo: así cada bolsa llega ya con sus entradas y salidas del mes y la rejilla se
      // pinta con UNA petición, en vez de con una por tarjeta.
      api.get<BolsaConRiesgo[]>(`/flito/bolsas/riesgo?periodo=${periodo}`),
      api.get<AlertasBolsas>('/flito/bolsas/alertas'),
      api.get<BolsaTransitoConNivel[]>('/flito/bolsas/transito'),
    ])
      .then(([c, r, a, o]) => {
        if (!vigente) return;
        setConsolidado(c);
        setBolsas(Array.isArray(r) ? r : []);
        setAlertas(a);
        setTransitos(Array.isArray(o) ? o : []);
      })
      .catch((e) => { if (vigente) setError(errorMessage(e)); });
    return () => { vigente = false; };
  }, [nonce, periodo]);

  if (error) {
    return (
      <FlitCard>
        <p className="text-sm" style={{ color: 'var(--flit-danger)' }}>{error}</p>
        <button type="button" className={`${flitBtnSecondary} mt-3`} style={flitBtnSecondaryStyle} onClick={onCambio}>
          Reintentar
        </button>
      </FlitCard>
    );
  }

  if (!bolsas) return <PageContentSkeleton />;

  const enRiesgo = bolsas.filter(
    (b) => b.nivel === NivelRiesgoBolsa.CRITICO || b.nivel === NivelRiesgoBolsa.AGOTADA,
  ).length;

  const conBolsa = new Set(bolsas.map((b) => b.companiaId));
  const candidatos = clientes.filter((c) => !conBolsa.has(c.id));

  return (
    <div className="space-y-4">
      <section aria-label="Resumen de bolsas" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <KpiCard label="Saldo total" value={pesos(consolidado?.saldoTotal ?? 0)}
          hint={`${consolidado?.clientes ?? 0} cliente(s) con bolsa abierta.`} />
        <KpiCard label="Bolsas en riesgo" value={enRiesgo}
          hint="Saldo crítico o agotado. Son las que frenan trámites."
          chip={enRiesgo > 0 ? { tone: 'danger', label: 'Requiere atención' } : undefined} />
        <KpiCard label="Conciliación pendiente"
          value={(alertas?.conciliacion.soportesSinTramite ?? 0) + (alertas?.conciliacion.movimientosSinSoporte ?? 0)}
          hint={`${alertas?.conciliacion.soportesSinTramite ?? 0} soporte(s) sin trámite · ${alertas?.conciliacion.movimientosSinSoporte ?? 0} movimiento(s) sin soporte.`}
          chip={(alertas?.conciliacion.soportesSinTramite ?? 0) + (alertas?.conciliacion.movimientosSinSoporte ?? 0) > 0
            ? { tone: 'warning', label: 'Revisar' } : undefined} />
      </section>

      <FlitAcordeon
        titulo="Clientes"
        cantidad={bolsas.length}
        descripcion="Saldo que cada compañía tiene precargado con FLIT."
        abierto={verClientes}
        onToggle={() => setVerClientes((v) => !v)}
        accion={
          <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
            aria-label="Abrir la bolsa de un cliente nuevo"
            onClick={() => setAbriendoBolsa(true)}>
            <span aria-hidden="true" className="mr-1 text-base leading-none">+</span>
            Abrir bolsa
          </button>
        }
      >
        {alertas && alertas.saldo.length > 0 && (
          <div className="mb-4">
            <h3 className="mb-1 text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>
              Alertas de saldo ({alertas.saldo.length})
            </h3>
            <p className="mb-3 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
              Los clientes que ya no están en nivel normal. Quien nunca ha recargado no aparece aquí:
              no tiene un problema de saldo, tiene una bolsa por abrir.
            </p>
            <ul className="flex flex-col gap-2">
              {alertas.saldo.map((a) => (
                <li key={a.companiaId}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2"
                  style={{ borderColor: 'var(--flit-border-soft)' }}>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <StatusChip tone={TONO_NIVEL[a.nivel]}>{NIVEL_RIESGO_BOLSA_LABEL[a.nivel]}</StatusChip>
                      <span className="text-sm font-semibold">{a.companiaNombre}</span>
                    </div>
                    {/* El motivo lo redacta el servidor: es el mismo texto que verá quien reciba la
                        alerta por otro canal, y reescribirlo aquí lo haría divergir. */}
                    <p className="mt-0.5 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>{a.mensaje}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold tabular-nums">{pesos(a.saldo)}</span>
                    <button type="button" className={flitBtnSecondary} style={flitBtnSecondaryStyle}
                      onClick={() => onVerCliente(a.companiaId)}>
                      Ver detalle
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {bolsas.length === 0 ? (
          <FlitEmpty>
            <span data-testid="sin-bolsas-cliente">
              Ningún cliente tiene bolsa todavía. Se abre con la primera recarga: pulsa «Abrir bolsa»,
              elige la compañía y registra el valor con su comprobante.
            </span>
          </FlitEmpty>
        ) : (
          <section aria-label="Bolsas por cliente" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {bolsas.map((b) => (
              <TarjetaBolsa key={b.companiaId} bolsa={b} periodo={periodo}
                onVer={() => onVerCliente(b.companiaId)} />
            ))}
          </section>
        )}
      </FlitAcordeon>

      <FlitAcordeon
        titulo="Tránsitos"
        cantidad={transitos.length}
        descripcion="Saldo que FLIT precarga para pagar ante las secretarías. Cada bolsa cubre las secretarías y los cobros que se le hayan definido."
        abierto={verTransitos}
        onToggle={() => setVerTransitos((v) => !v)}
        accion={
          <button type="button" className={flitBtnPrimary} style={flitBtnPrimaryStyle}
            aria-label="Crear una bolsa de tránsito"
            onClick={() => setCreandoTransito(true)}>
            <span aria-hidden="true" className="mr-1 text-base leading-none">+</span>
            Crear bolsa
          </button>
        }
      >
        {transitos.length === 0 ? (
          <FlitEmpty>
            <span data-testid="sin-bolsas-transito">
              Todavía no hay bolsas de tránsito. Pulsa «Crear bolsa», ponle nombre y elige a qué
              secretarías le aplica y qué cobros maneja.
            </span>
          </FlitEmpty>
        ) : (
          <section aria-label="Bolsas de tránsito" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {transitos.map((b) => (
              <TarjetaBolsaTransito key={b.id} bolsa={b}
                onVer={() => onVerTransito({ id: b.id, nombre: b.nombre })} />
            ))}
          </section>
        )}
      </FlitAcordeon>

      {abriendoBolsa && (
        <BolsaAbrirCliente candidatos={candidatos}
          onClose={() => setAbriendoBolsa(false)}
          onHecho={onCambio} />
      )}

      {creandoTransito && (
        <BolsaTransitoForm
          onClose={() => setCreandoTransito(false)}
          onHecho={() => { setCreandoTransito(false); onCambio(); }} />
      )}
    </div>
  );
}

function TarjetaBolsa({ bolsa, periodo, onVer }: {
  bolsa: BolsaConRiesgo;
  periodo: string;
  onVer: () => void;
}) {
  const agotada = bolsa.saldo <= 0;
  return (
    <article data-testid={`tarjeta-cliente-${bolsa.companiaId}`} className="flex flex-col bg-white p-5"
      style={{
        borderRadius: 'var(--flit-radius-card)',
        boxShadow: 'var(--flit-shadow-card)',
        // El nivel se distingue por color en el borde izquierdo, no solo en la pastilla: es lo que
        // permite barrer la rejilla sin leer cliente por cliente.
        border: '1px solid var(--flit-border-soft)',
        borderLeft: `4px solid var(--flit-${bolsa.nivel === 'normal' ? 'success' : bolsa.nivel === 'bajo' ? 'warning' : bolsa.nivel === 'sin_recargas' ? 'draft' : 'danger'})`,
      }}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 truncate text-sm font-bold" title={bolsa.companiaNombre}
          style={{ color: 'var(--flit-blue-text)' }}>
          {bolsa.companiaNombre}
        </h3>
        <StatusChip tone={TONO_NIVEL[bolsa.nivel]}>{NIVEL_RIESGO_BOLSA_LABEL[bolsa.nivel]}</StatusChip>
      </div>

      <p className="mt-3 text-2xl font-bold tabular-nums leading-none"
        style={{ color: agotada ? 'var(--flit-danger)' : 'var(--flit-text-primary)' }}>
        {pesos(bolsa.saldo)}
      </p>
      <p className="mt-1 text-xs" style={{ color: 'var(--flit-text-muted)' }}>
        {bolsa.porcentaje === null
          ? 'Sin recargas previas: no hay base para calcular el nivel.'
          : `${bolsa.porcentaje} % de la última recarga (${pesos(bolsa.ultimaRecargaValor ?? 0)}).`}
      </p>

      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div>
          <dt style={{ color: 'var(--flit-text-muted)' }}>Entradas · {etiquetaPeriodo(periodo)}</dt>
          <dd className="font-semibold tabular-nums" style={{ color: 'var(--flit-success)' }}>
            {totalDelPeriodo(bolsa.entradasPeriodo)}
          </dd>
        </div>
        <div>
          <dt style={{ color: 'var(--flit-text-muted)' }}>Salidas · {etiquetaPeriodo(periodo)}</dt>
          <dd className="font-semibold tabular-nums" style={{ color: 'var(--flit-warning)' }}>
            {totalDelPeriodo(bolsa.salidasPeriodo)}
          </dd>
        </div>
      </dl>

      <button type="button" className={`${flitBtnPrimary} mt-4 self-start`} style={flitBtnPrimaryStyle}
        onClick={onVer} aria-label={`Ver el detalle de la bolsa de ${bolsa.companiaNombre}`}>
        Ver detalle
      </button>
    </article>
  );
}

/**
 * Total del periodo de una tarjeta.
 *
 * `null` y `0` NO son lo mismo y no pueden pintarse igual: cero significa que ese mes no hubo
 * movimientos —dato útil, sobre todo si el cliente debería estar operando—, mientras que `null` es
 * que la respuesta vino sin periodo y no hay nada que afirmar. Pintar `$ 0` para ambos casos
 * afirmaría algo falso, así que el segundo se queda en un guion.
 *
 * El tablero siempre pide periodo, así que el guion no debería verse nunca: está por si algún día
 * alguien reutiliza `/riesgo` sin él.
 */
function totalDelPeriodo(valor: number | null): string {
  return valor === null ? '—' : pesos(valor);
}
