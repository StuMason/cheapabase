import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This app lives inside the cheapabase repo, which has its own lockfile.
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
