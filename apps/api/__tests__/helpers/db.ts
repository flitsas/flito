// Helpers para mockear drizzle. Los query builders de drizzle son thenable: cada método retorna
// el mismo chain y `await` resuelve al array final. Estos helpers replican ese contrato.

type AnyChain = {
  from: () => AnyChain;
  where: () => AnyChain;
  leftJoin: () => AnyChain;
  innerJoin: () => AnyChain;
  limit: () => AnyChain;
  offset: () => AnyChain;
  orderBy: () => AnyChain;
  groupBy: () => AnyChain;
  having: () => AnyChain;
  values: () => AnyChain;
  returning: () => AnyChain;
  set: () => AnyChain;
  for: () => AnyChain;
  onConflictDoUpdate: () => AnyChain;
  onConflictDoNothing: () => AnyChain;
  $dynamic: () => AnyChain;
  then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise<unknown>;
  catch: (reject: (e: unknown) => unknown) => Promise<unknown>;
  finally: (cb: () => void) => Promise<unknown>;
};

function makeChain(promise: Promise<unknown>): AnyChain {
  const t: AnyChain = {
    from: () => t, where: () => t, leftJoin: () => t, innerJoin: () => t,
    limit: () => t, offset: () => t,
    orderBy: () => t, groupBy: () => t, having: () => t,
    values: () => t, returning: () => t, set: () => t,
    for: () => t,
    onConflictDoUpdate: () => t, onConflictDoNothing: () => t,
    $dynamic: () => t,
    then: (resolve, reject) => promise.then(resolve, reject) as Promise<unknown>,
    catch: (reject) => promise.catch(reject) as Promise<unknown>,
    finally: (cb) => promise.finally(cb) as Promise<unknown>,
  };
  return t;
}

/** Chain que resuelve a las filas dadas. Cubre SELECT, INSERT...returning(), UPDATE...returning(). */
export function chain(rows: unknown[]): AnyChain {
  return makeChain(Promise.resolve(rows));
}

/** Chain que rechaza con el error dado. Útil para errores de constraint (23505) o BD caída. */
export function chainReject(err: unknown): AnyChain {
  const promise = Promise.reject(err);
  // Suprime "unhandled rejection" del runner; el reject se sigue propagando vía .then(_, reject)
  // cuando el código bajo test hace await sobre el chain.
  promise.catch(() => { /* noop */ });
  return makeChain(promise);
}
