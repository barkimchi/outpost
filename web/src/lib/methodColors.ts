/** Shared HTTP-method colors, so the same verb reads the same color in the method select,
 *  the Sidebar's saved-request rows, and anywhere else a method badge shows up. */
export const METHOD_COLOR: Record<string, string> = {
  GET: 'text-gym-green',
  POST: 'text-gym-amber',
  PUT: 'text-gym-blue',
  PATCH: 'text-gym-purple',
  DELETE: 'text-gym-red',
  HEAD: 'text-gym-text-dim',
  OPTIONS: 'text-gym-text-dim',
};

export function methodColor(method: string): string {
  return METHOD_COLOR[method.toUpperCase()] ?? 'text-gym-text-dim';
}
