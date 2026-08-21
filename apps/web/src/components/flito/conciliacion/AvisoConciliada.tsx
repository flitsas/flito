// FLITO Conciliación — el aviso de que el dinero salió (HU #11680, AC5).
//
// **Banner permanente, no un toast.** El AC pide cifras de dinero y trazabilidad, y un toast se va en
// cuatro segundos: quien acaba de conciliar necesita apuntar los dos saldos. Recibe el foco al
// aparecer, que es donde están las cifras, y **sobrevive a una recarga**.
//
// Dos cosas que este bloque no puede confundir, porque confundirlas es anunciar un cobro que no
// ocurrió:
//
//   · `totalConciliado` **no es** `cliente.descontado`. El primero es lo que la boleta concilió; el
//     segundo, lo que salió de la bolsa HOY. Son el mismo número solo cuando no hubo adoptados, y la
//     cifra grande del aviso es el primero.
//   · La línea de la bolsa de tránsito **solo aparece si hubo consumo de tránsito**: cuando ninguna
//     bolsa cubre el par, no hay movimiento, y anunciar «− $ 0» sería informar de algo que no pasó.

import { useEffect, useRef } from 'react';
import type { BoletaDetalleDto } from '@operaciones/shared-types';
import { fechaHora, pesos } from '../../../lib/bolsas';
import { IMPORTE_DESCONOCIDO, type AvisoConciliacion } from '../../../lib/conciliacion';
import { FlitCard } from '../../flit/flitPageKit';

const soat = (n: number): string => (n === 1 ? '1 SOAT' : `${n} SOAT`);

export default function AvisoConciliada(
  { aviso, boleta, enfocar }: { aviso: AvisoConciliacion; boleta: BoletaDetalleDto; enfocar: boolean },
) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (enfocar) ref.current?.focus(); }, [enfocar]);

  const saldosConocidos = aviso.cliente.descontado !== IMPORTE_DESCONOCIDO;

  return (
    <FlitCard>
      <div ref={ref} role="status" tabIndex={-1} className="space-y-3 outline-none">
        <p className="flex items-center gap-2 text-base font-bold" style={{ color: 'var(--flit-success-ink)' }}>
          <span aria-hidden="true">✔</span> Boleta conciliada
        </p>

        <p className="text-sm" style={{ color: 'var(--flit-text-primary)' }}>
          Se conciliaron <strong>{soat(aviso.soatConciliados)}</strong> por{' '}
          <strong className="tabular-nums">{pesos(aviso.totalConciliado)}</strong>.
        </p>

        {saldosConocidos ? (
          <ul className="space-y-1 text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            <li>
              Bolsa de <strong>{aviso.cliente.nombre ?? 'el cliente'}</strong>:{' '}
              <strong className="tabular-nums">− {pesos(aviso.cliente.descontado)}</strong>
              {' → saldo '}
              <strong className="tabular-nums">{pesos(aviso.cliente.saldoResultante)}</strong>
            </li>
            {/* Una línea por BOLSA de tránsito —no por organismo—: el saldo pertenece a la bolsa, y
                una bolsa puede cubrir varias secretarías. */}
            {aviso.transito.map((t, i) => (
              <li key={`${t.nombre ?? 'transito'}-${i}`}>
                Bolsa de tránsito de <strong>{t.nombre ?? 'la secretaría'}</strong>:{' '}
                <strong className="tabular-nums">− {pesos(t.descontado)}</strong>
                {' → saldo '}
                <strong className="tabular-nums">{pesos(t.saldoResultante)}</strong>
              </li>
            ))}
          </ul>
        ) : (
          // El detalle no trae los saldos de las bolsas y no se inventan. Quien los necesite los mira
          // en Bolsas, que es el libro.
          <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            Los saldos que quedaron en las bolsas se consultan en Bolsas: esta pantalla solo guarda el
            desglose mientras dura la sesión en que se concilió.
          </p>
        )}

        {aviso.adoptados > 0 && saldosConocidos && (
          <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
            {aviso.adoptados === 1
              ? '1 de esos SOAT ya se había descontado'
              : `${aviso.adoptados} de esos SOAT ya se habían descontado`}
            {' al liquidar su trámite, así que no se '}
            {aviso.adoptados === 1 ? 'volvió' : 'volvieron'} a cobrar: hoy salieron de la bolsa{' '}
            <strong className="tabular-nums">{pesos(aviso.cliente.descontado)}</strong>.
          </p>
        )}

        <p className="text-sm" style={{ color: 'var(--flit-text-secondary)' }}>
          Este descuento no se revierte si el trámite cambia de estado. Corregirlo exige un ajuste
          manual en la bolsa del cliente.
        </p>

        {boleta.conciliadaEn && (
          <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>
            Conciliada por {boleta.conciliadaPorNombre ?? 'un usuario de FLITO'} el{' '}
            {fechaHora(boleta.conciliadaEn)}.
          </p>
        )}
      </div>
    </FlitCard>
  );
}
