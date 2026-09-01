/** Shared status-code color bands (`lib/format.ts`'s `statusBand`) between the response
 *  panel and the Logs tab, so a 401 reads the same amber everywhere in the app. */
export const STATUS_BAND_CLASSES: Record<string, string> = {
  success: 'bg-gym-green-dim text-gym-green',
  redirect: 'bg-gym-blue-dim text-gym-blue',
  'client-error': 'bg-gym-amber-dim text-gym-amber',
  'server-error': 'bg-gym-red-dim text-gym-red',
  info: 'bg-gym-panel3 text-gym-text-dim',
  unknown: 'bg-gym-panel3 text-gym-text-dim',
};
