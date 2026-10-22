import type { Locale } from './shared';

export function resolveLocale(preference: unknown, editorLanguage: string): Locale {
  if (preference === 'en' || preference === 'zh-CN') return preference;
  return /^zh(?:-|$)/i.test(editorLanguage) ? 'zh-CN' : 'en';
}
