import { mobile } from '@e2e-dev/mobile';
import type { E2EConfig } from 'e2e';

export default {
  targets: [{
    name: 'harmony-phone',
    engine: mobile({ platform: 'harmonyos', device: process.env['E2E_DEVICE'] }),
    app: { bundleId: 'com.example.e2ecounter' },
  }],
} satisfies E2EConfig;
