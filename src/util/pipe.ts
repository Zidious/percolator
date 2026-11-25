const isEpipe = (err: unknown): boolean => (err as { code?: unknown } | null)?.code === 'EPIPE';

/** A writer for a CLI output stream that writes nothing once the reader has gone (EPIPE); other errors still throw. */
export function pipeWriter(stream: NodeJS.WritableStream): (s: string) => void {
  let closed = false;
  stream.on('error', (err: unknown) => {
    if (!isEpipe(err)) throw err;
    closed = true;
  });
  return (s) => {
    if (closed) return;
    try {
      stream.write(s);
    } catch (err) {
      if (!isEpipe(err)) throw err;
      closed = true;
    }
  };
}
