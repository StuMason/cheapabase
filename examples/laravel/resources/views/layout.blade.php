<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>@yield('title', 'cheapabase docs') · Laravel</title>
  <style>
    :root { color-scheme: light dark; --fg: #1d1d1f; --bg: #fafaf9; --muted: #6b7280; --line: #d6d3d1; --accent: #f05340; }
    @media (prefers-color-scheme: dark) { :root { --fg: #e7e5e4; --bg: #1c1917; --muted: #a8a29e; --line: #44403c; } }
    * { box-sizing: border-box; }
    body { margin: 0; font: 16px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
    main { max-width: 640px; margin: 0 auto; padding: 32px 16px; }
    h1 { font-size: 1.4rem; margin: 0 0 16px; }
    h1 span { color: var(--accent); }
    form { display: flex; gap: 8px; flex-wrap: wrap; margin: 0 0 16px; }
    input, textarea, button { font: inherit; padding: 8px 12px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; }
    input { flex: 1; min-width: 0; }
    textarea { width: 100%; min-height: 280px; }
    button { cursor: pointer; background: var(--accent); border-color: var(--accent); color: white; }
    button.secondary { background: transparent; color: inherit; border-color: var(--line); }
    ul { list-style: none; padding: 0; } li { padding: 6px 0; border-bottom: 1px solid var(--line); }
    a { color: var(--accent); }
    .muted { color: var(--muted); } .error { color: #dc2626; min-height: 1.5em; }
    header { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <main>
    @yield('content')
  </main>
</body>
</html>
