// Minimal no-op job decorator. Optionally takes an explicit job id.
export function job(_id?: string) {
  return function jobDecorator(_target: Function) {
    // no-op at runtime; used for discovery by the build script
  };
}

// Optional grouping decorator to put multiple jobs into the same bundle
export function bundleName(_name: string) {
  return function bundleDecorator(_target: Function) {
    // no-op at runtime; used for discovery by the build script
  };
}
