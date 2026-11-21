import { createInterface } from 'node:readline/promises';

/** Asks one question on `input`/`output` and returns the line typed; end of input (Ctrl-D) answers ''. */
export async function askLine(question: string, io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream }): Promise<string> {
  const rl = createInterface({ input: io.input, output: io.output });
  // without this, a closed input leaves the question pending forever
  const closed = new Promise<string>((resolve) => rl.once('close', () => resolve('')));
  try {
    return await Promise.race([rl.question(question).catch(() => ''), closed]);
  } finally {
    rl.close();
  }
}
