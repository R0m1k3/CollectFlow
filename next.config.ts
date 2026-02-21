import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    // Idem pour TypeScript
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
