import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.anilog.android',
  appName: 'AniLog',
  webDir: 'dist/android',
  android: {
    allowMixedContent: false,
  },
};

export default config;
