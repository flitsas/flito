import { useState } from 'react';
import { Icono, type NombreIcono } from './kit/Icono';

/**
 * Banner carrusel del tablero (UI Kit 2026, «Banner»): 200 px (180 en teléfono), láminas degradado / azul / tinta,
 * puntos y flechas; el único círculo decorativo del kit (blanco al 14 %). La primera lámina lleva la h1.
 */
export interface LaminaBanner { titulo: string; texto: string; icono: NombreIcono; fondo: 'degradado' | 'azul' | 'tinta' }

export default function BannerInicio({ laminas, etiqueta = 'Novedades' }: { laminas: LaminaBanner[]; etiqueta?: string }) {
  const [i, setI] = useState(0);
  const n = laminas.length;
  if (!n) return null;
  return (
    <section className="banner-kit" aria-roledescription="carrusel" aria-label={etiqueta} data-kit="banner">
      {laminas.map((b, k) => {
        const H = k === 0 ? 'h1' : 'h2';
        return (
          <div key={b.titulo} className={`banner-kit__lamina banner-kit__lamina--${b.fondo}`} hidden={k !== i}>
            <H className="banner-kit__titulo"><span className="banner-kit__chip" aria-hidden="true"><Icono nombre={b.icono} /></span>{b.titulo}</H>
            <p>{b.texto}</p>
          </div>
        );
      })}
      {n > 1 && (
        <div className="banner-kit__pie">
          {laminas.map((b, k) => (
            <button key={b.titulo} className="banner-kit__punto" type="button" aria-label={`Contenido ${k + 1} de ${n}`} aria-current={k === i ? 'true' : undefined} onClick={() => setI(k)} />
          ))}
          <span className="banner-kit__esp" />
          <button className="banner-kit__flecha" type="button" aria-label="Contenido anterior" onClick={() => setI((i + n - 1) % n)}><Icono nombre="izquierda" /></button>
          <button className="banner-kit__flecha" type="button" aria-label="Contenido siguiente" onClick={() => setI((i + 1) % n)}><Icono nombre="derecha" /></button>
        </div>
      )}
    </section>
  );
}
