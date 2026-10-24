// Dependency-free so config validation can name the registered runners without
// importing them (pi-environment.mjs imports config.mjs).
export const WORKER_TYPES = Object.freeze(["pi"]);
