import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "berrie-ai-incorporated.litellm-sandbox.ai",
        pathname: "/**",
      },
    ],
  },
};

export default nextConfig;
