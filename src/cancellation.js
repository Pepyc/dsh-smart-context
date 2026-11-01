/** 取消等待者，不取消其他调用共享的底层工作；迟到的拒绝仍有处理器。
 * @template T @param {Promise<T>} pending @param {...(AbortSignal|undefined)} signals @returns {Promise<T>} */
export function waitFor(pending, ...signals) {
  const watched = [...new Set(signals.filter((s) => s !== undefined))];
  if (watched.length === 0) return pending;
  return new Promise((resolve, reject) => {
    /** @type {Array<() => void>} */ const cleanups = [];
    let done = false;
    const cleanup = () => { for (const off of cleanups.splice(0)) off(); };
    pending.then((value) => { if (!done) { done = true; cleanup(); resolve(value); } },
      (error) => { if (!done) { done = true; cleanup(); reject(error); } });
    for (const signal of watched) {
      const abort = () => {
        if (!done) { done = true; cleanup(); reject(signal.reason ?? new DOMException("Operation aborted", "AbortError")); }
      };
      if (signal.aborted) { abort(); break; }
      signal.addEventListener("abort", abort, { once: true });
      cleanups.push(() => signal.removeEventListener("abort", abort));
    }
  });
}
