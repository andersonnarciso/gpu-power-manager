/**
 * Global setup shared by every test suite.
 *
 * The DOM matchers are only needed by the renderer suites; they are loaded
 * defensively so the node only suites (main process, privileged helper) can
 * run without a DOM.
 */

try {
  await import('@testing-library/jest-dom/vitest');
} catch {
  // Optional: the node only suites do not need the DOM matchers.
}

// The file uses a top level await, so it must be a module.
export {};
