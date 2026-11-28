/**
 * The app's main process, reached over the Node inspector it opens with
 * `--inspect`: where `electron.evaluate` runs, and where the main process's
 * console is read. An app that opens no inspector has none of this.
 */

import { Connection, webSocketTransport } from './cdp/connection.ts';
import { consoleText } from './console-text.ts';
import { callForPlainData, checkJsonArgument, describeException, functionSource } from './evaluate.ts';
import type { ElectronMainModule } from './fixtures.ts';

/** One line the main process wrote to its console. */
export type MainConsole = (type: string, text: string) => void;

export class MainProcess {
  private module: Promise<string> | undefined;

  private constructor(private readonly connection: Connection) {}

  /** Connects to the inspector at `url` and starts reading the main process's console. */
  static async connect(url: string, timeoutMs: number, onConsole: MainConsole): Promise<MainProcess> {
    const connection = new Connection(await webSocketTransport(url, timeoutMs));
    const { root } = connection;
    root.on('Runtime.consoleAPICalled', (event) => {
      // Context 0 is the inspector's own; the app's console calls come from its default context.
      if (event.executionContextId !== 0) onConsole(event.type, consoleText(event.args));
    });
    await root.send('Runtime.enable');
    return new MainProcess(connection);
  }

  /** The main process's `electron` module, held as a remote object for every call to receive. */
  private electronModule(): Promise<string> {
    if (this.module === undefined) {
      const module = (async () => {
        // `require` is in scope only with the command-line API, since Electron 28.
        const { result, exceptionDetails } = await this.connection.root.send('Runtime.evaluate', { expression: "require('electron')", includeCommandLineAPI: true });
        if (exceptionDetails !== undefined || result.objectId === undefined) throw new Error(`the main process has no electron module: ${exceptionDetails === undefined ? result.type : describeException(exceptionDetails)}`);
        return result.objectId;
      })();
      this.module = module;
      module.catch(() => {
        if (this.module === module) this.module = undefined;
      });
    }
    return this.module;
  }

  /**
   * Runs `fn` in the main process with its `electron` module and `arg`, and
   * returns what it returns as plain data (`plainData`). `fn` is sent as
   * source text, and `arg` as JSON.
   */
  async evaluate<R, A>(fn: (electron: ElectronMainModule, arg: A) => R | Promise<R>, arg: A): Promise<R> {
    checkJsonArgument(arg, 'electron.evaluate');
    const source = functionSource(fn, 'electron.evaluate');
    const objectId = await this.electronModule();
    return (await callForPlainData(this.connection.root, { objectId, source, leading: [{ objectId }], arg })) as R;
  }

  /** Disconnects. Node waits for its inspector's clients before it exits, so a quitting app is let go of here. */
  close(): void {
    this.connection.close();
  }
}
