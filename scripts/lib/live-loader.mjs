// The module hook of the live session's simulated model (scripts/lib/live-hook.mjs): while `runtime/dist/control.js`
// is loaded, the one stand-in that the configuration leaves for agents is replaced by the agents the preload put on
// `globalThis`, or by that same stand-in when it put none. Nothing else is touched. If the line is not in the file (the
// runtime changed), loading fails by name instead of the session quietly running without its simulated Matcher.

export const ANCHOR = 'agents: { run: async () => missing("agent adapter: agents run as agent loops, which need model and sandbox") },';
export const REPLACEMENT = 'agents: globalThis.__mandateLiveAgents ?? { run: async () => missing("agent adapter: agents run as agent loops, which need model and sandbox") },';

/** The source of the module at `url` as the session loads it: runtime/dist/control.js patched, any other module as it is. */
export function patched(url, source) {
  if (!/\/runtime\/dist\/control\.js$/.test(url)) return source;
  const text = String(source);
  if (!text.includes(ANCHOR)) throw new Error("the live kit's simulated model no longer fits runtime/dist/control.js: the stand-in line for agents is not there (scripts/lib/live-loader.mjs)");
  return text.replace(ANCHOR, REPLACEMENT);
}
