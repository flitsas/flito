import { useCallback, useEffect, useRef, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import type { ModuloGestion } from '@operaciones/shared-types';
import { hasPage, type PageSlug } from '../../../lib/permissions';
import { agregar, nuevoIdMensaje, type MensajeDrFlit } from '../../../lib/drFlitConversacion';
import {
  faseBloque, modulosAConsultar, moduloGestionWeb, textoResumen, type TipoValorGestion,
} from '../../../lib/drFlitGestion';
import {
  consultarModulo, fijarGrupos, generacionGestion, grupoDeRespuesta, resultadosGestion, suscribirResultados,
} from '../../../lib/drFlitGestionConsulta';
import { idGrupoGestion, idTituloGestion } from './ResultadoGestion';

// Dr. Flit — orquestación de las consultas de gestión en el panel (HU #13836 G1). Despachador
// (página + función, AC7), lanzamiento por módulo (cada grupo se pinta al responder, UX F6.3),
// reintento por grupo o global, foco (F6.14) y los dos anuncios por consulta.

type Usuario = Parameters<typeof hasPage>[0];

export interface GestionDrFlitOpciones {
  userId: string | number | undefined;
  user: Usuario;
  hasFuncion: (codigo: string) => boolean;
  mensajes: readonly MensajeDrFlit[];
  setMensajes: Dispatch<SetStateAction<MensajeDrFlit[]>>;
  anunciar: (texto: string) => void;
}

const enfocar = (id: string) => {
  requestAnimationFrame(() => document.getElementById(id)?.focus());
};

export function useGestionDrFlit({ userId, user, hasFuncion, mensajes, setMensajes, anunciar }: GestionDrFlitOpciones) {
  const resultados = useSyncExternalStore(suscribirResultados, resultadosGestion);
  /** Ofertas ya pulsadas: un doble clic no lanza una segunda tanda (F6.10). */
  const pulsadas = useRef(new Set<string>());

  const modulosPara = useCallback(
    (tipo: TipoValorGestion) =>
      modulosAConsultar(tipo, (page, funcion) => hasPage(user, page as PageSlug) && hasFuncion(funcion)),
    [user, hasFuncion],
  );

  const lanzar = (rid: string, valor: string, modulos: readonly ModuloGestion[], focoAlResponder: boolean) => {
    if (userId === undefined) return;
    const gen = generacionGestion();
    fijarGrupos(userId, gen, rid, (prev) => {
      const sig = { ...prev };
      for (const m of modulos) sig[m] = { estado: 'cargando' };
      return sig;
    });
    for (const m of modulos) {
      void consultarModulo(m, valor).then((r) => {
        const grupo = grupoDeRespuesta(r);
        if (!fijarGrupos(userId, gen, rid, (prev) => ({ ...prev, [m]: grupo }))) return;
        if (focoAlResponder) enfocar(grupo.estado === 'oculto' ? idTituloGestion(rid) : idGrupoGestion(rid, m));
      });
    }
  };

  /** «Consultar {valor} en sus módulos»: retira los botones, inserta el bloque y lleva el foco al título. */
  const consultar = (ofertaId: string) => {
    const oferta = mensajes.find((m) => m.id === ofertaId);
    if (!oferta || oferta.tipo !== 'ofertaGestion' || oferta.estado !== 'viva') return;
    if (pulsadas.current.has(ofertaId)) return;
    pulsadas.current.add(ofertaId);
    const modulos = modulosPara(oferta.tipoValor);
    const rid = nuevoIdMensaje();
    setMensajes((prev) =>
      agregar(
        prev.map((m) => (m.id === ofertaId && m.tipo === 'ofertaGestion' ? { ...m, estado: 'consultada' as const } : m)),
        { id: rid, ts: Date.now(), de: 'drflit', tipo: 'resultadoGestion', valor: oferta.valor, tipoValor: oferta.tipoValor, modulos },
      ),
    );
    anunciar(modulos.length ? 'Consultando sus módulos…' : 'No encontré resultados en sus módulos.');
    if (modulos.length) lanzar(rid, oferta.valor, modulos, false);
    enfocar(idTituloGestion(rid));
  };

  /** Reintentar de un grupo (foco a su `h4` al responder) o el global (foco al `h3`). */
  const reintentar = (rid: string, modulos: ModuloGestion[]) => {
    const resultado = mensajes.find((m) => m.id === rid);
    if (!resultado || resultado.tipo !== 'resultadoGestion' || modulos.length === 0) return;
    const deGrupo = modulos.length === 1 && resultado.modulos.length > 1;
    anunciar('Consultando sus módulos…');
    lanzar(rid, resultado.valor, modulos, deGrupo);
    enfocar(deGrupo ? idGrupoGestion(rid, modulos[0]) : idTituloGestion(rid));
  };

  // Resumen al terminar (F6.14): solo cuando un bloque pasa de «cargando» a terminado con el panel abierto.
  const fases = useRef(new Map<string, string>());
  useEffect(() => {
    for (const m of mensajes) {
      if (m.tipo !== 'resultadoGestion') continue;
      const grupos = resultados.get(m.id) ?? {};
      const lista = m.modulos.map((mod) => grupos[mod] ?? { estado: 'cargando' as const });
      const fase = faseBloque(lista);
      const previa = fases.current.get(m.id);
      fases.current.set(m.id, fase.fase);
      if (previa !== 'cargando' || fase.fase === 'cargando' || fase.fase === 'error') continue;
      const fallidos = m.modulos
        .filter((mod) => grupos[mod]?.estado === 'error')
        .map((mod) => ` No pude consultar ${moduloGestionWeb(mod)?.etiqueta ?? mod}.`)
        .join('');
      if (fase.fase === 'lleno') anunciar(`${textoResumen(fase.coincidencias, fase.modulos)}${fallidos}`);
      else if (fase.fase === 'mixto') anunciar(`No encontré coincidencias en los módulos que respondieron.${fallidos}`);
      else anunciar('No encontré resultados en sus módulos.');
    }
  }, [mensajes, resultados, anunciar]);

  return { resultados, modulosPara, consultar, reintentar };
}
