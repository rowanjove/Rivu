export type ReadingPreferences = {
  density: 'comfortable' | 'standard' | 'compact';
  uiFontSize: 'small' | 'standard' | 'large';
  theme: 'light' | 'dark' | 'system';
  font: 'sans' | 'serif';
  fontSize: 14 | 16 | 18 | 20;
  lineHeight: 1.6 | 1.8 | 2;
  width: 680 | 760 | 840;
  imageWidth: 'column' | 'wide';
  linkTarget: 'external' | 'ask';
};

export const defaultReadingPreferences: ReadingPreferences = {
  density: 'standard', uiFontSize: 'standard', theme: 'light', font: 'sans', fontSize: 16, lineHeight: 1.8,
  width: 760, imageWidth: 'column', linkTarget: 'external',
};

export function loadReadingPreferences(): ReadingPreferences {
  const legacyDensity = localStorage.getItem('rivu-density');
  const density = ['comfortable', 'standard', 'compact'].includes(legacyDensity || '')
    ? legacyDensity as ReadingPreferences['density'] : defaultReadingPreferences.density;
  try {
    const saved = JSON.parse(localStorage.getItem('rivu-reading-preferences') || '{}');
    const result = { ...defaultReadingPreferences, density };
    for (const key of Object.keys(result) as (keyof ReadingPreferences)[]) {
      if (saved[key] !== undefined && [
        ...(key === 'density' ? ['comfortable', 'standard', 'compact'] : []),
        ...(key === 'uiFontSize' ? ['small', 'standard', 'large'] : []),
        ...(key === 'theme' ? ['light', 'dark', 'system'] : []),
        ...(key === 'font' ? ['sans', 'serif'] : []),
        ...(key === 'fontSize' ? [14, 16, 18, 20] : []),
        ...(key === 'lineHeight' ? [1.6, 1.8, 2] : []),
        ...(key === 'width' ? [680, 760, 840] : []),
        ...(key === 'imageWidth' ? ['column', 'wide'] : []),
        ...(key === 'linkTarget' ? ['external', 'ask'] : []),
      ].includes(saved[key])) (result as Record<string,unknown>)[key] = saved[key];
    }
    return result;
  } catch { return { ...defaultReadingPreferences, density }; }
}
