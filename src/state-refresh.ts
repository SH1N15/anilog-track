export interface StateRefreshController {
  refresh(reportError?: boolean): Promise<void>;
  dispose(): void;
}

export function createStateRefreshController<T>({
  getState,
  subscribe,
  applyState,
  onError,
}: {
  getState: () => Promise<T>;
  subscribe: (callback: (state: T) => void) => () => void;
  applyState: (state: T) => void;
  onError?: (reason: unknown) => void;
}): StateRefreshController {
  let active = true;
  let pushedRevision = 0;
  let refreshInFlight: Promise<void> | null = null;

  const unsubscribe = subscribe((nextState) => {
    pushedRevision += 1;
    if (active) applyState(nextState);
  });

  function refresh(reportError = false): Promise<void> {
    if (refreshInFlight) return refreshInFlight;
    const revisionAtStart = pushedRevision;
    refreshInFlight = getState()
      .then((nextState) => {
        if (active && revisionAtStart === pushedRevision) applyState(nextState);
      })
      .catch((reason) => {
        if (active && reportError) onError?.(reason);
      })
      .finally(() => { refreshInFlight = null; });
    return refreshInFlight;
  }

  return {
    refresh,
    dispose() {
      if (!active) return;
      active = false;
      unsubscribe();
    },
  };
}
