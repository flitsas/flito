// Panel de resultado de «Probar conexión» (HU #11890, AC3).
//
// La regla que gobierna este archivo: `POST /probar-conexion` responde **200 tanto si la prueba
// pasa como si falla**, y el veredicto viaja en `ok`/`codigo`. Por eso `ok:false` se pinta AQUÍ,
// en un panel `role="status"` dentro de su tarjeta, y nunca en la banda de error de la página.
// Lo que sí es un error —que la petición no llegue a 200— lo pinta la tarjeta con `role="alert"`.

import { fecha } from '../estilos';
import {
  AMBIENTE_EN_FRASE, BORDE_TONO, TINTA_TONO, copiaVeredicto, sinAutorreferencia,
  type Ambiente, type ResultadoDiagnostico,
} from './tipos';
import { flitBtnSecondarySm, flitBtnSecondaryStyle } from '../../flit/flitPageKit';

interface Props {
  ambiente: Ambiente;
  resultado: ResultadoDiagnostico;
  /** Cuándo se pulsó el botón. El DTO no trae hora, así que se rotula «Probada el …». */
  probadaEn: string;
  onCerrar: () => void;
}

export default function PanelResultado({ ambiente, resultado, probadaEn, onCerrar }: Props) {
  const copia = copiaVeredicto(resultado.codigo, ambiente);
  // En `mock` el diagnóstico ni lee la credencial (`siigo.diagnostico.service.ts`): puede devolver
  // `ok:true` con `username:null` sin haber comprobado ninguna llave. Un ✓ verde ahí diría
  // «producción está lista» sin haber tocado producción, así que el símbolo pasa a 🧪.
  const simulado = resultado.modo !== 'real';
  const mensaje = sinAutorreferencia(resultado.mensaje);
  const idTitulo = `resultado-${ambiente}-titulo`;

  return (
    <section
      role="status"
      aria-labelledby={idTitulo}
      className="bg-white px-4 py-3"
      style={{
        borderRadius: 'var(--flit-radius-card)',
        border: '1px solid var(--flit-border-soft)',
        borderLeft: `4px solid ${BORDE_TONO[copia.tono]}`,
      }}
    >
      <h4 id={idTitulo} className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--flit-text-secondary)' }}>
        Resultado de la prueba
      </h4>

      {simulado && (
        <p className="mt-2 text-sm" style={{ color: 'var(--flit-warning-ink)' }}>
          <span aria-hidden="true">🧪 </span>
          Modo simulado: esta prueba no salió hacia Siigo. El resultado no dice nada sobre si tus
          credenciales sirven.
        </p>
      )}

      <p className="mt-1 text-sm font-semibold" style={{ color: TINTA_TONO[copia.tono] }}>
        <span aria-hidden="true">{simulado ? '🧪' : copia.simbolo} </span>
        {copia.encabezado}
      </p>

      {/* El mensaje del servidor, literal salvo la frase que manda a esta misma pantalla. */}
      {copia.pintarMensajeDelServidor && mensaje && (
        <p className="mt-1 text-sm" style={{ color: 'var(--flit-text-primary)' }}>{mensaje}</p>
      )}
      {copia.segunda && (
        <p className="mt-1 text-sm" style={{ color: 'var(--flit-text-primary)' }}>{copia.segunda}</p>
      )}

      {/* Los datos técnicos, literales y completos: son exactamente lo que se copia y se pega al
          pedir ayuda. `duracionMs: 1` es información real —dice que nunca salió de la máquina—, así
          que no se redondea ni se convierte a segundos. */}
      <p className="mt-2 text-xs" style={{ color: 'var(--flit-text-secondary)' }}>
        Ambiente {resultado.ambiente} · modo {resultado.modo} ·{' '}
        {resultado.username ? `usuario ${resultado.username}` : 'sin usuario'} ·{' '}
        {resultado.tokenObtenido ? 'token obtenido' : 'token no obtenido'} · {resultado.duracionMs} ms
      </p>

      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="text-xs" style={{ color: 'var(--flit-text-muted)' }}>Probada el {fecha(probadaEn)}</p>
        <button type="button" onClick={onCerrar} className={flitBtnSecondarySm} style={flitBtnSecondaryStyle}>
          Cerrar
          {/* Hay un panel por tarjeta: sin el ambiente en el nombre, los dos «Cerrar» son
              indistinguibles para quien navega por lista de botones. */}
          <span className="sr-only"> el resultado de la prueba de {AMBIENTE_EN_FRASE[ambiente]}</span>
        </button>
      </div>
    </section>
  );
}
