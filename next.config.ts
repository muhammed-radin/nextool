import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // v1.0.3: keep the Parquet adapter (+ its wasm / AWS-SDK internals) out of
  // the server bundle — it is required from node_modules at runtime instead.
  serverExternalPackages: ["@dsnp/parquetjs"],
};

export default nextConfig;
