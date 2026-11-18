export type Probe = () => Promise<void>;

function boundedProbe(probe: Probe, timeoutMs: number) {
  let pending: Promise<boolean> | undefined;
  return () => {
    if (pending) return pending;
    const operation = Promise.resolve().then(probe).then(() => true, () => false);
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    pending = Promise.race([operation, deadline]);
    // Reuse a timed-out result until its original operation settles. Polling a
    // stalled database must not accumulate new queries, timers or listeners.
    void operation.then(() => {
      clearTimeout(timer);
      pending = undefined;
    });
    return pending;
  };
}

type Dependency = "postgresql" | "redis";
export function createReadiness(
  probes: Record<Dependency, Probe>, timeoutMs: number,
  onTransition: (dependency: Dependency, ok: boolean) => void = () => {},
) {
  const names = ["postgresql", "redis"] as const;
  const checks = names.map(name => boundedProbe(probes[name], timeoutMs));
  const previous: Partial<Record<Dependency, boolean>> = {};
  let draining = false;
  let inFlight: Promise<boolean> | undefined;

  function ready(): Promise<boolean> {
    if (draining) return Promise.resolve(false);
    if (!inFlight) {
      inFlight = Promise.all(checks.map(check => check())).then(results => {
        results.forEach((ok, index) => {
          const name = names[index];
          if (previous[name] !== ok) onTransition(name, ok);
          previous[name] = ok;
        });
        return !draining && results.every(Boolean);
      }).finally(() => { inFlight = undefined; });
    }
    return inFlight;
  }
  return { ready, drain() { draining = true; } };
}
