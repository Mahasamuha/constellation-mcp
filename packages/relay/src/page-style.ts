// Inlined constellation-favicon.svg (assets/logo/) as a data URI — small and
// static enough that copying it into the image and adding a route would be
// pure overhead.
export const FAVICON_LINK =
  '<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48dGl0bGU+Q29uc3RlbGxhdGlvbjwvdGl0bGU+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iNyIgZmlsbD0iIzFBMUEyRSIvPjxnIHN0cm9rZT0iIzVEQ0FBNSIgc3Ryb2tlLXdpZHRoPSIxLjQiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgZmlsbD0ibm9uZSIgb3BhY2l0eT0iMC43Ij48bGluZSB4MT0iNSIgIHkxPSIxNyIgeDI9IjEyIiB5Mj0iNSIvPjxsaW5lIHgxPSIxMiIgeTE9IjUiICB4Mj0iMjQiIHkyPSI3Ii8+PGxpbmUgeDE9IjI0IiB5MT0iNyIgIHgyPSIyOCIgeTI9IjE2Ii8+PGxpbmUgeDE9IjI4IiB5MT0iMTYiIHgyPSIyNCIgeTI9IjI1Ii8+PGxpbmUgeDE9IjI0IiB5MT0iMjUiIHgyPSIxMyIgeTI9IjI4Ii8+PGxpbmUgeDE9IjEzIiB5MT0iMjgiIHgyPSI1IiAgeTI9IjE3Ii8+PGxpbmUgeDE9IjUiICB5MT0iMTciIHgyPSIxOCIgeTI9IjE2Ii8+PGxpbmUgeDE9IjEyIiB5MT0iNSIgIHgyPSIxOCIgeTI9IjE2Ii8+PGxpbmUgeDE9IjI4IiB5MT0iMTYiIHgyPSIxOCIgeTI9IjE2Ii8+PGxpbmUgeDE9IjEzIiB5MT0iMjgiIHgyPSIxOCIgeTI9IjE2Ii8+PC9nPjxjaXJjbGUgY3g9IjUiICBjeT0iMTciIHI9IjIuNSIgZmlsbD0iIzVEQ0FBNSIvPjxjaXJjbGUgY3g9IjEyIiBjeT0iNSIgIHI9IjIuNSIgZmlsbD0iIzVEQ0FBNSIvPjxjaXJjbGUgY3g9IjI0IiBjeT0iNyIgIHI9IjIiICAgZmlsbD0iIzVEQ0FBNSIvPjxjaXJjbGUgY3g9IjI4IiBjeT0iMTYiIHI9IjMiICAgZmlsbD0iIzVEQ0FBNSIvPjxjaXJjbGUgY3g9IjI0IiBjeT0iMjUiIHI9IjIiICAgZmlsbD0iIzVEQ0FBNSIvPjxjaXJjbGUgY3g9IjEzIiBjeT0iMjgiIHI9IjIuNSIgZmlsbD0iIzVEQ0FBNSIvPjxjaXJjbGUgY3g9IjE4IiBjeT0iMTYiIHI9IjQuNSIgZmlsbD0iIzVEQ0FBNSIvPjxjaXJjbGUgY3g9IjE4IiBjeT0iMTYiIHI9IjIuMiIgZmlsbD0iIzJBNkI1OCIvPjwvc3ZnPg==">';

export function pageStyle(): string {
  return `${FAVICON_LINK}<style>
    body { font-family: system-ui, sans-serif; background: #f5f5f5; display: flex; justify-content: center; padding: 4rem 1rem; }
    .card { background: #fff; border-radius: 8px; padding: 2rem; max-width: 420px; width: 100%; box-shadow: 0 2px 8px rgba(0,0,0,.1); }
    .card.wide { max-width: 640px; }
    h1 { margin-top: 0; font-size: 1.4rem; }
    h2 { font-size: 1.1rem; margin-top: 1.6rem; }
    label { display: block; margin: 1rem 0 .4rem; font-weight: 500; }
    .hint { font-weight: 400; font-size: .85em; color: #666; }
    input[type=text], input[type=password] { width: 100%; box-sizing: border-box; padding: .5rem; font-size: 1rem; border: 1px solid #ccc; border-radius: 4px; }
    input.code-input { font-size: 1.1rem; letter-spacing: .1em; }
    button { margin-top: 1.2rem; padding: .6rem 1.4rem; font-size: 1rem; border: none; border-radius: 4px; cursor: pointer; background: #2563eb; color: #fff; }
    button.secondary { background: #e5e7eb; color: #111; margin-left: .6rem; }
    .actions { display: flex; }
    pre { background: #f1f5f9; padding: 1rem; border-radius: 4px; font-size: .85rem; overflow-x: auto; white-space: pre-wrap; }
    .error { color: #dc2626; background: #fee2e2; padding: .4rem .6rem; border-radius: 4px; margin: 0; padding-left: 1.6rem; }
    .error li { padding: .2rem 0; }
    .meta { color: #555; font-size: .9rem; }
    .checklist { list-style: none; padding: 0; }
    .checklist li { padding: .3rem 0; }
    .checklist .ok { color: #16a34a; }
    .checklist .missing { color: #dc2626; }
  </style>`;
}
