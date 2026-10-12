import { spawnSync } from "node:child_process";
import { render } from "ink";
import type { Layer } from "../core/store.ts";
import { App, type ViewerState } from "./app.tsx";

/**
 * Runs the viewer until the user quits. Opening $EDITOR unmounts the UI, runs the editor in the
 * foreground, then remounts with the same state.
 */
export async function runViewer(layers: Layer[], initial: ViewerState): Promise<void> {
  let state = initial;
  for (;;) {
    let editing: string | undefined;
    const app = render(
      <App
        layers={layers}
        initial={state}
        onEdit={(path, s) => {
          editing = path;
          state = s;
        }}
      />,
      { alternateScreen: true, exitOnCtrlC: true },
    );
    await app.waitUntilExit();
    if (!editing) return;
    const editor = process.env.VISUAL || process.env.EDITOR || "vi";
    spawnSync(`${editor} "$O6Y_FILE"`, { shell: true, stdio: "inherit", env: { ...process.env, O6Y_FILE: editing } });
    process.stdout.write("\x1b[2J\x1b[H");
  }
}
