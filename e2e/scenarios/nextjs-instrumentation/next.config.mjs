import { wrapNextjsConfigWithBraintrust } from "braintrust/next";

/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default wrapNextjsConfigWithBraintrust(nextConfig);
