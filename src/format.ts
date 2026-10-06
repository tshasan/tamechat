export type Format = 'html' | 'markdown';

export const formats: Format[] = ['html', 'markdown'];

export function isFormat(value: unknown): value is Format {
  return value === 'html' || value === 'markdown';
}
