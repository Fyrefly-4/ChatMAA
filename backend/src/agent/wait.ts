// 取消等待不代表底层输出已取消；迟到的完成或失败仍被消费。
export async function waitForOutput(output: () => Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return output();
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
