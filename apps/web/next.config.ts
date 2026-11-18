import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: ['@yuqu/contracts'],
  devIndicators: false,
};
export default config;
