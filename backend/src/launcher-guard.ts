import { createServer } from 'node:net';
import { createHash } from 'node:crypto';

// Windows named pipes are released by the OS when their owner exits, including crashes.
export async function acquireLauncherGuard(repository: string) {
  const id = createHash('sha256').update(repository.toLowerCase()).digest('hex').slice(0, 32);
  const server = createServer(socket => socket.end());
  await new Promise<void>((ok, fail) => {
    server.once('error', error => {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') fail(new Error('ChatMAA 启动窗口已在运行，请回到原窗口。'));
      else fail(error);
    });
    server.listen(`\\\\.\\pipe\\chatmaa-launcher-${id}`, ok);
  });
  return () => new Promise<void>((ok, fail) => server.close(error => error ? fail(error) : ok()));
}
