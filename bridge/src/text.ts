// Lone UTF-16 surrogates: a JavaScript string may hold one, a request to the module may not (its reader refuses
// it, as the IR's does), and a Rust string cannot.

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_ALL = new RegExp(LONE.source, "g");

/** Whether `s` holds no lone surrogate (String.prototype.isWellFormed, which the target library does not type). */
export function isWellFormed(s: string): boolean {
  return !LONE.test(s);
}

/** `s` with each lone surrogate as U+FFFD (String.prototype.toWellFormed). */
export function toWellFormed(s: string): string {
  return isWellFormed(s) ? s : s.replace(LONE_ALL, "�");
}
