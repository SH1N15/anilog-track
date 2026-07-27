import type { CapacitorConfig } from '@capacitor/cli';

const originalEdition = process.env.ANILOG_ANDROID_EDITION === 'original';

const config: CapacitorConfig = {
  appId: originalEdition ? 'io.anilog.android.original' : 'io.anilog.android',
  appName: originalEdition ? 'AniLog Original' : 'AniLog',
  webDir: originalEdition ? 'dist/android-original' : 'dist/android',
  android: {
    allowMixedContent: false,
  },
};

export default config;
