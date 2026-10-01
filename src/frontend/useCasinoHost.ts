import { useEffect, useState } from 'react';
import {
  connectGameToHost,
  observeGameContentSize,
  type HostApiV1,
  type HostSnapshotV1,
} from '@chain/casino-sdk/guest';

export function useCasinoHost(): {
  hostApi: HostApiV1 | null;
  snapshot: HostSnapshotV1 | null;
  connectionError: string | null;
} {
  const [hostApi, setHostApi] = useState<HostApiV1 | null>(null);
  const [snapshot, setSnapshot] = useState<HostSnapshotV1 | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const connection = connectGameToHost({
      async setState(nextSnapshot) {
        if (mounted) setSnapshot(nextSnapshot);
      },
    });

    void connection.promise
      .then(parent => {
        if (mounted) setHostApi(parent);
      })
      .catch(error => {
        if (mounted) setConnectionError(error instanceof Error ? error.message : 'Host bridge unavailable.');
      });

    return () => {
      mounted = false;
      connection.destroy();
    };
  }, []);

  useEffect(() => {
    if (!hostApi) return;
    const observer = observeGameContentSize(hostApi);
    return () => observer.disconnect();
  }, [hostApi]);

  return { hostApi, snapshot, connectionError };
}
