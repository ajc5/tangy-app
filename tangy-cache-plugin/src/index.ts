import { registerPlugin, Capacitor } from '@capacitor/core';
import type { TangyCachePlugin } from './definitions';
import { TangyCacheWeb } from './web';

const TangyCache = registerPlugin<TangyCachePlugin>('TangyCache', {
  web: () => import('./web').then((m) => new m.TangyCacheWeb()),
});

export { TangyCache };
export type { TangyCachePlugin, CacheEntry, PinProgress, CacheStats, OfflineUrl } from './definitions';
