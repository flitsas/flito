// FLITO — canal Cliente: la tarjeta que explica por qué no hay botón (HU #11914, AC5).
//
// ── Tarjeta NEUTRA, no banda de error, y nunca `NoAccess` ───────────────────────────────────────
//
// Que la compañía no tenga el canal encendido **no es un fallo del usuario ni del sistema**: es una
// opción comercial de su empresa. Por eso tinta `--flit-text-secondary`, cero rojo y cero icono de
// alerta — y por eso tampoco es `NoAccess`, cuyo «No tienes acceso a SOAT» sería sencillamente
// falso: el permiso lo tiene, lo que no tiene su compañía es el canal.
//
// Y por eso, en la cola, **no hay ningún botón «Solicitar SOAT»**. Ofrecer un botón que abre una
// pantalla que explica que no se puede es justo el patrón que el AC5 pide evitar.

import { Link } from 'react-router-dom';
import { FlitCard, flitBtnSecondary, flitBtnSecondaryStyle } from '../../flit/flitPageKit';

interface Props {
  /**
   * La salida. `null` en la cola —ya está en su pantalla, no hay a dónde volver— y con destino en el
   * formulario, al que se puede llegar tecleando la URL.
   */
  salida?: { to: string; texto: string } | null;
  /**
   * Primera línea añadida cuando el canal se apagó **mientras** se llenaba el formulario (el `POST`
   * respondió 403 aunque `/me` dijera que sí).
   *
   * Es una frase incómoda y es la verdad. El silencio aquí se lee como «se perdió mi trabajo por un
   * error», y un `toast.error` genérico dejando el formulario en pie invita a reintentar en bucle
   * contra un canal cerrado.
   */
  avisoCarrera?: boolean;
}

export function TarjetaCanalDeshabilitado({ salida = null, avisoCarrera = false }: Props) {
  return (
    <FlitCard>
      <div className="space-y-2" style={{ color: 'var(--flit-text-secondary)' }}>
        <h2 className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>
          Solicitud de SOAT sin trámite
        </h2>
        {avisoCarrera && (
          <p className="text-sm font-semibold" style={{ color: 'var(--flit-text-primary)' }}>
            El canal se deshabilitó mientras llenaba el formulario, así que no se envió nada.
          </p>
        )}
        <p className="text-sm">
          Su compañía todavía no tiene habilitado este canal, así que por ahora aquí solo puede
          consultar sus SOAT.
        </p>
        <p className="text-sm">
          Para pedirle un SOAT a FLIT sin un trámite abierto, escríbale a su contacto comercial y
          pídale que lo habilite.
        </p>
        {salida && (
          <p className="pt-1">
            <Link to={salida.to} className={flitBtnSecondary} style={flitBtnSecondaryStyle}>{salida.texto}</Link>
          </p>
        )}
      </div>
    </FlitCard>
  );
}

/**
 * El formulario visto por quien **no es del canal**: `admin`, `auditor` y `proveedor` tienen el slug
 * `flito_soat`, así que la ruta les abre. Ni error ni formulario: el alta es del Cliente y la
 * revisión es de la HU #11915.
 */
export function TarjetaCanalAjeno() {
  return (
    <FlitCard>
      <div className="space-y-2" style={{ color: 'var(--flit-text-secondary)' }}>
        <h2 className="text-sm font-bold" style={{ color: 'var(--flit-blue-text)' }}>
          Este formulario es del canal Cliente.
        </h2>
        <p className="text-sm">
          Las solicitudes que llegan por aquí se revisan desde la cola de SOAT.
        </p>
        <p className="pt-1">
          <Link to="/flito/soat" className={flitBtnSecondary} style={flitBtnSecondaryStyle}>Ir a la cola de SOAT</Link>
        </p>
      </div>
    </FlitCard>
  );
}
