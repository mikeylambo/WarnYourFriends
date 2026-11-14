/** Vite asset imports resolve to their served URL. */
declare module '*.webp' {
  const url: string;
  export default url;
}
declare module '*.glb?url' {
  const url: string;
  export default url;
}
