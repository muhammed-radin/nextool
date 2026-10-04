import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  // v1.0.8 §7/§12 — the authoritative configuration-limits.json travels with
  // the standalone build so a self-hosted deployment can edit ONE JSON file
  // (and restart) to customize every operational limit.
  outputFileTracingIncludes: {
    "/**": ["./config/**"],
  },
  reactStrictMode: false,
  // v1.0.3: keep the Parquet adapter (+ its wasm / AWS-SDK internals) out of
  // the server bundle — it is required from node_modules at runtime instead.
  serverExternalPackages: ["@dsnp/parquetjs"],
};

export default nextConfig;
