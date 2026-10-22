import { connectToDaemon, type DaemonClient, type EnsureDaemonOptions, ensureDaemon } from "@agency/rpc";

export interface WorkspaceDaemonOptions {
  workspaceRoot: string;
  instanceDir: string;
  /** How the host starts a daemon: the CLI passes the spawn of its own `connectHeadlessClient`. */
  spawnDaemon: EnsureDaemonOptions["spawnDaemon"];
  build?: string;
  onConnection?: (online: boolean) => void;
}

/**
 * Finds or starts the one daemon of this workspace (the lock, stale-file and build checks of `ensureDaemon`) and
 * returns a client that reports drops and reconnects. Trust prompts stay with the host, before this call.
 */
export async function connectWorkspaceDaemon(options: WorkspaceDaemonOptions): Promise<DaemonClient> {
  const { client } = await ensureDaemon({
    workspaceRoot: options.workspaceRoot,
    instanceDir: options.instanceDir,
    spawnDaemon: options.spawnDaemon,
    ...(options.build === undefined ? {} : { build: options.build }),
    connect: (port, host, o) =>
      connectToDaemon(port, host, {
        ...o,
        ...(options.onConnection === undefined ? {} : { onConnection: options.onConnection }),
      }),
  });
  return client;
}
