/// <reference types="vite/client" />

// Loaded from cdnjs via a <script> tag in index.html (see CSP resourceDomains
// in the broker's ui:// resource registration) rather than bundled — keeps
// the ~150KB common-languages payload out of the inlined single-file build.
interface Window {
  hljs?: {
    highlightAuto(code: string): { value: string; language?: string };
  };
}
