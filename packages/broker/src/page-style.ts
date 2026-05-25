export function pageStyle(): string {
  return `<style>
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