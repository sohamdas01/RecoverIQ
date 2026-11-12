/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep the dev-only Next.js badge away from the sidebar's account row.
  devIndicators: {
    position: 'bottom-right',
  },
};

export default nextConfig;
