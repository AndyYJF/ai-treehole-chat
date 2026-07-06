import type { NextConfig } from "next";
import withPWA, { runtimeCaching } from "@ducanh2912/next-pwa";

const nextConfig: NextConfig = {
  turbopack: {},
};

const safeRuntimeCaching = [
  {
    urlPattern: ({ sameOrigin, url }: { sameOrigin: boolean; url: URL }) =>
      sameOrigin && url.pathname.startsWith("/api/"),
    handler: "NetworkOnly" as const,
    method: "GET" as const,
    options: {
      cacheName: "apis",
    },
  },
  ...runtimeCaching.filter((cache) => cache.options?.cacheName !== "apis"),
];

export default withPWA({
  dest: "public",
  disable: process.env.NODE_ENV === "development",
  workboxOptions: {
    runtimeCaching: safeRuntimeCaching,
  },
})(nextConfig);
