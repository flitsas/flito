/**
 * Ejecuta `fn` sobre `items` con como mucho `limite` en vuelo a la vez.
 *
 * Sin dependencias: un pool de N obreros que van tomando el siguiente índice libre. `Promise.all`
 * sobre todos los items lanzaría el lote entero de golpe; un `for` secuencial haría esperar el
 * doble de lo necesario.
 *
 * Los resultados vuelven en el ORDEN de entrada, no en el de terminación.
 */
export async function conConcurrencia<T, R>(items: T[], limite: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const resultados = new Array<R>(items.length);
  let siguiente = 0;
  const obreros = Array.from({ length: Math.min(limite, items.length) }, async () => {
    for (;;) {
      const i = siguiente++;
      if (i >= items.length) return;
      resultados[i] = await fn(items[i]);
    }
  });
  await Promise.all(obreros);
  return resultados;
}
