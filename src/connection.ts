export async function retryConnection<T>(attempt: () => Promise<T>, wait: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 2000))) {
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof TypeError) && (!(error instanceof DOMException) || !["AbortError", "TimeoutError"].includes(error.name))) throw error;
      console.error("Connection interrupted. Retrying…");
      await wait();
    }
  }
}
