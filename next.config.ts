import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Needed for video upload to /api/* routes when the proxy/middleware clones request bodies.
    // Default is 10MB, which can truncate iPhone .MOV uploads and break `req.formData()`.
    proxyClientMaxBodySize: "50mb",
    serverActions: {
      bodySizeLimit: "100mb",
    },
  },
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
