/** Vite asset imports resolve to their served URL. */
declare module '*.webp' {
  const url: string;
  export default url;
}
