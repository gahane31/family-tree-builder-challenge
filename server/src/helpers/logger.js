// Tiny structured logger. One JSON line per event via console.log/error.
// Every module creates its own: const log = createLogger("tools").

export function createLogger(tag) {
  const write = (level, msg, extra) => {
    const line = { ts: new Date().toISOString(), level, tag, msg, ...(extra || {}) };
    (level === "error" ? console.error : console.log)(JSON.stringify(line));
  };
  return {
    info: write.bind(null, "info"),
    warn: write.bind(null, "warn"),
    error: write.bind(null, "error"),
  };
}
