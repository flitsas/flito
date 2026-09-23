// HU #12087 (Feature #12072) — Excepciones por usuario: cómo viajan dentro del historial.
//
// `codificarExcepcion` / `decodificarExcepcion` son la forma `<efecto>:<codigo>` con la que la fila
// `usuario_funcion`/`conjunto` de `permisos_auditoria` reutiliza `ValorAuditable` sin abrirlo
// (ADR-0014 §2). Ida y vuelta exacta, y `null` ante lo que no es una excepción.
import { describe, it, expect } from 'vitest';
import {
  EFECTOS_PERMISO_USUARIO, codificarExcepcion, decodificarExcepcion, type FuncionDeUsuario,
} from '../src/index.js';

describe('EFECTOS_PERMISO_USUARIO', () => {
  it('son exactamente los dos literales del CHECK de la 0179', () => {
    expect([...EFECTOS_PERMISO_USUARIO]).toEqual(['conceder', 'revocar']);
  });
});

describe('codificarExcepcion / decodificarExcepcion', () => {
  it.each<FuncionDeUsuario>([
    { codigo: 'soat.cola.exportar', efecto: 'conceder' },
    { codigo: 'pagina.users', efecto: 'revocar' },
    { codigo: 'permisos.cuadro.guardar', efecto: 'revocar' },
  ])('ida y vuelta exacta de %j', (f) => {
    const s = codificarExcepcion(f);
    expect(s).toBe(`${f.efecto}:${f.codigo}`);
    expect(decodificarExcepcion(s)).toEqual(f);
  });

  it('el código puede llevar dos puntos por dentro: el separador es el PRIMERO', () => {
    expect(decodificarExcepcion('conceder:a:b')).toEqual({ codigo: 'a:b', efecto: 'conceder' });
  });

  it('devuelve null ante un prefijo desconocido, sin separador o sin código', () => {
    expect(decodificarExcepcion('permitir:pagina.users')).toBeNull();
    expect(decodificarExcepcion('pagina.users')).toBeNull();
    expect(decodificarExcepcion(':pagina.users')).toBeNull();
    expect(decodificarExcepcion('conceder:')).toBeNull();
    expect(decodificarExcepcion('')).toBeNull();
  });
});
